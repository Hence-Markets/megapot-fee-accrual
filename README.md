# Megapot Fee Accrual

**The most hated part of trading, turned into the best part.** Every fee a Hence trader pays
accrues as [Megapot](https://megapot.io) jackpot tickets — minted straight to their own wallet.

Built for the **Megapot hackathon**, on Base. Non-custodial from mint: tickets and any winnings
belong to the trader, never to us.

---

## The problem

Fees are the one part of trading nobody enjoys and nobody gets back. You pay them on every fill,
they vanish into the venue, and they are pure drag on a strategy that might otherwise be
working.

Loyalty programmes answer this by printing a token, which dilutes, or by rebating in kind, which
is just a discount with extra steps.

**Megapot answers it differently: the fee becomes a lottery ticket.** The trader spends nothing
extra, and gets a running shot at winning their whole fee accrual back — or the progressive
jackpot — on top of their P&L. The upside comes from Megapot's existing pool, not from an
emission.

## How it works

```
enrolled wallets ──▶ ACCRUE   fills since checkpoint (HL userFillsByTime)
                              × symbol allowlist × 4.5 bps × rollover share
                              × streak multiplier (1x–4x)
                              → per-wallet USDC credit          engine/state/ledger.json

                 ──▶ BUY      credit ≥ live ticketPrice()
                              → JackpotRandomTicketBuyer.buyTickets(n, TRADER, …)
                              → ticket NFTs mint to the TRADER's wallet on Base
```

Two commands, deliberately separate. Accrual is a pure read that can run as often as you like;
buying moves funds and is the step with the caps on it.

**The invariant:** per-wallet spend never exceeds per-wallet accrued fee credit. A trader can
only ever receive tickets bought with fees they actually paid.

### The streak multiplier

The game loop, and the reason this is a strategy game rather than a rebate:

| | |
|---|---|
| **1×** | Base rate — every qualifying trade counts once |
| **2×** | Trade on 5 distinct days in a week |
| **3×** | Hold 2× for 4 straight weeks, plus one basket run held to plan |
| **4×** | A full season streak plus a published rated thesis |

The higher tiers deliberately reward the behaviour Hence is actually for — running a
correlation-aware basket and holding it to plan — rather than raw volume, which would just pay
people to churn.

---

## Layout

| | |
|---|---|
| `engine/` | The accrual and buy jobs. Reads fills, writes the ledger, buys tickets |
| `web/` | Reward Hub — the trader-facing view of credit, tickets, streak and jackpot |
| `campaign.json` | The **product** parameters: window, eligibility, rates, caps, multipliers |
| `deploy/` | Engine as a container on the Hence VM; ledger on a named volume |

### campaign.json vs environment

A deliberate split, and the reason is operational: **`campaign.json` holds product parameters,
environment variables hold security gates.**

Retuning a campaign — which symbols qualify, the multiplier ladder, the daily cap — is a product
decision that should be a file edit and a re-run. Turning the campaign on, choosing who is in
it, and holding the signing key are security decisions that should never live in a file anyone
can edit and re-run.

```jsonc
{
  "campaign":    { "id": "megapot-rewards-s1", "network": "testnet", "startMs": …, "endMs": … },
  "eligibility": { "products": ["perps", "xyz-equities"],
                   "symbols":  ["BTC","ETH","SOL","HYPE","NVDA","TSLA"] },
  "economics":   { "feeBps": 4.5, "rolloverShare": 1.0 },
  "caps":        { "ticketsPerWalletPerDay": 5, "ticketsPerWalletPerWeek": 15,
                   "globalBudgetUsdc": 50 }
}
```

`startMs` and `endMs` are hard bounds — fills outside the window never credit. That matters more
than it looks: without a start bound, arming a campaign would retroactively credit **all of
history** on its first run.

## Gates

Following the Hence feature-gates convention:

- `MEGAPOT_ACTIVE=1` **plus** a whitelist = team cohort. The public flag stays **false** — the
  honesty rule is `active AND NOT whitelist`, so a whitelisted test never advertises itself as a
  live public campaign.
- **Empty whitelist = open to all enrolled users.** The engine refuses open mode without a user
  feed rather than guessing who is enrolled.
- To pause: `MEGAPOT_ACTIVE=0`. Never clear the list — that *opens* it.
- `DRY_RUN=1` is the **default**: the full state machine runs and prints, and nothing moves.

## Caps

Three independent limits, because a bug in any one of them should not be able to spend the
budget:

- per-wallet daily and weekly ticket caps
- a global lifetime budget halt
- the accrual invariant above

Ticket price and referral rates are read **live from the contracts** — they are per-drawing
parameters, and a hardcoded copy is wrong the moment a drawing rolls.

---

## Running it

```bash
cd engine && npm install && cp .env.example .env
set -a; source .env; set +a

npm run accrue    # fills → credit          (a pure read)
npm run buy       # credit → tickets        (DRY_RUN prints, moves nothing)
npm run status    # mode, public flag, ledger totals
```

The ledger is a file (`engine/state/ledger.json`) on a named Docker volume in production. It is
the source of truth for what each wallet is owed and what has already been bought — back it up
before touching a live campaign.

## Contracts

| | Base mainnet | Base Sepolia |
|---|---|---|
| Jackpot | `0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2` | `0x465dA3c859f193A3807386387bEE941B2A4c3279` |
| RandomTicketBuyer | `0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd` | `0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## What is real, and what is not

| | |
|---|---|
| Fee accrual from real fills | ✅ Real |
| Ticket purchase against live Megapot contracts | ✅ Real — mints to the trader's wallet |
| Streak multipliers, caps, campaign windows | ✅ Real |
| Current campaign network | **Base Sepolia** while under test; `network: mainnet` after sign-off |
| Custody | ❌ None — tickets mint to the trader, never to a Hence address |

## Built for the Megapot hackathon

By [Hence](https://hence.markets). The Hence terminal predates the jam; the fee-accrual engine,
the ticket-purchase flow and the Reward Hub were built during it.

Companion repo: [hence-incognito](https://github.com/Hence-Markets/hence-incognito) — the Inco
Lightning dark-pool pilot.

Spec: [Hence × Megapot — Reward Hub Integration Spec](https://app.notion.com/p/3bb8bcd7d5c381e5b4fbcd5e4fd43863)
