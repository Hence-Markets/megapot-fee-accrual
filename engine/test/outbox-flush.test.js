// end-to-end: the engine's outbox against a local PostHog stand-in that fails once
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const hits = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { hits.push(JSON.parse(body)); res.statusCode = hits.length === 1 ? 500 : 200; res.end('{}'); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.POSTHOG_HOST = `http://127.0.0.1:${srv.address().port}`;
process.env.POSTHOG_KEY = 'phc_test';
process.env.CUSTOMERIO_SITE_ID = '';
process.env.MEGAPOT_ACTIVE = '1';
const { flushOutbox } = await import('../src/engine.js');
const { enqueue } = await import('../src/outbox.js');

test('outbox delivers at-least-once: a 500 keeps the entry and the win marker pending, a 200 clears both', async () => {
  const s = { wallets: { '0xw': { cioWins: { t1: 'pending' } } } };
  enqueue(s, { kind: 'track', wallet: '0xw', name: 'megapot_win_unclaimed', data: { usd: 2 }, then: { win: { wallet: '0xw', id: 't1', state: 'notified' } } }, 1000);
  let r = await flushOutbox(s, 1000);
  assert.deepEqual(r, { delivered: 0, retry: 1, dead: 0 });
  assert.equal(s.wallets['0xw'].cioWins.t1, 'pending');
  assert.equal(s.outbox.length, 1);
  r = await flushOutbox(s, 1000 + 30_000);
  assert.deepEqual(r, { delivered: 0, retry: 0, dead: 0 }, 'not due yet');
  r = await flushOutbox(s, 1000 + 61_000);
  assert.deepEqual(r, { delivered: 1, retry: 0, dead: 0 });
  assert.equal(s.wallets['0xw'].cioWins.t1, 'notified', 'marked only after the 2xx');
  assert.equal(s.outbox.length, 0);
  assert.equal(hits.length, 2);
  assert.equal(hits[1].event, 'megapot_win_unclaimed'); assert.equal(hits[1].distinct_id, '0xw');
  srv.close();
});
