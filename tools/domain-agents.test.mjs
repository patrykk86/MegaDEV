import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgent } from './agent-loop.mjs';
import {
  DEFAULT_AGENTS_DIR,
  callDomainModelLive,
  consultDomainAgents,
  createDomainAgentHook,
  extractPathsFromToolCall,
  globToRegExp,
  loadDomainAgents,
  matchPathToDomains,
  runScenarioChecks,
  validateDomainAgents,
} from './domain-agents.mjs';

test('validateDomainAgents passes for seeded workspace agents/', () => {
  const res = validateDomainAgents(DEFAULT_AGENTS_DIR);
  assert.equal(res.ok, true, `Expected valid agents/, got: ${res.problems.join('; ')}`);
  assert.ok(res.count >= 2, 'Expected at least 2 seeded Domain Agents');
});

test('matchPathToDomains and extractPathsFromToolCall match owned globs including shell commands', () => {
  const agents = loadDomainAgents(DEFAULT_AGENTS_DIR);
  const loopMatches = matchPathToDomains('tools/agent-loop.mjs', agents);
  assert.deepEqual(
    loopMatches.map((a) => a.name),
    ['agent-loop'],
  );

  const memMatches = matchPathToDomains('tools/memory/rule-budget.mjs', agents);
  assert.deepEqual(
    memMatches.map((a) => a.name),
    ['memory-journal'],
  );

  // Nested subdirectories under tools/memory/** must also match
  const nestedMatches = matchPathToDomains('tools/memory/nested/sub/check.mjs', agents);
  assert.deepEqual(
    nestedMatches.map((a) => a.name),
    ['memory-journal'],
  );
  assert.equal(globToRegExp('tools/memory/**').test('tools/memory/a/b/c.mjs'), true);

  const extracted = extractPathsFromToolCall({
    name: 'run_shell',
    arguments: { command: 'node --test tools/journal.test.mjs' },
  });
  assert.ok(extracted.includes('tools/journal.test.mjs'));
});

test('consultDomainAgents consults crossing domains in parallel and read-only', async () => {
  const consults = await consultDomainAgents({
    paths: ['tools/agent-loop.mjs', 'tools/journal.mjs'],
    query: 'Update journal logging inside beforeTool hook',
    agentsDir: DEFAULT_AGENTS_DIR,
  });

  assert.equal(consults.length, 2);
  const domains = consults.map((c) => c.domain).sort();
  assert.deepEqual(domains, ['agent-loop', 'memory-journal']);
  for (const c of consults) {
    assert.equal(c.access, 'read-only');
    assert.equal(c.relevant, true);
    assert.ok(c.brief.length > 0);
  }
});

test('createDomainAgentHook briefs runAgent once per domain per task without blocking tools', async () => {
  const consultCalls = [];
  const beforeTool = createDomainAgentHook({
    agentsDir: DEFAULT_AGENTS_DIR,
    consultFn: async (agent, ctx) => {
      consultCalls.push({ domain: agent.name, matchedPaths: ctx.matchedPaths });
      return `- Watch out for ${agent.name} invariant [commit 8c64208]`;
    },
  });

  let step = 0;
  const llm = {
    async generate({ messages }) {
      step += 1;
      if (step === 1) {
        return {
          finishReason: 'tool_calls',
          toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'tools/agent-loop.mjs' } }],
        };
      }
      if (step === 2) {
        return {
          finishReason: 'tool_calls',
          toolCalls: [{ id: '2', name: 'read_file', arguments: { path: 'tools/agent-guard.mjs' } }],
        };
      }
      const hasBrief = messages.some((m) => m.role === 'system' && String(m.content).includes('Domain Agent brief'));
      assert.equal(hasBrief, true, 'Expected Domain Agent brief injected into Main messages');
      return { finishReason: 'stop', text: 'done' };
    },
  };

  const out = await runAgent({
    model: 'deepseek/deepseek-v4.1-flash-20260910',
    llm,
    query: 'Inspect agent-loop and agent-guard',
    tools: {
      read_file: ({ path: p }) => `contents of ${p}`,
    },
    readOnlyTools: ['read_file'],
    hooks: { beforeTool },
  });

  assert.equal(out.end, 'answer');
  assert.equal(out.text, 'done');
  assert.equal(consultCalls.length, 1, 'Domain Agent should brief Main only once per domain per task');
  assert.equal(consultCalls[0].domain, 'agent-loop');
});

