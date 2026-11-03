#!/usr/bin/env node
/**
 * tools/gateway/dispatcher.mjs - Outbound Multi-Channel Message & Alert Dispatcher
 *
 * Implements Step 2 & Step 3 of Task 3:
 * - Wires daily digests (Thread 1), reflections (Thread 2), and system alerts into outbound channels.
 * - Routes to Telegram Bot Gateway (Channel A) and HMAC-signed Webhook (Channel B).
 * - Enforces outbound secret scrubbing (redactOutbound) and anti-replay HMAC headers.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redactOutbound } from '../sanitize.mjs';

/**
 * Creates an anti-replay HMAC-SHA256 signature header for outbound webhook delivery.
 *
 * @param {string} payload - JSON stringified body
 * @param {string} secret - Shared webhook secret
 * @param {number} [timestamp] - Current timestamp in seconds
 * @returns {{ signatureHeader: string, hubSignatureHeader: string, timestamp: number }}
 */
export function createWebhookSignature(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  if (typeof payload !== 'string') {
    throw new TypeError('Webhook payload must be a JSON string');
  }
  const cleanSecret = String(secret || '').trim();
  if (cleanSecret.length < 16) {
    throw new Error('Webhook secret must be at least 16 characters long');
  }
  const safeTimestamp = Math.floor(Number(timestamp));
  if (!Number.isFinite(safeTimestamp) || safeTimestamp <= 0) {
    throw new TypeError('Timestamp must be a positive finite integer');
  }
  const signedPayload = `${safeTimestamp}.${payload}`;
  const hmac = crypto.createHmac('sha256', cleanSecret);
  hmac.update(signedPayload, 'utf8');
  const sigHex = hmac.digest('hex');

  return {
    signatureHeader: `t=${safeTimestamp},v1=${sigHex}`,
    hubSignatureHeader: `sha256=${sigHex}`,
    timestamp: safeTimestamp,
  };
}

/**
 * Outbound Dispatcher coordinating delivery across channels.
 */
export class OutboundDispatcher {
  /**
   * @param {Object} options
   * @param {Object} [options.telegramBot]
   * @param {string} [options.webhookUrl]
   * @param {string} [options.webhookSecret]
   * @param {Function} [options.fetchFn]
   * @param {Function} [options.logFn]
   */
  constructor(options = {}) {
    this.telegramBot = options.telegramBot || null;
    this.webhookUrl = options.webhookUrl || process.env.OUTBOUND_WEBHOOK_URL || null;
    this.webhookSecret = options.webhookSecret || process.env.OUTBOUND_WEBHOOK_SECRET || null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.logFn = options.logFn || console.log;
  }

