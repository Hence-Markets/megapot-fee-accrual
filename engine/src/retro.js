// Retro ticket allocation - PURE. The pool wallet holds Megapot's daily 12 tickets
// as ERC-721s; the engine hands those out BEFORE spending USDC. tokenId == the
// venue API's user_ticket_id. Inventory is the ACTIVE round only: a ticket for a
// settled round is a receipt, not a draw entry.

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
