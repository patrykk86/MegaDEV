// s03e02 review-gate: the OpenRouter peer-review dispatch for one change - the skill gate's
// description target moved from 300 to 512 characters so an installed course artifact keeps its own
// bytes. The reviewer gets the two files verbatim and the check results, not my argument for them.
//
// Usage: node s03e02/review-gate.mjs

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

// The reviewer tier of .agents/model-routing.json: dispatched only, medium effort.
const MODEL = 'deepseek/deepseek-v4.1-flash-20261017';
const REASONING_EFFORT = 'medium';

const gate = fs.readFileSync(path.join(ROOT, 'tools', 'check-skills.mjs'), 'utf-8');
const test = fs.readFileSync(path.join(ROOT, 'tools', 'check-skills.test.mjs'), 'utf-8');

const prompt = `You are peer-reviewing one change in the pure Node.js 25 MegaDEV repository (Node 25.4.0, ESM, zero runtime dependencies in the file under review). Nothing here is a clinical or regulated system. The repository's hard rules: no absolute filesystem paths in tracked files, no secrets in tracked files, no hardcoded keys or tickets, contract-first data shapes.

THE CHANGE
tools/check-skills.mjs is the static gate for skill manifests: it checks each skill folder's SKILL.md name, description, body, frontmatter keys and description overlap. It used to fail a description longer than 300 characters. A skill arrived from outside the repository (a course artifact, installed byte-for-byte with a sha256 the sender supplies) whose description is 411 characters, so the gate refused a file that must not be edited. The change raises the description target from a literal 300 to a named constant DESC_TARGET = 512, and the test file gained one test for the new boundary. The 1024-character hard cap is unchanged.

WHAT THE AUTHOR CLAIMS, NOT EVIDENCE: the constant is documented in place; the message now reports the constant, so a future change cannot leave a stale number in the text; the new test asserts the boundary at DESC_TARGET and at DESC_MAX, built from the constants.

THIS IS ROUND 2. Round 1 returned BLOCKED with two findings, and you are asked to confirm the fixes or raise what still blocks:
1. The test repeated 512 in its assertion, so it did not prove the message follows DESC_TARGET. Fix applied: DESC_TARGET and DESC_MAX are exported from the module and imported by the test, the description strings are built from those constants, and the message is matched against a pattern built from them.
2. The 1024 hard cap was a bare literal and the comment pointed at the wrong place. Fix applied: DESC_MAX names the portability cap, both checks and both messages use their constants, and the comment sits with the constants and says which is which.
Round 1's answer was cut off by its token budget, so findings 3 and later never arrived. Give the verdict in the first line, then at most four findings, shortest useful form.

LOCAL CHECKS THE AUTHOR RAN (Node 25.4.0, Windows): node --test tools/check-skills.test.mjs -> 4 tests, 4 pass, 0 fail. node tools/check.mjs -> no finding for any .agents/skills path and no stale codebase map. node tools/eval-agent-primitives.mjs -> 10/10. node tools/eval-agents-capabilities.mjs -> 37/37, 9 bidirectional tool-skill links across 11 schemas. node tools/eval-skill.mjs --check-skills -> 10 cases, pass@1 100%, pass^3 100%.

FILES, VERBATIM.

--- tools/check-skills.mjs ---
${gate}

--- tools/check-skills.test.mjs ---
${test}

--- END FILES ---

Judge this change against these questions and say where it is wrong, not where it is fine:
1. Does raising the target to 512 weaken the gate beyond what the stated reason needs, or break the portability contract the module docblock states?
2. Is the constant used everywhere the old literal was, including the failure message, so the two cannot disagree?
3. Does the new test actually prove the boundary (411 passes, 513 fails) with exact assertions and cleanup that survives an exception? Would it pass if the constant were reverted to 300?
4. Any path, secret, injection, ReDoS or file-handling defect introduced by the change, or any behaviour that differs on Windows versus POSIX?
5. Anything else in these two files a maintainer would block on.

Reply in this shape and nothing else:
Line 1: APPROVED or BLOCKED.
Then, if BLOCKED, a numbered list of blocking findings, each with the line or symbol it points at and the smallest fix. If APPROVED, up to three non-blocking notes.`;

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    // Budget from tools/model-limits.json for this model (maxOutputTokens 549, mean x 1.5), plus room
    // for the verdict: at 900 the answer was cut after two findings, at 1600 and 4000 the model spent
    // everything on reasoning, so 1400 carries a medium-effort chain and a short answer.
    max_tokens: 900,
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are a strict code reviewer. You answer in the exact shape the user asks for. No markdown fences, no preamble.' },
      { role: 'user', content: prompt },
    ],
  }),
});

const payload = await response.json();
const text = payload?.choices?.[0]?.message?.content ?? '';
const out = path.join(DIR, 'review-gate.json');
fs.writeFileSync(out, `${JSON.stringify({ model: MODEL, status: response.status, usage: payload.usage, error: payload.error ?? null, text }, null, 2)}\n`, 'utf-8');
console.log(
  JSON.stringify(
    { model: MODEL, status: response.status, promptChars: prompt.length, usage: payload.usage, error: payload.error ?? null, chars: text.length, out: path.basename(out) },
    null,
    2
  )
);
console.log(text);
