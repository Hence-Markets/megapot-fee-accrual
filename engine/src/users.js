// Per-USER accounting - PURE. The enrollment feed sends `user: 'u<id>'` per wallet; one
// account may link several wallets, and the activation pack, streak boxes and the
// 5/day + 15/week caps are per user, not per wallet (P0 economics: 10 linked wallets
// must not mean 10 packs). Whitelist mode carries no user key, so every wallet is its
// own user there - per-wallet behaviour is unchanged.

/** feed rows -> { wallets, emailBound, users } (users: wallet -> user key) */
export function parseRows(rows) {
  const wallets = [], emailBound = {}, users = {}, firstFill = {};
  for (const row of rows || []) {
    const obj = typeof row === 'object' && row !== null;
    const w = String(obj ? row.wallet : row).trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(w)) continue;      // malformed entries drop - never match
    if (wallets.includes(w)) continue;               // a wallet linked twice counts once
    wallets.push(w);
    emailBound[w] = obj ? !!(row.emailBound ?? row.email_bound) : false;   // a bare address proves nothing
    const u = obj ? String(row.user ?? row.user_id ?? '').trim() : '';
    if (u) users[w] = u;
    const ff = obj ? Number(row.firstFillMs ?? row.first_fill_ms) : 0;   // earliest reconciled venue fill, any time
    if (ff > 0) firstFill[w] = ff;
  }
  return { wallets, emailBound, users, firstFill };
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

/** one wallet's tickets today and in the rolling 7 days */
function countTickets(tickets, day, nowMs) {
  let dayCount = 0, week = 0;
  for (const [d, n] of Object.entries(tickets || {})) {
    if (d === day) dayCount += n;
    if (nowMs - new Date(d).getTime() < 7 * 86400000) week += n;
  }
  return { dayCount, week };
}

/** tickets minted today and in the rolling 7 days across the user's wallets */
export function userTicketCounts(s, w, day, nowMs = Date.now()) {
  let dayCount = 0, week = 0;
  for (const ww of userWallets(s, w)) {
    const c = countTickets(s.wallets?.[ww]?.tickets, day, nowMs);
    dayCount += c.dayCount; week += c.week;
  }
  return { dayCount, week };
}

/** how many more tickets this user may mint now under the day/week caps */
export function userCapLeft(s, w, day, caps, nowMs = Date.now()) {
  const { dayCount, week } = userTicketCounts(s, w, day, nowMs);
  return Math.max(0, Math.min(caps.perDay - dayCount, caps.perWeek - week));
}

/** cap room for the USER and for this wallet alone (may be negative). The status row uses
 *  it to say which binds: the wallet's own tickets, or a linked wallet's (status.js) */
export function userCapRoom(s, w, day, caps, nowMs = Date.now()) {
  const u = userTicketCounts(s, w, day, nowMs);
  const own = countTickets(s.wallets?.[w]?.tickets, day, nowMs);
  return { dayLeft: caps.perDay - u.dayCount, weekLeft: caps.perWeek - u.week, ownDayLeft: caps.perDay - own.dayCount, ownWeekLeft: caps.perWeek - own.week };
}

/** dates any wallet of the user already rolled a streak box for, and the count */
export function userBoxDates(s, w) {
  const dates = new Set();
  for (const ww of userWallets(s, w)) for (const d of Object.keys(s.wallets?.[ww]?.boxes || {})) dates.add(d);
  return dates;
}
