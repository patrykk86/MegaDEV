/**
 * tools/journal.test.mjs - Unit & Invariant Tests for Append-Only Journal Primitive
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GENESIS_PREV_HASH,
  JournalTamperError,
  ModelReflectionError,
  appendJournalEntry,
  canonicalJson,
  computeEntryHash,
  getDailyJournalSummary,
  readJournalEntries,
  recordCrossModelReflection,
  recordDailyTask,
  verifyJournalIntegrity,
} from './journal.mjs';

test('canonicalJson produces deterministic sorted keys', () => {
  const obj1 = { b: 2, a: 1, c: { y: 'bar', x: 'foo' } };
  const obj2 = { a: 1, c: { x: 'foo', y: 'bar' }, b: 2 };
  assert.equal(canonicalJson(obj1), canonicalJson(obj2));
});

test('journal append, hash chaining, and integrity verification', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
  const journalPath = path.join(tmpDir, 'journal.jsonl');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Genesis entry
  const entry1 = appendJournalEntry(
    {
      actor_id: 'gemini-3.8-flash',
      action_type: 'routine_task',
      summary: 'Initial system boot check',
      payload: { status: 'healthy' },
    },
    { journalPath },
  );

  assert.equal(entry1.prev_hash, GENESIS_PREV_HASH);
  assert.ok(entry1.hash.length === 64);

  // Second entry
  const entry2 = appendJournalEntry(
    {
      actor_id: 'gemini-4-argon',
      action_type: 'code_generation',
      summary: 'Implemented AES-256 vault',
      payload: { files: ['app/core/vault.py'] },
    },
    { journalPath },
  );

  assert.equal(entry2.prev_hash, entry1.hash);
  assert.notEqual(entry2.hash, entry1.hash);

  // Integrity check should pass cleanly
  const integrity = verifyJournalIntegrity(journalPath);
  assert.equal(integrity.valid, true);
  assert.equal(integrity.count, 2);
  assert.equal(integrity.errors.length, 0);
});

test('tamper detection: modifying contents fails integrity and blocks append', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-tamper-'));
  const journalPath = path.join(tmpDir, 'journal.jsonl');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  appendJournalEntry(
    { actor_id: 'model-a', action_type: 'task', summary: 'legitimate entry 1' },
    { journalPath },
  );
  appendJournalEntry(
    { actor_id: 'model-a', action_type: 'task', summary: 'legitimate entry 2' },
    { journalPath },
  );

  // Tamper with first line
  const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
  const tampered0 = JSON.parse(lines[0]);
  tampered0.summary = 'TAMPERED SUMMARY';
  // write back without recomputing hash
  fs.writeFileSync(journalPath, `${JSON.stringify(tampered0)}\n${lines[1]}\n`, 'utf8');

  const integrity = verifyJournalIntegrity(journalPath);
  assert.equal(integrity.valid, false);
  assert.ok(integrity.errors.some((e) => e.includes('Hash mismatch')));

  // Non-destructive append invariant: appending to tampered file must throw
  assert.throws(
    () => {
      appendJournalEntry(
        { actor_id: 'model-b', action_type: 'task', summary: 'should fail' },
        { journalPath },
      );
    },
    JournalTamperError,
  );
});

test('tamper detection: broken hash chain links fail verification', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-chain-'));
  const journalPath = path.join(tmpDir, 'journal.jsonl');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  appendJournalEntry({ actor_id: 'model-a', summary: 'entry 1' }, { journalPath });
  appendJournalEntry({ actor_id: 'model-a', summary: 'entry 2' }, { journalPath });

  const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
  const parsed1 = JSON.parse(lines[1]);
  // Alter prev_hash of line 2 and recompute hash for line 2
  parsed1.prev_hash = 'f'.repeat(64);
  parsed1.hash = computeEntryHash(parsed1);
  fs.writeFileSync(journalPath, `${lines[0]}\n${JSON.stringify(parsed1)}\n`, 'utf8');

  const integrity = verifyJournalIntegrity(journalPath);
  assert.equal(integrity.valid, false);
  assert.ok(integrity.errors.some((e) => e.includes('Broken hash chain')));
});

test('daily action tracking protocol and day-by-day aggregation', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-daily-'));
  const journalPath = path.join(tmpDir, 'journal.jsonl');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const testDay = '2026-11-03';

  recordDailyTask({
    actorId: 'gemini-4-argon',
    taskName: 'nightly_static_audit',
    summary: 'Executed check.mjs with zero errors',
    payload: { passed: true, exit_code: 0 },
    day: testDay,
    journalPath,
  });

  recordDailyTask({
    actorId: 'gemini-3.8-flash',
    taskName: 'health_sync_batch',
    summary: 'Processed 15 wearable telemetry records',
    payload: { synced_count: 15 },
    day: testDay,
    journalPath,
  });

  const dailyActions = readJournalEntries({ journalPath, day: testDay });
  assert.equal(dailyActions.length, 2);

  const summary = getDailyJournalSummary(testDay, { journalPath });
  assert.equal(summary.total_entries, 2);
  assert.equal(summary.tasks_count, 2);
  assert.equal(summary.actors.length, 2);
  assert.ok(summary.actors.includes('gemini-4-argon'));
  assert.ok(summary.actors.includes('gemini-3.8-flash'));
});

test('cross-model self-reflection invariant enforcement (author !== reviewer)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-reflect-'));
  const journalPath = path.join(tmpDir, 'journal.jsonl');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Same model reviewing own work MUST fail invariant
  assert.throws(
    () => {
      recordCrossModelReflection({
        targetEntryId: 'entry-123',
        authorModel: 'gemini-4-argon',
        reviewerModel: 'gemini-4-argon',
        verdict: { secure: true, stable: true, working: true, safe: true },
        journalPath,
      });
    },
    ModelReflectionError,
  );

  // Different model reviewing work succeeds and records 4 pillars
  const reflectionEntry = recordCrossModelReflection({
    targetEntryId: 'entry-123',
    authorModel: 'gemini-4-argon',
    reviewerModel: 'deepseek/deepseek-v4.1-flash-1017',
    verdict: {
      secure: true,
      stable: true,
      working: true,
      safe: true,
      overall: 'PASS',
    },
    suggestions: [
      'Add timing-safe comparison on webhook HMAC tokens',
      'Ensure UTC timestamp normalization on all incoming payloads',
    ],
    journalPath,
  });

  assert.equal(reflectionEntry.action_type, 'cross_model_reflection');
  assert.equal(reflectionEntry.payload.verdict.secure, true);
  assert.equal(reflectionEntry.payload.verdict.overall, 'PASS');
  assert.equal(reflectionEntry.payload.reviewer_model, 'deepseek/deepseek-v4.1-flash-1017');

  const summary = getDailyJournalSummary(reflectionEntry.day, { journalPath });
  assert.equal(summary.reflections_count, 1);
  assert.equal(summary.reflections_passed, 1);
  assert.equal(summary.reflections_failed, 0);
});
