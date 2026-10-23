# megapot-fee-accrual

**The fee-accrual leg from the [Hence × Megapot Reward Hub spec](https://app.notion.com/p/3bb8bcd7d5c381e5b4fbcd5e4fd43863), standalone.**

Hence trading fees roll back into Megapot tickets, minted directly to the trader's own wallet. No app integration — this engine reads venue-authoritative fills from Hyperliquid's public API, accrues fee credit per enrolled wallet, and converts credit into real Megapot tickets on Base. Non-custodial: tickets and winnings belong to the trader from mint.

```
enrolled wallets ──> accrue: HL userFillsByTime since checkpoint
                        × symbol allowlist × 4.5bps × rollover share
                        → per-wallet USDC credit  (state/ledger.json)
                 ──> buy: credit ≥ live ticketPrice()
                        → JackpotRandomTicketBuyer.buyTickets(n, TRADER, [treasury], [1e18], tag)
                        → ticket NFTs mint to the TRADER's wallet
```

## The invariant

Per-wallet spend never exceeds per-wallet accrued fee credit (spec v3). Plus hard caps on top: per-wallet daily ticket cap, global lifetime budget, and the buyer's 10-tickets-per-call limit.

## Safety rails (per the Hence feature-gates doc)

- **`START_MS` is required** — without a campaign start, every historical fill becomes eligible the moment you switch on. The engine refuses to run without it.
- **`DRY_RUN=1` is the default** — full accrue → cap → select machinery, prints what it *would* buy, moves nothing. `DRY_RUN=0` for live.
- **Gate semantics match serve.py exactly** (pre/post-production cohesive): `MEGAPOT_ACTIVE=1` + non-empty `MEGAPOT_WHITELIST` = pre-production team cohort, and any downstream public flag stays false (honesty rule: `active AND NOT whitelist`). `MEGAPOT_ACTIVE=1` + **empty whitelist = open to ALL** enrolled users (`USERS_FILE` standalone; the `hence_users` DB once stitched) — the engine refuses open mode without a user feed. **To pause: `MEGAPOT_ACTIVE=0`** — clearing the whitelist is the opposite of pausing.
- The pool key is a capped hot wallet; `GLOBAL_BUDGET_USDC` halts the engine regardless of credit.

## Run

```bash
npm install
cp .env.example .env   # set START_MS, WALLETS; keys only for live mode
set -a; source .env; set +a
npm run accrue          # fills → credit
npm run buy             # credit → tickets (DRY_RUN prints, no funds move)
node src/run.js cycle   # both
npm run status          # ledger dump
```

Cron it (e.g. hourly accrue, daily buy before Megapot's cutoff) for continuous operation.

## Deposit-offer lane (Prizerail deposit A/B, prize arm)

`src/depositOffer.js` (pure, tested in `test/depositOffer.test.js`) + `depositOfferLane()` in `engine.js`.
Each new Hence account in the A/B's **prize** arm that qualifies (first deposit of $15+) gets **one**
Megapot ticket, minted with USDC to its own wallet. The lane then reports the mint to the app, and the
app flips the reward row to `issued`.

```
GET  <app>/api/admin/deposit-offer/rewards?variant=prize&status=owed&due=1   (Bearer USERS_TOKEN)
  -> per owed row: validate wallet, skip if the ledger has it, check both budgets
  -> simulate, sign (pinned nonce), write intent, broadcast   randomBuyer.buyTickets(1, wallet, [TREASURY], [1e18], tag)
  -> receipt: tokenId = TicketNFT Transfer(0x0 -> wallet, tokenId)
  -> outbox '$grant' POST <app>/api/admin/megapot/grants {wallet, tokenId, round, tx, kind:'deposit-offer', drawAt, ts}
  -> ledger entry 'issued' (same save as the queued grant)
```

- **Step:** `node src/run.js deposit-offer`. It runs after `buy` in `deploy/run_engine.sh` and in `run.js cycle`.
  It returns at once when `DEPOSIT_OFFER_ACTIVE` is not `1`. It needs `MEGAPOT_ACTIVE=1` and `START_MS`
  like every step (`guard()`), so `MEGAPOT_ACTIVE=0` still pauses everything.
- **Not fee credit.** No wallet credit moves. The day/week caps do not apply. The cap is one ticket per wallet
  for the whole experiment: `depositOffer[experiment][wallet]`.
- **Budgets.** `DEPOSIT_OFFER_BUDGET_USDC` (default 50) is counted in `depositOfferSpentUsdc[experiment]`.
  Every mint also counts in `spentUsdc`, so `GLOBAL_BUDGET_USDC` still holds. When either budget cannot
  cover one more ticket, the lane stops and raises `deposit_offer_budget`.
- **Window.** The lane does not use the season `END_MS`. The app's feed lists only owed rows of the
  experiment window. Stop the lane with `DEPOSIT_OFFER_ACTIVE=0`.
- **Exactly once.** The entry and an `intents[]` row (`kind:'deposit-offer'`) are on disk before the
  broadcast. The debit is on disk before the receipt wait. `settleOpen()` settles open entries each cycle by
  receipt and nonce, with the same rules as buys (`reconcile.js`). `reconcileIntents()` in the buy step
  leaves these intents alone. A tx that never mined or reverted is refunded and minted again next cycle
  (at most 3 reverts, then `failed`). A mined tx without a ticket Transfer to the wallet becomes `no-token`
  and logs `ALERT deposit_offer_no_token`. It is never minted again.
- **Round and draw time.** `round` = `currentDrawingId()` just before the mint. `drawAt` =
  `getDrawingState(round).drawingTime x 1000`, left out when the read fails.
- **DRY_RUN=1** prints `WOULD mint 1 deposit-offer ticket` per row and writes no entry.
- **Live needs** `TICKET_NFT` (the token id is read from its log), `PRIVATE_KEY`, `TREASURY` (mainnet), and a
  standing USDC allowance for the buyer (the lane sets it with `planApproval` when it is too low).
- **Ledger statuses:** `intent`, `pending`, `issued`, `no-token`, `failed`, `reverted`, `dropped`.
  `npm run status` prints the counts under `depositOffer`.

Env (names only; values come from the deploy):

| Name | Default | What |
|---|---|---|
| `DEPOSIT_OFFER_ACTIVE` | off | `1` switches the lane on |
| `DEPOSIT_OFFER_BUDGET_USDC` | `50` | lane budget in USDC |
| `DEPOSIT_OFFER_FEED_URL` | derived | owed-rewards feed; default `USERS_URL` with `/api/admin/wallets` -> `/api/admin/deposit-offer/rewards?variant=prize&status=owed&due=1` |

## Addresses

| | Base mainnet | Base Sepolia |
|---|---|---|
| Jackpot | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` | `0x465dA3c859f193A3807386387bEE941B2A4c3279` |
| RandomTicketBuyer | `0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd` | `0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Ticket price and referral rates are read live from the contracts at run time — never hardcoded (per-drawing parameters).
