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

for (const f of walk('s02e01/sessions/stock-5-sessions')) {
  const content = fs.readFileSync(f, 'utf-8');
  if (content.includes('four workers') || content.includes('02:00') || content.includes('4 workers')) {
    console.log('Match in file:', f);
    const lines = content.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('four workers') || lines[i].includes('02:00') || lines[i].includes('4 workers')) {
        const o = JSON.parse(lines[i]);
        if (o.type === 'user' || o.type === 'assistant' || o.payload?.type === 'user_message' || o.payload?.type === 'agent_message' || o.payload?.type === 'message') {
          console.log(`Line ${i+1}: [${o.timestamp || o.created_at || ''}] [type=${o.type || o.payload?.type}]`);
          const msg = o.message?.content || o.payload?.message || o.payload?.content;
          console.log(JSON.stringify(msg).slice(0, 300));
          console.log('---');
        }
      }
    }
  }
}

