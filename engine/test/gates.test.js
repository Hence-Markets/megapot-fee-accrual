import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeFromDailyGate } from '../src/gates.js';

test('daily gate paces grants across users and resets at the UTC day boundary', () => {
  const s = {};
  assert.equal(takeFromDailyGate(s, 'streak', 30, '2026-09-10', 20), 20);
  assert.equal(takeFromDailyGate(s, 'streak', 30, '2026-09-10', 20), 10);   // only 10 left today
  assert.equal(takeFromDailyGate(s, 'streak', 30, '2026-09-10', 5), 0);
  assert.equal(takeFromDailyGate(s, 'streak', 30, '2026-09-11', 5), 5);     // next day
  assert.equal(takeFromDailyGate(s, 'other', 0, '2026-09-11', 7), 7);       // no cap = pass-through
});
