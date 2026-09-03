// Ledger persistence - crash-safe. A truncated file must never masquerade as
// a fresh season (that would re-credit, re-draw and re-mint everything), so
// writes go tmp -> rename (atomic on POSIX) and only ENOENT reads as fresh.
import fs from 'node:fs';
import path from 'node:path';

export function readLedger(file, fresh) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') return fresh();
    throw new Error(`ledger ${file} unreadable (${e.message}) - refusing to start from a blank season; restore from backup`);
  }
}
export function writeLedger(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}
// one engine process at a time. The holder refreshes `at` every 60 s (heartbeat);
// a lock is reclaimed only when that heartbeat is > 5 min old - a live holder in
// another container (pid invisible here) keeps it, and a holder stuck in a long
// receipt wait keeps it as long as its timer ticks.
export const LOCK_HEARTBEAT_MS = 60_000;
export const LOCK_STALE_MS = 5 * 60_000;
export function acquireLock(file, { nowMs = Date.now(), staleMs = LOCK_STALE_MS, heartbeat = true } = {}) {
  const lock = `${file}.lock`;
  const stamp = () => JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, stamp(), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let info = {};
    try { info = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* corrupt lock = stale */ }
    if (nowMs - Number(info.at || 0) < staleMs) throw new Error(`another engine process (pid ${info.pid}) holds ${lock} (heartbeat ${Math.round((nowMs - Number(info.at || 0)) / 1000)}s ago)`);
    fs.unlinkSync(lock);
    return acquireLock(file, { nowMs, staleMs, heartbeat });
  }
  let timer = null;
  if (heartbeat) {
    timer = setInterval(() => { try { fs.writeFileSync(lock, stamp()); } catch { /* next tick */ } }, LOCK_HEARTBEAT_MS);
    timer.unref();
  }
  return () => { if (timer) clearInterval(timer); try { fs.unlinkSync(lock); } catch { /* gone */ } };
}
// fills the campaign pays on: Hence-routed only (a builder fee was charged),
// unless the campaign explicitly opens it up
// A Hence fill = one Hence earns its fee on. Native HL perps only count when
// routed through Hence (builderFee tag present). xyz HIP-3 assets ALWAYS count
// for whitelisted wallets: Hence is the xyz DEPLOYER, so it earns on every xyz
// fill regardless of the builderFee field (which xyz fills never populate).
export const isHenceFill = (f, requireBuilderFee = true) =>
  !requireBuilderFee || Number(f?.builderFee || 0) > 0 || String(f?.coin || '').startsWith('xyz:');
