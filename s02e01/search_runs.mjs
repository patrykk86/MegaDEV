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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('02:00') || line.includes('four workers') || line.includes('Runs') || line.includes('nightly 02:00')) {
      const obj = JSON.parse(line);
      console.log('FILE:', path.basename(file), 'INDEX:', i);
      console.log('TIME:', obj.timestamp);
      // check if it is user message or assistant message
      console.log('TEXT:', line.slice(0, 300));
    }
  }
}

