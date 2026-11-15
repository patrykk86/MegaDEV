// s03e05 review-friction: the OpenRouter peer-review dispatch for tools/friction-log.mjs, its schema
// and the rule it adds to AGENTS.md. The reviewer gets the module and the schema verbatim and the
// check results, not my argument for them. The test file is described by its assertions rather than
// pasted, so the payload stays inside the 5,000-token cap .clinerules section 5 sets.
//
// Usage: node s03e05/review-friction.mjs [part] [model] [maxTokens]

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

// The reviewer tier of .agents/model-routing.json: dispatched only. An override is announced in the
// reply with its reason, never switched silently (.clinerules section 3.1).
const MODEL = process.argv[3] ?? 'deepseek/deepseek-v4.1-flash-20261017';
const MAX_TOKENS = Number(process.argv[4] ?? 3500);

const moduleSource = fs.readFileSync(path.join(ROOT, 'tools', 'friction-log.mjs'), 'utf-8');
const schemaSource = fs.readFileSync(path.join(ROOT, 'tools', 'friction-log.tool.json'), 'utf-8');

// The module is reviewed in two capped halves: the record and its marking, then the sweep and the CLI.
// `fixes` reviews only the hunks round 1 changed, because .clinerules section 3.4 asks a delegated
// payload to carry target functions rather than a whole tree.
const part = process.argv[2] ?? 'all';
const sweepIndex = moduleSource.indexOf('export function sweep');
let moduleSlice =
  part === 'logic'
    ? moduleSource.slice(0, sweepIndex)
    : part === 'sweep'
      ? moduleSource.slice(sweepIndex)
      : moduleSource;
if (part === 'fixes') {
  const pick = (pattern) => (moduleSource.match(pattern) ?? ['(not found)'])[0];
  moduleSlice = [
    pick(/const CREDENTIAL_RE =[\s\S]*?\r?\n\r?\n/),
    pick(/export function canonicalRel[\s\S]*?\r?\n\}\r?\n/),
    pick(/export function isProtected[\s\S]*?\r?\n\}\r?\n/),
    pick(/function checkText[\s\S]*?\r?\n\}\r?\n/),
    pick(/function checkFiles[\s\S]*?\r?\n\}\r?\n/),
    pick(/export function fingerprintOf[\s\S]*?\r?\n\}\r?\n/),
    pick(/  const print = fingerprintOf[\s\S]*?\r?\n  \}\r?\n/),
  ].join('\n--- next hunk ---\n');
}
const schemaSlice = part === 'logic' ? '(the schema belongs to the sweep half)' : schemaSource;

