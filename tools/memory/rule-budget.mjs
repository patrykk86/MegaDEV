/**
 * @fileoverview Enforces token and byte budgets for AGENTS.md and memory rules.
 * Demotes non-hard rules when soft/hard thresholds are approached and injects
 * an advisory manifest so agents know where to inspect demoted rules on demand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { RuleBudgetExceededError } from './types.mjs';

export const HARD_TOKEN_LIMIT = 20_000;
export const HARD_BYTE_LIMIT = 24 * 1024; // 24,576 bytes (24KB)

export function loadProjectMemoryRules(workspaceRoot = process.cwd()) {
  const candidatePaths = [
    path.join(workspaceRoot, 'memory', 'MEMORY.md'),
    path.join(workspaceRoot, '.claude', 'memory', 'MEMORY.md'),
  ];

  const loadedRules = [];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (content.length > 0) {
          const relPath = path.relative(workspaceRoot, p).replace(/\\/g, '/');
          loadedRules.push({
            id: 'project-memory-lamarck',
            content,
            hard: false,
            path: relPath,
            summary: 'Lamarck auto-curated conventions, gotchas, and tool recipes',
          });
          break;
        }
      } catch {
        // Fail-safe: if unreadable, ignore
      }
    }
  }
  return loadedRules;
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
  if (workspaceRoot && !combinedRules.some((r) => r.id === 'project-memory-lamarck')) {
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
