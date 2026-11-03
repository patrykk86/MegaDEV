#!/usr/bin/env node
/**
 * tools/service/health-check.mjs - Service Health Check & Background Process Monitor
 *
 * Checks health of:
 * 1. BioCore FastAPI Backend (http://127.0.0.1:8000/health)
 * 2. MegaDEV Telegram Bot Gateway
 *
 * Supports --start to automatically boot missing services in the background.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGatewayEnv, TelegramBotGateway } from '../gateway/telegram-bot.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIOCORE_PYTHON = 'd:\\Projekt Hajs\\biocore_ai\\biocore_backend\\venv\\Scripts\\python.exe';
const BIOCORE_APP_DIR = 'd:\\Projekt Hajs\\biocore_ai\\biocore_backend';

loadGatewayEnv();

export async function checkBioCoreBackend(port = 8000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { online: true, status: data.status || 'healthy', port };
    }
    return { online: false, status: `HTTP_${res.status}`, port };
  } catch (err) {
    return { online: false, error: err.message, port };
  }
}

export async function checkTelegramBot() {
  const bot = new TelegramBotGateway();
  if (!bot.botToken) {
    return { online: false, reason: 'TELEGRAM_BOT_TOKEN not configured in .env' };
  }
  try {
    const me = await bot.callApi('getMe');
    return {
      online: true,
      username: me.result?.username,
      allowedUsers: Array.from(bot.allowedUsers),
    };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

export function spawnBioCoreBackend() {
  if (!fs.existsSync(BIOCORE_PYTHON)) {
    throw new Error(`Python venv not found at ${BIOCORE_PYTHON}`);
  }
  const child = spawn(
    BIOCORE_PYTHON,
    ['-m', 'uvicorn', 'app.main:app', '--app-dir', BIOCORE_APP_DIR, '--host', '127.0.0.1', '--port', '8000'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.unref();
  return child.pid;
}

export function spawnTelegramGateway() {
  const scriptPath = path.join(ROOT_DIR, 'tools', 'gateway', 'run-gateway.mjs');
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export async function runHealthCheck(options = {}) {
  const autoStart = Boolean(options.start || process.argv.includes('--start'));

  console.log('🔍 Checking 24/7 background services health...\n');

  // 1. Check BioCore Backend
  const backend = await checkBioCoreBackend();
  if (backend.online) {
    console.log(`✅ BioCore Backend: ONLINE (http://127.0.0.1:${backend.port}/health)`);
  } else {
    console.log(`❌ BioCore Backend: OFFLINE (${backend.error || backend.status})`);
    if (autoStart) {
      try {
        const pid = spawnBioCoreBackend();
        console.log(`   🚀 Started BioCore Backend in background (PID: ${pid})`);
      } catch (err) {
        console.error(`   ⚠️ Failed to auto-start BioCore: ${err.message}`);
      }
    }
  }

  // 2. Check Telegram Gateway
  const tg = await checkTelegramBot();
  if (tg.online) {
    console.log(`✅ Telegram Bot Gateway: ONLINE (@${tg.username}, ${tg.allowedUsers.length} user authorized)`);
  } else {
    console.log(`❌ Telegram Bot Gateway: OFFLINE (${tg.reason || tg.error})`);
  }

  console.log('\n💡 Tip: Run `npm run services:start` or setup Windows Task Scheduler to keep them running 24/7.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runHealthCheck().catch((err) => {
    console.error('Health check error:', err);
    process.exit(1);
  });
}
