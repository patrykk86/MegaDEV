#!/usr/bin/env node
/**
 * tools/domain-agents.mjs - Domain Agents registry, path-router hook, parallel consultation,
 * and scenario check runner (S04E03).
 *
 * Reads `agents/<name>/agent.md`, `memories.md`, `glossary.md`, and `scenarios.md` dynamically
 * so adding a new domain folder under `agents/` works without editing hook or router code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROUTER_CONFIG } from './agent-loop.mjs';
import { resolveLimits } from './model-limits.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(THIS_DIR, '..');
export const DEFAULT_AGENTS_DIR = path.join(ROOT, 'agents');

const RECEIPT_RE =
  /\[(commit\s+[0-9a-f]{7,40}|issue\s+#?\d+|pr\s+#?\d+|from a conversation[^[\]]*|decided in conversation[^[\]]*)\]/i;
const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'file_path', 'target', 'dir', 'directory', 'folder'];
const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'does', 'not', 'touch', 'into', 'want', 'local', 'file', 'files',
  'name', 'helper', 'unrelated', 'change', 'changes', 'fixing', 'typo', 'rename', 'variable',
  'comment', 'formatting', 'what', 'happens', 'instead', 'directly', 'using', 'allows', 'without',
]);

function applyFrontmatterLine(line, frontmatter, activeArrayKey) {
  const itemMatch = line.match(/^\s*-\s+(.+)$/);
  if (itemMatch && activeArrayKey) {
    const val = itemMatch[1].trim().replace(/^["']|["']$/g, '');
    if (val) {
      frontmatter[activeArrayKey].push(val);
    }
    return activeArrayKey;
  }

  const kvMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!kvMatch) {
    return null;
  }
  const key = kvMatch[1].trim();
  const rest = kvMatch[2].trim();
  if (!rest) {
    frontmatter[key] = [];
    return key;
  }
  if (rest.startsWith('[') && rest.endsWith(']')) {
    frontmatter[key] = rest
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    return null;
  }
  frontmatter[key] = rest.replace(/^["']|["']$/g, '');
  return null;
}

/**
 * Parses YAML-like frontmatter (`owns:`, `model:`, `access:`) and markdown body.
 */
export function parseAgentMarkdown(raw) {
  const text = String(raw ?? '');
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: text.trim() };
  }
  const frontmatter = {};
  let activeArrayKey = null;
  for (const line of fmMatch[1].split(/\r?\n/)) {
    activeArrayKey = applyFrontmatterLine(line, frontmatter, activeArrayKey);
  }
  return { frontmatter, body: fmMatch[2].trim() };
}

function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'm');
  const m = String(markdown ?? '').match(re);
  return m ? m[1].trim() : '';
}

function parseMemoryEntries(markdown) {
  const parseList = (block) =>
    block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  const text = String(markdown ?? '');
  return {
    internal: parseList(extractSection(text, 'Internal engineering')),
    customerFacing: parseList(extractSection(text, 'Customer facing')),
    hasInternalSection: /^##\s+Internal engineering\b/m.test(text),
    hasCustomerSection: /^##\s+Customer facing\b/m.test(text),
  };
}

function parseScenarioSection(section) {
  const lines = section.split(/\r?\n/);
  const title = lines[0]?.trim() || 'Untitled scenario';
  const fields = { ask: '', expect: '', never: '' };
  for (const rawLine of lines.slice(1)) {
    const trimmed = rawLine.trim();
    const match = trimmed.match(/^(Ask|Expect|Never):\s*(.+)$/i);
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim();
    }
  }
  return fields.ask || fields.expect || fields.never ? { title, ...fields } : null;
}

/**
 * Parses `Ask:` / `Expect:` / `Never:` scenario blocks from `scenarios.md`.
 */
