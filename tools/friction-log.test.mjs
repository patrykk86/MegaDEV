#!/usr/bin/env node
/**
 * tools/friction-log.test.mjs - Unit tests for the friction log and its sweep
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  MARKS,
  classifyRecord,
  filesOf,
  fingerprintOf,
  idOf,
  isProtected,
  readRecords,
  renderSweep,
  sweep,
  validateRecord,
  writeRecord,
} from './friction-log.mjs';

const BASE = {
  what: 'the gate refused a file that only changed a comment',
  wanted: 'run the static analysis gate on one edited module',
  reproduce: 'node tools/check.mjs',
  cost: 'two retries and a re-read of the whole gate',
  files: ['tools/check.mjs'],
};

describe('friction-log: validation', () => {
  it('accepts a complete record', () => {
    const res = validateRecord(BASE);
    assert.equal(res.ok, true);
    assert.deepEqual(res.problems, []);
    assert.deepEqual(res.record.files, ['tools/check.mjs']);
  });

  it('refuses a record with no cost', () => {
    const res = validateRecord({ ...BASE, cost: '' });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.startsWith('cost: missing')));
  });

  it('refuses a credential', () => {
    const res = validateRecord({ ...BASE, what: 'api_key = "abcdef1234567890" was printed' });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('looks like a credential')));
  });

  it('refuses an absolute path in files', () => {
    const drive = 'C';
    const res = validateRecord({ ...BASE, files: [`${drive}:\\temp\\x.mjs`] });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('must stay inside the workspace')));
  });

  it('refuses a POSIX absolute path in files', () => {
    const res = validateRecord({ ...BASE, files: ['/etc/passwd'] });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('must stay inside the workspace')));
  });

  it('resolves a traversal instead of refusing it, and still protects the target', () => {
    const res = validateRecord({ ...BASE, files: ['tools/../AGENTS.md'] });
    assert.equal(res.ok, true);
    assert.equal(classifyRecord(res.record).mark, MARKS.NEEDS_HUMAN);
  });

  it('refuses a GitHub token', () => {
    const res = validateRecord({ ...BASE, what: 'the log printed ghp_abcdefghijklmnopqrstuvwx' });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('looks like a credential')));
  });

  it('refuses an unknown decision', () => {
    const res = validateRecord({ ...BASE, decision: 'vibes' });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.startsWith('decision:')));
  });
});

describe('friction-log: classification', () => {
  it('marks a fixable record agent-ready', () => {
    const res = classifyRecord(BASE);
    assert.equal(res.mark, MARKS.AGENT_READY);
  });

  it('marks a hard rule needs-human', () => {
    assert.equal(classifyRecord({ ...BASE, files: ['AGENTS.md'] }).mark, MARKS.NEEDS_HUMAN);
  });

  it('marks any tool contract needs-human', () => {
    assert.equal(isProtected('tools/brief.tool.json'), true);
    assert.equal(classifyRecord({ ...BASE, files: ['tools/brief.tool.json'] }).mark, MARKS.NEEDS_HUMAN);
  });

  it('marks a named decision needs-human even with a fixable file', () => {
    const res = classifyRecord({ ...BASE, decision: 'architecture' });
    assert.equal(res.mark, MARKS.NEEDS_HUMAN);
    assert.ok(res.reasons.some((r) => r.includes('architecture')));
  });

  it('blocks a record with no file', () => {
    const res = classifyRecord({ ...BASE, files: [] });
    assert.equal(res.mark, MARKS.BLOCKED);
    assert.ok(res.reasons.some((r) => r.startsWith('files:')));
  });

  it('blocks a record with no reproduce step', () => {
    const res = classifyRecord({ ...BASE, reproduce: '' });
    assert.equal(res.mark, MARKS.BLOCKED);
    assert.ok(res.reasons.some((r) => r.startsWith('reproduce:')));
  });

  it('does not treat a lookalike path as protected', () => {
    assert.equal(isProtected('tools/agent-guard-notes.md'), false);
    assert.equal(isProtected('docs/AGENTS.md'), false);
    assert.equal(isProtected('AGENTS.md.bak'), false);
  });

  it('sees through a traversal and a case change', () => {
    assert.equal(isProtected('tools/../AGENTS.md'), true);
    assert.equal(isProtected('agents.md'), true);
    assert.equal(isProtected('docs/../.agents/rules/x.md'), true);
  });

  it('protects a directory named without its trailing slash', () => {
    assert.equal(isProtected('.agents/rules'), true);
    assert.equal(isProtected('foo/../.agents/rules'), true);
  });

  it('fails closed on a path it cannot resolve', () => {
    assert.equal(isProtected('foo/../../AGENTS.md'), true);
    assert.equal(isProtected('../outside.mjs'), true);
    assert.equal(isProtected('/etc/passwd'), true);
  });

  it('does not refuse a reference to an environment variable', () => {
    const res = validateRecord({ ...BASE, reproduce: 'API_KEY=process.env.API_KEY node tools/check.mjs' });
    assert.equal(res.ok, true);
  });

  it('refuses an AWS key and a Basic header', () => {
    const aws = validateRecord({ ...BASE, what: 'the log printed AWS_SECRET_ACCESS_KEY=abcdefghijklmnop' });
    assert.equal(aws.ok, false);
    const basic = validateRecord({ ...BASE, what: 'the header was Authorization: Basic dXNlcjpwYXNzMTIzNDU2' });
    assert.equal(basic.ok, false);
  });

  it('refuses a POSIX path that follows an equals sign', () => {
    const res = validateRecord({ ...BASE, what: 'it read path=/mnt/data/x.json' });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('absolute path forbidden')));
  });
});

describe('friction-log: identity', () => {
  it('gives the same complaint the same fingerprint', () => {
    assert.equal(fingerprintOf(BASE), fingerprintOf({ ...BASE, what: BASE.what.toUpperCase() }));
  });

  it('gives a different complaint a different fingerprint', () => {
    assert.notEqual(fingerprintOf(BASE), fingerprintOf({ ...BASE, reproduce: 'node tools/other.mjs' }));
  });

  it('covers the words, so the same symptom on another file is not a duplicate', () => {
    assert.equal(fingerprintOf(BASE), fingerprintOf({ ...BASE, files: ['tools/other.mjs'] }));
    assert.notDeepEqual(filesOf(BASE), filesOf({ ...BASE, files: ['tools/other.mjs'] }));
  });

  it('builds a readable id from the complaint', () => {
    const id = idOf(BASE);
    assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{16}$/);
    assert.ok(id.startsWith('the-gate-refused-a-file'));
    assert.ok(id.length <= 65);
  });
});

describe('friction-log: fresh clone', () => {
  it('sweeps an empty workspace with no records folder', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-fresh-'));
    try {
      const result = sweep({ root: fresh });
      assert.equal(result.counts.total, 0);
      assert.deepEqual(result.rows, []);
      assert.equal(fs.existsSync(path.join(fresh, '.runs', 'friction')), false);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('friction-log: files', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes a record and its markdown beside it', () => {
    const res = writeRecord(BASE, { root, dir: '.runs/friction' });
    assert.equal(res.status, 'written');
    assert.equal(res.mark, MARKS.AGENT_READY);
    assert.ok(fs.existsSync(path.join(root, res.files.json)));
    assert.ok(fs.existsSync(path.join(root, res.files.md)));
    const md = fs.readFileSync(path.join(root, res.files.md), 'utf-8');
    assert.ok(md.includes('## How to reproduce'));
    assert.ok(md.includes('node tools/check.mjs'));
  });

  it('refuses a folder outside the workspace', () => {
    const res = writeRecord(BASE, { root, dir: '../escape' });
    assert.equal(res.status, 'failed');
    assert.ok(res.problems.some((p) => p.includes('escapes the workspace root')));
  });

  it('sweeps every record and counts the marks', () => {
    writeRecord({ ...BASE, what: 'the hard rule forbids the shortcut I needed', files: ['AGENTS.md'] }, { root, dir: '.runs/friction' });
    writeRecord({ ...BASE, what: 'the sweep cannot name the file it should fix', files: [] }, { root, dir: '.runs/friction' });
    const result = sweep({ root, dir: '.runs/friction' });
    assert.equal(result.counts.total, 3);
    assert.equal(result.counts[MARKS.AGENT_READY], 1);
    assert.equal(result.counts[MARKS.NEEDS_HUMAN], 1);
    assert.equal(result.counts[MARKS.BLOCKED], 1);
    assert.ok(fs.existsSync(path.join(root, '.runs/friction/sweep.json')));
  });

  it('files the same complaint on another file, and refuses it on the same file', () => {
    const other = writeRecord({ ...BASE, files: ['tools/other.mjs'] }, { root, dir: '.runs/friction' });
    assert.equal(other.status, 'written');
    const same = writeRecord(BASE, { root, dir: '.runs/friction' });
    assert.equal(same.status, 'duplicate');
    assert.equal(readRecords(path.join(root, '.runs/friction')).length, 4);
  });

  it('files the same complaint with a different decision', () => {
    const decided = writeRecord({ ...BASE, decision: 'product' }, { root, dir: '.runs/friction' });
    assert.equal(decided.status, 'written');
    assert.equal(decided.mark, MARKS.NEEDS_HUMAN);
  });

  it('reads back what it wrote', () => {
    const entries = readRecords(path.join(root, '.runs/friction'));
    assert.equal(entries.length, 5);
    assert.ok(entries.every((entry) => entry.record?.filedAt));
  });

  it('renders a sweep a person can read', () => {
    const md = renderSweep(sweep({ root, dir: '.runs/friction', write: false }));
    assert.ok(md.includes('- agent-ready: 2'));
    assert.ok(md.includes('- needs-human: 2'));
  });

  it('refuses to overwrite a record filed under an explicit id', () => {
    const first = { ...BASE, what: 'the sweep wrote a record under an id I chose' };
    const res = writeRecord({ ...first, id: 'my-friction' }, { root, dir: '.runs/friction' });
    assert.equal(res.status, 'written');
    const again = writeRecord(
      { ...first, id: 'my-friction', what: 'a different complaint entirely' },
      { root, dir: '.runs/friction' },
    );
    assert.equal(again.status, 'failed');
    assert.ok(again.problems.some((p) => p.includes('already filed')));
  });
});
