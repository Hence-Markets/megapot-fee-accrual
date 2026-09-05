import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perUserBonusLeft } from '../src/subsidy.js';
import { engineDoc } from '../src/status.js';

test('per-user multiplier subsidy: $20 across linked wallets, then zero; no cap when unset', () => {
  const s = { wallets: { a: { multBonusUsd: 12.5 }, b: { multBonusUsd: 5 }, c: { multBonusUsd: 0 } } };
  assert.equal(perUserBonusLeft(s, ['a', 'b'], 20), 2.5);
  assert.equal(perUserBonusLeft(s, ['a', 'b', 'c'], 20), 2.5);
  assert.equal(perUserBonusLeft(s, ['a'], 20), 7.5);
  assert.equal(perUserBonusLeft({ wallets: { a: { multBonusUsd: 25 } } }, ['a'], 20), 0);
  assert.equal(perUserBonusLeft(s, ['a'], 0), Infinity);
  assert.equal(perUserBonusLeft({}, ['zzz'], 20), 20);
});

test('heartbeat carries the activation-pack pool counters when known', () => {
  const d = engineDoc({ cycleMs: 300000, nowMs: 5, paused: false, target: 'mainnet', packPoolUsed: 41, packPoolTotal: 241 });
  assert.equal(d.packPoolUsed, 41); assert.equal(d.packPoolTotal, 241);
  const bare = engineDoc({ cycleMs: 300000, nowMs: 5, paused: false, target: 'mainnet' });
  assert.equal('packPoolUsed' in bare, false); assert.equal('packPoolTotal' in bare, false);
});
