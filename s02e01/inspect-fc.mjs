import fs from 'node:fs';

const lines = fs.readFileSync('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/30/rollout-2026-10-30T15-31-40-019a35d2-7c41-7e08-a3f1-5b9e2d6c4a10.jsonl', 'utf-8').split('\n').filter(Boolean);

for (const l of lines) {
  const o = JSON.parse(l);
  if (o.type === 'response_item' && o.payload?.type === 'function_call') {
    const p = o.payload;
    console.log(`[${o.timestamp}] ${p.name}:`);
    console.log(p.arguments);
    console.log('---');
  }
}

