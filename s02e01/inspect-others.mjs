import fs from 'node:fs';

function inspectFile(file) {
  console.log(`\n=================== FILE: ${file} ===================\n`);
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]);
    if (obj.payload?.id) {
      console.log(`Session Meta ID: ${obj.payload.id}, timestamp: ${obj.timestamp}`);
    }
    // Codex
    if (obj.payload && Array.isArray(obj.payload)) {
      for (const item of obj.payload) {
        if (item.type === 'input_text' || item.type === 'output_text') {
          console.log(`[${obj.timestamp}] ${item.type}: ${item.text.slice(0, 300)}`);
        }
      }
    }
    // Claude
    if (obj.type === 'user' || obj.type === 'assistant') {
      const text = typeof obj.message?.content === 'string' ? obj.message.content : (Array.isArray(obj.message?.content) ? obj.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
      if (text) {
        console.log(`[${obj.created_at || ''}] ${obj.type}: ${text.slice(0, 300)}`);
      }
    }
  }
}

inspectFile('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/31/rollout-2026-10-31T10-15-30-11e58d3b-f53e-400b-a860-133371967557.jsonl');
inspectFile('s02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/28/rollout-2026-10-28T09-40-12-6aab86ac-3a96-49de-a696-cfbbf066cea8.jsonl');
inspectFile('s02e01/sessions/stock-5-sessions/.claude/projects/-srv-ops-stock-5/e7b31c58-2d4a-4f90-8c16-9a5d03b7e2f1/subagents/agent-a91f3e07c5d28b64e.jsonl');

