// STREAK BOX - one surprise box per distinct trade day across the campaign.
//
// Day N = the wallet's Nth distinct qualifying trade day since campaign
// start (not per calendar week). Each day rolls ONE box against the matrix:
// heavy hit-rate on day 2 (the habit hook), a hit-rate that keeps falling
// after that, and a ticket size that keeps rising - so the rare late boxes
// are the big ones and only wallets that keep showing up past day 10 see
// the 4-8 ticket boxes.
//
// Pure: the caller supplies the RNG so the ledger replay and the tests are
// deterministic. `roll` returns { day, p, size, won, tickets }.

/** @type {{day:number,p:number,size:number}[]} */
export const STREAK_BOX_MATRIX = [
  { day: 1,  p: 0.15, size: 1 },   // day 1 already carries the activation pack
  { day: 2,  p: 0.60, size: 1 },   // the hook: most people who come back twice win
  { day: 3,  p: 0.45, size: 1 },
  { day: 4,  p: 0.35, size: 1 },
  { day: 5,  p: 0.30, size: 2 },
  { day: 6,  p: 0.25, size: 2 },
  { day: 7,  p: 0.22, size: 2 },
  { day: 8,  p: 0.20, size: 3 },
  { day: 9,  p: 0.18, size: 3 },
  { day: 10, p: 0.16, size: 3 },
  { day: 11, p: 0.15, size: 4 },
  { day: 12, p: 0.14, size: 5 },
  { day: 13, p: 0.13, size: 6 },
  { day: 14, p: 0.12, size: 8 },
];

export function boxFor(day, matrix = STREAK_BOX_MATRIX) {
  if (!Number.isInteger(day) || day < 1) return null;
  return matrix[Math.min(day, matrix.length) - 1];
}

/** roll one box. rng() must return a float in [0,1). */
export function rollStreakBox(day, rng, matrix = STREAK_BOX_MATRIX) {
  const b = boxFor(day, matrix);
  if (!b) return null;
  const won = rng() < b.p;
  return { day: b.day, p: b.p, size: b.size, won, tickets: won ? b.size : 0 };
}

/** expected tickets for a wallet that trades exactly `days` distinct days */
export function expectedTickets(days, matrix = STREAK_BOX_MATRIX) {
  let ev = 0;
  for (let d = 1; d <= days; d++) { const b = boxFor(d, matrix); ev += b.p * b.size; }
  return ev;
}

/** the printed matrix + cumulative EV - what the rules page and ops read */
export function matrixTable(matrix = STREAK_BOX_MATRIX) {
  let cum = 0;
  return matrix.map((b) => { cum += b.p * b.size; return { ...b, ev: +(b.p * b.size).toFixed(2), cumEv: +cum.toFixed(2) }; });
}
