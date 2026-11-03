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
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/drizzle|02:00|four workers|job store|runs/i.test(l)) {
      const o = JSON.parse(l);
      const ts = o.timestamp || o.created_at || '';
      console.log(`[${sessionId}] [line ${i+1}] [${ts}] type=${o.type}`);
      // Look for text in message
      const text = typeof o.message?.content === 'string' ? o.message.content : JSON.stringify(o.message?.content);
      if (text) {
        console.log(text.slice(0, 300));
        console.log('---');
      }
    }
  }
}

