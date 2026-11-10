import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}
loadEnv();

const inboxId = process.env.AGENTMAIL_INBOX;
const apiKey = process.env.AGENTMAIL_API_KEY;
const NTFY_TOPIC = 'megadev';

const FREE_ACTS = ['purge_cache', 'archive_report'];
const GATED_ACTS = ['post_status', 'ack_alert', 'release_hold', 'rotate_key'];

const knownMessageIds = new Set([
  '<010001a1b2bb094d-46a58522-5e3e-42ec-be2d-13bfd451d6ae-000000@email.amazonses.com>',
  '<010001a1b2b8469c-beac3fd1-490d-49a3-9745-afb22b686c96-000000@email.amazonses.com>',
  '<010001a1a3388463-cfc8ee08-0173-4aaf-97a9-d08236eb3740-000000@email.amazonses.com>',
  '<010001a1a3378bb1-b212574a-4292-4afa-a202-cdb0efb96f11-000000@email.amazonses.com>',
  '<010001a1a3376f9e-6b1de21e-8b99-4afe-8fc5-273faf183204-000000@email.amazonses.com>',
  '<010001a1a3375a1b-23dad27e-f4d3-47c8-9af0-d66826a38b2c-000000@email.amazonses.com>',
  '<010001a1a33744c1-7ad234a2-862b-4fa6-8f40-8196ba828607-000000@email.amazonses.com>',
]);

async function pingNtfy(title, message) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
      },
      body: message,
    });
    console.log(`[NTFY] Sent notification to ${NTFY_TOPIC}: ${title}`);
  } catch (err) {
    console.error(`[NTFY ERROR] Failed to send to ntfy: ${err.message}`);
  }
}

async function replyMessage(messageId, replyText) {
  console.log(`[REPLY] Replying to ${messageId}: "${replyText}"`);
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: replyText }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Reply failed HTTP ${res.status}: ${errText}`);
  }
  const data = await res.json();
  console.log(`[REPLY SUCCESS]`, data);
  return data;
}

async function checkInboxOnce() {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const msgs = data.messages || [];
  
  for (const m of msgs) {
    const id = m.message_id || m.id;
    if (knownMessageIds.has(id)) continue;
    if (m.from && m.from.includes(inboxId)) {
      knownMessageIds.add(id);
      continue;
    }

    console.log(`\n=== NEW MESSAGE RECEIVED ===`);
    console.log(`From: ${m.from}`);
    console.log(`Subject: ${m.subject}`);
    console.log(`Preview: ${m.preview}`);
    console.log(`Message ID: ${id}`);
    console.log(`Thread ID: ${m.thread_id}`);

    // Fetch full message
    const fullRes = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const fullMsg = await fullRes.json();
    const body = fullMsg.text || fullMsg.extracted_text || m.preview || '';
    console.log(`Full Body:\n${body}\n============================\n`);

    knownMessageIds.add(id);

    // Save message to disk for evidence
    fs.writeFileSync(path.resolve(`s02e05/incoming-${Date.now()}.json`), JSON.stringify(fullMsg, null, 2), 'utf8');

    // Detect action
    let detectedAct = null;
    for (const act of [...FREE_ACTS, ...GATED_ACTS]) {
      if (body.includes(act)) {
        detectedAct = act;
        break;
      }
    }

    console.log(`Detected act: ${detectedAct}`);

    if (FREE_ACTS.includes(detectedAct)) {
      console.log(`Act ${detectedAct} is FREE per policy! Replying done...`);
      await replyMessage(id, `Done. ${detectedAct} completed.`);
    } else if (GATED_ACTS.includes(detectedAct)) {
      console.log(`Act ${detectedAct} is GATED per policy! Pinging phone via ntfy...`);
      await pingNtfy(`GATED ACT: ${detectedAct}`, `A gated act was requested by Rook/Scout:\n${body}\nNeed human code/approval!`);
      // Also write alert to file
      fs.writeFileSync(path.resolve('s02e05/PENDING_APPROVAL.json'), JSON.stringify({
        messageId: id,
        threadId: m.thread_id,
        body,
        detectedAct,
        timestamp: new Date().toISOString()
      }, null, 2), 'utf8');
    } else {
      console.log(`Unknown act or general message. Sending ntfy ping...`);
      await pingNtfy(`New Message from ${m.from}`, body);
    }
  }
}

console.log(`Polling AgentMail inbox ${inboxId}...`);
while (true) {
  try {
    await checkInboxOnce();
  } catch (err) {
    console.error(`Polling error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 4000));
}
