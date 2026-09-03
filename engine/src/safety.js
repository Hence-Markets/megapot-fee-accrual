// Operational safety helpers - PURE (no IO) so every rule here has a test.
// The engine reads balances / fees / feeds and asks these functions what to do.

export const GAS_PER_BUY = 6_500_000n;                // the explicit buy gas limit
export const ALERT_GAP_MS = 60 * 60_000;              // at most one alert of a kind per hour

/** ETH the pool wallet must keep so three buys can still be sent at the fee cap */
export function gasReserveWei(maxFeeWei) { return GAS_PER_BUY * BigInt(maxFeeWei) * 3n; }

/** balances (bigint, base units) vs one ticket at `priceUnits` + the gas reserve */
export function lowFunds({ usdc, eth, priceUnits, maxFeeWei }) {
  const reserve = gasReserveWei(maxFeeWei);
  const usdcLow = BigInt(usdc) < BigInt(priceUnits);
  const ethLow = BigInt(eth) < reserve;
  return { low: usdcLow || ethLow, usdcLow, ethLow, reserve };
}

/** maxFeePerGas for a buy: 2x the current base fee, never above the hard ceiling,
 *  never below the tip (a maxFee under the priority fee is an invalid tx) */
export function feeCapFor(baseFee, ceilingWei, priorityWei = 0n) {
  const twice = BigInt(baseFee) * 2n;
  let cap = twice < BigInt(ceilingWei) ? twice : BigInt(ceilingWei);
  if (cap < BigInt(priorityWei)) cap = BigInt(priorityWei);
  return cap;
}

/** the base fee sits above the alert line - buys stall while it does */
export const feeSpike = (baseFee, alertWei) => BigInt(baseFee) > BigInt(alertWei);

/** alert dedupe: `alerts` is the ledger's s.alerts map (kind -> last ms) */
export function shouldAlert(alerts, kind, nowMs = Date.now(), gapMs = ALERT_GAP_MS) {
  const last = Number(alerts?.[kind] || 0);
  return nowMs - last >= gapMs;
}

/** refuse to overwrite the disk cache with an empty feed, or one that lost > 20% of
 *  the wallets the cache holds - the next outage would then run on the bad copy */
export function shouldCacheFeed(newCount, cachedCount) {
  if (!(newCount > 0)) return false;
  if (cachedCount > 0 && newCount < cachedCount * 0.8) return false;
  return true;
}

/** rotate the wallet order so the same tail never starves on rate limits */
export function rotate(list, offset) {
  if (!list.length) return list;
  const k = ((offset % list.length) + list.length) % list.length;
  return list.slice(k).concat(list.slice(0, k));
}

/** consecutive-cycle skip streak: alert once the third cycle in a row skipped wallets */
export function accrueSkipStreak(prevStreak, skipped) {
  const streak = skipped > 0 ? (prevStreak || 0) + 1 : 0;
  return { streak, alert: streak >= 3 };
}
