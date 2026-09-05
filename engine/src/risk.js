// Risk cohort - PURE. Suspected farm accounts (listed wallets, or any wallet whose feed
// country is listed) get ROI-positive treatment instead of a ban:
//   - first mint needs `firstTradeMinUsd` of qualifying volume (default cohort: $2,000)
//   - free tickets (streak boxes/checkpoints, blanket grants) only convert once Hence's
//     fees earned from the wallet cover `roiMultiple` x every free ticket it already got
//     (activation packs included). Fee credit buys are untouched - they self-fund.
// Named ops grants stay operator intent and are never gated.

/** the cohort rules for a wallet, or null when it is not in the cohort */
export function riskRulesFor(risk, wallet, country) {
  if (!risk) return null;
  const w = String(wallet || '').toLowerCase();
  const inList = (risk.wallets || []).some((x) => String(x).toLowerCase() === w);
  const cc = String(country || '').toUpperCase();
  const inGeo = !!cc && (risk.countries || []).some((x) => String(x).toUpperCase() === cc);
  if (!inList && !inGeo) return null;
  return { firstTradeMinUsd: Number(risk.firstTradeMinUsd) || 0, roiMultiple: Number(risk.roiMultiple) || 1, via: inList ? 'wallet' : 'country' };
}

/** how many free tickets the fees earned so far still cover */
export function roiRoomTickets(ws, rules, priceUsd) {
  const price = Number(priceUsd) || 1;
  const fees = Number(ws?.feesUsd) || 0;
  const free = Number(ws?.roiFreeUsd) || 0;
  const room = fees / (Number(rules?.roiMultiple) || 1) - free;
  return Math.max(0, Math.floor(room / price + 1e-9));
}

/** record free value handed to the wallet (every wallet keeps this ledger; only cohort wallets are gated on it) */
export function noteFree(ws, tickets, priceUsd) {
  ws.roiFreeUsd = (Number(ws.roiFreeUsd) || 0) + (Number(tickets) || 0) * (Number(priceUsd) || 1);
}

/** one-line explanation for the log */
export const roiLine = (ws, rules) => `fees $${(Number(ws?.feesUsd) || 0).toFixed(2)} vs ${rules.roiMultiple}x free $${(Number(ws?.roiFreeUsd) || 0).toFixed(2)}`;
