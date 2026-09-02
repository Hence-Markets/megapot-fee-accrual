// TICKET LIFECYCLE SNAPSHOT - the per-wallet daily status that drives the
// CRM: tickets in tonight's draw, winnings waiting to be claimed, fee
// rebate accrued toward the next ticket, campaign trade days and the odds
// on tomorrow's streak box. Pure: engine.js feeds it ledger state + the
// venue's ticket rows and decides whether to emit.
import { boxFor } from './streakBox.js';

const usdOf = (t) => {
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
    // the two figures every email leans on, formatted for Liquid as-is
    pool_usd: st.poolUsd == null ? '$1.1M' : `$${st.poolUsd.toLocaleString('en-US')}`,
    minted_today: st.mintedToday,
  };
}

/** emit once per UTC day, plus immediately when the draw count or claimable
    money changes - those are the two things a same-day email must not miss */
export function shouldEmit(prev, st) {
  if (!prev) return true;
  if (prev.dateUtc !== st.dateUtc) return true;
  return prev.ticketsInDraw !== st.ticketsInDraw || prev.unclaimedUsd !== st.unclaimedUsd;
}
