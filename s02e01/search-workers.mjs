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

const files = walk('s02e01/sessions/stock-5-sessions');

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  if (/02:00|four workers|workers/i.test(content)) {
    const lines = content.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (/02:00|four workers/i.test(lines[i])) {
        const o = JSON.parse(lines[i]);
        console.log(`[${path.basename(file)}] [line ${i+1}] [${o.timestamp || o.created_at || ''}]`);
        console.log(lines[i].slice(0, 300));
        console.log('---');
      }
    }
  }
}

