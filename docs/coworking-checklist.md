# Megapot integration - coworking checklist

Two repos, one money path. Read this before touching either.

| | neo-hence (hub + backend) | megapot-fee-accrual (engine) |
|---|---|---|
| What it does | Reward Hub UI, email bind, basket-volume API, users feed | reads Hence fills, credits fee rebate, mints tickets, emits CRM events |
| Deploys | merge to `main` → CI/CD → app.hence.markets | `deploy-megapot.yml` dispatch from neo-hence (manual, inputs matter) |
| Money moves? | never | **yes** when `DRY_RUN=0` on mainnet |

## Before you start
- [ ] Pull `main` in both repos. The hub mirrors engine config (`web/src/lib/megapot-campaign.ts` is GENERATED from `campaign.json`; `web/src/lib/streak-box.ts` mirrors `engine/src/streakBox.js`). Change the engine first, then regenerate the hub.
- [ ] Never commit `.env*`, keys, or ledger files (`engine/state/`). `.gitignore` covers them; `git status` before every commit anyway.
- [ ] Work on a branch. No direct pushes to `main` in either repo.
- [ ] Commit messages: plain conventional commits (`feat(engine): …`, `fix(hub): …`). No "(LOCAL)", no AI co-author lines.

## Changing the hub (neo-hence/web)
- [ ] Preview with the harness, not prod: `npm --prefix web run dev` → `http://localhost:5173/preview.html?w=<wallet>`. Dev-only flags: `&jardemo=1` (meter party), `&pathdemo=1` (email treated as linked), `&flowdemo=1` (first-pack walkthrough). They compile out of production builds - do not add new flags outside `web/src/lib/demo-flags.ts`.
- [ ] Only Hence-routed fills count (`builderFee > 0`). If you touch fill parsing, keep that filter; the engine applies the same rule.
- [ ] Do not hardcode pool sizes, odds or dollar thresholds - read `CAMPAIGN` (generated) or `STREAK_BOX_MATRIX`.
- [ ] Anything that celebrates (meter party, streak takeover, daily reveal) writes a per-wallet localStorage marker AFTER the moment plays. Keep that order or users get re-partied forever.
- [ ] Run `npx tsc --noEmit -p web/tsconfig.json` and `node --test web/test/*.test.js` (all green today: 388). Add a test in `web/test/rewards.test.js` for any math you change.
- [ ] Check desktop AND 375px mobile in the preview before opening the PR.

## Changing the engine (megapot-fee-accrual)
- [ ] `node --test engine/test/*.test.js` must pass (11 today). Pure logic lives in `streakBox.js`, `lifecycle.js`, `gates.js`, `ledger.js` - put new logic there with tests, not inline in `engine.js`.
- [ ] The ledger is the truth. Never hand-edit `state/ledger.<target>.json` on the VM; never delete it (a missing ledger = every historical fill re-credits). Writes are atomic and locked - keep `save()` per wallet.
- [ ] Anything that grants tickets must (1) be recorded on the ledger BEFORE its event is emitted, (2) respect `poolTickets` and the daily gates, (3) stop after `END_MS`.
- [ ] Comms (`track`, `cioIdentify`) are fail-open and must stay that way: never `await` them on the money path without `allSettled`.
- [ ] New events: add to `docs/crm-workflows.md` and the CRM Playbook; name them `megapot_<thing>`, wallet-keyed, no PII in PostHog props.
- [ ] Config changes go in `campaign.json` with a `$note`. Then regenerate the hub sheet (`megapot-campaign.ts`) in the same PR set.

## Deploying the engine (the part that spends money)
- [ ] Dispatch `deploy-megapot.yml` from neo-hence with ALL inputs explicit. Current live values: `ref=main`, `target=mainnet`, `dry_run=0`, `active=1`, `start_ms=1787572740000`, `budget_usdc=1500`, whitelist = the 4 team wallets. Empty whitelist = OPEN TO EVERYONE.
- [ ] Rehearse first: same inputs with `dry_run=1`, read the log for "WOULD buy".
- [ ] Watch the run's "Confirm the safety posture" step: `DRY_RUN`, `TARGET`, `ACTIVE`, key present.
- [ ] After deploy, tail one cycle on the VM (`docker compose logs -f engine`) and confirm no wallet logs "skipped this cycle" repeatedly.
- [ ] Top up the pool wallet (USDC + ~0.01 ETH gas) before raising `budget_usdc`.

## Don'ts
- Don't run `accrue`/`buy` by hand on the VM while the container loop runs (lock will refuse; don't remove the lock file).
- Don't change `START_MS` mid-season.
- Don't rename Customer.io event names or profile attributes - live campaigns key on them.
- Don't flip `streakBox.enabled` off mid-season without clearing expectations in the hub copy (checkpoints would start granting on top of boxes already opened).
- Don't merge hub changes that reference engine config not yet on `main`.

## When something looks wrong
1. Hub shows wrong numbers → check the preview with the user's wallet; compare `campaign-trade-days`/tickets against `node src/run.js status` on the VM.
2. A ticket minted twice / not at all → look for the purchase row in the ledger (`purchases[]`, `verified`, `refunded`) before touching anything.
3. Emails wrong → the event props are in PostHog (project 359671, `source: megapot-engine`); the copy is in the CRM Playbook.
4. Stop the bleeding: redeploy with `active=0` (pauses everything, ledger intact).
