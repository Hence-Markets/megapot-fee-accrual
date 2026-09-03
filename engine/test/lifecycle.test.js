import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyStatus, attrs, shouldEmit, statusKey, tradeAttrs, shouldIdentifyOnTrade, winTransition, winId } from '../src/lifecycle.js';

const rows = [
  { round_id: '41', winnings_amount: { amount: '2500000', decimals: 6 }, claimed: false },
  { round_id: '41', winnings_amount: { amount: '0', decimals: 6 }, claimed: false },
  { round_id: '42', winnings_amount: null, claimed: false },
  { round_id: '42', winnings_amount: null, claimed: false },
  { round_id: '40', winnings_amount: { amount: '1000000', decimals: 6 }, claimed: true },
];

test('daily status: tickets in the current draw, claimable money, accrual, box odds', () => {
  const ws = { creditUsdc: 0.4, rebatedUsd: 1.9, volumeUsd: 4750, lastFillMs: Date.UTC(2026, 8, 1, 12), boxes: { '2026-08-31': {}, '2026-09-01': {} } };
  const st = dailyStatus({ ws, rows, currentRound: '42', priceUsd: 1, nowMs: Date.UTC(2026, 8, 3, 9) });
  assert.equal(st.ticketsInDraw, 2);
  assert.equal(st.ticketsLifetime, 5);
  assert.equal(st.unclaimedUsd, 2.5);
  assert.equal(st.claimedLifetimeUsd, 1);
  assert.equal(st.wonLifetimeUsd, 3.5);
  assert.equal(st.nextTicketPct, 40);
  assert.equal(st.volumeToNextTicketUsd, 1500);        // $0.60 at 0.04%
  assert.equal(st.campaignTradeDays, 2);
  assert.equal(st.daysSinceLastTrade, 1);
  assert.equal(st.nextBoxDay, 3); assert.equal(st.nextBoxP, 0.45);
  const a = attrs(st);
  assert.equal(a.tickets_in_draw, 2); assert.equal(a.unclaimed_usd, 2.5); assert.equal(a.campaign_trade_days, 2);
});

test('emits once per day and again the moment draw count or claimable money moves', () => {
  const base = { dateUtc: '2026-09-03', ticketsInDraw: 2, unclaimedUsd: 0 };
  assert.equal(shouldEmit(null, base), true);
  assert.equal(shouldEmit(base, { ...base }), false);
  assert.equal(shouldEmit(base, { ...base, ticketsInDraw: 3 }), true);
  assert.equal(shouldEmit(base, { ...base, unclaimedUsd: 4.2 }), true);
  assert.equal(shouldEmit(base, { ...base, dateUtc: '2026-09-04' }), true);
});

test('a wallet with no fills and no tickets is a clean zero, never NaN', () => {
  const st = dailyStatus({ ws: {}, rows: [], currentRound: '42', priceUsd: 1, nowMs: Date.UTC(2026, 8, 3) });
  assert.equal(st.ticketsInDraw, 0); assert.equal(st.nextTicketPct, 0); assert.equal(st.daysSinceLastTrade, null);
  assert.equal(st.campaignTradeDays, 0); assert.equal(st.nextBoxDay, 1);
  for (const v of Object.values(st)) assert.ok(!(typeof v === 'number' && Number.isNaN(v)));
});

test('pool_usd is a number for segments, pool_label the formatted string for templates', () => {
  const st = dailyStatus({ ws: {}, rows: [], poolUsd: 1125335.44, nowMs: Date.UTC(2026, 8, 3) });
  const a = attrs(st);
  assert.equal(a.pool_usd, 1125335); assert.equal(a.pool_label, '$1,125,335');
  const none = attrs(dailyStatus({ ws: {}, rows: [], nowMs: Date.UTC(2026, 8, 3) }));
  assert.equal('pool_usd' in none, false); assert.equal(none.pool_label, '$1.1M');
});

test('same-day refresh when minted-today or the headline pool moves; unchanged pool stays quiet', () => {
  const base = { ws: {}, rows: [], currentRound: '1', nowMs: Date.UTC(2026, 8, 3, 9) };
  const a = dailyStatus({ ...base, mintedToday: 3, poolUsd: 1_120_000 });
  const key = statusKey(a);
  assert.equal(shouldEmit(key, dailyStatus({ ...base, mintedToday: 3, poolUsd: 1_123_000 })), false, '$3k inside the $10k bucket');
  assert.equal(shouldEmit(key, dailyStatus({ ...base, mintedToday: 4, poolUsd: 1_120_000 })), true, 'a mint today');
  assert.equal(shouldEmit(key, dailyStatus({ ...base, mintedToday: 3, poolUsd: 1_140_000 })), true, 'pool crossed a bucket');
  assert.equal(shouldEmit({ dateUtc: a.dateUtc, ticketsInDraw: 0, unclaimedUsd: 0 }, a), false, 'legacy key without the new fields: old rule');
});

test('on-trade identify: first of the day at once, then hourly; only the trade attributes', () => {
  const t0 = Date.UTC(2026, 8, 3, 10);
  assert.equal(shouldIdentifyOnTrade(undefined, t0), true);
  assert.equal(shouldIdentifyOnTrade(t0, t0 + 30 * 60_000), false);
  assert.equal(shouldIdentifyOnTrade(t0, t0 + 60 * 60_000), true);
  assert.equal(shouldIdentifyOnTrade(t0, Date.UTC(2026, 8, 4, 0, 1)), true, 'new UTC day');
  const ta = tradeAttrs(dailyStatus({ ws: { creditUsdc: 0.5, volumeUsd: 100 }, rows: [], nowMs: t0 }));
  assert.equal(ta.next_ticket_pct, 50);
  assert.equal('tickets_in_draw' in ta, false); assert.equal('unclaimed_usd' in ta, false);
});

test('win dedupe: first sight claimed emits claimed, claimed!==true is unclaimed, tx_hash#index fallback', () => {
  const win = { winnings_amount: { amount: '2000000', decimals: 6 } };
  assert.deepEqual(winTransition(undefined, { ...win, claimed: false }), { event: 'megapot_win_unclaimed', state: 'notified' });
  assert.deepEqual(winTransition(undefined, { ...win, claimed: null }), { event: 'megapot_win_unclaimed', state: 'notified' });
  assert.deepEqual(winTransition(undefined, { ...win, claimed: true }), { event: 'megapot_win_claimed', state: 'claimed' });
  assert.deepEqual(winTransition('notified', { ...win, claimed: true }), { event: 'megapot_win_claimed', state: 'claimed' });
  assert.equal(winTransition('notified', { ...win, claimed: false }), null);
  assert.equal(winTransition('pending', { ...win, claimed: true }), null, 'queued: wait for delivery');
  assert.equal(winTransition('claimed', { ...win, claimed: true }), null);
  assert.equal(winTransition(undefined, { winnings_amount: null, claimed: false }), null);
  assert.equal(winId({ user_ticket_id: '77', tx_hash: '0xa' }, 3), '77');
  assert.equal(winId({ tx_hash: '0xa' }, 3), '0xa#3');
  assert.equal(winId({}, 0), '');
});
