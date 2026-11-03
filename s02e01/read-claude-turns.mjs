import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  let res = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) res = res.concat(walk(full));
    else if (f.name.endsWith('.jsonl')) res.push(full);
  }
  return res;
}

const files = walk('s02e01/sessions/stock-5-sessions/.claude');

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  const sessionId = path.basename(file, '.jsonl');
  console.log(`\n=================== CLAUDE SESSION: ${sessionId} (${file}) ===================`);
  
  for (let i = 0; i < lines.length; i++) {
    const o = JSON.parse(lines[i]);
    const ts = o.timestamp || o.created_at || '';
    if (o.type === 'user') {
      const msg = typeof o.message?.content === 'string' ? o.message.content : JSON.stringify(o.message?.content);
      console.log(`[USER ${ts}]: ${msg.slice(0, 300)}`);
    } else if (o.type === 'assistant') {
      const content = o.message?.content;
      if (typeof content === 'string') {
        console.log(`[ASSISTANT ${ts}]: ${content.slice(0, 300)}`);
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') {
            console.log(`[ASSISTANT ${ts}]: ${c.text.slice(0, 300)}`);
          }
        }
      }
    }
  }
}

