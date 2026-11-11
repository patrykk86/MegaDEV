#!/usr/bin/env node
/**
 * tools/product-view.mjs - Renders the harness as a page a person can read
 *
 * Answers "what happens when this runs, and what does it leave behind" from the source, not from
 * memory, and gives the answer a shape a human can open rather than a log they have to trust:
 * - A flow is an entry point nobody imports, the primitives it reaches through local imports, and
 *   the workspace paths their source names.
 * - Paths, schemas and tests are read off the source and its siblings, so nothing here is retyped.
 * - Skills come through check-skills' frontmatter parser, so one parser serves both tools.
 * - The page is one file: inline CSS, no script, no network, and a content fingerprint that
 *   --check compares to a fresh scan, so a stale view is a red gate instead of a wrong impression.
 * - --out writes the page anywhere, so a change can leave it under .runs/<job>/ as the artifact a
 *   person opens next to the logs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseFrontmatter } from './check-skills.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VIEW_PATH = 'memory/PRODUCT-VIEW.html';
export const FINGERPRINT_RE = /^<!-- view-fingerprint: ([0-9a-f]{64}) -->$/m;

const ABOUT_CHARS = 140;
const MAX_STEPS = 8;
const MAX_FLOWS = 24;
const WRITE_ROOTS = [
  '.runs',
  '.approvals',
  '.agents',
  'memory',
  'data',
  'KEEP.md',
  'AGENTS.md',
  '.clinerules',
];

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

// Line endings are normalized before hashing: a checkout with autocrlf would otherwise make the page
// read as stale on another machine with no change to its content.
function textHash(text) {
  return sha256(String(text).replace(/\r\n/g, '\n'));
}

function fileHash(file) {
  return textHash(fs.readFileSync(file, 'utf-8'));
}

function docLines(source) {
  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean);
}

function purposeOf(source) {
  const first = (docLines(source)[0] ?? '').replace(/^@fileoverview\s*/, '');
  const dash = first.indexOf(' - ');
  return dash === -1 ? first : first.slice(dash + 3);
}

function importsOf(source, rel) {
  const dir = path.posix.dirname(rel);
  const found = new Set();
  const patterns = [/from\s+'([^']+)'/g, /import\s+'([^']+)'/g, /import\(\s*'([^']+)'\s*\)/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (!spec.startsWith('.')) {
        continue;
      }
      found.add(path.posix.normalize(path.posix.join(dir, spec)));
    }
  }
  return [...found].sort();
}

// Paths are named, not necessarily written here: most modules assemble a path from segments at
// runtime, so this reads the segments a module names and the page says so.
function pathsOf(source) {
  const found = new Set();
  for (const match of source.matchAll(/(['"`])([^'"`\r\n]{2,160})\1/g)) {
    const literal = match[2].replace(/\\/g, '/');
    for (const root of WRITE_ROOTS) {
      if (literal === root || literal.startsWith(`${root}/`)) {
        found.add(literal);
        break;
      }
    }
  }
  return [...found].sort();
}

// Drive letters and UNC shares, then POSIX absolute paths, then anything shaped like a token: a
// docblock or a skill description is untrusted text as far as this page is concerned.
const ABSOLUTE_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`]*/g;
const POSIX_ABSOLUTE_RE = /(^|[\s(])\/[^\s"'`)]*/g;
const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|v1\.[A-Za-z0-9._-]{20,})\b/g;

