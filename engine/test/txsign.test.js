import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, keccak256 } from 'viem';
import { signPinned } from '../src/txsign.js';
import { buyerAbi } from '../src/config.js';

test('locally signed buy: hash known before broadcast, nonce and fee fields pinned', async () => {
  const account = privateKeyToAccount('0x' + '11'.repeat(32));          // throwaway test key
  const args = [2n, '0x' + 'a'.repeat(40), [], [], '0x' + '0'.repeat(64)];
  const r = await signPinned(account, 8453, { to: '0x' + 'b'.repeat(40), abi: buyerAbi, functionName: 'buyTickets', args, gas: 6_500_000n, maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 500_000n, nonce: 42 });
  assert.equal(r.nonce, 42);
  assert.equal(r.hash, keccak256(r.serialized));
  const tx = parseTransaction(r.serialized);
  assert.equal(tx.nonce, 42); assert.equal(tx.chainId, 8453); assert.equal(tx.gas, 6_500_000n);
  assert.equal(tx.maxFeePerGas, 12_000_000n); assert.equal(tx.to, '0x' + 'b'.repeat(40));
  const again = await signPinned(account, 8453, { to: '0x' + 'b'.repeat(40), abi: buyerAbi, functionName: 'buyTickets', args, gas: 6_500_000n, maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 500_000n, nonce: 42 });
  assert.equal(again.hash, r.hash, 'deterministic: the same intent re-signs to the same hash');
});
