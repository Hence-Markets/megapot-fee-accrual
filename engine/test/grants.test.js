import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blanketGrantsDue } from '../src/grants.js';

const G = [{ id: 'all-traders-2026-09-03', usd: 2, requires: 'traded', beforeDate: '2026-09-03' }];

test('a wallet that traded on/before the cutoff gets the grant once', () => {
  const ws = { volumeUsd: 500, days: { '2026-09-02': 500 }, opsGrants: {} };
  assert.equal(blanketGrantsDue(ws, G).length, 1);
  ws.opsGrants['all-traders-2026-09-03'] = { usd: 2 };
  assert.equal(blanketGrantsDue(ws, G).length, 0, 'applied once per id');
});

test('this cycle\'s first fill counts when it lands on/before the cutoff', () => {
  const ws = { volumeUsd: 0, days: {}, opsGrants: {} };
  assert.equal(blanketGrantsDue(ws, G, { vol: 120, today: '2026-09-03' }).length, 1);
  assert.equal(blanketGrantsDue(ws, G, { vol: 120, today: '2026-09-04' }).length, 0, 'a later first trade is outside the cohort');
});

test('no trades = no grant; zero-volume days do not count', () => {
  assert.equal(blanketGrantsDue({ volumeUsd: 0, days: {} }, G).length, 0);
  assert.equal(blanketGrantsDue({ volumeUsd: 10, days: { '2026-09-05': 10, '2026-09-01': 0 } }, G).length, 0);
});

test('open-ended grant (no beforeDate) needs only volume; bad rows are ignored', () => {
  const open = [{ id: 'x', usd: 1 }, { id: 'bad', usd: 0 }, { usd: 3 }, { id: 'other', usd: 1, requires: 'streak' }];
  assert.deepEqual(blanketGrantsDue({ volumeUsd: 1, days: { '2026-09-09': 1 } }, open).map((g) => g.id), ['x']);
});

test('ledger volume without a day map still qualifies (recorded before this cycle)', () => {
  assert.equal(blanketGrantsDue({ volumeUsd: 850, opsGrants: {} }, G).length, 1);
  assert.equal(blanketGrantsDue({ volumeUsd: 850, days: {} }, G).length, 1);
  assert.equal(blanketGrantsDue({ volumeUsd: 0, days: {} }, G).length, 0);
});
