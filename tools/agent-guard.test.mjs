/**
 * @fileoverview Tests and experiments for tools/agent-guard.mjs and pre-execution guards (AGENTS.md section 7).
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkSource,
  isScannable,
  RULES,
  sessionStartPayload,
  stopDecision,
} from './agent-guard.mjs'
import { guardToolCall, runAgent } from './agent-loop.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

test('agent-guard: static rule checks (AG1-AG4)', async (t) => {
  const cases = [
    {
      name: 'compliant model call with limits, timeout, and output cap produces no violations',
      code: `
        import { resolveLimits } from './model-limits.mjs';
        const limits = resolveLimits(doc, 'gpt-4o');
        const res = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages,
          max_tokens: limits.maxOutputTokens,
          signal: AbortSignal.timeout(limits.timeoutMs),
        });
      `,
      expected: [],
    },
    {
      name: 'non-model code without model API calls produces no violations even with while(true)',
      code: `
        let counter = 0;
        while (true) {
          counter++;
          if (counter > 10) break;
        }
      `,
      expected: [],
    },
    {
      name: 'AG1: flags unbounded while(true) loop enclosing a model call',
      code: `
        import { resolveLimits } from './model-limits.mjs';
        while (true) {
          const res = await openai.chat.completions.create({
            max_tokens: 1000,
            signal: AbortSignal.timeout(5000),
          });
        }
      `,
      expected: ['AG1'],
    },
    {
      name: 'AG2: flags model call missing max_tokens output cap',
      code: `
        import { resolveLimits } from './model-limits.mjs';
        const res = await openai.chat.completions.create({
          signal: AbortSignal.timeout(5000),
        });
      `,
      expected: ['AG2'],
    },
    {
      name: 'AG3: flags model call missing timeout or AbortSignal',
      code: `
        import { resolveLimits } from './model-limits.mjs';
        const res = await openai.chat.completions.create({
          max_tokens: 1000,
        });
      `,
      expected: ['AG3'],
    },
    {
      name: 'AG4: flags model call without importing or referencing limits source',
      code: `
        const res = await openai.chat.completions.create({
          max_tokens: 1000,
          signal: AbortSignal.timeout(5000),
        });
      `,
      expected: ['AG4'],
    },
    {
      name: 'AG1-AG4: multiple violations triggered when loop is unbounded and all caps/sources are missing',
      code: `
        while (true) {
          const res = await openai.chat.completions.create({});
        }
      `,
      expected: ['AG1', 'AG2', 'AG3', 'AG4'],
    },
  ]

  for (const tc of cases) {
    await t.test(tc.name, () => {
      assert.deepEqual(checkSource(tc.code), tc.expected)
    })
  }
})

test('agent-guard: isScannable identifies scannable source code and excludes canonical and test files', async (t) => {
  const cases = [
    // Scannable source files across multiple extensions (.js, .mjs, .ts, .py)
    {
      path: 'src/index.js',
      expected: true,
      desc: 'JavaScript (.js) source file is scannable',
    },
    {
      path: 'src/worker.mjs',
      expected: true,
      desc: 'ES Module (.mjs) source file is scannable',
    },
    {
      path: 'src/agent.ts',
      expected: true,
      desc: 'TypeScript (.ts) source file is scannable',
    },
    {
      path: 'tools/bridge.py',
      expected: true,
      desc: 'Python (.py) source file is scannable',
    },

    // Canonical files excluded from scanning
    {
      path: 'tools/agent-guard.mjs',
      expected: false,
      desc: 'canonical agent-guard.mjs is excluded',
    },
    {
      path: 'tools/agent-loop.mjs',
      expected: false,
      desc: 'canonical agent-loop.mjs is excluded',
    },
    {
      path: 'tools/model-limits.mjs',
      expected: false,
      desc: 'canonical model-limits.mjs is excluded',
    },

    // Test files excluded from scanning
    {
      path: 'tools/agent-guard.test.mjs',
      expected: false,
      desc: 'test file (.test.mjs) is excluded',
    },
    {
      path: 'src/worker.spec.ts',
      expected: false,
      desc: 'spec file (.spec.ts) is excluded',
    },
    {
      path: 'tests/test_worker.py',
      expected: false,
      desc: 'Python test file (tests/test_*.py) is excluded',
    },
    {
      path: 'test_script.py',
      expected: false,
      desc: 'Python test file (test_*.py) is excluded',
    },

    // Non-code files excluded from scanning
    {
      path: 'README.md',
      expected: false,
      desc: 'documentation (.md) is excluded',
    },
    {
      path: 'package.json',
      expected: false,
      desc: 'JSON (.json) is excluded',
    },
  ]

  for (const tc of cases) {
    await t.test(tc.desc, () => {
      assert.equal(
        isScannable(tc.path),
        tc.expected,
        `Expected isScannable("${tc.path}") to be ${tc.expected}`,
      )
    })
  }
})

test('agent-guard: sessionStartPayload injects section 7 agent rules', () => {
  const payload = sessionStartPayload()
  assert.ok(
    Array.isArray(payload.injectSteps) && payload.injectSteps.length > 0,
    'sessionStartPayload must return a non-empty injectSteps array',
  )
  const [step] = payload.injectSteps
  assert.ok(
    step?.systemMessage?.systemMessage,
    'first injected step must contain systemMessage.systemMessage text',
  )
  const sysMsg = step.systemMessage.systemMessage
  assert.ok(
    sysMsg.includes('NON-NEGOTIABLE AGENT RULES'),
    'must declare NON-NEGOTIABLE AGENT RULES header',
  )
  assert.ok(
    sysMsg.includes('runAgent()'),
    'must require runAgent() agent loop execution',
  )
  assert.ok(
    sysMsg.includes('tools/model-limits.json'),
    'must reference tools/model-limits.json for limits',
  )
  assert.ok(
    sysMsg.includes('AGENTS.md section 7'),
    'must cite AGENTS.md section 7 enforcement',
  )
})

test('agent-guard: stopDecision blocks termination on violations until retry cap', (t) => {
  const testId = `test-conv-${crypto.randomUUID()}`
  const mockProblems = [{ file: 'bad.js', rule: 'AG1', message: RULES.AG1 }]
  const tmpFile = path.join(os.tmpdir(), `megadev-agent-guard-${testId}.json`)
  t.after(() => fs.rmSync(tmpFile, { force: true }))

  // First stop attempt with problems: blocked ('continue')
  const firstAttempt = stopDecision(
    { conversationId: testId, terminationReason: 'NO_TOOL_CALL' },
    mockProblems,
  )
  assert.equal(firstAttempt.decision, 'continue')
  assert.ok(firstAttempt.reason.includes('non-negotiable agent rules violated'))

  // Second stop attempt: blocked ('continue')
  const secondAttempt = stopDecision(
    { conversationId: testId, terminationReason: 'NO_TOOL_CALL' },
    mockProblems,
  )
  assert.equal(secondAttempt.decision, 'continue')

  // Third attempt reaches STOP_RETRY_CAP: allowed
  const thirdAttemptAllowed = stopDecision(
    { conversationId: testId, terminationReason: 'NO_TOOL_CALL' },
    mockProblems,
  )
  assert.equal(thirdAttemptAllowed.decision, 'allow')
})

const SHELL_COMMAND_CASES = [
  {
    name: 'semicolon chaining is blocked',
    command: 'npm test; rm -rf /',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'double pipe chaining is blocked',
    command: 'npm test || echo pwned',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'single ampersand backgrounding is blocked',
    command: 'npm test &',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'backtick command substitution is blocked',
    command: 'npm test `cat /etc/passwd`',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'dollar-parentheses command substitution is blocked',
    command: 'npm test $(whoami)',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'shell input redirect is blocked',
    command: 'npm test < input.txt',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'shell output redirect is blocked',
    command: 'npm test > out.txt',
    expectedBlock: true,
    reason: 'shell chaining, pipes and redirects are not allowed',
  },
  {
    name: 'parameter expansion and whitespace tricks are blocked',
    command: 'git$' + '{IFS}status',
    expectedBlock: true,
    reason: 'command not in allowlist: git$' + '{IFS}status',
  },
  {
    name: 'command touching .env is blocked',
    command: 'git status .env',
    expectedBlock: true,
    reason: 'commands touching .env are not allowed',
  },
  {
    name: 'command touching .env.local is blocked',
    command: 'git status .env.local',
    expectedBlock: true,
    reason: 'commands touching .env are not allowed',
  },
  {
    name: 'command touching .env.prod is blocked',
    command: 'git status .env.prod',
    expectedBlock: true,
    reason: 'commands touching .env are not allowed',
  },
  {
    name: 'command not in allowlist is blocked',
    command: 'curl http://malicious.site',
    expectedBlock: true,
    reason: 'command not in allowlist: curl',
  },
  {
    name: 'valid allowlisted command passes',
    command: 'npm test',
    expectedBlock: false,
  },
]

test('pre-execution guard: unauthorized shell commands are blocked before execution', async (t) => {
  const policy = {
    root: ROOT,
    allowCommands: ['npm test', 'node tools/check.mjs', 'git status'],
  }

  for (const tc of SHELL_COMMAND_CASES) {
    await t.test(tc.name, () => {
      const res = guardToolCall(
        { name: 'exec', arguments: { command: tc.command } },
        policy,
      )
      assert.equal(res.block, tc.expectedBlock)
      if (tc.expectedBlock) {
        assert.equal(res.reason, tc.reason)
      }
    })
  }
})

const FILE_PATH_CASES = [
  {
    name: 'path escaping workspace via forward slash is blocked',
    path: '../secret.txt',
    expectedBlock: true,
    reasonPattern: /path outside workspace/,
  },
  {
    name: 'path escaping workspace via backslash is blocked',
    path: '..\\secret.txt',
    expectedBlock: true,
    reasonPattern: /path outside workspace/,
  },
  {
    name: 'secret file .env is blocked',
    path: '.env',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'secret file .env.local is blocked',
    path: '.env.local',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'secret file .env.production is blocked',
    path: '.env.production',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'private key certs/server.key is blocked',
    path: 'certs/server.key',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'cert certs/server.pem is blocked',
    path: 'certs/server.pem',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'ssh key .ssh/id_rsa is blocked',
    path: '.ssh/id_rsa',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'ssh key id_rsa is blocked',
    path: 'id_rsa',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'credentials manifest credentials.json is blocked',
    path: 'credentials.json',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'credentials manifest mcp_config.json is blocked',
    path: 'mcp_config.json',
    expectedBlock: true,
    reasonPattern: /secret file is never readable by agents/,
  },
  {
    name: 'valid workspace path package.json passes',
    path: 'package.json',
    expectedBlock: false,
  },
  {
    name: 'valid workspace path src/index.js passes',
    path: 'src/index.js',
    expectedBlock: false,
  },
]

test('pre-execution guard: unauthorized file paths and secrets are blocked', async (t) => {
  const policy = {
    root: ROOT,
    allowCommands: [],
  }

  for (const tc of FILE_PATH_CASES) {
    await t.test(tc.name, () => {
      const res = guardToolCall(
        { name: 'read_file', arguments: { path: tc.path } },
        policy,
      )
      assert.equal(res.block, tc.expectedBlock)
      if (tc.expectedBlock) {
        assert.match(res.reason, tc.reasonPattern)
      }
    })
  }
})

test('pre-execution guard: fail-closed policy defaults block commands by default', async (t) => {
  const call = { name: 'exec', arguments: { command: 'npm test' } }

  await t.test('empty policy object defaults to deny for commands', () => {
    const res = guardToolCall(call, {})
    assert.equal(res.block, true)
    assert.equal(res.reason, 'command not in allowlist: npm')
  })

  await t.test(
    'policy with root but without allowCommands blocks commands',
    () => {
      const res = guardToolCall(call, { root: ROOT })
      assert.equal(res.block, true)
      assert.equal(res.reason, 'command not in allowlist: npm')
    },
  )
})

test('pre-execution guard: prototype dispatch resistance rejects Object prototype names', async () => {
  const protoNames = [
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
  ]

  let turn = 0
  const mockLLM = {
    generate: async () => {
      turn++
      if (turn === 1) {
        return {
          message: {
            role: 'assistant',
            content: 'attempting prototype property invocations',
          },
          toolCalls: protoNames.map((name, index) => ({
            id: `call-proto-${index}`,
            name,
            arguments: {},
          })),
        }
      }
      return { text: 'Prototype calls resisted.', toolCalls: [] }
    },
  }

  let recordedMessages = []
  const hooks = {
    afterRun: ({ state }) => {
      recordedMessages = state.messages
    },
  }

  const res = await runAgent({
    model: 'mock-model',
    query: 'test prototype dispatch resistance',
    tools: { custom_tool: () => 'ok' },
    hooks,
    llm: mockLLM,
    limitsDoc: {
      default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
      models: {},
    },
    policy: {
      root: ROOT,
      allowCommands: [],
    },
    autoLamarck: false,
  })

  assert.equal(res.end, 'answer')
  assert.equal(res.text, 'Prototype calls resisted.')

  const toolMessages = recordedMessages.filter((m) => m.role === 'tool')
  assert.equal(toolMessages.length, protoNames.length)

  for (let i = 0; i < protoNames.length; i++) {
    const name = protoNames[i]
    const id = `call-proto-${i}`
    const msg = toolMessages.find((m) => m.tool_call_id === id)
    assert.ok(msg, `tool message for ${id} (${name}) must exist`)
    assert.deepEqual(JSON.parse(msg.content), {
      error: `unknown tool ${name}`,
    })
  }
})

function makeSingleStepToolLLM(toolCall) {
  let turn = 0
  return {
    generate: async () => {
      turn++
      if (turn === 1) {
        return {
          message: {
            role: 'assistant',
            content: 'attempting tool invocation in agent loop',
          },
          toolCalls: [toolCall],
        }
      }
      return { text: 'Handled tool call gracefully.', toolCalls: [] }
    },
  }
}

async function runSingleToolTest({ toolCall, tools, policy, maxResultChars }) {
  let recordedMessages = []
  const res = await runAgent({
    sessionId: crypto.randomUUID(),
    model: 'mock-model',
    query: 'test security & error containment',
    tools,
    hooks: {
      afterRun: ({ state }) => {
        recordedMessages = state.messages
      },
    },
    llm: makeSingleStepToolLLM(toolCall),
    limitsDoc: {
      default: { maxSteps: 3, maxOutputTokens: 1000, timeoutMs: 5000 },
      models: {},
    },
    policy: policy ?? { root: ROOT, allowCommands: [] },
    maxResultChars,
    autoLamarck: false,
  })

  const toolMsg = recordedMessages.find((m) => m.tool_call_id === toolCall.id)
  return { res, toolMsg, recordedMessages }
}

async function testBlockedCommand() {
  let executedUnauthorized = false
  const toolCall = {
    id: 'c1',
    name: 'bash',
    arguments: { command: 'rm -rf * && cat .env' },
  }
  const tools = {
    bash: ({ command }) => {
      executedUnauthorized = true
      return `executed: ${command}`
    },
  }

  const { res, toolMsg } = await runSingleToolTest({
    toolCall,
    tools,
    policy: { root: ROOT, allowCommands: ['npm test'] },
  })

  assert.equal(executedUnauthorized, false)
  assert.equal(res.end, 'answer')
  assert.ok(toolMsg, 'tool message for c1 must exist')
  assert.ok(
    toolMsg.content.includes(
      'blocked: shell chaining, pipes and redirects are not allowed',
    ),
  )
}

async function testUnknownTool() {
  const toolCall = {
    id: 'c2',
    name: 'non_existent_tool',
    arguments: { foo: 'bar' },
  }
  const { res, toolMsg } = await runSingleToolTest({
    toolCall,
    tools: { known_tool: () => 'ok' },
  })

  assert.equal(res.end, 'answer')
  assert.ok(toolMsg, 'tool message for c2 must exist')
  assert.deepEqual(JSON.parse(toolMsg.content), {
    error: 'unknown tool non_existent_tool',
  })
}

async function testTrappedExceptions() {
  const toolCall = { id: 'c3', name: 'exploding_tool', arguments: {} }
  const tools = {
    exploding_tool: () => {
      throw new Error('Fatal database connection explosion!')
    },
  }

  const { res, toolMsg } = await runSingleToolTest({
    toolCall,
    tools,
  })

  assert.equal(res.end, 'answer')
  assert.ok(toolMsg, 'tool message for c3 must exist')
  assert.deepEqual(JSON.parse(toolMsg.content), {
    error: 'Fatal database connection explosion!',
  })
}

async function testTruncateOutput() {
  const MAX_RESULT_CHARS = 1000
  const HUGE_OUTPUT_CHARS = 12000
  const EXPECTED_TRUNCATED_CHARS = HUGE_OUTPUT_CHARS - MAX_RESULT_CHARS

  const toolCall = { id: 'c4', name: 'huge_output_tool', arguments: {} }
  const tools = {
    huge_output_tool: () => 'A'.repeat(HUGE_OUTPUT_CHARS),
  }

  const { res, toolMsg } = await runSingleToolTest({
    toolCall,
    tools,
    maxResultChars: MAX_RESULT_CHARS,
  })

  assert.equal(res.end, 'answer')
  assert.ok(toolMsg, 'tool message for c4 must exist')
  assert.ok(
    toolMsg.content.includes(`[truncated ${EXPECTED_TRUNCATED_CHARS} chars]`),
  )
}

test('pre-execution guard: unexpected tool outputs & errors are safely contained in agent loop', async (t) => {
  await t.test(
    'runAgent blocks unauthorized shell commands without executing them',
    testBlockedCommand,
  )
  await t.test(
    'runAgent gracefully handles unknown tools as structured error JSON',
    testUnknownTool,
  )
  await t.test(
    'runAgent safely traps thrown tool exceptions without crashing',
    testTrappedExceptions,
  )
  await t.test(
    'runAgent truncates oversized tool outputs to maxResultChars',
    testTruncateOutput,
  )
})
