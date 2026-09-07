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

// --- capped promo window: "+1 on any trade tonight, returning traders, first 10 users only"
const DAY0 = Date.UTC(2026, 8, 6);                    // 2026-09-06T00:00:00Z
const OPEN = DAY0 + 11 * 3600e3, CLOSE = DAY0 + 16.9 * 3600e3;
const C = [{ id: 'back-tonight', usd: 1, requires: 'traded-between', fromMs: OPEN, toMs: CLOSE,
  grantUntilMs: CLOSE + 120e3, priorTraderOnly: true, maxUsers: 10, excludeWallets: ['0xBAD'] }];
const traded = (over = {}) => ({ volumeUsd: 0, opsGrants: {}, lastFillMs: OPEN + 60e3, days: {}, ...over });

test('capped promo: the cap counts distinct wallets and only a paying wallet burns a slot', () => {
  const ws = () => traded({ days: { '2026-09-04': 250 } });
  assert.equal(blanketGrantsDue(ws(), C, { wallet: '0xa', nowMs: OPEN + 120e3, usedUsers: { 'back-tonight': 9 } }).length, 1, 'slot 10 still open');
  assert.equal(blanketGrantsDue(ws(), C, { wallet: '0xa', nowMs: OPEN + 120e3, usedUsers: { 'back-tonight': 10 } }).length, 0, 'cap reached');
  // a wallet the other filters reject must not be able to consume a slot: it never reaches the cap check
  assert.equal(blanketGrantsDue(ws(), C, { wallet: '0xbad', nowMs: OPEN + 120e3, usedUsers: {} }).length, 0, 'excluded wallet');
  assert.equal(blanketGrantsDue(traded(), C, { wallet: '0xa', nowMs: OPEN + 120e3, usedUsers: {} }).length, 0, 'no prior trading');
});

test('capped promo: prior-trader gate accepts any evidence of an earlier trade, rejects a first-ever trade', () => {
  const inWindow = { wallet: '0xa', nowMs: OPEN + 120e3, usedUsers: {} };
  assert.equal(blanketGrantsDue(traded({ days: { '2026-09-04': 250 } }), C, inWindow).length, 1, 'ledger trade-day before today');
  assert.equal(blanketGrantsDue(traded(), C, { ...inWindow, firstFillMs: OPEN - 86400e3 }).length, 1, 'feed first fill before the window');
  assert.equal(blanketGrantsDue(traded({ volumeUsd: 900 }), C, inWindow).length, 1, 'season volume, day map pruned');
  // first-ever trade lands inside the window: no prior evidence anywhere -> activation pack, not this
  assert.equal(blanketGrantsDue(traded({ days: { '2026-09-06': 40 } }), C, { ...inWindow, firstFillMs: OPEN + 60e3 }).length, 0, 'brand-new wallet');
  // any size qualifies: a $3 fill on a returning trader still pays
  assert.equal(blanketGrantsDue(traded({ days: { '2026-09-01': 3 } }), C, inWindow).length, 1, 'any trade size');
});

test('capped promo: the window and once-per-wallet rules still hold with a cap set', () => {
  const base = () => traded({ days: { '2026-09-04': 250 } });
  assert.equal(blanketGrantsDue(base(), C, { wallet: '0xa', nowMs: CLOSE + 300e3, usedUsers: {} }).length, 0, 'past grantUntilMs');
  const before = base(); before.lastFillMs = OPEN - 60e3;
  assert.equal(blanketGrantsDue(before, C, { wallet: '0xa', nowMs: OPEN + 120e3, usedUsers: {} }).length, 0, 'fill before the window opened');
  const paid = base(); paid.opsGrants['back-tonight'] = { usd: 1 };
  assert.equal(blanketGrantsDue(paid, C, { wallet: '0xa', nowMs: OPEN + 120e3, usedUsers: {} }).length, 0, 'second trade earns nothing more');
});

// --- standing new-trader bonus (+3 to every wallet whose first ever trade is on/after fromDate)
import { grantUsd } from '../src/grants.js';
const N = [{ id: 'new-trader-3', usd: 3, requires: 'traded', fromDate: '2026-09-07', excludeWallets: ['0xTEAM'] }];
const nt = (over = {}) => ({ volumeUsd: 0, opsGrants: {}, lastFillMs: 0, days: {}, ...over });

test('new-trader bonus: first trade on/after fromDate pays, any earlier evidence does not', () => {
  const now = { wallet: '0xa', today: '2026-09-07' };
  assert.equal(blanketGrantsDue(nt(), N, { ...now, vol: 50 }).length, 1, 'first fill today (this cycle)');
  assert.equal(blanketGrantsDue(nt({ days: { '2026-09-08': 20 }, volumeUsd: 20 }), N, { wallet: '0xa', today: '2026-09-08' }).length, 1, 'first fill after fromDate');
  assert.equal(blanketGrantsDue(nt({ days: { '2026-09-05': 20 }, volumeUsd: 20 }), N, { ...now, vol: 50 }).length, 0, 'ledger day before fromDate');
  assert.equal(blanketGrantsDue(nt(), N, { ...now, vol: 50, firstFillMs: Date.UTC(2026, 8, 6) }).length, 0, 'feed first fill before fromDate');
  assert.equal(blanketGrantsDue(nt({ volumeUsd: 900 }), N, now).length, 0, 'old season volume, day map pruned');
  assert.equal(blanketGrantsDue(nt(), N, { ...now, wallet: '0xteam', vol: 50 }).length, 0, 'excluded wallet');
  assert.equal(blanketGrantsDue(nt(), N, { ...now, vol: 0 }).length, 0, 'no volume at all');
  const paid = nt(); paid.opsGrants['new-trader-3'] = { usd: 3 };
  assert.equal(blanketGrantsDue(paid, N, { ...now, vol: 50 }).length, 0, 'once');
});

test('usdRange: whole-dollar draw within [lo, hi]; a range-only grant is valid; fixed usd unchanged', () => {
  const g = { id: 'r', usdRange: [1, 2], requires: 'traded-between', fromMs: 0, toMs: Infinity };
  assert.equal(grantUsd(g, () => 0), 1); assert.equal(grantUsd(g, () => 0.49), 1);
  assert.equal(grantUsd(g, () => 0.5), 2); assert.equal(grantUsd(g, () => 0.999), 2);
  assert.equal(grantUsd({ usd: 3 }), 3); assert.equal(grantUsd({ usdRange: [0, 2] }), 0, 'lo must be > 0');
  const seen = new Set(); for (let i = 0; i < 200; i++) seen.add(grantUsd(g));
  assert.deepEqual([...seen].sort(), [1, 2], 'both outcomes occur');
  assert.equal(blanketGrantsDue(nt({ lastFillMs: 5 }), [g], { wallet: '0xa', nowMs: 10 }).length, 1, 'range-only grant is evaluated');
  assert.equal(blanketGrantsDue(nt({ lastFillMs: 5 }), [{ ...g, excludeWallets: ['0xA'] }], { wallet: '0xa', nowMs: 10 }).length, 0, 'excludeWallets is case-insensitive');
});
