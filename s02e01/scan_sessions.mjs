import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  let res = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) res.push(...walk(full));
    else if (ent.name.endsWith('.jsonl')) res.push(full);
  }
  return res;
}

const files = walk('s02e01/sessions/stock-5-sessions');

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  console.log('====================================');
  console.log('FILE:', path.basename(file), 'FULL:', file);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Claude format
      if (obj.message) {
        const text = typeof obj.message.content === 'string' ? obj.message.content : (Array.isArray(obj.message.content) ? obj.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
        if (text && (obj.type === 'user' || (obj.type === 'assistant' && !line.includes('"tool_use"')))) {
          console.log(`[${obj.timestamp}] ${obj.message.role}: ${text.slice(0, 160)}`);
        }
      }
      // Codex format
      if (obj.type === 'response_item' && obj.payload) {
        if (obj.payload.type === 'message') {
          const text = obj.payload.content?.map(c => c.text).join(' ');
          if (text) {
            console.log(`[${obj.timestamp}] codex ${obj.payload.role}: ${text.slice(0, 160)}`);
          }
        }
      }
    } catch {}
  }
}

