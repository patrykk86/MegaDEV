// s03e01 status server: runs the night status page on loopback for verification before deploy.
// Same handler shape the deployed function uses: GET / is the page, GET /status.json is the data.
//
// Usage: node s03e01/site/server.mjs [port]

import http from 'node:http';
import { buildStatus, readFeed, renderHtml } from './status-core.mjs';

const port = Number(process.argv[2] ?? 8788);

const server = http.createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
  try {
    const status = buildStatus(await readFeed());
    if (path === '/status.json') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=45',
      });
      response.end(JSON.stringify(status));
      return;
    }
    if (path !== '/' && path !== '/index.html') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=45',
    });
    response.end(renderHtml(status));
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    response.end(`the ops feed did not answer: ${error.message}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}/`, pid: process.pid }));
});
