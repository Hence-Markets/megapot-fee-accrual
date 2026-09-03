// Blanket grants: one-time credit for every wallet that meets a campaign-wide condition, as
// opposed to opsGrants which name a wallet. Season 1 use: "+2 tickets to everyone who traded
// on Hence up to <date>" after the 2026-09-03 enrollment-feed regression. Pure decision helper
// so the money path stays testable without a ledger or RPC.
//
// campaign.blanketGrants: [{ id, usd, requires: 'traded', beforeDate: 'YYYY-MM-DD' }]
//   requires 'traded'  -> the wallet has qualifying in-window volume (fee-bearing fills)
//   beforeDate         -> only wallets whose FIRST recorded trade day is on/before this UTC
//                         date (a cohort snapshot, not a standing activation bonus); omit for
//                         an open-ended grant.
//   requires 'venue-traded' -> the backend feed reports a reconciled venue fill for the wallet
//                         (firstFillMs, ANY time - before the campaign too). beforeMs bounds the
//                         first fill; onlyWithoutSeasonVolume:true skips wallets that already have
//                         in-window volume (so a 'pre-season traders' grant does not stack on a
//                         'season traders' grant).
export function blanketGrantsDue(ws, grants, { vol = 0, today, firstFillMs = 0 } = {}) {
  const out = [];
  for (const g of grants || []) {
    if (!g || !g.id || !(Number(g.usd) > 0)) continue;
    if (ws.opsGrants && ws.opsGrants[g.id]) continue;
    const total = (Number(ws.volumeUsd) || 0) + (Number(vol) || 0);
    if (g.requires === 'venue-traded') {
      const ff = Number(firstFillMs) || 0;
      if (!(ff > 0)) continue;
      if (g.beforeMs && ff >= Number(g.beforeMs)) continue;
      if (g.onlyWithoutSeasonVolume && total > 0) continue;
      out.push(g);
      continue;
    }
    if ((g.requires || 'traded') !== 'traded') continue;
    if (!(total > 0)) continue;
    if (g.beforeDate) {
      const days = Object.entries(ws.days || {}).filter(([, v]) => Number(v) > 0).map(([d]) => d);
      if (vol > 0 && today) days.push(today);
      if (days.length) {
        const first = days.sort()[0];
        if (first > String(g.beforeDate)) continue;
      } else if (!((Number(ws.volumeUsd) || 0) > 0)) {
        continue;
      }
      // no day map but volume on the ledger: the volume was recorded by an earlier cycle (older
      // build or pruned >14d), i.e. strictly before now - it can only be outside a cutoff that is
      // itself in the past by more than the pruning window, which no live grant uses. 2026-09-03:
      // 2 of the 5 Season 1 traders had volume but no `days` and were skipped.
    }
    out.push(g);
  }
  return out;
}
