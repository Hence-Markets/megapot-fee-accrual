# Ledger backups

The engine ledger (`state/ledger.<target>.json` + checkpoints) lives in one Docker volume,
`megapot_ledger`, on the Hence VM. It is the only record of which fills were credited, which packs
were drawn and which purchases are pending reconcile. Losing it means re-crediting every fill since
`START_MS` and re-drawing every pack.

## What runs

`deploy/backup_ledger.sh`, hourly from the VM crontab (line in `deploy/README.md`):

- reads the volume from a throwaway `alpine` container, read-only — works whether or not the engine
  is up and never touches the engine container
- writes `~/megapot-backups/ledger-<epoch>.tgz` (mode 600, dir 700)
- keeps 7 days locally (`MEGAPOT_BACKUP_KEEP_DAYS`)
- optional off-VM copy with `rclone copy` to `MEGAPOT_BACKUP_REMOTE` (any configured remote:
  Cloudflare R2, GCS, Drive). Skipped silently when unset or rclone is absent. **Set it up** —
  a local-only backup does not survive a VM rebuild.

`megapot-diagnostics` prints the newest backup's age; `megapot-watch` alerts when it is older than
3 hours.

## Restore

1. Pause the engine: `deploy-megapot` dispatch with `active=0`, or on the VM
   `cd ~/megapot/deploy && docker compose stop engine`.
2. Pick the archive: `ls -la ~/megapot-backups/`. Check it: `tar tzf ledger-<epoch>.tgz` must list
   `ledger.mainnet.json`.
3. Inspect before restoring — the archive may predate purchases that already settled on chain:
   `tar xzf ledger-<epoch>.tgz -O ./ledger.mainnet.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);console.log("wallets",Object.keys(l.wallets||{}).length,"spent",l.spentUsdc,"purchases",(l.purchases||[]).length)})'`
   Compare with the on-chain state (Basescan on the pool wallet) for the gap between the backup
   time and now. Purchases made after the backup exist on chain but not in the archive; the
   engine's reconcile will not know about them, so their credit would be spent again. For every
   such tx, note the wallet and count.
4. Restore into the volume:
   ```
   docker run --rm -v megapot_ledger:/state -v ~/megapot-backups:/in:ro alpine:3.20 \
     sh -c 'rm -f /state/.lock* && tar xzf /in/ledger-<epoch>.tgz -C /state'
   ```
5. Re-apply the gap from step 3 by hand in a supervised session (debit the credit for tickets
   already minted, using the same shape as existing `purchases[]` rows), or accept the double
   mint for a small gap and note it in the ops log.
6. Start the engine (`active=1` redeploy, or `docker compose start engine`) and watch one full
   cycle: no wallet should log a large re-credit.

## Fresh-start guard

A mainnet engine must never start on an empty ledger while a backup exists. The engine-side check
lands with `feat/engine-safety`; until then, if `docker compose ps` shows a fresh container and the
log's first accrue credits a large amount, stop it (`active=0`) and restore.
