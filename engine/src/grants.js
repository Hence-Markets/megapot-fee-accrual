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
//   requires 'traded-between' -> a promo window: the wallet placed a qualifying fill with
//                         fromMs <= time <= toMs (accrue stamps ws.tradedWindow[g.id] per fill;
//                         a fill consumed before the grant existed counts via ws.lastFillMs).
//                         `wallets` restricts to a cohort (the email's recipients);
//                         `excludeWallets` drops named wallets (the risk cohort). Geo is not
//                         consulted: the feed already decided who is enrolled.
//                         `priorTraderOnly:true` limits it to wallets that already traded before
//                         the window opened (the "come back and trade tonight" email goes to
//                         existing traders; a brand-new wallet gets the activation pack instead).
//                         `maxUsers` caps how many DISTINCT wallets the grant can ever pay -
//                         checked last so a wallet filtered out for any other reason never eats
//                         a slot. The engine owns the counter (state.blanketUsers[id]) and bumps
//                         it only when it actually credits, so the cap holds across cycles.
const dayOf = (ms) => new Date(Number(ms) || 0).toISOString().slice(0, 10);

// "has this wallet traded before <ms>?" - deliberately permissive (any one signal is enough) so a
// returning trader is never denied by a gap in one source. Only a wallet whose FIRST ever trade
// lands inside the promo window itself fails every branch.
export function tradedBefore(ws, firstFillMs, beforeMs) {
  const ff = Number(firstFillMs) || 0;
  if (ff > 0 && ff < beforeMs) return true;                       // backend feed's reconciled first fill
  const days = Object.entries(ws?.days || {}).filter(([, v]) => Number(v) > 0).map(([d]) => d);
  if (days.some((d) => d < dayOf(beforeMs))) return true;         // a ledger trade-day before the window
  if (!days.length && (Number(ws?.volumeUsd) || 0) > 0) return true; // volume recorded before day-map pruning
  return false;
}

export function blanketGrantsDue(ws, grants, { vol = 0, today, firstFillMs = 0, wallet = '', nowMs = Date.now(), usedUsers = {} } = {}) {
  const out = [];
  const w = String(wallet || '').toLowerCase();
  for (const g of grants || []) {
    if (!g || !g.id || !(Number(g.usd) > 0)) continue;
    if (ws.opsGrants && ws.opsGrants[g.id]) continue;
    if (g.requires === 'traded-between') {
      const from = Number(g.fromMs) || 0, to = Number(g.toMs) || Infinity;
      if (Array.isArray(g.wallets) && g.wallets.length && !g.wallets.some((x) => String(x).toLowerCase() === w)) continue;
      if (Array.isArray(g.excludeWallets) && g.excludeWallets.some((x) => String(x).toLowerCase() === w)) continue;
      const stamped = !!(ws.tradedWindow && ws.tradedWindow[g.id]);
      const last = Number(ws.lastFillMs) || 0;
      if (!stamped && !(last >= from && last <= to)) continue;
      if (g.grantUntilMs && nowMs > Number(g.grantUntilMs)) continue;   // too late to mint for the draw
      if (g.priorTraderOnly && !tradedBefore(ws, firstFillMs, from)) continue;
      // cap check LAST: a wallet rejected above must not consume one of the slots
      if (Number(g.maxUsers) > 0 && (Number(usedUsers[g.id]) || 0) >= Number(g.maxUsers)) continue;
      out.push(g);
      continue;
    }
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
