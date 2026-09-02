// Standing USDC allowance for the ticket buyer. Mainnet 2026-09-02: per-buy
// approve(exact) followed by buyTickets reverted ~20% of the time with
// "ERC20: transfer amount exceeds allowance" (txs 0x7c39c5f8..., 0xb0774a51...)
// - the buy landed before the fresh approval was visible to the node that
// executed it. One large approval, topped up only when it runs low, removes
// the per-buy approve->buy pair the race lives in. Pure helpers, tested.
export const STANDING_TICKETS = 1000n;                 // one approval covers ~1000 tickets

/** approve when the allowance cannot cover this buy; approve enough for many */
export function planApproval(allowance, cost, price) {
  if (allowance >= cost) return null;
  return price * STANDING_TICKETS > cost ? price * STANDING_TICKETS : cost;
}
