// Bounded-concurrency map with a wall-clock budget - PURE control flow.
export async function mapLimit(items, limit, fn, { budgetMs = Infinity, now = Date.now } = {}) {
  const start = now();
  let i = 0, done = 0, skipped = 0;
  const results = new Array(items.length);
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      if (now() - start > budgetMs) { skipped++; continue; }
      try { results[idx] = await fn(items[idx], idx); } catch (e) { results[idx] = e; }
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return { results, done, skipped };
}
