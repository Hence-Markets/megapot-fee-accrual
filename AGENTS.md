# megapot-fee-accrual — agent brief

Read fully before editing. This brief is for AI coding agents (Claude Code, Codex, Cursor)
and the humans driving them. **This engine spends real USDC from a pool wallet and mints
on-chain lottery tickets to users' wallets.** A wrong edit here is not a visual bug; it is
money minted twice or never.

## What this is
- `engine/src/engine.js` — one cycle every 300 s: `accrue` (Hence fills → fee credit,
  activation packs, streak boxes) → `buy` (credit ≥ ticket price → retro ticket transfer
  first, then on-chain USDC mint) → `winSweep` (venue tickets → win events + daily status).
  Deployed as a container loop (`deploy/run_engine.sh`), never as cron. Each cycle touches
  `state/heartbeat.<target>` (the compose healthcheck and the watch workflow read it) and
  logs `[megapot] ALERT …` + PostHog `megapot_engine_alert` when something needs a human.
- Pure modules with tests: `streakBox.js` (daily box matrix), `lifecycle.js` (daily status
  snapshot), `gates.js` (season-wide daily caps), `ledger.js` (atomic writes, lock, Hence-fill
  filter). **Put new logic in a pure module with a test; do not grow `engine.js` inline.**
- `campaign.json` — the season sheet and the source of truth for the hub too. The hub's
  `web/src/lib/megapot-campaign.ts` (neo-hence) is GENERATED from it by
  `engine/scripts/gen-hub-sheet.mjs`; `web/src/lib/streak-box.ts` mirrors `STREAK_BOX_MATRIX`.
  Change here first, regenerate, then open the paired hub PR.
- `docs/crm-workflows.md`, `docs/crm-content.md`, `docs/customerio-setup.md`,
  `docs/coworking-checklist.md`, `docs/key-rotation.md`, `docs/backups.md` — CRM map, email
  copy, Customer.io click-path, human checklist, runbooks.

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
   Never remove the process lock or bypass `acquireLock`. Backups: `docs/backups.md`.
4. **Only Hence-routed fills pay** (`isHenceFill`: `builderFee > 0`, `campaign.requireBuilderFee`).
   Do not widen this.
5. **Pools and gates are ceilings.** Packs: `packSlots` (draw without replacement) + 30/day.
   Boxes: `streakBox.poolTickets` + `dailyCap` via `takeFromDailyGate`. Multiplier kickers:
   `multiplierBonus.poolTickets` (built; live once `BASKET_URL` is set). Per wallet 5/day,
   15/week. Global `GLOBAL_BUDGET_USDC` (USDC spend only — retro NFT transfers are inventory,
   not spend). Every new grant path must respect all that apply and stop after `END_MS`.
6. **Comms are fail-open.** `track`/`cioIdentify` have 4 s timeouts and `allSettled`; never
   let a Customer.io/PostHog failure throw into the money path. No PII in PostHog props
   (wallet ids only; email is attached by neo-hence's `serve.py`).
7. **Do not rename events or profile attributes** (`megapot_*`, `tickets_in_draw`,
   `unclaimed_usd`, …). Live Customer.io campaigns key on them. Add new ones; document them
   in `docs/crm-workflows.md`.
8. **`START_MS` is immutable mid-season.** `qualifies()` bounds every fill by it.
9. **`campaign.json` beats env for product parameters.** `FEE_BPS`, `ROLLOVER`, `SYMBOLS`,
   `MAX_TICKETS_PER_WALLET_PER_DAY`, `ENGINE_INTERVAL_S` stay blank in every `.env.example`
   and are stripped by the deploy. Env holds gates and secrets only.

## Working rules
- Branch from `main`; open a PR; conventional commits (`feat(engine): …`). No AI co-author
  trailers, no "(LOCAL)" tags. Never commit `.env*`, keys, or anything under `engine/state/`.
- Run `node --test engine/test/*.test.js` and `node --check engine/src/engine.js` before every
  commit (all green on `main`; the count moves, do not quote it). Add a test for any change in
  odds, gates, ledger or lifecycle math.
- Rehearse with `DRY_RUN=1` (`WOULD buy` in logs) before any mainnet change.
- Config changes: edit `campaign.json` with a `$note`, then regenerate the hub sheet:
  ```
  npm --prefix engine run gen:hub-sheet > <neo-hence>/web/src/lib/megapot-campaign.ts
  ```
  and open the paired neo-hence PR (`cd web && npx tsc --noEmit -p .` must pass there). The
  generator strips `$`-notes, drops engine-only keys (`opsGrants`, `caps.globalBudgetUsdc`,
  `multiplierBonus`), flattens `campaign/eligibility/economics/caps`, merges the `hub` overlay
  (`marketingConsentDefault`, `engineCycleS`) at the top level and stamps the JSON's sha256 in
  the header. Do not hardcode numbers from the sheet elsewhere.
- Deploy only through neo-hence's `deploy-megapot.yml` dispatch with **all inputs explicit**.
  Live Season 1 (dispatched 2026-09-03): `ref=main target=mainnet dry_run=0 active=1
  start_ms=1788379200000 end_ms=1789596000000 budget_usdc=1500 whitelist=<empty>` (open mode;
  `users_url`/`basket_url`/`spot_fills_url`/`active_url` on `app.hence.markets`,
  `ticket_nft=0x48ffe35abb9f4780a4f1775c2ce1c46185b366e4 retro_transfers=1`). Mainnet runs
  need the `megapot-mainnet` environment reviewer. An agent must not dispatch this workflow
  without the human saying so in that session.
- **Reset workflow (`megapot-reset-wallets`): do not run until the engine PR
  `feat/engine-safety` is deployed.** On the current build a reset rewinds the wallet's
  checkpoint to `START_MS` and replays its whole season (re-credits, re-grants the pack,
  re-rolls every box).
- Feeds: the engine authenticates to the backend with `USERS_TOKEN` = the read-only
  `HENCE_FEED_TOKEN`, never the admin token. `GRANTS_URL` derives from `USERS_URL`.
- Retro tickets: `RETRO_TRANSFERS=1` + `TICKET_NFT` make the engine hand out pool-held Megapot
  tickets of the active round before spending USDC. Inventory, not budget.

## Ops surfaces (neo-hence)
- `deploy-megapot` (dispatch, environment-gated), `megapot-diagnostics` (read-only, hashed
  wallets), `megapot-watch` (every 30 min: heartbeat, last mint/accrue, pool ETH/USDC, backup
  age, ALERT lines → Telegram), `megapot-reset-wallets`, `megapot-tier-grant`.
- Backups: `deploy/backup_ledger.sh` hourly via cron → `~/megapot-backups/` (`docs/backups.md`).
- Key rotation: `docs/key-rotation.md`.

## Emergency
- Pause everything, ledger intact: redeploy with `active=0`.
- Suspected double mint: read `purchases[]` (`verified`, `refunded`, `unfound`) in the ledger
  before any action; do not re-run `buy` by hand.
- Pool wallet low (`[megapot] ALERT` / Telegram): top up USDC + ~0.01 ETH, then raise
  `budget_usdc` with a redeploy if the ceiling is near.
