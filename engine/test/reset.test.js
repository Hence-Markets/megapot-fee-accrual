import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetWallets } from '../src/reset.js';

test('reset wipes only the named wallets and returns their pool draws', () => {
  const s = { firstTradePoolUsed: 4, streakBoxPoolUsed: 3, packSlots: { 1: 110, 3: 6 },
    wallets: {
      '0xaaa': { creditUsdc: 2, firstTradeBonus: { tickets: 3 }, boxes: { '2026-09-01': { tickets: 1 }, '2026-09-02': { tickets: 0 } }, streakTicketsPending: 2 },
      '0xbbb': { creditUsdc: 1, firstTradeBonus: { tickets: 1 } },
    }, purchases: [{ wallet: '0xaaa', count: 1 }] };
  const r = resetWallets(s, ['0xAAA']);
  assert.deepEqual(r, { reset: ['0xaaa'], packsReturned: 3, boxTicketsReturned: 3 });
  assert.equal(s.wallets['0xaaa'], undefined);
  assert.ok(s.wallets['0xbbb']);
  assert.equal(s.firstTradePoolUsed, 1); assert.equal(s.packSlots[3], 7); assert.equal(s.streakBoxPoolUsed, 0);
  assert.equal(s.purchases.length, 1, 'on-chain history untouched');
  assert.deepEqual(resetWallets(s, ['0xzzz']).reset, []);
});
