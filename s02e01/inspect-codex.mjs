import fs from 'node:fs';

const lines = fs.readFileSync('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/30/rollout-2026-10-30T15-31-40-019a35d2-7c41-7e08-a3f1-5b9e2d6c4a10.jsonl', 'utf-8').split('\n').filter(Boolean);

for (let i = 0; i < lines.length; i++) {
  const item = JSON.parse(lines[i]);
  const p = item.payload;
  if (!p) continue;
  
  // Codex types: user_message, assistant_message, function_call, function_call_output, etc.
  if (item.type === 'user_message' || item.type === 'message' || p.message || p.content || p.text || p.prompt) {
    const text = p.message || p.content || p.text || p.prompt;
    console.log(`\n--- [${item.timestamp}] TYPE: ${item.type} ---`);
    console.log(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  } else if (item.type === 'function_call' || item.type === 'call') {
    console.log(`\n--- [${item.timestamp}] CALL: ${p.name} ---`);
    console.log(JSON.stringify(p.arguments || p.input || p, null, 2).slice(0, 500));
  } else if (item.type === 'function_call_output' || item.type === 'output') {
    const out = JSON.stringify(p.output || p.result || p);
    if (out.length < 500) {
      console.log(`\n--- [${item.timestamp}] OUTPUT ---`);
      console.log(out);
    }
  }
}

