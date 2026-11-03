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
  console.log(`\n======================================================`);
  console.log(`FILE: ${file}`);
  console.log(`======================================================`);
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  
  let sessionId = path.basename(file, '.jsonl');
  
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.payload?.id) {
        sessionId = obj.payload.id;
      }
      
      // Claude format
      if (obj.type === 'user' || obj.type === 'assistant') {
        const text = typeof obj.message?.content === 'string' ? obj.message.content : (Array.isArray(obj.message?.content) ? obj.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
        if (text) {
          console.log(`[Claude] [${obj.created_at || ''}] [Session: ${sessionId}] ${obj.type}:`);
          console.log(text.slice(0, 300));
          console.log('---');
        }
      }
      
      // Codex format
      if (obj.type === 'response_item') {
        const items = obj.payload;
        if (Array.isArray(items)) {
          for (const it of items) {
            if (it.type === 'input_text' || it.type === 'output_text') {
              console.log(`[Codex] [${obj.timestamp || ''}] [Session: ${sessionId}] ${it.type}:`);
              console.log(it.text.slice(0, 300));
              console.log('---');
            }
          }
        }
      }
    } catch {}
  }
}

