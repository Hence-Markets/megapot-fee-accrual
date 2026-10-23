import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFeed, feedUrlFrom, validWallet, mintedTokenIds, depositGrantBody, runDepositOffer, budgetStop, mintable, summary,
  EXPERIMENT, MAX_REVERTS } from '../src/depositOffer.js';

const NFT = '0x48ffe35abb9f4780a4f1775c2ce1c46185b366e4';
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const NOW = Date.UTC(2026, 9, 23, 12);
const DRAW_AT = 1792861200000;                          // round 214's drawingTime (s) x 1000
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/deposit-offer-receipt.json', import.meta.url), 'utf8'));
const FIXTURE_TOKEN = '103114373766593840196871383602367918495492675469604440819360948182668579672329';

const reward = (wallet, o = {}) => ({ wallet, variant: 'prize', reward_kind: 'ticket', reward_usd: 1, reward_status: 'owed', reward_ref: null,
  deposit_usd: 20, qualified_ms: NOW - 86400000, payable_after_ms: NOW - 1000, ...o });
const feedOf = (...rows) => ({ experiment: EXPERIMENT, count: rows.length, rewards: rows });

// ── a fake Base: every broadcast mines at once unless told otherwise ─────────────
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');
const tokenFor = (n) => BigInt(1_000_000 + n);
const mintReceipt = (w, n, status = 'success') => ({ status, logs: status !== 'success' ? [] : [
  { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad('0x' + '1'.repeat(40)), pad(w)], data: '0x01' },
  { address: NFT, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad('0x0'), pad(w), '0x' + tokenFor(n).toString(16).padStart(64, '0')], data: '0x' },
] });
let _chains = 0;
const hashOf = (id, n, k) => `0x${'f'.repeat(52)}${id}${String(n).padStart(4, '0')}${String(k).padStart(4, '0')}`;
function harness(s, { feed, mine = 'success', sendFails = null, waitFails = false, simulateFails = new Set(), noToken = false } = {}) {
  const chain = { nonce: 0, txs: new Map(), receipts: new Map(), broadcasts: [], signs: 0, id: String(++_chains).padStart(4, '0') };
  const saves = [];
  const io = {
    log: () => {},
    save: () => saves.push(JSON.stringify(s)),
    fetchFeed: async () => (typeof feed === 'function' ? feed() : feed),
    receipt: async (h) => chain.receipts.get(h) ?? null,
    txFound: async (h) => chain.txs.has(h),
    drawing: async () => ({ round: '214', drawAt: DRAW_AT }),
    simulate: async (w) => { if (simulateFails.has(w)) throw new Error('execution reverted'); },
    sign: async (w) => { chain.signs++; const n = chain.nonce; return { hash: hashOf(chain.id, n, chain.signs), serialized: JSON.stringify({ w, n, k: chain.signs }), nonce: n }; },
    send: async (raw) => {
      const { w, n, k } = JSON.parse(raw);
      const hash = hashOf(chain.id, n, k);
      if (sendFails === 'before') throw new Error('connection reset');          // never reached the node
      chain.broadcasts.push({ w, hash });
      chain.txs.set(hash, true);
      chain.nonce = n + 1;
      const st = typeof mine === 'function' ? mine(w, chain.broadcasts.length) : mine;
      const rc = noToken ? { status: 'success', logs: [] } : mintReceipt(w, chain.broadcasts.length, st);
      chain.receipts.set(hash, rc);
      if (sendFails === 'after') throw new Error('timeout');                    // broadcast, answer lost
      return hash;
    },
    waitReceipt: async (h) => { if (waitFails) throw new Error('process killed'); return chain.receipts.get(h); },
  };
  return { io, chain, saves };
}
const ctx = (o = {}) => ({ exp: EXPERIMENT, nft: NFT, priceUsd: 1, budgetUsd: 50, globalBudgetUsd: 1500, dryRun: false, canSend: true, nowMs: NOW, ...o });
const accountNonce = (h) => h.chain.nonce;
const grants = (s) => (s.outbox || []).filter((e) => e.kind === 'grant');

// ── feed ─────────────────────────────────────────────────────────────────────────
test('feed URL derives from USERS_URL; an explicit one wins; nothing without a wallets URL', () => {
  assert.equal(feedUrlFrom('', 'https://app.hence.markets/api/admin/wallets'), 'https://app.hence.markets/api/admin/deposit-offer/rewards?variant=prize&status=owed&due=1');
  assert.equal(feedUrlFrom('https://x/feed', 'https://app.hence.markets/api/admin/wallets'), 'https://x/feed');
  assert.equal(feedUrlFrom('', ''), '');
  assert.equal(feedUrlFrom('', 'https://app.hence.markets/other'), '');
});

