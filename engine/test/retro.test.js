import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterInventory, allocateRetro, grantBody } from '../src/retro.js';
import { userCapLeft } from '../src/users.js';

const POOL = '0xBC54e516405A959746E3531d81Ea656DCc687A82';
const row = (id, o = {}) => ({ wallet: POOL, round_id: '163', user_ticket_id: id, claimed: false, winnings_amount: null, ...o });

test('inventory = active round, unclaimed, no winnings, owned by the pool, unique numeric ids', () => {
  const rows = [
    row('11'), row('12'),
    row('13', { round_id: '162' }),                                   // settled round: a receipt, not inventory
    row('14', { claimed: true }),
    row('15', { winnings_amount: { amount: '2500000', decimals: 6 } }), // a winner: never re-gifted
    row('16', { wallet: '0x' + '9'.repeat(40) }),
    row('11'), row('x'), row(undefined),
  ];
  assert.deepEqual(filterInventory(rows, { activeRound: '163', pool: POOL }), ['11', '12']);
  assert.deepEqual(filterInventory(rows, { activeRound: null, pool: POOL }), []);
});

test('allocation: inventory covers what it can, the remainder buys with USDC, never over count', () => {
  assert.deepEqual(allocateRetro(3, ['a', 'b', 'c', 'd']), { tokenIds: ['a', 'b', 'c'], usdcCount: 0 });
  assert.deepEqual(allocateRetro(5, ['a', 'b']), { tokenIds: ['a', 'b'], usdcCount: 3 });
  assert.deepEqual(allocateRetro(0, ['a']), { tokenIds: [], usdcCount: 0 });
  assert.deepEqual(allocateRetro(2, []), { tokenIds: [], usdcCount: 2 });
});

test('retro tickets sit under the per-user cap: inventory x count x caps', () => {
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
  const now = Date.UTC(2026, 8, 5, 12), day = '2026-09-05';
  const s = { users: { [A]: 'u1', [B]: 'u1' }, wallets: { [A]: { creditUsdc: 7, tickets: {} }, [B]: { creditUsdc: 0, tickets: { [day]: 3 } } } };
  const caps = { perDay: 5, perWeek: 15 };
  const owed = Math.min(Math.floor(s.wallets[A].creditUsdc / 1), userCapLeft(s, A, day, caps, now), 10);
  assert.equal(owed, 2, 'user u1 already minted 3 today on wallet B');
  const alloc = allocateRetro(owed, ['1', '2', '3', '4']);
  assert.deepEqual(alloc, { tokenIds: ['1', '2'], usdcCount: 0 });
  s.wallets[A].tickets[day] = alloc.tokenIds.length;                     // retro counts toward the cap
  assert.equal(userCapLeft(s, A, day, caps, now), 0);
  assert.equal(userCapLeft(s, B, day, caps, now), 0);
});

test('grant body is what the hub expects', () => {
  const b = grantBody({ wallet: '0xw', tokenId: 42n, round: 163, tx: '0xtx', ts: 5 });
  assert.deepEqual(b, { wallet: '0xw', tokenId: '42', round: '163', tx: '0xtx', kind: 'retro', ts: 5 });
});

// ── transferred-ticket wins: the venue files a retro ticket under the pool for good ──
import { attributeTransferredWins, transfersFromLedger, winGrantBody, claimTxOf } from '../src/retro.js';

const USER = '0x' + 'a'.repeat(40), OTHER = '0x' + 'b'.repeat(40), STRANGER = '0x' + 'c'.repeat(40);
const win = (id, o = {}) => row(id, { winnings_amount: { amount: '3590000', decimals: 6 }, ...o });   // $3.59 like round 163

test('transferred wins: pool keeps its own, an enrolled holder gets the row re-homed, unknown holders are reported', () => {
  const rows = [win('36558827'), win('81440122'), win('64941950'), win('11', { winnings_amount: null }), win('12', { winnings_amount: { amount: '0', decimals: 6 } })];
  const owners = { 36558827: POOL.toUpperCase(), 81440122: USER.toUpperCase(), 64941950: STRANGER, 11: USER, 12: USER };
  const unknown = [];
  const out = attributeTransferredWins(rows, owners, [USER, OTHER], { pool: POOL, onUnknown: (id, owner) => unknown.push([id, owner]) });
  assert.deepEqual(out.map((x) => x.wallet), [USER], 'only the enrolled holder; the pool win stays the pool\'s, no-winnings rows are ignored');
  const r = out[0].row;
  assert.equal(r._wallet, USER);
  assert.equal(r._source, 'retro');
  assert.equal(r.claimed, false, 'still held on-chain = not claimed');
  assert.equal(r.user_ticket_id, '81440122');
  assert.equal(r.wallet, POOL, 'the venue row itself is untouched apart from the re-home fields');
  assert.deepEqual(unknown, [['64941950', STRANGER]], 'a holder outside the ledger is reported once, not attributed');
});

