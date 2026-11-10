// s03e01 fetch-text: reads one public course URL and writes its body to a file, so the contract
// comes from the site's own text (llms.txt, page markdown) instead of a guessed endpoint.
//
// Usage: node s03e01/fetch-text.mjs <url> <out-file>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const [url, outArg] = process.argv.slice(2);

if (!url || !outArg) {
  console.error('usage: node s03e01/fetch-text.mjs <url> <out-file>');
  process.exitCode = 2;
} else {
  const out = path.isAbsolute(outArg) ? outArg : path.join(DIR, outArg);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/plain, text/markdown, */*' },
  });
  const body = await res.text();
  fs.writeFileSync(out, body, 'utf-8');
  console.log(JSON.stringify({ url, status: res.status, contentType: res.headers.get('content-type'), chars: body.length, out: path.basename(out) }, null, 2));
}
