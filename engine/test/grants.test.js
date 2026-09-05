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


/* ---- promo window: "trade tonight before the draw -> +1" ---- */
const P = [{ id: 'email-tonight', usd: 1, requires: 'traded-between', fromMs: 1000, toMs: 2000, grantUntilMs: 2500,
  wallets: ['0xAAA'], excludeWallets: ['0xBAD'] }];
test('promo window: cohort wallet with a fill inside the window gets +1 once; outside, excluded, or late does not', () => {
  const fresh = () => ({ volumeUsd: 100, opsGrants: {}, lastFillMs: 1500 });
  assert.equal(blanketGrantsDue(fresh(), P, { wallet: '0xaaa', nowMs: 1600 }).length, 1);
  assert.equal(blanketGrantsDue({ ...fresh(), lastFillMs: 900 }, P, { wallet: '0xaaa', nowMs: 1600 }).length, 0, 'fill before the window');
  assert.equal(blanketGrantsDue({ ...fresh(), lastFillMs: 3000, tradedWindow: { 'email-tonight': true } }, P, { wallet: '0xaaa', nowMs: 1600 }).length, 1, 'stamped fill counts even after later fills');
  assert.equal(blanketGrantsDue({ ...fresh(), lastFillMs: 3000 }, P, { wallet: '0xaaa', nowMs: 1600 }).length, 0, 'only a post-window fill, no stamp');
  assert.equal(blanketGrantsDue(fresh(), P, { wallet: '0xbbb', nowMs: 1600 }).length, 0, 'not in the cohort');
  assert.equal(blanketGrantsDue(fresh(), [{ ...P[0], wallets: ['0xAAA', '0xBAD'] }], { wallet: '0xbad', nowMs: 1600 }).length, 0, 'risk cohort excluded');
  assert.equal(blanketGrantsDue(fresh(), P, { wallet: '0xaaa', nowMs: 2600 }).length, 0, 'past grantUntilMs: too late to mint for the draw');
  const ws = fresh(); ws.opsGrants['email-tonight'] = { usd: 1 };
  assert.equal(blanketGrantsDue(ws, P, { wallet: '0xaaa', nowMs: 1600 }).length, 0, 'once');
});
