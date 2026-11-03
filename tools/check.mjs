#!/usr/bin/env node
/**
 * tools/check.mjs - Layer 2 Static Analysis & Agent Guardrail Suite for MegaDEV
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkillOverlap, validateSkill } from './check-skills.mjs';
import { validateSupportKb } from './kb-check.mjs';
import { aggregateHandoffs, validateHandoffObject } from './transcribe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SECRET_PATTERNS = [
  {
    name: 'Hardcoded MEGA Ticket (v1.eyJ...)',
    regex: /["'`]v1\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}["'`]/,
    fix: 'Read process.env.MEGADEV_TICKET from .env instead of hardcoding tickets.',
  },
  {
    name: 'Hardcoded X-Megadev-Key header UUID',
    regex: /["']X-Megadev-Key["']\s*:\s*["'][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']/i,
    fix: 'Use tools/hub-client.mjs or read MEGADEV_KEY from .env instead of hardcoding X-Megadev-Key.',
  },
  {
    name: 'Hardcoded OpenAI / OpenRouter API key',
    regex: /\bsk-(?:or-v1-|proj-)[A-Za-z0-9_-]{20,}\b/,
    fix: 'Store API keys in .env only; never place keys in source or markdown files.',
  },
];

const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'mega-examples']);

function walkFiles(dir, result = []) {
  if (!fs.existsSync(dir)) {
    return result;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, result);
    } else {
      result.push(full);
    }
  }
  return result;
}

function checkCanonicalTools(problems) {
  const forbiddenDuplicates = [
    ['tools/transcribe.py', 'Use the canonical Node.js CLI at tools/transcribe.mjs.'],
    ['s01e02/analyze.py', 'Use tools/transcribe.mjs instead of ad-hoc multi-source segment scripts.'],
  ];
  for (const [rel, reason] of forbiddenDuplicates) {
    if (fs.existsSync(path.join(ROOT, rel))) {
      problems.push(`${rel}: duplicate implementation detected. ${reason}`);
    }
  }
}

function shouldSkipScan(rel, base) {
  return (
    base === '.env' ||
    rel === '.agents/mcp_config.json' ||
    base.endsWith('.log') ||
    /\.(mp3|mp4|wav|pyc|woff2)$/i.test(base)
  );
}

function scanSingleFile(file, problems) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const base = path.basename(file);
  if (shouldSkipScan(rel, base)) {
    return;
  }

  const content = fs.readFileSync(file, 'utf-8');
  content.split(/\r?\n/).forEach((line, idx) => {
    for (const pat of SECRET_PATTERNS) {
      if (pat.regex.test(line)) {
        problems.push(`${rel}:${idx + 1}: ${pat.name} detected. ${pat.fix}`);
      }
    }
  });

  if (/\.(py|mjs|js|ts)$/i.test(rel) && rel !== 'tools/hub-client.mjs' && rel !== 'tools/check.mjs') {
    if (/X-Megadev-Key/i.test(content)) {
      problems.push(`${rel}: duplicate Hub HTTP client detected ("X-Megadev-Key"). Use tools/hub-client.mjs.`);
    }
  }

  if (/^s\d\de\d\d\/.*\.(py|mjs|js|ts)$/i.test(rel)) {
    const mentionsVideo = /video_audio_segments\.json|crank-review|crank_transcript\.txt/i.test(content);
    const mentionsAudio = /(?<!video_)audio_segments\.json|status-line|status_transcript\.txt/i.test(content);
    if (mentionsVideo && mentionsAudio) {
      problems.push(`${rel}: multi-source isolation violation — script references both video and audio streams.`);
    }
  }
}

function checkSecretsAndIsolation(problems) {
  for (const file of walkFiles(ROOT)) {
    scanSingleFile(file, problems);
  }
}

function checkSourceManifest(dir, problems) {
  const mf = path.join(dir, 'sources.json');
  if (!fs.existsSync(mf)) {
    return;
  }
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(mf, 'utf-8'));
  } catch (err) {
    problems.push(`${rel(mf)}: invalid JSON (${err.message})`);
    return;
  }
  const sources = data.sources || [];
  const ids = new Set();
  const files = new Set();
  const CLOCK_RE = /^(UTC|local[+-]\d{1,2}h)$/;
  for (const s of sources) {
    if (!s.sourceId || ids.has(s.sourceId)) {
      problems.push(`${rel(mf)}: duplicate or empty sourceId "${s.sourceId}".`);
    }
    ids.add(s.sourceId);
    if (files.has(s.originFile)) {
      problems.push(`${rel(mf)}: originFile "${s.originFile}" claimed by multiple sources.`);
    }
    files.add(s.originFile);
    if (!CLOCK_RE.test(s.clockReference ?? '')) {
      problems.push(`${rel(mf)}: ${s.sourceId} clockReference "${s.clockReference}" not UTC|local±Nh.`);
    }
  }
  const found = fs
    .readdirSync(dir)
    .filter((n) => /^handoff_.*\.json$/i.test(n))
    .map((n) => n.replace(/^handoff_|\.json$/gi, ''));
  for (const id of ids) {
    if (!found.includes(id)) {
      problems.push(`${rel(dir)}: missing handoff for declared source "${id}" (fail-closed).`);
    }
  }
}

function checkHandoffFiles(problems) {
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^s\d\de\d\d$/i.test(entry.name)) {
      continue;
    }
    const dir = path.join(ROOT, entry.name);
    checkSourceManifest(dir, problems);

    const handoffFiles = fs
      .readdirSync(dir)
      .filter((name) => /^handoff_.*\.json$/i.test(name))
      .map((name) => path.join(dir, name));

    for (const hf of handoffFiles) {
      const rel = path.relative(ROOT, hf).replace(/\\/g, '/');
      try {
        problems.push(...validateHandoffObject(JSON.parse(fs.readFileSync(hf, 'utf-8')), rel));
      } catch (err) {
        problems.push(`${rel}: invalid JSON (${err.message})`);
      }
    }

    if (handoffFiles.length >= 2) {
      try {
        aggregateHandoffs(handoffFiles);
      } catch (err) {
        problems.push(`${entry.name}: ${err.message}`);
      }
    }
  }
}

function checkGitIgnore(problems) {
  for (const sensitive of ['.env', '.agents/mcp_config.json', 's01e02/requests.log']) {
    if (!fs.existsSync(path.join(ROOT, sensitive))) {
      continue;
    }
    try {
      execFileSync('git', ['check-ignore', '-q', sensitive], { cwd: ROOT, stdio: 'ignore' });
    } catch {
      problems.push(`${sensitive}: file is NOT ignored by git. Add it to .gitignore immediately.`);
    }
  }
}

const VENDOR_SKILLS = new Set(['rig', 'keep', 'read', 'rook-loop']);

function checkSkills(problems) {
  const skillsRoot = path.join(ROOT, '.agents', 'skills');
  if (!fs.existsSync(skillsRoot)) {
    return;
  }
  const skills = [];
  for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || VENDOR_SKILLS.has(e.name)) {
      continue;
    }
    const sDir = path.join(skillsRoot, e.name);
    validateSkill(sDir, problems);
    const skPath = path.join(sDir, 'SKILL.md');
    if (fs.existsSync(skPath)) {
      const raw = fs.readFileSync(skPath, 'utf-8');
      const m = raw.match(/^description:\s*(.+)$/m);
      skills.push({ name: e.name, description: m ? m[1] : '' });
    }
  }
  checkSkillOverlap(skills, problems);
}

function checkKnowledgeBase(problems) {
  const kbRoot = path.join(ROOT, 'support-kb');
  if (!fs.existsSync(kbRoot)) {
    return;
  }
  const res = validateSupportKb(kbRoot);
  if (!res.ok) {
    problems.push(...res.errors);
  }
}

function runNodeTool(label, scriptArgs, cwd, problems) {
  try {
    execFileSync(process.execPath, scriptArgs, { cwd, stdio: 'pipe' });
  } catch (err) {
    const out = (err.stdout?.toString() || err.stderr?.toString() || err.message).trim();
    problems.push(`${label}:\n${out}`);
  }
}

function checkMegaExamples(problems) {
  const megaDir = path.join(ROOT, 'mega-examples');
  if (!fs.existsSync(megaDir)) {
    return;
  }

  const mexBin = path.join(megaDir, 'cli', 'bin', 'mex.js');
  if (fs.existsSync(mexBin)) {
    runNodeTool('mega-examples (mex check)', [mexBin, 'check'], megaDir, problems);
  }

  const tscBin = path.join(megaDir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (fs.existsSync(tscBin)) {
    runNodeTool(
      'mega-examples (tsc --noEmit)',
      [tscBin, '-p', path.join(megaDir, 'tsconfig.json'), '--noEmit'],
      megaDir,
      problems
    );
  } else {
    problems.push('mega-examples: missing typescript binary (node_modules/typescript/bin/tsc).');
  }

  const biomeBin = path.join(megaDir, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
  const biomeConfig = path.join(megaDir, 'biome.json');
  if (fs.existsSync(biomeBin)) {
    runNodeTool(
      'tools (biome lint --error-on-warnings)',
      [biomeBin, 'lint', '--error-on-warnings', '--config-path', biomeConfig, path.join(ROOT, 'tools')],
      ROOT,
      problems
    );
  }
}

function main() {
  const problems = [];
  checkCanonicalTools(problems);
  checkSecretsAndIsolation(problems);
  checkSourceManifest(path.join(ROOT, 's01e02'), problems);
  checkHandoffFiles(problems);
  checkGitIgnore(problems);
  checkSkills(problems);
  checkKnowledgeBase(problems);
  checkMegaExamples(problems);

  if (problems.length > 0) {
    console.error('✗ Workspace static analysis failed:\n');
    for (const p of problems) {
      console.error(`  ✗ ${p}`);
    }
    console.error(`\n${problems.length} problem(s) found.`);
    process.exit(1);
  }

  console.log(
    '✓ Workspace static analysis passed (canonical tools, secret hygiene, multi-source handoffs, gitignore, skills guard, support-kb contracts, mex check, tsc, biome).'
  );
}

main();
