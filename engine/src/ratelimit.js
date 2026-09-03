// Token bucket for the Hyperliquid info API, shared by the full sweep and the fast
// lane (separate processes) through a small state file. PURE core + a thin IO shell.
// HL weights userFillsByTime at 20 of 1200/min; 50 req/min keeps us well inside it.
import fs from 'node:fs';

export const HL_RPM = 50;

/** take one token from `state` ({tokens, at}) at nowMs; returns the new state and how
 *  long to wait first (0 when a token was available) */
export function takeToken(state, nowMs, cap = HL_RPM, refillPerMs = HL_RPM / 60_000) {
  const at = Number(state?.at || 0);
  let tokens = state && state.at != null ? Number(state.tokens) : cap;
  tokens = Math.min(cap, tokens + Math.max(0, nowMs - at) * refillPerMs);
  if (tokens >= 1) return { state: { tokens: tokens - 1, at: nowMs }, waitMs: 0 };
  const waitMs = Math.ceil((1 - tokens) / refillPerMs);
  return { state: { tokens, at: nowMs }, waitMs };
}

/** backoff after a 429: 2s, 4s, 8s ... capped at 30s */
export const backoffMs = (attempt) => Math.min(30_000, 2000 * 2 ** Math.max(0, attempt));

/** file-backed bucket: read-modify-write around takeToken; sleeps until a token is free */
export function fileBucket(file, { cap = HL_RPM, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const write = (st) => { try { fs.writeFileSync(file, JSON.stringify(st)); } catch { /* best-effort */ } };
  return {
    async take() {
      for (;;) {
        const r = takeToken(read(), Date.now(), cap);
        if (r.waitMs === 0) { write(r.state); return; }
        await sleep(r.waitMs);
      }
    },
  };
}
