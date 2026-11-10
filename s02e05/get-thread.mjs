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

const threadId = process.argv[2] || 'b17787d3-3e60-4e67-8474-d1d173abca39';
const res = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}`, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  },
});

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
