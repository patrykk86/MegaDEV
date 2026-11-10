// s03e01 serve: a loopback-only static server for the pack folder, so the recording and a page I
// control share one origin and the canvas can be read. Listens on 127.0.0.1 only.
//
// Usage: node s03e01/serve.mjs [port]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8787);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((request, response) => {
  const requested = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const target = path.join(DIR, path.normalize(requested).replace(/^([/\\])+/, ''));
  if (!target.startsWith(DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': types[path.extname(target).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(target).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}/`, pid: process.pid, root: path.basename(DIR) }));
});
