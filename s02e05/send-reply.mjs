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

const messageId = process.argv[2] || '<010001a1b2c7d033-c81d0604-f736-4597-9e93-c0f4a8f8b18d-000000@email.amazonses.com>';
const replyText = process.argv[3];

if (!replyText) {
  console.error("Please provide reply text as argument 3");
  process.exit(1);
}

console.log(`Replying to ${messageId} with:\n${replyText}`);

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
  console.error(`Reply failed HTTP ${res.status}: ${errText}`);
  process.exit(1);
}

const data = await res.json();
console.log('Success:', JSON.stringify(data, null, 2));
