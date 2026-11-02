#!/usr/bin/env node
/**
 * tools/agent-guard.mjs - Non-negotiable agent rules as code (AGENTS.md section 7).
 *
 * Rules for every source file that calls a model API (outside tests and the canonical modules):
 *   AG1 unbounded-loop   no while(true) / for(;;) / while True: next to a model call -> use runAgent()
 *   AG2 no-output-cap    the call must set max_tokens / max_output_tokens / maxOutputTokens
 *   AG3 no-timeout       the call must set a timeout (timeout / AbortSignal / signal)
 *   AG4 no-limits-source limits must come from model-limits(.json) or the canonical agent loop
 *
 * Entry points:
 *   node tools/agent-guard.mjs [files...]          scan (default: whole workspace), exit 1 on violations
 *   node tools/agent-guard.mjs --hook session-start  Antigravity SessionStart: inject the rules + limits
 *   node tools/agent-guard.mjs --hook stop           Antigravity Stop: block finishing while violations exist
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(THIS_DIR, '..');
export const STOP_RETRY_CAP = 2;

const CODE_FILE = /\.(mjs|cjs|js|ts|mts|py)$/i;
const TEST_FILE = /(\.test\.|\.spec\.|(^|[\\/])test_[^\\/]*\.py$|[\\/]tests?[\\/])/i;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'mega-examples', '.venv', 'venv', 'dist', 'build']);
export const CANONICAL = new Set(['tools/agent-loop.mjs', 'tools/model-limits.mjs', 'tools/agent-guard.mjs']);

const MODEL_CALL =
  /chat\/completions|\/v1\/responses|openrouter\.ai\/api|generate_content\s*\(|generateContent\s*\(|responses\.create\s*\(|completions\.create\s*\(|llm\.generate\s*\(/;
const UNBOUNDED = /while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)|while\s+(True|1)\s*:/;
const OUTPUT_CAP = /max_tokens|max_output_tokens|maxOutputTokens|max_completion_tokens/;
const TIMEOUT = /timeout|AbortSignal|signal\s*:/i;
const LIMITS_SOURCE = /model[-_]limits|agent[-_]loop|runAgent|run_agent|resolve_model_limits|resolveLimits/;

export const RULES = {
  AG1: 'unbounded agent loop next to a model call; use runAgent() from tools/agent-loop.mjs',
  AG2: 'model call without an output cap (max_tokens / max_output_tokens from model limits)',
  AG3: 'model call without a timeout (timeoutMs from model limits / AbortSignal)',
  AG4: 'model call does not read limits from tools/model-limits.json or the canonical agent loop',
};

/** Returns rule ids violated by one file's content. Pure; exported for tests. */
export function checkSource(content) {
  if (!MODEL_CALL.test(content)) {
    return [];
  }
  const out = [];
  if (UNBOUNDED.test(content)) {
    out.push('AG1');
  }
  if (!OUTPUT_CAP.test(content)) {
    out.push('AG2');
  }
  if (!TIMEOUT.test(content)) {
    out.push('AG3');
  }
  if (!LIMITS_SOURCE.test(content)) {
    out.push('AG4');
  }
  return out;
}

function rel(file, root) {
  return path.relative(root, file).replace(/\\/g, '/');
}

export function isScannable(relPath) {
  return CODE_FILE.test(relPath) && !TEST_FILE.test(relPath) && !CANONICAL.has(relPath);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Scans files (default: whole workspace) and returns [{ file, rule, message }]. */
export function scan(files = null, root = ROOT) {
  const list = files ?? walk(root);
  const problems = [];
  for (const file of list) {
    const r = rel(path.resolve(root, file), root);
    if (!isScannable(r) || !fs.existsSync(path.resolve(root, file))) {
      continue;
    }
    for (const rule of checkSource(fs.readFileSync(path.resolve(root, file), 'utf-8'))) {
      problems.push({ file: r, rule, message: RULES[rule] });
    }
  }
  return problems;
}

export function formatProblems(problems) {
  return problems.map((p) => `${p.file}: ${p.rule} ${p.message}`).join('\n');
}

function limitsTable(root) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'model-limits.json'), 'utf-8'));
    const rows = Object.entries(doc.models)
      .filter(([, l]) => l.samples >= 20)
      .map(([m, l]) => `- ${m}: maxSteps=${l.maxSteps}, maxOutputTokens=${l.maxOutputTokens}, timeoutMs=${l.timeoutMs}`);
    return `${rows.join('\n')}\n- unknown models: ${JSON.stringify(doc.default.maxSteps)} steps / ${doc.default.maxOutputTokens} tokens / ${doc.default.timeoutMs}ms`;
  } catch {
    return '- tools/model-limits.json missing: regenerate with node tools/model-limits.mjs --from-csv <export> --out tools/model-limits.json';
  }
}

export function sessionStartPayload(root = ROOT) {
  const text = [
    'NON-NEGOTIABLE AGENT RULES (MegaDEV AGENTS.md section 7, enforced by tools/agent-guard.mjs in npm test and the Stop hook):',
    '1. Every agent loop runs through runAgent() in tools/agent-loop.mjs. No hand-written while(true) loops around model calls.',
    '2. Every model call sets max_tokens, a timeout and a step limit read from tools/model-limits.json (mean * 1.5 of real usage). Never hardcode them.',
    '3. Tools: unknown tools and tool errors return as tool results; paths stay in the workspace; .env and key files are never read or printed; shell commands use an allowlist without chaining.',
    '4. A cut answer (finish_reason length) is reported as cut, never as complete.',
    'Current limits (models with >=20 logged calls):',
    limitsTable(root),
  ].join('\n');
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
}

function retryFile(conversationId) {
  const safe = String(conversationId || 'unknown').replace(/[^\w-]/g, '_');
  return path.join(os.tmpdir(), `megadev-agent-guard-${safe}.json`);
}

/** Stop hook decision. Blocks finishing (max STOP_RETRY_CAP times per conversation) while violations exist. */
export function stopDecision(input, problems) {
  if (input?.terminationReason && input.terminationReason !== 'NO_TOOL_CALL') {
    return { decision: 'allow' };
  }
  const file = retryFile(input?.conversationId);
  if (problems.length === 0) {
    fs.rmSync(file, { force: true });
    return { decision: 'allow' };
  }
  let count = 0;
  try {
    count = JSON.parse(fs.readFileSync(file, 'utf-8')).count ?? 0;
  } catch {
    count = 0;
  }
  if (count >= STOP_RETRY_CAP) {
    return { decision: 'allow' };
  }
  fs.writeFileSync(file, JSON.stringify({ count: count + 1 }));
  return {
    decision: 'continue',
    reason: `agent-guard: non-negotiable agent rules violated (AGENTS.md section 7). Fix before finishing:\n${formatProblems(problems)}`,
  };
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main(argv) {
  const hookIdx = argv.indexOf('--hook');
  if (hookIdx !== -1) {
    const hook = argv[hookIdx + 1];
    const input = readStdin();
    const payload = hook === 'session-start' ? sessionStartPayload() : stopDecision(input, scan());
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const files = argv.filter((a) => !a.startsWith('--'));
  const problems = scan(files.length ? files : null);
  if (problems.length) {
    console.error(formatProblems(problems));
    process.exit(1);
  }
  console.log('agent-guard: no violations');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