test('feed parsing: only owed, due, prize-arm ticket rows with a valid wallet, lowercased, once', () => {
  const upper = '0x' + 'D'.repeat(40);
  const j = feedOf(
    reward(A), reward(upper),
    reward('0x123'), reward(null), reward('0x' + 'g'.repeat(40)), reward(' ' + B + 'ff'),
    reward(C, { variant: 'match' }), reward(C, { reward_kind: 'match' }), reward(C, { reward_status: 'issued' }),
    reward(C, { reward_ref: 'ticket-9' }), reward(C, { payable_after_ms: NOW + 60_000 }), reward(C, { payable_after_ms: null }),
    reward(A),
  );
  const out = parseFeed(j, { nowMs: NOW });
  assert.deepEqual(out.rows.map((r) => r.wallet), [A, upper.toLowerCase()]);
  assert.equal(out.rows[0].depositUsd, 20);
  assert.deepEqual(out.skipped.map((k) => k.reason), ['invalid wallet', 'invalid wallet', 'invalid wallet', 'invalid wallet',
    'variant match', 'reward_kind match', 'status issued', 'already has a reward_ref', 'not payable yet', 'not payable yet', 'duplicate row']);
  assert.ok(validWallet(A) && !validWallet('0x' + 'a'.repeat(39)) && !validWallet(undefined));
});

test('feed parsing: another experiment or a malformed body is an error, never an empty list', () => {
  assert.throws(() => parseFeed({ experiment: 'other-2027', rewards: [reward(A)] }), /experiment/);
  assert.throws(() => parseFeed({ experiment: EXPERIMENT }), /rewards/);
  assert.throws(() => parseFeed(null), /rewards/);
});

