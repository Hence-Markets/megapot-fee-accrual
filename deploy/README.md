# Deploying Megapot

Two pieces. Only one needs the VM.

| Piece | Where it runs | Why |
|---|---|---|
| **Engine** (`engine/`) | **Hence VM**, own compose stack | Scheduled batch job, holds the pool wallet key, keeps a ledger on disk |
| **Reward Hub** (in-app) | `neo-hence` `web/` → app.hence.markets | Reads `web/src/lib/megapot-campaign.ts`, generated from this repo's `campaign.json` |

There is no standalone demo site any more (the old `web/` Next export and its Pages workflow
were deleted on 2026-09-03; the in-app hub is the only UI). **No Vercel anywhere** — a second
deploy surface means a second secrets store, and the thing most likely to end up in it is a hot
wallet key.

## 1 · Engine on the VM

Its own compose project (`name: megapot`, container `megapot-engine`), so it can be rebuilt or
deleted without touching the Hence stack. **No published ports** — the engine has no inbound
surface at all; it only makes outbound calls to Base, the Hyperliquid fills API and the Hence
backend feeds.

```bash
ssh <vm> && cd ~/megapot/deploy
cp .env.example .env      # then set it via the workflow, not by hand
docker compose up -d --build
docker compose logs -f engine
```

The `ledger` volume (`megapot_ledger`) is not optional. `state/ledger.<target>.json` records
which fills have already been credited and which packs were drawn; losing it re-credits them on
the next accrue, which is the one failure mode that costs real money.

### Health, stop, single instance

- `healthcheck`: the engine touches `state/heartbeat.<target>` at the end of every cycle; the
  container is healthy while that file is younger than 2 × `ENGINE_INTERVAL_S` (`-mmin -11` for
  the 300 s default). `docker compose ps` shows `unhealthy` when minting has stalled for any
  reason, and neo-hence's `megapot-watch` workflow alerts on it.
- `init: true` + the TERM trap in `run_engine.sh`: `docker stop` lets the current step (a buy
  in flight, for instance) finish and exits between steps, within the 120 s grace period.
- `container_name: megapot-engine`: exactly one engine per VM. Never start a second one against
  the same volume — the ledger lock is pid-based and cannot see across containers.

### Backups (hourly, cron)

`deploy/backup_ledger.sh` tars the `megapot_ledger` volume to `~/megapot-backups/ledger-<epoch>.tgz`
(7-day local retention) and, if `MEGAPOT_BACKUP_REMOTE` is set and `rclone` is configured, copies
it off the VM. Install once on the VM:

```cron
# megapot ledger backup — hourly, keep 7 days locally; optional off-VM copy via rclone
0 * * * * MEGAPOT_BACKUP_REMOTE="" $HOME/megapot/deploy/backup_ledger.sh >> $HOME/megapot-backups/backup.log 2>&1
```

Set `MEGAPOT_BACKUP_REMOTE="r2:megapot-ledger"` (or any `rclone config` remote) to enable the
off-VM leg. `megapot-diagnostics` and `megapot-watch` print/alert on the newest backup's age.
Restore procedure and what the archive contains: `docs/backups.md`.

### Operating it

**Deployment is dispatched from `neo-hence`, not from this repo** — Actions → **deploy-megapot**.
It checks this repo out by ref (`main`, a `v*` tag or a 40-hex SHA), syncs it to the VM, writes
`.env` from secrets held there, and recreates the container. Mainnet dispatches run in the
`megapot-mainnet` GitHub environment, which requires a reviewer.

That inversion is deliberate and is a security boundary, not a preference. The self-hosted
runner *is* the VM: it holds the `hence_users` Postgres, the upstream API keys, the rebate
payout wallet key and the Megapot pool wallet key. **This repo is public.** A runner reachable
from a public repo means anyone's pull request can execute next to those secrets, which is
what GitHub's own guidance warns against. So the private repo reaches in; the public repo never
touches the runner.

Practically, nothing changes for contributors: push here as normal, and release with a dispatch
from neo-hence.

Order matters, and the workflow enforces it:

1. **`start_ms` before `active`.** Switching on without a start makes every historical fill
   eligible at once. The workflow refuses an empty `start_ms`.
2. **`dry_run=1` until a supervised first mint.** It exercises accrue → caps → select and moves
   nothing.
3. **Pause with `active=0`, never by clearing the whitelist** — an empty whitelist means
   *everyone*, not nobody. (Note this is the opposite of hence-incognito's access gate, which
   fails closed. Right for a rebate, wrong for an access gate; don't copy one to the other.)

Live Season 1 dispatch (2026-09-03): `ref=main target=mainnet dry_run=0 active=1
start_ms=1788379200000 end_ms=1789596000000 budget_usdc=1500 whitelist=<empty>` (open mode).
See `AGENTS.md` for the full input list.

### What the deploy writes into `.env`

Product parameters (`FEE_BPS`, `ROLLOVER`, `SYMBOLS`, `MAX_TICKETS_PER_WALLET_PER_DAY`,
`ENGINE_INTERVAL_S`) are **stripped** on every deploy: `campaign.json` is the source of truth
and a stale value on the VM must not win over it. The dispatch writes the gates (`MEGAPOT_ACTIVE`,
`START_MS`, `END_MS`, `MEGAPOT_WHITELIST`, `DRY_RUN`, `TARGET`, `GLOBAL_BUDGET_USDC`), the feed
URLs (pinned to `app.hence.markets`), `USERS_TOKEN` (the read-only `HENCE_FEED_TOKEN`), the
retro settings (`TICKET_NFT`, `RETRO_TRANSFERS`) and the secrets below.

### Secrets to add before it can mint

| Secret (neo-hence) | What |
|---|---|
| `MEGAPOT_PRIVATE_KEY` | Pool hot wallet. **Fund with the campaign budget only** — never a treasury key. Rotation: `docs/key-rotation.md` |
| `MEGAPOT_TREASURY` | Address that receives Megapot referral fees. An address, not a key |
| `HENCE_FEED_TOKEN` | Read-only bearer for the backend feeds (users / basket / spot / active / grants). Falls back to `HENCE_ADMIN_TOKEN` from the app env with a warning |
| `CUSTOMERIO_SITE_ID`, `CUSTOMERIO_TRACK_API_KEY` | Comms (optional) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `megapot-watch` alerts (optional; the watch still fails the job without them) |

Until the wallet secrets exist the engine runs fine in `DRY_RUN=1` and mints nothing.

## 2 · Why there is no runner blocker

An earlier draft of this file told you to promote `hence-neo-vm` to an **org-level** runner so
this repo could use it. **Do not do that.** It would expose a VM holding wallet keys to every
public repo in the org, and both this repo and `hence-incognito` are public.

Deploying from the private repo removes the need entirely: no org runner, no runner groups, no
plan-tier dependency. See `neo-hence/.github/workflows/deploy-megapot.yml`.
