// A dependency-free static server for app/, so the board can be opened before it is deployed.
//
//   node scripts/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('../app/', import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = normalize(join(appDir, path === '/' ? 'index.html' : decodeURIComponent(path)));
    if (!file.startsWith(appDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(port, () => console.log(`serving app/ on http://localhost:${port}/`));
