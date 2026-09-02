import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAK_BOX_MATRIX, rollStreakBox, expectedTickets, boxFor, matrixTable } from '../src/streakBox.js';

test('the matrix is the shape the campaign asked for: peak hit-rate on day 2, falling after, sizes rising', () => {
  assert.equal(STREAK_BOX_MATRIX.length, 14);
  const p = STREAK_BOX_MATRIX.map((b) => b.p);
  assert.equal(Math.max(...p), p[1]);                           // day 2 is the peak
  for (let i = 2; i < p.length; i++) assert.ok(p[i] <= p[i - 1], `p falls after day 2 (day ${i + 1})`);
  const s = STREAK_BOX_MATRIX.map((b) => b.size);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1], `size never shrinks (day ${i + 1})`);
  assert.ok(s[10] >= 4 && s[13] === 8, 'past day 10 the boxes are 4-8 tickets');
});

test('roll is deterministic under the supplied rng and pays exactly the box size', () => {
  const win = rollStreakBox(2, () => 0.1);
  assert.deepEqual(win, { day: 2, p: 0.6, size: 1, won: true, tickets: 1 });
  const lose = rollStreakBox(2, () => 0.95);
  assert.equal(lose.won, false); assert.equal(lose.tickets, 0);
  assert.equal(rollStreakBox(14, () => 0.05).tickets, 8);
  assert.equal(rollStreakBox(0, () => 0), null);
  assert.equal(boxFor(99).day, 14, 'beyond the campaign length the last box repeats');
});

test('expected value: a 14-day trader expects ~8 tickets, a 5-day trader ~2', () => {
  const ev14 = expectedTickets(14), ev5 = expectedTickets(5), ev10 = expectedTickets(10);
  assert.ok(ev14 > 7 && ev14 < 9, `ev14=${ev14}`);
  assert.ok(ev5 > 1.8 && ev5 < 2.5, `ev5=${ev5}`);
  assert.ok(ev10 > ev5 && ev14 > ev10);
  assert.equal(matrixTable().at(-1).cumEv, +ev14.toFixed(2));
});

test('monte carlo: hit-rates converge to the matrix', () => {
  let seed = 12345; const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const day of [2, 8, 14]) {
    let wins = 0; const N = 20000;
    for (let i = 0; i < N; i++) if (rollStreakBox(day, rng).won) wins++;
    assert.ok(Math.abs(wins / N - boxFor(day).p) < 0.015, `day ${day}: ${wins / N}`);
  }
});
