// end-to-end: the status entry through the engine's outbox against a local backend stand-in
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const hits = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { hits.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.statusCode = hits.length === 1 ? 503 : 200; res.end('{"ok":true}'); });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.USERS_URL = `http://127.0.0.1:${srv.address().port}/api/admin/wallets`;   // STATUS_URL derives from it
process.env.USERS_TOKEN = 'feed-token';
process.env.POSTHOG_KEY = ''; process.env.CUSTOMERIO_SITE_ID = '';
process.env.MEGAPOT_ACTIVE = '1';
const { flushOutbox } = await import('../src/engine.js');
const { enqueueStatus } = await import('../src/outbox.js');

test('status push: bearer feed token, 500 rows per POST with the engine doc on each, retried as a whole after a 5xx', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ wallet: `0x${String(i).padStart(40, '0')}`, pendingTickets: 0 }));
  const s = { wallets: {} };
  enqueueStatus(s, { rows, engine: { cycleMs: 300_000, lastCycleMs: 1000, paused: false, target: 'mainnet' } }, 1000);
  let r = await flushOutbox(s, 1000);
  assert.deepEqual(r, { delivered: 0, retry: 1, dead: 0 }, 'the first chunk got a 503: nothing is cleared');
  assert.equal(hits.length, 1);
  r = await flushOutbox(s, 1000 + 61_000);
  assert.deepEqual(r, { delivered: 1, retry: 0, dead: 0 });
  assert.equal(hits.length, 3, 'retry re-sends both chunks');
  assert.equal(hits[1].url, '/api/admin/megapot/status');
  assert.equal(hits[1].auth, 'Bearer feed-token');
  assert.deepEqual([hits[1].body.rows.length, hits[2].body.rows.length], [500, 1]);
  assert.deepEqual(hits[2].body.engine, { cycleMs: 300_000, lastCycleMs: 1000, paused: false, target: 'mainnet' });
  assert.equal(s.outbox.length, 0);
  srv.close();
});
