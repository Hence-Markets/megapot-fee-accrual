import fs from 'node:fs';
import crypto from 'node:crypto';
import { rollStreakBox, boxFor } from './streakBox.js';
import { dailyStatus, attrs, shouldEmit, statusKey, tradeAttrs, shouldIdentifyOnTrade, winTransition, winId, usdOf } from './lifecycle.js';
import { cioIdentify, cioEnabled } from './cio.js';
import { readLedger, writeLedger, acquireLock, isHenceFill } from './ledger.js';
import { foldSpotFills } from './spotFills.js';
import { takeFromDailyGate } from './gates.js';
import { planApproval } from './allowance.js';
import { createPublicClient, createWalletClient, formatUnits, formatEther, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { parseTierRows, kickerFor } from './tiers.js';
import { cfg, net, jackpotAbi, buyerAbi, erc20Abi, erc721Abi, retroEnabled } from './config.js';
import { track, trackLegs, postGrant, postStatus, commsEnabled } from './comms.js';
import { filterInventory, allocateRetro, grantBody, attributeTransferredWins, transfersFromLedger, winGrantBody, claimTxOf } from './retro.js';
import { enqueue, enqueueStatus, due, afterAttempt, skipLegs } from './outbox.js';
import { parseRows, userPackGranted, userCapLeft, userCapRoom, userBoxDates } from './users.js';
import { lowFunds, feeCapFor, feeSpike, shouldAlert, shouldCacheFeed, rotate, accrueSkipStreak, buyGasFor } from './safety.js';
import { blanketGrantsDue } from './grants.js';
import { riskRulesFor, roiRoomTickets, noteFree, roiLine } from './risk.js';
import { fileBucket, backoffMs } from './ratelimit.js';
import { classifyPurchase, classifyIntent, walletOnHold } from './reconcile.js';
import { mapLimit } from './pool.js';
import { signPinned } from './txsign.js';
import { needsRewind } from './reset.js';
import { rpcTransport, watchRateLimits, RPC_TIMEOUT_MS } from './rpc.js';
import { decideBuy, statusRows, engineDoc } from './status.js';

// every upstream call is bounded: one hung feed must never freeze a cycle
const FETCH_MS = 12_000;
const fetchT = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_MS) });
const authHeaders = () => (cfg.USERS_TOKEN ? { Authorization: `Bearer ${cfg.USERS_TOKEN}` } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Eligible set per the feature-gates conventions: whitelist = pre-production
// cohort; empty whitelist = open mode, full user feed. Pause = ACTIVE=0.
// Open mode takes the feed from USERS_URL (the hence backend's admin wallet
// feed, refreshed each cycle with a disk cache to ride out outages) or
// USERS_FILE (static JSON). Rows may be plain "0x…" strings or
// {wallet, emailBound, user} objects; emailBound gates ACTIVATION PACKS only -
// volume accrual never depends on it. `user` groups linked wallets (users.js).
const FEED_CACHE = `state/users.feed.${cfg.TARGET}.json`;
let _feed = null;
const readFeedCache = () => { try { return JSON.parse(fs.readFileSync(FEED_CACHE, 'utf8')); } catch { return null; } };
export async function ensureFeed() {
  if (cfg.WHITELIST.length) { _feed = { wallets: cfg.WHITELIST, emailBound: null, users: {} }; return; }
  if (cfg.USERS_URL) {
    try {
      const r = await fetchT(cfg.USERS_URL, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const fresh = parseRows(Array.isArray(j) ? j : j.wallets || []);
      const cached = readFeedCache();
      const cachedN = cached?.wallets?.length || 0;
      if (shouldCacheFeed(fresh.wallets.length, cachedN)) {
        try { fs.writeFileSync(FEED_CACHE, JSON.stringify(fresh)); } catch { /* cache is best-effort */ }
        _feed = fresh;
      } else {
        // an empty feed runs on the cached copy; a shrunken one runs as served but the
        // cache keeps the larger set for the next outage
        console.log(`[megapot] ALERT user feed returned ${fresh.wallets.length} wallets vs ${cachedN} cached - cache NOT overwritten`);
        _feed = fresh.wallets.length ? fresh : (cached || fresh);
      }
    } catch (e) {
      const cached = readFeedCache();
      if (!cached) throw new Error(`Open mode: user feed unreachable and no cache yet (${e.message})`);
      _feed = cached;
      console.log(`[megapot] user feed unreachable (${e.message}) - continuing on cached feed (${_feed.wallets.length} wallets)`);
    }
    return;
  }
  if (!cfg.USERS_FILE) throw new Error('Open mode (empty MEGAPOT_WHITELIST) requires USERS_URL or USERS_FILE - empty whitelist means EVERYONE, and the engine needs the user feed to know who that is.');
  _feed = parseRows(JSON.parse(fs.readFileSync(cfg.USERS_FILE, 'utf8')));
}
// ── multiplier tier feed (kicker from the moment a tier is reached) ──────────
const BASKET_CACHE = `state/basket.feed.${cfg.TARGET}.json`;
let _tiers = {};                                    // wallet -> { x, crossedMs }
export async function ensureBasketFeed() {
  if (!cfg.BASKET_URL) { _tiers = {}; return; }
  try {
    const u = `${cfg.BASKET_URL}${cfg.BASKET_URL.includes('?') ? '&' : '?'}since_ms=${cfg.TIER_SINCE_MS}`;
    const r = await fetchT(u, { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    _tiers = parseTierRows(Array.isArray(j) ? j : j.rows || []);
    try { fs.writeFileSync(BASKET_CACHE, JSON.stringify(_tiers)); } catch { /* best-effort */ }
  } catch (e) {
    try { _tiers = JSON.parse(fs.readFileSync(BASKET_CACHE, 'utf8')); console.log(`[megapot] tier feed unreachable (${e.message}) - cached tiers`); }
    catch { _tiers = {}; console.log(`[megapot] tier feed unreachable (${e.message}) - base rate this cycle`); }
  }
}
export { parseTierRows, kickerFor, splitBoost } from './tiers.js';
const tierOf = (w) => _tiers[w] || null;
export function eligibleWallets() {
  if (!_feed) throw new Error('user feed not loaded - ensureFeed() runs at cycle start');
  return _feed.wallets;
}
// whitelist test cohorts (emailBound null) skip the email gate
const emailBound = (w) => (_feed && _feed.emailBound != null ? !!_feed.emailBound[w] : true);
const firstFillOf = (w) => Number(_feed?.firstFill?.[w]) || 0;   // from the backend feed; 0 = never reconciled
const countryOf = (w) => _feed?.country?.[w] || null;              // feed country; null = unknown / whitelist mode
const riskOf = (w) => riskRulesFor(cfg.RISK, w, countryOf(w));
// the wallet -> user map lives on the ledger so caps stay per user even when the feed is
// cached or a wallet later drops off it
const syncUsers = (s) => { for (const [w, u] of Object.entries(_feed?.users || {})) (s.users ??= {})[w] = u; };

// One ledger PER NETWORK: caps, spend and purchase records must not leak
// across the testnet→mainnet cutover (a $0.01 rehearsal ticket must never eat
// a $1 mainnet allowance, and reconcile must never look up a testnet tx on
// mainnet). The legacy un-suffixed file predates the split and was testnet.
export const STATE = `state/ledger.${cfg.TARGET}.json`;
const LEGACY_STATE = 'state/ledger.json';
const HEARTBEAT = `state/heartbeat.${cfg.TARGET}`;
const beat = () => { try { fs.mkdirSync('state', { recursive: true }); fs.writeFileSync(HEARTBEAT, String(Date.now())); } catch { /* ops healthcheck only */ } };

// ── ledger ──────────────────────────────────────────────────────────────────
// One JSON file: per-wallet fee credit (USDC, 6dp int), checkpoint of the last
// fill time already counted, tickets bought per day, lifetime spend.
export function load() {
  return readLedger(STATE, () => {
    if (cfg.TARGET === 'testnet') {
      try { return JSON.parse(fs.readFileSync(LEGACY_STATE, 'utf8')); } catch { /* fresh */ }
    }
    return { wallets: {}, spentUsdc: 0 };
  });
}
export function save(s) { writeLedger(STATE, s); }
// comms are emitted AFTER the ledger that records them is on disk - a
// crash between "WON +3" and save must never send an email the replay
// then contradicts. Every emit goes through the ledger OUTBOX (outbox.js):
// queued + saved first, then delivered; a failed leg retries next cycle, so
// events are at-least-once and never lost to a timeout or a kill.
// emits rows: [wallet, name, data] or [wallet, name, data, then] where `then`
// is applied to the ledger once every leg delivered (win markers).
async function flush(s, emits) {
  for (const row of emits.splice(0)) {
    const [w, name, data, then] = row;
    if (name === '$identify') enqueue(s, { kind: 'identify', wallet: w, attrs: data });
    else if (name === '$grant') enqueue(s, { kind: 'grant', wallet: w, body: data });
    else enqueue(s, { kind: 'track', wallet: w, name, data, ...(then ? { then } : {}) });
  }
  save(s);
  await flushOutbox(s);
  save(s);
}
async function deliver(e) {
  if (e.kind === 'track') return trackLegs(e.wallet, e.name, e.data, skipLegs(e));
  if (e.kind === 'identify') return { cio: cioEnabled() ? await cioIdentify(e.wallet, e.attrs) : null };
  if (e.kind === 'grant') return { grant: await postGrant(e.body) };
  if (e.kind === 'status') return { status: await postStatus(e.body) };
  return {};
}
const applyThen = (s, then) => {
  if (then?.win) { const ws = s.wallets?.[then.win.wallet]; if (ws) (ws.cioWins ??= {})[then.win.id] = then.win.state; }
};
export async function flushOutbox(s, nowMs = Date.now()) {
  let delivered = 0, retry = 0, dead = 0;
  for (const e of due(s, nowMs)) {
    const legs = await deliver(e);
    const r = afterAttempt(s, e, legs, nowMs);
    if (r === 'delivered') { delivered++; applyThen(s, e.then); }
    else if (r === 'retry') retry++;
    else { dead++; console.log(`[megapot] outbox: ${e.kind} ${e.name || ''} for ${e.wallet} dead after ${e.tries} tries`); if (e.then?.win) { const ws = s.wallets?.[e.then.win.wallet]; if (ws?.cioWins) delete ws.cioWins[e.then.win.id]; } }
  }
  if (retry || dead) console.log(`[megapot] outbox: ${delivered} delivered, ${retry} to retry, ${dead} dead, ${(s.outbox || []).length} queued`);
  return { delivered, retry, dead };
}
const wstate = (s, w) => (s.wallets[w] ??= { creditUsdc: 0, lastFillMs: cfg.START_MS, volumeUsd: 0, tickets: {} });

// ── ops alerts: one log line every time, one PostHog event per kind per hour ──
const ALERT_ID = `engine:${cfg.TARGET}`;
const alertKey = (kind) => `last${kind.replace(/(^|_)(\w)/g, (_, __, c) => c.toUpperCase())}Ms`;   // low_funds -> lastLowFundsMs
async function alert(s, kind, data = {}) {
  console.log(`[megapot] ALERT ${kind} ${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  s.alerts ??= {};
  const key = alertKey(kind);
  if (!shouldAlert(s.alerts, key)) return false;
  s.alerts[key] = Date.now();
  await track(ALERT_ID, 'megapot_engine_alert', { kind, ...data });
  return true;
}

// ── per-wallet status rows -> hub, through the outbox (one pending entry, newest wins) ──
// Built from the ledger AFTER a buy sweep with the same decideBuy the '0 tickets' log line
// uses. Skipped silently without a STATUS_URL (whitelist mode has no backend to tell).
const CAPS = { perDay: cfg.MAX_TICKETS_PER_WALLET_PER_DAY, perWeek: cfg.MAX_TICKETS_PER_WALLET_PER_WEEK };
const budgetTickets = (s, priceUsd) => Math.max(0, Math.floor((cfg.GLOBAL_BUDGET_USDC - s.spentUsdc) / priceUsd));
function queueStatus(s, ctx) {
  if (!cfg.STATUS_URL) return;
  const nowMs = Date.now();
  const rows = statusRows(s, { ...ctx, caps: CAPS, cycleMs: cfg.CYCLE_MS, nowMs });
  enqueueStatus(s, { rows, engine: engineDoc({ cycleMs: cfg.CYCLE_MS, nowMs, paused: !cfg.ACTIVE, target: cfg.TARGET }) }, nowMs);
  console.log(`[megapot] status: ${rows.length} wallet row(s) queued`);
}

// ── venue fills (Hyperliquid public info API — venue-authoritative) ────────
// Token bucket shared with the fast lane (file-backed), backoff on 429.
const hlBucket = fileBucket(`state/hl.bucket.${cfg.TARGET}.json`, { cap: cfg.HL_RPM });
async function hlInfo(body) {
  for (let attempt = 0; ; attempt++) {
    await hlBucket.take();
    const r = await fetchT(cfg.HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) {
      if (attempt >= 3) { const err = new Error('HL info 429 (rate limited after 3 retries)'); err.rateLimited = true; throw err; }   // accrue counts these per wallet
      await sleep(backoffMs(attempt));
      continue;
    }
    if (!r.ok) throw new Error(`HL info ${r.status}`);
    return r.json();
  }
}
async function fills(wallet, sinceMs) {
  const out = [];
  let start = sinceMs;
  for (let page = 0; page < 10; page++) { // paginate userFillsByTime (2k cap per call)
    const batch = await hlInfo({ type: 'userFillsByTime', user: wallet, startTime: start + 1, endTime: Date.now() });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch.filter((f) => isHenceFill(f, cfg.REQUIRE_BUILDER_FEE)));
    if (batch.length < 2000) break;
    start = batch[batch.length - 1].time;
  }
  return out;
}

// ── relay-spot fills (hence backend feed) ──────────────────────────────────
// Hyperliquid cannot see chain-4663 swaps, so the spot product reads Hence's OWN receipts
// ledger via /api/admin/spot-fills (same admin token as the enrollment feed). One fetch per
// cycle since the OLDEST enrolled checkpoint; per-wallet lastSpotFillMs makes the fold
// idempotent, so a new wallet joining (which drags `since` back to START_MS) re-reads
// history without re-crediting anyone. Season-scale bound: the feed caps at 5000 rows,
// far above S1's spot volume; revisit before a season where that could truncate.
async function spotFills(sinceMs) {
  const r = await fetchT(`${cfg.SPOT_FILLS_URL}?since=${sinceMs}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`spot feed ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j?.fills)) throw new Error('spot feed shape');
  return j.fills;
}

const qualifies = (coin, timeMs) => {
  // campaign window is a hard bound in both directions
  if (timeMs < cfg.START_MS || (cfg.END_MS && timeMs > cfg.END_MS)) return false;
  const raw = String(coin);
  const isXyz = raw.startsWith('xyz:');
  const product = isXyz ? 'xyz-equities' : 'perps';
  if (!cfg.PRODUCTS.includes(product)) return false;
  const sym = (isXyz ? raw.split(':')[1] : raw).toUpperCase();
  if (cfg.ZERO_FEE.includes(sym)) return false;           // zero-fee promo pairs earn nothing
  if (!cfg.SYMBOLS.length) return true;
  return cfg.SYMBOLS.includes(sym);
};

// ── accrue: fills since checkpoint → fee credit ────────────────────────────
export async function accrue(only = null) {
  guard();
  await ensureFeed();
  await ensureBasketFeed();
  const release = acquireLock(STATE);
  try { await accrueInner(only); } finally { release(); }
}
async function accrueInner(only = null) {
  const s = load();
  syncUsers(s);
  const emits = [];
  const grantsOpen = !cfg.END_MS || Date.now() <= cfg.END_MS;   // no new packs/boxes after the season
  // spot feed: fetched once per cycle, grouped per wallet. Unavailable = spot accrual
  // simply skips this cycle (checkpoints unmoved, HL accrual unaffected) — it must never
  // throw into the money path or advance past rows it did not read.
  const spotByWallet = new Map();
  let spotFeedOk = false;
  if (cfg.SPOT_FILLS_URL && cfg.PRODUCTS.includes('spot')) {
    try {
      const since = Math.min(...eligibleWallets().map((w) => Number(s.wallets?.[w]?.lastSpotFillMs || cfg.START_MS)), Date.now());
      for (const f of await spotFills(since)) {
        const fw = String(f.wallet || '').toLowerCase();
        if (!spotByWallet.has(fw)) spotByWallet.set(fw, []);
        spotByWallet.get(fw).push(f);
      }
      spotFeedOk = true;
    } catch (e) { console.log(`spot feed unavailable this cycle: ${e.message}`); }
  }
  // full sweeps start at a different wallet each cycle so a rate-limited tail rotates
  const fullSweep = !only;
  if (fullSweep) s.accrueCycle = (s.accrueCycle || 0) + 1;
  const accrueTargets = rotate(only ? eligibleWallets().filter((x) => only.has(x)) : eligibleWallets(), fullSweep ? s.accrueCycle : 0);
  let skipped = 0;
  for (const w of accrueTargets) {
   try {
    const ws = wstate(s, w);
    // A wallet first seen under a LATER start (its checkpoint was initialised to that
    // START_MS) must not skip fills that a subsequently EARLIER start makes eligible -
    // safe only while it has never been credited (no double-credit possible). A reset
    // wallet (resetMs) keeps its reset-time checkpoint (reset.js).
    if (needsRewind(ws, cfg.START_MS)) ws.lastFillMs = cfg.START_MS;
    const fs_ = await fills(w, ws.lastFillMs);
    let vol = 0, activationFill = null, boostedVol = 0;
    const risk = riskOf(w);
    // risk cohort: the first mint needs the cohort's (much higher) qualifying volume
    const ftMinUsd = cfg.FIRST_TRADE ? (risk?.firstTradeMinUsd || cfg.FIRST_TRADE.minTradeUsd || 0) : 0;
    const ftMin = cfg.FIRST_TRADE ? ftMinUsd : Infinity;
    if (risk && !ws.riskNoted) { ws.riskNoted = true; console.log(`${w} risk cohort (${risk.via}): first mint at $${ftMinUsd}, free tickets ROI-gated at ${risk.roiMultiple}x`); }
    const tier = tierOf(w);
    for (const f of fs_) {
      if (!qualifies(f.coin, f.time)) continue;
      const notional = Number(f.px) * Number(f.sz);
      if (activationFill == null && notional >= ftMin) activationFill = notional;
      vol += notional;
      if (tier && Number(f.time) >= tier.crossedMs) boostedVol += notional;
      const dstr = new Date(f.time).toISOString().slice(0, 10);
      (ws.days ??= {})[dstr] = (ws.days[dstr] || 0) + notional;
      ws.lastFillMs = Math.max(ws.lastFillMs, f.time);
    }
    // relay-spot fills join the SAME wallet ledger: volume and trade-days count toward
    // packs and streak boxes ("every product on Hence"), while the CREDIT is the exact
    // recorded fee (see spotFills.js for why it is not a bps recompute). hlVol is captured
    // first so the FEE_BPS formula below never re-prices spot volume at the perp rate.
    const hlVol = vol;
    let spotCredit = 0;
    if (spotFeedOk) {
      const sf = foldSpotFills(spotByWallet.get(w) || [], ws.lastSpotFillMs, cfg);
      if (sf.count) {
        spotCredit = sf.credit;
        vol += sf.vol;
        if (activationFill == null && sf.maxFillUsd >= ftMin) activationFill = sf.maxFillUsd;
        for (const [d, v] of Object.entries(sf.days)) (ws.days ??= {})[d] = (ws.days[d] || 0) + v;
        ws.lastSpotFillMs = sf.lastSpotFillMs;
        console.log(`${w} +$${sf.vol.toFixed(2)} spot volume (${sf.count} fill(s)) → +$${sf.credit.toFixed(4)} exact-fee credit`);
      }
    }
    // activation pack: granted ONCE per USER (any linked wallet), on the first
    // qualifying fill of >= minTradeUsd - a smaller starter trade must never
    // lock the pack out, so the qualifying notional persists on the ledger
    // until it can grant. With PACK_REQUIRES_EMAIL=1 the grant also waits for a
    // bound email (the user feed carries the flag); Season 1 runs without the
    // hold. Volume accrual is never held.
    const ft = cfg.FIRST_TRADE;
    if (ft) {
      const granted = userPackGranted(s, w);
      if (!granted && activationFill != null) ws.packQualifiedUsd = Math.max(ws.packQualifiedUsd || 0, activationFill);
      // TnC: a single $100 fill OR $100 of COMBINED in-window volume qualifies -
      // small traders reach the pack by adding up, not only by one big trade.
      if (!granted && ((ws.volumeUsd || 0) + vol) >= ftMinUsd) {
        ws.packQualifiedUsd = Math.max(ws.packQualifiedUsd || 0, (ws.volumeUsd || 0) + vol);
      }
      if (grantsOpen && !granted && (ws.packQualifiedUsd || 0) >= ftMinUsd && (ws.packQualifiedUsd || 0) > 0) {
        if (cfg.PACK_REQUIRES_EMAIL && !emailBound(w)) {
          console.log(`${w} activation pack HELD: qualifying trade $${ws.packQualifiedUsd.toFixed(2)} awaits a bound email`);
          if (!ws.packHeldNotified) { ws.packHeldNotified = true; emits.push([w, 'megapot_pack_held', { qualifyingUsd: Math.round(ws.packQualifiedUsd), reason: 'email' }]); }
        } else {
          // pack size is DRAWN AT RANDOM from a fixed season pool: 150 pack
          // slots totalling exactly 200 tickets, drawn without replacement
          // (the persisted slot counts ARE the odds - they deplete, so the
          // pool can never overshoot and late users still get fair draws).
          const slots = (s.packSlots ??= Object.fromEntries((ft.distribution || []).map((d) => [d.tickets, d.slots])));
          const entries = Object.entries(slots).filter(([, n]) => n > 0);
          const slotsLeft = entries.reduce((a, [, n]) => a + n, 0);
          const poolLeft = (ft.poolTickets || Infinity) - (s.firstTradePoolUsed || 0);
          ws.packGranted = true;                     // one shot, even if the pool is gone
          if (slotsLeft > 0 && poolLeft > 0) {
            let pick = crypto.randomInt(slotsLeft);
            let size = Number(entries[0][0]);
            for (const [k, n] of entries) { if (pick < n) { size = Number(k); break; } pick -= n; }
            slots[size] -= 1;
            const grant = Math.min(size, poolLeft);
            ws.bonusTicketsPending = (ws.bonusTicketsPending || 0) + grant;
            s.firstTradePoolUsed = (s.firstTradePoolUsed || 0) + grant;
            console.log(`${w} activation pack: drew ${grant} ticket(s) (qualifying fill $${ws.packQualifiedUsd.toFixed(2)}, pool ${s.firstTradePoolUsed}/${ft.poolTickets}, slots left ${slotsLeft - 1})`);
            emits.push([w, 'megapot_activation_pack', { tickets: grant, qualifyingUsd: Math.round(ws.packQualifiedUsd) }]);
          } else {
            console.log(`${w} activation pack skipped: season pool exhausted (${ft.poolTickets})`);
          }
        }
      }
    }
    // streak checkpoints: N distinct trade days this week + cumulative volume
    // gate -> one-time grant per checkpoint per week, from a shared season pool.
    const st = cfg.STREAK;
    const sb = cfg.STREAK_BOX;
    // STREAK BOX: one surprise box per distinct qualifying trade day across
    // the whole campaign (day N = Nth such day since START_MS), counted across
    // every wallet of the USER. Rolled once, recorded in ws.boxes so a replay
    // never re-rolls; a date another linked wallet already rolled is not rolled
    // again. Shared season pool. A day counts once its Hence volume reaches
    // minDayUsd - not on a $1 fill.
    if (sb && ws.days && grantsOpen) {
      const boxes = (ws.boxes ??= {});
      const boxed = userBoxDates(s, w);
      const matrix = Array.isArray(sb.matrix) && sb.matrix.length >= 1 && sb.matrix.every((b) => b && b.p >= 0 && b.p <= 1 && b.size >= 0) ? sb.matrix : undefined;
      const startDay = new Date(cfg.START_MS || 0).toISOString().slice(0, 10);
      const minDay = Number(sb.minDayUsd || 0);
      const newDays = Object.entries(ws.days).filter(([d, v]) => v >= Math.max(minDay, 1e-9) && d >= startDay && !boxed.has(d)).map(([d]) => d).sort();
      for (const d of newDays) {
        const dayN = boxed.size + 1;
        const poolLeft = (sb.poolTickets || Infinity) - (s.streakBoxPoolUsed || 0);
        const roll = rollStreakBox(dayN, () => crypto.randomInt(1_000_000) / 1_000_000, matrix);
        const grant = roll.won ? Math.min(roll.tickets, Math.max(0, poolLeft)) : 0;
        // a winning roll against an empty pool is an EMPTY box to the user - never "won 0"
        const poolExhausted = roll.won && grant <= 0;
        const won = roll.won && grant > 0;
        boxes[d] = { day: dayN, won, tickets: grant, ...(poolExhausted ? { poolExhausted: true } : {}) };
        boxed.add(d);
        if (grant > 0) {
          ws.streakTicketsPending = (ws.streakTicketsPending || 0) + grant;
          s.streakBoxPoolUsed = (s.streakBoxPoolUsed || 0) + grant;
        }
        console.log(`${w} streak box day ${dayN} (${d}): ${won ? `WON +${grant}` : poolExhausted ? 'empty (pool exhausted)' : 'empty'} (p ${roll.p}, size ${roll.size}, pool ${s.streakBoxPoolUsed || 0}/${sb.poolTickets})`);
        const nb = boxFor(dayN + 1, matrix);
        emits.push([w, 'megapot_streak_box', { day: dayN, dateUtc: d, won, tickets: grant, p: roll.p, size: roll.size,
          ...(poolExhausted ? { poolExhausted: true } : {}),
          nextDay: dayN + 1, nextP: nb.p, nextSize: nb.size }]);
      }
    }
    if (st && ws.days) {
      const nowD = new Date(); const dow = (nowD.getUTCDay() + 6) % 7;
      nowD.setUTCHours(0, 0, 0, 0);
      const mondayMs = nowD.getTime() - dow * 86400000;
      const weekKey = new Date(mondayMs).toISOString().slice(0, 10);
      let daysCount = 0, cum = 0;
      for (const [d, v] of Object.entries(ws.days)) {
        if (new Date(d + 'T00:00:00Z').getTime() >= mondayMs && v > 0) { daysCount++; cum += v; }
      }
      // legacy checkpoints only while boxes are off - no stale weekly state otherwise
      const g = sb ? {} : ((ws.streakGrants ??= {})[weekKey] ??= {});
      for (const cp of (sb || !grantsOpen ? [] : (st.checkpoints || []))) {
        const key = 'd' + cp.day;
        const poolLeft = (st.poolTickets || Infinity) - (s.streakPoolUsed || 0);
        if (!g[key] && daysCount >= cp.day && cum >= cp.minCumulativeUsd && poolLeft >= cp.tickets) {
          ws.streakTicketsPending = (ws.streakTicketsPending || 0) + cp.tickets;
          s.streakPoolUsed = (s.streakPoolUsed || 0) + cp.tickets;
          g[key] = true;
          console.log(`${w} streak d${cp.day} grant: +${cp.tickets} ticket(s) (days ${daysCount}, cum $${cum.toFixed(0)}, pool ${s.streakPoolUsed}/${st.poolTickets})`);
          emits.push([w, 'megapot_streak_ticket', { day: cp.day, tickets: cp.tickets, weekVolumeUsd: Math.round(cum) }]);
        }
      }
      // one event per NEW distinct trade day - the anchor Customer.io
      // workflows wait on to send "trade today or the streak resets"
      for (const [d, v] of Object.entries(ws.days)) {
        if (v <= 0 || new Date(d + 'T00:00:00Z').getTime() < mondayMs) continue;
        if ((ws.cioDays ??= {})[d]) continue;
        ws.cioDays[d] = true;
        emits.push([w, 'megapot_streak_day', { dateUtc: d, dayOfWeekCount: daysCount, weekVolumeUsd: Math.round(cum), campaignTradeDays: Object.keys(ws.boxes || {}).length }]);
      }
      for (const d of Object.keys(ws.cioDays || {})) {
        if (new Date(d + 'T00:00:00Z').getTime() < mondayMs - 14 * 86400000) delete ws.cioDays[d];
      }
      // prune day entries older than 14 days so the ledger stays small
      for (const d of Object.keys(ws.days)) {
        if (new Date(d + 'T00:00:00Z').getTime() < mondayMs - 14 * 86400000) delete ws.days[d];
      }
    }
    for (const g of cfg.OPS_GRANTS) {
      if (String(g.wallet).toLowerCase() !== w) continue;
      if ((ws.opsGrants ??= {})[g.id]) continue;
      ws.creditUsdc += Number(g.usd) || 0;
      ws.opsGrants[g.id] = { usd: g.usd, at: Date.now() };
      console.log(`${w} ops grant '${g.id}': +$${Number(g.usd).toFixed(2)} credit`);
    }
    // blanket grants: campaign-wide one-time credit (e.g. "+2 to everyone who traded by <date>")
    for (const g of blanketGrantsDue(ws, cfg.BLANKET_GRANTS, { vol, today: new Date().toISOString().slice(0, 10), firstFillMs: firstFillOf(w) })) {
      if (risk) {
        const priceUsd = s.lastPriceUsd || 1;
        if (roiRoomTickets(ws, risk, priceUsd) * priceUsd < (Number(g.usd) || 0)) { console.log(`${w} blanket grant '${g.id}' ROI-HELD (${roiLine(ws, risk)})`); continue; }
        noteFree(ws, (Number(g.usd) || 0) / priceUsd, priceUsd);
      }
      ws.creditUsdc += Number(g.usd) || 0;
      (ws.opsGrants ??= {})[g.id] = { usd: g.usd, at: Date.now(), blanket: true };
      console.log(`${w} blanket grant '${g.id}': +$${Number(g.usd).toFixed(2)} credit`);
    }
    let credit = hlVol * (cfg.FEE_BPS / 10_000) * cfg.ROLLOVER + spotCredit;
    // MULTIPLIER KICKER: fills after the wallet reached its tier earn the tier's kicker on
    // top of base credit (2x = +25% ... 5x = +100%). The extra is drawn from a season-wide
    // pool of bonus tickets (campaign.multiplierBonus.poolTickets); pool spent = base rate.
    const kick = tier ? kickerFor(tier.x, cfg.KICKERS) : 0;
    if (boostedVol > 0 && kick > 0) {
      const priceUsd = s.lastPriceUsd || 1;
      const poolLeftUsd = cfg.MULT_BONUS_POOL > 0 ? Math.max(0, cfg.MULT_BONUS_POOL * priceUsd - (s.multiplierBonusUsd || 0)) : Infinity;
      const extra = Math.min(poolLeftUsd, boostedVol * (cfg.FEE_BPS / 10_000) * cfg.ROLLOVER * kick);
      if (extra > 0) {
        credit += extra;
        s.multiplierBonusUsd = (s.multiplierBonusUsd || 0) + extra;
        ws.multBonusUsd = (ws.multBonusUsd || 0) + extra;
        console.log(`${w} ${tier.x}x tier (+${Math.round(kick * 100)}%): +$${extra.toFixed(4)} bonus credit on $${boostedVol.toFixed(2)} (pool used $${s.multiplierBonusUsd.toFixed(2)})`);
      }
    }
    ws.volumeUsd += vol;
    ws.creditUsdc += credit;
    // fees Hence earned from this wallet (HL at FEE_BPS, spot exact) - the ROI ledger the risk cohort is paid against
    ws.feesUsd = (ws.feesUsd || 0) + hlVol * (cfg.FEE_BPS / 10_000) + (cfg.ROLLOVER ? spotCredit / cfg.ROLLOVER : spotCredit);
    ws.rebatedUsd = (ws.rebatedUsd || 0) + credit;
    console.log(`${w} +$${vol.toFixed(2)} qualifying volume → +$${credit.toFixed(4)} credit (total $${ws.creditUsdc.toFixed(4)})`);
    // CRM anchor: one trade event per cycle with volume (the "user trades"
    // edge in every workflow) + where that leaves the next ticket
    if (vol > 0) {
      const priceUsd = s.lastPriceUsd || 1;
      emits.push([w, 'megapot_trade', {
        usd: Math.round(vol), fills: fs_.length, feeRebatedUsd: +credit.toFixed(4),
        creditUsd: +ws.creditUsdc.toFixed(4), nextTicketPct: Math.min(100, Math.round((ws.creditUsdc / priceUsd) * 100)),
        campaignTradeDays: Object.keys(ws.boxes || {}).length, dateUtc: new Date().toISOString().slice(0, 10),
      }]);
      // the profile attributes a trade moves, so same-day sends are not stale: first
      // trade of the day at once, then hourly
      if (shouldIdentifyOnTrade(ws.lastIdentifyMs)) {
        ws.lastIdentifyMs = Date.now();
        emits.push([w, '$identify', tradeAttrs(dailyStatus({ ws, rows: [], priceUsd, startMs: cfg.START_MS }))]);
      }
    }
    // accrue WATERMARK: stamped only by a completed pass, so the status row's lastAccrueMs
    // never claims the venue was read when the call failed
    ws.lastAccrueMs = Date.now();
    delete ws.accrueRateLimited;
    // one wallet's work is durable before the next wallet's RPC call can throw
    save(s);
    await flush(s, emits);
   } catch (e) {
    // one wallet's venue/RPC failure never stalls the others: its checkpoint
    // is untouched, so the next cycle retries it from where it left off
    emits.length = 0;
    skipped++;
    console.log(`${w} accrue skipped this cycle: ${e.message}`);
    // the HL rate limiter: count consecutive misses so a stale lastAccrueMs is explained
    if (e.rateLimited && s.wallets[w]) {
      const n = (s.wallets[w].accrueRateLimited = (s.wallets[w].accrueRateLimited || 0) + 1);
      console.log(`${w} accrue rate-limited by HL (${n} cycle(s) in a row) - lastAccrueMs unchanged`);
    }
   }
  }
  if (fullSweep) {
    const { streak, alert: fire } = accrueSkipStreak(s.accrueSkipStreak, skipped);
    s.accrueSkipStreak = streak;
    if (fire) await alert(s, 'accrue_skipped', { skipped, wallets: accrueTargets.length, cycles: streak });
    if (skipped > 0 && !fire) console.log(`[megapot] accrue skipped ${skipped} wallet(s) (${streak} cycle(s) in a row)`);
  }
  save(s);
  beat();
  return s;
}

// ── chain facts for reconcile ─────────────────────────────────────────────────
// "not found" (the node has no receipt / no tx) is a fact; a transport error is not.
const isNotFound = (e) => /NotFound/.test(String(e?.name || '')) || /could not be found|not found/i.test(String(e?.shortMessage || e?.message || ''));
async function receiptStatus(pub, hash) {
  try { const rc = await pub.getTransactionReceipt({ hash }); return rc?.status ?? null; }
  catch (e) { return isNotFound(e) ? null : undefined; }
}
async function txPresent(pub, hash) {
  try { const t = await pub.getTransaction({ hash }); return !!t; }
  catch (e) { return isNotFound(e) ? false : null; }
}
const latestNonce = async (pub, address) => {
  if (!address) return null;
  try { return await pub.getTransactionCount({ address, blockTag: 'latest' }); } catch { return null; }
};
const mintedEvent = (p, ws) => ['megapot_tickets_minted', { count: p.count, txHash: p.tx, drawing: String(p.drawing ?? ''), priceUsd: p.priceUsd,
  todayTotal: ws?.tickets?.[p.day] || p.count, creditLeftUsd: +Number(ws?.creditUsdc || 0).toFixed(4),
  ...(p.kind === 'retro' ? { source: 'retro', tokenId: String(p.tokenId) } : {}) }];

// reconcile: every recorded purchase carries its tx hash; verification is the
// on-chain receipt itself, not an indexer's opinion. A purchase whose receipt
// is reverted refunds credit, cap and budget precisely. A missing receipt is
// NOT a revert: the record is dropped (refunded) only when it is >= 30 min old,
// its nonce has been consumed by another tx, and the node has neither the tx
// nor a receipt (reconcile.js). Transport errors change nothing.
async function reconcile(s, pub, priceUsd, accountNonce, emits) {
  for (const p of s.purchases || []) {
    if (p.verified) continue;
    const receipt = await receiptStatus(pub, p.tx);
    let txFound = null;
    if (receipt === null && Date.now() - p.ts >= 30 * 60_000) txFound = await txPresent(pub, p.tx);
    const verdict = classifyPurchase(p, { receipt, txFound, accountNonce });
    if (verdict === 'transport') { console.log(`${p.wallet} reconcile: tx ${p.tx} lookup failed (transport) - unchanged`); continue; }
    if (verdict === 'pending') { if (receipt === null && txFound === false) p.unfound = (p.unfound || 0) + 1; continue; }   // count only when the node has no such tx (a mempool tx is not 'unfound')
    const ws = s.wallets[p.wallet];
    if (verdict === 'success') {
      p.verified = true;
      if (!p.notified) { p.notified = true; if (ws) ws.lastMintMs = Date.now(); emits.push([p.wallet, ...mintedEvent(p, ws)]); console.log(`${p.wallet} reconcile: tx ${p.tx} confirmed late - ${p.count} ticket(s)`); }
      continue;
    }
    // reverted on-chain, or dropped from the mempool and its nonce gone: refund exactly what was debited
    console.log(`${p.wallet} reconcile: ${verdict === 'dropped' ? 'dropped (unfound)' : 'tx reverted'} ${p.tx} — refunding ${p.count} ticket(s)${p.kind === 'retro' ? ` (retro #${p.tokenId})` : ''}`);
    const price = p.priceUsd ?? priceUsd;
    if (p.kind === 'retro') { s.retroUsd = Math.max(0, (s.retroUsd || 0) - p.count * price); s.retroTicketsUsed = Math.max(0, (s.retroTicketsUsed || 0) - p.count); }
    else s.spentUsdc = Math.max(0, s.spentUsdc - p.count * price);
    if (ws) {
      ws.creditUsdc += p.count * price;
      if (ws.tickets?.[p.day] != null) {
        ws.tickets[p.day] = Math.max(0, ws.tickets[p.day] - p.count);
        if (!ws.tickets[p.day]) delete ws.tickets[p.day];
      }
    }
    p.verified = true; p.refunded = true; p.dropped = verdict === 'dropped';
  }
  s.purchases = (s.purchases || []).filter((p) => !p.verified || Date.now() - p.ts < 7 * 86400000);
}

// intents: persisted BEFORE broadcast with the locally-signed hash. Consumed nonce +
// receipt = book the purchase now (debit on success); nonce spent by something else,
// or 30 min without consumption = the tx can never mine, drop it with no debit.
async function reconcileIntents(s, pub, accountNonce, emits) {
  for (const it of (s.intents || []).slice()) {
    const receipt = await receiptStatus(pub, it.tx);
    const consumed = accountNonce != null && accountNonce > Number(it.nonce);
    const txFound = (consumed && receipt === null) ? await txPresent(pub, it.tx) : null;
    const verdict = classifyIntent(it, { consumed, receipt, txFound });
    if (verdict === 'wait') continue;
    s.intents = s.intents.filter((x) => x !== it);
    if (verdict === 'drop') { console.log(`${it.wallet} intent ${it.kind} nonce ${it.nonce} dropped (never mined, no debit)`); continue; }
    if (it.kind !== 'buy' && it.kind !== 'transfer') continue;
    const ws = wstate(s, it.wallet);
    const retro = it.kind === 'transfer';
    const rec = { ts: it.ts, wallet: it.wallet, day: it.day, count: it.count, priceUsd: it.priceUsd, drawing: it.drawing, tx: it.tx, nonce: it.nonce, verified: true, lateSettled: true,
      ...(retro ? { kind: 'retro', tokenId: it.tokenId } : {}) };
    if (receipt === 'success') {
      ws.creditUsdc -= it.count * it.priceUsd;
      ws.tickets[it.day] = (ws.tickets[it.day] || 0) + it.count;
      if (retro) { s.retroUsd = (s.retroUsd || 0) + it.count * it.priceUsd; s.retroTicketsUsed = (s.retroTicketsUsed || 0) + it.count; }
      else s.spentUsdc += it.count * it.priceUsd;
      rec.notified = true;
      ws.lastMintMs = Date.now();
      emits.push([it.wallet, ...mintedEvent(rec, ws)]);
      if (retro) emits.push([it.wallet, '$grant', grantBody({ wallet: it.wallet, tokenId: it.tokenId, round: it.drawing, tx: it.tx })]);
      console.log(`${it.wallet} intent settled: tx ${it.tx} mined - ${it.count} ${retro ? 'retro ' : ''}ticket(s) booked`);
    } else {
      rec.refunded = true;
      console.log(`${it.wallet} intent settled: tx ${it.tx} reverted - no debit`);
    }
    (s.purchases ??= []).push(rec);
  }
}

// ── buy: credit ≥ live ticket price → tickets minted to the trader ─────────
export async function buy(only = null) {
  guard();
  await ensureFeed();
  if (cfg.END_MS && Date.now() > cfg.END_MS + cfg.BUY_GRACE_MS) { console.log('season over + grace: minting closed'); return load(); }
  const release = acquireLock(STATE);
  const rateLimited = new Set();                 // RPC urls that answered 'over rate limit' this cycle
  try { return await buyInner(only, rateLimited); }
  finally {
    // reported even when the cycle died on that very read; one line + event per hour
    try { if (rateLimited.size) await rpcAlert(rateLimited); } finally { release(); }
  }
}
// RPC: every url in RPC (config.js) behind one viem fallback, in order, 10 s each. A node
// that rate-limits us is skipped for the next url; its url lands here, once an hour.
async function rpcAlert(urls) {
  const s = load();
  if (!shouldAlert(s.alerts, alertKey('rpc_rate_limited'))) return;
  await alert(s, 'rpc_rate_limited', { url: [...urls].join(',') });
  save(s);
}
async function buyInner(only = null, rateLimited = new Set()) {
  const s = load();
  syncUsers(s);
  const n = net();
  const chain = cfg.TARGET === 'mainnet' ? base : baseSepolia;
  const transport = rpcTransport(n.rpcs);
  const pub = createPublicClient({ chain, transport });
  watchRateLimits(pub, (url) => rateLimited.add(url));
  const price = await pub.readContract({ address: n.jackpot, abi: jackpotAbi, functionName: 'ticketPrice' });
  const priceUsd = Number(formatUnits(price, 6));
  const drawing = await pub.readContract({ address: n.jackpot, abi: jackpotAbi, functionName: 'currentDrawingId' });
  const day = new Date().toISOString().slice(0, 10);
  console.log(`drawing #${drawing} · ticket $${priceUsd} · ${cfg.DRY_RUN ? 'DRY RUN — no funds move' : 'LIVE'}`);
  s.lastPriceUsd = priceUsd;

  let account = null, wallet = null;
  if (!cfg.DRY_RUN) {
    account = privateKeyToAccount(cfg.PRIVATE_KEY);
    wallet = createWalletClient({ account, chain, transport });
    watchRateLimits(wallet, (url) => rateLimited.add(url));
  } else if (cfg.PRIVATE_KEY) {
    try { account = privateKeyToAccount(cfg.PRIVATE_KEY); } catch { /* dry run without a usable key */ }
  } else if (cfg.POOL_WALLET) {
    account = { address: cfg.POOL_WALLET };          // rehearsal: read-only view of the pool wallet
  }
  const emits = [];
  const accountNonce = await latestNonce(pub, account?.address);
  await reconcileIntents(s, pub, accountNonce, emits);
  await reconcile(s, pub, priceUsd, accountNonce, emits);
  await flush(s, emits);

  // fee: 2x the base fee up to the hard ceiling; a spike above the alert line is
  // reported once an hour, above the ceiling buys wait (never a silent "skipped")
  let maxFee = cfg.MAX_FEE_WEI < cfg.MAX_FEE_CEILING_WEI ? cfg.MAX_FEE_WEI : cfg.MAX_FEE_CEILING_WEI;
  let feeOk = true;
  try {
    const blk = await pub.getBlock();
    const baseFee = blk?.baseFeePerGas ?? 0n;
    maxFee = feeCapFor(baseFee, cfg.MAX_FEE_CEILING_WEI, cfg.PRIORITY_FEE_WEI);
    if (feeSpike(baseFee, cfg.MAX_FEE_WEI)) await alert(s, 'fee_spike', { baseFeeGwei: formatUnits(baseFee, 9), alertGwei: formatUnits(cfg.MAX_FEE_WEI, 9), ceilingGwei: formatUnits(cfg.MAX_FEE_CEILING_WEI, 9) });
    if (baseFee > cfg.MAX_FEE_CEILING_WEI) { feeOk = false; console.log(`[megapot] base fee ${formatUnits(baseFee, 9)} gwei above ceiling ${formatUnits(cfg.MAX_FEE_CEILING_WEI, 9)} - USDC buys wait this cycle`); }
  } catch (e) { console.log(`[megapot] base fee unreadable (${e.message}) - using ${formatUnits(maxFee, 9)} gwei cap`); }

  // pool wallet funds: one ticket of USDC and three buys' worth of gas, or no USDC buys;
  // retro transfers need only the gas
  let fundsOk = true, gasOk = true;
  if (!cfg.DRY_RUN) {
    try {
      const [usdc, eth] = await Promise.all([
        pub.readContract({ address: n.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
        pub.getBalance({ address: account.address }),
      ]);
      const lf = lowFunds({ usdc, eth, priceUnits: price, maxFeeWei: cfg.MAX_FEE_WEI });
      if (lf.low) {
        fundsOk = false;
        gasOk = !lf.ethLow;
        const pendingCreditUsd = +Object.values(s.wallets).reduce((a, x) => a + Math.max(0, Number(x.creditUsdc || 0)), 0).toFixed(2);
        await alert(s, 'low_funds', { usdc: formatUnits(usdc, 6), eth: formatEther(eth), pendingCreditUsd, ethReserve: formatEther(lf.reserve) });
      }
    } catch (e) { console.log(`[megapot] balance check failed (${e.message}) - buys continue`); }
  }
  save(s);
  // RETRO INVENTORY: Megapot's daily tickets already sitting in the pool wallet, for the
  // ACTIVE round, verified on-chain. Handed out before any USDC moves.
  const inv = await inventory(pub, account?.address, drawing);

  const buyTargets = only ? eligibleWallets().filter((x) => only.has(x)) : eligibleWallets();
  const reverted = [];
  const runFor = async (list, isRetry) => {
  for (const w of list) {
   try {
    const ws = wstate(s, w);
    if (ws.streakTicketsPending > 0) {
      // risk cohort: streak tickets release only as fees earned cover them (ROI-positive)
      const risk = riskOf(w);
      let want = ws.streakTicketsPending;
      if (risk) {
        const room = roiRoomTickets(ws, risk, priceUsd);
        if (room < want) console.log(`${w} streak grant ROI-HELD: ${want - room} of ${want} ticket(s) wait for fees (${roiLine(ws, risk)})`);
        want = Math.min(want, room);
      }
      // 30/day season-wide gate on streak-box tickets (FCFS); the rest wait
      const conv = want > 0 ? takeFromDailyGate(s, 'streakBox', cfg.STREAK_BOX ? Number(cfg.STREAK_BOX.dailyCap || 0) : 0, day, want) : 0;
      if (conv > 0) {
        ws.creditUsdc += conv * priceUsd;
        noteFree(ws, conv, priceUsd);
        ws.streakTicketsPending -= conv;
        console.log(`${w} streak grant credited: ${conv} ticket(s) at $${priceUsd} (day gate ${s.gates?.streakBox?.used}/${cfg.STREAK_BOX?.dailyCap || '-'})`);
      }
      if (ws.streakTicketsPending > 0) console.log(`${w} streak grant DEFERRED: ${ws.streakTicketsPending} ticket(s) wait for tomorrow (day gate full)`);
    }
    if (ws.bonusTicketsPending > 0) {
      const ftCap = cfg.FIRST_TRADE && cfg.FIRST_TRADE.dailyMintCap;
      if (ftCap && s.ftMintDay !== day) { s.ftMintDay = day; s.ftMintUsed = 0; }
      const room = ftCap ? Math.max(0, ftCap - (s.ftMintUsed || 0)) : ws.bonusTicketsPending;
      const conv = Math.min(ws.bonusTicketsPending, room);
      if (conv > 0) {
        ws.creditUsdc += conv * priceUsd;
        s.ftMintUsed = (s.ftMintUsed || 0) + conv;
        // a pack split across days by the gate accumulates - the record is the whole pack
        const prev = ws.firstTradeBonus || { tickets: 0 };
        ws.firstTradeBonus = { tickets: (prev.tickets || 0) + conv, priceUsd, grantedMs: Date.now(), firstGrantedMs: prev.firstGrantedMs || prev.grantedMs || Date.now() };
        noteFree(ws, conv, priceUsd);       // the pack is free value the ROI ledger must earn back
        ws.bonusTicketsPending -= conv;
        console.log(`${w} first-trade bonus credited: ${conv} ticket(s) (day gate ${s.ftMintUsed}/${ftCap || '-'})`);
      }
      if (ws.bonusTicketsPending > 0) {
        console.log(`${w} first-trade bonus DEFERRED: ${ws.bonusTicketsPending} ticket(s) wait for tomorrow (day gate full)`);
      }
    }
    if (walletOnHold(s, w)) { console.log(`${w} buy on hold: an earlier buy intent is unsettled`); continue; }
    // RETRO FIRST: tickets owed = min(affordable, per-user cap, 10); as many as the pool
    // wallet's inventory covers move by transferFrom, the rest buys with USDC below.
    // Retro tickets count toward the day/week/user caps but never toward spentUsdc.
    const owed = Math.min(Math.floor(ws.creditUsdc / priceUsd), userCapLeft(s, w, day, CAPS), 10);
    if (owed > 0 && inv.tokenIds.length) {
      const { tokenIds } = allocateRetro(owed, inv.tokenIds);
      if (cfg.DRY_RUN) console.log(`${w} WOULD transfer ${tokenIds.length} retro ticket(s) (round ${inv.round}) → ${w}`);
      else if (!gasOk) console.log(`${w} retro transfer held: pool wallet low on ETH`);
      else if (!feeOk) console.log(`${w} retro transfer held: base fee above ceiling`);
      else {
        const held = await transferRetro({ s, ws, w, tokenIds, inv, pub, account, chain, day, priceUsd, maxFee, emits });
        if (held) continue;                       // a transfer send failed: wallet on hold until reconciled
      }
    }
    const dayCount = ws.tickets[day] || 0;
    const budgetLeft = budgetTickets(s, priceUsd);
    // 5/day + 15/week are per USER: every linked wallet's tickets count (users.js). The
    // decision itself is decideBuy (status.js): the hub's status row is the same call
    const { count, affordable, capLeft } = decideBuy(ws, { ...userCapRoom(s, w, day, CAPS), priceUsd, budgetLeft });
    if (count < 1) { console.log(`${w} credit $${ws.creditUsdc.toFixed(4)} → 0 tickets (affordable ${affordable}, cap ${capLeft}, budget ${budgetLeft})`); continue; }

    if (cfg.DRY_RUN) {
      console.log(`${w} WOULD buy ${count} ticket(s) → recipient ${w}, referrer ${cfg.TREASURY || '(unset)'}`);
      continue;
    }
    if (!fundsOk) { console.log(`${w} buy held: pool wallet low on funds (${count} ticket(s) wait)`); continue; }
    if (!feeOk) { console.log(`${w} buy held: base fee above ceiling (${count} ticket(s) wait)`); continue; }
    const cost = price * BigInt(count);
    // grants/credits above are committed before any wire call
    save(s);
    // STANDING ALLOWANCE (see allowance.js): approve only when the buyer's
    // allowance cannot cover this buy, and then for ~1000 tickets. The
    // per-buy approve->buy pair reverted with "transfer amount exceeds
    // allowance" on mainnet when the buy executed before the fresh approval
    // was visible; a standing allowance has no such window.
    let allowance = await pub.readContract({ address: n.usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, n.randomBuyer] });
    const approveFor = planApproval(allowance, cost, price);
    if (approveFor != null) {
      // explicit gas: the reverted approvals (nonce 10/17 on 2026-09-02) ran out of gas
      // at ~36k because the estimate came from a node that still saw the OLD non-zero
      // allowance (cheap SSTORE) while execution wrote zero -> non-zero (20k more).
      const h1 = await wallet.writeContract({ address: n.usdc, abi: erc20Abi, functionName: 'approve', args: [n.randomBuyer, approveFor], gas: 120_000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: cfg.PRIORITY_FEE_WEI });
      await pub.waitForTransactionReceipt({ hash: h1 });
      // the receipt is not the state: re-read until the node we buy through sees it
      for (let i = 0; i < 6 && allowance < cost; i++) {
        allowance = await pub.readContract({ address: n.usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, n.randomBuyer] });
        if (allowance < cost) await sleep(1500);
      }
      if (allowance < cost) { console.log(`${w} buy deferred: allowance ${allowance} still below cost ${cost} after approval - next cycle`); continue; }
      console.log(`standing allowance set: ${approveFor} (tx ${h1})`);
    }
    const buyArgs = [BigInt(count), w, cfg.TREASURY ? [cfg.TREASURY] : [], cfg.TREASURY ? [10n ** 18n] : [], keccak256(toHex(cfg.SOURCE_TAG))];
    // dry-run the exact call first: a would-be revert costs no gas, no ledger
    // debit and no refund cycle - the wallet simply waits for the next cycle
    try {
      await pub.simulateContract({ address: n.randomBuyer, abi: buyerAbi, functionName: 'buyTickets', args: buyArgs, account });
    } catch (e) {
      console.log(`${w} buy would revert - skipped this cycle: ${(e.shortMessage || e.message || '').split('\n')[0]}`);
      continue;
    }
    // SEND-THEN-PERSIST, inverted: pin the nonce, sign locally so the hash is known,
    // write the INTENT (wallet, count, nonce, hash) to the ledger, and only then
    // broadcast. A lost RPC response or a kill after the send leaves a record that
    // reconcileIntents() settles by nonce - never a second buy for the same credit.
    // explicit gas: the quick-pick path's cost is variable (entropy + per-ticket
    // loops) and estimation both underestimates it (observed 5.42M used of a
    // 5.5M limit -> on-chain OOG revert) and races fresh approvals on laggy
    // RPCs. A generous fixed limit sidesteps both; unused gas is refunded.
    const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const signed = await signPinned(account, chain.id, {
      to: n.randomBuyer, abi: buyerAbi, functionName: 'buyTickets', args: buyArgs,
      gas: buyGasFor(count),            // ~0.7M per ticket + fixed cost, with headroom (safety.js)
      maxFeePerGas: maxFee,             // min(2 x base fee, MAX_FEE_GWEI_CEILING)
      maxPriorityFeePerGas: cfg.PRIORITY_FEE_WEI,
      nonce,
    });
    const intent = { kind: 'buy', wallet: w, count, nonce, priceUsd, day, ts: Date.now(), drawing: drawing.toString(), tx: signed.hash };
    (s.intents ??= []).push(intent);
    save(s);
    let h2;
    try {
      h2 = await pub.sendRawTransaction({ serializedTransaction: signed.serialized });
    } catch (e) {
      // maybe broadcast, maybe not: the intent stays and the wallet is on hold until
      // reconcileIntents() sees the nonce consumed (book it) or 30 min pass (drop it)
      console.log(`${w} buy send failed (intent kept, nonce ${nonce}, tx ${signed.hash}): ${(e.shortMessage || e.message || '').split('\n')[0]}`);
      continue;
    }
    // the tx hash is on disk BEFORE we wait for the receipt: a crash or RPC
    // timeout here must never lead to a second buy for the same credit.
    // reconcile() settles the receipt (success -> verified, reverted ->
    // refund) on later cycles; until then the credit stays debited.
    s.intents = s.intents.filter((x) => x !== intent);
    ws.creditUsdc -= count * priceUsd;
    ws.tickets[day] = dayCount + count;
    s.spentUsdc += count * priceUsd;
    const rec = { ts: Date.now(), wallet: w, day, count, priceUsd, drawing: drawing.toString(), tx: h2, nonce, verified: false };
    (s.purchases ??= []).push(rec);
    save(s);
    console.log(`${w} buy PENDING (tx ${h2}, nonce ${nonce}) - ${count} ticket(s)`);
    const rc = await pub.waitForTransactionReceipt({ hash: h2 });
    if (rc.status !== 'success') {
      // mined but REVERTED: refund exactly what was debited (tx 0x605689d2 once ate a day cap)
      console.log(`${w} buy REVERTED on-chain (tx ${h2}) - refunded${isRetry ? '' : ' - will retry once'}`);
      ws.creditUsdc += count * priceUsd; ws.tickets[day] = dayCount; if (!ws.tickets[day]) delete ws.tickets[day];
      s.spentUsdc -= count * priceUsd; rec.verified = true; rec.refunded = true;
      save(s);
      if (!isRetry) reverted.push(w);
      continue;
    }
    rec.verified = true; rec.notified = true; ws.lastMintMs = Date.now();
    console.log(`${w} bought ${count} ticket(s) → tx ${h2}`);
    emits.push([w, ...mintedEvent(rec, ws)]);
    await flush(s, emits);
   } catch (e) {
    console.log(`${w} buy skipped this cycle: ${e.message}`);
   }
  }
  };
  await runFor(buyTargets, false);
  await flush(s, emits);
  if (reverted.length) {
    // one retry after a short pause: sequential purchases in one pass have reverted
    // on-chain at ~76k gas (allowance/entropy timing) and succeeded next attempt
    console.log(`retrying ${reverted.length} reverted buy(s) once after 4s`);
    await sleep(4000);
    await runFor(reverted.splice(0), true);
  }
  // STATUS PUSH: the hub's per-wallet "queued / waiting on" is this post-sweep snapshot of
  // the ledger, never a client-side fee estimate. Rides the outbox with the emits.
  queueStatus(s, { day, priceUsd, budgetLeft: budgetTickets(s, priceUsd), fundsOk, feeOk, retroAvailable: inv.tokenIds.length });
  await flush(s, emits);
  save(s);
  beat();
  return s;
}

// ── retro inventory + transfer ────────────────────────────────────────────────
// Once per cycle: the venue API lists the pool wallet's tickets; keep the ACTIVE
// round, unclaimed, no winnings; confirm ownerOf == pool on-chain for each. API or
// chain down = no retro this cycle (the USDC path continues), never a guess.
async function markBurnedAsClaimed(pub, rows) {
  if (!cfg.TICKET_NFT || !Array.isArray(rows)) return rows;
  const cand = rows.filter((t) => t && t.claimed !== true && Number(t.winnings_amount?.amount ?? t.winnings_amount ?? 0) > 0 && /^[0-9]+$/.test(String(t.user_ticket_id ?? '')));
  if (!cand.length) return rows;
  try {
    const owners = await pub.multicall({ allowFailure: true, contracts: cand.map((t) => ({ address: cfg.TICKET_NFT, abi: erc721Abi, functionName: 'ownerOf', args: [BigInt(t.user_ticket_id)] })) });
    const burned = new Set(cand.filter((t, i) => owners[i]?.status !== 'success').map((t) => String(t.user_ticket_id)));
    if (!burned.size) return rows;
    return rows.map((t) => (burned.has(String(t?.user_ticket_id)) ? { ...t, claimed: true, claimedOnChain: true } : t));
  } catch { return rows; }                      // read failure: keep the venue's view, retry next sweep
}
async function inventory(pub, pool, drawing) {
  const none = { round: null, tokenIds: [] };
  if (!retroEnabled() || !pool || drawing == null) return none;
  try {
    // ON-CHAIN, no venue API: the jackpot's currentDrawingId (read by the caller) plus the
    // ticket NFT's getUserTickets(pool, drawingId) lists every ticket the pool holds for the
    // active draw. api.megapot.io rate-limits per IP (429 seen from the VM) and the retro
    // path must not depend on it. ownerOf is re-checked in one multicall: a ticket the
    // pool already transferred is still listed under its original recipient.
    const round = String(drawing);
    const rows = await pub.readContract({ address: cfg.TICKET_NFT, abi: erc721Abi, functionName: 'getUserTickets', args: [pool, BigInt(drawing)] });
    const candidates = [...new Set((rows || []).map((r) => String(r.ticketId ?? r[0])).filter((id) => /^[0-9]+$/.test(id)))];
    if (!candidates.length) { console.log(`[megapot] retro inventory: none held for round ${round}`); return { round, tokenIds: [] }; }
    const owners = await pub.multicall({ allowFailure: true, contracts: candidates.map((id) => ({ address: cfg.TICKET_NFT, abi: erc721Abi, functionName: 'ownerOf', args: [BigInt(id)] })) });
    const tokenIds = candidates.filter((id, i) => owners[i]?.status === 'success' && String(owners[i].result).toLowerCase() === String(pool).toLowerCase());
    console.log(`[megapot] retro inventory: ${tokenIds.length} ticket(s) held for round ${round} (${candidates.length} listed on-chain)`);
    return { round, tokenIds };
  } catch (e) {
    console.log(`[megapot] retro inventory unavailable (${String(e.shortMessage || e.message).split('\n')[0]}) - USDC path only this cycle`);
    return none;
  }
}
// transferFrom(pool, user, tokenId) per ticket, intent-first like a buy. Success debits
// one ticket of credit, counts toward the day cap, books a kind:'retro' purchase and
// reports the grant; a revert drops the token from inventory with no debit.
// Returns true when the wallet must be left on hold (a send failed with the intent kept).
async function transferRetro({ s, ws, w, tokenIds, inv, pub, account, chain, day, priceUsd, maxFee, emits }) {
  for (const tokenId of tokenIds) {
    let nonce, signed;
    try {
      nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
      signed = await signPinned(account, chain.id, {
        to: cfg.TICKET_NFT, abi: erc721Abi, functionName: 'transferFrom', args: [account.address, w, BigInt(tokenId)],
        gas: 200_000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: cfg.PRIORITY_FEE_WEI, nonce,
      });
    } catch (e) { console.log(`${w} retro #${tokenId} skipped (prepare failed): ${e.message}`); return false; }
    const intent = { kind: 'transfer', wallet: w, count: 1, tokenId, nonce, priceUsd, day, ts: Date.now(), drawing: inv.round, tx: signed.hash };
    (s.intents ??= []).push(intent);
    save(s);
    let hash;
    try { hash = await pub.sendRawTransaction({ serializedTransaction: signed.serialized }); }
    catch (e) {
      console.log(`${w} retro #${tokenId} send failed (intent kept, nonce ${nonce}, tx ${signed.hash}): ${(e.shortMessage || e.message || '').split('\n')[0]}`);
      inv.tokenIds = inv.tokenIds.filter((x) => x !== tokenId);
      return true;
    }
    s.intents = s.intents.filter((x) => x !== intent);
    inv.tokenIds = inv.tokenIds.filter((x) => x !== tokenId);
    const dayCount = ws.tickets[day] || 0;
    ws.creditUsdc -= priceUsd;
    ws.tickets[day] = dayCount + 1;
    s.retroUsd = (s.retroUsd || 0) + priceUsd;
    s.retroTicketsUsed = (s.retroTicketsUsed || 0) + 1;
    const rec = { ts: Date.now(), wallet: w, day, count: 1, priceUsd, drawing: inv.round, tx: hash, nonce, verified: false, kind: 'retro', tokenId };
    (s.purchases ??= []).push(rec);
    save(s);
    console.log(`${w} retro transfer PENDING (tx ${hash}, nonce ${nonce}) - ticket #${tokenId}`);
    let rc;
    try { rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }); }
    catch (e) { console.log(`${w} retro #${tokenId} receipt not yet seen (${e.message}) - reconcile settles it`); return false; }
    if (rc.status !== 'success') {
      console.log(`${w} retro transfer REVERTED (tx ${hash}) - ticket #${tokenId} dropped from inventory, no debit`);
      ws.creditUsdc += priceUsd; ws.tickets[day] = dayCount; if (!ws.tickets[day]) delete ws.tickets[day];
      s.retroUsd -= priceUsd; s.retroTicketsUsed -= 1; rec.verified = true; rec.refunded = true;
      save(s);
      continue;
    }
    rec.verified = true; rec.notified = true; ws.lastMintMs = Date.now();
    console.log(`${w} retro ticket #${tokenId} transferred → tx ${hash} (round ${inv.round}, ${s.retroTicketsUsed} retro used)`);
    emits.push([w, ...mintedEvent(rec, ws)]);
    emits.push([w, '$grant', grantBody({ wallet: w, tokenId, round: inv.round, tx: hash })]);
    await flush(s, emits);
  }
  return false;
}

// ── fast lane: accrue + buy for wallets with a FRESH execution receipt ────────
// Runs between full sweeps (every ENGINE_FAST_S). The backend lists wallets that
// recorded a fill since the last fast run, so a validated trade mints within
// seconds while Hyperliquid is only polled for those wallets.
const FAST_STATE = `state/fast.${cfg.TARGET}.json`;
const fastLaneUrl = () => cfg.ACTIVE_URL || (cfg.USERS_URL ? cfg.USERS_URL.replace(/\/api\/admin\/wallets.*$/, '/api/admin/active-wallets') : '');
export async function fastLane() {
  guard();
  const url = fastLaneUrl();
  if (!url || url === cfg.USERS_URL) return;
  let since = Date.now() - 10 * 60_000;
  try { since = Number(JSON.parse(fs.readFileSync(FAST_STATE, 'utf8')).since) || since; } catch { /* first run */ }
  const startedAt = Date.now();
  let wallets = [];
  try {
    const r = await fetchT(`${url}${url.includes('?') ? '&' : '?'}since_ms=${since - 30_000}`, { headers: authHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    wallets = (Array.isArray(j) ? j : j.wallets || []).map((w) => String(w).toLowerCase());
  } catch (e) { console.log(`[megapot] fast lane: active feed unreachable (${e.message})`); return; }
  // the watermark advances only after a successful run: a failed accrue/buy re-covers
  // the same window next time instead of losing those wallets' fast mints
  const commit = () => { try { fs.writeFileSync(FAST_STATE, JSON.stringify({ since: startedAt })); } catch { /* best-effort */ } };
  if (!wallets.length) { commit(); return; }
  await ensureFeed();
  const elig = new Set(eligibleWallets());
  const only = new Set(wallets.filter((w) => elig.has(w)));
  if (!only.size) { commit(); return; }
  console.log(`[megapot] fast lane: ${only.size} active wallet(s)`);
  await accrue(only);
  await buy(only);
  commit();
}

// aggregates only - the wallet map never goes to the container log (it is the ledger)
export function status() {
  const s = load();
  const mode = !cfg.ACTIVE ? 'INACTIVE' : cfg.WHITELIST.length ? 'PRE-PRODUCTION (whitelist)' : 'POST-PRODUCTION (open)';
  // honesty rule for any downstream public surface: publicFlag = active AND NOT whitelist
  const publicFlag = cfg.ACTIVE && !cfg.WHITELIST.length;
  const day = new Date().toISOString().slice(0, 10);
  const ws = Object.values(s.wallets || {});
  const sum = (f) => +ws.reduce((a, x) => a + (Number(f(x)) || 0), 0).toFixed(4);
  console.log(JSON.stringify({
    mode, publicFlag, target: cfg.TARGET, dryRun: cfg.DRY_RUN, startMs: cfg.START_MS, endMs: cfg.END_MS, cohort: cfg.WHITELIST.length || 'open',
    wallets: ws.length, users: new Set(Object.values(s.users || {})).size || undefined,
    creditSumUsd: sum((x) => x.creditUsdc), pendingBonusTickets: sum((x) => (x.bonusTicketsPending || 0) + (x.streakTicketsPending || 0)),
    ticketsToday: sum((x) => x.tickets?.[day] || 0), ticketsTotal: sum((x) => Object.values(x.tickets || {}).reduce((a, b) => a + b, 0)),
    spentUsdc: s.spentUsdc, retroUsd: s.retroUsd || 0, retroTicketsUsed: s.retroTicketsUsed || 0,
    pools: { packs: `${s.firstTradePoolUsed || 0}/${cfg.FIRST_TRADE?.poolTickets ?? '-'}`, boxes: `${s.streakBoxPoolUsed || 0}/${cfg.STREAK_BOX?.poolTickets ?? '-'}`, multiplierUsd: +(s.multiplierBonusUsd || 0).toFixed(2) },
    intentsPending: (s.intents || []).length, purchasesUnverified: (s.purchases || []).filter((p) => !p.verified).length,
    outboxPending: (s.outbox || []).length, accrueSkipStreak: s.accrueSkipStreak || 0,
  }, null, 2));
}

let _bannered = false;
function banner() {
  if (_bannered) return;
  _bannered = true;
  const iso = (ms) => new Date(ms).toISOString();
  console.log(`[megapot] window ${iso(cfg.START_MS)}..${cfg.END_MS ? iso(cfg.END_MS) : 'open'} (source ${process.env.START_MS ? 'env' : 'sheet'}|${process.env.END_MS ? 'env' : 'sheet'})`);
  const fl = fastLaneUrl();
  console.log(`[megapot] fast lane ${fl && fl !== cfg.USERS_URL ? fl : 'disabled'}`);
  console.log(`[megapot] rpc ${net().rpcs.join(', ')} (fallback in order, ${RPC_TIMEOUT_MS / 1000}s each)`);
  console.log(`[megapot] status push ${cfg.STATUS_URL || 'disabled (no STATUS_URL / USERS_URL)'}`);
  if (!cfg.SPOT_FILLS_URL) console.log('[megapot] spot accrual OFF (no SPOT_FILLS_URL)');
}
function guard() {
  if (!cfg.ACTIVE) throw new Error('MEGAPOT_ACTIVE != 1 - campaign is off. To pause a whitelist test, set ACTIVE=0; never clear the whitelist (empty = open to ALL).');
  if (!cfg.START_MS) throw new Error('START_MS is required - set the campaign start before running (historical fills must never credit).');
  if (!cfg.DRY_RUN && !cfg.PRIVATE_KEY) throw new Error('LIVE mode needs PRIVATE_KEY (the capped pool wallet).');
  if (!cfg.DRY_RUN && cfg.TARGET === 'mainnet' && !cfg.TREASURY) throw new Error('LIVE mainnet needs TREASURY set.');
  banner();
}


// ── win sweep: venue-observed winnings → Customer.io events ────────────────
// Once per ticket id (ledger-marked): 'megapot_win_unclaimed' when a win shows
// with claimed=false, 'megapot_win_claimed' when the claim flips true. Powers
// the "you won - claim it" reminder workflows. Runs only when Customer.io is
// configured; the venue API is public and the sweep never touches the wire.
// Bounded: 8 wallets in flight, 4 minutes wall clock, under the ledger lock.
// Transferred tickets: the venue files a retro ticket under the POOL wallet for good, so
// its win never reaches the user's rows. Once per sweep the pool's rows are read, every
// winner's ownerOf resolved in one multicall, and a ticket a user holds (or claimed -
// burned - per the ledger's transfer record) is swept as that user's: same win dedupe
// and events (source:'retro'), same daily status totals, plus a grant upsert so the
// backend's record carries the win. Chain or venue down = no attribution this sweep.
const SWEEP_CONCURRENCY = 8;
const SWEEP_BUDGET_MS = 4 * 60_000;
const venueTickets = (w) => fetchT(`https://api.megapot.io/v1/wallets/${w}/tickets`);
const poolAddress = () => {
  if (cfg.PRIVATE_KEY) { try { return privateKeyToAccount(cfg.PRIVATE_KEY).address.toLowerCase(); } catch { /* no usable key: fall through */ } }
  return cfg.POOL_WALLET || '';
};
const _unknownOwnerLogged = new Set();                 // one log line per ticket per process
/** wallet -> rows the pool's venue rows hand to that wallet; {} when anything is unavailable.
 *  Sets throttled() on a 429 like every other venue call. */
async function transferredWins(s, pub, { throttled, onThrottle }) {
  const pool = poolAddress();
  if (!pool || !cfg.TICKET_NFT || throttled()) return {};
  try {
    const r = await venueTickets(pool);
    if (r.status === 429) { onThrottle(); return {}; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const rows = Array.isArray(j?.data) ? j.data : [];
    const winners = rows.filter((t) => t && usdOf(t) > 0 && /^[0-9]+$/.test(String(t.user_ticket_id ?? '')));
    if (!winners.length) return {};
    const res = await pub.multicall({ allowFailure: true, contracts: winners.map((t) => ({ address: cfg.TICKET_NFT, abi: erc721Abi, functionName: 'ownerOf', args: [BigInt(t.user_ticket_id)] })) });
    const owners = Object.fromEntries(winners.map((t, i) => [String(t.user_ticket_id), res[i]?.status === 'success' ? String(res[i].result).toLowerCase() : null]));
    const byWallet = {};
    const hits = attributeTransferredWins(winners, owners, eligibleWallets(), {
      pool, transfers: transfersFromLedger(s),
      onUnknown: (id, owner, t) => {
        if (_unknownOwnerLogged.has(id)) return;
        _unknownOwnerLogged.add(id);
        console.log(`[megapot] win sweep: pool ticket #${id} (round ${t.round_id ?? '?'}, $${usdOf(t).toFixed(2)}) ${owner === null ? 'is burned and no transfer record names its holder' : `is held by ${owner}, not an enrolled wallet`} - not attributed`);
      },
    });
    for (const { wallet, row } of hits) (byWallet[wallet] ??= []).push(row);
    if (hits.length) console.log(`[megapot] win sweep: ${hits.length} transferred-ticket win(s) attributed to ${Object.keys(byWallet).length} wallet(s) (${winners.length} winner(s) under the pool)`);
    return byWallet;
  } catch (e) {
    console.log(`[megapot] win sweep: transferred-ticket wins unavailable (${String(e.shortMessage || e.message).split('\n')[0]}) - skipped this sweep`);
    return {};
  }
}
export async function winSweep() {
  if (!commsEnabled()) return;
  guard();
  await ensureFeed();
  const release = acquireLock(STATE);
  try { await winSweepInner(); } finally { release(); }
}
async function winSweepInner() {
  const s = load();
  const sweepPub = createPublicClient({ chain: cfg.TARGET === 'mainnet' ? base : baseSepolia, transport: rpcTransport(net().rpcs) });
  // per-IP venue rate limit: after a 429 the whole sweep stands down for 10 minutes
  // (status/attrs re-emit next time; nothing is lost) instead of hammering every wallet
  if ((s.venueBackoffUntil || 0) > Date.now()) { console.log(`[megapot] win sweep: venue rate-limited, standing down until ${new Date(s.venueBackoffUntil).toISOString()}`); return; }
  let throttled = false;
  // the active round once per sweep - "tickets in tonight's draw" needs it
  let currentRound = null, poolUsd = null;
  try {
    const r = await fetchT('https://api.megapot.io/v1/rounds/active');
    const j = await r.json();
    if (j?.id != null) currentRound = String(j.id);
    if (j?.prize_pool?.amount != null) poolUsd = Number(j.prize_pool.amount) / 10 ** Number(j.prize_pool.decimals ?? 6);
  } catch { /* status still emits without the draw count */ }
  // tickets the pool wallet minted today across all users - the "23 tickets minted today" line
  const todayKey = new Date().toISOString().slice(0, 10);
  const mintedToday = (s.purchases || []).filter((p) => p.day === todayKey && !p.refunded).reduce((a, p) => a + p.count, 0);
  // wins the venue still files under the pool wallet for tickets the retro path handed out
  const transferred = await transferredWins(s, sweepPub, { throttled: () => throttled, onThrottle: () => { throttled = true; } });
  const sweepEmits = [];
  const one = async (w) => {
    const ws = wstate(s, w);
    const extra = transferred[w] || [];
    // idle wallets (no Hence volume, no tickets, no pack) cannot hold a Hence win:
    // skip the venue call so the per-IP rate limit is spent on wallets that matter
    if (!((ws.volumeUsd || 0) > 0 || Object.keys(ws.tickets || {}).length || ws.packGranted || (ws.lastStatus?.ticketsInDraw || 0) > 0 || extra.length)) return;
    let rows = [];
    try {
      if (throttled) return;
      const r = await venueTickets(w);
      if (r.status === 429) { throttled = true; return; }
      const j = await r.json();
      rows = Array.isArray(j?.data) ? j.data : [];
    } catch { return; }                         // venue hiccup: next cycle retries
    // TICKET LIFECYCLE: daily status event + profile attributes (once a day,
    // and again the moment the draw count or claimable money changes)
    // a claimed ticket is BURNED on-chain; the venue API's `claimed` flag lags a claim
    // made on megapot.io, so confirm ownership before telling anyone they have money to
    // claim (the hub does the same before it offers the claim button)
    rows = await markBurnedAsClaimed(sweepPub, rows);
    // transferred-ticket wins join this wallet's rows (ownership already settled on-chain;
    // an id the venue also lists under the user is never counted twice)
    if (extra.length) { const own = new Set(rows.map((t) => String(t?.user_ticket_id ?? ''))); rows = rows.concat(extra.filter((t) => !own.has(String(t.user_ticket_id)))); }
    const st = dailyStatus({ ws, rows, currentRound, priceUsd: s.lastPriceUsd || 1, startMs: cfg.START_MS, poolUsd, mintedToday });
    const emits = [];
    if (shouldEmit(ws.lastStatus, st)) {
      ws.lastStatus = statusKey(st);
      emits.push([w, 'megapot_daily_status', st]);
      // an enrolled wallet that never traded and holds no ticket gets no daily profile
      // write - nothing on it changed, and it is most of the feed
      const idle = !(ws.volumeUsd > 0) && rows.length === 0;
      if (!idle) emits.push([w, '$identify', attrs(st)]);
    }
    rows.forEach((t, i) => {
      const id = winId(t, i);
      if (!id) return;
      const tr = winTransition((ws.cioWins ??= {})[id], t);
      if (!tr) return;
      const usd = Number(dailyStatus({ ws: {}, rows: [t] }).wonLifetimeUsd);
      // 'pending' blocks a re-queue; the marker flips to notified/claimed only once the
      // outbox delivered the event (2xx)
      ws.cioWins[id] = 'pending';
      const retro = t._source === 'retro';
      emits.push([w, tr.event, { usd, round: String(t.round_id ?? ''), ticketId: id, ...(retro ? { source: 'retro' } : {}) }, { win: { wallet: w, id, state: tr.state } }]);
      // the backend's grant record (upsert on tokenId) learns the win on the same transition
      // the event fires on: once unclaimed, once more when the claim burns the ticket
      if (retro) emits.push([w, '$grant', winGrantBody({ wallet: w, tokenId: id, round: t.round_id, tx: t._tx, ts: t._ts, winningsUsd: usdOf(t), claimed: t.claimed === true, claimedTx: claimTxOf(t), settledAt: Date.now() })]);
    });
    if (emits.length) sweepEmits.push(...emits);
  };
  const { done, skipped } = await mapLimit(eligibleWallets(), SWEEP_CONCURRENCY, one, { budgetMs: SWEEP_BUDGET_MS });
  if (skipped > 0) console.log(`[megapot] win sweep: ${done} wallet(s) swept, ${skipped} skipped (time budget ${SWEEP_BUDGET_MS / 1000}s)`);
  if (throttled) { s.venueBackoffUntil = Date.now() + 10 * 60_000; console.log(`[megapot] ALERT venue_rate_limited: api.megapot.io returned 429 during the win sweep - standing down 10 min`); }
  // ledger first (markers + queue), then delivery; retries ride the next sweep
  await flush(s, sweepEmits);
  save(s);
}
