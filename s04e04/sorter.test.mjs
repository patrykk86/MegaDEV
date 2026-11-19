import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sortSavedArrivals } from './sorter.mjs';

const first = {
  sequence: 1,
  ticketId: 'duplicate-card-entry',
  answer: { owner: 'pricing', ownerConfidence: 0.9, moneyProbability: 0.30 },
};
const second = {
  sequence: 2,
  ticketId: 'free-parking',
  answer: { owner: 'nobody', ownerConfidence: 0.9, moneyProbability: 0.02 },
};

test('routes money and uncertain ownership independently', () => {
  const third = {
    sequence: 3,
    ticketId: 'slow-calendar',
    answer: { owner: 'booking', ownerConfidence: 0.2, moneyProbability: 0.05 },
  };
  const fourth = {
    sequence: 4,
    ticketId: 'refund',
    answer: { owner: 'pricing', ownerConfidence: 0.70, moneyProbability: 0.70 },
  };
  assert.deepEqual(sortSavedArrivals(':memory:', [first, second, third, fourth]).tags, [
    { ticketId: first.ticketId, owner: 'pricing', money: true, review: ['money', 'uncertain-money'] },
    { ticketId: second.ticketId, owner: 'nobody', money: false, review: [] },
    { ticketId: third.ticketId, owner: 'booking', money: false, review: ['uncertain-owner'] },
    { ticketId: fourth.ticketId, owner: 'pricing', money: true, review: ['money'] },
  ]);
});

test('reopens saved progress, retries unavailable answers, and deduplicates by ticket', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'megadev-sorter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'sorter.sqlite');

  assert.deepEqual(sortSavedArrivals(database, []), { bookmark: 0, tags: [] });
  for (const answer of [undefined, { ...second.answer, moneyProbability: 1.1 }]) {
    assert.throws(
      () => sortSavedArrivals(database, [first, { ...second, answer }]),
      /Missing or invalid saved classification/,
    );
    assert.equal(sortSavedArrivals(database, []).bookmark, 1);
  }
  assert.throws(() => sortSavedArrivals(database, [{ ...second, sequence: 3 }]), /Missing arrival/);
  const recovered = sortSavedArrivals(database, [first, second]);
  assert.equal(recovered.bookmark, 2);

  // A new arrival needs an answer. A repeat delivery can reuse its ticket's saved tag.
  const duplicate = { sequence: 3, ticketId: first.ticketId, answer: null };
  assert.throws(
    () => sortSavedArrivals(database, [{ ...duplicate, ticketId: 'new-ticket' }]),
    /Missing or invalid saved classification/,
  );
  assert.deepEqual(sortSavedArrivals(database, []), recovered);

  const saved = sortSavedArrivals(database, [duplicate]);
  assert.equal(saved.bookmark, 3);
  assert.deepEqual(saved.tags, recovered.tags);
  assert.deepEqual(saved.tags.map(({ ticketId }) => ticketId), [first.ticketId, second.ticketId]);
  assert.deepEqual(sortSavedArrivals(database, [first, second]), saved);
});
