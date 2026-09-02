import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyStatus, attrs, shouldEmit } from '../src/lifecycle.js';

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
