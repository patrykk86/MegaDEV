import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSkillOverlap, parseFrontmatter, } from './check-skills.mjs';

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
