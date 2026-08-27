// Customer.io Track API client — comms must NEVER stall or fail the money
// path: every call is fail-open with a hard timeout, and a missing key
// disables the whole integration silently. Profiles are keyed by WALLET
// (lowercase) — the one id both the engine and the backend always know;
// serve.py attaches email + consent to the same profile at email-bind.
import { cfg } from './config.js';

export const cioEnabled = () => !!(cfg.CIO_SITE_ID && cfg.CIO_TRACK_KEY);

async function call(method, path, body) {
  if (!cioEnabled()) return false;
  try {
    const r = await fetch(`https://track.customer.io/api/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${cfg.CIO_SITE_ID}:${cfg.CIO_TRACK_KEY}`).toString('base64'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) console.log(`[cio] ${method} ${path} -> ${r.status}`);
    return r.ok;
  } catch (e) {
    console.log(`[cio] ${method} ${path} failed: ${e.message}`);
    return false;
  }
}

export const cioTrack = (wallet, name, data = {}) =>
  call('POST', `/customers/${wallet}/events`, { name, data });
export const cioIdentify = (wallet, attrs = {}) =>
  call('PUT', `/customers/${wallet}`, attrs);
