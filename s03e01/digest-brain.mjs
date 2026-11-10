// s03e01 brain digest: searches the Antigravity IDE and CLI brain transcripts for keywords and
// prints bounded, redacted excerpts. The roots are resolved from the operator profile at runtime;
// no home path is written here.
//
// Usage: node s03e01/digest-brain.mjs <keyword[,keyword...]> [--files N] [--hits N] [--chars N] [--root <dir[,dir...]>]
//
// --root points the digest at a copied brain tree, such as the .gemini folder kept in this
// workspace; without it the operator profile's own brain is read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const keywords = (args[0] ?? '').split(',').filter(Boolean);
if (keywords.length === 0) {
  console.error('usage: node s03e01/digest-brain.mjs <keyword[,keyword...]> [--files N] [--hits N] [--chars N]');
  process.exit(1);
}

function flag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? fallback : Number.parseInt(args[idx + 1], 10);
}

const MAX_FILES = flag('files', 6);
const MAX_HITS = flag('hits', 40);
const MAX_CHARS = flag('chars', 420);

// --conversation narrows the scan to one conversation id (or any substring of it).
// --user-only keeps the human's own turns, which is how a thread's intent is read.
const conversationFilter = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : null;
const userOnly = args.includes('--user-only');
const matchAll = keywords.includes('all');

const rootFlag = args.includes('--root') ? args[args.indexOf('--root') + 1] : null;
const ROOTS = rootFlag
  ? rootFlag.split(',').filter(Boolean).map((dir) => path.resolve(process.cwd(), dir))
  : [
      path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    ];

// Bounded walk: transcript files sit three levels down, under <conversation>/.system_generated/logs.
function findTranscripts(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const found = [];
  let level = [root];
  for (let depth = 0; depth <= 3 && level.length; depth += 1) {
    const next = [];
    for (const dir of level) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          next.push(full);
        } else if (entry.name === 'transcript_full.jsonl' || entry.name === 'transcript.jsonl') {
          found.push(full);
        }
      }
    }
    level = next;
  }
  return found;
}

// Tokens, keys and long opaque blobs never reach the digest.
function redact(text) {
  return text
    .replace(/v1\.[A-Za-z0-9_\-.=]{20,}/g, 'v1.<redacted>')
    .replace(/mcpat_[A-Za-z0-9_\-]+/g, 'mcpat_<redacted>')
    .replace(/\bwhsec_[A-Za-z0-9+/=]+/g, 'whsec_<redacted>')
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '<redacted-blob>')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
}

const pattern = new RegExp(keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

const transcripts = ROOTS.flatMap((root) => findTranscripts(root))
  .filter((file) => !conversationFilter || file.split(path.sep).slice(-4, -3)[0].includes(conversationFilter))
  .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, MAX_FILES);

console.log(`transcripts scanned: ${transcripts.length} (newest first)`);
for (const { file } of transcripts) {
  console.log(`  ${path.basename(path.dirname(path.dirname(path.dirname(file))))}  ${file.split(path.sep).slice(-1)[0]}`);
}

let hits = 0;
for (const { file } of transcripts) {
  const conversation = file.split(path.sep).slice(-4, -3)[0];
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    if (hits >= MAX_HITS) {
      break;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const raw = typeof rec.content === 'string' ? rec.content : JSON.stringify(rec.content ?? '');
    if (userOnly && !String(rec.source ?? '').includes('USER')) {
      continue;
    }
    if (!matchAll && !pattern.test(raw)) {
      continue;
    }
    const text = redact(raw).replace(/\s+/g, ' ').trim();
    const at = matchAll ? 0 : text.search(pattern);
    const start = Math.max(0, at - Math.floor(MAX_CHARS / 3));
    const excerpt = text.slice(start, start + MAX_CHARS);
    hits += 1;
    console.log(`\n[${conversation} step ${rec.step_index} ${rec.created_at} ${rec.type}]`);
    console.log(`${start > 0 ? '...' : ''}${excerpt}${start + MAX_CHARS < text.length ? '...' : ''}`);
  }
}
console.log(`\nhits: ${hits}${hits >= MAX_HITS ? ' (capped)' : ''}`);
