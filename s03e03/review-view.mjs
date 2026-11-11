// s03e03 review-view: the OpenRouter peer-review dispatch for tools/product-view.mjs - the product
// view plus the per-change artifact. The reviewer gets the module and its schema verbatim and the
// check results, not my argument for them. The test file is described by its assertions rather than
// pasted, so the payload stays inside the 5,000-token cap .clinerules §5 sets.
//
// Usage: node s03e03/review-view.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) {
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

loadEnv();

// The reviewer tier of .agents/model-routing.json: dispatched only. argv[3] overrides it, and an
// override is announced in the reply with its reason, never switched silently (.clinerules §3.1).
const MODEL = process.argv[3] ?? 'deepseek/deepseek-v4.1-flash-20261017';
// argv[4] sets the completion cap: the routed reviewer is a thinking model, and at 900 every token went
// to reasoning (reasoning_tokens 900, content empty, finish_reason length), so the cap must cover the
// chain *and* the answer.
const MAX_TOKENS = Number(process.argv[4] ?? 3500);

const moduleSource = fs.readFileSync(path.join(ROOT, 'tools', 'product-view.mjs'), 'utf-8');
const schemaSource = fs.readFileSync(path.join(ROOT, 'tools', 'product-view.tool.json'), 'utf-8');

// The module is reviewed in two capped halves: the derivation, then the render and the CLI. A single
// dispatch carrying both ran to 6,511 prompt tokens, over the 5,000 cap, and returned empty content.
const part = process.argv[2] ?? 'all';
const styleIndex = moduleSource.indexOf('const STYLE =');
let moduleSlice =
  part === 'logic'
    ? moduleSource.slice(0, styleIndex)
    : part === 'render'
      ? moduleSource.slice(styleIndex)
      : moduleSource;
if (part === 'fixes') {
  // Round 3 reviews the hunks it changed, not the whole module: .clinerules §3.4 asks a delegated
  // payload to carry target functions or diff hunks rather than a whole tree.
  const pick = (pattern) => (moduleSource.match(pattern) ?? ['(not found)'])[0];
  moduleSlice = [
    pick(/^#![\s\S]*?\*\//),
    pick(/function textHash[\s\S]*?\n}\n/),
    pick(/export function fingerprintOf[\s\S]*?\n}\n/),
    pick(/  const model = \{[\s\S]*?\n  \};\n/),
  ].join('\n--- next hunk ---\n');
}
const schemaSlice = part === 'logic' ? '(the schema belongs to the render half)' : schemaSource;

