import fs from 'node:fs';

const file = 's02e01/sessions/stock-5-sessions/.claude/projects/-srv-ops-stock-5/e7b31c58-2d4a-4f90-8c16-9a5d03b7e2f1/subagents/agent-a91f3e07c5d28b64e.jsonl';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n').filter(Boolean);
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    const msg = obj.message;
    if (msg && msg.content) {
      if (typeof msg.content === 'string') {
        console.log(`[${obj.timestamp}] ${msg.role}: ${msg.content.slice(0, 150)}`);
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'text') {
            console.log(`[${obj.timestamp}] ${msg.role}: ${p.text.slice(0, 150)}`);
          }
        }
      }
    }
  } catch {}
}

