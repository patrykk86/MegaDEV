#!/usr/bin/env node
/**
 * tools/friction-log.mjs - the friction log an agent files into, and the sweep that marks it
 *
 * An agent that works around a problem never mentions it, so the workaround quietly becomes the norm.
 * This tool gives that moment a standard record and a deterministic sweep:
 *  - `--file` writes one record: what happened, what was wanted, how to reproduce it, what it cost,
 *    the investigation so far and the files it touches, under `.runs/friction/<id>.{json,md}`.
 *  - `--sweep` reads the open records and marks each `agent-ready`, `needs-human` or `blocked`, so a
 *    daily run hands a person only the decisions that are actually theirs.
 *  - `--check` fails a record that cannot be acted on, and `--selftest` asserts with no network.
 *
 * A record naming a protected path - a hard rule, a tool contract, the guard, the journal - is
 * `needs-human` whatever else it says: those are the operator's calls, not the sweep's. A record with
 * no file or no reproduce step is `blocked`, and the sweep says which one is missing. Two records are
 * the same record when their words, their files and their decision all match; the second is refused.
 *
 * Usage:
 *   node tools/friction-log.mjs --what "..." --wanted "..." --reproduce "..." --cost "..." \
 *     --files tools/check.mjs [--investigation "..."] [--decision product|architecture]
 *   node tools/friction-log.mjs --sweep [--dir .runs/friction]
 *   node tools/friction-log.mjs --check [--dir .runs/friction]
 *   node tools/friction-log.mjs --selftest
 *
 * Exit codes: 0 written, swept or clean · 1 a record is blocked or invalid · 2 usage
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isInside } from './client-handoff.mjs';
import { redactOutbound } from './sanitize.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(THIS_DIR, '..');
export const DEFAULT_DIR = '.runs/friction';

/** The three marks a sweep can give a record. */
export const MARKS = Object.freeze({
  AGENT_READY: 'agent-ready',
  NEEDS_HUMAN: 'needs-human',
  BLOCKED: 'blocked',
});

/**
 * Paths whose change is a decision, not a fix: the hard rules, the routing and MCP declarations, the
 * guard, the loop, the journal, the sanitizer and the approval record. A tool contract is protected by
 * its suffix, because changing a schema changes every caller.
 */
export const PROTECTED_PATHS = Object.freeze([
  'AGENTS.md',
  '.clinerules',
  '.agents/rules/',
  '.agents/model-routing.json',
  '.agents/mcp_config.json',
  'tools/agent-guard.mjs',
  'tools/agent-loop.mjs',
  'tools/journal.mjs',
  'tools/sanitize.mjs',
  'tools/resumable-approval.mjs',
]);

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MIN_CHARS = 8;
/**
 * A credential shape, not a proof: a `key = value` pair with a literal value, a known token prefix, or
 * a Basic/Bearer header. A reference such as `process.env.API_KEY` is not a secret and is not refused,
 * because the record an agent most needs to file about an auth flow is the one that names it.
 */
const CREDENTIAL_RE =
  /(?:api[_-]?key|secret|password|token|access[_-]?key)\s*[:=]\s*["']?(?!process\.env|\$\{)[A-Za-z0-9_-]{12,}|\b(?:gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i;

/** A drive path or a POSIX root anywhere in a line, including after `=` or a quote. */
const ABSOLUTE_ANYWHERE_RE =
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\/(?:home|Users|root|etc|tmp|var|opt|usr|mnt|private|srv|bin|sbin|lib|proc|sys|dev|media|run)\/)/;

/**
 * Resolves `.` and `..` lexically and lowercases, so `tools/../AGENTS.md` and `agents.md` are the same
 * path as `AGENTS.md` on the platform this runs on. Returns null when the path leaves the workspace.
 * @param {string} value
 * @returns {string|null}
 */
export function canonicalRel(value) {
  const clean = normalizeRel(value);
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) {
    return null;
  }
  const out = [];
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? null : out.join('/').toLowerCase();
}

/** True when this path is a workspace-relative path that stays inside the root. */
export function isSafeRel(value) {
  return canonicalRel(value) !== null;
}

