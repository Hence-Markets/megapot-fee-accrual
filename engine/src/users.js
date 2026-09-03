// Per-USER accounting - PURE. The enrollment feed sends `user: 'u<id>'` per wallet; one
// account may link several wallets, and the activation pack, streak boxes and the
// 5/day + 15/week caps are per user, not per wallet (P0 economics: 10 linked wallets
// must not mean 10 packs). Whitelist mode carries no user key, so every wallet is its
// own user there - per-wallet behaviour is unchanged.

/** feed rows -> { wallets, emailBound, users } (users: wallet -> user key) */
export function parseRows(rows) {
  const wallets = [], emailBound = {}, users = {};
  for (const row of rows || []) {
    const obj = typeof row === 'object' && row !== null;
    const w = String(obj ? row.wallet : row).trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(w)) continue;      // malformed entries drop - never match
    if (wallets.includes(w)) continue;               // a wallet linked twice counts once
    wallets.push(w);
    emailBound[w] = obj ? !!(row.emailBound ?? row.email_bound) : false;   // a bare address proves nothing
    const u = obj ? String(row.user ?? row.user_id ?? '').trim() : '';
    if (u) users[w] = u;
  }
  return { wallets, emailBound, users };
}

/** every wallet the ledger knows for `w`'s user (always includes `w`) */
export function userWallets(s, w) {
  const u = s?.users?.[w];
  if (!u) return [w];
  const out = Object.entries(s.users).filter(([, uu]) => uu === u).map(([ww]) => ww);
  if (!out.includes(w)) out.push(w);
  return out;
}

const packOf = (ws) => !!(ws && (ws.packGranted || ws.firstTradeBonus || ws.bonusTicketsPending));

/** activation pack already granted to ANY wallet of this user */
export function userPackGranted(s, w) {
  return userWallets(s, w).some((ww) => packOf(s.wallets?.[ww]));
}

/** tickets minted today and in the rolling 7 days across the user's wallets */
export function userTicketCounts(s, w, day, nowMs = Date.now()) {
  let dayCount = 0, week = 0;
  for (const ww of userWallets(s, w)) {
    const t = s.wallets?.[ww]?.tickets || {};
    for (const [d, n] of Object.entries(t)) {
      if (d === day) dayCount += n;
      if (nowMs - new Date(d).getTime() < 7 * 86400000) week += n;
    }
  }
  return { dayCount, week };
}

/** how many more tickets this user may mint now under the day/week caps */
export function userCapLeft(s, w, day, caps, nowMs = Date.now()) {
  const { dayCount, week } = userTicketCounts(s, w, day, nowMs);
  return Math.max(0, Math.min(caps.perDay - dayCount, caps.perWeek - week));
}

/** dates any wallet of the user already rolled a streak box for, and the count */
export function userBoxDates(s, w) {
  const dates = new Set();
  for (const ww of userWallets(s, w)) for (const d of Object.keys(s.wallets?.[ww]?.boxes || {})) dates.add(d);
  return dates;
}