  /**
   * Dispatches event to Telegram channel.
   */
  async dispatchToTelegram(event, safeTitle, safeBody, priority, metadata) {
    if (!this.telegramBot) {
      return null;
    }
    try {
      if (event.type === 'digest' || event.type === 'reflection') {
        const sections = metadata.sections || [{ heading: safeTitle, content: safeBody }];
        const res = await this.telegramBot.sendDailyDigest({
          title: safeTitle,
          summary: safeBody,
          sections,
        });
        return { ok: true, result: res };
      }
      const res = await this.telegramBot.sendOutboundAlert({
        title: safeTitle,
        body: safeBody,
        priority,
        metadata,
      });
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Dispatches event to HMAC-signed Webhook channel.
   */
  async dispatchToWebhook(event, safeTitle, safeBody, priority, metadata) {
    if (!this.webhookUrl || !this.webhookSecret) {
      return null;
    }
    try {
      const safeMetadata = metadata ? JSON.parse(redactOutbound(JSON.stringify(metadata))) : null;
      const payloadObj = {
        event_type: event.type,
        title: safeTitle,
        body: safeBody,
        priority,
        metadata: safeMetadata,
        dispatched_at: new Date().toISOString(),
      };
      const payloadStr = JSON.stringify(payloadObj);
      const sig = createWebhookSignature(payloadStr, this.webhookSecret);

      const resp = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': sig.signatureHeader,
          'X-Hub-Signature-256': sig.hubSignatureHeader,
        },
        body: payloadStr,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return { ok: false, status: resp.status, error: redactOutbound(errText) };
      }
      const data = await resp.json().catch(() => ({}));
      return { ok: true, status: resp.status, response: data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Dispatches an outbound notification to all configured channels.
   *
   * @param {Object} event
   * @param {string} event.type - 'alert' | 'digest' | 'reflection' | 'audit'
   * @param {string} event.title - Message title
   * @param {string} event.body - Main content body
   * @param {string} [event.priority] - 'high' | 'normal' | 'low'
   * @param {Object} [event.metadata] - Extra key/value metadata
   * @param {string[]} [event.channels] - Explicit channels: ['telegram', 'webhook']
   */
  async dispatch(event) {
    const safeTitle = redactOutbound(String(event.title || 'Notification'));
    const safeBody = redactOutbound(String(event.body || ''));
    const priority = event.priority || 'normal';
    const metadata = event.metadata || {};
    const targetChannels = event.channels || ['telegram', 'webhook'];

    const outcomes = {
      timestamp: new Date().toISOString(),
      type: event.type,
      title: safeTitle,
      channels: {},
    };

    if (targetChannels.includes('telegram')) {
      const tgRes = await this.dispatchToTelegram(event, safeTitle, safeBody, priority, metadata);
      if (tgRes) {
        outcomes.channels.telegram = tgRes;
      }
    }

    if (targetChannels.includes('webhook')) {
      const whRes = await this.dispatchToWebhook(event, safeTitle, safeBody, priority, metadata);
      if (whRes) {
        outcomes.channels.webhook = whRes;
      }
    }

    return outcomes;
  }

  /**
   * Dispatches Thread 1 daily digest.
   */
  async dispatchDailyDigest(digest) {
    return this.dispatch({
      type: 'digest',
      title: digest.title || 'Daily Digest',
      body: digest.summary || '',
      priority: 'normal',
      metadata: {
        date: digest.date || new Date().toISOString().slice(0, 10),
        sections: digest.sections || [],
      },
    });
  }

  /**
   * Dispatches Thread 2 Lamarckian architectural reflection.
   */
  async dispatchReflection(reflection) {
    return this.dispatch({
      type: 'reflection',
      title: `Architectural Reflection: ${reflection.sessionId || 'Latest'}`,
      body: reflection.insights || reflection.summary || '',
      priority: 'normal',
      metadata: {
        sessionId: reflection.sessionId,
        metrics: reflection.metrics || {},
      },
    });
  }

  /**
   * Dispatches nightly workspace audit report outcome.
   */
  async dispatchAuditResult(audit) {
    const passed = Boolean(audit.passed);
    return this.dispatch({
      type: 'audit',
      title: `Nightly Audit ${passed ? 'PASSED' : 'FAILED'} (${audit.auditId})`,
      body: passed
        ? 'All static analysis, hygiene scans, and guardrails passed cleanly.'
        : `Failures detected in workspace static checks. Please inspect report at ${audit.reportPath || 'latest'}.`,
      priority: passed ? 'normal' : 'high',
      metadata: {
        auditId: audit.auditId,
        passed,
      },
    });
  }
}

/**
 * CLI runner for dispatcher.
 */
function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(
      [
        'Usage:',
        '  node tools/gateway/dispatcher.mjs --event <alert|digest|audit> --title "<title>" --body "<body>" [--priority high|normal]',
        '  node tools/gateway/dispatcher.mjs --audit-file <path>',
      ].join('\n'),
    );
    return 0;
  }

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  };

  const dispatcher = new OutboundDispatcher();

  const auditFile = getArg('--audit-file');
  if (auditFile) {
    if (!fs.existsSync(auditFile)) {
      console.error(`Audit file not found: ${auditFile}`);
      return 1;
    }
    const data = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
    dispatcher.dispatchAuditResult(data).then((res) => {
      console.log(JSON.stringify(res, null, 2));
    });
    return 0;
  }

  const event = getArg('--event') || 'alert';
  const title = getArg('--title') || 'CLI Alert';
  const body = getArg('--body') || '';
  const priority = getArg('--priority') || 'normal';

  dispatcher
    .dispatch({ type: event, title, body, priority })
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error(`Dispatch error: ${err.message}`);
      process.exit(1);
    });

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv);
}
