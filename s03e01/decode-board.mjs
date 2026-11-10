// s03e01 decode-board: turns the base64 payload the signed-in page returned into a real file,
// and reports what the fetch actually got (status, content type, size).
//
// Usage: node s03e01/decode-board.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const [inputArg, outBaseArg] = process.argv.slice(2);
const payload = JSON.parse(fs.readFileSync(path.join(DIR, inputArg ?? 'board.b64.json'), 'utf-8'));

if (!payload.b64) {
  console.log(JSON.stringify({ error: 'no b64 in payload', keys: Object.keys(payload), preview: JSON.stringify(payload).slice(0, 400) }, null, 2));
  process.exit(0);
}

const bytes = Buffer.from(payload.b64, 'base64');
const type = String(payload.type ?? '');
const extension = type.includes('png') ? '.png' : type.includes('jpeg') ? '.jpg' : type.includes('svg') ? '.svg' : '.bin';
const out = path.join(DIR, `${outBaseArg ?? 'board'}${extension}`);
fs.writeFileSync(out, bytes);

console.log(
  JSON.stringify(
    {
      status: payload.status,
      type,
      bytes: bytes.length,
      out: path.basename(out),
      head: bytes.subarray(0, 16).toString('latin1'),
      textHead: extension === '.svg' || extension === '.bin' ? bytes.subarray(0, 300).toString('utf8') : undefined,
    },
    null,
    2,
  ),
);
