import fs from 'node:fs';

const lines = fs.readFileSync('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/30/rollout-2026-10-30T15-31-40-019a35d2-7c41-7e08-a3f1-5b9e2d6c4a10.jsonl', 'utf-8').split('\n').filter(Boolean);

for (let i = 110; i < 150 && i < lines.length; i++) {
  const o = JSON.parse(lines[i]);
  console.log(`[Line ${i+1}] [${o.timestamp}] type=${o.type} payloadType=${o.payload?.type}`);
  if (o.payload?.name === 'shell' || o.payload?.command) {
    console.log(JSON.stringify(o.payload));
  }
  if (o.payload?.message || o.payload?.content) {
    console.log(JSON.stringify(o.payload.message || o.payload.content));
  }
}

