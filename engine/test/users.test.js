import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, userWallets, userPackGranted, userTicketCounts, userCapLeft, userCapRoom, userBoxDates } from '../src/users.js';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);

test('feed rows keep the per-user key; malformed and duplicate rows drop', () => {
  const f = parseRows([{ wallet: A.toUpperCase(), user: 'u1', emailBound: true }, { wallet: B, user: 'u1' }, { wallet: C }, 'garbage', { wallet: A, user: 'u1' }]);
  assert.deepEqual(f.wallets, [A, B, C]);
  assert.deepEqual(f.users, { [A]: 'u1', [B]: 'u1' });
  assert.equal(f.emailBound[A], true); assert.equal(f.emailBound[C], false);
});

test('linked wallets share one activation pack; a wallet without a user is its own user', () => {
  const s = { users: { [A]: 'u1', [B]: 'u1' }, wallets: { [A]: { packGranted: true }, [B]: {}, [C]: {} } };
  assert.deepEqual(userWallets(s, B).sort(), [A, B]);
  assert.deepEqual(userWallets(s, C), [C]);
  assert.equal(userPackGranted(s, B), true, 'B cannot draw a second pack for user u1');
  assert.equal(userPackGranted(s, C), false);
  assert.equal(userPackGranted({ wallets: { [A]: { bonusTicketsPending: 2 } } }, A), true);
});

test('day/week caps count every wallet of the user', () => {
  const now = Date.UTC(2026, 8, 5, 12);
  const s = { users: { [A]: 'u1', [B]: 'u1' }, wallets: {
    [A]: { tickets: { '2026-09-05': 3, '2026-09-01': 4 } },
    [B]: { tickets: { '2026-09-05': 1, '2026-08-20': 9 } },      // Aug 20 is outside the rolling week
    [C]: { tickets: { '2026-09-05': 5 } },
  } };
  assert.deepEqual(userTicketCounts(s, A, '2026-09-05', now), { dayCount: 4, week: 8 });
  assert.equal(userCapLeft(s, B, '2026-09-05', { perDay: 5, perWeek: 15 }, now), 1);
  assert.equal(userCapLeft(s, C, '2026-09-05', { perDay: 5, perWeek: 15 }, now), 0);
  s.wallets[B].tickets['2026-09-03'] = 7;                           // week 15 -> weekly cap binds
  assert.equal(userCapLeft(s, A, '2026-09-05', { perDay: 5, perWeek: 15 }, now), 0);
});

test('streak-box days are shared across the user: a date one wallet rolled is not re-rolled', () => {
  const s = { users: { [A]: 'u1', [B]: 'u1' }, wallets: { [A]: { boxes: { '2026-09-03': {}, '2026-09-04': {} } }, [B]: { boxes: { '2026-09-04': {} } } } };
  assert.deepEqual([...userBoxDates(s, B)].sort(), ['2026-09-03', '2026-09-04']);
  assert.equal(userBoxDates({ wallets: {} }, C).size, 0);
});

test('cap room is reported for the user and for the wallet alone (status rows tell them apart)', () => {
  const now = Date.UTC(2026, 8, 5, 12);
  const s = { users: { [A]: 'u1', [B]: 'u1' }, wallets: { [A]: { tickets: { '2026-09-05': 1 } }, [B]: { tickets: { '2026-09-05': 4, '2026-09-01': 2 } } } };
  assert.deepEqual(userCapRoom(s, A, '2026-09-05', { perDay: 5, perWeek: 15 }, now), { dayLeft: 0, weekLeft: 8, ownDayLeft: 4, ownWeekLeft: 14 });
  assert.deepEqual(userCapRoom(s, C, '2026-09-05', { perDay: 5, perWeek: 15 }, now), { dayLeft: 5, weekLeft: 15, ownDayLeft: 5, ownWeekLeft: 15 }, 'unknown wallet: full room');
});
