// ── Deposit-offer lane (Prizerail deposit A/B, prize arm) ────────────────────────
// Each new Hence account in the A/B's PRIZE arm that made a qualifying first deposit is owed
// ONE Megapot ticket. The app lists those rows (GET /api/admin/deposit-offer/rewards
// ?variant=prize&status=owed&due=1, feed token); this lane mints one ticket to each wallet
// with USDC (randomBuyer.buyTickets, count 1), reads the minted tokenId from the receipt's
// ERC-721 Transfer log and reports it (POST /api/admin/megapot/grants, kind 'deposit-offer')
// through the outbox, so the app flips the reward row to issued.
//
// It is NOT a fee-credit grant: no wallet credit moves, the 5/day + 15/week caps do not
// apply, and the cap is ONE ticket per wallet for the whole experiment. Its own budget
// (DEPOSIT_OFFER_BUDGET_USDC) and the season-wide GLOBAL_BUDGET_USDC both hold.
//
// Ledger (state/ledger.<target>.json):
//   depositOffer[experiment][wallet] = {status, tx, nonce, at, round, drawAt, priceUsd,
//                                       tokenId?, tokenIds?, attempts, prevTx?, unfound?}
//   depositOfferSpentUsdc[experiment] = USDC spent by this lane (also counted in spentUsdc)
//   intents[] kind:'deposit-offer' while a signed tx is not yet known to be broadcast
// status: 'intent'  signed + intent on disk, broadcast unknown; NOT debited
//         'pending' broadcast accepted; debited; receipt not yet read
//         'issued'  mined, tokenId read, grant queued in the outbox   (final)
//         'no-token' mined but no Transfer to the recipient found      (final, needs a human)
//         'failed'  reverted MAX_REVERTS times                         (final, needs a human)
//         'reverted' / 'dropped'  nothing minted, refunded; minted again on a later cycle
//
// PURE except runDepositOffer, which takes every chain / network call through `io` so the
// tests drive the whole lane (crash between broadcast and receipt, retries, DRY_RUN).
import { classifyIntent, classifyPurchase } from './reconcile.js';
import { enqueue } from './outbox.js';

export const EXPERIMENT = 'prizerail-deposit-2026';
export const GRANT_KIND = 'deposit-offer';
export const INTENT_KIND = 'deposit-offer';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';   // Transfer(address,address,uint256)
export const MAX_REVERTS = 3;
export const MAX_MINTS_PER_CYCLE = 10;               // bounds one cycle's receipt waits
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const RETRYABLE = new Set(['reverted', 'dropped']);

export const validWallet = (w) => typeof w === 'string' && ADDR.test(w.trim());

/** feed URL: explicit, else USERS_URL's host with the rewards path; '' when neither is set */
export function feedUrlFrom(explicit, usersUrl) {
  if (explicit) return explicit;
  if (!usersUrl || !/\/api\/admin\/wallets/.test(usersUrl)) return '';
  return usersUrl.replace(/\/api\/admin\/wallets.*$/, '/api/admin/deposit-offer/rewards?variant=prize&status=owed&due=1');
}

/**
 * The app's response -> {experiment, rows:[{wallet (lowercase), depositUsd, qualifiedMs, payableAfterMs}], skipped:[{wallet, reason}]}.
 * A row is minted only when it is the prize arm, a ticket, still owed, has no reward_ref, is
 * past its hold and carries a valid wallet. A response for another experiment is an error:
 * the ledger key is the experiment, so a renamed experiment would make every wallet new again.
 */
export function parseFeed(j, { experiment = EXPERIMENT, nowMs = Date.now() } = {}) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.rewards)) throw new Error('deposit-offer feed: no rewards[] in the response');
  if (String(j.experiment || '') !== experiment) throw new Error(`deposit-offer feed: experiment '${j.experiment}' is not '${experiment}'`);
  const rows = [], skipped = [], seen = new Set();
  for (const r of j.rewards) {
    const raw = String(r?.wallet ?? '').trim();
    const skip = (reason) => skipped.push({ wallet: raw || null, reason });
    if (!validWallet(raw)) { skip('invalid wallet'); continue; }
    const wallet = raw.toLowerCase();
    if (r.variant !== 'prize') { skip(`variant ${r.variant}`); continue; }
    if (r.reward_kind !== 'ticket') { skip(`reward_kind ${r.reward_kind}`); continue; }
    if (r.reward_status !== 'owed') { skip(`status ${r.reward_status}`); continue; }
    if (r.reward_ref) { skip('already has a reward_ref'); continue; }
    if (r.payable_after_ms == null || Number(r.payable_after_ms) > nowMs) { skip('not payable yet'); continue; }
    if (seen.has(wallet)) { skip('duplicate row'); continue; }
    seen.add(wallet);
    rows.push({ wallet, depositUsd: Number(r.deposit_usd) || 0, qualifiedMs: Number(r.qualified_ms) || 0, payableAfterMs: Number(r.payable_after_ms) });
  }
  return { experiment, rows, skipped };
}

