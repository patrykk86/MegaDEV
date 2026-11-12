/**
 * @fileoverview Enforces token and byte budgets for AGENTS.md and memory rules.
 * Demotes non-hard rules when soft/hard thresholds are approached and injects
 * an advisory manifest so agents know where to inspect demoted rules on demand.
 *
 * Memory is a tree, not one file: `memory/MEMORY.md` is the index (a hard rule, never
 * demoted, so routing always reaches the model) and every `.md` it links to is a subject
 * file loaded as its own soft rule. A subject that does not fit is demoted alone, and the
 * advisory manifest names the file to read on demand, so overflow costs one subject
 * instead of the whole memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { RuleBudgetExceededError } from './types.mjs';

export const HARD_TOKEN_LIMIT = 24_000;
export const HARD_BYTE_LIMIT = 36 * 1024; // 36,864 bytes: AGENTS.md plus the whole memory tree

/** The index file: always loaded, never demoted. */
export const MEMORY_INDEX_NAME = 'MEMORY.md';
/** The index routes, so it must stay readable at a glance. */
export const INDEX_BYTE_CAP = 3_072;
/** One subject, one file: a subject that outgrows this is split, not grown. */
export const SUBJECT_BYTE_CAP = 4_096;

/** Generated or rendered files that live beside memory and were never rules. */
const RESERVED_MEMORY_FILES = new Set(['CODEBASE-MAP.md', 'PRODUCT-VIEW.html']);

const MEMORY_LINK_RE = /\]\(([^()\s]+\.md)\)/gi;

function findMemoryIndex(workspaceRoot) {
  for (const rel of [
    path.join('memory', MEMORY_INDEX_NAME),
    path.join('.claude', 'memory', MEMORY_INDEX_NAME),
  ]) {
    const candidate = path.join(workspaceRoot, rel);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Subject files the index links to, in the order it links them: that order is priority,
 * because `packSoftRules` keeps the earliest and demotes the tail.
 * @param {string} indexContent
 * @param {string} [indexName]
 * @returns {string[]}
 */
export function listMemorySubjectFiles(indexContent, indexName = MEMORY_INDEX_NAME) {
  if (typeof indexContent !== 'string') {
    throw new TypeError('indexContent must be a string.');
  }
  const seen = new Set();
  const subjects = [];
  for (const match of indexContent.matchAll(MEMORY_LINK_RE)) {
    const raw = match[1].trim().replace(/^\.\//, '');
    if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes(':') || raw.includes('..')) {
      continue;
    }
    if (raw === MEMORY_INDEX_NAME || raw === indexName || RESERVED_MEMORY_FILES.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    subjects.push(raw);
  }
  return subjects;
}

function relativeTo(workspaceRoot, full) {
  return path.relative(workspaceRoot, full).replace(/\\/g, '/');
}

/** One linked subject: it must exist, carry rules and stay inside its cap. */
function describeSubject(dir, name, workspaceRoot, problems) {
  const full = path.join(dir, name);
  const rel = relativeTo(workspaceRoot, full);
  if (!fs.existsSync(full)) {
    problems.push(`${rel}: linked from the index but missing. A dangling link cannot load.`);
    return null;
  }
  const bytes = Buffer.byteLength(fs.readFileSync(full, 'utf-8'), 'utf8');
  if (bytes === 0) {
    problems.push(`${rel}: empty subject file. Remove the link or write the rules.`);
    return null;
  }
  if (bytes > SUBJECT_BYTE_CAP) {
    problems.push(
      `${rel}: ${bytes}B exceeds the ${SUBJECT_BYTE_CAP}B subject cap. Split it by subject or tighten the prose.`
    );
  }
  return { name, path: rel, bytes };
}

/** A subject nobody links is a rule the model never reads. */
function reportUnlinkedSubjects(dir, indexName, linked, workspaceRoot, problems) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    if (entry.name === indexName || RESERVED_MEMORY_FILES.has(entry.name) || linked.has(entry.name)) {
      continue;
    }
    problems.push(
      `${relativeTo(workspaceRoot, path.join(dir, entry.name))}: not linked from ${indexName}, so it never loads. Link it or delete it.`
    );
  }
}

/**
 * Reads the memory tree and reports what is wrong with its shape. The gate in
 * `tools/check.mjs` and the loader below share this, so a layout that cannot load is a
 * failure instead of a silent no-op.
 * @param {string} [workspaceRoot]
 */
export function inspectMemoryLayout(workspaceRoot = process.cwd()) {
  const index = findMemoryIndex(workspaceRoot);
  if (!index) {
    return { ok: true, problems: [], index: null, subjects: [] };
  }

  const problems = [];
  const indexRel = path.relative(workspaceRoot, index).replace(/\\/g, '/');
  const indexContent = fs.readFileSync(index, 'utf-8');
  const indexBytes = Buffer.byteLength(indexContent, 'utf8');
  if (indexBytes > INDEX_BYTE_CAP) {
    problems.push(
      `${indexRel}: ${indexBytes}B exceeds the ${INDEX_BYTE_CAP}B index cap. It routes; detail belongs in a subject file.`
    );
  }

  const dir = path.dirname(index);
  const linked = listMemorySubjectFiles(indexContent, path.basename(index));
  const subjects = [];
  for (const name of linked) {
    const subject = describeSubject(dir, name, workspaceRoot, problems);
    if (subject) {
      subjects.push(subject);
    }
  }
  reportUnlinkedSubjects(dir, path.basename(index), new Set(linked), workspaceRoot, problems);

  return {
    ok: problems.length === 0,
    problems,
    index: { path: indexRel, bytes: indexBytes },
    subjects,
  };
}

/** First heading of a subject file, used as its line in the advisory manifest. */
function subjectSummary(content, name) {
  const heading = content.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : name;
}

/**
 * Loads the memory tree as rules: the index as a hard rule, each linked subject as its
 * own soft rule. A single unlinked `MEMORY.md` still loads as one soft rule, so an older
 * workspace keeps working.
 * @param {string} [workspaceRoot]
 */
export function loadProjectMemoryRules(workspaceRoot = process.cwd()) {
  const indexPath = findMemoryIndex(workspaceRoot);
  if (!indexPath) {
    return [];
  }

  let indexContent = '';
  try {
    indexContent = fs.readFileSync(indexPath, 'utf-8').trim();
  } catch {
    return []; // Fail-safe: unreadable memory is absent memory, not a crash
  }
  if (indexContent.length === 0) {
    return [];
  }

  const indexRel = path.relative(workspaceRoot, indexPath).replace(/\\/g, '/');
  const dir = path.dirname(indexPath);
  const linked = listMemorySubjectFiles(indexContent, path.basename(indexPath));

  if (linked.length === 0) {
    return [
      {
        id: 'project-memory-lamarck',
        content: indexContent,
        hard: false,
        path: indexRel,
        summary: 'Lamarck auto-curated conventions, gotchas, and tool recipes',
      },
    ];
  }

  const rules = [
    {
      id: 'project-memory-index',
      content: indexContent,
      hard: true,
      path: indexRel,
      summary: 'Memory index; routes a question to the subject file that answers it',
    },
  ];

  for (const name of linked) {
    const full = path.join(dir, name);
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf-8').trim();
    } catch {
      continue; // A link to a missing file is reported by inspectMemoryLayout
    }
    if (content.length === 0) {
      continue;
    }
    rules.push({
      id: `memory:${name.replace(/\.md$/i, '')}`,
      content,
      hard: false,
      path: path.relative(workspaceRoot, full).replace(/\\/g, '/'),
      summary: subjectSummary(content, name),
    });
  }

  return rules;
}

