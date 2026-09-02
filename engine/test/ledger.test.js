import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLedger, writeLedger, acquireLock, isHenceFill } from '../src/ledger.js';

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

test('lock: second holder refused while the first is alive, stale lock reclaimed', () => {
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file), /another engine process/);
  release();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: 0 }));   // dead pid, ancient
  const r2 = acquireLock(file); r2();
});

test('only Hence-routed fills (builder fee charged) pay', () => {
  assert.equal(isHenceFill({ builderFee: '0.12' }), true);
  assert.equal(isHenceFill({ builderFee: '0' }), false);
  assert.equal(isHenceFill({}), false);
  assert.equal(isHenceFill({}, false), true);
});
