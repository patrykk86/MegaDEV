/**
 * @fileoverview Unit tests for tools/agent-loop.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, triggerLamarckAfterRun } from './agent-loop.mjs';

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

