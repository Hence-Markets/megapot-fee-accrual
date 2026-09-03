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

test('venue-traded cohort: pre-season traders from the feed, not stacking on season traders', () => {
  const P = [{ id: 'pre-season', usd: 1, requires: 'venue-traded', beforeMs: 1788379200000, onlyWithoutSeasonVolume: true }];
  const fresh = { volumeUsd: 0, days: {}, opsGrants: {} };
  assert.equal(blanketGrantsDue(fresh, P, { firstFillMs: 1710000000000 }).length, 1, 'traded in March, nothing this season');
  assert.equal(blanketGrantsDue(fresh, P, { firstFillMs: 1788400000000 }).length, 0, 'first fill inside the season is not pre-season');
  assert.equal(blanketGrantsDue(fresh, P, { firstFillMs: 0 }).length, 0, 'no reconciled fill on the feed');
  assert.equal(blanketGrantsDue({ volumeUsd: 300, days: { '2026-09-02': 300 } }, P, { firstFillMs: 1710000000000 }).length, 0, 'season trader already got the season grant');
  fresh.opsGrants['pre-season'] = { usd: 1 };
  assert.equal(blanketGrantsDue(fresh, P, { firstFillMs: 1710000000000 }).length, 0, 'once');
});
