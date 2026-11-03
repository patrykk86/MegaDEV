import fs from 'node:fs';
import path from 'node:path';

const url = "https://hq.mega.dev/challenges/found-out-late/archive/v1.eyJzdWIiOiIxNTM2IiwiYXVkIjoiZm91bmQtb3V0LWxhdGU6YXJjaGl2ZSIsImlhdCI6MTc5MzY0NTkyOCwiZXhwIjoxNzk4ODI5OTI4fQ.t-RAd7iadM2WH2AboyTD04odVRI1YILm5bT9S0RN3aM";

const res = await fetch(url);
const data = await res.json();
console.log('Files in archive:', data.files.length);
for (const file of data.files) {
  console.log(file.name, file.url);
  if (file.name.endsWith('.jsonl')) {
    const target = path.join('s02e01/sessions', file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fRes = await fetch(file.url);
    const content = await fRes.text();
    fs.writeFileSync(target, content, 'utf8');
    console.log(`Saved ${target} (${content.length} bytes)`);
  }
}
