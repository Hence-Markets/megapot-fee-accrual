// Ledger OUTBOX - PURE queue rules. Every CRM / PostHog / grant call is written here
// after the ledger save that records the fact, and delivered at-least-once: an
// entry leaves the queue only when every enabled leg returned 2xx. Backoff per
// entry so one dead endpoint never blocks the rest; a poisoned entry dies after
// MAX_TRIES with a log line, never by silently vanishing.
export const MAX_TRIES = 48;                                   // ~ a day at the capped backoff
export const retryDelayMs = (tries) => Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, tries - 1));

let _seq = 0;
export function enqueue(s, entry, nowMs = Date.now()) {
  const e = { id: `${nowMs}-${(_seq++).toString(36)}`, ts: nowMs, tries: 0, nextAt: 0, ...entry };
  (s.outbox ??= []).push(e);
  return e;
}
export const due = (s, nowMs = Date.now()) => (s.outbox || []).filter((e) => Number(e.nextAt || 0) <= nowMs);

/** apply one delivery attempt. `legs` = {cio: true|false|null, ph: ...} (null = leg disabled).
 *  Returns 'delivered' | 'retry' | 'dead'. Delivered legs are remembered so a retry
 *  only re-sends the leg that failed. */
export function afterAttempt(s, entry, legs, nowMs = Date.now()) {
  entry.done = { ...(entry.done || {}) };
  for (const [k, v] of Object.entries(legs || {})) if (v === true || v === null) entry.done[k] = true;
  const pending = Object.entries(legs || {}).some(([k, v]) => v === false && !entry.done[k]);
  if (!pending) { s.outbox = (s.outbox || []).filter((x) => x !== entry); return 'delivered'; }
  entry.tries = (entry.tries || 0) + 1;
  if (entry.tries >= MAX_TRIES) { s.outbox = (s.outbox || []).filter((x) => x !== entry); return 'dead'; }
  entry.nextAt = nowMs + retryDelayMs(entry.tries);
  return 'retry';
}
/** legs still owed for this entry (skip the ones already delivered) */
export const skipLegs = (entry) => ({ ...(entry.done || {}) });
