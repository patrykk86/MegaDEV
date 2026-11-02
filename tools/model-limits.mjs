#!/usr/bin/env node
/**
 * tools/model-limits.mjs - Per-model agent limits derived from real OpenRouter usage.
 *
 * Method (user policy): every limit = observed mean * 1.5 ("average + 50%").
 * - maxOutputTokens: mean(tokens_completion) * 1.5. OpenRouter counts reasoning tokens inside
 *   tokens_completion, so the value maps directly onto `max_tokens` / `max_output_tokens`.
 * - timeoutMs: mean(generation_time_ms) * 1.5 (falls back to time_to_first_token_ms when a
 *   provider reports 0 generation time).
 * - maxSteps: mean(calls per session) * 1.5, where a session is a run of calls to the same
 *   model with gaps <= sessionGapMs. This is a heuristic: the export has no run identifier.
 *
 * CLI:
 *   node tools/model-limits.mjs --from-csv <activity.csv> --out <limits.json> [--multiplier 1.5]
 *        [--session-gap-ms 60000] [--alias short/id=provider/full-id-20261017 ...]
 *   node tools/model-limits.mjs --lookup <model-id> --limits <limits.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MULTIPLIER = 1.5;
export const DEFAULT_SESSION_GAP_MS = 60_000;

/** Reads one quoted field starting after the opening quote; returns [value, nextIndex]. */
function readQuoted(text, start) {
  let value = '';
  let i = start;
  while (i < text.length) {
    if (text[i] === '"' && text[i + 1] === '"') {
      value += '"';
      i += 2;
    } else if (text[i] === '"') {
      return [value, i + 1];
    } else {
      value += text[i];
      i++;
    }
  }
  return [value, i];
}

/** Splits CSV text into records of raw string fields. */
function tokenizeCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const [quoted, next] = readQuoted(text, i + 1);
      field += quoted;
      i = next;
      continue;
    }
    if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 1 : 0;
    } else {
      field += c;
    }
    i++;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Parses RFC 4180-style CSV (quoted fields, escaped quotes) into objects keyed by header. */