test('transferred wins: a burned winner is a claimed one, attributed through the ledger transfer record', () => {
  const rows = [win('72536798'), win('100575790')];
  const owners = { 72536798: null, 100575790: null };                 // ownerOf reverted: claimed on megapot.io
  const transfers = { 72536798: { wallet: USER, tx: '0xtx1', ts: 5 } };
  const unknown = [];
  const out = attributeTransferredWins(rows, owners, [USER], { pool: POOL, transfers, onUnknown: (id, owner) => unknown.push([id, owner]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].wallet, USER);
  assert.equal(out[0].row.claimed, true);
  assert.equal(out[0].row.claimedOnChain, true);
  assert.equal(out[0].row._tx, '0xtx1');
  assert.equal(out[0].row._ts, 5);
  assert.deepEqual(unknown, [['100575790', null]], 'burned with no record: nobody to hand it to');
});

test('transferred wins: chain beats ledger for a live ticket; venue claimed flag is never downgraded; unread ids skip', () => {
  const rows = [win('1', { claimed: true }), win('2'), win('3')];
  const owners = { 1: USER, 2: OTHER };                                 // '3' was not read this sweep
  const transfers = { 2: { wallet: USER, tx: '0xold' } };                // ledger says USER, chain says OTHER
  const out = attributeTransferredWins(rows, owners, [USER, OTHER], { pool: POOL, transfers });
  assert.deepEqual(out.map((x) => [x.wallet, x.row.claimed, x.row._tx]), [[USER, true, undefined], [OTHER, false, undefined]]);
  assert.deepEqual(attributeTransferredWins(rows, {}, [USER], { pool: POOL }), [], 'nothing resolved = nothing attributed');
  assert.deepEqual(attributeTransferredWins(rows, undefined, [USER], { pool: POOL }), []);
});

test('transfer records: retro purchases first (tx/ts), then win markers already on a wallet; refunds do not count', () => {
  const s = {
    wallets: { [USER]: { cioWins: { 5: 'notified', 'abc#0': 'claimed' } }, [OTHER]: { cioWins: { 6: 'pending' } } },
    purchases: [
      { kind: 'retro', wallet: USER.toUpperCase(), tokenId: '7', tx: '0xt7', ts: 70 },
      { kind: 'retro', wallet: OTHER, tokenId: '8', tx: '0xt8', ts: 80, refunded: true },
      { kind: 'usdc', wallet: OTHER, tx: '0xu', ts: 90 },
      { kind: 'retro', wallet: OTHER, tokenId: 5, tx: '0xt5', ts: 50 },
    ],
  };
  assert.deepEqual(transfersFromLedger(s), { 5: { wallet: OTHER, tx: '0xt5', ts: 50 }, 6: { wallet: OTHER }, 7: { wallet: USER, tx: '0xt7', ts: 70 } });
  assert.deepEqual(transfersFromLedger({}), {});
});

test('win grant upsert carries the win on top of the original grant fields', () => {
  const b = winGrantBody({ wallet: USER, tokenId: 81440122n, round: 163, tx: '0xtx', ts: 5, winningsUsd: 3.5899999, claimed: false, settledAt: 99 });
  assert.deepEqual(b, { wallet: USER, tokenId: '81440122', round: '163', kind: 'retro', tx: '0xtx', ts: 5, winningsUsd: 3.59, claimed: false, settledAt: 99 });
  const c = winGrantBody({ wallet: USER, tokenId: '72536798', round: '163', winningsUsd: 3.59, claimed: true, claimedTx: '0xclaim', settledAt: 100 });
  assert.deepEqual(c, { wallet: USER, tokenId: '72536798', round: '163', kind: 'retro', winningsUsd: 3.59, claimed: true, claimedTx: '0xclaim', settledAt: 100 }, 'tx/ts omitted when the ledger no longer knows the transfer');
  assert.equal(winGrantBody({ wallet: USER, tokenId: 1, winningsUsd: 1.1234567, claimed: 'yes' }).winningsUsd, 1.123457, '6dp');
  assert.equal(winGrantBody({ wallet: USER, tokenId: 1, claimed: 'yes' }).claimed, false, 'claimed is a strict boolean');
  assert.equal(typeof winGrantBody({ wallet: USER, tokenId: 1 }).settledAt, 'number');
  assert.equal(claimTxOf({ claim_tx_hash: '0xc' }), '0xc');
  assert.equal(claimTxOf({}), undefined);
});
