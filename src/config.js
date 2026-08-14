// ── Campaign parameters ─────────────────────────────────────────────────────
// Per the Reward Hub spec (v3/v4) and the Hence feature-gates doc:
//  - START_MS is NOT optional: without it every historical fill becomes
//    eligible the moment the engine turns on. Set it before ACTIVE.
//  - DRY_RUN=1 runs the full accrue→cap→select machine without touching
//    the wire. Rehearse with it before every real run.
//  - An EMPTY wallet list means NOBODY (unlike the serve.py whitelist
//    convention where empty = everyone). This engine only ever acts on
//    explicitly enrolled wallets.

export const cfg = {
  DRY_RUN: process.env.DRY_RUN !== '0',            // safe by default: real buys need DRY_RUN=0
  START_MS: Number(process.env.START_MS || 0),      // campaign start — refuse to run if 0
  FEE_BPS: Number(process.env.FEE_BPS || 4.5),      // Hence builder fee, bps of notional
  ROLLOVER: Number(process.env.ROLLOVER || 1.0),    // share of fee credited (1.0 = 100% per spec v3)

  // enrolled trader wallets (the test cohort). Explicit list, lowercase.
  WALLETS: (process.env.WALLETS || '').split(',').map((w) => w.trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)),

  // qualifying symbols (allowlist per spec; empty = all symbols qualify in test mode)
  SYMBOLS: (process.env.SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

  // caps — belt and braces even though spend ≤ credit by construction
  MAX_TICKETS_PER_WALLET_PER_DAY: Number(process.env.MAX_TICKETS_PER_WALLET_PER_DAY || 5),
  GLOBAL_BUDGET_USDC: Number(process.env.GLOBAL_BUDGET_USDC || 50), // engine halts when lifetime spend reaches this

  // Hyperliquid public info API (venue-authoritative fills; no key needed)
  HL_INFO: 'https://api.hyperliquid.xyz/info',

  // Megapot on Base — testnet by default; TARGET=mainnet flips
  TARGET: process.env.TARGET || 'testnet',
  nets: {
    testnet: {
      rpc: process.env.RPC || 'https://sepolia.base.org',
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      jackpot: '0x465dA3c859f193A3807386387bEE941B2A4c3279',
      randomBuyer: '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746',
    },
    mainnet: {
      rpc: process.env.RPC || 'https://mainnet.base.org',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      jackpot: '0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2',
      randomBuyer: '0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd',
    },
  },

  TREASURY: (process.env.TREASURY || '').toLowerCase(), // Megapot referrer — referral fees recycle
  PRIVATE_KEY: process.env.PRIVATE_KEY || '',           // pool hot wallet (capped)
  SOURCE_TAG: 'hence-fee-accrual',
};

export const net = () => cfg.nets[cfg.TARGET];

export const jackpotAbi = [
  { type: 'function', name: 'ticketPrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'currentDrawingId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
export const buyerAbi = [
  { type: 'function', name: 'buyTickets', stateMutability: 'nonpayable', inputs: [
    { type: 'uint256' }, { type: 'address' }, { type: 'address[]' }, { type: 'uint256[]' }, { type: 'bytes32' }], outputs: [] },
];
export const erc20Abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
