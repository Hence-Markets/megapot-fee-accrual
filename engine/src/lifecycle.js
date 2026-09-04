// TICKET LIFECYCLE SNAPSHOT - the per-wallet daily status that drives the
// CRM: tickets in tonight's draw, winnings waiting to be claimed, fee
// rebate accrued toward the next ticket, campaign trade days and the odds
// on tomorrow's streak box. Pure: engine.js feeds it ledger state + the
// venue's ticket rows and decides whether to emit.
import { boxFor } from './streakBox.js';

/** a venue row's winnings in USD ({amount,decimals} object, else 6dp micro-units) */
export const usdOf = (t) => {
  const wa = t?.winnings_amount;
  return wa && typeof wa === 'object' ? Number(wa.amount || 0) / 10 ** (wa.decimals ?? 6) : Number(wa || 0) / 1e6;
};

/** @returns the event payload (camelCase) - attrs() turns it into profile attributes */
export function dailyStatus({ ws, rows = [], currentRound = null, priceUsd = 1, nowMs = Date.now(), startMs = 0, poolUsd = null, mintedToday = 0 }) {
  const inDraw = currentRound == null ? 0 : rows.filter((t) => String(t.round_id ?? t.roundId ?? '') === String(currentRound)).length;
  let unclaimedUsd = 0, wonUsd = 0, claimedUsd = 0;
  for (const t of rows) {
    const u = usdOf(t);
    if (!(u > 0)) continue;
    wonUsd += u;
    if (t.claimed === true) claimedUsd += u; else unclaimedUsd += u;
  }
  const tradeDays = Object.keys(ws.boxes || {}).length
    || Object.entries(ws.days || {}).filter(([d, v]) => v > 0 && new Date(d + 'T00:00:00Z').getTime() >= startMs).length;
  const lastTradeMs = ws.lastFillMs || 0;
  const daysSinceLastTrade = lastTradeMs ? Math.floor((nowMs - lastTradeMs) / 86400000) : null;
  const credit = Number(ws.creditUsdc || 0);
  const next = boxFor(tradeDays + 1);
  return {
    dateUtc: new Date(nowMs).toISOString().slice(0, 10),
    ticketsInDraw: inDraw,
    ticketsLifetime: rows.length,
    unclaimedUsd: +unclaimedUsd.toFixed(2),
    wonLifetimeUsd: +wonUsd.toFixed(2),
    claimedLifetimeUsd: +claimedUsd.toFixed(2),
    creditUsd: +credit.toFixed(4),
    nextTicketPct: Math.max(0, Math.min(100, Math.round((credit / priceUsd) * 100))),
    volumeToNextTicketUsd: Math.max(0, Math.round((priceUsd - credit) / 0.0004)),
    feeRebatedUsd: +Number(ws.rebatedUsd || 0).toFixed(2),
    volumeUsd: Math.round(ws.volumeUsd || 0),
    campaignTradeDays: tradeDays,
    lastTradeAt: lastTradeMs ? new Date(lastTradeMs).toISOString() : null,
    daysSinceLastTrade,
    nextBoxDay: next.day, nextBoxP: next.p, nextBoxSize: next.size,
    poolUsd: poolUsd == null ? null : Math.round(poolUsd),
    mintedToday,
  };
}

/** Customer.io profile attributes (snake_case) so segments can filter on them */
export function attrs(st) {
  return {
    tickets_in_draw: st.ticketsInDraw, tickets_lifetime: st.ticketsLifetime,
    unclaimed_usd: st.unclaimedUsd, won_lifetime_usd: st.wonLifetimeUsd,
    next_ticket_pct: st.nextTicketPct, volume_to_next_ticket_usd: st.volumeToNextTicketUsd,
    fee_rebated_usd: st.feeRebatedUsd, campaign_volume_usd: st.volumeUsd,
    campaign_trade_days: st.campaignTradeDays, last_trade_at: st.lastTradeAt,
    days_since_last_trade: st.daysSinceLastTrade,
    next_box_day: st.nextBoxDay, next_box_p: st.nextBoxP, next_box_size: st.nextBoxSize,
    megapot_status_at: st.dateUtc,
    // the two figures every email leans on: pool_usd is a NUMBER (segments can compare
    // it), pool_label the Liquid-ready string the templates print
    ...(st.poolUsd == null ? {} : { pool_usd: st.poolUsd }),
    pool_label: st.poolUsd == null ? '$1.1M' : `$${st.poolUsd.toLocaleString('en-US')}`,
    minted_today: st.mintedToday,
  };
}

