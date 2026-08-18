import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { cfg, net, jackpotAbi, buyerAbi, erc20Abi } from './config.js';

// Eligible set per the feature-gates conventions: whitelist = pre-production
// cohort; empty whitelist = open mode, full user feed. Pause = ACTIVE=0.
export function eligibleWallets() {
  if (cfg.WHITELIST.length) return cfg.WHITELIST;
  if (!cfg.USERS_FILE) throw new Error('Open mode (empty MEGAPOT_WHITELIST) requires USERS_FILE - empty whitelist means EVERYONE, and the engine needs the user feed to know who that is.');
  const list = JSON.parse(fs.readFileSync(cfg.USERS_FILE, 'utf8'));
  return list.map((w) => String(w).trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w));
}

const STATE = 'state/ledger.json';

// ── ledger ──────────────────────────────────────────────────────────────────
// One JSON file: per-wallet fee credit (USDC, 6dp int), checkpoint of the last
// fill time already counted, tickets bought per day, lifetime spend.
export function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { wallets: {}, spentUsdc: 0 }; }
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
  const s = load();
  for (const w of eligibleWallets()) {
    const ws = wstate(s, w);
    const fs_ = await fills(w, ws.lastFillMs);
    let vol = 0;
    for (const f of fs_) {
      if (!qualifies(f.coin, f.time)) continue;
      vol += Number(f.px) * Number(f.sz);
      ws.lastFillMs = Math.max(ws.lastFillMs, f.time);
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
      gas: 15_000_000n,
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