/** A workspace-relative path with forward slashes, or the empty string. */
export function normalizeRel(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/** True when changing this path is the operator's call rather than a fix. */
export function isProtected(rel) {
  const clean = canonicalRel(rel);
  if (!clean) {
    // A path that cannot be resolved is not provably safe, so it is the operator's call, not a fix.
    return true;
  }
  if (clean.endsWith('.tool.json')) {
    return true;
  }
  return PROTECTED_PATHS.some((p) => {
    const target = p.toLowerCase().replace(/\/$/, '');
    return clean === target || clean.startsWith(`${target}/`);
  });
}

function asList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeRel).filter(Boolean);
  }
  const one = normalizeRel(value);
  return one ? [one] : [];
}

function checkText(text, label, problems) {
  if (CREDENTIAL_RE.test(text)) {
    problems.push(`${label}: looks like a credential; a record never carries a secret`);
  }
  if (ABSOLUTE_ANYWHERE_RE.test(text)) {
    problems.push(`${label}: absolute path forbidden; name the file from the workspace root`);
  }
}

function checkFields(record, problems) {
  for (const key of ['what', 'wanted', 'reproduce', 'cost']) {
    if (record[key].length < MIN_CHARS) {
      problems.push(`${key}: missing or too thin; it asks ${ASKED[key]}`);
    }
    checkText(record[key], key, problems);
  }
  if (record.investigation) {
    checkText(record.investigation, 'investigation', problems);
  }
}

function checkDecision(record, problems) {
  if (record.decision && !['product', 'architecture'].includes(record.decision)) {
    problems.push('decision: use "product" or "architecture", or leave it out');
  }
}

function checkFiles(record, problems) {
  for (const file of record.files) {
    if (!isSafeRel(file)) {
      problems.push(`files: "${file}" must stay inside the workspace`);
    }
  }
}

/**
 * Validates one record and returns the normalized shape.
 * @param {object} input
 * @returns {{ ok: boolean, problems: string[], record: object }}
 */
export function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: ['record: must be an object'], record: {} };
  }
  const problems = [];
  const record = {
    what: String(input.what ?? '').trim(),
    wanted: String(input.wanted ?? '').trim(),
    reproduce: String(input.reproduce ?? '').trim(),
    cost: String(input.cost ?? '').trim(),
    investigation: String(input.investigation ?? '').trim(),
    decision: String(input.decision ?? '').trim(),
    files: asList(input.files),
  };
  checkFields(record, problems);
  checkDecision(record, problems);
  checkFiles(record, problems);
  return { ok: problems.length === 0, problems, record };
}

const ASKED = Object.freeze({
  what: 'what happened, in the words of the agent that hit it',
  wanted: 'what the agent was trying to achieve',
  reproduce: 'the command or steps that bring it back',
  cost: 'what it cost in time, tokens or retries',
});

/** A stable identity for the same complaint filed twice: the words, not the files. */
export function fingerprintOf(record) {
  const basis = [record.what, record.wanted, record.reproduce]
    .map((part) => String(part ?? '').trim().toLowerCase())
    .join('\u0000');
  return createHash('sha256').update(basis, 'utf-8').digest('hex').slice(0, 16);
}

/** The files a record names, canonical and sorted, so two records can be compared by target. */
export function filesOf(record) {
  return (record.files ?? [])
    .map((file) => canonicalRel(file) ?? normalizeRel(file))
    .sort();
}

/**
 * The key two records are compared by: the words, the files and the decision. A different decision on
 * the same symptom is a different record, because it asks a different person for a different answer.
 * @param {object} record
 * @returns {string}
 */
export function duplicateKeyOf(record) {
  return [
    fingerprintOf(record),
    filesOf(record).join(','),
    String(record.decision ?? '').trim().toLowerCase(),
  ].join('\u0000');
}

/**
 * Marks one record. The order matters: a decision outranks a fix, and a missing file outranks both.
 * @param {object} record
 * @returns {{ mark: string, reasons: string[] }}
 */
export function classifyRecord(record) {
  const reasons = [];
  if (record.decision) {
    reasons.push(`a ${record.decision} decision is the operator's call`);
  }
  const protectedFiles = record.files.filter(isProtected);
  if (protectedFiles.length > 0) {
    reasons.push(`touches a protected path: ${protectedFiles.join(', ')}`);
  }
  if (reasons.length > 0) {
    return { mark: MARKS.NEEDS_HUMAN, reasons };
  }
  if (record.files.length === 0) {
    return { mark: MARKS.BLOCKED, reasons: ['files: name at least one workspace-relative file'] };
  }
  if (!record.reproduce) {
    return { mark: MARKS.BLOCKED, reasons: ['reproduce: the sweep cannot verify a fix without it'] };
  }
  return { mark: MARKS.AGENT_READY, reasons: ['a file and a reproduce step are both named'] };
}