/** the attributes a TRADE moves - identified on megapot_trade so the afternoon sends
 *  see today's box day / next-ticket percent, without touching the ticket + win fields
 *  only the venue rows can supply */
export function tradeAttrs(st) {
  const a = attrs(st);
  return {
    next_ticket_pct: a.next_ticket_pct, volume_to_next_ticket_usd: a.volume_to_next_ticket_usd,
    fee_rebated_usd: a.fee_rebated_usd, campaign_volume_usd: a.campaign_volume_usd,
    campaign_trade_days: a.campaign_trade_days, last_trade_at: a.last_trade_at,
    days_since_last_trade: a.days_since_last_trade,
    next_box_day: a.next_box_day, next_box_p: a.next_box_p, next_box_size: a.next_box_size,
  };
}

/** on-trade identify cadence: the first trade of the UTC day identifies at once, then at
 *  most once an hour */
export function shouldIdentifyOnTrade(lastIdentifyMs, nowMs = Date.now()) {
  if (!lastIdentifyMs) return true;
  if (new Date(lastIdentifyMs).toISOString().slice(0, 10) !== new Date(nowMs).toISOString().slice(0, 10)) return true;
  return nowMs - lastIdentifyMs >= 60 * 60_000;
}

/** the pool moves with every ticket sold; compare it in $10k steps so a same-day
    refresh happens when the headline number moves, not every sweep */
export const poolBucket = (poolUsd) => (poolUsd == null ? null : Math.round(poolUsd / 10_000));
/** the snapshot the ledger keeps to decide the next emit */
export const statusKey = (st) => ({ dateUtc: st.dateUtc, ticketsInDraw: st.ticketsInDraw, unclaimedUsd: st.unclaimedUsd, mintedToday: st.mintedToday, poolBucket: poolBucket(st.poolUsd) });
/** emit once per UTC day, plus immediately when the draw count, claimable money,
    today's minted total or the headline pool changes - the figures a same-day
    email must not show stale */
export function shouldEmit(prev, st) {
  if (!prev) return true;
  if (prev.dateUtc !== st.dateUtc) return true;
  if (prev.ticketsInDraw !== st.ticketsInDraw || prev.unclaimedUsd !== st.unclaimedUsd) return true;
  if (prev.mintedToday != null && prev.mintedToday !== st.mintedToday) return true;
  if (prev.poolBucket != null && prev.poolBucket !== poolBucket(st.poolUsd)) return true;
  return false;
}

/** win dedupe - PURE: which event (if any) a venue ticket row triggers, given the
 *  ledger marker for its id. First sight of a claimed win emits claimed directly
 *  (never silently swallowed); claimed !== true counts as unclaimed. */
export function winTransition(seen, row) {
  const usd = usdOf(row);
  if (!(usd > 0)) return null;
  const claimed = row.claimed === true;
  if (!seen) return claimed ? { event: 'megapot_win_claimed', state: 'claimed' } : { event: 'megapot_win_unclaimed', state: 'notified' };
  if (seen === 'notified' && claimed) return { event: 'megapot_win_claimed', state: 'claimed' };
  return null;
}
/** ticket id for the dedupe map: user_ticket_id, else tx_hash#index so a multi-ticket
 *  buy never collapses to one win */
export const winId = (row, index) => (row.user_ticket_id != null ? String(row.user_ticket_id) : row.tx_hash ? `${row.tx_hash}#${index}` : '');
