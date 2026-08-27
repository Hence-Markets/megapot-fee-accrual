// Unified comms/analytics emitter: every campaign event goes to BOTH
// Customer.io (messaging workflows) and PostHog (monitoring) - each leg
// independently fail-open, so an outage on one never silences the other
// and neither can ever stall the money path.
import { cfg } from './config.js';
import { cioTrack, cioEnabled } from './cio.js';

export const phEnabled = () => !!cfg.POSTHOG_KEY;
export const commsEnabled = () => cioEnabled() || phEnabled();

async function phCapture(wallet, name, data = {}) {
  if (!phEnabled()) return false;
  try {
    const r = await fetch(`${cfg.POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.POSTHOG_KEY,
        event: name,
        distinct_id: wallet,
        properties: { ...data, source: 'megapot-engine', $process_person_profile: true },
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) console.log(`[posthog] ${name} -> ${r.status}`);
    return r.ok;
  } catch (e) {
    console.log(`[posthog] ${name} failed: ${e.message}`);
    return false;
  }
}

export async function track(wallet, name, data = {}) {
  await Promise.allSettled([cioTrack(wallet, name, data), phCapture(wallet, name, data)]);
}
