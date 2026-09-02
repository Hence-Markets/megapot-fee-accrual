// Relay-spot fills → fee credit. PURE — the engine does the IO and applies the fold.
//
// Rows come from the hence backend's admin feed (serve.py /api/admin/spot-fills), shaped
// like Hyperliquid fills on purpose: `builderFee` is Hence's OWN app fee in USD (the 25bps
// slice Relay routes to the same wallet HL routes the builder fee to), `time` is epoch ms,
// `tid` is chain:txhash, `product` is the explicit literal 'spot'. The feed already emits
// only filled rows with the fee charged and the signer wallet known — and every one of
// those rules is RE-CHECKED here, because a feed bug must not mint tickets.
//
// Credit is the EXACT recorded fee × rolloverShare, not a bps-of-notional recompute: unlike
// Hyperliquid (where the engine reads the venue's feed and recomputes at FEE_BPS), the spot
// fee is first-party ground truth in Hence's own receipts ledger, and a recompute could
// only drift from what was actually charged. campaign.json documents this asymmetry.

/** One row's eligibility. Mirrors the HL grammar (window bounds, ZERO_FEE, SYMBOLS,
 *  fee-present) without touching isHenceFill — invariant 4 stays narrow; this feed carries
 *  its own guarantee and is re-verified anyway. */
export const qualifiesSpot = (f, cfg) => {
  if (!cfg.PRODUCTS.includes('spot')) return false;
  if (!f || f.product !== 'spot') return false;      // explicit — never the coin-prefix fallback,
                                                     // which reads a bare spot symbol as a PERP
  if (!(Number(f.builderFee || 0) > 0)) return false; // no fee charged → Hence earned nothing → no credit
  const t = Number(f.time || 0);
  if (!t || t < cfg.START_MS || (cfg.END_MS && t > cfg.END_MS)) return false;
  const sym = String(f.coin || '').toUpperCase();
  if (!sym || sym.includes(':')) return false;       // a spot coin is a bare symbol by hub law
  if (cfg.ZERO_FEE.includes(sym)) return false;
  if (cfg.SYMBOLS.length && !cfg.SYMBOLS.includes(sym)) return false;
  return true;
};

/** Fold one wallet's feed rows into {vol, credit, days, maxFillUsd, lastSpotFillMs, count}.
 *  Strictly-after `lastSpotFillMs` — the per-wallet checkpoint is invariant 2's spot twin:
 *  a replayed feed page must never credit a fill twice. An unpriced fill (no usd, no px*sz)
 *  contributes NOTHING — not zero-volume credit, not a streak day; its fee is still real
 *  but a volume ledger must never book a notional it does not know. */
export function foldSpotFills(rows, lastSpotFillMs, cfg) {
  // `floor` is the checkpoint FROZEN at entry: comparing against the advancing `last`
  // instead would drop the second of two same-millisecond fills inside one batch
  const floor = Number(lastSpotFillMs || cfg.START_MS);
  let vol = 0, credit = 0, maxFillUsd = 0, count = 0;
  let last = floor;
  const days = {};
  for (const f of rows || []) {
    if (!qualifiesSpot(f, cfg)) continue;
    const t = Number(f.time);
    if (t <= floor) continue;
    const notional = Number(f.usd) > 0 ? Number(f.usd)
      : (Number(f.px) > 0 && Number(f.sz) > 0 ? Number(f.px) * Number(f.sz) : 0);
    if (!(notional > 0)) continue;
    vol += notional;
    credit += Number(f.builderFee) * cfg.ROLLOVER;
    maxFillUsd = Math.max(maxFillUsd, notional);
    const d = new Date(t).toISOString().slice(0, 10);
    days[d] = (days[d] || 0) + notional;
    last = Math.max(last, t);
    count++;
  }
  return { vol, credit, days, maxFillUsd, lastSpotFillMs: last, count };
}
