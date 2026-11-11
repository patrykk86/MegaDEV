#!/usr/bin/env node
/**
 * tools/codebase-map.mjs - Generated map of the workspace primitives
 *
 * Answers "which primitive does what, and what calls it" from the source, not from memory:
 * - Reads each tools/*.mjs docblock for its purpose line and its bullets.
 * - Derives "called by" from local imports, so the reverse index cannot drift by hand.
 * - Reads each .agents/skills/<name>/SKILL.md for its name and the tool it drives.
 * - Hashes every input, so --check fails the moment the map goes stale.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseFrontmatter } from './check-skills.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINGERPRINT_RE = /^<!-- map-fingerprint: ([0-9a-f]{64}) -->$/m;
const EPISODE_RE = /^s\d{2}e\d{2}$/;
const ABOUT_CHARS = 140;

export const MAP_PATH = 'memory/CODEBASE-MAP.md';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function docLines(source) {
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean);
}

function purpose(lines) {
  const first = (lines[0] ?? '').replace(/^@fileoverview\s*/, '');
  const dash = first.indexOf(' - ');
  return dash === -1 ? first : first.slice(dash + 3);
}

function localImports(source) {
  const found = new Set();
  for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
    found.add(`tools/${match[1].replace(/^\.\//, '')}`);
  }
  return [...found].sort();
}

function exportsOf(source) {
  const found = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_$]+)/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

function moduleRows(root) {
  const dir = path.join(root, 'tools');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .sort();
  return files.map((name) => {
    const source = fs.readFileSync(path.join(dir, name), 'utf-8');
    const lines = docLines(source);
    const stem = name.replace(/\.mjs$/, '');
    return {
      rel: `tools/${name}`,
      purpose: purpose(lines) || '(no docblock)',
      imports: localImports(source),
      exports: exportsOf(source),
      schema: fs.existsSync(path.join(dir, `${stem}.tool.json`)) ? `tools/${stem}.tool.json` : null,
      test: fs.existsSync(path.join(dir, `${stem}.test.mjs`)) ? `tools/${stem}.test.mjs` : null,
      hash: sha256(source),
    };
  });
}

function skillRows(root) {
  const dir = path.join(root, '.agents', 'skills');
  if (!fs.existsSync(dir)) {
    return [];
  }
  const skillDirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .filter((skillDir) => fs.existsSync(path.join(skillDir, 'SKILL.md')));
  return skillDirs
    .map((skillDir) => {
      const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
      let fm = {};
      try {
        fm = parseFrontmatter(raw).fm;
      } catch {
        fm = {};
      }
      return {
        name: fm.name ?? path.basename(skillDir),
        about: String(fm.description ?? '').slice(0, ABOUT_CHARS),
        tool: fm.metadata?.tools ?? '-',
        hash: sha256(raw),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function episodeRows(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && EPISODE_RE.test(entry.name))
    .map((entry) => {
      const files = fs.readdirSync(path.join(root, entry.name));
      return {
        name: entry.name,
        notes: files.includes('LESSON-NOTES.md') ? 'LESSON-NOTES.md' : '-',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fingerprint(rows, skills, episodes) {
  const parts = [
    ...rows.map((row) => `${row.rel}:${row.hash}:${row.schema ?? ''}:${row.test ?? ''}`),
    ...skills.map((skill) => `skill:${skill.name}:${skill.hash}`),
    ...episodes.map((episode) => `episode:${episode.name}:${episode.notes}`),
  ];
  return sha256(parts.sort().join('\n'));
}

function calledBy(rows) {
  const index = new Map();
  for (const row of rows) {
    for (const target of row.imports) {
      if (!index.has(target)) {
        index.set(target, []);
      }
      index.get(target).push(row.rel);
    }
  }
  return index;
}

function cell(text) {
  return (
    String(text)
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
      .trim() || '-'
  );
}

function codeList(value) {
  const items = String(value ?? '')
    .split(', ')
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    return '-';
  }
  return items.map((item) => `\`${item}\``).join(', ');
}

function renderMap(model) {
  const index = calledBy(model.rows);
  const lines = [
    '# Codebase map',
    '',
    `<!-- map-fingerprint: ${model.fingerprint} -->`,
    '',
    'Generated by `tools/codebase-map.mjs`; do not edit by hand. Run `node tools/codebase-map.mjs`',
    'after a change, and `node tools/codebase-map.mjs --check` (also run by `node tools/check.mjs`)',
    'to prove the map is current. "Called by" is derived from local imports, not asserted.',
    '',
    '## Primitives',
    '',
    '| Module | What it does | Exports | Schema | Test | Called by |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
  ];
  for (const row of model.rows) {
    lines.push(
      `| \`${row.rel}\` | ${cell(row.purpose)} | ${codeList(row.exports.join(', '))} | ${codeList(row.schema)} | ${codeList(row.test)} | ${codeList(index.get(row.rel)?.join(', '))} |`,
    );
  }
  lines.push('', '## Skills', '', '| Skill | What it is for | Tool |', '| :--- | :--- | :--- |');
  for (const skill of model.skills) {
    lines.push(`| \`${skill.name}\` | ${cell(skill.about)} | ${codeList(skill.tool)} |`);
  }
  lines.push('', '## Episodes', '', '| Folder | Notes |', '| :--- | :--- |');
  for (const episode of model.episodes) {
    lines.push(`| \`${episode.name}\` | ${episode.notes} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function buildMap(root = ROOT) {
  const rows = moduleRows(root);
  const skills = skillRows(root);
  const episodes = episodeRows(root);
  const model = { rows, skills, episodes, fingerprint: fingerprint(rows, skills, episodes) };
  return { ...model, markdown: renderMap(model) };
}

export function verifyMap(root = ROOT, file = path.join(root, MAP_PATH)) {
  if (!fs.existsSync(file)) {
    return { ok: false, problems: [`${MAP_PATH}: missing; run node tools/codebase-map.mjs`] };
  }
  const match = fs.readFileSync(file, 'utf-8').match(FINGERPRINT_RE);
  if (!match) {
    return { ok: false, problems: [`${MAP_PATH}: no fingerprint; run node tools/codebase-map.mjs`] };
  }
  const expected = buildMap(root).fingerprint;
  if (match[1] !== expected) {
    return { ok: false, problems: [`${MAP_PATH}: stale; run node tools/codebase-map.mjs`] };
  }
  return { ok: true, problems: [] };
}

function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      stdout: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const map = buildMap(ROOT);

  if (values.check) {
    const res = verifyMap(ROOT);
    console.log(JSON.stringify({ ...res, fingerprint: map.fingerprint }, null, 2));
    process.exitCode = res.ok ? 0 : 1;
    return;
  }
  if (values.stdout) {
    process.stdout.write(map.markdown);
    return;
  }
  const target = path.join(ROOT, MAP_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, map.markdown, 'utf-8');
  const summary = {
    written: MAP_PATH,
    primitives: map.rows.length,
    skills: map.skills.length,
    episodes: map.episodes.length,
    fingerprint: map.fingerprint,
  };
  console.log(JSON.stringify(summary, null, 2));
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