export function parseScenarios(markdown) {
  const sections = String(markdown ?? '').split(/^##\s+/m).slice(1);
  return sections.map(parseScenarioSection).filter(Boolean);
}

/**
 * Converts a glob pattern (`**`, `*`, `?`) into a RegExp for POSIX relative paths.
 */
export function globToRegExp(glob) {
  const norm = String(glob ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  const escaped = norm.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${pattern}$`);
}

/**
 * Normalizes a file path relative to `workspaceRoot` using POSIX separators.
 */
export function normalizeRelativePath(filePath, workspaceRoot = ROOT) {
  const raw = String(filePath ?? '').trim();
  if (!raw) {
    return '';
  }
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workspaceRoot, raw);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return raw.replace(/\\/g, '/').replace(/^\.\//, '');
  }
  return rel;
}

function readOptionalUtf8(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function loadSingleDomainAgent(dir, name) {
  const agentPath = path.join(dir, 'agent.md');
  if (!fs.existsSync(agentPath)) {
    return null;
  }
  const { frontmatter, body } = parseAgentMarkdown(fs.readFileSync(agentPath, 'utf8'));
  const owns = Array.isArray(frontmatter.owns) ? frontmatter.owns : [];
  const memoriesRaw = readOptionalUtf8(path.join(dir, 'memories.md'));
  const glossaryRaw = readOptionalUtf8(path.join(dir, 'glossary.md'));
  const scenariosRaw = readOptionalUtf8(path.join(dir, 'scenarios.md'));

  return {
    name,
    dir,
    owns,
    matchers: owns.map((g) => globToRegExp(g)),
    model: String(frontmatter.model || DEFAULT_ROUTER_CONFIG.lightweightModel),
    access: String(frontmatter.access || 'read-only'),
    job: extractSection(body, 'Job') || body,
    memoriesRaw,
    memories: parseMemoryEntries(memoriesRaw),
    glossaryRaw,
    scenariosRaw,
    scenarios: parseScenarios(scenariosRaw),
  };
}

/**
 * Loads all Domain Agents from `agents/<name>/`.
 */
export function loadDomainAgents(agentsDir = DEFAULT_AGENTS_DIR) {
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => loadSingleDomainAgent(path.join(agentsDir, entry.name), entry.name))
    .filter(Boolean);
}

/**
 * Returns Domain Agents whose `owns:` globs match the given file path.
 */
export function matchPathToDomains(filePath, agents, workspaceRoot = ROOT) {
  const rel = normalizeRelativePath(filePath, workspaceRoot);
  if (!rel) {
    return [];
  }
  return agents.filter((agent) => agent.matchers.some((re) => re.test(rel)));
}

/**
 * Extracts candidate file paths from a tool call's arguments (including shell commands).
 */
export function extractPathsFromToolCall(call, workspaceRoot = ROOT) {
  const args = call?.arguments ?? {};
  const found = new Set();

  for (const key of PATH_ARG_KEYS) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      found.add(normalizeRelativePath(val, workspaceRoot));
    }
  }

  if (typeof args.command === 'string' && args.command.trim()) {
    const tokens = args.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const rawTok of tokens) {
      const tok = rawTok.replace(/^["']|["']$/g, '');
      if (/[\\/]|\.(?:mjs|js|ts|md|json|yaml|yml)$/i.test(tok) && !tok.startsWith('-')) {
        found.add(normalizeRelativePath(tok, workspaceRoot));
      }
    }
  }

  return [...found].filter(Boolean);
}

function tokenizeQuery(text) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/\b(?:does not|doesn't|do not|don't|never|without)\s+(?:touch|use|involve|affect)\b[^.;]*/g, ' ');
  return cleaned
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
}

function scoreCandidateLines(lines, terms) {
  return lines.map((line) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (lower.includes(t)) {
        score += 1;
      }
    }
    return { line, score };
  });
}

/**
 * Deterministic read-only brief builder from a Domain Agent's `memories.md` and `glossary.md`.
 * Returns at most 5 lines with references, or "nothing relevant".
 */
export function buildDeterministicBrief(agent, { filePath = '', query = '' } = {}) {
  const terms = new Set([...tokenizeQuery(query), ...tokenizeQuery(filePath)]);
  const minScore = filePath ? 1 : 2;
  const memoryLines = [...agent.memories.internal, ...agent.memories.customerFacing];
  const glossaryLines = agent.glossaryRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('**'))
    .map((l) => l.replace(/^-\s+/, ''));

  const candidates = [
    ...scoreCandidateLines(memoryLines, terms),
    ...scoreCandidateLines(glossaryLines, terms).filter((c) => c.score > 0),
  ].sort((a, b) => b.score - a.score);

  const relevant = candidates.filter((c) => c.score >= minScore).slice(0, 5);
  let selected = relevant;
  if (selected.length === 0 && filePath) {
    selected = candidates.slice(0, Math.min(2, candidates.length));
  }

  if (selected.length === 0) {
    return {
      domain: agent.name,
      model: agent.model,
      access: agent.access,
      relevant: false,
      brief: 'nothing relevant',
      lines: [],
    };
  }

  const lines = selected.map((c) => `- ${c.line}`);
  return {
    domain: agent.name,
    model: agent.model,
    access: agent.access,
    relevant: true,
    brief: lines.join('\n'),
    lines,
  };
}

/**
 * Calls OpenRouter headless on the Domain Agent's small, fast model with limits from
 * `tools/model-limits.json` (respecting tools/agent-guard.mjs).
 */
async function callDomainModelLive(agent, promptText) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is required for live Domain Agent calls.');
  }
  const limits = resolveLimits(agent.model);
  const systemPrompt = [
    agent.job,
    '',
    '## Glossary',
    agent.glossaryRaw || '(none)',
    '',
    '## Memories',
    agent.memoriesRaw || '(none)',
  ].join('\n');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: Math.min(limits.maxOutputTokens, 600),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText },
      ],
    }),
    signal: AbortSignal.timeout(limits.timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}`);
  }
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * Consults all matching Domain Agents in parallel and read-only.
 */
export async function consultDomainAgents({
  paths = [],
  query = '',
  agentsDir = DEFAULT_AGENTS_DIR,
  workspaceRoot = ROOT,
  consultFn = null,
  live = false,
} = {}) {
  const agents = loadDomainAgents(agentsDir);
  const matchedMap = new Map();

  for (const p of paths) {
    for (const agent of matchPathToDomains(p, agents, workspaceRoot)) {
      if (!matchedMap.has(agent.name)) {
        matchedMap.set(agent.name, { agent, matchedPaths: [] });
      }
      matchedMap.get(agent.name).matchedPaths.push(normalizeRelativePath(p, workspaceRoot));
    }
  }

  return Promise.all(
    [...matchedMap.values()].map(async ({ agent, matchedPaths }) => {
      if (agent.access !== 'read-only') {
        throw new Error(`Domain Agent "${agent.name}" must be read-only (found "${agent.access}").`);
      }
      if (typeof consultFn === 'function') {
        const out = await consultFn(agent, { matchedPaths, query });
        const brief = typeof out === 'string' ? out : String(out?.brief ?? 'nothing relevant');
        return {
          domain: agent.name,
          model: agent.model,
          access: 'read-only',
          matchedPaths,
          relevant: !/^nothing relevant$/i.test(brief.trim()),
          brief,
        };
      }
      if (live) {
        const promptText = [
          `Files touched: ${matchedPaths.join(', ')}`,
          query ? `Task context: ${query}` : '',
          'Give a brief of at most 5 lines: the traps in play and their references, or "nothing relevant".',
        ]
          .filter(Boolean)
          .join('\n');
        const brief = await callDomainModelLive(agent, promptText);
        return {
          domain: agent.name,
          model: agent.model,
          access: 'read-only',
          matchedPaths,
          relevant: !/^nothing relevant$/i.test(brief.trim()),
          brief,
        };
      }
      const det = buildDeterministicBrief(agent, { filePath: matchedPaths[0] ?? '', query });
      return { ...det, matchedPaths };
    }),
  );
}

function collectUnseenPaths(paths, agents, seen, workspaceRoot) {
  return paths.filter((p) =>
    matchPathToDomains(p, agents, workspaceRoot).some((a) => !seen.has(a.name)),
  );
}

function injectDomainBriefs(state, call, consults, seen) {
  if (!Array.isArray(state.domainBriefs)) {
    state.domainBriefs = [];
  }
  const injectedBlocks = [];
  for (const c of consults) {
    seen.add(c.domain);
    state.domainBriefs.push(c);
    if (c.relevant) {
      injectedBlocks.push(`[Domain Agent: ${c.domain} (${c.model}, ${c.access})]\n${c.brief}`);
    }
  }
  if (injectedBlocks.length > 0 && Array.isArray(state?.messages)) {
    state.messages.push({
      role: 'system',
      content: `Domain Agent brief before ${call?.name ?? 'tool'}:\n${injectedBlocks.join('\n\n')}`,
    });
  }
}

/**
 * Creates a `beforeTool` hook for `tools/agent-loop.mjs` (`runAgent`) that:
 * - watches tool file paths (and shell command paths) against `agents/<name>/agent.md` `owns:` globs
 * - consults matching Domain Agents in parallel, read-only, on their small fast model
 * - briefs Main once per Domain Agent per task/conversation (and again if task changes or forced)
 * - never blocks the read/edit and never lets a Domain Agent edit files.
 */
export function createDomainAgentHook({
  agentsDir = DEFAULT_AGENTS_DIR,
  workspaceRoot = ROOT,
  consultFn = null,
  live = false,
  taskKey = '',
} = {}) {
  const briefedByTask = new Map();

  return async function domainAgentBeforeTool(state, call) {
    const activeTask = String(state?.domainTaskKey ?? taskKey ?? '');
    if (!briefedByTask.has(activeTask)) {
      briefedByTask.set(activeTask, new Set());
    }
    const seen = briefedByTask.get(activeTask);
    const paths = extractPathsFromToolCall(call, workspaceRoot);
    const agents = paths.length > 0 ? loadDomainAgents(agentsDir) : [];
    const neededPaths = collectUnseenPaths(paths, agents, seen, workspaceRoot);
    if (neededPaths.length === 0) {
      return {};
    }

    const latestUserMsg = [...(state?.messages ?? [])].reverse().find((m) => m?.role === 'user')?.content ?? '';
    const consults = await consultDomainAgents({
      paths: neededPaths,
      query: latestUserMsg,
      agentsDir,
      workspaceRoot,
      consultFn,
      live,
    });

    injectDomainBriefs(state, call, consults, seen);
    return {};
  };
}

/**
 * Evaluates a Domain Agent answer against `Expect:` and `Never:` clauses.
 */
export function evaluateScenarioAnswer(scenario, answer) {
  const text = String(answer ?? '').toLowerCase();
  const extractKeywords = (phrase) =>
    String(phrase ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((w) => w.length >= 4 && !['that', 'with', 'from', 'this', 'into', 'without', 'says'].includes(w));

  const expectWords = extractKeywords(scenario.expect);
  const matchedExpect = expectWords.length === 0 || expectWords.some((w) => text.includes(w));

  const neverPhrases = String(scenario.never ?? '')
    .toLowerCase()
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
  const hitNever = neverPhrases.some((p) => text.includes(p));

  if (matchedExpect && !hitNever) {
    return { pass: true, reason: 'Matched Expect criteria without violating Never criteria' };
  }
  const reason = matchedExpect
    ? `Answer violated Never (${scenario.never})`
    : `Answer did not satisfy Expect (${scenario.expect})`;
  return { pass: false, reason };
}

async function resolveScenarioAnswer(agent, scenario, { askFn, live }) {
  if (typeof askFn === 'function') {
    return askFn(agent, scenario);
  }
  if (live) {
    return callDomainModelLive(agent, scenario.ask);
  }
  const det = buildDeterministicBrief(agent, { query: scenario.ask });
  if (!det.relevant) {
    return 'nothing relevant';
  }
  return `${det.brief}\n${agent.glossaryRaw}\n${agent.memoriesRaw}`.trim();
}

/**
 * Runs scenario checks for one or all Domain Agents.
 */
export async function runScenarioChecks({
  agentName = null,
  agentsDir = DEFAULT_AGENTS_DIR,
  askFn = null,
  live = false,
} = {}) {
  const allAgents = loadDomainAgents(agentsDir);
  const targets = agentName ? allAgents.filter((a) => a.name === agentName) : allAgents;
  if (agentName && targets.length === 0) {
    throw new Error(`Unknown Domain Agent: ${agentName}`);
  }

  const results = [];
  for (const agent of targets) {
    for (const scenario of agent.scenarios) {
      const answer = await resolveScenarioAnswer(agent, scenario, { askFn, live });
      const verdict = evaluateScenarioAnswer(scenario, answer);
      results.push({
        agent: agent.name,
        title: scenario.title,
        pass: verdict.pass,
        reason: verdict.reason,
        answer: String(answer).slice(0, 400),
      });
    }
  }

  return {
    ok: results.every((r) => r.pass),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
  };
}

function validateSingleDomainAgent(agent, problems) {
  const prefix = `agents/${agent.name}`;
  if (agent.owns.length === 0) {
    problems.push(`${prefix}/agent.md: missing "owns:" glob list.`);
  }
  if (!agent.model) {
    problems.push(`${prefix}/agent.md: missing "model:" field.`);
  }
  if (agent.access !== 'read-only') {
    problems.push(`${prefix}/agent.md: "access:" must be "read-only" (got "${agent.access}").`);
  }
  if (!agent.job) {
    problems.push(`${prefix}/agent.md: missing "## Job" instructions.`);
  }
  if (!agent.memories.hasInternalSection || !agent.memories.hasCustomerSection) {
    problems.push(`${prefix}/memories.md: must contain both "## Internal engineering" and "## Customer facing".`);
  }
  const allMemories = [...agent.memories.internal, ...agent.memories.customerFacing];
  if (allMemories.length === 0) {
    problems.push(`${prefix}/memories.md: must contain at least one cited memory.`);
  }
  for (const mem of allMemories) {
    if (!RECEIPT_RE.test(mem)) {
      problems.push(
        `${prefix}/memories.md: memory missing receipt ([commit ...], [issue ...], [pr ...], or [from a conversation ...]): "${mem.slice(0, 60)}"`,
      );
    }
  }
  if (!agent.glossaryRaw.trim()) {
    problems.push(`${prefix}/glossary.md: missing or empty glossary.`);
  }
  if (agent.scenarios.length === 0) {
    problems.push(`${prefix}/scenarios.md: must define at least one scenario with Ask/Expect/Never.`);
  }
}

/**
 * Validates structure, frontmatter, memory receipts, glossaries, and scenarios under `agents/`.
 */
export function validateDomainAgents(agentsDir = DEFAULT_AGENTS_DIR) {
  const problems = [];
  if (!fs.existsSync(agentsDir)) {
    return { ok: true, count: 0, problems };
  }
  const agents = loadDomainAgents(agentsDir);
  for (const agent of agents) {
    validateSingleDomainAgent(agent, problems);
  }
  return { ok: problems.length === 0, count: agents.length, problems };
}

function readFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

function runCliValidation() {
  const v = validateDomainAgents(DEFAULT_AGENTS_DIR);
  if (!v.ok) {
    for (const p of v.problems) {
      console.error(`✗ ${p}`);
    }
    process.exitCode = 1;
    return false;
  }
  console.log(`✓ Domain Agents validated (${v.count} domain(s))`);
  return true;
}

async function runCliScenarios(agentName, live) {
  const report = await runScenarioChecks({ agentName, live });
  for (const r of report.results) {
    console.log(`${r.pass ? '✓' : '✗'} [${r.agent}] ${r.title} — ${r.reason}`);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const runScenarios = args.includes('--scenarios');
  const live = args.includes('--live');
  const agentName = readFlagValue(args, '--agent');
  const pathsArg = readFlagValue(args, '--paths') ?? '';

  if (args.includes('--validate') || (!runScenarios && !pathsArg)) {
    if (!runCliValidation() || (!runScenarios && !pathsArg)) {
      return;
    }
  }
  if (pathsArg) {
    const paths = pathsArg.split(',').map((s) => s.trim()).filter(Boolean);
    console.log(JSON.stringify(await consultDomainAgents({ paths, live }), null, 2));
  }
  if (runScenarios) {
    await runCliScenarios(agentName, live);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exitCode = 1;
  });
}
