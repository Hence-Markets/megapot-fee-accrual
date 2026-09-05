// Multiplier subsidy - PURE. The kicker is the EXTRA credit above the base fee rebate.
// It is capped per USER (all linked wallets) at `perUserUsd`; past the cap the wallet keeps
// its tier but mints at base rate ($1 of ticket per $1 of fee, uncapped).
export function perUserBonusLeft(s, wallets, perUserUsd) {
  const cap = Number(perUserUsd) || 0;
  if (!(cap > 0)) return Infinity;
  let used = 0;
  for (const w of wallets || []) used += Number(s?.wallets?.[w]?.multBonusUsd) || 0;
  return Math.max(0, cap - used);
}
