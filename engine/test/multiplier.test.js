import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTierRows, splitBoost, kickerFor } from '../src/tiers.js';

test('tier rows parse to wallet -> {x, crossedMs}, dropping malformed entries', () => {
  const m = parseTierRows([
    { wallet: '0x9CC6c5d8318C69b602b866F644628E61d98F55ed', usd: 1200, x: 2, crossedMs: 1788400000000 },
    { wallet: 'nope', x: 2, crossedMs: 1 }, { wallet: '0x' + 'a'.repeat(40), x: 1, crossedMs: 5 },
  ]);
  assert.deepEqual(m, { '0x9cc6c5d8318c69b602b866f644628e61d98f55ed': { x: 2, crossedMs: 1788400000000 } });
});

test('kickers: 2x = +25% .. 5x = +100%, unknown = 0', () => {
  const k = { 1: 0, 2: 0.25, 3: 0.5, 4: 0.75, 5: 1 };
  assert.equal(kickerFor(2, k), 0.25); assert.equal(kickerFor(5, k), 1); assert.equal(kickerFor(7, k), 0);
});

test('fills split into base / boosted by the crossing time', () => {
  const fills = [
    { px: 100, sz: 1, time: 1788399999999 },   // before the crossing
    { px: 100, sz: 2, time: 1788400000000 },   // at the crossing
    { px: 100, sz: 3, time: 1788400001000 },
  ];
  assert.deepEqual(splitBoost(fills, 1788400000000), { base: 100, boosted: 500 });
  assert.deepEqual(splitBoost(fills, null), { base: 600, boosted: 0 });
});
