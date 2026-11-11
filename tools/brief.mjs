#!/usr/bin/env node
/**
 * tools/brief.mjs - Standing Brief for work this session does itself
 *
 * A change starts from a written definition of done, not from a symptom:
 * - Requires five blocks: intent, done[], proof[], existing, boundaries[].
 * - Refuses an unbalanced brief: every criterion carries its own proof line.
 * - Refuses a block that looks like a credential or an absolute path.
 * - Writes inside the workspace root only, under .runs/<job>/brief.{json,md}.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isInside } from './client-handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MIN_CHARS = 8;
const CREDENTIAL_RE =
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{12,}/i;
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}(?:home|Users|root)\b)/;

export const STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
});

export const BLOCKS = Object.freeze([
  { key: 'intent', kind: 'string', asks: 'what the human can do when this is done' },
  { key: 'done', kind: 'list', asks: 'the acceptance criteria, one per entry' },
  { key: 'proof', kind: 'list', asks: 'the command, log line or file that proves each criterion' },
  { key: 'existing', kind: 'string', asks: 'the behaviour that already exists and must not change' },
  { key: 'boundaries', kind: 'list', asks: 'what this must not do, and what it must not touch' },
]);

function asEntries(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function checkText(text, label, problems) {
  if (CREDENTIAL_RE.test(text)) {
    problems.push(`${label}: looks like a credential; a brief never carries a secret`);
  }
  if (ABSOLUTE_RE.test(text)) {
    problems.push(`${label}: absolute path forbidden; name the file from the workspace root`);
  }
}

function checkBlock(block, input, problems) {
  const entries = asEntries(input[block.key]);
  const kept = block.kind === 'list' ? entries : entries.slice(0, 1);
  if (kept.length === 0) {
    problems.push(`${block.key}: missing; it asks ${block.asks}`);
    return [];
  }
  for (const entry of kept) {
    if (entry.length < MIN_CHARS) {
      problems.push(`${block.key}: "${entry}" is too thin; it asks ${block.asks}`);
    }
    checkText(entry, block.key, problems);
  }
  return kept;
}

export function validateBrief(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: ['brief: must be an object carrying the five blocks'] };
  }
  const problems = [];
  const blocks = {};
  for (const block of BLOCKS) {
    const kept = checkBlock(block, input, problems);
    blocks[block.key] = block.kind === 'list' ? kept : (kept[0] ?? '');
  }
  if (blocks.done.length !== blocks.proof.length) {
    problems.push(
      `proof: needs one entry per criterion (${blocks.done.length} criteria, ${blocks.proof.length} proofs)`,
    );
  }
  return { ok: problems.length === 0, problems, blocks };
}

export function renderBrief(job, blocks) {
  const lines = [`# Brief: ${job}`, '', '## Intent', '', blocks.intent, '', '## Done when', ''];
  blocks.done.forEach((criterion, index) => {
    lines.push(`${index + 1}. ${criterion}`, `   - proof: ${blocks.proof[index] ?? '(missing)'}`);
  });
  lines.push('', '## Already exists', '', blocks.existing, '', '## Boundaries', '');
  for (const boundary of blocks.boundaries) {
    lines.push(`- ${boundary}`);
  }
  return `${lines.join('\n')}\n`;
}

export function createBrief(input, options = {}) {
  const root = path.resolve(options.root ?? ROOT);
  const job = String(input?.job ?? '').trim();
  if (!JOB_RE.test(job)) {
    return { status: STATUS.FAILED, problems: ['job: use lowercase letters, digits and dashes, max 64'] };
  }
  const verdict = validateBrief(input);
  if (!verdict.ok) {
    return { status: STATUS.FAILED, problems: verdict.problems };
  }
  const dir = path.join(root, '.runs', job);
  if (!isInside(root, dir)) {
    return { status: STATUS.FAILED, problems: [`job: "${job}" escapes the workspace root`] };
  }
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'brief.json');
  const mdPath = path.join(dir, 'brief.md');
  const record = {
    job,
    title: String(input.title ?? job),
    blocks: verdict.blocks,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(mdPath, renderBrief(job, verdict.blocks), 'utf-8');
  return {
    status: STATUS.PASSED,
    job,
    files: {
      json: path.relative(root, jsonPath).replace(/\\/g, '/'),
      md: path.relative(root, mdPath).replace(/\\/g, '/'),
    },
    criteria: verdict.blocks.done.length,
  };
}

export function readBrief(filePath) {
  const record = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const verdict = validateBrief(record?.blocks ?? {});
  return { ok: verdict.ok, job: record?.job ?? null, problems: verdict.problems };
}

function collect(values) {
  return {
    job: values.job,
    title: values.title,
    intent: values.intent,
    done: values.done ?? [],
    proof: values.proof ?? [],
    existing: values.existing,
    boundaries: values.boundary ?? [],
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      job: { type: 'string' },
      title: { type: 'string' },
      intent: { type: 'string' },
      done: { type: 'string', multiple: true },
      proof: { type: 'string', multiple: true },
      existing: { type: 'string' },
      boundary: { type: 'string', multiple: true },
      check: { type: 'string' },
      stdin: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.check) {
    const res = readBrief(path.resolve(ROOT, values.check));
    console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok ? 0 : 1;
    return;
  }

  const input = values.stdin ? JSON.parse(fs.readFileSync(0, 'utf-8')) : collect(values);
  const result = createBrief(input);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === STATUS.PASSED ? 0 : 1;
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