const prompt = `You are peer-reviewing one half of one change in the pure Node.js 25 MegaDEV repository (Node 25.4.0, ESM, no runtime dependency in the file under review). No clinical or regulated system. Hard rules: no absolute filesystem paths in tracked files, no secrets, no hardcoded keys, contract-first data shapes.

THE CHANGE (${part} half of a ${moduleSource.split('\n').length}-line module; the other half is not shown, so judge only what is here)
tools/product-view.mjs is a new generator. It reads every tools/*.mjs docblock, its local imports and the workspace paths its string literals name. A "flow" is an entry point nothing else in tools/ imports, the primitives it reaches through those imports, and the paths that chain writes. Skills are read through the existing tools/check-skills.mjs parser. Output is ONE self-contained HTML page: inline CSS, no script tag, no remote asset, no absolute path, plus a sha256 fingerprint. --check exits 1 when the page is missing or stale. --out writes the page anywhere, so a job can leave it under .runs/<job>/ as the artifact a person opens beside the logs. It closes a lesson gap: the repository could say which primitive calls which, but had no view a person opens, and every proof of a change was a log.

CLAIMS, NOT EVIDENCE: the flow is derived rather than hand-written; the fingerprint makes a stale view a red gate; the page is offline-safe; every path in it is workspace-relative.

CHECKS RUN (Node 25.4.0, Windows): node --test tools/product-view.test.mjs -> 7 tests, 7 pass, 0 fail. Assertions: every primitive read from source, rels unique; a real caller edge, tools/journal.mjs called by tools/agent-loop.mjs; every flow entry has zero callers and tools/eval-agent-primitives.mjs reaches tools/agent-loop.mjs with every step a known primitive and never the entry; a known module credited with a path and no path absolute; the page has no <script, no src=, no href="http, no drive-letter path, no file:///; the embedded fingerprint equals the computed one and a page with that line removed yields null; --out writes, --check is green on the fresh file, and --check exits 1 when the embedded fingerprint no longer matches the source. Also: node tools/product-view.mjs -> 22 primitives, 11 flows, 12 paths; node tools/product-view.mjs --check -> ok true.

FILES, VERBATIM.

THIS IS ROUND 3, the last round the cap allows - a block here is escalated to the operator, not looped. Round 2 returned BLOCKED with three findings, all fixed:
1. The docblock still said "the workspace paths that chain writes" after the page had been relabelled. Fix: it now reads "the workspace paths their source names", and a flow's paths are the union of the named paths its entry and steps carry.
2. The fingerprint was incomplete: skill rows come from parseFrontmatter in check-skills.mjs, and test imports decide entry status, and neither was hashed. Fix: fingerprintOf now hashes the module source, a normalized hash of check-skills.mjs, and every test import edge.
3. Hashing raw bytes made line endings a staleness signal. Fix: textHash() normalizes CRLF to LF before hashing, for the module and for the parser.
Round 1's four fixes hold; see the previous paragraph: paths are labelled as named, imports cover from/bare/dynamic, tests count as callers, the step cap is checked inside the inner loop, hidden entries are reported, escapeHtml routes every value through safeText, and the page states that the flow is static reachability.
Local checks now: 9 tests, 9 pass, 0 fail, including that the fingerprint changes when the module hash, the parser hash or the test edges change, and that safeText masks a Windows path and a token. node tools/product-view.mjs -> 22 primitives, 4 flows, 12 paths; node tools/product-view.mjs --check -> ok true.

--- tools/product-view.mjs (${part} half) ---
${moduleSlice}

--- tools/product-view.tool.json ---
${schemaSlice}

--- END FILES ---

Judge this change against these questions and say where it is wrong, not where it is fine:
1. Is any claim above false as written, given the code? Quote the line.
2. Does the flow heuristic (runnable plus zero callers inside tools/) mislead a reader about the product, and how should the page say so?
3. Is anything in the emitted page unsafe, non-deterministic, or able to leak an absolute path or a secret?
4. Is the fingerprint the right staleness signal, or can the page go stale while --check stays green?
5. Does anything fail on a fresh clone, with no .agents/, no memory/ and no prior output?
Give the verdict in the first line: APPROVED, APPROVED WITH NITS, or BLOCKED. Then at most four findings, shortest useful form.`;

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    // The routed reviewer is a thinking model: at 900 the whole cap went to reasoning
    // (completion_tokens 900, reasoning_tokens 900, content empty, finish_reason length), so the cap
    // has to cover the chain and the answer.
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You are a strict code reviewer. You answer in the exact shape the user asks for. No markdown fences, no preamble.',
      },
      { role: 'user', content: prompt },
    ],
  }),
});

const payload = await response.json();
if (!response.ok) {
  console.error(JSON.stringify({ status: response.status, error: payload?.error?.message ?? 'no message' }, null, 1));
  process.exit(1);
}

const content = payload.choices?.[0]?.message?.content ?? '';
const usage = payload.usage ?? {};
fs.writeFileSync(
  path.join(DIR, `review-view-${part}.json`),
  `${JSON.stringify({ model: MODEL, at: new Date().toISOString(), usage, content, raw: payload }, null, 2)}\n`,
  'utf-8'
);

console.log(content || '(empty content - the reviewer spent the whole budget on reasoning)');
console.log(
  JSON.stringify(
    {
      prompt_chars: prompt.length,
      approx_prompt_tokens: Math.ceil(prompt.length / 4),
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cost_usd: usage.cost ?? null,
      empty: content.length === 0,
    },
    null,
    1
  )
);
