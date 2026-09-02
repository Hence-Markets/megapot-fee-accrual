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
// one engine process at a time: a stale lock (dead pid or > 15 min) is reclaimed
export function acquireLock(file) {
  const lock = `${file}.lock`;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return () => { try { fs.unlinkSync(lock); } catch { /* gone */ } };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let info = {};
    try { info = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* corrupt lock = stale */ }
    let alive = false;
    try { if (info.pid) { process.kill(info.pid, 0); alive = true; } } catch { alive = false; }
    if (alive && Date.now() - (info.at || 0) < 15 * 60_000) throw new Error(`another engine process (pid ${info.pid}) holds ${lock}`);
    fs.unlinkSync(lock);
    return acquireLock(file);
  }
}
// fills the campaign pays on: Hence-routed only (a builder fee was charged),
// unless the campaign explicitly opens it up
export const isHenceFill = (f, requireBuilderFee = true) => !requireBuilderFee || Number(f?.builderFee || 0) > 0;
