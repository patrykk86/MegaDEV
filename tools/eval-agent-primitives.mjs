#!/usr/bin/env node
/**
 * @fileoverview Synthetic Evaluation Matrix for AGENTS.md Section 8 (Contextual Recall & Resumable Approvals).
 *
 * Implements Rule 5: Matrix-driven verification and policy-as-code assertions
 * crossing user intents, memory budgets, and security/tamper conditions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resumeAgent, runAgent } from './agent-loop.mjs';
import { buildPermutationMatrix, evaluateSuite } from './eval-skill.mjs';
import { buildIndex } from './memory/contextual-recall.mjs';
import { createSuspension, loadSuspension } from './resumable-approval.mjs';

const corpus = [
  {
    id: 'kb-redis',
    source: 'kb/redis.md',
    content: '# Redis Cache Pooling\nConnection timeouts and eviction policies for high throughput.\nTags: #redis #cache #performance',
  },
  {
    id: 'kb-auth',
    source: 'kb/auth.md',
    content: '# JWT Authentication Architecture\nRotate refresh tokens and store in secure httpOnly cookies.\nTags: #security #auth #jwt',
  },
];

async function runRecallCase(c, index, tmpDir) {
  let injected = false;
  const isTag = c.scenario === 'recall_tag_boost';
  const query = isTag ? 'check #redis #cache eviction' : 'how to configure jwt cookie security?';
  const expectedText = isTag ? 'Redis Cache Pooling' : 'JWT Authentication Architecture';

  await runAgent({
    model: 'mock-model',
    query,
    contextualRecall: { index, maxTokens: c.maxTokens, minScore: 0.05 },
    limitsDoc: { default: { maxSteps: 2, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    llm: {
      generate: async ({ messages }) => {
        if (messages[0]?.role === 'system' && messages[0].content.includes(expectedText)) {
          injected = true;
        }
        return { text: 'Done', toolCalls: [] };
      },
    },
    policy: { root: tmpDir },
    autoLamarck: false,
  });
  return { ok: injected, type: 'recall' };
}

async function runApproveCase(tmpDir) {
  let executed = false;
  const tools = { deploy_prod: () => { executed = true; return 'deployed'; } };
  const initial = await runAgent({
    model: 'mock-model',
    query: 'deploy prod',
    approvalRequiredTools: ['deploy_prod'],
    tools,
    limitsDoc: { default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    llm: {
      generate: async () => ({
        message: { role: 'assistant', content: 'deploying' },
        toolCalls: [{ id: 'tc-1', name: 'deploy_prod', arguments: {} }],
      }),
    },
    policy: { root: tmpDir },
    autoLamarck: false,
  });

  assert.equal(initial.end, 'suspended');

  const resumed = await resumeAgent({
    approvalId: initial.approvalId,
    decision: 'approved',
    tools,
    limitsDoc: { default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    llm: { generate: async () => ({ text: 'All deployed', toolCalls: [] }) },
    policy: { root: tmpDir },
    workspaceRoot: tmpDir,
    autoLamarck: false,
  });

  return { ok: executed && resumed.end === 'answer', type: 'approval' };
}

async function runRejectCase(tmpDir) {
  let executed = false;
  const tools = { drop_db: () => { executed = true; return 'dropped'; } };
  const initial = await runAgent({
    model: 'mock-model',
    query: 'drop database',
    approvalRequiredTools: ['drop_db'],
    tools,
    limitsDoc: { default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    llm: {
      generate: async () => ({
        message: { role: 'assistant', content: 'dropping' },
        toolCalls: [{ id: 'tc-2', name: 'drop_db', arguments: {} }],
      }),
    },
    policy: { root: tmpDir },
    autoLamarck: false,
  });

  assert.equal(initial.end, 'suspended');

  let seenRejectionInPrompt = false;
  const resumed = await resumeAgent({
    approvalId: initial.approvalId,
    decision: 'rejected',
    feedback: 'Dangerous action denied',
    tools,
    limitsDoc: { default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    llm: {
      generate: async ({ messages }) => {
        const toolMsg = messages.find((m) => m.role === 'tool');
        if (toolMsg?.content.includes('Dangerous action denied')) {
          seenRejectionInPrompt = true;
        }
        return { text: 'Cancelled drop', toolCalls: [] };
      },
    },
    policy: { root: tmpDir },
    workspaceRoot: tmpDir,
    autoLamarck: false,
  });

  return { ok: !executed && seenRejectionInPrompt && resumed.end === 'answer', type: 'approval' };
}

function runTamperCase(tmpDir) {
  const sus = createSuspension({
    toolCall: { id: 'tc-tamper', name: 'safe_action', arguments: {} },
    state: { step: 1, messages: [] },
    workspaceRoot: tmpDir,
  });

  const raw = JSON.parse(fs.readFileSync(sus.filePath, 'utf-8'));
  raw.toolCall.name = 'malicious_injected_action';
  fs.writeFileSync(sus.filePath, JSON.stringify(raw), 'utf-8');

  let blocked = false;
  try {
    loadSuspension(sus.approvalId, { workspaceRoot: tmpDir });
  } catch (err) {
    if (err.message.includes('failed HMAC integrity verification')) {
      blocked = true;
    }
  }
  return { ok: blocked, type: 'security' };
}

async function executeScenario(c, index) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-primitives-'));
  try {
    if (c.scenario === 'recall_query' || c.scenario === 'recall_tag_boost') {
      return await runRecallCase(c, index, tmpDir);
    }
    if (c.scenario === 'approval_approve') {
      return await runApproveCase(tmpDir);
    }
    if (c.scenario === 'approval_reject') {
      return await runRejectCase(tmpDir);
    }
    if (c.scenario === 'approval_tamper_guard') {
      return runTamperCase(tmpDir);
    }
    return { ok: false, type: 'unknown' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runPrimitivesMatrix() {
  const factors = {
    scenario: [
      'recall_query',
      'recall_tag_boost',
      'approval_approve',
      'approval_reject',
      'approval_tamper_guard',
    ],
    maxTokens: [200, 800],
  };

  const cases = buildPermutationMatrix(factors);
  const index = buildIndex(corpus);
  const runner = (c) => executeScenario(c, index);

  const policyAssert = (c, outcome) => ({
    passed: outcome?.ok === true,
    category: `${c.scenario}`,
    expected: true,
    actual: outcome?.ok,
  });

  return evaluateSuite({ cases, runner, policyAssert });
}

if (process.argv[1]?.endsWith('eval-agent-primitives.mjs')) {
  console.log('Running AGENTS.md Section 8 Synthetic Permutation Matrix...');
  runPrimitivesMatrix()
    .then((res) => {
      console.log(`Evaluated ${res.total} synthetic permutations.`);
      console.log(`Pass Rate: ${(res.passRate * 100).toFixed(1)}% (${res.passed}/${res.total})`);
      for (const [cat, data] of Object.entries(res.byCategory)) {
        console.log(`- ${cat}: ${(data.passRate * 100).toFixed(1)}%`);
      }
      if (res.passed !== res.total) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
