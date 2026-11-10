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

const STATUS_LOG = path.resolve('s02e05/status.log');
// Ensure status.log is clean
fs.writeFileSync(STATUS_LOG, '', 'utf8');

function logEvent(round, event) {
  const at = new Date().toISOString();
  const entry = { at, round, event };
  const line = JSON.stringify(entry);
  fs.appendFileSync(STATUS_LOG, line + '\n', 'utf8');
  console.log(`[STATUS LOG] ${line}`);
  return at;
}

async function pingNtfy(title, message) {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high' },
      body: message,
    });
    console.log(`[NTFY] Sent notification to ${NTFY_TOPIC}: ${title}`);
  } catch (err) {
    console.error(`[NTFY ERROR] Failed to send to ntfy: ${err.message}`);
  }
}

async function replyMessage(messageId, replyText) {
  console.log(`[REPLY] Replying to ${messageId}:\n${replyText}`);
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
  console.log(`[REPLY SUCCESS] ID: ${data.message_id || data.id}`);
  return data;
}

// Fetch all existing message IDs to ignore them
const knownMessageIds = new Set();
async function initKnownMessages() {
  const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (res.ok) {
    const data = await res.json();
    for (const m of (data.messages || [])) {
      knownMessageIds.add(m.message_id || m.id);
    }
  }
  console.log(`Initialized with ${knownMessageIds.size} existing messages.`);
}

let round1Done = false;
let round2Done = false;

// Remove any stale CODE.txt or NEED_CODE.json
if (fs.existsSync('s02e05/CODE.txt')) fs.unlinkSync('s02e05/CODE.txt');
if (fs.existsSync('s02e05/NEED_CODE.json')) fs.unlinkSync('s02e05/NEED_CODE.json');

await initKnownMessages();
console.log('Runner v2 ready and polling...');

while (!round1Done || !round2Done) {
  try {
    const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      for (const m of (data.messages || [])) {
        const id = m.message_id || m.id;
        if (knownMessageIds.has(id)) continue;
        if (m.from && m.from.includes(inboxId)) {
          knownMessageIds.add(id);
          continue;
        }

        console.log(`\n>>> NEW INCOMING MESSAGE: ${id} from ${m.from}`);
        // Fetch full message
        const fullRes = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        });
        const fullMsg = await fullRes.json();
        const body = fullMsg.text || fullMsg.extracted_text || m.preview || '';
        console.log(`Subject: ${m.subject}\nBody:\n${body}\n`);

        knownMessageIds.add(id);
        fs.writeFileSync(path.resolve(`s02e05/msg-${Date.now()}.json`), JSON.stringify(fullMsg, null, 2), 'utf8');

        if (!round1Done) {
          // Round 1: Message before window
          logEvent(1, 'received');
          console.log('[ROUND 1] Answering check-in...');
          await replyMessage(id, 'im up');
          logEvent(1, 'replied');
          round1Done = true;
          console.log('>>> ROUND 1 COMPLETE <<<\n');
        } else if (!round2Done) {
          // Round 2: Message inside window with asks
          logEvent(2, 'received');
          const foundFree = FREE_ACTS.filter((a) => body.includes(a));
          const foundGated = GATED_ACTS.filter((a) => body.includes(a));

          console.log(`[ROUND 2] Detected free acts: ${foundFree.join(', ') || 'none'}`);
          console.log(`[ROUND 2] Detected gated acts: ${foundGated.join(', ') || 'none'}`);

          if (foundGated.length > 0) {
            await pingNtfy('GATED ACT APPROVAL REQUIRED', `Gated acts: ${foundGated.join(', ')}\n${body}`);
            logEvent(2, 'notified');
          }

          // Initial reply: one line per ask
          const lines = [];
          for (const a of foundFree) lines.push(`DONE: ${a}`);
          for (const a of foundGated) lines.push(`HOLD: ${a}`);

          console.log(`[ROUND 2] Sending initial reply...`);
          await replyMessage(id, lines.join('\n'));
          logEvent(2, 'replied');

          if (foundGated.length > 0) {
            // Signal coordinator that code is needed
            fs.writeFileSync(path.resolve('s02e05/NEED_CODE.json'), JSON.stringify({
              messageId: id,
              threadId: m.thread_id,
              gated: foundGated,
              time: new Date().toISOString()
            }, null, 2), 'utf8');

            console.log('[ROUND 2] Waiting for s02e05/CODE.txt...');
            let code = null;
            while (!code) {
              if (fs.existsSync('s02e05/CODE.txt')) {
                const c = fs.readFileSync('s02e05/CODE.txt', 'utf8').trim();
                if (c) code = c;
              }
              if (!code) await new Promise((r) => setTimeout(r, 500));
            }

            console.log(`[ROUND 2] Got code: ${code}`);
            logEvent(2, 'owner_answered');

            // Send release reply
            const releaseLines = foundGated.map((a) => `DONE: ${a} CODE: ${code}`);
            console.log(`[ROUND 2] Sending release reply...`);
            await replyMessage(id, releaseLines.join('\n'));
            logEvent(2, 'replied');
          }

          round2Done = true;
          console.log('>>> ROUND 2 COMPLETE <<<\n');
          break;
        }
      }
    }
  } catch (err) {
    console.error(`Runner error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log('ALL ROUNDS FINISHED! Final status log:');
console.log(fs.readFileSync(STATUS_LOG, 'utf8'));
