/**
 * @fileoverview Unit tests for tools/memory/rule-budget.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HARD_TOKEN_LIMIT,
  HARD_BYTE_LIMIT,
  estimateTokens,
  measureContent,
  buildAdvisoryManifest,
  loadProjectMemoryRules,
  enforceRuleBudget,
} from './rule-budget.mjs';
import { RuleBudgetExceededError } from './types.mjs';

test('measureContent and estimateTokens calculate deterministic metrics', () => {
  assert.deepEqual(measureContent(''), { bytes: 0, tokens: 0 });

  const sample = '# AGENTS.md\nAlways run tests before committing.';
  const metrics = measureContent(sample);
  assert.equal(metrics.bytes, Buffer.byteLength(sample, 'utf8'));
  assert.ok(metrics.tokens > 0);
  assert.equal(metrics.tokens, estimateTokens(sample));
});

test('enforceRuleBudget: passes when AGENTS.md and rules are within budget', () => {
  const agentsMdContent = '# AGENTS.md\nCore instructions for the repository.';
  const rules = [
    { id: 'rule-security', content: 'Never commit secrets.', hard: true },
    { id: 'rule-style', content: 'Prefer ES modules.', hard: false },
  ];

  const result = enforceRuleBudget({ agentsMdContent, rules });

  assert.equal(result.advisoryManifestInjected, false);
  assert.deepEqual(result.activeRules, ['rule-security', 'rule-style']);
  assert.deepEqual(result.demotedRules, []);
  assert.ok(result.compiledContent.includes('Never commit secrets.'));
  assert.ok(result.compiledContent.includes('Prefer ES modules.'));
  assert.ok(result.tokens <= HARD_TOKEN_LIMIT);
  assert.ok(result.bytes <= HARD_BYTE_LIMIT);
});

test('enforceRuleBudget: throws RuleBudgetExceededError when byte limit (>24KB) is exceeded by hard rules', () => {
  const oversizedContent = 'x'.repeat(25 * 1024);

  assert.throws(
    () =>
      enforceRuleBudget({
        agentsMdContent: oversizedContent,
        rules: [{ id: 'hard-1', content: 'Mandatory rule', hard: true }],
      }),
    (err) => {
      assert.ok(err instanceof RuleBudgetExceededError);
      assert.equal(err.code, 'ERR_RULE_BUDGET_EXCEEDED');
      assert.ok(err.metrics.bytes > HARD_BYTE_LIMIT);
      assert.equal(err.metrics.maxBytes, HARD_BYTE_LIMIT);
      return true;
    }
  );
});

test('enforceRuleBudget: throws RuleBudgetExceededError when token limit (>20,000 tokens) is exceeded', () => {
  const manyTokensContent = Array.from({ length: 16_000 }, () => 'a').join(' ');

  assert.throws(
    () =>
      enforceRuleBudget({
        agentsMdContent: manyTokensContent,
        maxTokens: HARD_TOKEN_LIMIT,
        maxBytes: 100_000,
      }),
    (err) => {
      assert.ok(err instanceof RuleBudgetExceededError);
      assert.ok(err.metrics.tokens > HARD_TOKEN_LIMIT);
      assert.equal(err.metrics.maxTokens, HARD_TOKEN_LIMIT);
      return true;
    }
  );
});

test('enforceRuleBudget: demotes non-hard rules and injects advisory manifest when approaching budget', () => {
  const agentsMdContent = '# AGENTS.md\nCore instructions.';
  const hardRule = {
    id: 'core-safety',
    content: 'Validate all inputs using validateId and validateSymbolPointer.',
    hard: true,
  };
  const softRuleFits = {
    id: 'soft-fits',
    content: 'Keep functions small.',
    hard: false,
    path: '.agents/rules/soft-fits.md',
    summary: 'Code modularity guidelines',
  };
  const softRuleHeavy = {
    id: 'soft-heavy',
    content: `Detailed architectural history: ${'word '.repeat(400)}`,
    hard: false,
    path: '.agents/rules/soft-heavy.md',
    summary: 'Historical context and legacy migration notes',
  };

  const result = enforceRuleBudget({
    agentsMdContent,
    rules: [hardRule, softRuleFits, softRuleHeavy],
    maxBytes: 1000,
    maxTokens: 5000,
  });

  assert.equal(result.advisoryManifestInjected, true);
  assert.deepEqual(result.activeRules, ['core-safety', 'soft-fits']);
  assert.equal(result.demotedRules.length, 1);
  assert.equal(result.demotedRules[0].id, 'soft-heavy');
  assert.equal(result.demotedRules[0].path, '.agents/rules/soft-heavy.md');

  assert.ok(result.compiledContent.includes('<!-- MEMORY_ADVISORY_MANIFEST_START -->'));
  assert.ok(result.compiledContent.includes('**soft-heavy** (.agents/rules/soft-heavy.md)'));
  assert.ok(result.compiledContent.includes('Historical context and legacy migration notes'));
  assert.ok(!result.compiledContent.includes('Detailed architectural history:'));
  assert.ok(result.bytes <= 1000);
});

test('enforceRuleBudget: injects advisory manifest when a rule is explicitly marked demoted: true', () => {
  const result = enforceRuleBudget({
    agentsMdContent: '# AGENTS.md',
    rules: [
      {
        id: 'explicitly-demoted',
        content: 'Rarely needed database migration rule.',
        hard: false,
        demoted: true,
        path: 'rules/db-migration.md',
        summary: 'Load when modifying SQL schemas',
      },
    ],
  });

  assert.equal(result.advisoryManifestInjected, true);
  assert.deepEqual(result.activeRules, []);
  assert.equal(result.demotedRules.length, 1);
  assert.equal(result.demotedRules[0].id, 'explicitly-demoted');
  assert.ok(result.compiledContent.includes('rules/db-migration.md'));
  assert.ok(result.compiledContent.includes('Load when modifying SQL schemas'));
});

test('buildAdvisoryManifest returns empty string when no rules are demoted', () => {
  assert.equal(buildAdvisoryManifest([]), '');
});

test('enforceRuleBudget: validates maxTokens and maxBytes as positive safe integers', () => {
  assert.throws(
    () => enforceRuleBudget({ agentsMdContent: '# Doc', maxTokens: Number.NaN }),
    /maxTokens must be a positive safe integer/
  );
  assert.throws(
    () => enforceRuleBudget({ agentsMdContent: '# Doc', maxTokens: 0 }),
    /maxTokens must be a positive safe integer/
  );
  assert.throws(
    () => enforceRuleBudget({ agentsMdContent: '# Doc', maxTokens: -10 }),
    /maxTokens must be a positive safe integer/
  );
  assert.throws(
    () => enforceRuleBudget({ agentsMdContent: '# Doc', maxBytes: Number.POSITIVE_INFINITY }),
    /maxBytes must be a positive safe integer/
  );
  assert.throws(
    () => enforceRuleBudget({ agentsMdContent: '# Doc', maxBytes: 12.5 }),
    /maxBytes must be a positive safe integer/
  );
});

test('buildAdvisoryManifest: sanitizes HTML comments, dashes, and newlines to prevent breakout injection', () => {
  const demoted = [
    {
      id: 'rule--injection-->alert(1)',
      path: 'foo/bar\r\nbaz<!--comment-->',
      summary: 'Summary with --> breakout attempt\nand newlines',
      tokens: 10,
      bytes: 40,
    },
  ];

  const manifest = buildAdvisoryManifest(demoted);
  assert.ok(!manifest.includes('-->alert(1)'));
  assert.ok(manifest.includes('rule__injection__&gt;alert(1)'));
  assert.ok(!manifest.includes('\r\n'));
  assert.ok(manifest.includes('baz&lt;!__comment__&gt;'));
  assert.ok(manifest.includes('Summary with __&gt; breakout attempt and newlines'));
});

test('loadProjectMemoryRules & enforceRuleBudget: auto-loads memory/MEMORY.md as soft rule', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lamarck-mem-test-'));
  try {
    const memDir = path.join(tmpDir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, 'MEMORY.md'),
      '# Claude Memory\n## Gotchas\n- Always test with node --test\n',
      'utf-8'
    );

    const loaded = loadProjectMemoryRules(tmpDir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'project-memory-lamarck');
    assert.equal(loaded[0].hard, false);
    assert.ok(loaded[0].content.includes('Always test with node --test'));

    const result = enforceRuleBudget({
      agentsMdContent: '# AGENTS.md\nRules',
      workspaceRoot: tmpDir,
    });

    assert.ok(result.activeRules.includes('project-memory-lamarck'));
    assert.ok(result.compiledContent.includes('Always test with node --test'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