export function estimateTokens(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }
  const charBased = Math.ceil(text.length / 4);
  const segments = text.trim().split(/[\s.,!?;:()[\]{}"'`~<>\\|+=*-]+/).filter(Boolean);
  const wordBased = Math.ceil(segments.length * 1.3);
  return Math.max(charBased, wordBased);
}

export function measureContent(text) {
  if (!text || typeof text !== 'string') {
    return { bytes: 0, tokens: 0 };
  }
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    tokens: estimateTokens(text),
  };
}

export function sanitizeAdvisoryText(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str
    .replace(/--/g, '__')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function buildAdvisoryManifest(demotedRules) {
  if (!Array.isArray(demotedRules) || demotedRules.length === 0) {
    return '';
  }

  const lines = [
    '<!-- MEMORY_ADVISORY_MANIFEST_START -->',
    '## Advisory Rules Manifest (Demoted for Context Budget)',
    'The following non-hard rules were omitted from active context to respect the 20,000 token / 24KB budget. Load them on-demand when relevant:',
    '',
  ];

  for (const rule of demotedRules) {
    const cleanId = sanitizeAdvisoryText(rule.id);
    const loc = rule.path ? ` (${sanitizeAdvisoryText(rule.path)})` : '';
    const desc = rule.summary ? ` - ${sanitizeAdvisoryText(rule.summary)}` : '';
    lines.push(`- **${cleanId}**${loc}: ~${rule.tokens} tokens, ${rule.bytes}B${desc}`);
  }

  lines.push('<!-- MEMORY_ADVISORY_MANIFEST_END -->');
  return lines.join('\n');
}

function partitionRules(rules) {
  const hardRules = [];
  const activeSoftRules = [];
  const demotedRules = [];

  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || typeof rule.content !== 'string') {
      throw new TypeError('Each rule must be an object with string "id" and "content" properties.');
    }
    const metrics = measureContent(rule.content);
    const enriched = { ...rule, ...metrics };
    if (rule.hard !== false && !rule.demoted) {
      hardRules.push(enriched);
    } else if (rule.demoted) {
      demotedRules.push({
        id: rule.id,
        path: rule.path,
        summary: rule.summary,
        tokens: metrics.tokens,
        bytes: metrics.bytes,
      });
    } else {
      activeSoftRules.push(enriched);
    }
  }

  return { hardRules, activeSoftRules, demotedRules };
}

