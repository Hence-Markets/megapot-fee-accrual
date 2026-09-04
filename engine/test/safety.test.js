import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gasReserveWei, lowFunds, feeCapFor, feeSpike, shouldAlert, shouldCacheFeed, rotate, accrueSkipStreak, GAS_PER_BUY } from '../src/safety.js';

const GWEI = 1_000_000_000n;

test('low funds: one ticket of USDC and three buys of gas at the fee cap', () => {
  const maxFeeWei = 18_000_000n;                                   // 0.018 gwei
  assert.equal(gasReserveWei(maxFeeWei), GAS_PER_BUY * maxFeeWei * 3n);
  const ok = lowFunds({ usdc: 5_000_000n, eth: 10n ** 18n, priceUnits: 1_000_000n, maxFeeWei });
  assert.equal(ok.low, false);
  const noUsdc = lowFunds({ usdc: 999_999n, eth: 10n ** 18n, priceUnits: 1_000_000n, maxFeeWei });
  assert.deepEqual([noUsdc.low, noUsdc.usdcLow, noUsdc.ethLow], [true, true, false]);
  const noEth = lowFunds({ usdc: 5_000_000n, eth: gasReserveWei(maxFeeWei) - 1n, priceUnits: 1_000_000n, maxFeeWei });
  assert.deepEqual([noEth.low, noEth.usdcLow, noEth.ethLow], [true, false, true]);
});

test('fee cap = min(2 x base fee, ceiling), never below the tip; spike above the alert line', () => {
  const ceiling = GWEI / 10n;                                      // 0.1 gwei
  assert.equal(feeCapFor(6_000_000n, ceiling, 500_000n), 12_000_000n);   // Base at 0.006 -> 0.012
  assert.equal(feeCapFor(GWEI, ceiling, 500_000n), ceiling);              // spike: capped at ceiling
  assert.equal(feeCapFor(0n, ceiling, 500_000n), 500_000n);               // never under the priority fee
  assert.equal(feeSpike(6_000_000n, 18_000_000n), false);
  assert.equal(feeSpike(20_000_000n, 18_000_000n), true);
});

test('alerts fire at most once an hour per kind', () => {
  const alerts = {}, t0 = 10 * 60 * 60_000;
  assert.equal(shouldAlert(alerts, 'lastLowFundsMs', t0), true);
  alerts.lastLowFundsMs = t0;
  assert.equal(shouldAlert(alerts, 'lastLowFundsMs', t0 + 30 * 60_000), false);
  assert.equal(shouldAlert(alerts, 'lastLowFundsMs', t0 + 60 * 60_000), true);
  assert.equal(shouldAlert(alerts, 'lastFeeSpikeMs', t0 + 1), true);   // another kind is independent
});

test('feed cache guard: empty or > 20% shrink never overwrites the cache', () => {
  assert.equal(shouldCacheFeed(0, 0), false);
  assert.equal(shouldCacheFeed(0, 100), false);
  assert.equal(shouldCacheFeed(79, 100), false);
  assert.equal(shouldCacheFeed(80, 100), true);
  assert.equal(shouldCacheFeed(5, 0), true);
  assert.equal(shouldCacheFeed(120, 100), true);
});

test('rotation moves the start offset each cycle; skip streak alerts on the third cycle', () => {
  assert.deepEqual(rotate(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 1), ['b', 'c', 'a']);
  assert.deepEqual(rotate(['a', 'b', 'c'], 4), ['b', 'c', 'a']);
  assert.deepEqual(rotate([], 3), []);
  let st = accrueSkipStreak(0, 2); assert.deepEqual(st, { streak: 1, alert: false });
  st = accrueSkipStreak(st.streak, 1); assert.deepEqual(st, { streak: 2, alert: false });
  st = accrueSkipStreak(st.streak, 3); assert.deepEqual(st, { streak: 3, alert: true });
  st = accrueSkipStreak(st.streak, 0); assert.deepEqual(st, { streak: 0, alert: false });
});

test('buy gas scales with ticket count and covers the measured 10-ticket cost', async () => {
  const { buyGasFor, GAS_PER_BUY } = await import('../src/safety.js');
  assert.ok(buyGasFor(10) > 6_406_350n * 12n / 10n, '10 tickets used 6.41M and hit the old 6.5M cap');
  assert.ok(buyGasFor(1) >= 1_170_000n, '1 ticket peaked at 1.17M');
  assert.ok(buyGasFor(5) >= 3_974_788n * 11n / 10n, '5 tickets peaked at 3.97M');
  assert.equal(buyGasFor(0), buyGasFor(1));
  assert.equal(buyGasFor(50), buyGasFor(10), 'never above the per-call maximum');
  assert.equal(GAS_PER_BUY, buyGasFor(10), 'the ETH reserve assumes the largest buy');
});
