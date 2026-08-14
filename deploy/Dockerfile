# The accrual engine. A scheduled BATCH job, not a web service — it holds the pool wallet key,
# keeps a ledger on disk, and moves money. That is why it belongs on the VM and not on a
# serverless host: ephemeral functions would lose state/ledger.json between runs, and a hot
# wallet key has no business in a serverless secret store.
FROM node:22-alpine AS engine
WORKDIR /app/engine

# deps first so a code change does not reinstall the world
COPY engine/package.json engine/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY engine/ ./
# campaign.json lives at the repo root and is read by BOTH engine and UI — one controller.
COPY campaign.json /app/campaign.json
COPY deploy/run_engine.sh /app/run_engine.sh
RUN chmod +x /app/run_engine.sh

# state/ is a volume in compose — the ledger and checkpoints MUST survive a container rebuild,
# or a redeploy would re-credit fills that were already paid.
RUN mkdir -p /app/engine/state
ENV CAMPAIGN_FILE=/app/campaign.json

CMD ["/app/run_engine.sh"]
