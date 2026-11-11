#!/usr/bin/env node
/**
 * tools/codebase-map.test.mjs - Unit tests for the generated codebase map
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildMap, verifyMap } from './codebase-map.mjs';

const ALPHA = `/**
 * tools/alpha.mjs - Alpha primitive
 *
 * - does the first thing.
 */

export const A = 1;
`;

const BETA = `/**
 * tools/beta.mjs - Beta primitive
 */

import { A } from './alpha.mjs';

export function run() {
  return A;
}
`;

function writeFixture(root) {
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(root, 's01e01'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'alpha.mjs'), ALPHA, 'utf-8');
  fs.writeFileSync(path.join(root, 'tools', 'beta.mjs'), BETA, 'utf-8');
  fs.writeFileSync(path.join(root, 'tools', 'alpha.tool.json'), '{"name":"alpha"}\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'tools', 'alpha.test.mjs'), '// test\n', 'utf-8');
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill.\nmetadata:\n  tools: tools/alpha.mjs\n---\n\n# demo\n',
    'utf-8',
  );
  fs.writeFileSync(path.join(root, 's01e01', 'LESSON-NOTES.md'), '# notes\n', 'utf-8');
}

describe('codebase-map: generation', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-map-'));
    writeFixture(root);
  });

  after(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps every module and skips test files', () => {
    const map = buildMap(root);
    const names = map.rows.map((row) => row.rel);
    assert.deepEqual(names, ['tools/alpha.mjs', 'tools/beta.mjs']);
    const alpha = map.rows[0];
    assert.equal(alpha.purpose, 'Alpha primitive');
    assert.equal(alpha.schema, 'tools/alpha.tool.json');
    assert.equal(alpha.test, 'tools/alpha.test.mjs');
    assert.deepEqual(alpha.exports, ['A']);
  });

  it('derives called-by from local imports', () => {
    const map = buildMap(root);
    const beta = map.rows[1];
    assert.deepEqual(beta.imports, ['tools/alpha.mjs']);
    assert.ok(map.markdown.includes('| `tools/alpha.mjs` |'));
    assert.ok(map.markdown.includes('| `tools/beta.mjs` | Beta primitive | `run` | - | - | - |'));
  });

  it('reads skills and episodes', () => {
    const map = buildMap(root);
    assert.equal(map.skills[0].name, 'demo');
    assert.equal(map.skills[0].tool, 'tools/alpha.mjs');
    assert.equal(map.episodes[0].name, 's01e01');
    assert.equal(map.episodes[0].notes, 'LESSON-NOTES.md');
  });

  it('is deterministic across two builds', () => {
    assert.equal(buildMap(root).fingerprint, buildMap(root).fingerprint);
  });
});

describe('codebase-map: staleness gate', () => {
  let root;
  let mapFile;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-map-gate-'));
    writeFixture(root);
    mapFile = path.join(root, 'CODEBASE-MAP.md');
    fs.writeFileSync(mapFile, buildMap(root).markdown, 'utf-8');
  });

  after(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes on a freshly written map', () => {
    const res = verifyMap(root, mapFile);
    assert.equal(res.ok, true);
    assert.deepEqual(res.problems, []);
  });

  it('fails once a module changes', () => {
    fs.writeFileSync(path.join(root, 'tools', 'gamma.mjs'), '/**\n * tools/gamma.mjs - Gamma\n */\n', 'utf-8');
    const res = verifyMap(root, mapFile);
    assert.equal(res.ok, false);
    assert.ok(res.problems[0].includes('stale'));
  });

  it('fails on a missing map and on a map without a fingerprint', () => {
    assert.equal(verifyMap(root, path.join(root, 'absent.md')).ok, false);
    const bare = path.join(root, 'bare.md');
    fs.writeFileSync(bare, '# Codebase map\n', 'utf-8');
    const res = verifyMap(root, bare);
    assert.equal(res.ok, false);
    assert.ok(res.problems[0].includes('no fingerprint'));
  });
});
