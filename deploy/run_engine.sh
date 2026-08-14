#!/bin/sh
# accrue → buy on an interval. Same shape as neo-hence's pipeline container: loop in-process
# rather than host cron, so the schedule ships with the deployment and survives a VM reboot.
set -u
INTERVAL="${ENGINE_INTERVAL_S:-3600}"

echo "[megapot] starting · interval=${INTERVAL}s · DRY_RUN=${DRY_RUN:-1} · TARGET=${TARGET:-testnet}"
if [ "${DRY_RUN:-1}" = "0" ]; then
  echo "[megapot] *** DRY_RUN=0 — this WILL spend from the pool wallet ***"
fi

while true; do
  echo "[megapot] $(date -u) accrue"
  node src/run.js accrue || echo "[megapot] accrue failed (continuing)" >&2
  # buy only ever spends against credit the accrue step already recorded, and is capped
  # per-wallet and globally by the campaign sheet. A failure here must not kill the loop —
  # the next pass retries from the checkpoint.
  echo "[megapot] $(date -u) buy"
  node src/run.js buy || echo "[megapot] buy failed (continuing)" >&2
  node src/run.js status || true
  sleep "$INTERVAL"
done