// ── receipt -> token id ──────────────────────────────────────────────────────────
test('token id comes from the ticket NFT Transfer to the recipient in a real-layout receipt', () => {
  assert.deepEqual(mintedTokenIds(FIXTURE, { nft: NFT, recipient: A }), [FIXTURE_TOKEN]);
  assert.deepEqual(mintedTokenIds(FIXTURE, { nft: NFT.toUpperCase().replace('0X', '0x'), recipient: A.toUpperCase().replace('0X', '0x') }), [FIXTURE_TOKEN], 'case-blind');
  // the USDC Transfer to the same recipient (3 topics) and a ticket to another wallet are ignored
  assert.deepEqual(mintedTokenIds(FIXTURE, { nft: NFT, recipient: B }), []);
  assert.deepEqual(mintedTokenIds(FIXTURE, { nft: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', recipient: A }), []);
  assert.deepEqual(mintedTokenIds(FIXTURE, { nft: '', recipient: A }), []);
  assert.deepEqual(mintedTokenIds({ logs: [] }, { nft: NFT, recipient: A }), []);
});

test('grant body is what POST /api/admin/megapot/grants settles the reward on', () => {
  assert.deepEqual(depositGrantBody({ wallet: A.toUpperCase().replace('0X', '0x'), tokenId: 42n, round: 214n, tx: '0xtx', drawAt: DRAW_AT, ts: 5 }),
    { wallet: A, tokenId: '42', round: '214', tx: '0xtx', kind: 'deposit-offer', drawAt: DRAW_AT, ts: 5 });
  assert.deepEqual(depositGrantBody({ wallet: A, tokenId: '7', round: '214', tx: '0xtx', drawAt: null, ts: 5 }),
    { wallet: A, tokenId: '7', round: '214', tx: '0xtx', kind: 'deposit-offer', ts: 5 }, 'no draw time read: drawAt is left out');
});

// ── the lane ─────────────────────────────────────────────────────────────────────
test('mints ONE ticket per owed wallet, queues the grant, marks issued; a second cycle mints nothing', async () => {
  const s = { wallets: {}, spentUsdc: 10 };
  const h = harness(s, { feed: feedOf(reward(A), reward(B)) });
  const r1 = await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
  assert.equal(r1.minted, 2);
  assert.deepEqual(h.chain.broadcasts.map((b) => b.w), [A, B]);
  const eA = s.depositOffer[EXPERIMENT][A];
  assert.equal(eA.status, 'issued');
  assert.equal(eA.tokenId, String(tokenFor(1)));
  assert.equal(eA.round, '214');
  assert.equal(eA.drawAt, DRAW_AT);
  assert.equal(s.depositOfferSpentUsdc[EXPERIMENT], 2);
  assert.equal(s.spentUsdc, 12, 'the lane counts toward GLOBAL_BUDGET_USDC too');
  assert.deepEqual(s.wallets, {}, 'no fee credit or day-cap ledger moves');
  assert.deepEqual(s.intents, []);
  const g = grants(s);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].body, { wallet: A, tokenId: String(tokenFor(1)), round: '214', tx: eA.tx, kind: 'deposit-offer', drawAt: DRAW_AT, ts: NOW });
  assert.equal(g[0].wallet, A);
  // the app is slow to flip the row: the feed still lists both
  const r2 = await runDepositOffer(s, ctx({ accountNonce: accountNonce(h), nowMs: NOW + 300_000 }), h.io);
  assert.equal(r2.minted, 0);
  assert.equal(r2.skipped, 2);
  assert.equal(h.chain.broadcasts.length, 2);
  assert.equal(grants(s).length, 2);
  assert.deepEqual(summary(s), { experiment: EXPERIMENT, spentUsdc: 2, issued: 2 });
});

test('crash after the broadcast, before the receipt: the restart settles it and mints nothing new', async () => {
  for (const point of ['wait', 'send-answer-lost']) {
    const s = { wallets: {}, spentUsdc: 0 };
    const h = harness(s, { feed: feedOf(reward(A)), waitFails: point === 'wait', sendFails: point === 'send-answer-lost' ? 'after' : null });
    await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
    assert.equal(h.chain.broadcasts.length, 1);
    // the process dies here: the next cycle starts from the last ledger on disk
    const disk = JSON.parse(h.saves.at(-1));
    const e = disk.depositOffer[EXPERIMENT][A];
    assert.equal(e.status, point === 'wait' ? 'pending' : 'intent', point);
    assert.equal(grants(disk).length, 0);
    const h2 = harness(disk, { feed: feedOf(reward(A)) });
    h2.chain = h.chain; Object.assign(h2.io, { receipt: h.io.receipt, txFound: h.io.txFound, send: h.io.send, sign: h.io.sign });
    const r = await runDepositOffer(disk, ctx({ accountNonce: h.chain.nonce, nowMs: NOW + 300_000 }), h2.io);
    assert.equal(h.chain.broadcasts.length, 1, `${point}: no second mint`);
    assert.equal(r.settled.issued, 1);
    assert.equal(disk.depositOffer[EXPERIMENT][A].status, 'issued');
    assert.equal(disk.depositOffer[EXPERIMENT][A].tokenId, String(tokenFor(1)));
    assert.equal(disk.depositOfferSpentUsdc[EXPERIMENT], 1, `${point}: debited exactly once`);
    assert.equal(disk.spentUsdc, 1);
    assert.equal(grants(disk).length, 1);
    assert.deepEqual(disk.intents, []);
    // and once more: still nothing
    await runDepositOffer(disk, ctx({ accountNonce: h.chain.nonce, nowMs: NOW + 600_000 }), h2.io);
    assert.equal(h.chain.broadcasts.length, 1);
    assert.equal(grants(disk).length, 1);
  }
});

test('the intent is on disk before the broadcast', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A)) });
  const send = h.io.send;
  let atSend = null;
  h.io.send = async (raw) => { atSend = JSON.parse(h.saves.at(-1)); return send(raw); };
  await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
  assert.equal(atSend.depositOffer[EXPERIMENT][A].status, 'intent');
  assert.equal(atSend.intents.length, 1);
  assert.equal(atSend.intents[0].kind, 'deposit-offer');
  assert.equal(atSend.intents[0].wallet, A);
  assert.equal(atSend.depositOfferSpentUsdc, undefined, 'no debit before the broadcast is known');
});

test('a send that never reached the node: the stale intent drops with no debit, the next cycle mints again', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A), reward(B)), sendFails: 'before' });
  await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
  assert.equal(h.chain.broadcasts.length, 0);
  assert.equal(s.depositOffer[EXPERIMENT][A].status, 'intent');
  assert.equal(s.depositOffer[EXPERIMENT][B], undefined, 'the lane stops after a failed send');
  const h2 = harness(s, { feed: feedOf(reward(A), reward(B)) });
  // within the 30 min window the intent waits and A is not minted again
  await runDepositOffer(s, ctx({ accountNonce: 0, nowMs: NOW + 5 * 60_000 }), h2.io);
  assert.deepEqual(h2.chain.broadcasts.map((b) => b.w), [B]);
  // after 30 min with the nonce never used for A's tx: dropped, then minted afresh
  const r = await runDepositOffer(s, ctx({ accountNonce: h2.chain.nonce, nowMs: NOW + 31 * 60_000 }), h2.io);
  assert.equal(r.settled.dropped, 1);
  assert.deepEqual(h2.chain.broadcasts.map((b) => b.w), [B, A]);
  const eA = s.depositOffer[EXPERIMENT][A];
  assert.equal(eA.status, 'issued');
  assert.equal(eA.attempts, 2);
  assert.equal(eA.prevTx.length, 1);
  assert.equal(s.depositOfferSpentUsdc[EXPERIMENT], 2);
});

