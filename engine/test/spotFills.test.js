import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesSpot, foldSpotFills } from '../src/spotFills.js';

// The spot twin of the HL accrual rules. Every rejection here is a money rule: a fill the
// engine credits must carry OUR fee, sit inside the season window, be explicitly product
// 'spot' (a bare symbol falling through the coin-prefix derivation would credit as a PERP),
// and never be counted twice across replays.

const CFG = {
  PRODUCTS: ['perps', 'xyz-equities', 'spot'],
  START_MS: 1_000_000,
  END_MS: 2_000_000,
  ZERO_FEE: ['PROMO'],
  SYMBOLS: [],
  ROLLOVER: 1.0,
};
const fill = (over = {}) => ({
  wallet: '0x' + 'a'.repeat(40), coin: 'NVDA', side: 'buy', px: 200, sz: 0.5, usd: 100,
  builderFee: 0.25, time: 1_500_000, tid: '4663:0xabc', product: 'spot', ...over,
});

test('qualifiesSpot: every gate rejects for its own reason', () => {
  assert.ok(qualifiesSpot(fill(), CFG));
  assert.ok(!qualifiesSpot(fill(), { ...CFG, PRODUCTS: ['perps'] }), 'product disabled');
  assert.ok(!qualifiesSpot(fill({ product: undefined }), CFG), 'no explicit product — never the prefix fallback');
  assert.ok(!qualifiesSpot(fill({ product: 'perps' }), CFG), 'wrong product literal');
  assert.ok(!qualifiesSpot(fill({ builderFee: 0 }), CFG), 'no fee charged → Hence earned nothing');
  assert.ok(!qualifiesSpot(fill({ builderFee: undefined }), CFG), 'fee ABSENT is not fee zero — neither credits');
  assert.ok(!qualifiesSpot(fill({ time: 999_999 }), CFG), 'before the season');
  assert.ok(!qualifiesSpot(fill({ time: 2_000_001 }), CFG), 'after the season');
  assert.ok(!qualifiesSpot(fill({ coin: 'xyz:NVDA' }), CFG), 'a spot coin is a bare symbol by hub law');
  assert.ok(!qualifiesSpot(fill({ coin: 'PROMO' }), CFG), 'zero-fee promo pairs earn nothing');
  assert.ok(!qualifiesSpot(fill({ coin: 'NVDA' }), { ...CFG, SYMBOLS: ['AAPL'] }), 'allowlist respected');
});

test('credit is the EXACT recorded fee times rollover — never a bps recompute', () => {
  const r = foldSpotFills([fill({ builderFee: 0.25 }), fill({ builderFee: 0.1, time: 1_500_001, usd: 40 })], 0, CFG);
  assert.equal(r.count, 2);
  assert.ok(Math.abs(r.credit - 0.35) < 1e-12);
  assert.equal(r.vol, 140);
  const half = foldSpotFills([fill()], 0, { ...CFG, ROLLOVER: 0.5 });
  assert.ok(Math.abs(half.credit - 0.125) < 1e-12);
});

test('the checkpoint makes replays idempotent — a fill can never credit twice', () => {
  const rows = [fill({ time: 1_400_000 }), fill({ time: 1_500_000 })];
  const first = foldSpotFills(rows, 0, CFG);
  assert.equal(first.count, 2);
  assert.equal(first.lastSpotFillMs, 1_500_000);
  const replay = foldSpotFills(rows, first.lastSpotFillMs, CFG);
  assert.equal(replay.count, 0, 'the same page re-served must credit nothing');
  assert.equal(replay.credit, 0);
  assert.equal(replay.lastSpotFillMs, 1_500_000, 'checkpoint never moves backward');
});

test('two same-millisecond fills inside ONE batch both count', () => {
  // the floor is frozen at entry — comparing against the advancing cursor would silently
  // drop the second of a same-ms pair, under-crediting a real fill
  const r = foldSpotFills([fill({ tid: 'a' }), fill({ tid: 'b' })], 0, CFG);
  assert.equal(r.count, 2);
});

test('an unpriced fill contributes NOTHING — no credit, no volume, no streak day', () => {
  const r = foldSpotFills([fill({ usd: undefined, px: undefined, sz: undefined })], 0, CFG);
  assert.equal(r.count, 0);
  assert.equal(r.credit, 0);
  assert.deepEqual(r.days, {});
});

test('volume, days and maxFill feed the pack/streak grammar', () => {
  const r = foldSpotFills([fill({ usd: 300, time: 1_400_000 }), fill({ usd: 50, time: 1_500_000 })], 0, CFG);
  assert.equal(r.maxFillUsd, 300, 'a single ≥$250 spot fill can qualify the activation pack');
  assert.equal(Object.keys(r.days).length, 1, 'same UTC day aggregates');
  assert.equal(r.days[new Date(1_400_000).toISOString().slice(0, 10)], 350);
});

test('notional prefers the cash leg and falls back to px*sz', () => {
  const r = foldSpotFills([fill({ usd: undefined, px: 200, sz: 0.5 })], 0, CFG);
  assert.equal(r.vol, 100);
});
