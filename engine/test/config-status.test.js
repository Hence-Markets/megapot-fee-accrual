// STATUS_URL / RPC / cycle derivation - config.js reads env at import, so set it first
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TARGET = 'mainnet';
process.env.USERS_URL = 'https://app.hence.markets/api/admin/wallets?feed=1';
for (const k of ['STATUS_URL', 'GRANTS_URL', 'RPC', 'ENGINE_INTERVAL_S']) delete process.env[k];
const { cfg, net } = await import('../src/config.js');
const { DEFAULT_RPCS } = await import('../src/rpc.js');

test('STATUS_URL derives from USERS_URL like GRANTS_URL; RPC defaults to the mainnet list; cycle from the sheet', () => {
  assert.equal(cfg.STATUS_URL, 'https://app.hence.markets/api/admin/megapot/status');
  assert.equal(cfg.GRANTS_URL, 'https://app.hence.markets/api/admin/megapot/grants');
  assert.deepEqual(net().rpcs, DEFAULT_RPCS.mainnet);
  assert.equal(cfg.CYCLE_MS, 300_000);
});
