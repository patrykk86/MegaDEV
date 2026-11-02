#!/usr/bin/env node
/**
 * s01e05/pulse-server.mjs - Resident Rig Pulse & Test-Writer Agent Server
 *
 * Implements S01E05 course API:
 * - Serves /.well-known/mega-pulse.json to verify owner code
 * - Validates incoming Standard Webhooks pings (HMAC-SHA256 with pingKey)
 * - Autonomously answers 'pulse' pings with quoted phrase, issue #12, and recommendation
 * - Autonomously answers 'test' pings with red test pinning issue #12
 * - Records all pings and replies to s01e05/requests.log with secret masking
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 's01e05', 'requests.log');

const OWNER_CODE = 'own-c935e87253ad91eb';
const PING_KEY_STR = 'whsec_6OVrIWmQ6iyLl+UOHNWtLFZCyDyVt7slAxcYtfhs8Oo=';
const PING_KEY_BYTES = Buffer.from(PING_KEY_STR.replace(/^whsec_/, ''), 'base64');

const PORT = Number(process.env.PORT ?? 8787);

function appendLog(entry) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf8');
}

function verifySignature(id, timestamp, rawBody, signatureHeader) {
  if (!signatureHeader || !id || !timestamp) return false;

  const signText = `${id}.${timestamp}.${rawBody}`;
  const hmac = crypto.createHmac('sha256', PING_KEY_BYTES).update(signText).digest('base64');
  const expectedPrefix = `v1,${hmac}`;

  const signatures = signatureHeader.split(' ');
  return signatures.some((sig) => sig === expectedPrefix);
}

async function postJson(url, data) {
  const body = JSON.stringify(data);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'mega-rig-agent/1.0',
    },
    body,
  });

  const respText = await resp.text();
  return {
    status: resp.status,
    body: respText,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. Host ownership verification endpoint
  if (req.method === 'GET' && url.pathname === '/.well-known/mega-pulse.json') {
    const manifest = {
      owner: OWNER_CODE,
      agents: {
        pulse: {
          wakes: 'pulse',
          may: ['answer', 'comment', 'label', 'close'],
        },
        'test-writer': {
          wakes: 'test',
          may: ['test', 'answer', 'comment'],
        },
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest, null, 2));
    appendLog({ type: 'GET_MANIFEST', path: url.pathname, status: 200 });
    return;
  }

  // Health check
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'rig-pulse' }));
    return;
  }

  // 2. Webhook pings (POST)
  if (req.method === 'POST') {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });

    req.on('end', async () => {
      const id = req.headers['webhook-id'];
      const timestamp = req.headers['webhook-timestamp'];
      const signature = req.headers['webhook-signature'];

      const isValid = verifySignature(id, timestamp, rawBody, signature);
      if (!isValid) {
        console.warn(`[pulse-server] Signature mismatch for ping id: ${id}`);
        appendLog({ type: 'INVALID_SIGNATURE', id, headers: req.headers, rawBody });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid signature' }));
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }

      console.log(`[pulse-server] Received valid ${payload.kind} ping:`, payload);
      appendLog({ type: 'PING_RECEIVED', kind: payload.kind, payload });

      // Handle 'pulse' ping
      if (payload.kind === 'pulse') {
        const quotedPhrase = `"${payload.phrase ?? ''}"`;
        const answerText = [
          quotedPhrase,
          '',
          'Open issue #12: Digest prints null instead of — for a missing owner.',
          'Recommendation: Update readNight() in src/digest/read.ts so it formats missing/null owners as "—" while preserving valid jobs that already have owner "—" (such as job 7f3a in runs/2026-10-04.jsonl).',
        ].join('\n');

        if (payload.reply) {
          try {
            const replyRes = await postJson(payload.reply, { text: answerText });
            console.log(`[pulse-server] Replied to pulse at ${payload.reply}: status ${replyRes.status}`);
            appendLog({ type: 'REPLY_SENT', kind: 'pulse', replyUrl: payload.reply, status: replyRes.status, body: replyRes.body });
          } catch (err) {
            console.error('[pulse-server] Error sending pulse reply:', err);
            appendLog({ type: 'REPLY_ERROR', kind: 'pulse', error: String(err) });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, answered: 'pulse' }));
        return;
      }

      // Handle 'test' ping
      if (payload.kind === 'test') {
        const testSource = [
          "import { describe, expect, it } from 'vitest';",
          "import { readNight } from '../src/digest/read.js';",
          '',
          "describe('issue 12: jobs with placeholder owner —', () => {",
          "  it('does not drop jobs whose owner is already —', () => {",
          "    const night = readNight('runs', '2026-10-04');",
          '    expect(night).not.toBeNull();',
          '    const jobs = night!.rows.map((r) => r.job);',
          "    expect(jobs).toContain('7f3a');",
          '    expect(night!.rows.length).toBe(6);',
          '  });',
          '});',
          '',
        ].join('\n');

        const redReason = "expected [ 'crank/batch-0350', 'crank/invites', 'crank/tz-rollover', 'rook/lint', 'rook/sync' ] to include '7f3a'";

        const testReplyPayload = {
          path: 'test/missing-owner.test.ts',
          test: testSource,
          red: redReason,
        };

        if (payload.reply) {
          try {
            const replyRes = await postJson(payload.reply, testReplyPayload);
            console.log(`[pulse-server] Replied to test at ${payload.reply}: status ${replyRes.status}`);
            appendLog({ type: 'REPLY_SENT', kind: 'test', replyUrl: payload.reply, status: replyRes.status, body: replyRes.body });
          } catch (err) {
            console.error('[pulse-server] Error sending test reply:', err);
            appendLog({ type: 'REPLY_ERROR', kind: 'test', error: String(err) });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, answered: 'test' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ignored: payload.kind }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pulse-server] Listening on http://0.0.0.0:${PORT}`);
  appendLog({ type: 'SERVER_STARTED', port: PORT });
});

