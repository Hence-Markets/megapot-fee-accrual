# megapot-fee-accrual — agent brief

Read fully before editing. This brief is for AI coding agents (Claude Code, Codex, Cursor)
and the humans driving them. **This engine spends real USDC from a pool wallet and mints
on-chain lottery tickets to users' wallets.** A wrong edit here is not a visual bug; it is
money minted twice or never.

## What this is
- `engine/src/engine.js` — one cycle every 300 s: `accrue` (Hence fills → fee credit,
  activation packs, streak boxes) → `buy` (credit ≥ ticket price → on-chain mint) →
  `winSweep` (venue tickets → win events + daily status). Deployed as a container loop
  (`deploy/run_engine.sh`), never as cron.
- Pure modules with tests: `streakBox.js` (daily box matrix), `lifecycle.js` (daily status
  snapshot), `gates.js` (season-wide daily caps), `ledger.js` (atomic writes, lock, Hence-fill
  filter). **Put new logic in a pure module with a test; do not grow `engine.js` inline.**
- `campaign.json` — the season sheet. It is the source of truth for the hub too: the hub's
  `web/src/lib/megapot-campaign.ts` (neo-hence) is generated from it and
  `web/src/lib/streak-box.ts` mirrors `STREAK_BOX_MATRIX`. Change here first, then the hub.
- `docs/crm-workflows.md`, `docs/crm-content.md`, `docs/coworking-checklist.md` — CRM map,
  email copy, human checklist.

## Invariants — never break these
1. **Ledger before wire, wire before comms.** Any grant or purchase is written to the
   ledger (`save(s)`) before the tx is awaited and before any `track()` fires. Events are
   queued in `emits` and flushed after the wallet's save. A crash between grant and email
   must never produce an email the replay contradicts.
2. **One buy per credit.** The tx hash + debit are persisted before `waitForTransactionReceipt`;
   `reconcile()` settles or refunds later. Never move that order. Never re-derive credit from
   fills without the checkpoint `lastFillMs`.
3. **Ledger is append-only truth.** Never hand-edit or delete `state/ledger.*.json`.
   `readLedger` hard-stops on a corrupt file; do not "fix" that by returning a blank ledger.
   Never remove the process lock or bypass `acquireLock`.
4. **Only Hence-routed fills pay** (`isHenceFill`: `builderFee > 0`, `campaign.requireBuilderFee`).
   Do not widen this.
5. **Pools and gates are ceilings.** Packs: `packSlots` (draw without replacement) + 30/day.
   Boxes: `streakBox.poolTickets` + `dailyCap` via `takeFromDailyGate`. Per wallet 5/day,
   15/week. Global `GLOBAL_BUDGET_USDC`. Every new grant path must respect all that apply
   and stop after `END_MS`.
6. **Comms are fail-open.** `track`/`cioIdentify` have 4 s timeouts and `allSettled`; never
   let a Customer.io/PostHog failure throw into the money path. No PII in PostHog props
   (wallet ids only; email is attached by neo-hence's `serve.py`).
7. **Do not rename events or profile attributes** (`megapot_*`, `tickets_in_draw`,
   `unclaimed_usd`, …). Live Customer.io campaigns key on them. Add new ones; document them
   in `docs/crm-workflows.md`.
8. **`START_MS` is immutable mid-season.** `qualifies()` bounds every fill by it.

## Working rules
- Branch from `main`; open a PR; conventional commits (`feat(engine): …`). No AI co-author
  trailers, no "(LOCAL)" tags. Never commit `.env*`, keys, or anything under `engine/state/`.
- Run `node --test engine/test/*.test.js` (11 today) and `node --check engine/src/engine.js`
  before every commit. Add a test for any change in odds, gates, ledger or lifecycle math.
- Rehearse with `DRY_RUN=1` (`WOULD buy` in logs) before any mainnet change.
- Config changes: edit `campaign.json` with a `$note`, then regenerate the hub sheet in a
  paired neo-hence PR. Do not hardcode numbers from the sheet elsewhere.
- Deploy only through neo-hence's `deploy-megapot.yml` dispatch with **all inputs explicit**
  (live: `ref=main target=mainnet dry_run=0 active=1 start_ms=1787572740000 budget_usdc=1500`,
  whitelist = 4 team wallets; empty whitelist = everyone). An agent must not dispatch this
  workflow without the human saying so in that session.

## Emergency
- Pause everything, ledger intact: redeploy with `active=0`.
- Suspected double mint: read `purchases[]` (`verified`, `refunded`, `unfound`) in the ledger
  before any action; do not re-run `buy` by hand.