function slugOf(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept = [];
  let length = 0;
  for (const word of words) {
    if (length + word.length + (kept.length ? 1 : 0) > 48) {
      break;
    }
    kept.push(word);
    length += word.length + (kept.length > 1 ? 1 : 0);
  }
  return kept.join('-');
}

/** The id a record is filed under: a readable slug plus a hash of the words, the files and the decision. */
export function idOf(record) {
  const slug = slugOf(record.what) || 'friction';
  const suffix = createHash('sha256')
    .update(duplicateKeyOf(record), 'utf-8')
    .digest('hex')
    .slice(0, 16);
  return `${slug}-${suffix}`;
}

export function renderRecord(id, record, verdict) {
  const lines = [
    `# Friction: ${id}`,
    '',
    `- **Mark**: ${verdict.mark}`,
    `- **Why**: ${verdict.reasons.join('; ')}`,
    `- **Filed**: ${record.filedAt}`,
    '',
    '## What happened',
    '',
    record.what,
    '',
    '## What I wanted',
    '',
    record.wanted,
    '',
    '## How to reproduce',
    '',
    '```',
    record.reproduce,
    '```',
    '',
    '## What it cost',
    '',
    record.cost,
    '',
  ];
  if (record.investigation) {
    lines.push('## Investigation so far', '', record.investigation, '');
  }
  lines.push('## Files', '');
  for (const file of record.files) {
    lines.push(`- \`${file}\``);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Writes one record under the friction folder.
 * @param {object} input
 * @param {{ root?: string, dir?: string }} [options]
 * @returns {{ status: string, id?: string, mark?: string, files?: object, problems?: string[] }}
 */
export function writeRecord(input, options = {}) {
  const root = path.resolve(options.root ?? WORKSPACE_ROOT);
  const dir = path.resolve(root, options.dir ?? DEFAULT_DIR);
  if (!isInside(root, dir)) {
    return { status: 'failed', problems: ['dir: escapes the workspace root'] };
  }
  const verdict = validateRecord(input);
  if (!verdict.ok) {
    return { status: 'failed', problems: verdict.problems };
  }
  const record = { ...verdict.record, filedAt: new Date().toISOString() };
  const id = input.id ? String(input.id) : idOf(record);
  if (!ID_RE.test(id)) {
    return { status: 'failed', problems: ['id: use lowercase letters, digits and dashes'] };
  }
  const print = duplicateKeyOf(record);
  const existing = readRecords(dir).find(
    (entry) => entry.record && duplicateKeyOf(entry.record) === print,
  );
  if (existing) {
    return { status: 'duplicate', id: existing.id, mark: existing.record.mark };
  }
  if (input.id && fs.existsSync(path.join(dir, `${id}.json`))) {
    return { status: 'failed', problems: [`id: "${id}" is already filed; pick another or leave it out`] };
  }
  const mark = classifyRecord(record);
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${id}.json`);
  const mdPath = path.join(dir, `${id}.md`);
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify({ id, ...record, mark: mark.mark, reasons: mark.reasons }, null, 2)}\n`,
    'utf-8',
  );
  fs.writeFileSync(mdPath, renderRecord(id, record, mark), 'utf-8');
  return {
    status: 'written',
    id,
    mark: mark.mark,
    files: {
      json: path.relative(root, jsonPath).replace(/\\/g, '/'),
      md: path.relative(root, mdPath).replace(/\\/g, '/'),
    },
  };
}

/** Every record in the folder, in file-name order, with its file name as the id. */
export function readRecords(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'sweep.json')
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
        return { id: parsed.id ?? name.replace(/\.json$/, ''), record: parsed, file: full };
      } catch (err) {
        return { id: name.replace(/\.json$/, ''), record: null, file: full, error: err.message };
      }
    });
}/**
 * Marks every open record and writes the sweep beside them.
 * @param {{ root?: string, dir?: string, write?: boolean }} [options]
 * @returns {object}
 */
