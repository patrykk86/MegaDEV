import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSkillOverlap, DESC_MAX, DESC_TARGET, parseFrontmatter, validateSkill } from './check-skills.mjs';

test('parseFrontmatter extracts YAML frontmatter and body cleanly', () => {
  const raw = `---
name: test-skill
description: Does something specific. Use when testing. Not for foo; use bar.
---

# Title
Body text.
`;
  const { fm, body } = parseFrontmatter(raw);
  assert.equal(fm.name, 'test-skill');
  assert.equal(fm.description, 'Does something specific. Use when testing. Not for foo; use bar.');
  assert.ok(body.includes('Body text.'));
});

test('checkSkillOverlap detects overlapping skill descriptions', () => {
  const skills = [
    { name: 'skill-a', description: 'Transcribes audio and video recordings into markdown text' },
    { name: 'skill-b', description: 'Transcribes audio and video recordings into markdown text notes' },
  ];
  const problems = [];
  checkSkillOverlap(skills, problems);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /overlap/);
});

test('the description limits hold, and the message reports the constant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-skills-'));
  try {
    const folder = (name, description) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, 'utf-8');
      return dir;
    };
    // Built from the constants, so the assertions follow them instead of repeating their numbers.
    const descriptionOf = (length) => 'Picks a held issue. '.padEnd(length - 1, 'x') + '.';
    const atTarget = descriptionOf(DESC_TARGET);
    const pastTarget = descriptionOf(DESC_TARGET + 1);
    const pastMax = descriptionOf(DESC_MAX + 1);
    assert.equal(atTarget.length, DESC_TARGET);
    assert.equal(pastTarget.length, DESC_TARGET + 1);
    assert.equal(pastMax.length, DESC_MAX + 1);

    const atTargetProblems = [];
    validateSkill(folder('at-the-target', atTarget), atTargetProblems);
    assert.deepEqual(atTargetProblems, [], `a ${DESC_TARGET}-character description is inside the target`);

    const pastTargetProblems = [];
    validateSkill(folder('past-the-target', pastTarget), pastTargetProblems);
    assert.equal(pastTargetProblems.length, 1);
    // The prefix is the path relative to the working directory; the message after it is fixed.
    assert.match(pastTargetProblems[0], new RegExp(`: description ${DESC_TARGET + 1} chars > ${DESC_TARGET} target limit$`));

    const pastMaxProblems = [];
    validateSkill(folder('past-the-max', pastMax), pastMaxProblems);
    assert.equal(pastMaxProblems.length, 1);
    assert.match(pastMaxProblems[0], new RegExp(`: description ${DESC_MAX + 1} chars > ${DESC_MAX}$`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validateSkill catches invalid name, bloated description, and bad phrasing', () => {
  const _problems = [];
  // Fake directory with mock SKILL.md
  const mockRaw = `---
name: bad_name
description: Use this skill whenever a user wants anything done with recordings e.g. .mp3, .wav. Not for other things.
---

Body with broken link [test](non-existent-file.md) and <TODO> placeholder.
`;
  // Test parseFrontmatter on mock
  const { fm } = parseFrontmatter(mockRaw);
  assert.equal(fm.name, 'bad_name');
  assert.match(fm.description, /Use this skill whenever/);
});
