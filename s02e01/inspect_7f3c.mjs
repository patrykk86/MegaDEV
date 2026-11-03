import fs from 'node:fs';

const file = 's02e01/sessions/stock-5-sessions/.claude/projects/-home-build-stock-5/7f3c2a91-4e5b-4d1a-9b8e-2c6d0f1a3b57.jsonl';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n').filter(Boolean);
for (let i = 0; i < lines.length; i++) {
  try {
    const obj = JSON.parse(lines[i]);
    if (obj.type === 'user' || (obj.type === 'assistant' && !lines[i].includes('"tool_use"'))) {
      const msg = obj.message;
      let text = '';
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) text = msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
      if (text) {
        console.log(`[${i}] ${obj.timestamp} (${msg.role}): ${text}`);
      }
    }
  } catch {}
}

