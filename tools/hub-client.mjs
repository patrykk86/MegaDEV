#!/usr/bin/env node
/**
 * hub-client.mjs - Canonical MEGA Challenge Hub HTTP Client with Automatic Secret Masking
 * Single source of truth for .env loading, X-Megadev-Key auth, ticket injection, and masked logging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_RE = /ticket|token|authorization|key|secret|receipt/i;

export function loadWorkspaceEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) {
      process.env[key] = trimmed.slice(eq + 1).trim();
    }
  }
}

function maskStringSecret(str) {
  if (str.startsWith('v1.') && str.length > 30) {
    return `${str.slice(0, 10)}...MASKED...${str.slice(-6)}`;
  }
  if (UUID_RE.test(str)) {
    return `${str.slice(0, 8)}...MASKED`;
  }
  return str;
}

function maskObjectSecrets(obj) {
  const masked = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k) && v) {
      const s = String(v);
      masked[k] = s.length > 16 ? `${s.slice(0, 10)}...MASKED...${s.slice(-6)}` : '***MASKED***';
    } else {
      masked[k] = maskSecretValue(v);
    }
  }
  return masked;
}

export function maskSecretValue(value) {
  if (typeof value === 'string') {
    return maskStringSecret(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskSecretValue);
  }
  if (value && typeof value === 'object') {
    return maskObjectSecrets(value);
  }
  return value;
}

export async function postHubReport(url, body, options = {}) {
  loadWorkspaceEnv();
  const apiKey = options.apiKey || process.env.MEGADEV_KEY;
  if (!apiKey) {
    throw new Error('Missing MEGADEV_KEY in .env or environment variables.');
  }

  const payload = { ...body };
  if (!payload.ticket) {
    if (!process.env.MEGADEV_TICKET) {
      throw new Error('Missing ticket in payload and MEGADEV_TICKET is not set in .env.');
    }
    payload.ticket = process.env.MEGADEV_TICKET;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'X-Megadev-Key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let respBody = rawText;
  try {
    respBody = JSON.parse(rawText);
  } catch {
    // Keep plain text response
  }

  if (options.logFile) {
    const entry = {
      timestamp: new Date().toISOString(),
      url,
      request: maskSecretValue(payload),
      status: response.status,
      response: maskSecretValue(respBody),
    };
    fs.appendFileSync(options.logFile, `${JSON.stringify(entry, null, 2)}\n---\n`, 'utf-8');
  }

  return { status: response.status, body: respBody };
}

function buildCliBody(values) {
  if (values.body) {
    return JSON.parse(values.body);
  }
  if (values.record) {
    const rec = values.record.startsWith('@')
      ? fs.readFileSync(values.record.slice(1), 'utf-8').trim()
      : values.record;
    return { record: rec };
  }
  if (values.finding !== undefined) {
    const body = { finding: values.finding };
    if (values.offset !== undefined) {
      body.offset = Number.parseInt(values.offset, 10);
    }
    return body;
  }
  throw new Error('Provide --finding, --record, or --body.');
}

async function runCli() {
  const { values } = parseNodeArgs({
    options: {
      url: { type: 'string' },
      body: { type: 'string' },
      finding: { type: 'string' },
      offset: { type: 'string' },
      record: { type: 'string' },
      log: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(
      'Usage: node tools/hub-client.mjs --url <endpoint> [--finding <val> --offset <sec> | --record <text|@file> | --body <json>] [--log <requests.log>]'
    );
    return;
  }
  if (!values.url) {
    throw new Error('--url is required.');
  }

  const res = await postHubReport(values.url, buildCliBody(values), { logFile: values.log });
  console.log(JSON.stringify(res, null, 2));
  if (res.status >= 400) {
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
