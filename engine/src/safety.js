// Operational safety helpers - PURE (no IO) so every rule here has a test.
// The engine reads balances / fees / feeds and asks these functions what to do.

// buy gas scales with the ticket count: the quick-pick path mints one NFT per ticket
// (~0.7M gas each on top of ~0.2M fixed). Measured on Base 2026-09-02..04: 1 ticket
// 0.75-1.17M, 4 -> 2.8-2.9M, 5 -> 3.6-4.0M, and a 10-ticket buy ran OUT OF GAS at the old
// flat 6.5M limit (used 6,406,350 of 6,500,000 - two reverts for 0x7a08, 2026-09-04 14:04Z).
export const BUY_GAS_BASE = 1_000_000n;
export const BUY_GAS_PER_TICKET = 900_000n;
export const MAX_PER_BUY_GAS = 10n;
export function buyGasFor(count) {
  const c = BigInt(Math.max(1, Math.min(Number(count) || 1, Number(MAX_PER_BUY_GAS))));
  return BUY_GAS_BASE + BUY_GAS_PER_TICKET * c;                 // 10 tickets -> 10.0M, 5 -> 5.5M, 1 -> 1.9M
}
export const GAS_PER_BUY = buyGasFor(MAX_PER_BUY_GAS);      // the largest buy the engine sends
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
