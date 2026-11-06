import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createServerHandler, maskSecrets, TOOLS } from './server.mjs';

function callHandler(handler, { method = 'GET', url = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    if (!req.headers.host) req.headers.host = 'localhost:8787';

    let statusCode = 200;
    const responseHeaders = {};
    let responseBody = '';

    const res = {
      setHeader(name, val) {
        responseHeaders[name.toLowerCase()] = val;
      },
      writeHead(code, hdrs = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) {
          responseHeaders[k.toLowerCase()] = v;
        }
      },
      write(chunk) {
        responseBody += chunk;
      },
      end(chunk = '') {
        responseBody += chunk;
        resolve({
          status: statusCode,
          headers: {
            get: (name) => responseHeaders[name.toLowerCase()] ?? null,
            raw: responseHeaders,
          },
          text: async () => responseBody,
          json: async () => JSON.parse(responseBody),
        });
      },
    };

    handler(req, res).catch(reject);

    process.nextTick(() => {
      if (body) {
        req.emit('data', Buffer.from(body));
      }
      req.emit('end');
    });
  });
}

describe('s02e03 Remote MCP Server Suite', () => {
  const publicBaseUrl = 'https://megadev-test.web.app';
  const adminToken = 'test-admin-token-12345';
  const handler = createServerHandler({
    publicBaseUrl,
    adminToken,
  });

  it('serves health check', async () => {
    const res = await callHandler(handler, { url: '/health' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('serves plan / resource_documentation page with tools, sign-in and retention', async () => {
    const res = await callHandler(handler, { url: '/plan' });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /memo_write/);
    assert.match(html, /memo_search/);
    assert.match(html, /upload/);
    assert.match(html, /transcribe/);
    assert.match(html, /OAuth 2\.1/);
    assert.match(html, /Data Retention/);
  });

  it('serves RFC 9728 Protected Resource Metadata', async () => {
    const res = await callHandler(handler, { url: '/.well-known/oauth-protected-resource' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.resource, `${publicBaseUrl}/mcp`);
    assert.deepEqual(data.authorization_servers, [publicBaseUrl]);
    assert.equal(data.resource_documentation, `${publicBaseUrl}/plan`);
  });

  it('serves Agent2Agent (A2A) discovery card at /.well-known/agent-card.json', async () => {
    const res = await callHandler(handler, { url: '/.well-known/agent-card.json' });
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.equal(card.name, 'MegaDEV Remote Agent & MCP Service');
    assert.equal(card.version, '1.0.0');
    assert.ok(Array.isArray(card.supportedInterfaces));
    assert.equal(card.supportedInterfaces[0].url, `${publicBaseUrl}/mcp`);
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.ok(Array.isArray(card.skills));
    assert.equal(card.skills.length, 4);
    for (const skill of card.skills) {
      assert.ok(skill.id);
      assert.ok(skill.name);
      assert.ok(skill.inputContract);
      assert.equal(skill.inputContract.type, 'object');
    }
  });

  it('serves RFC 8414 Authorization Server Metadata', async () => {
    const res = await callHandler(handler, { url: '/.well-known/oauth-authorization-server' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.authorization_endpoint, `${publicBaseUrl}/oauth/authorize`);
    assert.equal(data.token_endpoint, `${publicBaseUrl}/oauth/token`);
    assert.deepEqual(data.response_types_supported, ['code']);
    assert.ok(data.code_challenge_methods_supported.includes('S256'));
  });

  it('rejects unauthenticated requests to /mcp with 401 and WWW-Authenticate', async () => {
    const res = await callHandler(handler, {
      method: 'POST',
      url: '/mcp',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    const wwwAuth = res.headers.get('www-authenticate');
    assert.ok(wwwAuth);
    assert.match(wwwAuth, /resource_metadata=/);
  });

  it('executes full OAuth 2.1 authorization code flow with PKCE', async () => {
    // 1. Client creates PKCE verifier and challenge
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'https://course.mega.dev/callback';
    const state = 'state_xyz123';

    // 2. Consent Screen
    const consentRes = await callHandler(handler, {
      url: `/oauth/authorize?client_id=course-client&redirect_uri=${encodeURIComponent(
        redirectUri
      )}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`,
    });
    assert.equal(consentRes.status, 200);

    // 3. User Approves Consent -> 302 redirect with code
    const approveBody = new URLSearchParams({
      client_id: 'course-client',
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    const approveRes = await callHandler(handler, {
      method: 'POST',
      url: '/oauth/authorize/approve',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: approveBody,
    });

    assert.equal(approveRes.status, 302);
    const location = approveRes.headers.get('location');
    assert.ok(location);
    const redirectedUrl = new URL(location);
    const code = redirectedUrl.searchParams.get('code');
    assert.ok(code);
    assert.equal(redirectedUrl.searchParams.get('state'), state);

    // 4. Token Exchange with PKCE verifier
    const tokenRes = await callHandler(handler, {
      method: 'POST',
      url: '/oauth/token',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });

    assert.equal(tokenRes.status, 200);
    const tokenData = await tokenRes.json();
    assert.ok(tokenData.access_token);
    assert.equal(tokenData.token_type, 'Bearer');

    const accessToken = tokenData.access_token;

    // 5. Use Access Token to call /mcp tools/list
    const listRes = await callHandler(handler, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
    });

    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.result.tools.length, 4);

    // 6. Test memo_write
    const writeRes = await callHandler(handler, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'memo_write',
          arguments: { text: 'Secret mission directive 42' },
        },
      }),
    });
    assert.equal(writeRes.status, 200);
    const writeData = await writeRes.json();
    const noteId = writeData.result.structuredContent.id;
    assert.ok(noteId);

    // 7. Test memo_search
    const searchRes = await callHandler(handler, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'memo_search',
          arguments: { query: 'mission directive' },
        },
      }),
    });
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.ok(Array.isArray(searchData.result.structuredContent.notes));
    assert.ok(searchData.result.structuredContent.notes.length >= 1);
    const foundNote = searchData.result.structuredContent.notes.find((n) => n.id === noteId);
    assert.ok(foundNote);
    assert.equal(foundNote.text, 'Secret mission directive 42');

    // 8. Test upload
    const uploadRes = await callHandler(handler, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'upload',
          arguments: { content: 'hello public world', filename: 'greeting.txt' },
        },
      }),
    });
    assert.equal(uploadRes.status, 200);
    const uploadData = await uploadRes.json();
    const fileUrl = uploadData.result.structuredContent.url;
    assert.ok(fileUrl);
    assert.match(fileUrl, /^https:\/\/megadev-test\.web\.app\/files\//);

    // 9. Test transcribe tool response structure
    const transRes = await callHandler(handler, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'transcribe',
          arguments: { url: 'https://example.com/audio.mp3' },
        },
      }),
    });
    assert.equal(transRes.status, 200);
    const transData = await transRes.json();
    if (transData.result.isError) {
      assert.equal(transData.result.isError, true);
      assert.ok(Array.isArray(transData.result.content));
      assert.ok(transData.result.content[0].text.includes('Transcription failed'));
    } else {
      assert.ok(Array.isArray(transData.result.structuredContent.segments));
      assert.ok(transData.result.structuredContent.segments.length > 0);
      assert.equal(typeof transData.result.structuredContent.segments[0].start, 'number');
      assert.equal(typeof transData.result.structuredContent.segments[0].text, 'string');
    }
  });

  it('masks sensitive secrets in logs', () => {
    const raw = {
      token: 'mcpat_1234567890abcdef1234567890abcdef',
      authorization: 'Bearer secret_token_xyz_987654321',
      regular_name: 'public_info',
    };
    const masked = maskSecrets(raw);
    assert.equal(masked.token, '[REDACTED]');
    assert.equal(masked.authorization, '[REDACTED]');
    assert.equal(masked.regular_name, 'public_info');
  });
});
