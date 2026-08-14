# Deploying Megapot

Three separable pieces. Only one of them is a website, and only one needs the VM.

| Piece | Where it runs | Why |
|---|---|---|
| **Engine** (`engine/`) | **GCP VM**, own compose stack | Scheduled batch job, holds the pool wallet key, keeps a ledger on disk |
| **Demo UI** (`web/`) | **GitHub Pages** (static export) | No secrets, no server. Nothing to gain from the VM |
| **In-app screen** | `neo-hence` branch `test/megapot-reward-hub` | Just a merge; `main` auto-deploys |

**No Vercel anywhere.** Adding it would mean a second deploy surface and a second secrets store —
and the thing most likely to end up in it is a hot wallet key.

## 1 · Engine on the VM

Its own compose project (`name: megapot`), so it can be rebuilt or deleted without touching the
Hence stack. **No published ports** — the engine has no inbound surface at all; it only makes
outbound calls to Base and the Hyperliquid fills API.

```bash
ssh <vm> && cd ~/megapot/deploy
cp .env.example .env      # then set it via the workflow, not by hand
docker compose up -d --build
docker compose logs -f engine
```

The `ledger` volume is not optional. `state/ledger.json` records which fills have already been
credited; losing it re-credits them on the next accrue, which is the one failure mode that
costs real money.

### Operating it

**Deployment is dispatched from `neo-hence`, not from this repo** — Actions → **deploy-megapot**.
It checks this repo out by ref, syncs it to the VM, writes `.env` from secrets held there, and
recreates the container.

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

### Secrets to add before it can mint

| Secret | What |
|---|---|
| `MEGAPOT_PRIVATE_KEY` | Pool hot wallet. **Fund with the campaign budget only** — never a treasury key |
| `MEGAPOT_TREASURY` | Address that receives Megapot referral fees. An address, not a key |

Until these exist the engine runs fine in `DRY_RUN=1` and mints nothing.

## 2 · Demo UI

Built and published by the `pages` workflow on every push to `main` that touches `web/`.

**This previously shipped an empty site.** The `gh-pages` branch had a commit titled
*"deploy: Reward Hub static export"* containing only `.nojekyll`, and the URL 404'd — `web/`
had no `output: 'export'`, so `next build` produced a *server* build and there was no `out/` to
publish. Pages reported success because it successfully published nothing. The config now
exports (21 files, verified), and the workflow **fails loudly** if the export is empty rather
than shipping a silent 404 again.

### Putting it on `megapot.hence.markets`

Pages, not the VM — it is static and the VM stack has no web surface to attach it to.

1. `echo megapot.hence.markets > web/public/CNAME`
2. set `basePath`/`assetPrefix` to `''` (drop `DEPLOY_TARGET=pages`) — those exist only because
   Pages serves from a repo subpath; on a custom domain the site is at the root
3. Cloudflare DNS: `CNAME megapot → hence-markets.github.io`, proxied

Do **not** add it to the Cloudflare Tunnel — that is for services on the VM, and routing a
static site through it buys nothing.

## 3 · Why there is no runner blocker

An earlier draft of this file told you to promote `hence-neo-vm` to an **org-level** runner so
this repo could use it. **Do not do that.** It would expose a VM holding wallet keys to every
public repo in the org, and both this repo and `hence-incognito` are public.

Deploying from the private repo removes the need entirely: no org runner, no runner groups, no
plan-tier dependency. See `neo-hence/.github/workflows/deploy-megapot.yml`.
