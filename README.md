# megapot-fee-accrual

**The Megapot reward leg for Hence: trading fees roll back into Megapot tickets, minted to the trader's own wallet.** Non-custodial from mint — tickets and winnings always belong to the trader.

```
enrolled wallets ──> accrue: HL userFillsByTime since checkpoint
                        × symbol allowlist × 4.5bps × rollover share
                        → per-wallet USDC credit  (engine/state/ledger.json)
                 ──> buy: credit ≥ live ticketPrice()
                        → JackpotRandomTicketBuyer.buyTickets(n, TRADER, [treasury], [1e18], tag)
                        → ticket NFTs mint to the TRADER's wallet on Base
```

## Gates (pre-production → post-production, per the Hence feature-gates doc)

`MEGAPOT_ACTIVE=1` + whitelist = team cohort, public flag stays **false** (honesty rule: `active AND NOT whitelist`). Empty whitelist = **open to all** enrolled users (requires the user feed — the engine refuses open mode without one). Pause = `ACTIVE=0`, never clear the list. `START_MS` before active; `DRY_RUN=1` (default) rehearses everything without moving funds.

## Run

```bash
cd engine && npm install && cp .env.example .env
set -a; source .env; set +a
npm run accrue    # fills → credit
npm run buy       # credit → tickets (DRY_RUN prints, moves nothing)
npm run status    # mode, public flag, ledger
```

## Invariant & caps

Per-wallet spend never exceeds per-wallet accrued fee credit, plus a per-wallet daily ticket cap and a global lifetime budget halt. Ticket price and referral rates are read live from the contracts — per-drawing parameters, never hardcoded.

| | Base mainnet | Base Sepolia |
|---|---|---|
| Jackpot | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` | `0x465dA3c859f193A3807386387bEE941B2A4c3279` |
| RandomTicketBuyer | `0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd` | `0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Spec: [Hence × Megapot — Reward Hub Integration Spec](https://app.notion.com/p/3bb8bcd7d5c381e5b4fbcd5e4fd43863)
