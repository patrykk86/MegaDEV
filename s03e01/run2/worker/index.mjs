// s03e01 run 2 worker: the night status page on Cloudflare Workers. Two routes, one shape: GET / is
// the page, GET /status.json is the data. Both read the ops feed on every request, so neither serves a
// copy (R-L5X), and both carry the headers the tram boards poll for (R-H5X, R-K2L).

import { buildStatus, readFeed, renderHtml } from './core.mjs';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=45',
};

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=45',
};

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'access-control-allow-origin': '*',
};

async function statusOrError() {
  try {
    return { status: buildStatus(await readFeed()) };
  } catch (error) {
    return { error: `the ops feed did not answer: ${error.message}` };
  }
}

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: TEXT_HEADERS });
    }
    const { pathname } = new URL(request.url);
    const result = await statusOrError();
    if (result.error) {
      return new Response(result.error, { status: 502, headers: TEXT_HEADERS });
    }
    if (pathname === '/status.json') {
      return new Response(JSON.stringify(result.status), { status: 200, headers: JSON_HEADERS });
    }
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(renderHtml(result.status), { status: 200, headers: HTML_HEADERS });
    }
    return new Response('not found', { status: 404, headers: TEXT_HEADERS });
  },
};
