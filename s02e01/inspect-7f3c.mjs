import fs from 'node:fs';

const lines = fs.readFileSync('s02e01/sessions/stock-5-sessions/.claude/projects/-home-build-stock-5/7f3c2a91-4e5b-4d1a-9b8e-2c6d0f1a3b57.jsonl', 'utf-8').split('\n').filter(Boolean);

for (let i = 0; i < lines.length; i++) {
  const o = JSON.parse(lines[i]);
  const content = o.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text') text += c.text + '\n';
      if (c.type === 'tool_use' && (c.name === 'Write' || c.name === 'Edit')) {
        text += `[Tool: ${c.name} ${c.input?.path || ''}]\n${JSON.stringify(c.input?.content || c.input?.new_string || '').slice(0, 300)}\n`;
      }
    }
  }
  if (/drizzle|sqlite|reorder\.db|02:00|workers|orm|schema\.ts/i.test(text)) {
    console.log(`[Line ${i+1}] [${o.timestamp}] ${o.type}:`);
    console.log(text.slice(0, 400));
    console.log('---');
  }
}