// One choke point: every value that reaches the page passes through here, so a docblock or a skill
// description cannot carry an absolute path or a token into an artifact someone shares.
export function safeText(value) {
  return String(value)
    .replace(ABSOLUTE_RE, '[absolute path]')
    .replace(POSIX_ABSOLUTE_RE, (match, lead) => `${lead}[absolute path]`)
    .replace(SECRET_RE, '[redacted]');
}

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return safeText(value).replace(/[&<>"']/g, (char) => map[char]);
}


function primitiveRows(root) {
  const dir = path.join(root, 'tools');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .sort()
    .map((name) => {
      const rel = `tools/${name}`;
      const stem = name.replace(/\.mjs$/, '');
      const source = fs.readFileSync(path.join(dir, name), 'utf-8');
      return {
        rel,
        purpose: purposeOf(source) || '(no docblock)',
        imports: importsOf(source, rel),
        paths: pathsOf(source),
        schema: fs.existsSync(path.join(dir, `${stem}.tool.json`)) ? `tools/${stem}.tool.json` : null,
        test: fs.existsSync(path.join(dir, `${stem}.test.mjs`)) ? `tools/${stem}.test.mjs` : null,
        runnable: /^#!/.test(source),
      };
    });
}

// A test is a caller but not a primitive: without this, a module used only by its own test would be
// reported as an entry point nobody imports.
function testRows(root) {
  const dir = path.join(root, 'tools');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => {
      const rel = `tools/${name}`;
      return { rel, imports: importsOf(fs.readFileSync(path.join(dir, name), 'utf-8'), rel) };
    });
}

