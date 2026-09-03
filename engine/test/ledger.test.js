import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLedger, writeLedger, acquireLock, isHenceFill, LOCK_STALE_MS } from '../src/ledger.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
const file = path.join(dir, 'ledger.json');

test('missing ledger = fresh; corrupt ledger = hard stop, never a blank season', () => {
  assert.deepEqual(readLedger(file, () => ({ wallets: {} })), { wallets: {} });
  writeLedger(file, { wallets: { a: 1 }, spentUsdc: 3 });
  assert.equal(readLedger(file, () => null).spentUsdc, 3);
  fs.writeFileSync(file, '{"wallets": {"a": 1}, "spentUs');   // truncated mid-write
  assert.throws(() => readLedger(file, () => ({})), /refusing to start/);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no tmp files left behind');
});

test('lock: second holder refused while the heartbeat is fresh; reclaimed after 5 min without one', () => {
  const release = acquireLock(file, { heartbeat: false });
  assert.throws(() => acquireLock(file, { heartbeat: false }), /another engine process/);
  release();
  const now = Date.now();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: now - LOCK_STALE_MS + 10_000 }));   // 4m50s old: still held
  assert.throws(() => acquireLock(file, { heartbeat: false }), /another engine process/);
  // a live pid in ANOTHER container is invisible here: only the heartbeat age decides
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: now - LOCK_STALE_MS - 1 }));
  const r2 = acquireLock(file, { heartbeat: false }); r2();
  fs.writeFileSync(`${file}.lock`, 'not json');                                      // corrupt = stale
  const r3 = acquireLock(file, { heartbeat: false }); r3();
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test('only Hence-routed fills (builder fee charged) pay', () => {
  assert.equal(isHenceFill({ builderFee: '0.12' }), true);
  assert.equal(isHenceFill({ builderFee: '0' }), false);
  assert.equal(isHenceFill({}), false);
  assert.equal(isHenceFill({}, false), true);
});
