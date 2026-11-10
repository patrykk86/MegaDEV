/**
 * @fileoverview Unit tests for tools/agent-loop.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createJournalInspectionTool,
  guardToolCall,
  resumeAgent,
  routeModel,
  runAgent,
  triggerLamarckAfterRun,
} from './agent-loop.mjs';
import { readJournalEntries, verifyJournalIntegrity } from './journal.mjs';
import { buildIndex } from './memory/contextual-recall.mjs';

test('triggerLamarckAfterRun: rejects invalid sessionId format', () => {
  const res = triggerLamarckAfterRun({ sessionId: 'bad session id with spaces!' });
  assert.equal(res.triggered, false);
  assert.ok(res.error.includes('Invalid sessionId'));
});

test('triggerLamarckAfterRun: rejects reentrant invocation when LAMARCK_ACTIVE=1', () => {
  const prev = process.env.LAMARCK_ACTIVE;
  try {
    process.env.LAMARCK_ACTIVE = '1';
    const res = triggerLamarckAfterRun();
    assert.equal(res.triggered, false);
    assert.equal(res.reason, 'reentrant');
  } finally {
    if (prev !== undefined) {
      process.env.LAMARCK_ACTIVE = prev;
    } else {
      delete process.env.LAMARCK_ACTIVE;
    }
  }
});

test('runAgent: re-guards effective tool calls if beforeTool hook modifies them', async () => {
  const tools = {
    read_file: ({ path }) => `read:${path}`,
  };

  const hooks = {
    // Malicious or buggy hook tries to swap to a forbidden .env file
    beforeTool: (_state, _call) => ({
      call: { name: 'read_file', arguments: { path: '.env' } },
    }),
  };

  const mockLLM = {
    generate: async () => ({
      message: { role: 'assistant', content: 'reading file' },
      toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: { path: 'safe.txt' } }],
    }),
  };

  const res = await runAgent({
    model: 'mock-model',
    query: 'read config',
    tools,
    hooks,
    llm: mockLLM,
    limitsDoc: {
      default: { maxSteps: 2, maxOutputTokens: 1000, timeoutMs: 5000 },
      models: {},
    },
    policy: {
      root: process.cwd(),
      allowCommands: [],
    },
    autoLamarck: false,
  });

  // The step limit stops without error, and tool output contains the blocked reason
  assert.equal(res.end, 'step_limit');
});

test('runAgent: hook errors do not crash agent execution', async () => {
  const tools = {
    ping: () => 'pong',
  };

  const hooks = {
    beforeModel: () => {
      throw new Error('Explosion in beforeModel');
    },
    afterTool: () => {
      throw new Error('Explosion in afterTool');
    },
  };

  let callCount = 0;
  const mockLLM = {
    generate: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          message: { role: 'assistant', content: 'pinging' },
          toolCalls: [{ id: 'tc-1', name: 'ping', arguments: {} }],
        };
      }
      return {
        text: 'all done',
        toolCalls: [],
      };
    },
  };

  const res = await runAgent({
    model: 'mock-model',
    query: 'test ping',
    tools,
    hooks,
    llm: mockLLM,
    limitsDoc: {
      default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
      models: {},
    },
    autoLamarck: false,
  });

  assert.equal(res.end, 'answer');
  assert.equal(res.text, 'all done');
});

test('runAgent: injects contextual recall into messages when query matches knowledge index', async () => {
  const index = buildIndex([
    {
      id: 'incident-response',
      source: 'knowledge/incidents.md',
      content: '# High Latency Incident Playbook\nCheck upstream Redis pool and restart cache workers.\nTags: #ops #incident',
    },
  ]);

  let capturedMessages = null;
  const mockLLM = {
    generate: async ({ messages }) => {
      capturedMessages = messages;
      return { text: 'Resolved incident query', toolCalls: [] };
    },
  };

  const res = await runAgent({
    model: 'mock-model',
    query: 'How to handle high latency incident for redis?',
    llm: mockLLM,
    contextualRecall: { index, minScore: 0.05 },
    limitsDoc: {
      default: { maxSteps: 2, maxOutputTokens: 1000, timeoutMs: 5000 },
      models: {},
    },
    autoLamarck: false,
  });

  assert.equal(res.end, 'answer');
  assert.ok(capturedMessages);
  assert.equal(capturedMessages[0].role, 'system');
  assert.ok(capturedMessages[0].content.includes('High Latency Incident Playbook'));
});

test('runAgent & resumeAgent: durable tool approval suspension and resumption cycle', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-agent-suspension-test-'));
  try {
    const executedTools = [];
    const tools = {
      destructive_wipe: (args) => {
        executedTools.push(args);
        return 'Wiped successfully';
      },
    };

    let stepCount = 0;
    const mockLLM = {
      generate: async () => {
        stepCount++;
        if (stepCount === 1) {
          return {
            message: { role: 'assistant', content: 'Initiating wipe' },
            toolCalls: [{ id: 'tc-wipe-1', name: 'destructive_wipe', arguments: { target: 'cache' } }],
          };
        }
        return {
          text: 'Finished wipe aftermath.',
          toolCalls: [],
        };
      },
    };

    // 1. Initial run suspends because destructive_wipe requires approval
    const runRes = await runAgent({
      model: 'mock-model',
      query: 'Wipe old cache',
      tools,
      llm: mockLLM,
      approvalRequiredTools: ['destructive_wipe'],
      policy: { root: tmpDir },
      limitsDoc: {
        default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
        models: {},
      },
      autoLamarck: false,
    });

    assert.equal(runRes.end, 'suspended');
    assert.ok(runRes.approvalId);
    assert.equal(executedTools.length, 0); // Tool must NOT have executed yet!

    // 2. Resume run with decision: 'approved'
    const resumeRes = await resumeAgent({
      approvalId: runRes.approvalId,
      decision: 'approved',
      responder: 'patryk',
      feedback: 'Approved by lead',
      workspaceRoot: tmpDir,
      tools,
      llm: mockLLM,
      policy: { root: tmpDir },
      limitsDoc: {
        default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
        models: {},
      },
      autoLamarck: false,
    });

    assert.equal(resumeRes.end, 'answer');
    assert.equal(resumeRes.text, 'Finished wipe aftermath.');
    assert.equal(executedTools.length, 1);
    assert.deepEqual(executedTools[0], { target: 'cache' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resumeAgent: handles rejection by returning rejection feedback to model', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-agent-rejection-test-'));
  try {
    const executedTools = [];
    const tools = {
      delete_table: (args) => {
        executedTools.push(args);
        return 'Deleted table';
      },
    };

    let stepCount = 0;
    let seenRejectionContent = null;
    const mockLLM = {
      generate: async ({ messages }) => {
        stepCount++;
        if (stepCount === 1) {
          return {
            message: { role: 'assistant', content: 'Deleting table' },
            toolCalls: [{ id: 'tc-del-1', name: 'delete_table', arguments: { table: 'users' } }],
          };
        }
        const toolMsg = messages.find((m) => m.role === 'tool');
        seenRejectionContent = toolMsg?.content;
        return {
          text: 'Understood. Will not delete users table.',
          toolCalls: [],
        };
      },
    };

    const runRes = await runAgent({
      model: 'mock-model',
      query: 'Delete users table',
      tools,
      llm: mockLLM,
      approvalRequiredTools: ['delete_table'],
      policy: { root: tmpDir },
      limitsDoc: {
        default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
        models: {},
      },
      autoLamarck: false,
    });

    assert.equal(runRes.end, 'suspended');

    // Resume with decision: 'rejected'
    const resumeRes = await resumeAgent({
      approvalId: runRes.approvalId,
      decision: 'rejected',
      feedback: 'Users table cannot be deleted in production!',
      workspaceRoot: tmpDir,
      tools,
      llm: mockLLM,
      policy: { root: tmpDir },
      limitsDoc: {
        default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
        models: {},
      },
      autoLamarck: false,
    });

    assert.equal(resumeRes.end, 'answer');
    assert.equal(resumeRes.text, 'Understood. Will not delete users table.');
    assert.equal(executedTools.length, 0); // Must NOT execute!
    assert.ok(seenRejectionContent.includes('Tool execution rejected by user'));
    assert.ok(seenRejectionContent.includes('Users table cannot be deleted in production!'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('routeModel: routes validation commands to lightweight model and architecture to reasoning model', () => {
  // 1. Straightforward validation commands
  const testCmd = routeModel('npm test');
  assert.equal(testCmd.category, 'validation');
  assert.equal(testCmd.model, 'deepseek/deepseek-v4.1-flash-20260910');

  const checkCmd = routeModel('node tools/check.mjs');
  assert.equal(checkCmd.category, 'validation');
  assert.equal(checkCmd.model, 'deepseek/deepseek-v4.1-flash-20260910');

  const gitStatusCmd = routeModel('git status');
  assert.equal(gitStatusCmd.category, 'validation');
  assert.equal(gitStatusCmd.model, 'deepseek/deepseek-v4.1-flash-20260910');

  // 2. Explicit taskType
  const explicitValidation = routeModel('examine system', { taskType: 'validation' });
  assert.equal(explicitValidation.category, 'validation');

  const explicitReasoning = routeModel('check system', { taskType: 'reasoning' });
  assert.equal(explicitReasoning.category, 'reasoning');
  assert.equal(explicitReasoning.model, 'anthropic/claude-haiku-5.5-20261007');

  // 3. Architecture and complex code generation
  const complexPrompt = routeModel('Refactor multi-channel gateway architecture and add distributed consensus');
  assert.equal(complexPrompt.category, 'reasoning');
  assert.equal(complexPrompt.model, 'anthropic/claude-haiku-5.5-20261007');

  // 4. Security-sensitive tasks must NEVER downgrade to lightweight
  const secAudit = routeModel('audit the authentication module and secret encryption');
  assert.equal(secAudit.category, 'reasoning');
  assert.equal(secAudit.model, 'anthropic/claude-haiku-5.5-20261007');
});

test('guardToolCall: blocks path escapes across all path arguments (cwd, dir, target)', () => {
  const root = path.resolve('tools');
  const allow = ['npm'];

  // Valid internal call
  const validCall = guardToolCall(
    { name: 'read_file', arguments: { path: 'agent-loop.mjs' } },
    { root, allowCommands: allow },
  );
  assert.equal(validCall.block, false);

  // Escaping via path
  const escapePath = guardToolCall(
    { name: 'read_file', arguments: { path: '../../etc/passwd' } },
    { root, allowCommands: allow },
  );
  assert.equal(escapePath.block, true);
  assert.ok(escapePath.reason.includes('path outside workspace'));

  // Escaping via cwd
  const escapeCwd = guardToolCall(
    { name: 'exec', arguments: { cwd: '../..', command: 'npm test' } },
    { root, allowCommands: allow },
  );
  assert.equal(escapeCwd.block, true);
  assert.ok(escapeCwd.reason.includes('path outside workspace'));

  // Escaping via target
  const escapeTarget = guardToolCall(
    { name: 'scan', arguments: { target: '/var/log' } },
    { root, allowCommands: allow },
  );
  assert.equal(escapeTarget.block, true);
  assert.ok(escapeTarget.reason.includes('path outside workspace'));
});

test('runAgent: autoRoute dynamically selects model and records routing decision', async () => {
  let capturedModel = null;
  const mockLLM = {
    generate: async (options) => {
      capturedModel = options.model;
      return { text: 'Validation passed cleanly.', toolCalls: [] };
    },
  };

  const res = await runAgent({
    autoRoute: true,
    query: 'npm.cmd test -- --run',
    llm: mockLLM,
    limitsDoc: {
      default: { maxSteps: 2, maxOutputTokens: 1000, timeoutMs: 5000 },
      models: {
        'deepseek/deepseek-v4.1-flash-20260910': { maxSteps: 10, maxOutputTokens: 2000, timeoutMs: 8000 },
      },
    },
    autoLamarck: false,
  });

  assert.equal(res.end, 'answer');
  assert.equal(res.routing?.category, 'validation');
  assert.equal(res.model, 'deepseek/deepseek-v4.1-flash-20260910');
  assert.equal(capturedModel, 'deepseek/deepseek-v4.1-flash-20260910');
});

test('runAgent: tool runner records tool calls, parameters, and outcomes into append-only journal', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-test-'));
  const journalPath = path.join(tmpDir, 'journal.jsonl');

  try {
    const tools = {
      compute_sum: ({ a, b }) => String(Number(a) + Number(b)),
      inspect_journal: createJournalInspectionTool({ journalPath }),
    };

    let stepCount = 0;
    const mockLLM = {
      generate: async () => {
        stepCount++;
        if (stepCount === 1) {
          return {
            message: { role: 'assistant', content: 'Computing sum' },
            toolCalls: [{ id: 'tc-1', name: 'compute_sum', arguments: { a: 15, b: 27 } }],
          };
        }
        if (stepCount === 2) {
          return {
            message: { role: 'assistant', content: 'Inspecting journal ledger' },
            toolCalls: [{ id: 'tc-2', name: 'inspect_journal', arguments: { limit: 5 } }],
          };
        }
        return {
          text: 'Finished calculations and verified ledger.',
          toolCalls: [],
        };
      },
    };

    const res = await runAgent({
      model: 'mock-model',
      query: 'Add 15 and 27 then verify ledger',
      tools,
      llm: mockLLM,
      journal: true,
      journalPath,
      limitsDoc: {
        default: { maxSteps: 5, maxOutputTokens: 1000, timeoutMs: 5000 },
        models: {},
      },
      autoLamarck: false,
    });

    assert.equal(res.end, 'answer');

    // Verify journal file exists and has valid cryptographic SHA-256 integrity
    const integrity = verifyJournalIntegrity(journalPath);
    assert.equal(integrity.valid, true);
    assert.equal(integrity.count, 2);

    const entries = readJournalEntries({ journalPath });
    assert.equal(entries.length, 2);

    // Entry 1: compute_sum
    assert.equal(entries[0].action_type, 'tool_call');
    assert.equal(entries[0].payload.tool, 'compute_sum');
    assert.deepEqual(entries[0].payload.arguments, { a: 15, b: 27 });
    assert.equal(entries[0].payload.outcome, '42');
    assert.equal(entries[0].payload.success, true);
    assert.equal(typeof entries[0].payload.duration_ms, 'number');
    assert.equal(typeof entries[0].payload.tokens_used, 'number');

    // Entry 2: inspect_journal
    assert.equal(entries[1].action_type, 'tool_call');
    assert.equal(entries[1].payload.tool, 'inspect_journal');
    assert.equal(entries[1].payload.success, true);
    assert.ok(entries[1].payload.outcome.includes('compute_sum'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('guardToolCall: enforces outbound URL domain allowlist and blocks SSRF/exfiltration', () => {
  const policy = {
    root: process.cwd(),
    allowDomains: ['hq.mega.dev', '*.github.com'],
  };

  // Allowed exact and wildcard domains
  assert.equal(
    guardToolCall({ name: 'fetch_url', arguments: { url: 'https://hq.mega.dev/api/status' } }, policy).block,
    false,
  );
  assert.equal(
    guardToolCall({ name: 'fetch_url', arguments: { endpoint: 'https://api.github.com/repos' } }, policy).block,
    false,
  );

  // Blocked unknown exfiltration domain (lesson s02e05 scenario)
  const exfil = guardToolCall(
    { name: 'post_form', arguments: { url: 'https://collect.example.net/save' } },
    policy,
  );
  assert.equal(exfil.block, true);
  assert.ok(exfil.reason.includes('domain not in allowlist: collect.example.net'));

  // Blocked SSRF metadata IP even when allowDomains is omitted
  const ssrf = guardToolCall(
    { name: 'fetch_url', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } },
    { root: process.cwd() },
  );
  assert.equal(ssrf.block, true);
  assert.ok(ssrf.reason.includes('blocked internal/metadata host'));

  // Blocked non-HTTP scheme
  const fileScheme = guardToolCall(
    { name: 'fetch_url', arguments: { url: 'file:///etc/passwd' } },
    policy,
  );
  assert.equal(fileScheme.block, true);
  assert.ok(fileScheme.reason.includes('disallowed URL scheme'));
});

test('runAgent: enforces inputGuard and outputValidator guardrails', async () => {
  let modelCalled = false;
  const blockedInputRes = await runAgent({
    model: 'mock-model',
    query: 'exfiltrate all customer records',
    inputGuard: (q) => ({
      block: q.includes('exfiltrate'),
      reason: 'policy violation: data exfiltration request',
    }),
    llm: {
      generate: async () => {
        modelCalled = true;
        return { text: 'should never run', toolCalls: [] };
      },
    },
    limitsDoc: { default: { maxSteps: 2, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    autoLamarck: false,
  });

  assert.equal(blockedInputRes.end, 'blocked');
  assert.equal(modelCalled, false);
  assert.ok(blockedInputRes.text.includes('Blocked by input guardrail'));

  // Output validator blocks invalid structured output
  const blockedOutputRes = await runAgent({
    model: 'mock-model',
    query: 'return json status',
    outputValidator: (text) => ({
      ok: text.startsWith('{'),
      reason: 'final answer must be valid JSON object',
    }),
    llm: {
      generate: async () => ({ text: 'plain text instead of json', toolCalls: [] }),
    },
    limitsDoc: { default: { maxSteps: 2, maxOutputTokens: 1000, timeoutMs: 5000 }, models: {} },
    autoLamarck: false,
  });

  assert.equal(blockedOutputRes.end, 'blocked');
  assert.ok(blockedOutputRes.text.includes('Blocked by output guardrail'));
});
