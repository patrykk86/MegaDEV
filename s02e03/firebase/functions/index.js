import { onRequest } from 'firebase-functions/v2/https';
import { createServerHandler } from './server.mjs';
import { buildStatus, readFeed, renderHtml } from './status-core.mjs';

const handler = createServerHandler({
  publicBaseUrl: 'https://megadevpat.web.app',
  adminToken: process.env.ADMIN_TOKEN || 'admin-mega-dev-secure',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
});

export const mcp = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
  await handler(req, res);
});

// S03E01: the night status page and its JSON, built from the ops feed on every request.
// Served beside the MCP server on the same site, at /status/ and /status/status.json.
export const status = onRequest({ maxInstances: 10 }, async (req, res) => {
  const path = String(req.path || '/');
  try {
    const payload = buildStatus(await readFeed());
    if (path.endsWith('status.json')) {
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'public, max-age=45');
      res.status(200).send(JSON.stringify(payload));
      return;
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=45');
    res.status(200).send(renderHtml(payload));
  } catch (error) {
    res.set('Access-Control-Allow-Origin', '*');
    res.status(502).send(`the ops feed did not answer: ${error.message}`);
  }
});

