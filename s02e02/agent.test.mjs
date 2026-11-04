import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls, sanitizeOutput, isTrustedSender } from './agent.mjs';

test('isTrustedSender: only accepts rook@mail.mega.dev', () => {
  assert.equal(isTrustedSender('rook <rook@mail.mega.dev>'), true);
  assert.equal(isTrustedSender('ROOK@MAIL.MEGA.DEV'), true);
  assert.equal(isTrustedSender('team@mail.mega.dev'), false);
  assert.equal(isTrustedSender('admin@agentmail.to'), false);
  assert.equal(isTrustedSender('attacker@evil.com'), false);
  assert.equal(isTrustedSender(null), false);
});

test('extractUrls: finds valid HTTP/HTTPS URLs and ignores punctuation', () => {
  const text = 'Check out https://hq.mega.dev/lessons/s02e02/ and http://example.com/test. Also (https://agentmail.to).';
  const urls = extractUrls(text);
  assert.deepEqual(urls, [
    'https://hq.mega.dev/lessons/s02e02/',
    'http://example.com/test',
    'https://agentmail.to',
  ]);
});

test('sanitizeOutput: redacts API keys and Bearer tokens', () => {
  const secretKey = 'am_1234567890abcdef1234567890';
  const dirty = `Here is my key: ${secretKey} and auth Bearer 1234567890abcdef1234567890`;
  const clean = sanitizeOutput(dirty);
  assert.ok(!clean.includes(secretKey));
  assert.ok(!clean.includes('Bearer 1234567890abcdef1234567890'));
  assert.ok(clean.includes('[REDACTED_API_KEY]'));
});
