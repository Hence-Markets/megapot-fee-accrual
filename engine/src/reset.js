// TEAM-TEST RESET - wipe a wallet's campaign state so the whitelist can walk
// the whole journey again. Returns the season pool counters it gave back so
// the shared pools stay honest. Never touches purchases (on-chain history) or
// other wallets. Pure: takes and returns the ledger object.
export function resetWallets(s, wallets, nowMs = Date.now()) {
  const out = { reset: [], packsReturned: 0, boxTicketsReturned: 0 };
  for (const raw of wallets) {
    const w = String(raw).trim().toLowerCase();
    const ws = s.wallets?.[w];
    if (!ws) continue;
    // give back the activation pack slot + pool tickets it consumed
    const packTix = (ws.firstTradeBonus?.tickets || 0) + (ws.bonusTicketsPending || 0);
    if (packTix > 0) {
      s.firstTradePoolUsed = Math.max(0, (s.firstTradePoolUsed || 0) - packTix);
      if (s.packSlots && s.packSlots[packTix] != null) s.packSlots[packTix] += 1;
      out.packsReturned += packTix;
    }
    const boxTix = Object.values(ws.boxes || {}).reduce((a, b) => a + (b?.tickets || 0), 0) + (ws.streakTicketsPending || 0);
    if (boxTix > 0) { s.streakBoxPoolUsed = Math.max(0, (s.streakBoxPoolUsed || 0) - boxTix); out.boxTicketsReturned += boxTix; }
    // fresh start from NOW: historical fills must not re-qualify the pack on the next cycle
    s.wallets[w] = { creditUsdc: 0, lastFillMs: nowMs, volumeUsd: 0, tickets: {} };
    out.reset.push(w);
  }
  return out;
}
