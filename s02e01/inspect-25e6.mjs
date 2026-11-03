import fs from 'node:fs';

const lines = fs.readFileSync('s02e01/sessions/stock-5-sessions/.claude/projects/-home-build-stock-5/25e645ab-8a84-4a82-a463-ac9edd2d31c0.jsonl', 'utf-8').split('\n').filter(Boolean);

console.log('Total lines in 25e645ab:', lines.length);
for (let i = 0; i < lines.length; i++) {
  const o = JSON.parse(lines[i]);
  if (o.type === 'user' || (o.type === 'assistant' && o.message?.content && typeof o.message.content === 'string')) {
    console.log(`[Line ${i+1}] [${o.timestamp || o.created_at || ''}] ${o.type}:`);
    const c = typeof o.message?.content === 'string' ? o.message.content : JSON.stringify(o.message?.content);
    console.log(c.slice(0, 300));
    console.log('---');
  }
}

