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

## Addresses

| | Base mainnet | Base Sepolia |
|---|---|---|
| Jackpot | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` | `0x465dA3c859f193A3807386387bEE941B2A4c3279` |
| RandomTicketBuyer | `0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd` | `0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Ticket price and referral rates are read live from the contracts at run time — never hardcoded (per-drawing parameters).
