// Sign locally so the tx hash is known - and on disk - BEFORE the broadcast.
// A lost RPC response after sendRawTransaction then leaves a record to reconcile
// against instead of a second buy for the same credit.
import { keccak256, encodeFunctionData } from 'viem';

export async function signPinned(account, chainId, { to, abi, functionName, args, gas, maxFeePerGas, maxPriorityFeePerGas, nonce }) {
  const data = encodeFunctionData({ abi, functionName, args });
  const tx = { type: 'eip1559', chainId, to, data, gas, maxFeePerGas, maxPriorityFeePerGas, nonce, value: 0n };
  const serialized = await account.signTransaction(tx);
  return { serialized, hash: keccak256(serialized), nonce };
}
