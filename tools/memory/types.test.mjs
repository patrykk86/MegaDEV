/**
 * @fileoverview Unit tests for tools/memory/types.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  WINDOWS_RESERVED,
  EVENT_ID_REGEX,
  SHA256_HEX,
  GIT_COMMIT_SHA,
  SYMBOL_POINTER_REGEX,
  SecurityError,
  StaleSymbolPointerError,
  EventSequenceExhaustedError,
  RuleBudgetExceededError,
  validateId,
  validateSymbolPointer,
  computeContentSha256,
  computeSymbolSha,
} from './types.mjs';

test('Custom Error Classes instantiate with expected properties', () => {
  const secErr = new SecurityError('bad input', { field: 'id' });
  assert.ok(secErr instanceof Error);
  assert.equal(secErr.name, 'SecurityError');
  assert.equal(secErr.code, 'ERR_MEMORY_SECURITY');
  assert.deepEqual(secErr.details, { field: 'id' });

  const staleErr = new StaleSymbolPointerError('symbol://a#b?sha=c', 'expected123', 'actual456');
  assert.ok(staleErr instanceof Error);
  assert.equal(staleErr.name, 'StaleSymbolPointerError');
  assert.equal(staleErr.expectedSha, 'expected123');
  assert.equal(staleErr.actualSha, 'actual456');

  const seqErr = new EventSequenceExhaustedError('agent-1', 999999);
  assert.ok(seqErr instanceof Error);
  assert.equal(seqErr.name, 'EventSequenceExhaustedError');
  assert.equal(seqErr.agentId, 'agent-1');
  assert.equal(seqErr.lastSequence, 999999);

  const budgetErr = new RuleBudgetExceededError('Over budget', {
    tokens: 25000,
    maxTokens: 20000,
    bytes: 30000,
    maxBytes: 24576,
  });
  assert.ok(budgetErr instanceof Error);
  assert.equal(budgetErr.name, 'RuleBudgetExceededError');
  assert.equal(budgetErr.metrics.tokens, 25000);
});

test('validateId: accepts valid identifiers', () => {
  const validIds = ['a', 'agent-1', 'Agent_01', '0123456789', 'a'.repeat(64)];
  for (const id of validIds) {
    assert.equal(validateId(id), id);
  }
});

test('validateId: rejects path traversal, slashes, and invalid lengths', () => {
  const invalidIds = [
    '',
    '..',
    '../secret',
    'foo/../bar',
    '/leading',
    'trailing/',
    'back\\slash',
    'null\0byte',
    '-starts-with-dash',
    '_starts_with_underscore',
    'a'.repeat(65),
    'spaces not allowed',
  ];

  for (const invalid of invalidIds) {
    assert.throws(
      () => validateId(invalid, 'testId'),
      (err) => err instanceof SecurityError,
      `Expected "${invalid}" to throw SecurityError`
    );
  }
});

test('validateId & WINDOWS_RESERVED: rejects Windows reserved names', () => {
  const reservedNames = [
    'CON',
    'con',
    'PRN',
    'aux',
    'NUL',
    'COM1',
    'com9',
    'LPT1',
    'lpt9',
    'con.txt',
    'LPT1.log',
  ];

  for (const name of reservedNames) {
    assert.ok(WINDOWS_RESERVED.test(name), `Expected WINDOWS_RESERVED to match ${name}`);
    assert.throws(
      () => validateId(name, 'reservedCheck'),
      (err) => err instanceof SecurityError && err.message.includes('Windows reserved')
    );
  }

  assert.equal(validateId('CONSOLE'), 'CONSOLE');
  assert.equal(validateId('COM10'), 'COM10');
  assert.equal(validateId('LPT0'), 'LPT0');
});

test('EVENT_ID_REGEX: validates evt-<agent>-000001 up to 64 chars', () => {
  assert.ok(EVENT_ID_REGEX.test('evt-a-000001'));
  assert.ok(EVENT_ID_REGEX.test('evt-planner_01-000042'));
  assert.ok(EVENT_ID_REGEX.test('evt-coder-999999'));

  const maxAgent = 'a'.repeat(53);
  const maxEventId = `evt-${maxAgent}-000001`;
  assert.equal(maxEventId.length, 64);
  assert.ok(EVENT_ID_REGEX.test(maxEventId));

  const tooLongEventId = `evt-${'a'.repeat(54)}-000001`;
  assert.equal(tooLongEventId.length, 65);
  assert.ok(!EVENT_ID_REGEX.test(tooLongEventId));

  const invalidEventIds = [
    'evt--000001',
    'evt-_agent-000001',
    'evt--agent-000001',
    'evt-agent-00001',
    'evt-agent-0000001',
    'evt-agent-abcdef',
    'event-agent-000001',
    'evt-agent/1-000001',
  ];

  for (const invalid of invalidEventIds) {
    assert.ok(!EVENT_ID_REGEX.test(invalid), `Expected EVENT_ID_REGEX to reject "${invalid}"`);
  }
});

test('SHA256_HEX and GIT_COMMIT_SHA regexes', () => {
  const validSha256 = 'a'.repeat(64);
  const validGitSha = 'f'.repeat(40);

  assert.ok(SHA256_HEX.test(validSha256));
  assert.ok(!SHA256_HEX.test('A'.repeat(64)));
  assert.ok(!SHA256_HEX.test('g'.repeat(64)));
  assert.ok(!SHA256_HEX.test('a'.repeat(63)));

  assert.ok(GIT_COMMIT_SHA.test(validGitSha));
  assert.ok(!GIT_COMMIT_SHA.test('f'.repeat(39)));
  assert.ok(!GIT_COMMIT_SHA.test('F'.repeat(40)));
});

test('validateSymbolPointer: parses valid symbol:// URLs and rejects unsafe paths', () => {
  const workspaceRoot = '/workspace/project';
  const sha = computeSymbolSha('function hello() { return 42; }');
  const validUri = `symbol://src/utils/math.mjs#MyClass_hello?sha=${sha}`;

  const parsed = validateSymbolPointer(validUri, workspaceRoot);
  assert.equal(parsed.uri, validUri);
  assert.equal(parsed.relativePath, 'src/utils/math.mjs');
  assert.equal(parsed.absolutePath, path.resolve(workspaceRoot, 'src/utils/math.mjs'));
  assert.equal(parsed.symbolName, 'MyClass_hello');
  assert.equal(parsed.sha256, sha);
  assert.ok(SYMBOL_POINTER_REGEX.test(validUri));

  const invalidPointers = [
    `http://src/index.mjs#fn?sha=${sha}`,
    `symbol:///etc/passwd#fn?sha=${sha}`,
    `symbol://../outside.mjs#fn?sha=${sha}`,
    `symbol://src/../../outside.mjs#fn?sha=${sha}`,
    `symbol://src/./index.mjs#fn?sha=${sha}`,
    `symbol://src//index.mjs#fn?sha=${sha}`,
    `symbol://src\\index.mjs#fn?sha=${sha}`,
    `symbol://C:/src/index.mjs#fn?sha=${sha}`,
    `symbol://src/CON/index.mjs#fn?sha=${sha}`,
    `symbol://src/nul.mjs#fn?sha=${sha}`,
    `symbol://src/index.mjs#invalid-symbol!?sha=${sha}`,
    `symbol://src/index.mjs#fn?sha=12345`,
    `symbol://src/index.mjs?sha=${sha}`,
  ];

  for (const badPointer of invalidPointers) {
    assert.throws(
      () => validateSymbolPointer(badPointer, workspaceRoot),
      (err) => err instanceof SecurityError,
      `Expected symbol pointer "${badPointer}" to throw SecurityError`
    );
  }
});

test('Hash helpers: computeContentSha256 and computeSymbolSha', () => {
  const hash1 = computeContentSha256('hello world');
  const hash2 = computeContentSha256(Buffer.from('hello world', 'utf8'));
  assert.equal(hash1, hash2);
  assert.ok(SHA256_HEX.test(hash1));

  const astLf = '  function test() {\n  return true;\n}  ';
  const astCrlf = '\r\nfunction test() {\r\n  return true;\r\n}\n';
  assert.equal(computeSymbolSha(astLf), computeSymbolSha(astCrlf));
});
