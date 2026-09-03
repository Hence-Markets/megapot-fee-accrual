import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBuy, statusRows, chunkRows, engineDoc, seenByEngine, MAX_PER_BUY } from '../src/status.js';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), D = '0x' + 'd'.repeat(40);
const base = { priceUsd: 1, budgetLeft: 100, dayLeft: 5, weekLeft: 15 };

test('decideBuy: count = min(affordable, cap, budget, 10); no reason while nothing is owed', () => {
  assert.deepEqual(decideBuy({ creditUsdc: 0.9 }, base), { count: 0, affordable: 0, capLeft: 5, reason: null });
  assert.deepEqual(decideBuy({ creditUsdc: 3.2 }, base), { count: 3, affordable: 3, capLeft: 5, reason: null });
  assert.equal(decideBuy({ creditUsdc: 40 }, base).count, 5, 'the day cap binds the count');
  assert.equal(decideBuy({ creditUsdc: 40 }, { ...base, dayLeft: 50, weekLeft: 50 }).count, MAX_PER_BUY);
  assert.equal(decideBuy({ creditUsdc: 40 }, { ...base, budgetLeft: 2 }).count, 2);
  assert.equal(decideBuy({ creditUsdc: -0.01 }, base).affordable, -1, 'a drifted-negative credit reads as the log line always did');
  assert.equal(decideBuy({ creditUsdc: 3 }, { ...base, dayLeft: -2, weekLeft: 4 }).capLeft, 0, 'cap never below zero');
});

test('decideBuy: the queued reason names what blocks the next ticket, in the buy loop\'s order', () => {
  const owed = { creditUsdc: 2 };
  assert.equal(decideBuy(owed, { ...base, onHold: true }).reason, 'hold');
  assert.equal(decideBuy(owed, { ...base, onHold: true, dayLeft: 0 }).reason, 'hold', 'an open intent comes first, as in the buy loop');
  assert.equal(decideBuy(owed, { ...base, dayLeft: 0 }).reason, 'day_cap');
  assert.equal(decideBuy(owed, { ...base, dayLeft: 0, ownDayLeft: 3 }).reason, 'user_cap', 'a linked wallet used the day room');
  assert.equal(decideBuy(owed, { ...base, weekLeft: 0 }).reason, 'week_cap');
  assert.equal(decideBuy(owed, { ...base, weekLeft: -1, ownWeekLeft: 2 }).reason, 'user_cap');
  assert.equal(decideBuy(owed, { ...base, budgetLeft: 0 }).reason, 'budget');
  assert.deepEqual(decideBuy(owed, { ...base, fundsOk: false }), { count: 2, affordable: 2, capLeft: 5, reason: 'low_funds' });
  assert.equal(decideBuy(owed, { ...base, feeOk: false }).reason, 'fee_spike');
  assert.equal(decideBuy({ creditUsdc: 0.5 }, { ...base, dayLeft: 0, fundsOk: false }).reason, null, 'nothing owed: nothing is queued');
});

test('statusRows: only wallets the engine touched; per-user caps, holds, watermarks; chunks + engine doc', () => {
  const day = '2026-09-05', now = Date.UTC(2026, 8, 5, 12);
  const s = {
    users: { [A]: 'u1', [B]: 'u1' },
    spentUsdc: 0,
    intents: [{ kind: 'buy', wallet: C, nonce: 1 }],
    wallets: {
      [A]: { creditUsdc: 2.5, volumeUsd: 100, tickets: { '2026-09-03': 2 }, lastAccrueMs: 1, lastMintMs: 2 },
      [B]: { creditUsdc: 1, volumeUsd: 0, tickets: { [day]: 5 }, packGranted: true },
      [C]: { creditUsdc: 5, volumeUsd: 10, tickets: {} },
      [D]: { creditUsdc: 0, volumeUsd: 0, tickets: {} },          // enrolled, never traded: no row
    },
  };
  const rows = statusRows(s, { day, priceUsd: 1, budgetLeft: 100, fundsOk: true, feeOk: true, retroAvailable: 4, cycleMs: 300_000, caps: { perDay: 5, perWeek: 15 }, nowMs: now });
  assert.deepEqual(rows.map((r) => r.wallet), [A, B, C]);
  assert.deepEqual(rows[0], { wallet: A, creditUsdc: 2.5, pendingTickets: 2, ticketsToday: 0, capLeft: 0, weekLeft: 8, queuedReason: 'user_cap',
    lastAccrueMs: 1, lastMintMs: 2, holds: 0, retroAvailable: 4, cycleMs: 300_000 }, 'B minted the user\'s 5 today: A is blocked by the shared cap');
  assert.equal(rows[1].queuedReason, 'day_cap', 'B filled the day cap itself');
  assert.equal(rows[1].lastAccrueMs, null, 'never accrued: null, not a guess');
  assert.deepEqual([rows[2].queuedReason, rows[2].holds], ['hold', 1]);
  assert.equal(seenByEngine({ creditUsdc: 0.2 }), true, 'an ops grant alone is a row');
  assert.equal(seenByEngine({}), false);
  assert.deepEqual(engineDoc({ cycleMs: 300_000, nowMs: now, paused: false, target: 'mainnet' }), { cycleMs: 300_000, lastCycleMs: now, paused: false, target: 'mainnet' });
  assert.deepEqual(chunkRows([], 2), [[]], 'an empty sweep still posts the engine doc');
  assert.deepEqual(chunkRows([1, 2, 3], 2), [[1, 2], [3]]);
  assert.equal(chunkRows(Array.from({ length: 1001 }, (_, i) => i)).length, 3, '500 per POST');
});
