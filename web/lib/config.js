// Base Sepolia (84532) — llms.megapot.io/contracts/reference, 2026-08-14
export const CHAIN_ID = 84532;
export const RPC = 'https://sepolia.base.org';
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
export const SEALED_CALLER = process.env.NEXT_PUBLIC_SEALED_CALLER || '';

export const jackpotAbi = [
  { type: 'function', name: 'currentDrawingId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ticketPrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getDrawingState', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: [
    { name: 'prizePool', type: 'uint256' }, { name: 'ticketPrice', type: 'uint256' }, { name: 'edgePerTicket', type: 'uint256' },
    { name: 'referralWinShare', type: 'uint256' }, { name: 'referralFee', type: 'uint256' }, { name: 'globalTicketsBought', type: 'uint256' },
    { name: 'lpEarnings', type: 'uint256' }, { name: 'drawingTime', type: 'uint256' }, { name: 'winningTicket', type: 'uint256' },
    { name: 'ballMax', type: 'uint8' }, { name: 'bonusballMax', type: 'uint8' }, { name: 'payoutCalculator', type: 'address' }, { name: 'jackpotLock', type: 'bool' } ] }] },
];

export const usdcAbi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export const sealedCallerAbi = [
  { type: 'function', name: 'entryFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'commitGuess', stateMutability: 'nonpayable', inputs: [{ name: 'ciphertext', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'rounds', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
    { name: 'sidePot', type: 'uint256' }, { name: 'settledAt', type: 'uint256' }, { name: 'winningBonusball', type: 'uint8' },
    { name: 'winnerCount', type: 'uint256' }, { name: 'payoutPerWinner', type: 'uint256' } ] },
  { type: 'function', name: 'playersOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'guessHandleOf', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bytes32' }] },
];