export function parseCsv(text) {
  const nonEmpty = tokenizeCsv(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length === 0) {
    return [];
  }
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function toTimestamp(createdAt) {
  const iso = `${String(createdAt).trim().replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function latencyMs(row) {
  const gen = num(row.generation_time_ms);
  return gen > 0 ? gen : num(row.time_to_first_token_ms);
}

function sessionLengths(timestamps, gapMs) {
  const sorted = timestamps.filter((t) => t !== null).sort((a, b) => a - b);
  const lengths = [];
  let current = 0;
  let last = null;
  for (const t of sorted) {
    if (last !== null && t - last <= gapMs) {
      current++;
    } else {
      if (current > 0) {
        lengths.push(current);
      }
      current = 1;
    }
    last = t;
  }
  if (current > 0) {
    lengths.push(current);
  }
  return lengths;
}

function summarize(rows, multiplier, gapMs) {
  const completion = rows.map((r) => num(r.tokens_completion));
  const latencies = rows.map(latencyMs).filter((v) => v > 0);
  const sessions = sessionLengths(rows.map((r) => toTimestamp(r.created_at)), gapMs);
  const avgCompletion = mean(completion);
  const avgLatency = mean(latencies);
  const avgSteps = mean(sessions);
  return {
    samples: rows.length,
    sessions: sessions.length,
    avgCompletionTokens: Math.round(avgCompletion),
    avgLatencyMs: Math.round(avgLatency),
    avgSteps: Math.round(avgSteps * 10) / 10,
    maxOutputTokens: Math.max(1, Math.ceil(avgCompletion * multiplier)),
    timeoutMs: latencies.length ? Math.max(1, Math.ceil(avgLatency * multiplier)) : null,
    maxSteps: Math.max(1, Math.ceil(avgSteps * multiplier)),
  };
}

/** Builds the limits document from parsed CSV rows. */
export function computeLimits(rows, options = {}) {
  const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;
  const gapMs = options.sessionGapMs ?? DEFAULT_SESSION_GAP_MS;
  const byModel = new Map();
  for (const row of rows) {
    const model = String(row.model_permaslug ?? '').trim();
    if (!model || row.cancelled === 'true') {
      continue;
    }
    if (!byModel.has(model)) {
      byModel.set(model, []);
    }
    byModel.get(model).push(row);
  }
  const models = {};
  for (const model of [...byModel.keys()].sort()) {
    models[model] = summarize(byModel.get(model), multiplier, gapMs);
  }
  const pooled = summarize([...byModel.values()].flat(), multiplier, gapMs);
  return {
    method: `mean * ${multiplier} (average + ${Math.round((multiplier - 1) * 100)}%)`,
    multiplier,
    sessionGapMs: gapMs,
    source: options.source ?? null,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    aliases: { ...(options.aliases ?? {}) },
    default: { ...pooled, note: 'Pooled across all models; used for unknown ids.' },
    models,
  };
}

const DATE8 = /-(\d{8})$/;
const DATE4 = /-(\d{4})$/;

function baseId(id) {
  return id.replace(DATE8, '').replace(DATE4, '');
}

function shortName(id) {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * Resolves a model id (dated permaslug, MMDD alias like "-1017", undated name, or bare name
 * without provider) to an entry in the limits document. Returns { model, limits, matched }.
 */
export function resolveLimits(doc, requested) {
  const id = String(requested ?? '').trim().toLowerCase();
  const keys = Object.keys(doc.models ?? {});
  const aliasTarget = Object.entries(doc.aliases ?? {}).find(([k]) => k.toLowerCase() === id)?.[1];
  const exact = keys.find((k) => k.toLowerCase() === (aliasTarget ?? id).toLowerCase());
  if (exact) {
    return { model: exact, limits: doc.models[exact], matched: aliasTarget ? 'alias' : 'exact' };
  }
  const wantBase = shortName(baseId(id));
  const candidates = keys.filter((k) => shortName(baseId(k.toLowerCase())) === wantBase);
  if (candidates.length > 0) {
    const mmdd = id.match(DATE4)?.[1] ?? id.match(DATE8)?.[1]?.slice(4);
    const dated = (k) => k.match(DATE8)?.[1] ?? '';
    const sameDay = mmdd ? candidates.filter((k) => dated(k).endsWith(mmdd)) : [];
    const pool = sameDay.length > 0 ? sameDay : candidates;
    const best = [...pool].sort((a, b) => dated(b).localeCompare(dated(a)))[0];
    return { model: best, limits: doc.models[best], matched: 'family' };
  }
  return { model: null, limits: doc.default, matched: 'default' };
}

function parseArgs(argv) {
  const args = { aliases: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--alias') {
      const eq = String(value ?? '').indexOf('=');
      if (eq <= 0) {
        throw new Error('--alias expects short-id=full-permaslug');
      }
      args.aliases[value.slice(0, eq)] = value.slice(eq + 1);
      i++;
    } else if (flag.startsWith('--')) {
      args[flag.slice(2)] = value;
      i++;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.lookup) {
    if (!args.limits) {
      throw new Error('--lookup needs --limits <limits.json>');
    }
    const doc = JSON.parse(fs.readFileSync(args.limits, 'utf-8'));
    console.log(JSON.stringify(resolveLimits(doc, args.lookup), null, 2));
    return;
  }
  if (!args['from-csv'] || !args.out) {
    console.error('Usage: node tools/model-limits.mjs --from-csv <activity.csv> --out <limits.json>');
    process.exit(2);
  }
  const rows = parseCsv(fs.readFileSync(args['from-csv'], 'utf-8'));
  const doc = computeLimits(rows, {
    multiplier: args.multiplier ? Number(args.multiplier) : undefined,
    sessionGapMs: args['session-gap-ms'] ? Number(args['session-gap-ms']) : undefined,
    source: path.basename(args['from-csv']),
    aliases: args.aliases,
  });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(doc.models).length} model limits from ${rows.length} rows to ${args.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