function emptyResult(dir) {
  return {
    at: new Date().toISOString(),
    dir,
    counts: {
      total: 0,
      [MARKS.AGENT_READY]: 0,
      [MARKS.NEEDS_HUMAN]: 0,
      [MARKS.BLOCKED]: 0,
    },
    rows: [],
  };
}

/** Marks one stored record, naming the record it duplicates when there is one. */
function markEntry(entry, seen) {
  if (!entry.record) {
    return { id: entry.id, mark: MARKS.BLOCKED, reasons: [`unreadable: ${entry.error}`] };
  }
  const verdict = validateRecord(entry.record);
  if (!verdict.ok) {
    return { id: entry.id, mark: MARKS.BLOCKED, reasons: verdict.problems };
  }
  const mark = classifyRecord(verdict.record);
  const key = duplicateKeyOf(verdict.record);
  const prior = seen.get(key) ?? null;
  // The lowest id survives, so which record is "the" one does not depend on directory order.
  const duplicateOf = prior && prior < entry.id ? prior : null;
  if (!prior || entry.id < prior) {
    seen.set(key, entry.id);
  }
  return {
    id: entry.id,
    mark: mark.mark,
    reasons: duplicateOf ? [...mark.reasons, `duplicate of ${duplicateOf}`] : mark.reasons,
    duplicateOf,
  };
}

