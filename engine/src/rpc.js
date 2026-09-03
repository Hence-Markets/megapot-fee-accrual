// RPC transport rules - PURE helpers + a thin viem shell (end-to-end in test/rpc.test.js).
// Production ran every buy cycle through ONE public node (mainnet.base.org) and its
// 'over rate limit' (-32016) answers stalled whole cycles. RPC now takes a comma-
// separated list, tried in order (viem fallback with rank:false so the operator's
// order holds), each url with a 10 s timeout; a node that rate-limits us is skipped
// for the next url and reported once an hour through the engine's alert helper.
import { fallback, http } from 'viem';

export const DEFAULT_RPCS = {
  mainnet: ['https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io', 'https://1rpc.io/base'],
  testnet: ['https://sepolia.base.org'],
};
export const RPC_TIMEOUT_MS = 10_000;           // per url; the fallback moves on after it

/** 'a, b,,c' -> ['a','b','c']; blank -> the network's defaults */
export function parseRpcList(raw, defaults = []) {
  const list = String(raw || '').split(',').map((u) => u.trim()).filter(Boolean);
  return list.length ? list : [...defaults];
}

/** a rate-limit answer: JSON-RPC -32016 (Base's 'over rate limit') or -32005, HTTP 429,
 *  or a node saying so in words - checked down the cause chain viem wraps errors in */
export function isRateLimited(e) {
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) {
    if (x.code === -32016 || x.code === -32005 || x.status === 429) return true;
    if (/rate limit|too many requests/i.test(String(x.details || x.message || ''))) return true;
  }
  return false;
}

/** one fallback transport over `urls` in order; two retries over the whole list */
export const rpcTransport = (urls) => fallback(urls.map((u) => http(u, { timeout: RPC_TIMEOUT_MS })), { rank: false, retryCount: 2 });

/** report the url behind every rate-limited answer a client gets (the fallback hides it) */
export function watchRateLimits(client, onUrl) {
  client.transport.onResponse?.(({ status, error, transport }) => {
    if (status === 'error' && isRateLimited(error)) onUrl(String(transport?.value?.url || 'unknown'));
  });
}
