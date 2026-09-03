import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterInventory, allocateRetro, grantBody } from '../src/retro.js';
import { userCapLeft } from '../src/users.js';

const POOL = '0xBC54e516405A959746E3531d81Ea656DCc687A82';
const row = (id, o = {}) => ({ wallet: POOL, round_id: '163', user_ticket_id: id, claimed: false, winnings_amount: null, ...o });

test('inventory = active round, unclaimed, no winnings, owned by the pool, unique numeric ids', () => {
  const rows = [
    row('11'), row('12'),
    row('13', { round_id: '162' }),                                   // settled round: a receipt, not inventory
    row('14', { claimed: true }),
    row('15', { winnings_amount: { amount: '2500000', decimals: 6 } }), // a winner: never re-gifted
    row('16', { wallet: '0x' + '9'.repeat(40) }),
    row('11'), row('x'), row(undefined),
  ];
  assert.deepEqual(filterInventory(rows, { activeRound: '163', pool: POOL }), ['11', '12']);
  assert.deepEqual(filterInventory(rows, { activeRound: null, pool: POOL }), []);
});

test('allocation: inventory covers what it can, the remainder buys with USDC, never over count', () => {
  assert.deepEqual(allocateRetro(3, ['a', 'b', 'c', 'd']), { tokenIds: ['a', 'b', 'c'], usdcCount: 0 });
  assert.deepEqual(allocateRetro(5, ['a', 'b']), { tokenIds: ['a', 'b'], usdcCount: 3 });
  assert.deepEqual(allocateRetro(0, ['a']), { tokenIds: [], usdcCount: 0 });
  assert.deepEqual(allocateRetro(2, []), { tokenIds: [], usdcCount: 2 });
});

test('retro tickets sit under the per-user cap: inventory x count x caps', () => {
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
  const now = Date.UTC(2026, 8, 5, 12), day = '2026-09-05';
  const s = { users: { [A]: 'u1', [B]: 'u1' }, wallets: { [A]: { creditUsdc: 7, tickets: {} }, [B]: { creditUsdc: 0, tickets: { [day]: 3 } } } };
  const caps = { perDay: 5, perWeek: 15 };
  const owed = Math.min(Math.floor(s.wallets[A].creditUsdc / 1), userCapLeft(s, A, day, caps, now), 10);
  assert.equal(owed, 2, 'user u1 already minted 3 today on wallet B');
  const alloc = allocateRetro(owed, ['1', '2', '3', '4']);
  assert.deepEqual(alloc, { tokenIds: ['1', '2'], usdcCount: 0 });
  s.wallets[A].tickets[day] = alloc.tokenIds.length;                     // retro counts toward the cap
  assert.equal(userCapLeft(s, A, day, caps, now), 0);
  assert.equal(userCapLeft(s, B, day, caps, now), 0);
});

test('grant body is what the hub expects', () => {
  const b = grantBody({ wallet: '0xw', tokenId: 42n, round: 163, tx: '0xtx', ts: 5 });
  assert.deepEqual(b, { wallet: '0xw', tokenId: '42', round: '163', tx: '0xtx', kind: 'retro', ts: 5 });
});
