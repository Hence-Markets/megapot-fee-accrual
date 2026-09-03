import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeToken, backoffMs } from '../src/ratelimit.js';

test('token bucket: 50 per minute, refills continuously, waits when empty', () => {
  let st = null;
  const t0 = 1_000_000;
  for (let i = 0; i < 50; i++) { const r = takeToken(st, t0, 50); assert.equal(r.waitMs, 0); st = r.state; }
  const empty = takeToken(st, t0, 50);
  assert.ok(empty.waitMs > 0 && empty.waitMs <= 1200, `wait ${empty.waitMs}`);   // one token every 1.2s
  const later = takeToken(empty.state, t0 + 1200, 50);
  assert.equal(later.waitMs, 0);
  const full = takeToken(later.state, t0 + 10 * 60_000, 50);                     // never above the cap
  assert.equal(full.state.tokens, 49);
});

test('429 backoff doubles from 2s and caps at 30s', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(backoffMs), [2000, 4000, 8000, 16000, 30000]);
});