test('budget stop: the lane ends when the budget cannot cover one more ticket', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A), reward(B), reward(C)) });
  const r = await runDepositOffer(s, ctx({ budgetUsd: 2.5, accountNonce: 0 }), h.io);
  assert.equal(r.minted, 2);
  assert.match(r.stop, /deposit-offer budget/);
  assert.equal(s.depositOffer[EXPERIMENT][C], undefined);
  assert.equal(budgetStop(s, EXPERIMENT, { priceUsd: 0.5, budgetUsd: 2.5, globalBudgetUsd: 1500 }), null, 'a cheaper ticket still fits');
});

test('GLOBAL_BUDGET_USDC still holds over the lane', async () => {
  const s = { wallets: {}, spentUsdc: 1499.5 };
  const h = harness(s, { feed: feedOf(reward(A)) });
  const r = await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
  assert.equal(r.minted, 0);
  assert.match(r.stop, /GLOBAL_BUDGET_USDC/);
  assert.equal(h.chain.broadcasts.length, 0);
});

test('DRY_RUN prints what it would mint and moves nothing', async () => {
  const s = { wallets: {}, spentUsdc: 0, depositOffer: { [EXPERIMENT]: { [B]: { status: 'issued', tx: '0xold', tokenId: '9' } } }, depositOfferSpentUsdc: { [EXPERIMENT]: 1 } };
  const before = JSON.stringify(s);
  const h = harness(s, { feed: feedOf(reward(A), reward(B), reward(C)) });
  const lines = [];
  h.io.log = (m) => lines.push(m);
  for (const k of ['sign', 'send', 'simulate', 'waitReceipt', 'save']) h.io[k] = () => { throw new Error(`${k} called in DRY_RUN`); };
  const r = await runDepositOffer(s, ctx({ dryRun: true, budgetUsd: 2 }), h.io);
  assert.deepEqual(r.wouldMint, [A], 'B already issued; C is past the $2 budget');
  assert.match(r.stop, /budget/);
  assert.ok(lines.some((l) => l.includes(`${A} WOULD mint 1 deposit-offer ticket`)));
  assert.equal(JSON.stringify(s), before, 'ledger untouched');
  assert.equal(h.chain.broadcasts.length, 0);
});

test('a revert refunds and retries; after MAX_REVERTS the wallet fails for a human', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A)), mine: 'reverted' });
  for (let i = 0; i < MAX_REVERTS + 1; i++) await runDepositOffer(s, ctx({ accountNonce: h.chain.nonce, nowMs: NOW + i * 300_000 }), h.io);
  assert.equal(h.chain.broadcasts.length, MAX_REVERTS);
  assert.equal(s.depositOffer[EXPERIMENT][A].status, 'failed');
  assert.equal(s.depositOfferSpentUsdc[EXPERIMENT], 0);
  assert.equal(s.spentUsdc, 0);
  assert.equal(grants(s).length, 0);
  assert.equal(mintable(s, EXPERIMENT, A), false);
});

test('a would-revert simulation skips the wallet with no intent; the others still mint', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A), reward(B)), simulateFails: new Set([A]) });
  await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
  assert.deepEqual(h.chain.broadcasts.map((b) => b.w), [B]);
  assert.equal(s.depositOffer[EXPERIMENT][A], undefined);
});

test('mined with no ticket Transfer to the wallet: no grant, never re-minted', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A)), noToken: true });
  await runDepositOffer(s, ctx({ accountNonce: 0 }), h.io);
  await runDepositOffer(s, ctx({ accountNonce: h.chain.nonce, nowMs: NOW + 300_000 }), h.io);
  assert.equal(h.chain.broadcasts.length, 1);
  assert.equal(s.depositOffer[EXPERIMENT][A].status, 'no-token');
  assert.equal(grants(s).length, 0);
  assert.equal(s.depositOfferSpentUsdc[EXPERIMENT], 1, 'the USDC was spent');
});

test('held sends and an unreachable feed mint nothing', async () => {
  const s = { wallets: {}, spentUsdc: 0 };
  const h = harness(s, { feed: feedOf(reward(A)) });
  let r = await runDepositOffer(s, ctx({ canSend: false, holdReason: 'pool wallet low on funds', accountNonce: 0 }), h.io);
  assert.equal(r.minted, 0);
  const h2 = harness(s, { feed: () => { throw new Error('HTTP 503'); } });
  r = await runDepositOffer(s, ctx({ accountNonce: 0 }), h2.io);
  assert.match(r.feedError, /503/);
  assert.equal(h.chain.broadcasts.length + h2.chain.broadcasts.length, 0);
  assert.equal(s.depositOffer, undefined);
});