const prompt = `You are peer-reviewing one half of one change in the pure Node.js 25 MegaDEV repository (Node 25.4.0, ESM, no runtime dependency in the file under review). No clinical or regulated system. Hard rules: no absolute filesystem paths in tracked files, no secrets, no hardcoded keys, contract-first data shapes.

THE CHANGE (${part} half of a ${moduleSource.split('\n').length}-line module; the other half is not shown, so judge only what is here)
tools/friction-log.mjs is a new primitive. It closes a gap the S03E05 lesson names: an agent that works around a broken tool never reports it, so the workaround silently becomes the norm. --file writes one record (what happened, what was wanted, how to reproduce, what it cost, the investigation, the files) under .runs/friction/<id>.{json,md}. --sweep marks each open record agent-ready, needs-human or blocked and writes sweep.json and sweep.md beside them. A record naming a protected path (AGENTS.md, .clinerules, .agents/rules/, .agents/model-routing.json, .agents/mcp_config.json, tools/agent-guard.mjs, tools/agent-loop.mjs, tools/journal.mjs, tools/sanitize.mjs, tools/resumable-approval.mjs) or any *.tool.json is needs-human whatever else it says. No file or no reproduce step is blocked. A record whose fingerprint already exists is refused as a duplicate. It is wired into tools/scheduler/runner.mjs as friction_sweep on the existing daily 20:00 cron, and AGENTS.md section 4 gains one line telling an agent to file a workaround.

CLAIMS, NOT EVIDENCE: the mark is deterministic and needs no model; a protected path can never be marked agent-ready; the same complaint cannot be filed twice; every path written stays inside the workspace root; nothing here calls the network.

CHECKS RUN (Node 25.4.0, Windows): node --test tools/friction-log.test.mjs -> 31 tests, 31 pass, 0 fail. They cover: a complete record validates; a missing cost, a credential, a GitHub token, an AWS key, a Basic header, a drive path, a POSIX path, a POSIX path after an equals sign and a path that climbs out are each refused; a traversal resolves to its target and is then needs-human; a fixable record is agent-ready; AGENTS.md, any *.tool.json, a case change, a traversal and a protected directory named without its slash are needs-human; a lookalike path is not; a named decision outranks a fix; no file and no reproduce step each block; the fingerprint ignores case and is the words only; the files and the decision are compared separately; the id is a slug plus 16 hex; a record and its markdown are written; a folder outside the root is refused; a sweep counts 2/2/1; the same complaint on the same file is a duplicate and on another file is not; an explicit id cannot overwrite; the sweep renders as markdown. Also: --selftest -> 20 checks ok; node --test tools/scheduler/runner.test.mjs -> 6 pass; biome lint --error-on-warnings over tools/ -> clean; node tools/check.mjs -> only the pre-existing .agents/skills/prove failure, a vendored pack installed byte for byte, not part of this change.

FILES, VERBATIM.

--- tools/friction-log.mjs (${part} half) ---
${moduleSlice}

--- tools/friction-log.tool.json ---
${schemaSlice}

--- END FILES ---

THIS IS ROUND 3, the last round the cap allows - a block here is escalated to the operator, not looped. Round 2 returned BLOCKED with four findings, all fixed:
1. isProtected missed a protected directory named without its trailing slash, so .agents/rules was agent-ready. Fix: the target is stripped of its trailing slash and matched as an exact path or a prefix followed by a slash.
2. The absolute-path check missed a POSIX path after an equals sign and roots outside a short list. Fix: ABSOLUTE_ANYWHERE_RE matches a drive path or a POSIX root after any non-alphanumeric character, over a wider root list.
3. The claim that the fingerprint covers the files was false, and the duplicate key ignored the decision. Fix: fingerprintOf is the words only, filesOf compares the files, and duplicateKeyOf joins the words, the files and the decision; the docblock now says so.
4. CREDENTIAL_RE missed AWS keys and Basic headers, and the refusal overclaimed. Fix: it now matches an access-key pair, gh*/sk-*/AKIA/xox* prefixes and a Bearer or Basic header, and the docblock says it is a shape, not a proof.

Judge this change against these questions and say where it is wrong, not where it is fine:
1. Is any claim above false as written, given the code? Quote the line.
2. Can a record that should be needs-human be marked agent-ready, or the reverse, by any input?
3. Is anything written outside the workspace root, or able to leak an absolute path or a secret into a record?
4. Is the duplicate rule right, or does it lose a genuinely different complaint?
5. Does anything fail on a fresh clone, with no .runs/ and no prior output?
Give the verdict in the first line: APPROVED, APPROVED WITH NITS, or BLOCKED. Then at most four findings, shortest useful form.`;

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    // The routed reviewer is a thinking model: the cap has to cover the chain and the answer.
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
  console.error(
    JSON.stringify({ status: response.status, error: payload?.error?.message ?? 'no message' }, null, 1),
  );
  process.exit(1);
}

const content = payload.choices?.[0]?.message?.content ?? '';
const usage = payload.usage ?? {};
fs.writeFileSync(
  path.join(DIR, `review-friction-${part}.json`),
  `${JSON.stringify({ model: MODEL, at: new Date().toISOString(), usage, content, raw: payload }, null, 2)}\n`,
  'utf-8',
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
    1,
  ),
);
