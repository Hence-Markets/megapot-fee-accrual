// ── Campaign parameters ─────────────────────────────────────────────────────
// Per the Reward Hub spec (v3/v4) and the Hence feature-gates doc:
//  - START_MS is NOT optional: without it every historical fill becomes
//    eligible the moment the engine turns on. Set it before ACTIVE.
//  - DRY_RUN=1 runs the full accrue→cap→select machine without touching
//    the wire. Rehearse with it before every real run.
//  - Gate semantics follow the Hence feature-gates doc EXACTLY (cohesive
//    with serve.py's campaign conventions, pre- and post-production):
//      MEGAPOT_ACTIVE=1 + non-empty MEGAPOT_WHITELIST -> PRE-PRODUCTION:
//        only the whitelisted team wallets accrue/buy. Any public flag
//        downstream must stay false in this mode (honesty rule:
//        active AND NOT whitelist) - testers learn through their own
//        authenticated surface, never the public config.
//      MEGAPOT_ACTIVE=1 + EMPTY whitelist -> POST-PRODUCTION (open):
//        empty is the documented signal for "campaign open to all" -
//        the eligible set becomes the FULL enrolled-user feed
//        (USERS_FILE standalone; the hence_users DB once stitched).
//      To pause: MEGAPOT_ACTIVE=0. Clearing the whitelist does the
//        exact opposite of pausing (it opens the campaign to everyone).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// campaign controller — product parameters live in campaign.json (repo root);
// env keeps the security gates and secrets. CAMPAIGN_FILE overrides the path.
const _dir = path.dirname(fileURLToPath(import.meta.url));
const _campaignPath = process.env.CAMPAIGN_FILE || path.join(_dir, '../../campaign.json');
export const campaign = JSON.parse(fs.readFileSync(_campaignPath, 'utf8'));

export const cfg = {
  DRY_RUN: process.env.DRY_RUN !== '0',            // safe by default: real buys need DRY_RUN=0
  START_MS: Number(process.env.START_MS || campaign.campaign.startMs || 0), // env overrides the sheet
  END_MS: Number(process.env.END_MS || campaign.campaign.endMs || 0),
  FEE_BPS: Number(process.env.FEE_BPS || campaign.economics.feeBps || 4.5),
  ROLLOVER: Number(process.env.ROLLOVER || campaign.economics.rolloverShare || 1.0),

  ACTIVE: process.env.MEGAPOT_ACTIVE === '1',
  // pre-production cohort. parse_whitelist semantics from users_store.py:
  // lowercase, strict 42-char 0x address, malformed entries silently dropped
  // (a typo removes that person - it never matches nothing or everything).
  WHITELIST: (process.env.MEGAPOT_WHITELIST || '').split(',').map((w) => w.trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)),
  // open-mode user feed: JSON array of wallets. Standalone stand-in for the
  // hence_users enrollment pull; required before the whitelist may be emptied.
  USERS_FILE: process.env.USERS_FILE || '',

  // qualifying symbols (allowlist per spec; empty = all symbols qualify in test mode)
  SYMBOLS: (process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : (campaign.eligibility.symbols || [])).map((s) => String(s).trim().toUpperCase()).filter(Boolean),
  PRODUCTS: campaign.eligibility.products || ['perps'],
  ZERO_FEE: (campaign.eligibility.excludeZeroFeePairs || []).map((s) => String(s).toUpperCase()),

  // caps — belt and braces even though spend ≤ credit by construction
  MAX_TICKETS_PER_WALLET_PER_DAY: Number(process.env.MAX_TICKETS_PER_WALLET_PER_DAY || campaign.caps.ticketsPerWalletPerDay || 5),
  MAX_TICKETS_PER_WALLET_PER_WEEK: Number(campaign.caps.ticketsPerWalletPerWeek || 15),
  GLOBAL_BUDGET_USDC: Number(process.env.GLOBAL_BUDGET_USDC || campaign.caps.globalBudgetUsdc || 50),

  // Hyperliquid public info API (venue-authoritative fills; no key needed)
  HL_INFO: 'https://api.hyperliquid.xyz/info',

  // Megapot on Base — testnet by default; TARGET=mainnet flips
  TARGET: process.env.TARGET || campaign.campaign.network || 'testnet',
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

  FIRST_TRADE: campaign.firstTradeBonus || null,     // new-user unlock (null disables)
  STREAK: campaign.streak || null,                    // day-3/day-5 checkpoint grants (null disables)
  OPS_GRANTS: campaign.opsGrants || [],               // one-time config-driven credit grants (compensations, smoke tests)

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
