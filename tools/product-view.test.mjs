import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildViewModel, renderView, readViewFingerprint, fingerprintOf, safeText } from './product-view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'product-view.mjs');
const model = buildViewModel(ROOT);
const html = renderView(model);

test('reads every primitive from source', () => {
  assert.ok(model.primitives.length >= 15, `only ${model.primitives.length} primitives`);
  assert.equal(new Set(model.primitives.map((row) => row.rel)).size, model.primitives.length);
  for (const row of model.primitives) {
    assert.match(row.rel, /^tools\/[a-z0-9-]+\.mjs$/);
    assert.ok(!row.rel.endsWith('.test.mjs'));
    assert.ok(row.purpose.length > 0, `${row.rel} has no purpose line`);
  }
});

test('derives callers from local imports, not from a hand-written list', () => {
  const journal = model.primitives.find((row) => row.rel === 'tools/journal.mjs');
  assert.ok(journal, 'journal.mjs missing from the view');
  assert.ok(
    journal.callers.includes('tools/agent-loop.mjs'),
    `journal callers were ${JSON.stringify(journal.callers)}`
  );
});

test('builds a flow from an entry point nobody imports', () => {
  for (const flow of model.flows) {
    const entry = model.primitives.find((row) => row.rel === flow.entry);
    assert.ok(entry, `${flow.entry} is not a primitive`);
    assert.deepEqual(entry.callers, [], `${flow.entry} is imported, so it is not an entry point`);
  }
  const flow = model.flows.find((entry) => entry.entry === 'tools/eval-agent-primitives.mjs');
  assert.ok(flow, `flows were ${JSON.stringify(model.flows.map((entry) => entry.entry))}`);
  assert.ok(flow.steps.includes('tools/agent-loop.mjs'), JSON.stringify(flow.steps));
  const known = new Set(model.primitives.map((row) => row.rel));
  for (const step of flow.steps) {
    assert.ok(known.has(step), `${step} is not a primitive the view knows`);
    assert.notEqual(step, flow.entry);
  }
  assert.ok(flow.steps.length <= 8, `a flow carried ${flow.steps.length} steps`);
});

test('a module used only by its own test is not an entry point', () => {
  const testCallers = new Set();
  for (const entry of model.flows) {
    testCallers.add(entry.entry);
  }
  for (const rel of testCallers) {
    const row = model.primitives.find((candidate) => candidate.rel === rel);
    assert.deepEqual(row.callers, [], `${rel} is imported by ${row.callers.join(', ')}`);
  }
  assert.ok(model.primitives.some((row) => row.test), 'no primitive publishes a test');
  assert.ok(!model.flows.some((flow) => flow.entry.endsWith('.test.mjs')));
});

test('names the paths a module names, and no path is absolute', () => {
  const fromJournal = model.pathIndex.filter(([, writers]) => writers.includes('tools/journal.mjs'));
  assert.ok(fromJournal.length > 0, 'journal.mjs names no path');
  for (const [target] of fromJournal) {
    assert.ok(!path.isAbsolute(target), `${target} is an absolute path`);
  }
  assert.equal(new Set(model.pathIndex.map(([target]) => target)).size, model.pathIndex.length);
});

test('the fingerprint covers the renderer, the parser and the test edges, and page text is filtered', () => {
  assert.match(model.sourceHash, /^[0-9a-f]{64}$/);
  assert.match(model.parserHash, /^[0-9a-f]{64}$/);
  assert.ok(model.testEdges.length > 0, 'no test import edge was recorded');
  for (const edge of model.testEdges) {
    assert.match(edge, /^tools\/[a-z0-9-]+\.test\.mjs:/);
  }
  assert.notEqual(fingerprintOf({ ...model, sourceHash: 'f'.repeat(64) }), model.fingerprint);
  assert.notEqual(fingerprintOf({ ...model, parserHash: 'f'.repeat(64) }), model.fingerprint);
  assert.notEqual(fingerprintOf({ ...model, testEdges: [] }), model.fingerprint);
  assert.equal(safeText('open C:\\Users\\someone\\notes.txt'), 'open [absolute path]');
  assert.equal(safeText('read /etc/passwd now'), 'read [absolute path] now');
  assert.equal(safeText('share \\\\build-host\\artifacts\\x.html'), 'share [absolute path]');
  assert.equal(safeText('key sk-abcdefghijklmnopqrst'), 'key [redacted]');
  assert.equal(safeText('a plain sentence'), 'a plain sentence');
});

test('a fresh clone with no skills, no memory and no output still renders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-view-clone-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(
      path.join(root, 'tools', 'alpha.mjs'),
      '#!/usr/bin/env node\n/**\n * tools/alpha.mjs - Alpha entry\n *\n * Reads memory/THING.md.\n */\nimport { beta } from \'./beta.mjs\';\nexport const alpha = beta;\nexport const where = \'memory/THING.md\';\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(root, 'tools', 'beta.mjs'),
      '/**\n * tools/beta.mjs - Beta helper\n */\nexport const beta = 1;\n',
      'utf-8'
    );
    const clone = buildViewModel(root);
    assert.equal(clone.primitives.length, 2);
    assert.deepEqual(clone.skills, []);
    assert.equal(clone.flows.length, 1);
    assert.equal(clone.flows[0].entry, 'tools/alpha.mjs');
    assert.deepEqual(clone.flows[0].steps, ['tools/beta.mjs']);
    assert.equal(clone.gates.length, 0);
    assert.ok(clone.pathIndex.some(([target]) => target === 'memory/THING.md'));
    const page = renderView(clone);
    assert.equal(readViewFingerprint(page), clone.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the page is one file: no script, no network, no absolute path', () => {
  assert.ok(html.startsWith('<!doctype html>'));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\ssrc=/i);
  assert.doesNotMatch(html, /href="https?:/i);
  assert.doesNotMatch(html, /[A-Za-z]:[\\/]/);
  assert.ok(!html.includes('file:///'));
});

test('the fingerprint matches the page, and a page without one is refused', () => {
  assert.equal(readViewFingerprint(html), model.fingerprint);
  const stripped = html.replace(/^<!-- view-fingerprint: [0-9a-f]{64} -->$/m, '');
  assert.equal(readViewFingerprint(stripped), null);
});

test('--out writes where a job reads it, and --check fails once it drifts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-view-'));
  const target = path.join(dir, 'view.html');
  try {
    const write = spawnSync(process.execPath, [SCRIPT, '--out', target], { cwd: ROOT, encoding: 'utf-8' });
    assert.equal(write.status, 0, write.stderr);
    const payload = JSON.parse(write.stdout);
    assert.equal(payload.flows, model.flows.length);
    assert.ok(fs.existsSync(target));
    assert.equal(readViewFingerprint(fs.readFileSync(target, 'utf-8')), model.fingerprint);

    const fresh = spawnSync(process.execPath, [SCRIPT, '--check', '--out', target], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    assert.equal(fresh.status, 0, fresh.stderr);

    // A page whose fingerprint no longer matches the source is what --check exists to catch.
    const current = fs.readFileSync(target, 'utf-8');
    fs.writeFileSync(target, current.replace(/view-fingerprint: [0-9a-f]{64}/, `view-fingerprint: ${'0'.repeat(64)}`), 'utf-8');
    const stale = spawnSync(process.execPath, [SCRIPT, '--check', '--out', target], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    assert.equal(stale.status, 1);
    const verdict = JSON.parse(stale.stdout);
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems.join(' '), /stale/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