function assembleDocument(baseText, hardRules, includedSoft, demotedList) {
  const sections = [];
  if (baseText.length > 0) {
    sections.push(baseText);
  }
  for (const hr of hardRules) {
    sections.push(hr.content);
  }
  for (const sr of includedSoft) {
    sections.push(sr.content);
  }

  const manifest = buildAdvisoryManifest(demotedList);
  if (manifest) {
    sections.push(manifest);
  }

  const text = sections.join('\n\n');
  const metrics = measureContent(text);
  return { text, metrics, manifestInjected: Boolean(manifest) };
}

function checkMandatoryBudget(baseText, hardRules, maxTokens, maxBytes) {
  const mandatoryParts = [];
  if (baseText.length > 0) {
    mandatoryParts.push(baseText);
  }
  for (const hr of hardRules) {
    mandatoryParts.push(hr.content);
  }

  const mandatoryMetrics = measureContent(mandatoryParts.join('\n\n'));
  if (mandatoryMetrics.tokens > maxTokens || mandatoryMetrics.bytes > maxBytes) {
    throw new RuleBudgetExceededError(
      `Hard rule budget exceeded: ${mandatoryMetrics.tokens}/${maxTokens} tokens, ${mandatoryMetrics.bytes}/${maxBytes} bytes.`,
      { tokens: mandatoryMetrics.tokens, maxTokens, bytes: mandatoryMetrics.bytes, maxBytes }
    );
  }
}

function packSoftRules(baseText, hardRules, activeSoftRules, demotedRules, maxTokens, maxBytes) {
  const accepted = [];

  for (const candidate of activeSoftRules) {
    const trial = assembleDocument(baseText, hardRules, [...accepted, candidate], demotedRules);
    if (trial.metrics.tokens <= maxTokens && trial.metrics.bytes <= maxBytes) {
      accepted.push(candidate);
    } else {
      demotedRules.push({
        id: candidate.id,
        path: candidate.path,
        summary: candidate.summary,
        tokens: candidate.tokens,
        bytes: candidate.bytes,
      });
    }
  }

  let assembly = assembleDocument(baseText, hardRules, accepted, demotedRules);
  while ((assembly.metrics.tokens > maxTokens || assembly.metrics.bytes > maxBytes) && accepted.length > 0) {
    const evicted = accepted.pop();
    demotedRules.unshift({
      id: evicted.id,
      path: evicted.path,
      summary: evicted.summary,
      tokens: evicted.tokens,
      bytes: evicted.bytes,
    });
    assembly = assembleDocument(baseText, hardRules, accepted, demotedRules);
  }

  return { accepted, assembly };
}

export function enforceRuleBudget({
  agentsMdContent = '',
  rules = [],
  workspaceRoot = null,
  maxTokens = HARD_TOKEN_LIMIT,
  maxBytes = HARD_BYTE_LIMIT,
} = {}) {
  if (typeof agentsMdContent !== 'string') {
    throw new TypeError('agentsMdContent must be a string.');
  }
  if (!Array.isArray(rules)) {
    throw new TypeError('rules must be an array.');
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new TypeError(`maxTokens must be a positive safe integer, got ${maxTokens}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError(`maxBytes must be a positive safe integer, got ${maxBytes}`);
  }

  const combinedRules = [...rules];
  const alreadyCarriesMemory = combinedRules.some(
    (r) => typeof r.id === 'string' && (r.id.startsWith('project-memory-') || r.id.startsWith('memory:'))
  );
  if (workspaceRoot && !alreadyCarriesMemory) {
    const memoryRules = loadProjectMemoryRules(workspaceRoot);
    combinedRules.push(...memoryRules);
  }

  const { hardRules, activeSoftRules, demotedRules } = partitionRules(combinedRules);
  checkMandatoryBudget(agentsMdContent, hardRules, maxTokens, maxBytes);

  const { accepted, assembly } = packSoftRules(
    agentsMdContent,
    hardRules,
    activeSoftRules,
    demotedRules,
    maxTokens,
    maxBytes
  );

  if (assembly.metrics.tokens > maxTokens || assembly.metrics.bytes > maxBytes) {
    throw new RuleBudgetExceededError(
      `Rule budget exceeded after demoting all non-hard rules: ${assembly.metrics.tokens}/${maxTokens} tokens, ${assembly.metrics.bytes}/${maxBytes} bytes.`,
      { tokens: assembly.metrics.tokens, maxTokens, bytes: assembly.metrics.bytes, maxBytes }
    );
  }

  return {
    compiledContent: assembly.text,
    tokens: assembly.metrics.tokens,
    bytes: assembly.metrics.bytes,
    activeRules: [...hardRules.map((r) => r.id), ...accepted.map((r) => r.id)],
    demotedRules,
    advisoryManifestInjected: assembly.manifestInjected,
  };
}
