import crypto from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';

const PING_KEY_STR = 'whsec_6OVrIWmQ6iyLl+UOHNWtLFZCyDyVt7slAxcYtfhs8Oo=';
const PING_KEY_BYTES = Buffer.from(PING_KEY_STR.replace(/^whsec_/, ''), 'base64');

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
  return { status: resp.status, body: await resp.text() };
}

export const pulse = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).json({ ok: true, agent: 'pulse' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const id = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signature = req.headers['webhook-signature'];
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : req.rawBody?.toString('utf8') ?? JSON.stringify(req.body);

  const isValid = verifySignature(id, timestamp, rawBody, signature);
  if (!isValid) {
    console.warn(`[pulse] Invalid signature for id: ${id}`);
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  const payload = req.body;
  console.log(`[pulse] Received ${payload?.kind} ping:`, payload);

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
        console.log(`[pulse] Replied to pulse at ${payload.reply}: status ${replyRes.status}`);
      } catch (err) {
        console.error('[pulse] Error posting pulse reply:', err);
      }
    }

    res.status(200).json({ ok: true, answered: 'pulse' });
    return;
  }

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

    if (payload.reply) {
      try {
        const replyRes = await postJson(payload.reply, {
          path: 'test/missing-owner.test.ts',
          test: testSource,
          red: redReason,
        });
        console.log(`[pulse] Replied to test at ${payload.reply}: status ${replyRes.status}`);
      } catch (err) {
        console.error('[pulse] Error posting test reply:', err);
      }
    }

    res.status(200).json({ ok: true, answered: 'test' });
    return;
  }

  res.status(200).json({ ok: true, ignored: payload?.kind });
});

