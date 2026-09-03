# Megapot Fee Accrual

**The most hated part of trading, turned into the best part.** Every fee a Hence trader pays
accrues as [Megapot](https://megapot.io) jackpot tickets — minted straight to their own wallet.

Started at the **Megapot hackathon**, now Season 1 live on Base. Non-custodial from mint: tickets and
any winnings belong to the trader, never to us.

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
enrolled wallets ──▶ ACCRUE   Hence-routed fills since checkpoint (HL userFillsByTime, spot feed)
                              × eligibility × economics.feeBps × rolloverShare × tier kicker
                              → per-wallet USDC credit, activation packs, streak boxes   (ledger)

                 ──▶ BUY      credit ≥ live ticketPrice()
                              → retro TicketNFT transfer (pool-held, active round) first
                              → else JackpotRandomTicketBuyer.buyTickets(n, TRADER, …)
                              → tickets land in the TRADER's wallet on Base
```

Two commands, deliberately separate. Accrual is a pure read that can run as often as you like;
buying moves funds and is the step with the caps on it.

**The invariant:** per-wallet spend never exceeds per-wallet accrued fee credit plus explicit
grants (pack, box, ops). A trader can only ever receive tickets bought with fees they actually
paid or grants the sheet defines.

---

## Layout

| | |
|---|---|
| `campaign.json` | The **season sheet**: window, eligibility, rate, caps, pools, odds, multipliers, rules copy, hub overlay, retro. Source of truth for engine *and* hub |
| `engine/` | The accrual, buy, reconcile and win-sweep jobs. Reads fills, writes the ledger, mints tickets, emits CRM events |
| `engine/scripts/gen-hub-sheet.mjs` | Generates neo-hence's `web/src/lib/megapot-campaign.ts` from `campaign.json` |
| `deploy/` | Engine as a container on the Hence VM; ledger on a named volume; hourly backup script |
| `docs/` | Coworking checklist, CRM workflows + copy + templates, Customer.io setup, key rotation, backups |
| `AGENTS.md` | The brief for anyone (human or agent) editing this repo — read it first |

The trader-facing Reward Hub lives in `Hence-Markets/neo-hence` (`web/src/components/RewardHub.tsx`),
not here.

### The campaign

Everything about the current season — the live window, what qualifies, the rebate rate, the
activation pack odds, the daily surprise-box matrix, the multiplier tiers, per-wallet and
season-wide caps, the user-facing rules — is in **`campaign.json`**, each knob next to a `$note`
explaining it. This README deliberately does not repeat the numbers: they change between seasons
and a stale copy here has bitten us before. Read the sheet, and read `AGENTS.md` for the live
deploy inputs and the invariants around changing it.

**`campaign.json` holds product parameters; environment variables hold security gates.** Retuning
a season is a file edit, a hub regeneration and a redeploy. Turning the campaign on, choosing who
is in it, and holding the signing key are decisions that live in the deploy dispatch and repo
secrets, never in a file anyone can edit. The deploy strips product keys (`FEE_BPS`, `ROLLOVER`,
`SYMBOLS`, day cap, interval) from the VM env so a stale value can never override the sheet.

`campaign.startMs` / `endMs` are hard bounds — fills outside the window never credit. Without a
start bound, arming a campaign would retroactively credit **all of history** on its first run.

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

Independent limits, because a bug in any one of them should not be able to spend the budget:

- per-wallet daily and weekly ticket caps
- season pools for packs, boxes and multiplier kickers, plus per-day mint gates
- a global USDC budget halt (`GLOBAL_BUDGET_USDC`, set per deploy)
- the accrual invariant above

Ticket price and referral rates are read **live from the contracts** — they are per-drawing
parameters, and a hardcoded copy is wrong the moment a drawing rolls.

---

## Running it

```bash
cd engine && npm install && cp .env.example .env
set -a; source .env; set +a

npm run accrue          # fills → credit          (a pure read)
npm run buy             # credit → tickets        (DRY_RUN prints, moves nothing)
npm run status          # mode, public flag, ledger totals
npm run gen:hub-sheet   # campaign.json → stdout TS module for neo-hence
node --test test/*.test.js
```

The ledger is a file (`engine/state/ledger.<target>.json`) on a named Docker volume in production.
It is the source of truth for what each wallet is owed and what has already been bought — backed
up hourly (`deploy/backup_ledger.sh`, `docs/backups.md`). Deployment is a dispatch from
neo-hence (`deploy/README.md`).

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
| Fee accrual from real Hence-routed fills | ✅ Real |
| Ticket purchase against live Megapot contracts on Base mainnet | ✅ Real — mints to the trader's wallet |
| Activation packs, surprise boxes, caps, campaign window | ✅ Real — odds and pools in `campaign.json` |
| Multiplier tiers | Built; activate when the basket-volume feed (`BASKET_URL`) is set |
| Custody | ❌ None — tickets mint to the trader, never to a Hence address |

## Built for the Megapot hackathon

By [Hence](https://hence.markets). The Hence terminal predates the jam; the fee-accrual engine,
the ticket-purchase flow and the Reward Hub were built during it; Season 1 hardened it.

Companion repo: [hence-incognito](https://github.com/Hence-Markets/hence-incognito) — the Inco
Lightning dark-pool pilot.

Spec: [Hence × Megapot — Reward Hub Integration Spec](https://app.notion.com/p/3bb8bcd7d5c381e5b4fbcd5e4fd43863)
