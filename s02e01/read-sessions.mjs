import fs from 'node:fs';

function extractAllTexts(file) {
  console.log(`\n=================== FILE: ${file} ===================\n`);
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      // Codex format vs Claude format
      const ts = obj.timestamp || obj.created_at || (obj.message && obj.message.created_at) || '';
      
      // Look for text in messages
      let texts = [];
      function collectStrings(o) {
        if (!o) return;
        if (typeof o === 'string') {
          if (o.length > 20 && !o.startsWith('ey') && !o.startsWith('data:')) {
            texts.push(o);
          }
          return;
        }
        if (Array.isArray(o)) {
          for (const item of o) collectStrings(item);
          return;
        }
        if (typeof o === 'object') {
          if (o.text) texts.push(o.text);
          if (o.content) collectStrings(o.content);
          if (o.message) collectStrings(o.message);
          if (o.arguments) collectStrings(o.arguments);
        }
      }
      collectStrings(obj);

      const filtered = texts.filter(t => /postgres|sqlite|drizzle|prisma|reorder|plan|decision|db|worker|nightly|02:00|03:00|04:00|port|5432|store/i.test(t));
      if (filtered.length > 0) {
        console.log(`[Line ${i + 1}] [${ts}] (type=${obj.type || obj.role || ''}):`);
        for (const t of filtered) {
          console.log(t.trim().slice(0, 300));
          console.log('---');
        }
      }
    } catch (e) {}
  }
}

const fileCodex = 's02e01/sessions/stock-5-sessions/.codex/sessions/2026/10/30/rollout-2026-10-30T15-31-40-019a35d2-7c41-7e08-a3f1-5b9e2d6c4a10.jsonl';
extractAllTexts(fileCodex);
