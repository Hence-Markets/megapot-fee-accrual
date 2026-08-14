# hence × megapot — the Megapot reward leg

Everything Megapot for Hence, nested in one repo. Three legs, one invariant: **tickets and winnings always belong to the trader's own wallet — non-custodial from mint.**

| Leg | What it is | Status |
|---|---|---|
| [`engine/`](engine/) | **Fee accrual → tickets.** Venue-authoritative HL fills × 4.5bps × rollover → per-wallet credit → Megapot quick-picks minted to the trader. Gate semantics match the Hence feature-gates doc exactly (ACTIVE + WHITELIST, pre/post-production, honesty rule). | DRY_RUN-verified on live fills |
| [`contracts/`](contracts/) | **SealedCaller** — sealed bonusball predictions on Megapot's daily draw (Inco-encrypted guesses, real ticket per entry, side pot to proven hits). | Deployed Base Sepolia: [`0x31edcfdd…426a`](https://sepolia.basescan.org/address/0x31edcfdd0147c45f7635896cb919e795b50d426a) |
| [`web/`](web/) | Next.js frontend: live pool/countdown from chain, Inco encrypt-and-commit flow. | Verified against Base Sepolia |

## Gates (pre-production → post-production)

`MEGAPOT_ACTIVE=1` + whitelist = team cohort, public flag stays **false** (honesty rule: `active AND NOT whitelist`). Empty whitelist = **open to all** enrolled users (requires the user feed). Pause = `ACTIVE=0`, never clear the list. `START_MS` before active, `DRY_RUN` rehearsal before live. Details in [`engine/README.md`](engine/README.md).

## Quick start

```bash
cd engine && npm install && cp .env.example .env   # fee-accrual job
cd contracts && npm install && forge build          # SealedCaller
cd web && npm install && npm run dev                # frontend (localhost:3000)
```

Spec: [Hence × Megapot — Reward Hub Integration Spec](https://app.notion.com/p/3bb8bcd7d5c381e5b4fbcd5e4fd43863) · addresses read live from chain, never hardcoded.