function skillRows(root) {
  const dir = path.join(root, '.agents', 'skills');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .filter((skillDir) => fs.existsSync(path.join(skillDir, 'SKILL.md')))
    .map((skillDir) => {
      let fm = {};
      try {
        fm = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).fm ?? {};
      } catch {
        fm = {};
      }
      return {
        name: fm.name ?? path.basename(skillDir),
        about: String(fm.description ?? '').slice(0, ABOUT_CHARS),
        tool: fm.metadata?.tools ?? '-',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function callersOf(primitives) {
  const index = new Map();
  for (const row of primitives) {
    for (const target of row.imports) {
      if (!index.has(target)) {
        index.set(target, []);
      }
      index.get(target).push(row.rel);
    }
  }
  return index;
}

function flowsOf(primitives, callers) {
  const byRel = new Map(primitives.map((row) => [row.rel, row]));
  const entries = primitives.filter((row) => row.runnable && !(callers.get(row.rel) ?? []).length);
  const flows = [];
  for (const entry of entries) {
    const steps = [];
    const seen = new Set([entry.rel]);
    let frontier = [entry];
    while (frontier.length > 0 && steps.length < MAX_STEPS) {
      const next = [];
      for (const node of frontier) {
        for (const target of node.imports) {
          if (steps.length >= MAX_STEPS) {
            break;
          }
          if (seen.has(target) || !byRel.has(target)) {
            continue;
          }
          seen.add(target);
          steps.push(target);
          next.push(byRel.get(target));
        }
      }
      frontier = next;
    }
    const paths = new Set(entry.paths);
    for (const rel of steps) {
      for (const target of byRel.get(rel).paths) {
        paths.add(target);
      }
    }
    flows.push({ entry: entry.rel, purpose: entry.purpose, steps, paths: [...paths].sort() });
  }
  return { flows: flows.slice(0, MAX_FLOWS), entryCount: entries.length };
}

export function fingerprintOf(model) {
  const parts = [
    `m:${model.sourceHash}`,
    `c:${model.parserHash}`,
    ...model.testEdges.map((edge) => `t:${edge}`),
    ...model.primitives.map(
      (row) =>
        `p:${row.rel}:${row.purpose}:${row.imports.join(',')}:${row.paths.join(',')}:${row.schema ?? ''}:${row.test ?? ''}:${row.entry}`
    ),
    ...model.skills.map((row) => `s:${row.name}:${row.about}:${row.tool}`),
    ...model.gates.map((row) => `g:${row.test}:${row.covers}`),
    ...model.flows.map((row) => `f:${row.entry}:${row.steps.join(',')}`),
  ];
  return sha256(parts.sort().join('\n'));
}

export function buildViewModel(root = ROOT) {
  const primitives = primitiveRows(root);
  const tests = testRows(root);
  const callers = callersOf([...primitives, ...tests]);
  const { flows, entryCount } = flowsOf(primitives, callers);
  const entryPoints = new Set(flows.map((flow) => flow.entry));
  const gates = primitives
    .filter((row) => row.test)
    .map((row) => ({ test: row.test, covers: row.rel }))
    .concat(
      primitives
        .filter((row) => /^tools\/eval-[^/]+\.mjs$/.test(row.rel))
        .map((row) => ({ test: row.rel, covers: 'the whole workspace' }))
    );
  const pathIndex = new Map();
  for (const row of primitives) {
    for (const target of row.paths) {
      if (!pathIndex.has(target)) {
        pathIndex.set(target, []);
      }
      pathIndex.get(target).push(row.rel);
    }
  }
  const model = {
    sourceHash: fileHash(fileURLToPath(import.meta.url)),
    parserHash: fileHash(path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-skills.mjs')),
    testEdges: tests.map((row) => `${row.rel}:${row.imports.join(',')}`),
    primitives: primitives.map((row) => ({
      ...row,
      entry: entryPoints.has(row.rel),
      callers: callers.get(row.rel) ?? [],
    })),
    skills: skillRows(root),
    flows,
    hiddenFlows: Math.max(0, entryCount - flows.length),
    gates,
    pathIndex: [...pathIndex.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
  model.fingerprint = fingerprintOf(model);
  return model;
}

export function readViewFingerprint(html) {
  const match = String(html).match(FINGERPRINT_RE);
  return match ? match[1] : null;
}

const STYLE = `
  :root { color-scheme: light dark; --ink:#1b1b1f; --muted:#5b5b66; --line:#d8d8e0; --chip:#eef0f6; --accent:#2f5bd7; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e9e9ef; --muted:#a0a0ad; --line:#33333d; --chip:#22222a; --accent:#8aa8ff; } }
  * { box-sizing: border-box; }
  body { margin:0 auto; max-width:62rem; padding:2rem 1.25rem 4rem; font:16px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color:var(--ink); }
  h1 { font-size:1.6rem; margin:0 0 .25rem; }
  h2 { font-size:1.1rem; margin:2.5rem 0 .75rem; padding-bottom:.35rem; border-bottom:1px solid var(--line); }
  h3 { font-size:.95rem; margin:1.2rem 0 .25rem; }
  p { margin:.35rem 0; }
  .lede, .muted { color:var(--muted); }
  code { font:13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; background:var(--chip); padding:.1rem .3rem; border-radius:.25rem; }
  .ref { font:13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
  .flow { border:1px solid var(--line); border-radius:.5rem; padding:.75rem .9rem; margin:.75rem 0; }
  .steps .ref { color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:.4rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  footer { margin-top:3rem; border-top:1px solid var(--line); padding-top:1rem; font-size:13px; color:var(--muted); }
`;

function rowsHtml(model) {
  const flows = model.flows.length
    ? model.flows
        .map(
          (flow) => `      <article class="flow">
        <h3><code>node ${escapeHtml(flow.entry)}</code></h3>
        <p>${escapeHtml(flow.purpose)}</p>
        <p class="steps">${
          flow.steps.length
            ? flow.steps.map((step) => `<span class="ref">${escapeHtml(step)}</span>`).join(' &rarr; ')
            : '<em>reaches no local module</em>'
        }</p>${
          flow.paths.length
            ? `
        <p class="writes">names <code>${flow.paths.slice(0, 6).map(escapeHtml).join('</code>, <code>')}</code></p>`
            : ''
        }
      </article>`
        )
        .join('\n')
    : '      <p class="muted">No runnable entry point was found in tools/.</p>';

  const artifacts = model.pathIndex
    .map(
      ([target, writers]) =>
        `        <tr><td><code>${escapeHtml(target)}</code></td><td>${writers
          .map((writer) => `<span class="ref">${escapeHtml(writer)}</span>`)
          .join('<br>')}</td></tr>`
    )
    .join('\n');

  const gates = model.gates
    .map(
      (gate) =>
        `        <tr><td><code>${escapeHtml(gate.test)}</code></td><td><code>${escapeHtml(gate.covers)}</code></td></tr>`
    )
    .join('\n');

  const primitives = model.primitives
    .map(
      (row) =>
        `        <tr><td><code>${escapeHtml(row.rel)}</code>${
          row.entry ? ' <span class="muted">entry</span>' : ''
        }</td><td>${escapeHtml(row.purpose)}</td><td>${
          row.callers.length
            ? row.callers.map((caller) => `<span class="ref">${escapeHtml(caller)}</span>`).join('<br>')
            : '<span class="muted">&ndash;</span>'
        }</td><td><code>${escapeHtml(row.test ?? 'no test')}</code></td></tr>`
    )
    .join('\n');

  const skills = model.skills
    .map(
      (skill) =>
        `        <tr><td><code>${escapeHtml(skill.name)}</code></td><td>${escapeHtml(
          skill.about
        )}</td><td><code>${escapeHtml(skill.tool)}</code></td></tr>`
    )
    .join('\n');

  return { flows, artifacts, gates, primitives, skills };
}

export function renderView(model) {
  const body = rowsHtml(model);
  return `<!doctype html>
<!-- view-fingerprint: ${model.fingerprint} -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MegaDEV product view</title>
<style>${STYLE}</style>
</head>
<body>
<h1>MegaDEV product view</h1>
<p class="lede">Every flow below is read from the source: an entry point nothing imports, the modules it reaches through local imports, and the paths its source names. Generated by <code>node tools/product-view.mjs</code>; <code>--check</code> fails when this page no longer matches the code, renderer included.</p>

<h2>Flows</h2>
<p class="muted">Static reachability inside <code>tools/</code>: an entry point is a runnable module that no other module, test included, imports, and a flow is what that entry reaches through named imports and dynamic <code>import()</code>. A module reached only through <code>child_process</code> is invisible here, and neither are <code>package.json</code> scripts, workflows or agent-driven invocations, so this is a reading of the repository, not a call graph of a running system.</p>
${body.flows}${
    model.hiddenFlows > 0
      ? `
<p class="muted">${model.hiddenFlows} further entry point(s) not shown.</p>`
      : ''
  }

<h2>Paths named in the source</h2>
<p class="muted">These are the path segments a module names. Most modules assemble a real path from them at runtime, so a row here means "this module names this place", not "this module writes that file".</p>
<table>
        <tr><th>Path</th><th>Named by</th></tr>
${body.artifacts}
</table>

<h2>What proves it</h2>
<table>
        <tr><th>Gate</th><th>Proves</th></tr>
${body.gates}
</table>

<h2>Primitives and who calls them</h2>
<table>
        <tr><th>Primitive</th><th>Purpose</th><th>Called by</th><th>Test</th></tr>
${body.primitives}
</table>

<h2>Skills and the tool they drive</h2>
<table>
        <tr><th>Skill</th><th>What it is for</th><th>Tool</th></tr>
${body.skills}
</table>

<footer>
<p>${model.primitives.length} primitives, ${model.flows.length} flows, ${model.pathIndex.length} paths, ${model.gates.length} gates, ${model.skills.length} skills. Fingerprint <code>${model.fingerprint.slice(0, 12)}</code>.</p>
<p>This page holds no secret, no absolute path and no remote asset. Copy it under <code>.runs/</code> with <code>--out</code> when a change needs an artifact a person can open.</p>
</footer>
</body>
</html>
`;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        check: { type: 'boolean', default: false },
        stdout: { type: 'boolean', default: false },
        out: { type: 'string' },
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, problems: [error.message] }, null, 1));
    process.exitCode = 2;
    return;
  }

  const { values } = parsed;
  const model = buildViewModel(ROOT);
  const html = renderView(model);

  if (values.stdout) {
    process.stdout.write(html);
    return;
  }

  const target = values.out ? path.resolve(ROOT, values.out) : path.join(ROOT, VIEW_PATH);
  const shown = path.relative(ROOT, target).split(path.sep).join('/') || target;

  if (values.check) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
    const ok = existing !== null && readViewFingerprint(existing) === model.fingerprint;
    const problems = ok ? [] : [existing === null ? `${shown} is missing` : `${shown} is stale`];
    console.log(
      JSON.stringify(
        {
          ok,
          target: shown,
          primitives: model.primitives.length,
          flows: model.flows.length,
          fingerprint: model.fingerprint,
          problems,
        },
        null,
        1
      )
    );
    if (!ok) {
      process.exitCode = 1;
    }
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html, 'utf-8');
  console.log(
    JSON.stringify(
      {
        written: shown,
        primitives: model.primitives.length,
        flows: model.flows.length,
        paths: model.pathIndex.length,
        fingerprint: model.fingerprint,
      },
      null,
      1
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
