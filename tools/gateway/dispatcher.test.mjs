/**
 * @fileoverview Unit tests for tools/gateway/dispatcher.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { OutboundDispatcher, createWebhookSignature } from './dispatcher.mjs';

test('createWebhookSignature: produces valid HMAC-SHA256 headers with anti-replay timestamp', () => {
  const secret = 'super-secret-key-12345';
  const payload = JSON.stringify({ message: 'hello' });
  const timestamp = 1700000000;

  const sig = createWebhookSignature(payload, secret, timestamp);
  assert.ok(sig.signatureHeader.startsWith(`t=${timestamp},v1=`));
  assert.ok(sig.hubSignatureHeader.startsWith('sha256='));

  // Verify HMAC calculation matches expected sha256 digest
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  assert.equal(sig.signatureHeader, `t=${timestamp},v1=${expectedHmac}`);
  assert.equal(sig.hubSignatureHeader, `sha256=${expectedHmac}`);
});

test('createWebhookSignature: throws on missing or short secret', () => {
  assert.throws(() => createWebhookSignature('{}', ''), /at least 16 characters/);
  assert.throws(() => createWebhookSignature('{}', '   '), /at least 16 characters/);
  assert.throws(() => createWebhookSignature('{}', 'short-secret'), /at least 16 characters/);
  assert.throws(() => createWebhookSignature({}, 'secret-longer-than-16-bytes'), /payload must be a JSON string/);
});

test('OutboundDispatcher: dispatches across Telegram and Webhook channels with redaction', async () => {
  const telegramCalls = [];
  const mockTelegram = {
    sendOutboundAlert: async (data) => {
      telegramCalls.push(data);
      return { ok: true, messageId: 1 };
    },
    sendDailyDigest: async (data) => {
      telegramCalls.push(data);
      return { ok: true, messageId: 2 };
    },
  };

  const webhookCalls = [];
  const mockFetch = async (url, options) => {
    webhookCalls.push({
      url,
      headers: options.headers,
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'received' }),
    };
  };

  const dispatcher = new OutboundDispatcher({
    telegramBot: mockTelegram,
    webhookUrl: 'https://biocore.example.com/api/v1/channel/outbound',
    webhookSecret: 'sample-secret-length-exceeds-16-bytes',
    fetchFn: mockFetch,
  });

  // Dispatch an alert containing a secret that must be redacted
  const event = {
    type: 'alert',
    title: 'Cluster Status',
    body: 'Database healthy. Token: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9. Key: 12345678-1234-1234-1234-123456789abc',
    priority: 'high',
    metadata: { env: 'prod' },
  };

  const outcome = await dispatcher.dispatch(event);

  assert.equal(outcome.channels.telegram.ok, true);
  assert.equal(outcome.channels.webhook.ok, true);

  // Check Telegram redaction
  assert.equal(telegramCalls.length, 1);
  assert.ok(!telegramCalls[0].body.includes('eyJhbGciOiJIUzI1Ni'));
  assert.ok(telegramCalls[0].body.includes('[REDACTED_TOKEN]'));
  assert.ok(telegramCalls[0].body.includes('[REDACTED_UUID]'));

  // Check Webhook signature & headers
  assert.equal(webhookCalls.length, 1);
  const sentHeaders = webhookCalls[0].headers;
  assert.ok(sentHeaders['X-Webhook-Signature'].includes('t='));
  assert.ok(sentHeaders['X-Hub-Signature-256'].startsWith('sha256='));
  assert.ok(!webhookCalls[0].body.body.includes('eyJhbGciOiJIUzI1Ni'));
  assert.ok(webhookCalls[0].body.body.includes('[REDACTED_TOKEN]'));
});

test('OutboundDispatcher: convenience dispatchers (daily digest, reflection, audit)', async () => {
  const telegramCalls = [];
  const mockTelegram = {
    sendDailyDigest: async (data) => {
      telegramCalls.push(data);
      return { ok: true };
    },
    sendOutboundAlert: async (data) => {
      telegramCalls.push(data);
      return { ok: true };
    },
  };

  const dispatcher = new OutboundDispatcher({
    telegramBot: mockTelegram,
  });

  // Daily digest
  await dispatcher.dispatchDailyDigest({
    title: 'Thread 1 Daily Digest',
    summary: 'Correlations computed for 15 patients.',
    sections: [{ heading: 'Labs', content: 'All values within range.' }],
  });
  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].title, 'Thread 1 Daily Digest');

  // Architectural reflection
  await dispatcher.dispatchReflection({
    sessionId: 'session-20261103',
    summary: 'Lamarckian memory evolution added 2 invariant rules.',
  });
  assert.equal(telegramCalls.length, 2);
  assert.ok(telegramCalls[1].title.includes('Architectural Reflection'));

  // Nightly audit
  await dispatcher.dispatchAuditResult({
    auditId: 'audit-001',
    passed: true,
    reportPath: '/runs/audits/audit-001/report.md',
  });
  assert.equal(telegramCalls.length, 3);
  assert.ok(telegramCalls[2].title.includes('PASSED'));
});
