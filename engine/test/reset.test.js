import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetWallets, needsRewind } from '../src/reset.js';

test('reset wipes only the named wallets and returns their pool draws', () => {
  const s = { firstTradePoolUsed: 4, streakBoxPoolUsed: 3, packSlots: { 1: 110, 3: 6 },
    wallets: {
      '0xaaa': { creditUsdc: 2, firstTradeBonus: { tickets: 3 }, boxes: { '2026-09-01': { tickets: 1 }, '2026-09-02': { tickets: 0 } }, streakTicketsPending: 2 },
      '0xbbb': { creditUsdc: 1, firstTradeBonus: { tickets: 1 } },
    }, purchases: [{ wallet: '0xaaa', count: 1 }] };
  const r = resetWallets(s, ['0xAAA'], 1700000000000);
  assert.deepEqual(r, { reset: ['0xaaa'], packsReturned: 3, boxTicketsReturned: 3 });
  assert.deepEqual(s.wallets['0xaaa'], { creditUsdc: 0, lastFillMs: 1700000000000, volumeUsd: 0, tickets: {}, resetMs: 1700000000000 }, 'fresh checkpoint at reset time');
  assert.ok(s.wallets['0xbbb']);
  assert.equal(s.firstTradePoolUsed, 1); assert.equal(s.packSlots[3], 7); assert.equal(s.streakBoxPoolUsed, 0);
  assert.equal(s.purchases.length, 1, 'on-chain history untouched');
  assert.deepEqual(resetWallets(s, ['0xzzz']).reset, []);
});

test('a reset wallet is never rewound to START_MS by the start-moved rule', () => {
  const START = 1_600_000_000_000;
  const s = { wallets: { '0xaaa': { creditUsdc: 1, lastFillMs: START + 5, volumeUsd: 100, tickets: {} } } };
  resetWallets(s, ['0xaaa'], START + 86400000);
  const ws = s.wallets['0xaaa'];
  assert.equal(needsRewind(ws, START), false, 'reset wallet keeps its reset-time checkpoint');
  assert.equal(ws.lastFillMs, START + 86400000);
  assert.equal(needsRewind({ creditUsdc: 0, lastFillMs: START + 10, volumeUsd: 0, tickets: {} }, START), true, 'never-credited wallet seen under a later start rewinds');
  assert.equal(needsRewind({ creditUsdc: 0, lastFillMs: START, volumeUsd: 0, tickets: {} }, START), false, 'created at START_MS: nothing to rewind');
  assert.equal(needsRewind({ lastFillMs: START + 10, volumeUsd: 5 }, START), false, 'credited wallets never rewind');
});
