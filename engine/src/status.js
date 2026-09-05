// Per-wallet STATUS rows for the hub - PURE. After every buy sweep and fast lane the
// engine POSTs these to STATUS_URL (via the outbox); the hub shows "N tickets queued,
// waiting on X" from them and never from a client-side fee estimate. Every number
// comes from the ledger, and the queued reason comes from the SAME decision the
// engine logs as 'credit $x → 0 tickets (affordable a, cap c, budget b)'.
import { userCapRoom } from './users.js';
import { walletOnHold } from './reconcile.js';

export const MAX_PER_BUY = 10;                  // buyer contract caps 10 tickets per call
export const MAX_ROWS_PER_POST = 500;

/**
 * The buy decision for one wallet. ctx:
 *   priceUsd, budgetLeft (tickets the global budget still covers),
 *   dayLeft / weekLeft (the USER's cap room, linked wallets included),
 *   ownDayLeft / ownWeekLeft (this wallet alone; default = the user's),
 *   onHold (an unsettled intent), fundsOk / feeOk (pool wallet + base fee this cycle).
 * -> { count, affordable, capLeft, reason }; reason is null when nothing is queued, else
 *    'hold' | 'day_cap' | 'week_cap' | 'user_cap' | 'budget' | 'low_funds' | 'fee_spike'.
 */
export function decideBuy(ws, ctx) {
  const { priceUsd, budgetLeft, dayLeft, weekLeft, ownDayLeft = dayLeft, ownWeekLeft = weekLeft, onHold = false, fundsOk = true, feeOk = true } = ctx;
  const affordable = Math.floor(Number(ws?.creditUsdc || 0) / priceUsd);
  const capLeft = Math.max(0, Math.min(dayLeft, weekLeft));
  const count = Math.max(0, Math.min(affordable, capLeft, budgetLeft, MAX_PER_BUY));
  const out = (c, reason) => ({ count: c, affordable, capLeft, reason });
  if (onHold) return out(0, 'hold');                       // nothing until the open intent settles
  if (affordable < 1) return out(0, null);                 // no ticket owed yet: nothing is queued
  // caps are per USER: the wallet's own cap when its own tickets fill it, 'user_cap' when
  // a linked wallet used the room
  if (dayLeft < 1) return out(0, ownDayLeft < 1 ? 'day_cap' : 'user_cap');
  if (weekLeft < 1) return out(0, ownWeekLeft < 1 ? 'week_cap' : 'user_cap');
  if (budgetLeft < 1) return out(0, 'budget');
  if (!fundsOk) return out(count, 'low_funds');            // owed, but the pool wallet cannot pay
  if (!feeOk) return out(count, 'fee_spike');              // owed, but buys wait for the base fee
  return out(count, null);
}

/** a wallet the engine has touched: volume, a ticket, a pack or credit (an ops grant) */
export const seenByEngine = (ws) => (Number(ws?.volumeUsd) || 0) > 0 || Object.keys(ws?.tickets || {}).length > 0 || !!ws?.packGranted || (Number(ws?.creditUsdc) || 0) > 0;

/** rows per the engine -> backend contract.
 *  ctx: { day, priceUsd, budgetLeft, fundsOk, feeOk, retroAvailable, cycleMs, caps, nowMs } */
export function statusRows(s, ctx) {
  const { day, priceUsd, caps, nowMs = Date.now() } = ctx;
  const rows = [];
  for (const [wallet, ws] of Object.entries(s.wallets || {})) {
    if (!seenByEngine(ws)) continue;
    const room = userCapRoom(s, wallet, day, caps, nowMs);
    const d = decideBuy(ws, { ...room, priceUsd, budgetLeft: ctx.budgetLeft, onHold: walletOnHold(s, wallet), fundsOk: ctx.fundsOk, feeOk: ctx.feeOk });
    rows.push({
      wallet,
      creditUsdc: +Number(ws.creditUsdc || 0).toFixed(6),
      pendingTickets: Math.max(0, d.affordable),          // floor(credit / price)
      ticketsToday: Number(ws.tickets?.[day] || 0),
      capLeft: Math.max(0, room.dayLeft),                 // the user's day room
      weekLeft: Math.max(0, room.weekLeft),               // the user's week room
      queuedReason: d.reason,
      lastAccrueMs: ws.lastAccrueMs ?? null,              // stamped only by a COMPLETED accrue
      lastMintMs: ws.lastMintMs ?? null,
      holds: (s.intents || []).filter((i) => i.wallet === wallet).length,   // unsettled buy / transfer intents
      retroAvailable: Number(ctx.retroAvailable || 0),    // pool-held retro tickets left after the sweep
      cycleMs: ctx.cycleMs,
    });
  }
  return rows;
}

/** the engine doc that rides with every status POST */
export const engineDoc = ({ cycleMs, nowMs = Date.now(), paused, target, packPoolUsed, packPoolTotal }) => ({ cycleMs, lastCycleMs: nowMs, paused: !!paused, target,
  ...(Number.isFinite(Number(packPoolUsed)) ? { packPoolUsed: Number(packPoolUsed) } : {}), ...(Number(packPoolTotal) > 0 ? { packPoolTotal: Number(packPoolTotal) } : {}) });

/** at most MAX_ROWS_PER_POST rows per POST; an empty row set still carries the engine doc */
export function chunkRows(rows, size = MAX_ROWS_PER_POST) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out.length ? out : [[]];
}
