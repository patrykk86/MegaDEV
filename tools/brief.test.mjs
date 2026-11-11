#!/usr/bin/env node
/**
 * tools/brief.test.mjs - Unit tests for the standing brief
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STATUS, createBrief, readBrief, renderBrief, validateBrief } from './brief.mjs';

const COMPLETE = {
  job: 's03e02-gap-one',
  title: 'standing brief',
  intent: 'a change starts from a written definition of done',
  done: ['a complete brief is written under the runs folder', 'an incomplete brief is refused'],
  proof: ['node --test tools/brief.test.mjs', 'node tools/brief.mjs --job demo --done aa --proof bb'],
  existing: 'the crew skill already demands five blocks for a delegated job',
  boundaries: ['no hard policy file is edited here', 'no secret is written into a brief'],
};

describe('brief: validation', () => {
  it('passes a complete brief', () => {
    const res = validateBrief(COMPLETE);
    assert.equal(res.ok, true);
    assert.deepEqual(res.problems, []);
    assert.equal(res.blocks.done.length, 2);
  });

  it('refuses a brief with no done block', () => {
    const res = validateBrief({ ...COMPLETE, done: [] });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.startsWith('done: missing')));
  });

  it('refuses one proof for two criteria', () => {
    const res = validateBrief({ ...COMPLETE, proof: COMPLETE.proof.slice(0, 1) });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.startsWith('proof: needs one entry per criterion')));
  });

  it('refuses a block that looks like a credential', () => {
    const res = validateBrief({
      ...COMPLETE,
      boundaries: ['api_key = "abcdef1234567890" stays out of the brief'],
    });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('looks like a credential')));
  });

  it('refuses an absolute path', () => {
    const drive = 'C';
    const res = validateBrief({ ...COMPLETE, intent: `${drive}:\\temp\\scratch is cleaned up` });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('absolute path forbidden')));
  });

  it('refuses a non-object brief', () => {
    const res = validateBrief(null);
    assert.equal(res.ok, false);
    assert.ok(res.problems[0].startsWith('brief:'));
  });
});

describe('brief: writing and reading back', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
  });

  after(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes both files under .runs/<job>', () => {
    const res = createBrief(COMPLETE, { root });
    assert.equal(res.status, STATUS.PASSED);
    assert.equal(res.files.json, '.runs/s03e02-gap-one/brief.json');
    assert.equal(res.files.md, '.runs/s03e02-gap-one/brief.md');
    const md = fs.readFileSync(path.join(root, res.files.md), 'utf-8');
    assert.ok(md.includes('## Done when'));
    assert.ok(md.includes('proof: node --test tools/brief.test.mjs'));
    assert.ok(md.includes('- no secret is written into a brief'));
  });

  it('reads a written brief back as valid', () => {
    const res = readBrief(path.join(root, '.runs/s03e02-gap-one/brief.json'));
    assert.equal(res.ok, true);
    assert.equal(res.job, 's03e02-gap-one');
  });

  it('reports a tampered brief as invalid', () => {
    const file = path.join(root, '.runs/s03e02-gap-one/brief.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
    record.blocks.proof = [];
    const tampered = path.join(root, 'tampered.json');
    fs.writeFileSync(tampered, JSON.stringify(record), 'utf-8');
    const res = readBrief(tampered);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.startsWith('proof: missing')));
  });

  it('refuses a job id that would escape the root', () => {
    const res = createBrief({ ...COMPLETE, job: '../escape' }, { root });
    assert.equal(res.status, STATUS.FAILED);
    assert.ok(res.problems[0].startsWith('job:'));
  });

  it('renders every criterion beside its proof', () => {
    const md = renderBrief('demo', validateBrief(COMPLETE).blocks);
    assert.ok(md.startsWith('# Brief: demo'));
    assert.ok(md.includes('1. a complete brief is written under the runs folder'));
    assert.ok(md.includes('   - proof: node --test tools/brief.test.mjs'));
  });
});
