// Unified comms/analytics emitter: every campaign event goes to BOTH
// Customer.io (messaging workflows) and PostHog (monitoring) - each leg
// independently fail-open, so an outage on one never silences the other
// and neither can ever stall the money path. Callers get per-leg results
// (true 2xx / false failed / null disabled) so the ledger outbox can retry
// exactly the leg that failed.
import { cfg } from './config.js';
import { cioTrack, cioEnabled } from './cio.js';

export const phEnabled = () => !!cfg.POSTHOG_KEY;
export const commsEnabled = () => cioEnabled() || phEnabled();

async function phCapture(wallet, name, data = {}) {
  if (!phEnabled()) return null;
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

/** both legs; `skip` = legs already delivered ({cio:true} / {ph:true}) */
export async function trackLegs(wallet, name, data = {}, skip = {}) {
  const [c, p] = await Promise.allSettled([
    skip.cio ? null : (cioEnabled() ? cioTrack(wallet, name, data) : null),
    skip.ph ? null : phCapture(wallet, name, data),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : false);
  return { cio: skip.cio ? null : val(c), ph: skip.ph ? null : val(p) };
}
export async function track(wallet, name, data = {}) {
  const r = await trackLegs(wallet, name, data);
  return r.cio !== false && r.ph !== false;
}

/** report a retro ticket grant to the hence backend (hub labels it) */
export async function postGrant(body) {
  if (!cfg.GRANTS_URL) return null;
  try {
    const r = await fetch(cfg.GRANTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.USERS_TOKEN ? { Authorization: `Bearer ${cfg.USERS_TOKEN}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.log(`[grants] ${r.status}`);
    return r.ok;
  } catch (e) {
    console.log(`[grants] failed: ${e.message}`);
    return false;
  }
}
