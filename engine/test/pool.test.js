import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/pool.js';

test('mapLimit keeps at most N in flight, collects errors, honours the time budget', async () => {
  let inFlight = 0, peak = 0;
  const fn = async (x) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; if (x === 3) throw new Error('boom'); return x * 2; };
  const r = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, fn);
  assert.equal(peak, 3);
  assert.equal(r.done, 10);
  assert.equal(r.results[0], 2);
  assert.ok(r.results[2] instanceof Error);
  let clock = 0;
  const r2 = await mapLimit([1, 2, 3, 4], 1, async () => { clock += 100; return 1; }, { budgetMs: 150, now: () => clock });
  assert.equal(r2.done, 2);
  assert.equal(r2.skipped, 2);
  assert.deepEqual(await mapLimit([], 8, async () => 1), { results: [], done: 0, skipped: 0 });
});
