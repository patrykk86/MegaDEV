#!/usr/bin/env node
/**
 * tools/skill-links.test.mjs - Health test for the link between a skill and the tool it drives
 *
 * - Every `metadata.tools` and `metadata.schema` a skill declares resolves to a file in the repository.
 * - A skill that ships a `scripts/` folder declares `metadata.tools`, so a missing link fails here
 *   instead of passing silently: no gate reads these paths.
 * - The live skill set is checked, and a fixture with three faults proves each assertion fires.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, vendoredEntryFor, VENDORED_SKILLS } from './check-skills.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTSIDE = /^(?:[A-Za-z]:[\\/]|\/)/;

export function declaredLinks(fm) {
  const raw = [fm.metadata?.tools, fm.metadata?.schema].filter(Boolean).join(',');
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function linkProblem(root, name, link) {
  if (OUTSIDE.test(link) || link.includes('\\')) {
    return [`${name}: "${link}" must be a repository-relative path with forward slashes`];
  }
  if (!fs.existsSync(path.join(root, link))) {
    return [`${name}: "${link}" does not exist`];
  }
  return [];
}

function skillProblems(root, name) {
  const dir = path.join(root, '.agents', 'skills', name);
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    return [`${name}: missing SKILL.md`];
  }
  let fm;
  try {
    fm = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8')).fm;
  } catch (error) {
    return [`${name}: ${error.message}`];
  }
  const links = declaredLinks(fm);
  const problems = links.flatMap((link) => linkProblem(root, name, link));
  // A vendored pack runs its own scripts and declares no link into this repository; the exemption is
  // the same hash check that excuses its description wording, so a tampered pack is still judged.
  const vendored = vendoredEntryFor(dir, skillFile) !== null;
  if (links.length === 0 && fs.existsSync(path.join(dir, 'scripts')) && !vendored) {
    problems.push(`${name}: ships scripts/ but declares no metadata.tools`);
  }
  return problems;
}

export function linkProblems(root) {
  const skillsRoot = path.join(root, '.agents', 'skills');
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => skillProblems(root, name));
}

test('every skill in this repository links to a tool that exists', (t) => {
  const skillsRoot = path.join(ROOT, '.agents', 'skills');
  if (!fs.existsSync(skillsRoot)) {
    t.skip('no skill folder in this checkout, so there is no link to check');
    return;
  }
  assert.deepEqual(linkProblems(ROOT), []);
});

test('a vendored pack is exempt, and a tampered one is not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-links-vendored-'));
  const entry = VENDORED_SKILLS[0];
  const dir = path.join(root, '.agents', 'skills', entry.name);
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'go.mjs'), '// go\n', 'utf-8');
    const head = `---\nname: ${entry.name}\ndescription: A vendored skill.\n---\n\n# ${entry.name}\n`;
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, head, 'utf-8');

    // Not the installed bytes, so the hash does not match and the exemption does not apply.
    assert.deepEqual(linkProblems(root), [
      `${entry.name}: ships scripts/ but declares no metadata.tools`,
    ]);

    const original = entry.sha256;
    entry.sha256 = crypto.createHash('sha256').update(head, 'utf-8').digest('hex');
    try {
      assert.deepEqual(
        linkProblems(root),
        [],
        'an unmodified vendored pack runs its own scripts and links to nothing here',
      );
    } finally {
      entry.sha256 = original;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the health check catches a missing tool, an absolute path and an unlinked scripts folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-links-'));
  const skill = (name, frontmatter, withScripts) => {
    const dir = path.join(root, '.agents', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    const head = `---\nname: ${name}\ndescription: A demo skill.\n${frontmatter}---\n\n# ${name}\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), head, 'utf-8');
    if (withScripts) {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'check.mjs'), '// check\n', 'utf-8');
    }
  };
  try {
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'real.mjs'), '// tool\n', 'utf-8');
    skill('linked', 'metadata:\n  tools: tools/real.mjs\n', true);
    skill('missing', 'metadata:\n  tools: tools/gone.mjs\n', false);
    skill('absolute', 'metadata:\n  tools: /opt/tool.mjs\n', false);
    skill('unlinked', '', true);

    assert.deepEqual(linkProblems(root), [
      'absolute: "/opt/tool.mjs" must be a repository-relative path with forward slashes',
      'missing: "tools/gone.mjs" does not exist',
      'unlinked: ships scripts/ but declares no metadata.tools',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
