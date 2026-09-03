import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, enqueueStatus, due, afterAttempt, skipLegs, retryDelayMs, MAX_TRIES, STATUS_TRIES } from '../src/outbox.js';

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

test('status push: one pending entry (newest wins), dead after STATUS_TRIES; other kinds untouched', () => {
  const s = {};
  enqueue(s, { kind: 'track', wallet: '0xw', name: 'megapot_trade', data: {} });
  enqueueStatus(s, { rows: [{ wallet: '0xw' }], engine: { lastCycleMs: 1000 } }, 1000);
  const e2 = enqueueStatus(s, { rows: [], engine: { lastCycleMs: 2000 } }, 2000);
  assert.equal(s.outbox.filter((e) => e.kind === 'status').length, 1, 'coalesced');
  assert.equal(s.outbox.length, 2, 'the track entry stays');
  assert.equal(s.outbox.find((e) => e.kind === 'status').body.engine.lastCycleMs, 2000, 'newest wins');
  assert.equal(STATUS_TRIES, 3);
  assert.equal(afterAttempt(s, e2, { status: false }, 2000), 'retry');
  assert.equal(afterAttempt(s, e2, { status: false }, 2000), 'retry');
  assert.equal(afterAttempt(s, e2, { status: false }, 2000), 'dead');
  assert.equal(s.outbox.length, 1);
});
