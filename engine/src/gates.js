// Season-wide daily gates: "N tickets of this kind per UTC day across all
// users". Pure; the ledger carries {day, used} per gate key. Anything over
// the gate waits on the wallet's pending counter and drains next day - a
// grant is never lost, only paced.
export function takeFromDailyGate(s, key, cap, day, want) {
  if (!cap || cap <= 0) return want;
  const g = (s.gates ??= {})[key] ??= { day, used: 0 };
  if (g.day !== day) { g.day = day; g.used = 0; }
  const room = Math.max(0, cap - g.used);
  const take = Math.min(want, room);
  g.used += take;
  return take;
}
