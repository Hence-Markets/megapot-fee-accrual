#!/bin/sh
# accrue → buy on an interval. Same shape as neo-hence's pipeline container: loop in-process
# rather than host cron, so the schedule ships with the deployment and survives a VM reboot.
set -u
INTERVAL="${ENGINE_INTERVAL_S:-300}"
FAST="${ENGINE_FAST_S:-15}"

# Graceful stop. compose runs us under tini (`init: true`), which forwards SIGTERM here. POSIX sh
# runs a trap only once the foreground child has exited, so a TERM that lands mid-`buy` lets that
# buy finish (and persist its tx hash) and we exit BETWEEN steps, never inside one. The node
# steps are not signalled at all — that is deliberate. `stop_grace_period` (120 s) is the ceiling.
STOP=0
on_term() { STOP=1; echo "[megapot] SIGTERM received - finishing the current step, then exiting"; }
trap on_term TERM INT
# Called between steps: exit 0 (clean, so `restart: unless-stopped` does not fight `docker stop`).
step_gate() { if [ "$STOP" = 1 ]; then echo "[megapot] stopped cleanly after step: $1"; exit 0; fi; }

echo "[megapot] starting · interval=${INTERVAL}s · fast lane every ${FAST}s · DRY_RUN=${DRY_RUN:-1} · TARGET=${TARGET:-testnet}"
if [ "${DRY_RUN:-1}" = "0" ]; then
  echo "[megapot] *** DRY_RUN=0 — this WILL spend from the pool wallet ***"
fi

while true; do
  echo "[megapot] $(date -u) accrue"
  node src/run.js accrue || echo "[megapot] accrue failed (continuing)" >&2
  step_gate accrue
  # buy only ever spends against credit the accrue step already recorded, and is capped
  # per-wallet and globally by the campaign sheet. A failure here must not kill the loop —
  # the next pass retries from the checkpoint.
  echo "[megapot] $(date -u) buy"
  node src/run.js buy || echo "[megapot] buy failed (continuing)" >&2
  step_gate buy
  # win sweep + daily lifecycle status (comms only; never touches the wire)
  node src/run.js winsweep || echo "[megapot] winsweep failed (continuing)" >&2
  step_gate winsweep
  node src/run.js status || true
  step_gate status
  # fast lane between sweeps: accrue + buy ONLY for wallets with a fresh execution
  # receipt (backend feed), so a validated trade mints within seconds
  elapsed=0
  while [ "$elapsed" -lt "$INTERVAL" ]; do
    sleep "$FAST"; elapsed=$((elapsed + FAST))
    step_gate sleep
    node src/run.js fast || echo "[megapot] fast lane failed (continuing)" >&2
    step_gate fast
  done
done
