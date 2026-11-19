import { DatabaseSync } from 'node:sqlite';

const OWNERS = ['booking', 'pricing', 'nobody'];

function tagFor(answer) {
  const { owner, ownerConfidence, moneyProbability } = answer ?? {};
  const validScore = (score) => Number.isFinite(score) && score >= 0 && score <= 1;
  if (!OWNERS.includes(owner) || !validScore(ownerConfidence) || !validScore(moneyProbability)) {
    throw new Error('Missing or invalid saved classification');
  }

  const review = [];
  const money = moneyProbability >= 0.30;
  if (money) review.push('money');
  if (money && moneyProbability < 0.70) review.push('uncertain-money');
  if (ownerConfidence < 0.70) review.push('uncertain-owner');
  return { owner, money, review };
}

/**
 * Process synthetic arrivals from one ordered, append-only stream.
 * Each entry has a stable, contiguous sequence starting at 1, a synthetic
 * ticketId and a saved classifier answer. Reuse the database on restart.
 */
export function sortSavedArrivals(databasePath, arrivals) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tags (ticket_id TEXT PRIMARY KEY, tag TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bookmark (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO bookmark VALUES (1, 0);
    `);
    const readBookmark = db.prepare('SELECT sequence FROM bookmark WHERE id = 1');
    const findTag = db.prepare('SELECT 1 FROM tags WHERE ticket_id = ?');
    const saveTag = db.prepare('INSERT INTO tags VALUES (?, ?)');
    const saveBookmark = db.prepare('UPDATE bookmark SET sequence = ? WHERE id = 1');

    for (const { sequence, ticketId, answer } of arrivals) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = readBookmark.get().sequence;
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          throw new Error('Invalid arrival sequence');
        }
        if (sequence > previous) {
          if (sequence !== previous + 1) throw new Error('Missing arrival before this sequence');
          if (typeof ticketId !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(ticketId)) {
            throw new Error('Invalid synthetic ticket ID');
          }
          if (!findTag.get(ticketId)) saveTag.run(ticketId, JSON.stringify(tagFor(answer)));
          saveBookmark.run(sequence);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    const tags = db.prepare('SELECT ticket_id, tag FROM tags ORDER BY rowid').all()
      .map(({ ticket_id, tag }) => ({ ticketId: ticket_id, ...JSON.parse(tag) }));
    return { bookmark: readBookmark.get().sequence, tags };
  } finally {
    db.close();
  }
}
