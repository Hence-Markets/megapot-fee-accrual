import fs from 'node:fs';
import crypto from 'node:crypto';
import { rollStreakBox, boxFor } from './streakBox.js';
import { createPublicClient, createWalletClient, http, formatUnits, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { cfg, net, jackpotAbi, buyerAbi, erc20Abi } from './config.js';
import { track, commsEnabled } from './comms.js';

// Eligible set per the feature-gates conventions: whitelist = pre-production
// cohort; empty whitelist = open mode, full user feed. Pause = ACTIVE=0.
// Open mode takes the feed from USERS_URL (the hence backend's admin wallet
// feed, refreshed each cycle with a disk cache to ride out outages) or
// USERS_FILE (static JSON). Rows may be plain "0x…" strings or
// {wallet, emailBound} objects; emailBound gates ACTIVATION PACKS only -
// volume accrual never depends on it.
const FEED_CACHE = `state/users.feed.${cfg.TARGET}.json`;
let _feed = null;
const _parseRows = (rows) => {
  const wallets = [], emailBound = {};
  for (const row of rows) {
    const obj = typeof row === 'object' && row !== null;
    const w = String(obj ? row.wallet : row).trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(w)) continue;    // malformed entries drop - never match
    wallets.push(w);
    emailBound[w] = obj ? !!(row.emailBound ?? row.email_bound) : true;
  }
  return { wallets, emailBound };
};
export async function ensureFeed() {
  if (cfg.WHITELIST.length) { _feed = { wallets: cfg.WHITELIST, emailBound: null }; return; }
  if (cfg.USERS_URL) {
    try {
      const r = await fetch(cfg.USERS_URL, { headers: cfg.USERS_TOKEN ? { Authorization: `Bearer ${cfg.USERS_TOKEN}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      _feed = _parseRows(Array.isArray(j) ? j : j.wallets || []);
      try { fs.writeFileSync(FEED_CACHE, JSON.stringify(_feed)); } catch { /* cache is best-effort */ }
    } catch (e) {
      try {
        _feed = JSON.parse(fs.readFileSync(FEED_CACHE, 'utf8'));
        console.log(`[megapot] user feed unreachable (${e.message}) - continuing on cached feed (${_feed.wallets.length} wallets)`);
      } catch { throw new Error(`Open mode: user feed unreachable and no cache yet (${e.message})`); }
    }
    return;
  }
  if (!cfg.USERS_FILE) throw new Error('Open mode (empty MEGAPOT_WHITELIST) requires USERS_URL or USERS_FILE - empty whitelist means EVERYONE, and the engine needs the user feed to know who that is.');
  _feed = _parseRows(JSON.parse(fs.readFileSync(cfg.USERS_FILE, 'utf8')));
}
export function eligibleWallets() {
  if (!_feed) throw new Error('user feed not loaded - ensureFeed() runs at cycle start');
  return _feed.wallets;
}
// whitelist test cohorts (emailBound null) skip the email gate
const emailBound = (w) => (_feed && _feed.emailBound != null ? !!_feed.emailBound[w] : true);

// One ledger PER NETWORK: caps, spend and purchase records must not leak
// across the testnet→mainnet cutover (a $0.01 rehearsal ticket must never eat
// a $1 mainnet allowance, and reconcile must never look up a testnet tx on
// mainnet). The legacy un-suffixed file predates the split and was testnet.
const STATE = `state/ledger.${cfg.TARGET}.json`;
const LEGACY_STATE = 'state/ledger.json';

// ── ledger ──────────────────────────────────────────────────────────────────
// One JSON file: per-wallet fee credit (USDC, 6dp int), checkpoint of the last
// fill time already counted, tickets bought per day, lifetime spend.
export function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch {
    if (cfg.TARGET === 'testnet') {
      try { return JSON.parse(fs.readFileSync(LEGACY_STATE, 'utf8')); } catch { /* fresh */ }
    }
    return { wallets: {}, spentUsdc: 0 };
  }
}
export function save(s) {
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}
const wstate = (s, w) => (s.wallets[w] ??= { creditUsdc: 0, lastFillMs: cfg.START_MS, volumeUsd: 0, tickets: {} });

// ── venue fills (Hyperliquid public info API — venue-authoritative) ────────
async function fills(wallet, sinceMs) {
  const out = [];
  let start = sinceMs;
  for (let page = 0; page < 10; page++) { // paginate userFillsByTime (2k cap per call)
    const r = await fetch(cfg.HL_INFO, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userFillsByTime', user: wallet, startTime: start + 1, endTime: Date.now() }),
    });
    if (!r.ok) throw new Error(`HL info ${r.status}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < 2000) break;
    start = batch[batch.length - 1].time;
  }
  return out;
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
export async function accrue() {
  guard();
  await ensureFeed();
  const s = load();
  for (const w of eligibleWallets()) {
    const ws = wstate(s, w);
    const fs_ = await fills(w, ws.lastFillMs);
    let vol = 0, activationFill = null;
    const ftMin = cfg.FIRST_TRADE ? (cfg.FIRST_TRADE.minTradeUsd || 0) : Infinity;
    for (const f of fs_) {
      if (!qualifies(f.coin, f.time)) continue;
      const notional = Number(f.px) * Number(f.sz);
      if (activationFill == null && notional >= ftMin) activationFill = notional;
      vol += notional;
      const dstr = new Date(f.time).toISOString().slice(0, 10);
      (ws.days ??= {})[dstr] = (ws.days[dstr] || 0) + notional;
      ws.lastFillMs = Math.max(ws.lastFillMs, f.time);
    }
    // activation pack: granted ONCE per wallet, on the wallet's first
    // qualifying fill of >= minTradeUsd - a smaller starter trade must never
    // lock the pack out, so the qualifying notional persists on the ledger
    // until it can grant. In open mode the grant also waits for a bound email
    // (the user feed carries the flag); volume accrual is never held.
    const ft = cfg.FIRST_TRADE;
    if (ft) {
      const granted = !!(ws.packGranted || ws.firstTradeBonus || ws.bonusTicketsPending);
      if (!granted && activationFill != null) ws.packQualifiedUsd = Math.max(ws.packQualifiedUsd || 0, activationFill);
      // TnC: a single $250 fill OR $250 of COMBINED in-window volume qualifies -
      // small traders reach the pack by adding up, not only by one big trade.
      if (!granted && ((ws.volumeUsd || 0) + vol) >= (ft.minTradeUsd || 0)) {
        ws.packQualifiedUsd = Math.max(ws.packQualifiedUsd || 0, (ws.volumeUsd || 0) + vol);
      }
      if (!granted && (ws.packQualifiedUsd || 0) >= (ft.minTradeUsd || 0) && (ws.packQualifiedUsd || 0) > 0) {
        if (!emailBound(w)) {
          console.log(`${w} activation pack HELD: qualifying trade $${ws.packQualifiedUsd.toFixed(2)} awaits a bound email`);
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
            await track(w, 'megapot_activation_pack', { tickets: grant, qualifyingUsd: Math.round(ws.packQualifiedUsd) });
          } else {
            console.log(`${w} activation pack skipped: season pool exhausted (${ft.poolTickets})`);
          }
        }
      }
    }
    // streak checkpoints: N distinct trade days this week + cumulative volume
    // gate -> one-time grant per checkpoint per week, from a shared season pool.
    const st = cfg.STREAK;
    if (st && ws.days) {
      const nowD = new Date(); const dow = (nowD.getUTCDay() + 6) % 7;
      nowD.setUTCHours(0, 0, 0, 0);
      const mondayMs = nowD.getTime() - dow * 86400000;
      const weekKey = new Date(mondayMs).toISOString().slice(0, 10);
      let daysCount = 0, cum = 0;
      for (const [d, v] of Object.entries(ws.days)) {
        if (new Date(d + 'T00:00:00Z').getTime() >= mondayMs && v > 0) { daysCount++; cum += v; }
      }
      // STREAK BOX: one surprise box per distinct qualifying trade day across
      // the whole campaign (day N = Nth such day since START_MS). Rolled once,
      // recorded in ws.boxes so a replay never re-rolls. Shared season pool.
      const sb = cfg.STREAK_BOX;
      if (sb) {
        const boxes = (ws.boxes ??= {});
        const startDay = new Date(cfg.START_MS || 0).toISOString().slice(0, 10);
        const newDays = Object.entries(ws.days).filter(([d, v]) => v > 0 && d >= startDay && !boxes[d]).map(([d]) => d).sort();
        for (const d of newDays) {
          const dayN = Object.keys(boxes).length + 1;
          const poolLeft = (sb.poolTickets || Infinity) - (s.streakBoxPoolUsed || 0);
          const roll = rollStreakBox(dayN, () => crypto.randomInt(1_000_000) / 1_000_000);
          const grant = roll.won ? Math.min(roll.tickets, Math.max(0, poolLeft)) : 0;
          boxes[d] = { day: dayN, won: roll.won, tickets: grant };
          if (grant > 0) {
            ws.streakTicketsPending = (ws.streakTicketsPending || 0) + grant;
            s.streakBoxPoolUsed = (s.streakBoxPoolUsed || 0) + grant;
          }
          console.log(`${w} streak box day ${dayN} (${d}): ${roll.won ? `WON +${grant}` : 'empty'} (p ${roll.p}, size ${roll.size}, pool ${s.streakBoxPoolUsed || 0}/${sb.poolTickets})`);
          await track(w, 'megapot_streak_box', { day: dayN, dateUtc: d, won: roll.won, tickets: grant, p: roll.p, size: roll.size,
            nextDay: dayN + 1, nextP: boxFor(dayN + 1).p, nextSize: boxFor(dayN + 1).size });
        }
      }
      const g = ((ws.streakGrants ??= {})[weekKey] ??= {});
      for (const cp of (sb ? [] : (st.checkpoints || []))) {
        const key = 'd' + cp.day;
        const poolLeft = (st.poolTickets || Infinity) - (s.streakPoolUsed || 0);
        if (!g[key] && daysCount >= cp.day && cum >= cp.minCumulativeUsd && poolLeft >= cp.tickets) {
          ws.streakTicketsPending = (ws.streakTicketsPending || 0) + cp.tickets;
          s.streakPoolUsed = (s.streakPoolUsed || 0) + cp.tickets;
          g[key] = true;
          console.log(`${w} streak d${cp.day} grant: +${cp.tickets} ticket(s) (days ${daysCount}, cum $${cum.toFixed(0)}, pool ${s.streakPoolUsed}/${st.poolTickets})`);
          await track(w, 'megapot_streak_ticket', { day: cp.day, tickets: cp.tickets, weekVolumeUsd: Math.round(cum) });
        }
      }
      // one event per NEW distinct trade day - the anchor Customer.io
      // workflows wait on to send "trade today or the streak resets"
      for (const [d, v] of Object.entries(ws.days)) {
        if (v <= 0 || new Date(d + 'T00:00:00Z').getTime() < mondayMs) continue;
        if ((ws.cioDays ??= {})[d]) continue;
        ws.cioDays[d] = true;
        await track(w, 'megapot_streak_day', { dateUtc: d, dayOfWeekCount: daysCount, weekVolumeUsd: Math.round(cum) });
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
    const credit = vol * (cfg.FEE_BPS / 10_000) * cfg.ROLLOVER;
    ws.volumeUsd += vol;
    ws.creditUsdc += credit;
    console.log(`${w} +$${vol.toFixed(2)} qualifying volume → +$${credit.toFixed(4)} credit (total $${ws.creditUsdc.toFixed(4)})`);
  }
  save(s);
  return s;
}

// reconcile: every recorded purchase carries its tx hash; verification is the
// on-chain receipt itself, not an indexer's opinion. A purchase whose receipt
// is reverted (or vanished after a reorg window) refunds credit, cap and
// budget precisely. Mainnet-grade: no API-lag false positives.
async function reconcile(s, pub, priceUsd) {
  for (const p of s.purchases || []) {
    if (p.verified) continue;
    let status = null;
    try {
      const rc = await pub.getTransactionReceipt({ hash: p.tx });
      status = rc?.status ?? null;
    } catch { /* not found yet: leave unverified, re-check next cycle */ }
    if (status === 'success') { p.verified = true; continue; }
    if (status === 'reverted') {
      console.log(`${p.wallet} reconcile: tx ${p.tx} reverted — refunding ${p.count} ticket(s)`);
      const ws = s.wallets[p.wallet];
      const price = p.priceUsd ?? priceUsd;
      s.spentUsdc = Math.max(0, s.spentUsdc - p.count * price);
      if (ws) {
        ws.creditUsdc += p.count * price;
        if (ws.tickets?.[p.day] != null) {
          ws.tickets[p.day] = Math.max(0, ws.tickets[p.day] - p.count);
          if (!ws.tickets[p.day]) delete ws.tickets[p.day];
        }
      }
      p.verified = true; p.refunded = true;
    }
  }
}

// ── buy: credit ≥ live ticket price → tickets minted to the trader ─────────
export async function buy() {
  guard();
  await ensureFeed();
  const s = load();
  const n = net();
  const chain = cfg.TARGET === 'mainnet' ? base : baseSepolia;
  const pub = createPublicClient({ chain, transport: http(n.rpc) });
  const price = await pub.readContract({ address: n.jackpot, abi: jackpotAbi, functionName: 'ticketPrice' });
  const priceUsd = Number(formatUnits(price, 6));
  const drawing = await pub.readContract({ address: n.jackpot, abi: jackpotAbi, functionName: 'currentDrawingId' });
  const day = new Date().toISOString().slice(0, 10);
  console.log(`drawing #${drawing} · ticket $${priceUsd} · ${cfg.DRY_RUN ? 'DRY RUN — no funds move' : 'LIVE'}`);
  await reconcile(s, pub, priceUsd);

  let account = null, wallet = null;
  if (!cfg.DRY_RUN) {
    account = privateKeyToAccount(cfg.PRIVATE_KEY);
    wallet = createWalletClient({ account, chain, transport: http(n.rpc) });
  }

  for (const w of eligibleWallets()) {
    const ws = wstate(s, w);
    if (ws.streakTicketsPending > 0) {
      ws.creditUsdc += ws.streakTicketsPending * priceUsd;
      console.log(`${w} streak grant credited: ${ws.streakTicketsPending} ticket(s) at $${priceUsd}`);
      ws.streakTicketsPending = 0;
    }
    if (ws.bonusTicketsPending > 0) {
      const ftCap = cfg.FIRST_TRADE && cfg.FIRST_TRADE.dailyMintCap;
      if (ftCap && s.ftMintDay !== day) { s.ftMintDay = day; s.ftMintUsed = 0; }
      const room = ftCap ? Math.max(0, ftCap - (s.ftMintUsed || 0)) : ws.bonusTicketsPending;
      const conv = Math.min(ws.bonusTicketsPending, room);
      if (conv > 0) {
        ws.creditUsdc += conv * priceUsd;
        s.ftMintUsed = (s.ftMintUsed || 0) + conv;
        ws.firstTradeBonus = { tickets: conv, priceUsd, grantedMs: Date.now() };
        ws.bonusTicketsPending -= conv;
        console.log(`${w} first-trade bonus credited: ${conv} ticket(s) (day gate ${s.ftMintUsed}/${ftCap || '-'})`);
      }
      if (ws.bonusTicketsPending > 0) {
        console.log(`${w} first-trade bonus DEFERRED: ${ws.bonusTicketsPending} ticket(s) wait for tomorrow (day gate full)`);
      }
    }
    const affordable = Math.floor(ws.creditUsdc / priceUsd);
    const dayCount = ws.tickets[day] || 0;
    const week = Object.entries(ws.tickets).filter(([d]) => (Date.now() - new Date(d).getTime()) < 7*86400000).reduce((a, [,n]) => a + n, 0);
    const capLeft = Math.max(0, Math.min(cfg.MAX_TICKETS_PER_WALLET_PER_DAY - dayCount, cfg.MAX_TICKETS_PER_WALLET_PER_WEEK - week));
    const budgetLeft = Math.max(0, Math.floor((cfg.GLOBAL_BUDGET_USDC - s.spentUsdc) / priceUsd));
    const count = Math.min(affordable, capLeft, budgetLeft, 10); // buyer contract caps 10/call
    if (count < 1) { console.log(`${w} credit $${ws.creditUsdc.toFixed(4)} → 0 tickets (affordable ${affordable}, cap ${capLeft}, budget ${budgetLeft})`); continue; }

    if (cfg.DRY_RUN) {
      console.log(`${w} WOULD buy ${count} ticket(s) → recipient ${w}, referrer ${cfg.TREASURY || '(unset)'}`);
      continue;
    }
    const cost = price * BigInt(count);
    const h1 = await wallet.writeContract({ address: n.usdc, abi: erc20Abi, functionName: 'approve', args: [n.randomBuyer, cost] });
    await pub.waitForTransactionReceipt({ hash: h1 });
    // explicit gas: the quick-pick path's cost is variable (entropy + per-ticket
    // loops) and estimation both underestimates it (observed 5.42M used of a
    // 5.5M limit -> on-chain OOG revert) and races fresh approvals on laggy
    // RPCs. A generous fixed limit sidesteps both; unused gas is refunded.
    const h2 = await wallet.writeContract({
      address: n.randomBuyer, abi: buyerAbi, functionName: 'buyTickets',
      args: [BigInt(count), w, cfg.TREASURY ? [cfg.TREASURY] : [], cfg.TREASURY ? [10n ** 18n] : [], keccak256(toHex(cfg.SOURCE_TAG))],
      gas: 6_500_000n,                  // ~5.4M real usage + 20% headroom
      maxFeePerGas: cfg.MAX_FEE_WEI,    // default 0.018 gwei cap (Base ~0.006); MAX_FEE_GWEI env raises it
      maxPriorityFeePerGas: 500_000n,   // 0.0005 gwei tip
      // upfront reserve = gas*maxFee = 0.000117 ETH; keep the pool wallet's
      // native balance above that or the node rejects the send pre-hash.
    });
    const rc = await pub.waitForTransactionReceipt({ hash: h2 });
    // a mined-but-REVERTED buy must not touch the ledger: unchecked status
    // once recorded a phantom purchase that ate the daily cap (tx 0x605689d2)
    if (rc.status !== 'success') {
      console.log(`${w} buy REVERTED on-chain (tx ${rc.transactionHash}) — ledger untouched`);
      continue;
    }
    ws.creditUsdc -= count * priceUsd;
    ws.tickets[day] = dayCount + count;
    s.spentUsdc += count * priceUsd;
    (s.purchases ??= []).push({ ts: Date.now(), wallet: w, day, count, priceUsd, drawing: drawing.toString(), tx: rc.transactionHash, verified: false });
    console.log(`${w} bought ${count} ticket(s) → tx ${rc.transactionHash}`);
    await track(w, 'megapot_tickets_minted', { count, txHash: rc.transactionHash });
  }
  save(s);
  return s;
}

export function status() {
  const s = load();
  const mode = !cfg.ACTIVE ? 'INACTIVE' : cfg.WHITELIST.length ? 'PRE-PRODUCTION (whitelist)' : 'POST-PRODUCTION (open)';
  // honesty rule for any downstream public surface: publicFlag = active AND NOT whitelist
  const publicFlag = cfg.ACTIVE && !cfg.WHITELIST.length;
  console.log(JSON.stringify({ mode, publicFlag, target: cfg.TARGET, dryRun: cfg.DRY_RUN, startMs: cfg.START_MS, cohort: cfg.WHITELIST.length || 'open', spentUsdc: s.spentUsdc, wallets: s.wallets }, null, 2));
}

function guard() {
  if (!cfg.ACTIVE) throw new Error('MEGAPOT_ACTIVE != 1 - campaign is off. To pause a whitelist test, set ACTIVE=0; never clear the whitelist (empty = open to ALL).');
  if (!cfg.START_MS) throw new Error('START_MS is required - set the campaign start before running (historical fills must never credit).');
  if (!cfg.DRY_RUN && !cfg.PRIVATE_KEY) throw new Error('LIVE mode needs PRIVATE_KEY (the capped pool wallet).');
  if (!cfg.DRY_RUN && cfg.TARGET === 'mainnet' && !cfg.TREASURY) throw new Error('LIVE mainnet needs TREASURY set.');
}


// ── win sweep: venue-observed winnings → Customer.io events ────────────────
// Once per ticket id (ledger-marked): 'megapot_win_unclaimed' when a win shows
// with claimed=false, 'megapot_win_claimed' when the claim flips true. Powers
// the "you won - claim it" reminder workflows. Runs only when Customer.io is
// configured; the venue API is public and the sweep never touches the wire.
export async function winSweep() {
  if (!commsEnabled()) return;
  guard();
  await ensureFeed();
  const s = load();
  for (const w of eligibleWallets()) {
    const ws = wstate(s, w);
    let rows = [];
    try {
      const r = await fetch(`https://api.megapot.io/v1/wallets/${w}/tickets`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      rows = Array.isArray(j?.data) ? j.data : [];
    } catch { continue; }                       // venue hiccup: next cycle retries
    for (const t of rows) {
      const wa = t.winnings_amount;
      const usd = wa && typeof wa === 'object' ? Number(wa.amount || 0) / 10 ** (wa.decimals ?? 6) : Number(wa || 0) / 1e6;
      if (!(usd > 0)) continue;
      const id = String(t.user_ticket_id ?? t.tx_hash ?? '');
      if (!id) continue;
      const seen = (ws.cioWins ??= {})[id];
      if (!seen && t.claimed === false) {
        ws.cioWins[id] = 'notified';
        await track(w, 'megapot_win_unclaimed', { usd: Number(usd.toFixed(2)), round: String(t.round_id ?? ''), ticketId: id });
      } else if (seen === 'notified' && t.claimed === true) {
        ws.cioWins[id] = 'claimed';
        await track(w, 'megapot_win_claimed', { usd: Number(usd.toFixed(2)), round: String(t.round_id ?? ''), ticketId: id });
      }
    }
  }
  save(s);
}
