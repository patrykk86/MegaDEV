// s03e01 fetch-bin: saves one binary response (the course's pack) to disk unchanged.
//
// Usage: node s03e01/fetch-bin.mjs <url> <out-file>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const [url, outArg] = process.argv.slice(2);

if (!url || !outArg) {
  console.error('usage: node s03e01/fetch-bin.mjs <url> <out-file>');
  process.exitCode = 2;
} else {
  const out = path.isAbsolute(outArg) ? outArg : path.join(DIR, outArg);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buffer);
  console.log(JSON.stringify({ url, status: res.status, contentType: res.headers.get('content-type'), bytes: buffer.length, out: path.basename(out) }, null, 2));
}
