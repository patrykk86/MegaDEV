import { onRequest } from 'firebase-functions/v2/https';
import { createServerHandler } from './server.mjs';

const handler = createServerHandler({
  publicBaseUrl: 'https://megadevpat.web.app',
  adminToken: process.env.ADMIN_TOKEN || 'admin-mega-dev-secure',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
});

export const mcp = onRequest({ cors: true, maxInstances: 10 }, async (req, res) => {
  await handler(req, res);
});

