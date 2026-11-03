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
  const content = fs.readFileSync(file, 'utf-8');
  const rel = path.relative('s02e01/sessions/stock-5-sessions', file);
  
  const mWorkers = content.match(/workers?/gi);
  const mRuns = content.match(/\bruns?\b/gi);
  const mNightly = content.match(/\bnightly\b/gi);
  const mSchedule = content.match(/schedule|cron|02:00/gi);
  
  console.log(`${rel}: workers=${mWorkers?.length || 0}, runs=${mRuns?.length || 0}, nightly=${mNightly?.length || 0}, sched=${mSchedule?.length || 0}`);
}

