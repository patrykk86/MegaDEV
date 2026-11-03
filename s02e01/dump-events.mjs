import fs from 'node:fs';

function showEvents(f) {
  console.log('=== ' + f + ' ===');
  const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o.type === 'event_msg') {
      console.log(`[${o.timestamp}] ${JSON.stringify(o.payload)}`);
    }
  }
}

showEvents('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/31/rollout-2026-10-31T10-15-30-11e58d3b-f53e-400b-a860-133371967557.jsonl');
showEvents('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/28/rollout-2026-10-28T09-40-12-6aab86ac-3a96-49de-a696-cfbbf066cea8.jsonl');
showEvents('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/30/rollout-2026-10-30T15-31-40-019a35d2-7c41-7e08-a3f1-5b9e2d6c4a10.jsonl');

