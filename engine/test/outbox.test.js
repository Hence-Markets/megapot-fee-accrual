import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, due, afterAttempt, skipLegs, retryDelayMs, MAX_TRIES } from '../src/outbox.js';

test('outbox: an entry leaves only when every enabled leg delivered; a failed leg retries alone', () => {
  const s = {};
  const e = enqueue(s, { kind: 'track', wallet: '0xw', name: 'megapot_win_unclaimed', data: { usd: 2 } }, 1000);
  assert.equal(due(s, 1000).length, 1);
  assert.equal(afterAttempt(s, e, { cio: true, ph: false }, 1000), 'retry');
  assert.equal(s.outbox.length, 1);
  assert.deepEqual(skipLegs(e), { cio: true }, 'Customer.io got it: only PostHog is re-sent');
  assert.equal(due(s, 1000).length, 0, 'backoff: not due yet');
  assert.equal(e.nextAt, 1000 + retryDelayMs(1));
  assert.equal(due(s, e.nextAt).length, 1);
  assert.equal(afterAttempt(s, e, { cio: null, ph: true }, e.nextAt), 'delivered');
  assert.equal(s.outbox.length, 0);
});

test('outbox: disabled legs count as delivered; poisoned entries die after MAX_TRIES', () => {
  const s = {};
  const ok = enqueue(s, { kind: 'identify', wallet: '0xw', attrs: {} });
  assert.equal(afterAttempt(s, ok, { cio: null }), 'delivered');
  const bad = enqueue(s, { kind: 'grant', wallet: '0xw', body: {} });
  let r;
  for (let i = 0; i < MAX_TRIES; i++) r = afterAttempt(s, bad, { grant: false }, i);
  assert.equal(r, 'dead');
  assert.equal(s.outbox.length, 0);
  assert.equal(retryDelayMs(1), 60_000); assert.equal(retryDelayMs(3), 240_000); assert.equal(retryDelayMs(20), 3_600_000);
});