export function sweep(options = {}) {
  const root = path.resolve(options.root ?? WORKSPACE_ROOT);
  const dir = path.resolve(root, options.dir ?? DEFAULT_DIR);
  if (!isInside(root, dir)) {
    return emptyResult(options.dir ?? DEFAULT_DIR);
  }
  const seen = new Map();
  const rows = readRecords(dir).map((entry) => markEntry(entry, seen));

  const counts = {
    total: rows.length,
    [MARKS.AGENT_READY]: rows.filter((r) => r.mark === MARKS.AGENT_READY).length,
    [MARKS.NEEDS_HUMAN]: rows.filter((r) => r.mark === MARKS.NEEDS_HUMAN).length,
    [MARKS.BLOCKED]: rows.filter((r) => r.mark === MARKS.BLOCKED).length,
  };
  const result = { at: new Date().toISOString(), dir: path.relative(root, dir).replace(/\\/g, '/'), counts, rows };

  if (options.write !== false && fs.existsSync(dir)) {
    fs.writeFileSync(
      path.join(dir, 'sweep.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf-8',
    );
    fs.writeFileSync(path.join(dir, 'sweep.md'), renderSweep(result), 'utf-8');
  }
  return result;
}

export function renderSweep(result) {
  const lines = [
    `# Friction sweep: ${result.at}`,
    '',
    `- agent-ready: ${result.counts[MARKS.AGENT_READY]}`,
    `- needs-human: ${result.counts[MARKS.NEEDS_HUMAN]}`,
    `- blocked: ${result.counts[MARKS.BLOCKED]}`,
    '',
  ];
  for (const row of result.rows) {
    lines.push(`- \`${row.id}\` - **${row.mark}**: ${row.reasons.join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function collect(values) {
  return {
    id: values.id,
    what: values.what,
    wanted: values.wanted,
    reproduce: values.reproduce,
    cost: values.cost,
    investigation: values.investigation,
    decision: values.decision,
    files: values.files ?? [],
  };
}

function selftest() {
  const base = {
    what: 'the gate refused a file that only changed a comment',
    wanted: 'run the static analysis gate on one edited module',
    reproduce: 'node tools/check.mjs',
    cost: 'two retries and a re-read of the whole gate',
    files: ['tools/check.mjs'],
  };
  const ready = classifyRecord(base);
  const human = classifyRecord({ ...base, files: ['AGENTS.md'] });
  const contract = classifyRecord({ ...base, files: ['tools/brief.tool.json'] });
  const blocked = classifyRecord({ ...base, files: [] });
  const decision = classifyRecord({ ...base, decision: 'product' });
  const thin = validateRecord({ ...base, cost: 'x' });
  const secret = validateRecord({ ...base, what: 'api_key = "abcdef1234567890" leaked' });
  const ghToken = validateRecord({ ...base, what: 'the log printed ghp_abcdefghijklmnopqrstuvwx' });
  const drive = 'C';
  const absolute = validateRecord({ ...base, files: [`${drive}:\\temp\\x.mjs`] });
  const etcPath = validateRecord({ ...base, files: ['/etc/passwd'] });
  const traversal = validateRecord({ ...base, files: ['tools/../AGENTS.md'] });
  const climbsOut = validateRecord({ ...base, files: ['../outside.mjs'] });
  const same = fingerprintOf(base) === fingerprintOf({ ...base, what: base.what.toUpperCase() });
  const otherFile = fingerprintOf(base) === fingerprintOf({ ...base, files: ['tools/other.mjs'] });
  const otherFiles = filesOf(base).join(',') !== filesOf({ ...base, files: ['tools/other.mjs'] }).join(',');
  const otherDecision = duplicateKeyOf(base) !== duplicateKeyOf({ ...base, decision: 'product' });
  const rulesDir = classifyRecord({ ...base, files: ['.agents/rules'] });
  const rulesTraversal = classifyRecord({ ...base, files: ['foo/../.agents/rules'] });
  const awsKey = validateRecord({ ...base, what: 'the log printed AWS_SECRET_ACCESS_KEY=abcdefghijklmnop' });
  const basicAuth = validateRecord({ ...base, what: 'the header was Authorization: Basic dXNlcjpwYXNzMTIzNDU2' });
  const mntPath = validateRecord({ ...base, what: 'it read path=/mnt/data/x.json' });

  const checks = [
    [ready.mark === MARKS.AGENT_READY, 'a file and a reproduce step mark agent-ready'],
    [human.mark === MARKS.NEEDS_HUMAN, 'a hard rule is the operator\'s call'],
    [contract.mark === MARKS.NEEDS_HUMAN, 'a tool contract is the operator\'s call'],
    [blocked.mark === MARKS.BLOCKED, 'no file blocks the record'],
    [decision.mark === MARKS.NEEDS_HUMAN, 'a named decision outranks a fix'],
    [thin.ok === false, 'a thin cost is refused'],
    [secret.ok === false, 'a credential is refused'],
    [ghToken.ok === false, 'a GitHub token is refused'],
    [absolute.ok === false, 'an absolute path is refused'],
    [etcPath.ok === false, 'a POSIX absolute path is refused'],
    [traversal.ok === true && classifyRecord(traversal.record).mark === MARKS.NEEDS_HUMAN, 'a traversal resolves to the protected target'],
    [climbsOut.ok === false, 'a path that climbs out is refused'],
    [same, 'the fingerprint ignores case'],
    [otherFile, 'the fingerprint is the words, not the files'],
    [otherFiles, 'the files are compared separately'],
    [otherDecision, 'a different decision is a different record'],
    [rulesDir.mark === MARKS.NEEDS_HUMAN, 'a protected directory named without a slash is protected'],
    [rulesTraversal.mark === MARKS.NEEDS_HUMAN, 'a traversal into a protected directory is protected'],
    [awsKey.ok === false, 'an AWS access key is refused'],
    [basicAuth.ok === false, 'a Basic header is refused'],
    [mntPath.ok === false, 'a POSIX path after = is refused'],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
  for (const [ok, label] of checks) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  }
  return failed.length === 0;
}

function main() {
  const { values } = parseArgs({
    options: {
      what: { type: 'string' },
      wanted: { type: 'string' },
      reproduce: { type: 'string' },
      cost: { type: 'string' },
      investigation: { type: 'string' },
      decision: { type: 'string' },
      files: { type: 'string', multiple: true },
      id: { type: 'string' },
      dir: { type: 'string' },
      stdin: { type: 'boolean', default: false },
      sweep: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      selftest: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.selftest) {
    process.exitCode = selftest() ? 0 : 1;
    return;
  }

  if (values.sweep || values.check) {
    const result = sweep({ dir: values.dir, write: values.sweep });
    console.log(redactOutbound(renderSweep(result)));
    process.exitCode = values.check && result.counts[MARKS.BLOCKED] > 0 ? 1 : 0;
    return;
  }

  const input = values.stdin ? JSON.parse(fs.readFileSync(0, 'utf-8')) : collect(values);
  const written = writeRecord(input, { dir: values.dir });
  console.log(redactOutbound(JSON.stringify(written, null, 2)));
  process.exitCode = written.status === 'written' ? 0 : 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 2;
  }
}
