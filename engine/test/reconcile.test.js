import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPurchase, classifyIntent, walletOnHold, DROP_AFTER_MS } from '../src/reconcile.js';

const t0 = 1_000_000_000;
const p = { ts: t0, nonce: 7, tx: '0xabc' };

test('a purchase is dropped only when old, nonce consumed, tx absent and no receipt', () => {
  assert.equal(classifyPurchase(p, { receipt: 'success', txFound: null, accountNonce: 8, nowMs: t0 }), 'success');
  assert.equal(classifyPurchase(p, { receipt: 'reverted', txFound: null, accountNonce: 8, nowMs: t0 }), 'reverted');
  assert.equal(classifyPurchase(p, { receipt: undefined, txFound: false, accountNonce: 99, nowMs: t0 + 10 * DROP_AFTER_MS }), 'transport', 'transport errors never settle anything');
  assert.equal(classifyPurchase(p, { receipt: null, txFound: false, accountNonce: 99, nowMs: t0 + DROP_AFTER_MS - 1 }), 'pending', 'too young');
  assert.equal(classifyPurchase(p, { receipt: null, txFound: true, accountNonce: 99, nowMs: t0 + DROP_AFTER_MS }), 'pending', 'tx still in the node');
  assert.equal(classifyPurchase(p, { receipt: null, txFound: false, accountNonce: 7, nowMs: t0 + DROP_AFTER_MS }), 'pending', 'nonce not consumed yet');
  assert.equal(classifyPurchase(p, { receipt: null, txFound: false, accountNonce: null, nowMs: t0 + DROP_AFTER_MS }), 'pending', 'nonce unknown');
  assert.equal(classifyPurchase(p, { receipt: null, txFound: false, accountNonce: 8, nowMs: t0 + DROP_AFTER_MS }), 'dropped');
});

test('legacy records without a nonce keep the 12-unfound rule, still only after 30 min', () => {
  const legacy = { ts: t0, tx: '0xold', unfound: 11 };
  assert.equal(classifyPurchase(legacy, { receipt: null, txFound: false, accountNonce: 99, nowMs: t0 + DROP_AFTER_MS }), 'pending');
  assert.equal(classifyPurchase({ ...legacy, unfound: 12 }, { receipt: null, txFound: false, accountNonce: 99, nowMs: t0 + DROP_AFTER_MS }), 'dropped');
});

test('intents settle on a receipt, drop when the nonce went elsewhere or 30 min pass, else wait', () => {
  const it = { ts: t0, nonce: 3, tx: '0xint', wallet: '0xw' };
  assert.equal(classifyIntent(it, { consumed: true, receipt: 'success', nowMs: t0 + 1 }), 'settle');
  assert.equal(classifyIntent(it, { consumed: true, receipt: 'reverted', nowMs: t0 + 1 }), 'settle');
  assert.equal(classifyIntent(it, { consumed: true, receipt: null, nowMs: t0 + 1 }), 'drop', 'another tx took the nonce');
  assert.equal(classifyIntent(it, { consumed: false, receipt: null, nowMs: t0 + 1 }), 'wait');
  assert.equal(classifyIntent(it, { consumed: false, receipt: null, nowMs: t0 + DROP_AFTER_MS }), 'drop');
  assert.equal(classifyIntent(it, { consumed: true, receipt: undefined, nowMs: t0 + DROP_AFTER_MS }), 'wait', 'transport error: decide next cycle');
  assert.equal(walletOnHold({ intents: [it] }, '0xw'), true);
  assert.equal(walletOnHold({ intents: [it] }, '0xz'), false);
  assert.equal(walletOnHold({}, '0xw'), false);
});