test('runScenarioChecks passes for workspace agents and fails if a key rule is removed', async () => {
  const passReport = await runScenarioChecks({ agentsDir: DEFAULT_AGENTS_DIR });
  assert.equal(passReport.ok, true, `Expected all scenarios to pass, failures: ${JSON.stringify(passReport.results.filter((r) => !r.pass))}`);
  assert.ok(passReport.total >= 6);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-domain-agents-'));
  try {
    const dest = path.join(tmpDir, 'agent-loop');
    fs.cpSync(path.join(DEFAULT_AGENTS_DIR, 'agent-loop'), dest, { recursive: true });
    // Water down memories & glossary so the beforeTool re-check rule is gone
    fs.writeFileSync(
      path.join(dest, 'memories.md'),
      '# Agent-Loop memories\n\n## Internal engineering\n- Keep files tidy. [commit 8c64208]\n\n## Customer facing\n- Be polite. [commit 5e35c68]\n',
      'utf8',
    );
    fs.writeFileSync(path.join(dest, 'glossary.md'), '# Agent-Loop glossary\n\n- **Loop**: Runs steps.\n', 'utf8');

    const failReport = await runScenarioChecks({ agentName: 'agent-loop', agentsDir: tmpDir });
    assert.equal(failReport.ok, false, 'Scenario check must fail when critical domain rules are watered down');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createDomainAgentHook deduplicates concurrent parallel read-only tool calls in one step', async () => {
  const consultCalls = [];
  const beforeTool = createDomainAgentHook({
    agentsDir: DEFAULT_AGENTS_DIR,
    consultFn: async (agent, ctx) => {
      await new Promise((r) => setTimeout(r, 15));
      consultCalls.push({ domain: agent.name, matchedPaths: ctx.matchedPaths });
      return `- Watch out for ${agent.name} invariant [commit 8c64208]`;
    },
  });

  let step = 0;
  const llm = {
    async generate() {
      step += 1;
      if (step === 1) {
        return {
          finishReason: 'tool_calls',
          toolCalls: [
            { id: '1', name: 'read_file', arguments: { path: 'tools/agent-loop.mjs' } },
            { id: '2', name: 'read_file', arguments: { path: 'tools/agent-guard.mjs' } },
          ],
        };
      }
      return { finishReason: 'stop', text: 'done' };
    },
  };

  const out = await runAgent({
    model: 'deepseek/deepseek-v4.1-flash-20260910',
    llm,
    query: 'Parallel read of two files in the same domain',
    tools: {
      read_file: ({ path: p }) => `contents of ${p}`,
    },
    readOnlyTools: ['read_file'],
    hooks: { beforeTool },
  });

  assert.equal(out.end, 'answer');
  assert.equal(consultCalls.length, 1, 'Concurrent tool calls in the same domain must trigger only one consultation');
});

test('callDomainModelLive resolves model limits from loadLimitsDoc() properly', async () => {
  const agents = loadDomainAgents(DEFAULT_AGENTS_DIR);
  const loopAgent = agents.find((a) => a.name === 'agent-loop');
  assert.ok(loopAgent);

  let capturedBody = null;
  let capturedSignal = null;
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key-for-unit-test';
  try {
    const reply = await callDomainModelLive(loopAgent, 'Check beforeTool hook', {
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        capturedSignal = init.signal;
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: '- Re-check with guardToolCall [commit 8c64208]' } }] };
          },
        };
      },
    });
    assert.ok(reply.includes('guardToolCall'));
    assert.equal(capturedBody.model, loopAgent.model);
    assert.equal(typeof capturedBody.max_tokens, 'number');
    assert.ok(Number.isFinite(capturedBody.max_tokens) && capturedBody.max_tokens > 0);
    assert.ok(capturedSignal instanceof AbortSignal);
  } finally {
    if (prevKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = prevKey;
    }
  }
});
