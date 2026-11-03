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
    // check user or assistant text specifically
    if (/02:00|worker|cron|schedule|nightly.*run/i.test(line)) {
      try {
        const obj = JSON.parse(line);
        // check if this line is a message or text rather than test output
        const str = JSON.stringify(obj);
        if (str.includes('SQLITE_BUSY') && str.includes('worker-')) continue; // skip spam
        if (str.includes('queued sku=')) continue;
        console.log(`[${path.basename(file)}:${i}] ${obj.timestamp || ''} -> ${str.slice(0, 200)}`);
      } catch {}
    }
  }
}

