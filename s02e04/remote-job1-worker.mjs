#!/usr/bin/env node
/**
 * s02e04/remote-job1-worker.mjs - Remote CI Worker for S02E04 job-1 (incident-lookup)
 *
 * Executes exclusively on the remote GitHub Actions runner:
 * 1. Decrypts the AES-256-GCM encrypted job-1 MCP URL in memory using PAYLOAD_KEY.
 * 2. Performs MCP initialization, reads skill://incident-lookup/SKILL.md, and lists tools.
 * 3. Runs the 4-step incident-lookup procedure (search -> read -> redact -> submit).
 * 4. Encrypts the complete execution result and receipt with AES-256-GCM before logging.
 */

import crypto from 'node:crypto';

function decryptAesGcm(packed, keyHex) {
  const [ivHex, tagHex, cipherHex] = String(packed || '').split(':');
  if (!ivHex || !tagHex || !cipherHex) {
    throw new Error('Invalid encrypted payload format');
  }
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function encryptAesGcm(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

let rpcId = 0;

async function mcpRequest(mcpUrl, method, params = {}) {
  rpcId += 1;
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method,
      params,
    }),
  });
  const raw = await res.text();
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  return { status: res.status, response: parsed };
}

async function mcpToolCall(mcpUrl, name, args) {
  const { status, response } = await mcpRequest(mcpUrl, 'tools/call', {
    name,
    arguments: args,
  });
  const contentText = response?.result?.content?.[0]?.text;
  let inner = null;
  if (contentText) {
    try {
      inner = JSON.parse(contentText);
    } catch {
      inner = contentText;
    }
  }
  return { status, rawResponse: response, inner };
}

function findTram3Item(searchInner) {
  if (!searchInner || typeof searchInner !== 'object') {
    return null;
  }
  const candidates = [];
  if (Array.isArray(searchInner)) {
    candidates.push(...searchInner);
  } else {
    for (const val of Object.values(searchInner)) {
      if (Array.isArray(val)) {
        candidates.push(...val);
      }
    }
  }
  return (
    candidates.find((item) => {
      const s = JSON.stringify(item).toLowerCase();
      return s.includes('tram-3') || s.includes('tram 3');
    }) ||
    candidates[0] ||
    null
  );
}

function resolvePrimaryParamName(tools, toolName, excludedKeys, fallback) {
  const tool = (tools || []).find((t) => t.name === toolName);
  const props = Object.keys(tool?.inputSchema?.properties || {});
  const found = props.find((k) => !excludedKeys.includes(k));
  return found || fallback;
}

function extractRecordFields(readInner) {
  if (typeof readInner === 'string') {
    return readInner;
  }
  const container =
    readInner?.fields ??
    readInner?.record ??
    readInner?.incident ??
    readInner?.entry ??
    readInner?.item ??
    readInner?.data ??
    readInner;
  if (typeof container === 'string') {
    return container;
  }
  const ordered = ['date', 'time', 'clock', 'line', 'cause'];
  const lines = [];
  for (const field of ordered) {
    if (container && container[field] !== undefined) {
      lines.push(`${field}: ${container[field]}`);
    }
  }
  return lines.join('\n');
}

function extractRedactedText(redactInner) {
  if (typeof redactInner === 'string') {
    return redactInner;
  }
  for (const key of ['text', 'redacted', 'result', 'content', 'output', 'record', 'clean', 'value']) {
    if (typeof redactInner?.[key] === 'string') {
      return redactInner[key];
    }
  }
  if (redactInner && typeof redactInner === 'object') {
    for (const [k, v] of Object.entries(redactInner)) {
      if (k !== 'step' && k !== 'status' && typeof v === 'string') {
        return v;
      }
    }
  }
  return '';
}

async function runJob1() {
  const keyHex = process.env.PAYLOAD_KEY || '';
  const encryptedUrl = process.env.ENCRYPTED_JOB_URL || '';
  if (!keyHex || !encryptedUrl) {
    throw new Error('Missing PAYLOAD_KEY or ENCRYPTED_JOB_URL');
  }

  const mcpUrl = decryptAesGcm(encryptedUrl, keyHex);
  console.log(`::add-mask::${mcpUrl}`);

  const initOut = await mcpRequest(mcpUrl, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'megadev-remote-job1-worker', version: '1.0.0' },
  });
  const resourcesOut = await mcpRequest(mcpUrl, 'resources/list', {});
  const skillReadOut = await mcpRequest(mcpUrl, 'resources/read', {
    uri: 'skill://incident-lookup/SKILL.md',
  });
  const toolsOut = await mcpRequest(mcpUrl, 'tools/list', {});
  const tools = toolsOut.response?.result?.tools || [];

  // Step 1: search with query: "tram-3", scope: "ops/live"
  const searchOut = await mcpToolCall(mcpUrl, 'search', { query: 'tram-3', scope: 'ops/live' });
  const step1 = searchOut.inner?.step;
  const tram3Item = findTram3Item(searchOut.inner);

  // Step 2: read with fields: ["date", "time", "clock", "line", "cause"]
  const idParam = resolvePrimaryParamName(tools, 'read', ['fields', 'step'], 'id');
  const idVal =
    tram3Item?.[idParam] ?? tram3Item?.id ?? tram3Item?.ref ?? tram3Item?.key ?? tram3Item?.recordId ?? 'tram-3';
  const readOut = await mcpToolCall(mcpUrl, 'read', {
    [idParam]: idVal,
    fields: ['date', 'time', 'clock', 'line', 'cause'],
    step: step1,
  });
  const step2 = readOut.inner?.step;
  const formattedText = extractRecordFields(readOut.inner);

  // Step 3: redact
  const redactParam = resolvePrimaryParamName(tools, 'redact', ['step'], 'text');
  const redactOut = await mcpToolCall(mcpUrl, 'redact', {
    [redactParam]: formattedText,
    step: step2,
  });
  const step3 = redactOut.inner?.step;
  const redactedText = extractRedactedText(redactOut.inner);

  // Step 4: submit with skillVersion: "1"
  const submitParam = resolvePrimaryParamName(tools, 'submit', ['skillVersion', 'step'], 'result');
  const submitOut = await mcpToolCall(mcpUrl, 'submit', {
    [submitParam]: redactedText,
    skillVersion: '1',
    step: step3,
  });

  const bundle = {
    initOut: initOut.response,
    resourcesOut: resourcesOut.response,
    skillReadOut: skillReadOut.response,
    tools,
    searchOut: searchOut.inner,
    tram3Item,
    readOut: readOut.inner,
    formattedText,
    redactOut: redactOut.inner,
    redactedText,
    submitOut: submitOut.inner,
    submitRaw: submitOut.rawResponse,
  };

  const encryptedBundle = encryptAesGcm(JSON.stringify(bundle), keyHex);
  console.log(`ENCRYPTED_JOB1_BUNDLE:${encryptedBundle}`);
}

runJob1().catch((err) => {
  console.error('Worker error:', err.message);
  process.exit(1);
});
