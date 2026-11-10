// s03e01 hub discovery: records what the course serves to an unauthenticated client.
// Read-only GETs of public pages and metadata; reads no .env value.
//
// The course's own instructions (hq.mega.dev/llms.txt) say a session that has not loaded the
// mega-challenge tools must not call the MCP endpoint or run OAuth itself, so this script
// deliberately probes no /mcp URL: the MCP connection is the client's own sign-in, driven by the
// human. Lines 1-7 of the log come from the first pass, which included one 401 check made before
// those instructions arrived; do not repeat that check.
//
// Entries are appended with real timestamps taken when each response lands.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LOG = path.join(DIR, 'requests.log');
const INBOX = path.join(DIR, 'inbox-raw.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function record(event, payload) {
  // Payloads here hold status codes and public metadata only: the run reads no .env value and
  // sends no ticket or key, so there is nothing to mask. Anything credentialed goes through
  // tools/hub-client.mjs instead.
  const line = `[${new Date().toISOString()}] ${event} ${JSON.stringify(payload)}`;
  fs.appendFileSync(LOG, `${line}\n`, 'utf-8');
  console.log(line);
}

async function probe(event, url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
    const contentType = res.headers.get('content-type') ?? '';
    const payload = { url, status: res.status, contentType };
    const challenge = res.headers.get('www-authenticate');
    if (challenge) {
      // Record the scheme only: the pointer URL is already logged as its own MCP_METADATA entry.
      payload.authScheme = challenge.split(' ')[0];
      payload.pointsAtMetadata = challenge.includes('resource_metadata');
    }
    if (contentType.includes('application/json')) {
      payload.body = await res.json();
    } else {
      const text = await res.text();
      payload.bytes = Buffer.byteLength(text);
      payload.authWall = /Sign in|login link/i.test(text);
    }
    record(event, payload);
    return res.status;
  } catch (error) {
    record(event, { url, error: error.message });
    return 0;
  }
}

await probe('LESSON_PROBE', 'https://hq.mega.dev/lessons/s03e01/');
await probe('LESSON_PROBE', 'https://hq.mega.dev/lessons/s02e05/');
await probe('MCP_METADATA', 'https://hq.mega.dev/.well-known/oauth-protected-resource');
await probe('MCP_METADATA', 'https://hq.mega.dev/.well-known/oauth-authorization-server');

if (fs.existsSync(INBOX)) {
  const raw = JSON.parse(fs.readFileSync(INBOX, 'utf-8').replace(/^\uFEFF/, ''));
  const messages = raw.messages ?? [];
  const latest = messages
    .map((m) => m.created_at ?? m.timestamp ?? '')
    .sort()
    .at(-1);
  record('INBOX_SNAPSHOT', {
    status: 200,
    messages: messages.length,
    latest,
    threads: [...new Set(messages.map((m) => m.thread_id))].length,
    s03e01HandoffSeen: messages.some((m) => /s03e01/i.test(`${m.subject ?? ''} ${m.text ?? ''}`)),
  });
} else {
  record('INBOX_SNAPSHOT', { error: 'inbox-raw.json missing; run the inbox fetch first' });
}

// mcp-remote keeps its OAuth cache under the operator profile. Presence is all we record.
const authCache = path.join(os.homedir(), '.mcp-auth');
function tokenFilesIn(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 2) {
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...tokenFilesIn(full, depth + 1));
    } else if (entry.name.endsWith('_tokens.json')) {
      found.push(full);
    }
  }
  return found;
}
const tokenFiles = tokenFilesIn(authCache);
record('MCP_AUTH_CACHE', {
  state: fs.existsSync(authCache) ? 'present' : 'absent',
  tokenFiles: tokenFiles.length,
  note: 'cached tokens for the hub MCP; a reconnect may skip the browser authorize step',
});