export const entryOf = (s, exp, w) => s?.depositOffer?.[exp]?.[String(w).toLowerCase()] || null;
/** a wallet may be minted for: no entry yet, or the last attempt minted nothing */
export const mintable = (s, exp, w) => { const e = entryOf(s, exp, w); return !e || RETRYABLE.has(e.status); };
export const spentOf = (s, exp) => Number(s?.depositOfferSpentUsdc?.[exp] || 0);

/** can one more ticket at priceUsd be paid? -> null (yes) or the reason it cannot */
export function budgetStop(s, exp, { priceUsd, budgetUsd, globalBudgetUsd, extraSpent = 0 }) {
  const eps = 1e-9;
  if (spentOf(s, exp) + extraSpent + priceUsd > budgetUsd + eps) return `deposit-offer budget: $${(spentOf(s, exp) + extraSpent).toFixed(2)} of $${budgetUsd} spent, a ticket is $${priceUsd}`;
  if (Number(s?.spentUsdc || 0) + extraSpent + priceUsd > globalBudgetUsd + eps) return `GLOBAL_BUDGET_USDC: $${(Number(s?.spentUsdc || 0) + extraSpent).toFixed(2)} of $${globalBudgetUsd} spent`;
  return null;
}

const topicAddr = (t) => `0x${String(t).slice(-40)}`.toLowerCase();
/** token ids the ticket NFT transferred to `recipient` in this receipt (mint = from 0x0) */
export function mintedTokenIds(receipt, { nft, recipient }) {
  const n = String(nft || '').toLowerCase(), to = String(recipient || '').toLowerCase();
  if (!n || !to) return [];
  const out = [];
  for (const l of receipt?.logs || []) {
    const t = l?.topics || [];
    if (String(l.address || '').toLowerCase() !== n || t.length !== 4 || String(t[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topicAddr(t[2]) !== to) continue;
    const id = BigInt(t[3]).toString();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** the POST /api/admin/megapot/grants body the app settles the reward on */
export function depositGrantBody({ wallet, tokenId, round, tx, drawAt, ts = Date.now() }) {
  const b = { wallet: String(wallet).toLowerCase(), tokenId: String(tokenId), round: String(round ?? ''), tx, kind: GRANT_KIND };
  if (Number.isFinite(Number(drawAt)) && Number(drawAt) > 0) b.drawAt = Number(drawAt);
  b.ts = ts;
  return b;
}

// ── ledger moves (all on `s`; the caller saves) ──────────────────────────────────
const book = (s, exp) => ((s.depositOffer ??= {})[exp] ??= {});
function debit(s, exp, usd) {
  (s.depositOfferSpentUsdc ??= {})[exp] = spentOf(s, exp) + usd;
  s.spentUsdc = Number(s.spentUsdc || 0) + usd;
}
function refund(s, exp, usd) {
  s.depositOfferSpentUsdc[exp] = Math.max(0, spentOf(s, exp) - usd);
  s.spentUsdc = Math.max(0, Number(s.spentUsdc || 0) - usd);
}
const dropIntent = (s, tx) => { s.intents = (s.intents || []).filter((i) => !(i.kind === INTENT_KIND && i.tx === tx)); };

/** a mined-success receipt: read the token, queue the grant, THEN mark issued (one save) */
function finishSuccess(s, exp, w, e, receipt, { nft, nowMs, log }) {
  const ids = mintedTokenIds(receipt, { nft, recipient: w });
  e.minedAt = nowMs;
  if (!ids.length) {
    e.status = 'no-token';
    log(`[megapot] ALERT deposit_offer_no_token wallet=${w} tx=${e.tx} - mined, but no ticket Transfer to the wallet in the receipt; not re-minted, needs a human`);
    return 'no-token';
  }
  e.tokenId = ids[0];
  if (ids.length > 1) { e.tokenIds = ids; log(`${w} deposit-offer: receipt ${e.tx} carries ${ids.length} tickets - reporting #${ids[0]}`); }
  enqueue(s, { kind: 'grant', wallet: w, body: depositGrantBody({ wallet: w, tokenId: ids[0], round: e.round, tx: e.tx, drawAt: e.drawAt, ts: nowMs }) }, nowMs);
  e.status = 'issued';
  e.issuedAt = nowMs;
  log(`${w} deposit-offer ticket #${ids[0]} minted (tx ${e.tx}, round ${e.round ?? '?'}) - grant queued`);
  return 'issued';
}
function onRevert(s, exp, w, e, { debited, log }) {
  if (debited) refund(s, exp, e.priceUsd);
  e.reverts = (e.reverts || 0) + 1;
  e.status = e.reverts >= MAX_REVERTS ? 'failed' : 'reverted';
  log(`${w} deposit-offer tx ${e.tx} reverted (${e.reverts}/${MAX_REVERTS})${debited ? ' - refunded' : ''}${e.status === 'failed' ? ' - [megapot] ALERT deposit_offer_failed, not retried' : ' - retried next cycle'}`);
}

/**
 * Settle every open entry against the chain. `io.receipt(hash)` -> full receipt | null (none)
 * | undefined (transport); `io.txFound(hash)` -> true | false | null; `accountNonce` = the
 * pool's latest nonce (null = unknown). Returns counts per outcome.
 */
export async function settleOpen(s, { exp, nft, accountNonce, nowMs = Date.now(), io }) {
  const log = io.log || (() => {});
  const out = { issued: 0, reverted: 0, dropped: 0, waiting: 0, noToken: 0 };
  for (const [w, e] of Object.entries(s.depositOffer?.[exp] || {})) {
    if (e.status !== 'intent' && e.status !== 'pending') continue;
    const receipt = await io.receipt(e.tx);
    const rStatus = receipt === undefined ? undefined : (receipt ? receipt.status : null);
    if (e.status === 'intent') {
      // signed and on disk, broadcast unknown, nothing debited (reconcile.js classifyIntent)
      const consumed = accountNonce != null && accountNonce > Number(e.nonce);
      const txFound = (consumed && rStatus === null) ? await io.txFound(e.tx) : null;
      const v = classifyIntent({ ts: e.at }, { consumed, receipt: rStatus, txFound, nowMs });
      if (v === 'wait') { out.waiting++; continue; }
      dropIntent(s, e.tx);
      if (v === 'drop') { e.status = 'dropped'; out.dropped++; log(`${w} deposit-offer intent nonce ${e.nonce} dropped (never mined, no debit) - minted again next cycle`); continue; }
      if (rStatus === 'success') { debit(s, exp, e.priceUsd); finishSuccess(s, exp, w, e, receipt, { nft, nowMs, log }) === 'issued' ? out.issued++ : out.noToken++; }
      else { onRevert(s, exp, w, e, { debited: false, log }); out.reverted++; }
      continue;
    }
    // pending: broadcast and debited (reconcile.js classifyPurchase)
    let txFound = null;
    if (rStatus === null && nowMs - Number(e.at || 0) >= 30 * 60_000) txFound = await io.txFound(e.tx);
    const v = classifyPurchase({ ts: e.at, nonce: e.nonce, unfound: e.unfound }, { receipt: rStatus, txFound, accountNonce, nowMs });
    if (v === 'transport' || v === 'pending') { if (v === 'pending' && rStatus === null && txFound === false) e.unfound = (e.unfound || 0) + 1; out.waiting++; continue; }
    if (v === 'success') { finishSuccess(s, exp, w, e, receipt, { nft, nowMs, log }) === 'issued' ? out.issued++ : out.noToken++; continue; }
    if (v === 'dropped') { refund(s, exp, e.priceUsd); e.status = 'dropped'; out.dropped++; log(`${w} deposit-offer tx ${e.tx} dropped (unfound, nonce consumed) - refunded, minted again next cycle`); continue; }
    onRevert(s, exp, w, e, { debited: true, log }); out.reverted++;
  }
  return out;
}

/**
 * One lane pass. ctx: {exp, nft, priceUsd, budgetUsd, globalBudgetUsd, dryRun, canSend,
 * holdReason, accountNonce, nowMs}. io: {fetchFeed, receipt, txFound, drawing, simulate,
 * sign, send, waitReceipt, save, log}. The ledger is saved before every wire call.
 */
export async function runDepositOffer(s, ctx, io) {
  const { exp = EXPERIMENT, nft, priceUsd, budgetUsd, globalBudgetUsd, dryRun, canSend = true, holdReason = '', accountNonce = null } = ctx;
  const nowMs = ctx.nowMs ?? Date.now();
  const log = io.log || (() => {});
  const res = { settled: null, minted: 0, wouldMint: [], skipped: 0, stop: null, feedError: null };
  if (!dryRun) { res.settled = await settleOpen(s, { exp, nft, accountNonce, nowMs, io }); io.save(); }

  let feed;
  try { feed = parseFeed(await io.fetchFeed(), { experiment: exp, nowMs }); }
  catch (e) { res.feedError = e.message; log(`[megapot] deposit-offer feed unavailable (${e.message}) - no mint this cycle`); return res; }
  for (const k of feed.skipped) log(`deposit-offer row skipped: ${k.wallet || '(no wallet)'} - ${k.reason}`);

  let dryExtra = 0;
  for (const row of feed.rows) {
    const w = row.wallet;
    if (!mintable(s, exp, w)) { res.skipped++; continue; }           // one per wallet per experiment
    const stop = budgetStop(s, exp, { priceUsd, budgetUsd, globalBudgetUsd, extraSpent: dryExtra });
    if (stop) { res.stop = stop; log(`[megapot] deposit-offer lane stopped: ${stop}`); break; }
    if (res.minted + res.wouldMint.length >= MAX_MINTS_PER_CYCLE) { log(`deposit-offer: ${MAX_MINTS_PER_CYCLE} mints this cycle - the rest next cycle`); break; }
    let draw = { round: null, drawAt: null };
    try { draw = await io.drawing(); } catch (e) { log(`deposit-offer: drawing read failed (${e.message})`); }
    if (dryRun) {
      dryExtra += priceUsd;
      res.wouldMint.push(w);
      log(`${w} WOULD mint 1 deposit-offer ticket → ${w} (round ${draw.round ?? '?'}, draw ${draw.drawAt ? new Date(draw.drawAt).toISOString() : '?'}, $${priceUsd}, deposit $${row.depositUsd})`);
      continue;
    }
    if (!canSend) { log(`${w} deposit-offer mint held: ${holdReason || 'pool cannot send'}`); break; }
    if (draw.round == null) { log(`${w} deposit-offer mint held: round unreadable`); break; }
    try { await io.simulate(w); }
    catch (e) { log(`${w} deposit-offer mint would revert - skipped this cycle: ${String(e.shortMessage || e.message || '').split('\n')[0]}`); continue; }
    let signed;
    try { signed = await io.sign(w); }
    catch (e) { log(`${w} deposit-offer mint not signed: ${e.message}`); break; }
    const prev = entryOf(s, exp, w);
    const e = { status: 'intent', tx: signed.hash, nonce: signed.nonce, at: nowMs, round: String(draw.round), drawAt: draw.drawAt ?? null, priceUsd, count: 1,
      attempts: (prev?.attempts || 0) + 1, ...(prev ? { prevTx: [...(prev.prevTx || []), prev.tx], reverts: prev.reverts || 0 } : {}) };
    book(s, exp)[w] = e;
    (s.intents ??= []).push({ kind: INTENT_KIND, exp, wallet: w, count: 1, nonce: signed.nonce, priceUsd, ts: nowMs, drawing: e.round, tx: signed.hash });
    io.save();                                                           // intent on disk BEFORE broadcast
    try { await io.send(signed.serialized); }
    catch (err) {
      // maybe broadcast, maybe not: the entry stays 'intent' and settleOpen decides by nonce
      log(`${w} deposit-offer send failed (intent kept, nonce ${signed.nonce}, tx ${signed.hash}): ${String(err.shortMessage || err.message || '').split('\n')[0]}`);
      break;
    }
    dropIntent(s, signed.hash);
    e.status = 'pending';
    debit(s, exp, priceUsd);
    io.save();                                                           // debit on disk BEFORE the receipt wait
    log(`${w} deposit-offer mint PENDING (tx ${signed.hash}, nonce ${signed.nonce})`);
    let rc;
    try { rc = await io.waitReceipt(signed.hash); }
    catch (err) { log(`${w} deposit-offer receipt not yet seen (${err.message}) - settled next cycle`); continue; }
    if (rc?.status === 'success') { if (finishSuccess(s, exp, w, e, rc, { nft, nowMs, log }) === 'issued') res.minted++; }
    else onRevert(s, exp, w, e, { debited: true, log });
    io.save();
  }
  return res;
}

/** aggregates for `run.js status` */
export function summary(s, exp = EXPERIMENT) {
  const by = {};
  for (const e of Object.values(s?.depositOffer?.[exp] || {})) by[e.status] = (by[e.status] || 0) + 1;
  return { experiment: exp, spentUsdc: +spentOf(s, exp).toFixed(2), ...by };
}
