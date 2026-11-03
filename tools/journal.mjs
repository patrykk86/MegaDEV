/**
 * tools/journal.mjs - Append-Only Journal Primitive & Cross-Model Self-Reflection Engine
 *
 * Implements Task 2:
 * - Append-only JSONL journal with strict non-destructive invariant.
 * - SHA-256 cryptographic hash chaining (prev_hash -> hash).
 * - ISO timestamps and actor IDs.
 * - Daily action tracking protocol (day-by-day task & action recording).
 * - Cross-Model Self-Reflection: different models verify each other's work (Secure, Stable, Working, Safe).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactOutbound } from './sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GENESIS_PREV_HASH = '0'.repeat(64);
export const DEFAULT_JOURNAL_PATH = path.join(ROOT, '.runs', 'journal.jsonl');

export class JournalTamperError extends Error {
  constructor(message) {
    super(`[Journal Integrity Violation] ${message}`);
    this.name = 'JournalTamperError';
  }
}

export class ModelReflectionError extends Error {
  constructor(message) {
    super(`[Cross-Model Reflection Violation] ${message}`);
    this.name = 'ModelReflectionError';
  }
}

/**
 * Deterministically serialize any JavaScript value with sorted object keys.
 */
export function canonicalJson(data) {
  if (data === null || typeof data !== 'object') {
    return JSON.stringify(data);
  }
  if (Array.isArray(data)) {
    return `[${data.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const sortedKeys = Object.keys(data).filter((k) => data[k] !== undefined).sort();
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJson(data[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Calculate SHA-256 hash for a journal entry payload.
 */
export function computeEntryHash(entryFields) {
  const content = canonicalJson({
    entry_id: entryFields.entry_id,
    timestamp: entryFields.timestamp,
    day: entryFields.day,
    actor_id: entryFields.actor_id,
    action_type: entryFields.action_type,
    summary: entryFields.summary,
    payload: entryFields.payload,
    prev_hash: entryFields.prev_hash,
  });
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Parse and validate all entries from a journal file.
 */
export function readJournalEntries(options = {}) {
  const filePath = options.journalPath ?? DEFAULT_JOURNAL_PATH;
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      throw new JournalTamperError(`Corrupted JSON line in journal: ${err.message}`);
    }
  }

  return filterEntries(entries, options);
}

function filterEntries(entries, options) {
  let result = entries;
  if (options.day) {
    result = result.filter((e) => e.day === options.day);
  }
  if (options.actor_id) {
    result = result.filter((e) => e.actor_id === options.actor_id);
  }
  if (options.action_type) {
    result = result.filter((e) => e.action_type === options.action_type);
  }
  return result;
}

/**
 * Verifies full cryptographic integrity of the journal chain.
 */
export function verifyJournalIntegrity(journalPath = DEFAULT_JOURNAL_PATH) {
  if (!fs.existsSync(journalPath)) {
    return { valid: true, count: 0, errors: [] };
  }
  const raw = fs.readFileSync(journalPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const errors = [];
  let expectedPrevHash = GENESIS_PREV_HASH;
  let lastTimestamp = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    verifySingleLine(lines[idx], idx, expectedPrevHash, lastTimestamp, errors);
    try {
      const parsed = JSON.parse(lines[idx]);
      expectedPrevHash = parsed.hash;
      lastTimestamp = new Date(parsed.timestamp).getTime();
    } catch {
      // already recorded in verifySingleLine
    }
  }

  return { valid: errors.length === 0, count: lines.length, errors };
}

function verifySingleLine(lineStr, idx, expectedPrevHash, lastTimestamp, errors) {
  let entry;
  try {
    entry = JSON.parse(lineStr);
  } catch (err) {
    errors.push(`Line ${idx + 1}: Malformed JSON (${err.message})`);
    return;
  }

  if (entry.prev_hash !== expectedPrevHash) {
    errors.push(
      `Line ${idx + 1}: Broken hash chain. Expected prev_hash '${expectedPrevHash}', found '${entry.prev_hash}'`,
    );
  }

  const computed = computeEntryHash(entry);
  if (entry.hash !== computed) {
    errors.push(`Line ${idx + 1}: Hash mismatch. Recorded '${entry.hash}', computed '${computed}'`);
  }

  const curTs = new Date(entry.timestamp).getTime();
  if (Number.isNaN(curTs)) {
    errors.push(`Line ${idx + 1}: Invalid ISO timestamp '${entry.timestamp}'`);
  } else if (curTs < lastTimestamp) {
    errors.push(
      `Line ${idx + 1}: Non-monotonic timestamp '${entry.timestamp}' earlier than previous line`,
    );
  }
}

/**
 * Appends a new entry strictly enforcing non-destructive invariant and SHA-256 hash chaining.
 */
export function appendJournalEntry(entryInput, options = {}) {
  const filePath = options.journalPath ?? DEFAULT_JOURNAL_PATH;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const integrity = verifyJournalIntegrity(filePath);
  if (!integrity.valid) {
    throw new JournalTamperError(
      `Cannot append to corrupted journal: ${integrity.errors.join('; ')}`,
    );
  }

  const entries = readJournalEntries({ journalPath: filePath });
  const prevHash = entries.length > 0 ? entries[entries.length - 1].hash : GENESIS_PREV_HASH;

  const now = entryInput.timestamp ? new Date(entryInput.timestamp) : new Date();
  const timestamp = now.toISOString();
  const day = entryInput.day ?? timestamp.slice(0, 10);

  // Recursively sanitize and redact outbound summary and payload to prevent at-rest secret/PHI leaks
  const cleanSummary = redactOutbound(String(entryInput.summary ?? ''));
  const rawPayload = entryInput.payload ?? {};
  const cleanPayload = JSON.parse(redactOutbound(JSON.stringify(rawPayload)));

  const entry = {
    entry_id: entryInput.entry_id ?? crypto.randomUUID(),
    timestamp,
    day,
    actor_id: String(entryInput.actor_id ?? 'unknown'),
    action_type: String(entryInput.action_type ?? 'generic'),
    summary: cleanSummary,
    payload: cleanPayload,
    prev_hash: prevHash,
    hash: '',
  };

  entry.hash = computeEntryHash(entry);

  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(filePath, line, 'utf8');

  return entry;
}

/**
 * Daily Routine Task Tracking: records daily tasks and operational actions.
 */
export function recordDailyTask({
  actorId,
  taskName,
  summary,
  payload = {},
  day,
  journalPath = DEFAULT_JOURNAL_PATH,
}) {
  return appendJournalEntry(
    {
      actor_id: actorId,
      action_type: 'daily_routine',
      summary: `[${taskName}] ${summary}`,
      payload: {
        task_name: taskName,
        ...payload,
      },
      day,
    },
    { journalPath },
  );
}

/**
 * Cross-Model Self-Reflection Gate:
 * Invariant: another model must ALWAYS check the work of a different model (author !== reviewer).
 */
export function recordCrossModelReflection({
  targetEntryId,
  authorModel,
  reviewerModel,
  verdict,
  suggestions = [],
  summary,
  journalPath = DEFAULT_JOURNAL_PATH,
}) {
  if (!authorModel || !reviewerModel) {
    throw new ModelReflectionError('Both authorModel and reviewerModel must be specified.');
  }

  if (authorModel.trim().toLowerCase() === reviewerModel.trim().toLowerCase()) {
    throw new ModelReflectionError(
      `Cross-model invariant violation: Author model '${authorModel}' cannot review its own work. A different model must perform reflection.`,
    );
  }

  const normalizedVerdict = {
    secure: Boolean(verdict.secure),
    stable: Boolean(verdict.stable),
    working: Boolean(verdict.working),
    safe: Boolean(verdict.safe),
    overall:
      verdict.overall ??
      (verdict.secure && verdict.stable && verdict.working && verdict.safe ? 'PASS' : 'FAIL'),
  };

  const reflectionPayload = {
    target_entry_id: targetEntryId,
    author_model: authorModel,
    reviewer_model: reviewerModel,
    verdict: normalizedVerdict,
    suggestions: Array.isArray(suggestions) ? suggestions : [String(suggestions)],
  };

  return appendJournalEntry(
    {
      actor_id: reviewerModel,
      action_type: 'cross_model_reflection',
      summary: summary || `Reflection on entry '${targetEntryId}' by ${reviewerModel} (verdict: ${normalizedVerdict.overall})`,
      payload: reflectionPayload,
    },
    { journalPath },
  );
}

/**
 * Generates an aggregated daily report across all actions and reflections for a given date.
 */
export function getDailyJournalSummary(day, options = {}) {
  const filePath = options.journalPath ?? DEFAULT_JOURNAL_PATH;
  const entries = readJournalEntries({ journalPath: filePath, day });

  const tasks = [];
  const reflections = [];
  const actors = new Set();
  let passedReflections = 0;
  let failedReflections = 0;

  for (const e of entries) {
    actors.add(e.actor_id);
    if (e.action_type === 'daily_routine' || e.action_type === 'task_execution') {
      tasks.push(e);
    } else if (e.action_type === 'cross_model_reflection') {
      reflections.push(e);
      if (e.payload?.verdict?.overall === 'PASS') {
        passedReflections++;
      } else {
        failedReflections++;
      }
    }
  }

  return {
    day,
    total_entries: entries.length,
    actors: Array.from(actors),
    tasks_count: tasks.length,
    reflections_count: reflections.length,
    reflections_passed: passedReflections,
    reflections_failed: failedReflections,
    tasks,
    reflections,
  };
}

function handleVerify(filePath) {
  const res = verifyJournalIntegrity(filePath);
  console.log(`Journal integrity: ${res.valid ? 'VALID' : 'INVALID'} (${res.count} entries)`);
  if (!res.valid) {
    for (const err of res.errors) {
      console.error(`  - ${err}`);
    }
    return 1;
  }
  return 0;
}

function handleSummary(filePath, day) {
  const summary = getDailyJournalSummary(day, { journalPath: filePath });
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

function handleList(filePath, day) {
  const entries = readJournalEntries({ journalPath: filePath, day });
  console.log(JSON.stringify(entries, null, 2));
  return 0;
}

export function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage:',
        '  node tools/journal.mjs --verify [--file <path>]',
        '  node tools/journal.mjs --summary [--day <YYYY-MM-DD>] [--file <path>]',
        '  node tools/journal.mjs --list [--day <YYYY-MM-DD>] [--file <path>]',
      ].join('\n'),
    );
    return 0;
  }

  const fIdx = args.indexOf('--file');
  const filePath = fIdx !== -1 && args[fIdx + 1] ? path.resolve(args[fIdx + 1]) : DEFAULT_JOURNAL_PATH;

  const dIdx = args.indexOf('--day');
  const day = dIdx !== -1 && args[dIdx + 1] ? args[dIdx + 1] : new Date().toISOString().slice(0, 10);

  if (args.includes('--verify')) {
    return handleVerify(filePath);
  }
  if (args.includes('--summary')) {
    return handleSummary(filePath, day);
  }
  if (args.includes('--list')) {
    return handleList(filePath, day);
  }

  console.log('Use --verify, --summary, or --list. Run with --help for usage.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli(process.argv);
}

