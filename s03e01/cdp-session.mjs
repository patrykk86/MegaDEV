// s03e01 CDP session: drives a Chrome instance started for this task on a throwaway profile,
// so a page behind the course sign-in can be read without touching the operator's own profile
// or session (KEEP.md finding, sourced to s03e01/requests.log:12).
//
// Usage:
//   node s03e01/cdp-session.mjs launch [url]   start Chrome detached, wait for the debug port
//   node s03e01/cdp-session.mjs open <url>     open a tab on an already running instance
//   node s03e01/cdp-session.mjs read [--out f] dump the rendered text of the open tab
//   node s03e01/cdp-session.mjs close          stop the instance and delete its profile
//
// The script writes cdp-state.json beside itself so a later turn finds the same pid and profile.
// It reads no .env value and sends no ticket: it only talks to 127.0.0.1.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(DIR, 'cdp-state.json');
const PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const PROFILE = path.join(os.tmpdir(), 'megadev-cdp-s03e01');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('chrome.exe not found in the standard install paths');
  }
  return found;
}

async function version(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/json/version`);
      if (res.ok) {
        return await res.json();
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`Chrome did not answer on ${BASE}: ${lastError}`);
}

async function targets() {
  const res = await fetch(`${BASE}/json/list`);
  if (!res.ok) {
    throw new Error(`/json/list answered HTTP ${res.status}`);
  }
  return res.json();
}

function readState() {
  return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf-8')) : null;
}

async function launch(url) {
  if (typeof WebSocket !== 'function') {
    throw new Error(`this node build has no global WebSocket (found ${process.version})`);
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(
    chromePath(),
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      url ?? 'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  fs.writeFileSync(STATE, `${JSON.stringify({ pid: child.pid, profile: PROFILE, port: PORT, url }, null, 2)}\n`, 'utf-8');
  const info = await version();
  return { pid: child.pid, profile: PROFILE, browser: info.Browser, websocket: Boolean(info.webSocketDebuggerUrl) };
}

async function open(url) {
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) {
    throw new Error(`/json/new answered HTTP ${res.status}`);
  }
  const target = await res.json();
  return { id: target.id, url: target.url };
}

async function evaluate(wsUrl, expression, timeoutMs = 20000) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('cdp socket refused the connection'));
  });
  const id = 1;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp evaluate timed out')), timeoutMs);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        clearTimeout(timer);
        resolve(message);
      }
    };
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  socket.close();
  if (reply.error) {
    throw new Error(reply.error.message);
  }
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.text ?? 'cdp evaluate threw');
  }
  return reply.result?.result?.value;
}

async function pickTarget(wanted = 'hq.mega.dev') {
  const pages = (await targets()).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (pages.length === 0) {
    throw new Error('no page target is open in the task browser');
  }
  const strip = (url) => url.split('#')[0].split('?')[0];
  return (
    pages.find((page) => page.url === wanted) ??
    pages.find((page) => strip(page.url) === strip(wanted)) ??
    pages.find((page) => page.url.includes(wanted)) ??
    pages[0]
  );
}

async function read(outFile, wanted) {
  const target = await pickTarget(wanted ?? 'https://hq.mega.dev/challenges/status-for-the-night');
  const text = await evaluate(target.webSocketDebuggerUrl, 'document.body ? document.body.innerText : ""');
  const href = await evaluate(target.webSocketDebuggerUrl, 'location.href');
  const readyState = await evaluate(target.webSocketDebuggerUrl, 'document.readyState');
  const body = typeof text === 'string' ? text : '';
  const destination = outFile ?? path.join(DIR, 'page.txt');
  fs.writeFileSync(destination, body, 'utf-8');
  return {
    href,
    readyState,
    chars: body.length,
    signInWall: /Sign in|sign-in link|login link/i.test(body),
    out: path.relative(DIR, destination),
  };
}

async function capture(wsUrl, timeoutMs = 20000) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('cdp socket refused the connection'));
  });
  const call = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp ${method} timed out`)), timeoutMs);
      const listener = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === id) {
          clearTimeout(timer);
          socket.removeEventListener('message', listener);
          resolve(message);
        }
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call(1, 'Page.enable');
  const reply = await call(2, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
  socket.close();
  if (reply.error) {
    throw new Error(reply.error.message);
  }
  return reply.result.data;
}

async function close() {
  const state = readState();
  const result = { killed: false, profileRemoved: false };
  if (state?.pid) {
    spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' });
    result.killed = true;
  }
  if (fs.existsSync(PROFILE)) {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
    result.profileRemoved = true;
  }
  if (fs.existsSync(STATE)) {
    fs.rmSync(STATE, { force: true });
  }
  return result;
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => (rest.indexOf(name) >= 0 ? rest[rest.indexOf(name) + 1] : undefined);
const outFile = flag('--out');
const match = flag('--match');

try {
  if (command === 'launch') {
    console.log(JSON.stringify(await launch(rest.find((value) => value.startsWith('http'))), null, 2));
  } else if (command === 'open') {
    console.log(JSON.stringify(await open(rest[0]), null, 2));
  } else if (command === 'read') {
    console.log(JSON.stringify(await read(outFile, match), null, 2));
  } else if (command === 'eval') {
    const expression = fs.readFileSync(rest[0], 'utf-8');
    const target = await pickTarget(match);
    const result = await evaluate(target.webSocketDebuggerUrl, expression, 120000);
    if (outFile) {
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      const out = path.isAbsolute(outFile) ? outFile : path.join(DIR, outFile);
      fs.writeFileSync(out, text, 'utf-8');
      console.log(JSON.stringify({ url: target.url, out: path.basename(out), chars: text.length }, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (command === 'shot') {
    const target = await pickTarget(match);
    const data = await capture(target.webSocketDebuggerUrl);
    const out = path.join(DIR, rest[0] ?? 'shot.png');
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    console.log(JSON.stringify({ url: target.url, out: path.basename(out), bytes: Buffer.from(data, 'base64').length }, null, 2));
  } else if (command === 'close') {
    console.log(JSON.stringify(await close(), null, 2));
  } else {
    console.error('usage: launch [url] | open <url> | read [--out file] | close');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
