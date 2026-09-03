#!/bin/sh
# Hourly backup of the engine ledger volume. Run from cron on the VM (see deploy/README.md).
#
#   ~/megapot-backups/ledger-<epoch>.tgz     tar.gz of the whole `megapot_ledger` volume
#                                            (ledger.<target>.json, checkpoints, heartbeat)
#
# Why: the ledger is the only record of which fills were already credited and which packs were
# drawn. It lives in ONE docker volume. A volume prune or a VM rebuild would start the engine
# fresh from START_MS and re-credit every fill since Sept 2. This is the cheapest insurance.
#
# The read is done from a throwaway alpine container mounting the volume read-only, so it works
# whether or not the engine is running and never touches the engine's own filesystem. tar of a
# file the engine is mid-write on is fine: ledger writes are atomic (write temp + rename).
#
# Optional off-VM copy: set MEGAPOT_BACKUP_REMOTE to an rclone destination (e.g. `r2:megapot-ledger`
# or `gdrive:megapot-backups`) in the crontab line and have `rclone config` done for that remote.
# If rclone is not installed or the variable is empty this step is skipped silently.
set -eu

VOLUME="${MEGAPOT_LEDGER_VOLUME:-megapot_ledger}"     # compose project `megapot` + volume `ledger`
OUT="${MEGAPOT_BACKUP_DIR:-$HOME/megapot-backups}"
KEEP_DAYS="${MEGAPOT_BACKUP_KEEP_DAYS:-7}"
REMOTE="${MEGAPOT_BACKUP_REMOTE:-}"

mkdir -p "$OUT"
chmod 700 "$OUT"

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "[backup] volume $VOLUME not found - nothing to back up" >&2
  exit 1
fi

TS=$(date -u +%s)
FILE="$OUT/ledger-$TS.tgz"
TMP="$FILE.part"

docker run --rm \
  -v "$VOLUME:/state:ro" \
  -v "$OUT:/out" \
  alpine:3.20 \
  sh -c "tar czf /out/$(basename "$TMP") -C /state ." \
  || { rm -f "$TMP"; echo "[backup] tar failed" >&2; exit 1; }
mv "$TMP" "$FILE"
chmod 600 "$FILE"

# sanity: an empty archive means the volume was empty (engine never ran) or the mount was wrong
n=$(tar tzf "$FILE" | grep -c 'ledger\.' || true)
echo "[backup] $(date -u +%FT%TZ) wrote $FILE ($(du -h "$FILE" | cut -f1), $n ledger file(s))"
[ "$n" -gt 0 ] || echo "[backup] WARNING: archive has no ledger.*.json - check the volume name ($VOLUME)" >&2

# retention: keep KEEP_DAYS days locally
find "$OUT" -name 'ledger-*.tgz' -type f -mtime +"$KEEP_DAYS" -delete

# optional off-VM copy
if [ -n "$REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy --quiet "$FILE" "$REMOTE/" && echo "[backup] copied to $REMOTE" \
    || echo "[backup] WARNING: rclone copy to $REMOTE failed" >&2
fi
