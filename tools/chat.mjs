#!/usr/bin/env node
/**
 * tools/chat.mjs - Interactive terminal conversation CLI with OpenRouter & Gemini 4 Argon
 * Supports real-time streaming, conversation history, and model switching.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

const apiKey = process.env.OPENROUTER_API_KEY;

const MODEL_ALIASES = {
  argon: 'argon',
  'gemini-4-argon': 'argon',
  flash: 'deepseek/deepseek-v4.1-flash-1017',
  deepseek: 'deepseek/deepseek-v4.1-flash-1017',
  haiku: 'anthropic/claude-5.5-haiku',
  sonnet: 'anthropic/claude-3.5-sonnet',
  luna: 'openai/gpt-6-luna',
  gpt4o: 'openai/gpt-4o',
  llama: 'meta-llama/llama-3.3-70b-instruct',
};

let currentModel = 'deepseek/deepseek-v4.1-flash-1017';

const history = [
  {
    role: 'system',
    content:
      'You are a fast, concise, helpful AI programming companion running directly in the MegaDEV harness. Keep answers brief and direct.',
  },
];

console.log('\x1b[1m\x1b[32m=== MegaDEV Agent Chat CLI ===\x1b[0m');
console.log(`Default model: \x1b[33m${currentModel}\x1b[0m`);
console.log('Commands: \x1b[36m/model <name>\x1b[0m, \x1b[36m/clear\x1b[0m, \x1b[36m/exit\x1b[0m\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\x1b[1m\x1b[34myou > \x1b[0m',
});

rl.prompt();

// Call Gemini 4 Argon via claude.cmd CLI
async function callArgon(promptText) {
  return new Promise((resolve, reject) => {
    const claudeBin = path.join(__dirname, '..', 'bin', 'claude.cmd');
    const child = spawn('cmd.exe', ['/c', claudeBin, '-p', promptText], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(d.toString());
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Argon exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', reject);
  });
}

function parseSseLine(rawLine) {
  const l = rawLine.trim();
  if (!l.startsWith('data:')) {
    return null;
  }
  const jsonStr = l.slice(5).trim();
  if (jsonStr === '[DONE]') {
    return '[DONE]';
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.choices?.[0]?.delta?.content || null;
  } catch (_) {
    return null;
  }
}

async function streamOpenRouter(model, messages) {
  if (!apiKey) {
    console.log('\n\x1b[31mError: OPENROUTER_API_KEY required for OpenRouter models.\x1b[0m\n');
    return null;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/megadev',
      'X-Title': 'Antigravity Chat CLI',
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.log(`\n\x1b[31mError ${response.status}: ${errText}\x1b[0m\n`);
    return null;
  }

  let assistantText = '';
  const decoder = new TextDecoder('utf8');

  for await (const chunk of response.body) {
    const str = decoder.decode(chunk, { stream: true });
    for (const rawL of str.split('\n')) {
      const delta = parseSseLine(rawL);
      if (delta === '[DONE]') {
        break;
      }
      if (delta) {
        process.stdout.write(delta);
        assistantText += delta;
      }
    }
  }

  process.stdout.write('\n\n');
  return assistantText;
}

function handleCommand(line) {
  if (line === '/exit' || line === 'exit' || line === 'quit') {
    console.log('\x1b[90mGoodbye!\x1b[0m');
    process.exit(0);
  }

  if (line === '/clear') {
    history.length = 1;
    console.log('\x1b[90mConversation history cleared.\x1b[0m\n');
    return true;
  }

  if (line.startsWith('/model')) {
    const parts = line.split(/\s+/);
    if (parts[1]) {
      const alias = parts[1].toLowerCase();
      currentModel = MODEL_ALIASES[alias] || parts[1];
      console.log(`\x1b[90mSwitched model to: \x1b[1m\x1b[33m${currentModel}\x1b[0m\n`);
    } else {
      console.log(`\x1b[90mCurrent model: \x1b[1m\x1b[33m${currentModel}\x1b[0m\n`);
    }
    return true;
  }

  return false;
}

async function handleUserInput(line) {
  history.push({ role: 'user', content: line });
  rl.pause();

  const shortName = currentModel.split('/').pop() || currentModel;
  process.stdout.write(`\x1b[1m\x1b[36m${shortName} > \x1b[0m`);

  try {
    if (currentModel === 'argon' || currentModel === 'google/gemini-4-argon') {
      const promptChain = history
        .filter((m) => m.role !== 'system')
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');

      const responseText = await callArgon(promptChain);
      process.stdout.write('\n');
      history.push({ role: 'assistant', content: responseText });
    } else {
      const assistantText = await streamOpenRouter(currentModel, history);
      if (assistantText) {
        history.push({ role: 'assistant', content: assistantText });
      }
    }
  } catch (err) {
    console.log(`\n\x1b[31mError: ${err.message}\x1b[0m\n`);
  }

  rl.resume();
  rl.prompt();
}

rl.on('line', async (rawLine) => {
  const line = rawLine.trim();
  if (!line) {
    rl.prompt();
    return;
  }

  if (handleCommand(line)) {
    rl.prompt();
    return;
  }

  await handleUserInput(line);
});

rl.on('close', () => {
  console.log('\n\x1b[90mGoodbye!\x1b[0m');
  process.exit(0);
});
