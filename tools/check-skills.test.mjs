import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkSkillOverlap,
  DESC_MAX,
  DESC_TARGET,
  parseFrontmatter,
  validateSkill,
  VENDORED_SKILLS,
  vendoredEntryFor,
} from './check-skills.mjs'

test('parseFrontmatter extracts YAML frontmatter and body cleanly', () => {
  const raw = `---
name: test-skill
description: Does something specific. Use when testing. Not for foo; use bar.
---

# Title
Body text.
`
  const { fm, body } = parseFrontmatter(raw)
  assert.equal(fm.name, 'test-skill')
  assert.equal(
    fm.description,
    'Does something specific. Use when testing. Not for foo; use bar.',
  )
  assert.ok(body.includes('Body text.'))
})

test('checkSkillOverlap detects overlapping skill descriptions', () => {
  const skills = [
    {
      name: 'skill-a',
      description: 'Transcribes audio and video recordings into markdown text',
    },
    {
      name: 'skill-b',
      description:
        'Transcribes audio and video recordings into markdown text notes',
    },
  ]
  const problems = []
  checkSkillOverlap(skills, problems)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /overlap/)
})

test('the description limits hold, and the message reports the constant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-skills-'))
  try {
    const folder = (name, description) => {
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
        'utf-8',
      )
      return dir
    }
    // Built from the constants, so the assertions follow them instead of repeating their numbers.
    const descriptionOf = (length) =>
      `${'Picks a held issue. '.padEnd(length - 1, 'x')}.`
    const atTarget = descriptionOf(DESC_TARGET)
    const pastTarget = descriptionOf(DESC_TARGET + 1)
    const pastMax = descriptionOf(DESC_MAX + 1)
    assert.equal(atTarget.length, DESC_TARGET)
    assert.equal(pastTarget.length, DESC_TARGET + 1)
    assert.equal(pastMax.length, DESC_MAX + 1)

    const atTargetProblems = []
    validateSkill(folder('at-the-target', atTarget), atTargetProblems)
    assert.deepEqual(
      atTargetProblems,
      [],
      `a ${DESC_TARGET}-character description is inside the target`,
    )

    const pastTargetProblems = []
    validateSkill(folder('past-the-target', pastTarget), pastTargetProblems)
    assert.equal(pastTargetProblems.length, 1)
    // The prefix is the path relative to the working directory; the message after it is fixed.
    assert.match(
      pastTargetProblems[0],
      new RegExp(
        `: description ${DESC_TARGET + 1} chars > ${DESC_TARGET} target limit$`,
      ),
    )

    const pastMaxProblems = []
    validateSkill(folder('past-the-max', pastMax), pastMaxProblems)
    assert.equal(pastMaxProblems.length, 1)
    assert.match(
      pastMaxProblems[0],
      new RegExp(`: description ${DESC_MAX + 1} chars > ${DESC_MAX}$`),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('validateSkill catches invalid name, bloated description, and bad phrasing', () => {
  const _problems = []
  // Fake directory with mock SKILL.md
  const mockRaw = `---
name: bad_name
description: Use this skill whenever a user wants anything done with recordings e.g. .mp3, .wav. Not for other things.
---

Body with broken link [test](non-existent-file.md) and <TODO> placeholder.
`
  // Test parseFrontmatter on mock
  const { fm } = parseFrontmatter(mockRaw)
  assert.equal(fm.name, 'bad_name')
  assert.match(fm.description, /Use this skill whenever/)
})

test('a vendored skill skips the description style rules and nothing else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-'))
  try {
    const name = VENDORED_SKILLS[0].name
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'SKILL.md')
    // First-person, opens with "Use", and names two extensions: three style failures at once.
    const description =
      'Use when I need to check .mp3 and .wav handling. I can do that.'
    fs.writeFileSync(
      file,
      `---\nname: ${name}\ndescription: ${description}\n---\n\nBody with <TODO> placeholder.\n`,
      'utf-8',
    )

    // The hash of this fixture is not the installed one, so the exemption does not apply.
    const unmodified = []
    validateSkill(dir, unmodified)
    assert.ok(
      unmodified.some((p) => p.includes('description must be third person')),
      'an edited pack is judged on its own wording',
    )
    assert.equal(vendoredEntryFor(dir, file), null)

    // Re-register the fixture under its real hash: only the style findings disappear.
    const realHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex')
    const entry = VENDORED_SKILLS.find((candidate) => candidate.name === name)
    const original = entry.sha256
    entry.sha256 = realHash
    try {
      assert.deepEqual(vendoredEntryFor(dir, file), { name, provenance: entry.provenance })
      const exempt = []
      validateSkill(dir, exempt)
      assert.ok(
        exempt.some((p) => p.includes('placeholder text in body')),
        'the body rules still run on a vendored skill',
      )
      assert.ok(
        !exempt.some((p) => p.includes('description')),
        `no description finding survives the exemption: ${exempt.join(' | ')}`,
      )
    } finally {
      entry.sha256 = original
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('every installed vendored pack still matches the hash the exemption records', () => {
  const skillsRoot = path.join(process.cwd(), '.agents', 'skills')
  const checked = []
  for (const entry of VENDORED_SKILLS) {
    const dir = path.join(skillsRoot, entry.name)
    if (!fs.existsSync(dir)) {
      continue
    }
    checked.push(entry.name)
    assert.deepEqual(
      vendoredEntryFor(dir),
      { name: entry.name, provenance: entry.provenance },
      `${entry.name}: SKILL.md changed since it was installed, so the exemption no longer applies. ` +
        'Update the hash in tools/check-skills.mjs in the same commit as the pack.',
    )
  }
  assert.ok(checked.length > 0, 'no vendored pack is installed in this checkout')
})
