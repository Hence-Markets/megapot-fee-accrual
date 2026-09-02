/* Multiplier tier helpers - PURE (no config, no network) so they test in isolation.
   Tiers are KICKERS on top of base minting: 2x = +25% ... 5x = +100%. */
export const parseTierRows = (rows) => {
  const out = {};
  for (const r of rows || []) {
    const w = String(r?.wallet || '').trim().toLowerCase();
    const t = Number(r?.crossedMs ?? r?.crossed_ms);
    const x = Number(r?.x || 0);
    if (/^0x[a-f0-9]{40}$/.test(w) && Number.isFinite(t) && t > 0 && x >= 2) out[w] = { x, crossedMs: t };
  }
  return out;
};
export const kickerFor = (x, kickers) => Number(kickers?.[x] ?? 0);
/** split qualifying notional into base / boosted by the tier crossing time (pure) */
export const splitBoost = (fills, crossedMs) => {
  let base = 0, boosted = 0;
  for (const f of fills) {
    const n = Number(f.px) * Number(f.sz);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (crossedMs && Number(f.time) >= crossedMs) boosted += n; else base += n;
  }
  return { base, boosted };
};
