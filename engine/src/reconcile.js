// Purchase / intent settlement rules - PURE. engine.js gathers the chain facts
// (receipt, tx presence, account nonce) and these decide what the ledger does.
export const DROP_AFTER_MS = 30 * 60_000;

/**
 * One unverified purchase record against what the chain says right now.
 *   receipt:      'success' | 'reverted' | null (not found) | undefined (lookup failed = transport)
 *   txFound:      true | false | null (unknown / not checked)
 *   accountNonce: the account's LATEST nonce (number) or null when unknown
 * -> 'success' | 'reverted' | 'dropped' | 'pending' | 'transport'
 * Dropped only when the record is old, its nonce has been consumed by something
 * else, the tx is absent from the node and there is no receipt.
 */
export function classifyPurchase(p, { receipt, txFound, accountNonce, nowMs = Date.now() }) {
  if (receipt === 'success' || receipt === 'reverted') return receipt;
  if (receipt === undefined) return 'transport';
  const age = nowMs - Number(p.ts || 0);
  if (age < DROP_AFTER_MS) return 'pending';
  if (txFound !== false) return 'pending';
  if (p.nonce == null) return (p.unfound || 0) >= 12 ? 'dropped' : 'pending';   // legacy record: no nonce to check
  if (accountNonce == null || accountNonce <= Number(p.nonce)) return 'pending';
  return 'dropped';
}

/**
 * An intent (persisted BEFORE broadcast; hash known from local signing).
 *   consumed: account latest nonce > intent.nonce
 *   receipt:  'success' | 'reverted' | null | undefined (transport)
 * -> 'settle' (receipt found: book it), 'drop' (nonce used by another tx, or stale
 *    and never consumed), 'wait' (still possible)
 */
export const CONSUMED_GRACE_MS = 5 * 60_000;
export function classifyIntent(intent, { consumed, receipt, txFound = null, nowMs = Date.now() }) {
  if (receipt === 'success' || receipt === 'reverted') return 'settle';
  if (receipt === undefined) return 'wait';
  const age = nowMs - Number(intent.ts || 0);
  // nonce spent by a different tx: this one can never mine. But "consumed" can come
  // from a node one block AHEAD of the one that answered the receipt lookup
  // (load-balanced public RPCs), so a consumed nonce with no receipt is only dropped
  // once the node also has no such tx, or after a grace period - never on first sight.
  if (consumed) return (txFound === false || age >= CONSUMED_GRACE_MS) ? 'drop' : 'wait';
  return age >= DROP_AFTER_MS ? 'drop' : 'wait';
}

/** a wallet with an open intent is on hold: no new buy until the intent settles */
export const walletOnHold = (s, w) => (s.intents || []).some((i) => i.wallet === w);
