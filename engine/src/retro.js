// Retro ticket allocation - PURE. The pool wallet holds Megapot's daily 12 tickets
// as ERC-721s; the engine hands those out BEFORE spending USDC. tokenId == the
// venue API's user_ticket_id. Inventory is the ACTIVE round only: a ticket for a
// settled round is a receipt, not a draw entry.
import { usdOf } from './lifecycle.js';

/** venue rows for the pool wallet -> tokenIds usable as inventory this cycle */
export function filterInventory(rows, { activeRound, pool }) {
  const out = [];
  const poolL = String(pool || '').toLowerCase();
  for (const t of rows || []) {
    if (String(t?.round_id ?? '') !== String(activeRound ?? '')) continue;
    if (t.claimed === true) continue;
    if (t.winnings_amount != null && Number(typeof t.winnings_amount === 'object' ? t.winnings_amount.amount : t.winnings_amount) > 0) continue;
    if (poolL && t.wallet && String(t.wallet).toLowerCase() !== poolL) continue;
    const id = String(t.user_ticket_id ?? '');
    if (!/^\d+$/.test(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** how many of a wallet's `count` owed tickets come from inventory, and which */
export function allocateRetro(count, inventory) {
  const n = Math.max(0, Math.min(Number(count) || 0, inventory.length));
  return { tokenIds: inventory.slice(0, n), usdcCount: Math.max(0, (Number(count) || 0) - n) };
}

/** the grant report the hub reads to label a retro ticket */
export const grantBody = ({ wallet, tokenId, round, tx, ts = Date.now() }) => ({ wallet, tokenId: String(tokenId), round: String(round ?? ''), tx, kind: 'retro', ts });

// ── transferred-ticket wins ────────────────────────────────────────────────────
// The venue API files a ticket under its ORIGINAL recipient for good: a pool ticket the
// retro path handed to a user (transferFrom) keeps showing under the pool wallet, with its
// winnings_amount / claimed after the draw, and never under the user. The win sweep reads
// the pool's rows once, resolves ownerOf for every winner in one multicall and hands each
// win to the wallet that holds the ticket. A claim BURNS the ticket (ownerOf reverts), so a
// burned winner is a claimed one; who claimed it comes from the ledger's transfer records.

const numericId = (t) => { const id = String(t?.user_ticket_id ?? ''); return /^\d+$/.test(id) ? id : ''; };

/** tokenId -> {wallet, tx?, ts?} for every ticket the ledger says the pool handed out:
 *  kind:'retro' purchases (pruned after 7 days once verified) and, after that, the win
 *  markers a previous sweep already stamped on the receiving wallet (cioWins) */
export function transfersFromLedger(s) {
  const out = {};
  for (const [w, ws] of Object.entries(s?.wallets || {})) {
    for (const id of Object.keys(ws?.cioWins || {})) if (/^\d+$/.test(id)) out[id] = { wallet: String(w).toLowerCase() };
  }
  for (const p of s?.purchases || []) {
    if (p?.kind !== 'retro' || p.refunded || p.tokenId == null || !p.wallet) continue;
    out[String(p.tokenId)] = { wallet: String(p.wallet).toLowerCase(), ...(p.tx ? { tx: p.tx } : {}), ...(p.ts ? { ts: p.ts } : {}) };
  }
  return out;
}

/** PURE attribution of the pool wallet's winning rows.
 *  `owners`: tokenId -> on-chain ownerOf (address) | null when ownerOf reverted (burned);
 *            a tokenId absent from the map was not read this sweep and is skipped.
 *  `ledgerWallets`: the enrolled wallets (any case). `pool`: the pool wallet address.
 *  `transfers`: transfersFromLedger(s) - names the wallet behind a burned ticket.
 *  Returns [{wallet, row}] with row = the pool row re-homed: `_wallet` = the user,
 *  `claimed` true when burned (never downgraded), `_source:'retro'`, `_tx`/`_ts` when the
 *  ledger knows the transfer. The pool's own wins are left alone; a ticket owned by an
 *  address that is not enrolled (or burned with no transfer record) goes to onUnknown. */
export function attributeTransferredWins(poolRows, owners, ledgerWallets, { pool = '', transfers = {}, onUnknown = () => {} } = {}) {
  const poolL = String(pool || '').toLowerCase();
  const enrolled = new Set([...(ledgerWallets || [])].map((w) => String(w).toLowerCase()));
  const out = [], seen = new Set();
  for (const t of poolRows || []) {
    const id = numericId(t);
    if (!id || seen.has(id) || !(usdOf(t) > 0)) continue;
    if (!owners || !(id in owners)) continue;                      // not resolved this sweep
    seen.add(id);
    const owner = owners[id] == null ? null : String(owners[id]).toLowerCase();
    const burned = owner === null;
    const rec = transfers?.[id];
    const wallet = burned ? (rec?.wallet || '') : owner;
    if (!burned && wallet === poolL) continue;                     // the pool's own win
    if (!wallet || !enrolled.has(wallet)) { onUnknown(id, owner, t); continue; }
    // the chain names a live ticket's holder; the ledger's record only adds the transfer tx/ts
    const known = rec && rec.wallet === wallet ? rec : null;
    const row = { ...t, _wallet: wallet, _source: 'retro', claimed: burned || t.claimed === true, ...(burned ? { claimedOnChain: true } : {}),
      ...(known?.tx ? { _tx: known.tx } : {}), ...(known?.ts ? { _ts: known.ts } : {}) };
    out.push({ wallet, row });
  }
  return out;
}

/** the hash the venue reports for a claim, if it reports one */
export const claimTxOf = (t) => t?.claim_tx_hash ?? t?.claimed_tx_hash ?? t?.claim_tx ?? t?.claimTx ?? undefined;

/** the grant upsert (keyed on tokenId backend-side) that carries a transferred ticket's win:
 *  tx/ts stay as the original grant sent them when the ledger still knows them, else omitted */
export const winGrantBody = ({ wallet, tokenId, round, tx, ts, winningsUsd, claimed, claimedTx, settledAt = Date.now() }) => ({
  wallet, tokenId: String(tokenId), round: String(round ?? ''), kind: 'retro',
  ...(tx ? { tx } : {}), ...(ts ? { ts } : {}),
  winningsUsd: +Number(winningsUsd || 0).toFixed(6), claimed: claimed === true,
  ...(claimedTx ? { claimedTx: String(claimedTx) } : {}), settledAt,
});
