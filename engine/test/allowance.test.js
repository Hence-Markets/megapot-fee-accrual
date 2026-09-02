import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planApproval, STANDING_TICKETS } from '../src/allowance.js';

test('no approval while the standing allowance covers the buy', () => {
  assert.equal(planApproval(5_000_000n, 1_000_000n, 1_000_000n), null);
  assert.equal(planApproval(1_000_000n, 1_000_000n, 1_000_000n), null);
});
test('a short allowance is topped up to the standing size, never just the exact cost', () => {
  assert.equal(planApproval(0n, 1_000_000n, 1_000_000n), 1_000_000n * STANDING_TICKETS);
  assert.equal(planApproval(500_000n, 3_000_000n, 1_000_000n), 1_000_000n * STANDING_TICKETS);
  // a single buy bigger than the standing size still gets covered
  assert.equal(planApproval(0n, 2_000_000_000n, 1_000_000n), 2_000_000_000n);
});
