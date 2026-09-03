import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicClient } from 'viem';
import { base } from 'viem/chains';
import { parseRpcList, isRateLimited, rpcTransport, watchRateLimits, DEFAULT_RPCS } from '../src/rpc.js';

test('RPC list: comma-separated, trimmed, blanks dropped; empty = the network defaults', () => {
  assert.deepEqual(parseRpcList(' https://a , ,https://b,'), ['https://a', 'https://b']);
  assert.deepEqual(parseRpcList('', DEFAULT_RPCS.mainnet), DEFAULT_RPCS.mainnet);
  assert.deepEqual(parseRpcList(undefined, DEFAULT_RPCS.testnet), ['https://sepolia.base.org']);
  assert.deepEqual(DEFAULT_RPCS.mainnet, ['https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io', 'https://1rpc.io/base']);
});

test('rate-limit answers: -32016 / -32005 / 429 / "over rate limit", anywhere down the cause chain', () => {
  assert.equal(isRateLimited(Object.assign(new Error('x'), { code: -32016 })), true);
  assert.equal(isRateLimited(Object.assign(new Error('HTTP request failed'), { status: 429 })), true);
  assert.equal(isRateLimited(new Error('RPC Request failed.\n\nDetails: over rate limit')), true);
  assert.equal(isRateLimited(new Error('wrapped', { cause: Object.assign(new Error('inner'), { code: -32005 }) })), true);
  assert.equal(isRateLimited(Object.assign(new Error('execution reverted'), { code: 3 })), false);
  assert.equal(isRateLimited(new Error('timeout')), false);
  assert.equal(isRateLimited(null), false);
});

// two local nodes: the first answers every call with Base's rate-limit error, the second works
const serve = (reply) => new Promise((r) => {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, ...reply })); });
  });
  srv.listen(0, '127.0.0.1', () => r(srv));
});
const urlOf = (srv) => `http://127.0.0.1:${srv.address().port}`;

test('fallback: a rate-limited node is skipped for the next url and reported by url', async () => {
  const limited = await serve({ error: { code: -32016, message: 'over rate limit' } });
  const healthy = await serve({ result: '0x10' });
  const seen = [];
  const pub = createPublicClient({ chain: base, transport: rpcTransport([urlOf(limited), urlOf(healthy)]) });
  watchRateLimits(pub, (u) => seen.push(u));
  assert.equal(pub.transport.type, 'fallback');
  assert.equal(await pub.getBlockNumber(), 16n, 'answered by the second node');
  assert.deepEqual([...new Set(seen)], [urlOf(limited)], 'only the limited node is reported');
  limited.close(); healthy.close();
});
