# Pool wallet key rotation — runbook

When: the key is suspected leaked, someone with docker-group access on the VM leaves, or on a
schedule between seasons. The key sits in the container env (`docker inspect` shows it to anyone
in the docker group), so treat "someone had VM access" as "someone had the key".

Six steps, in this order. Nothing here touches the ledger; user credit and purchase history
survive a key change untouched because the ledger is keyed by user wallet, not by the pool key.

1. **Generate the new key** locally, offline (`cast wallet new` or `node -e "console.log(require('viem/accounts').generatePrivateKey())"`).
   Record the address. Never paste the key into chat, an issue, a workflow input or a log.
2. **Fund the new wallet** on Base: enough USDC for the remaining budget you intend to move
   (see step 5) plus ~0.01 ETH for gas. Confirm on Basescan before continuing.
3. **Update the GitHub secret** `MEGAPOT_PRIVATE_KEY` in `Hence-Markets/neo-hence` (Settings →
   Secrets → Actions). Keep the old key available offline until step 5 is done.
4. **Redeploy via dispatch** — Actions → `deploy-megapot` with the current live inputs
   (`AGENTS.md`), same `ref`. The workflow rewrites `deploy/.env` with the new key and recreates
   the container. Watch the "Confirm the safety posture" step (`pool wallet key: present`) and
   the first cycle's log: `standing allowance set` on the new address, then `bought` / `transferred`.
   Run `megapot-diagnostics`: `pool wallet` must print the NEW address.
5. **Sweep the old wallet**: transfer remaining USDC and ETH from the old address to the new one
   (or treasury), and any pool-held Megapot TicketNFTs of the active round (retro inventory) to
   the new address. Do this yourself from a wallet you control; no workflow moves funds out.
   Then destroy the old key.
6. **Verify the referrer**: Megapot referral fees (`claimReferralFees`) accrue to `TREASURY`,
   which is an address secret (`MEGAPOT_TREASURY`) and does not change with the key — confirm
   it is still set in `.env` (diagnostics prints it) and that the next `bought` line carries the
   referrer. Post the new pool address in the ops channel and update the watch thresholds if the
   funding level changed.

Rollback: re-set the secret to the old key and redeploy (step 4). Only possible until step 5.
