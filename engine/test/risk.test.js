import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskRulesFor, roiRoomTickets, noteFree } from '../src/risk.js';

const RISK = { wallets: ['0xAbC0000000000000000000000000000000000001'], countries: ['HK'], firstTradeMinUsd: 2000, roiMultiple: 1.1 };

test('cohort membership: listed wallet (any case) or listed country; nobody else', () => {
  assert.equal(riskRulesFor(RISK, '0xabc0000000000000000000000000000000000001', null)?.via, 'wallet');
  assert.equal(riskRulesFor(RISK, '0x' + '2'.repeat(40), 'hk')?.via, 'country');
  assert.equal(riskRulesFor(RISK, '0x' + '2'.repeat(40), 'AU'), null);
  assert.equal(riskRulesFor(RISK, '0x' + '2'.repeat(40), null), null);
  assert.equal(riskRulesFor(null, '0xabc0000000000000000000000000000000000001', 'HK'), null);
  assert.equal(riskRulesFor(RISK, '0xabc0000000000000000000000000000000000001', 'HK').firstTradeMinUsd, 2000);
});

test('ROI room: free tickets release only once fees cover roiMultiple x everything free so far', () => {
  const rules = riskRulesFor(RISK, '0xabc0000000000000000000000000000000000001', null);
  const ws = { feesUsd: 0, roiFreeUsd: 0 };
  assert.equal(roiRoomTickets(ws, rules, 1), 0);               // nothing earned -> nothing free
  ws.feesUsd = 1.0;  assert.equal(roiRoomTickets(ws, rules, 1), 0);   // $1.00 < 1.1 x $1
  ws.feesUsd = 1.1;  assert.equal(roiRoomTickets(ws, rules, 1), 1);   // exactly covers one
  ws.feesUsd = 3.3;  assert.equal(roiRoomTickets(ws, rules, 1), 3);
  noteFree(ws, 2, 1);                                            // two free tickets handed out
  assert.equal(roiRoomTickets(ws, rules, 1), 1);                 // 3.3/1.1 - 2 = 1 left
  noteFree(ws, 1, 1);
  assert.equal(roiRoomTickets(ws, rules, 1), 0);
  // a $5 pack at $1 tickets: $5.50 of fees must land before the next free ticket
  const w2 = { feesUsd: 5.49, roiFreeUsd: 5 }; assert.equal(roiRoomTickets(w2, rules, 1), 0);
  w2.feesUsd = 6.6; assert.equal(roiRoomTickets(w2, rules, 1), 1);
});

test('at 4bps a cohort wallet must trade ~$2,750 of volume per free ticket', () => {
  const rules = riskRulesFor(RISK, '0xabc0000000000000000000000000000000000001', null);
  const feeBps = 4; const volumeForOne = (1.1 / (feeBps / 10_000));
  const ws = { feesUsd: volumeForOne * feeBps / 10_000, roiFreeUsd: 0 };
  assert.equal(Math.round(volumeForOne), 2750);
  assert.equal(roiRoomTickets(ws, rules, 1), 1);
});
