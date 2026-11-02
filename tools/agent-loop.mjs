#!/usr/bin/env node
/**
 * tools/agent-loop.mjs - Canonical guarded agent loop for MegaDEV (AGENTS.md section 7).
 *
 * Every agent loop in this workspace must run through runAgent(). It enforces, per model:
 * - maxSteps / maxOutputTokens / timeoutMs from tools/model-limits.json (mean * 1.5 of real usage)
 * - unknown tools and thrown tool errors become tool results instead of crashes
 * - default tool policy: paths stay inside the workspace, secrets (.env, keys) are never read,
 *   shell commands must match an allowlist and may not chain or redirect
 * - hooks return decisions: beforeTool -> { block, reason, call }, afterTool -> replacement result
 * - tool results are capped, cut answers (finish_reason "length") are reported, token budget,
 *   AbortSignal and a clean step-limit stop.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLimits } from './model-limits.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIMITS_PATH = path.join(THIS_DIR, 'model-limits.json');
export const DEFAULT_RESULT_CHARS = 8000;

export const SECRET_PATH = /(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials.*\.json|mcp_config\.json)$/i;
const SHELL_META = /[;&|`<>]|\$\(/;

let cachedDoc = null;

export function loadLimitsDoc(limitsPath = DEFAULT_LIMITS_PATH) {
  if (limitsPath === DEFAULT_LIMITS_PATH && cachedDoc) {
    return cachedDoc;
  }
  const doc = JSON.parse(fs.readFileSync(limitsPath, 'utf-8'));
  if (limitsPath === DEFAULT_LIMITS_PATH) {
    cachedDoc = doc;
  }
  return doc;
}

export function truncate(text, max = DEFAULT_RESULT_CHARS) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n[truncated ${s.length - max} chars]` : s;
}

function insideRoot(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(root, String(target ?? '')));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function checkPathArguments(args, root) {
  for (const key of ['path', 'file', 'filePath', 'file_path']) {
    const val = args[key];
    if (val === undefined) {
      continue;
    }
    if (!insideRoot(root, val)) {
      return `path outside workspace: ${val}`;
    }
    if (SECRET_PATH.test(String(val))) {
      return `secret file is never readable by agents: ${val}`;
    }
  }
  return null;
}

function checkCommandArgument(command, allow) {
  if (command === undefined) {
    return null;
  }
  const cmd = String(command).trim();
  if (SHELL_META.test(cmd)) {
    return 'shell chaining, pipes and redirects are not allowed';
  }
  if (/\.env\b/i.test(cmd)) {
    return 'commands touching .env are not allowed';
  }
  if (!allow.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `))) {
    return `command not in allowlist: ${cmd.split(/\s+/)[0]}`;
  }
  return null;
}

export function guardToolCall(call, policy = {}) {
  const root = policy.root ?? process.cwd();
  const allow = policy.allowCommands ?? [];
  const args = call?.arguments ?? {};
  
  const pathErr = checkPathArguments(args, root);
  if (pathErr) {
    return { block: true, reason: pathErr };
  }
  const cmdErr = checkCommandArgument(args.command, allow);
  if (cmdErr) {
    return { block: true, reason: cmdErr };
  }
  return { block: false };
}

function asError(message) {
  return JSON.stringify({ error: message });
}

async function executeToolCall(fn, effective, ctx, state) {
  try {
    const raw = await fn(effective.arguments ?? {}, { signal: ctx.signal });
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    let replaced = null;
    try {
      replaced = await ctx.hooks.afterTool?.(state, text, effective);
    } catch (hookErr) {
      console.error(`[agent-loop] afterTool hook error: ${hookErr?.message ?? String(hookErr)}`);
    }
    return truncate(replaced ?? text, ctx.maxResultChars);
  } catch (err) {
    return asError(err?.message ?? String(err));
  }
}

async function resolveEffectiveCall(call, state, ctx) {
  const policyDecision = guardToolCall(call, ctx.policy);
  if (policyDecision.block) {
    return { error: asError(`blocked: ${policyDecision.reason}`) };
  }
  let decision = {};
  try {
    decision = (await ctx.hooks.beforeTool?.(state, call)) ?? {};
  } catch (hookErr) {
    return { error: asError(`beforeTool hook error: ${hookErr?.message ?? String(hookErr)}`) };
  }
  if (decision.block) {
    return { error: asError(`blocked: ${decision.reason ?? 'beforeTool hook'}`) };
  }
  const effective = decision.call ?? call;
  const finalGuard = guardToolCall(effective, ctx.policy);
  if (finalGuard.block) {
    return { error: asError(`blocked: ${finalGuard.reason}`) };
  }
  return { effective };
}

async function runTool(state, call, ctx) {
  const resolution = await resolveEffectiveCall(call, state, ctx);
  if (resolution.error) {
    return resolution.error;
  }
  const effective = resolution.effective;
  const fn = Object.hasOwn(ctx.tools, effective.name) ? ctx.tools[effective.name] : null;
  if (typeof fn !== 'function') {
    return asError(`unknown tool ${effective.name}`);
  }
  return executeToolCall(fn, effective, ctx, state);
}

async function runTools(state, calls, ctx) {
  const parallel = calls.every((c) => ctx.readOnlyTools.has(c.name));
  if (parallel) {
    return Promise.all(calls.map((c) => runTool(state, c, ctx)));
  }
  const results = [];
  for (const c of calls) {
    results.push(await runTool(state, c, ctx));
  }
  return results;
}

function stepSignal(ctx) {
  const timeout = ctx.limits.timeoutMs ? AbortSignal.timeout(ctx.limits.timeoutMs) : null;
  const signals = [ctx.signal, timeout].filter(Boolean);
  return signals.length ? AbortSignal.any(signals) : undefined;
}

function result(end, text, state, step) {
  return { end, text, steps: step, usage: state.usage, model: state.model, limits: state.limits };
}

function createContext(options) {
  const doc = options.limitsDoc ?? loadLimitsDoc(options.limitsPath);
  const resolved = resolveLimits(doc, options.model);
  const limits = { ...resolved.limits, ...(options.overrides ?? {}) };
  return {
    limits,
    resolvedModel: resolved.model,
    tools: options.tools ?? {},
    hooks: options.hooks ?? {},
    policy: options.policy ?? {},
    signal: options.signal,
    readOnlyTools: new Set(options.readOnlyTools ?? []),
    maxResultChars: options.maxResultChars ?? DEFAULT_RESULT_CHARS,
    budgetTokens: options.budgetTokens ?? Number.POSITIVE_INFINITY,
    schemas: options.toolSchemas ?? [],
  };
}

async function invokeModel(state, ctx, generateFn, step) {
  try {
    await ctx.hooks.beforeModel?.(state);
  } catch (hookErr) {
    console.error(`[agent-loop] beforeModel hook error: ${hookErr?.message ?? String(hookErr)}`);
  }
  try {
    const response = await generateFn({
      ...state.settings,
      messages: state.messages,
      tools: ctx.schemas,
      signal: stepSignal(ctx),
    });
    return { ok: true, response };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const why = timedOut ? `model call exceeded ${ctx.limits.timeoutMs}ms` : (err?.message ?? String(err));
    const end = ctx.signal?.aborted ? 'aborted' : 'error';
    return { ok: false, errorResult: result(end, `Model call failed: ${why}`, state, step) };
  }
}

export function resolveLamarckExecutable() {
  const possiblePaths = [
    process.env.LAMARCK_BIN,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'lamarck', 'dist', 'cli.js') : null,
    path.join(process.cwd(), 'node_modules', 'lamarck', 'dist', 'cli.js'),
  ].filter(Boolean);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return { command: process.execPath, args: [p] };
    }
  }

  const isWin = process.platform === 'win32';
  return { command: isWin ? 'lamarck.cmd' : 'lamarck', args: [] };
}

export function triggerLamarckAfterRun({
  workspaceRoot = process.cwd(),
  sessionId = null,
  claudeBin = null,
  background = true,
} = {}) {
  if (process.env.LAMARCK_ACTIVE === '1') {
    return { triggered: false, reason: 'reentrant' };
  }

  if (sessionId && !/^[\w-]{1,64}$/.test(sessionId)) {
    return { triggered: false, error: `Invalid sessionId: ${sessionId}` };
  }

  const env = { ...process.env, LAMARCK_ACTIVE: '1' };
  const candidateClaude = claudeBin ?? path.join(workspaceRoot, 'bin', 'claude.cmd');
  if (fs.existsSync(candidateClaude)) {
    env.CLAUDE_BIN = candidateClaude;
  }

  const execInfo = resolveLamarckExecutable();
  const cliArgs = [...execInfo.args, '--project', workspaceRoot];
  if (sessionId) {
    cliArgs.push('--session-id', sessionId);
  }

  try {
    if (background) {
      const child = spawn(execInfo.command, cliArgs, {
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => {
        console.error(`[agent-loop] Lamarck background spawn error: ${err.message}`);
      });
      child.unref();
      return { triggered: true, background: true };
    }
    const res = spawnSync(execInfo.command, cliArgs, { env, encoding: 'utf-8' });
    if (res.error) {
      return { triggered: false, background: false, error: res.error.message };
    }
    if (res.status !== 0) {
      return {
        triggered: false,
        background: false,
        status: res.status,
        error: (res.stderr || '').trim() || `Process exited with code ${res.status}`,
      };
    }
    return { triggered: true, background: false, status: res.status, output: res.stdout };
  } catch (err) {
    return { triggered: false, error: err?.message ?? String(err) };
  }
}

function handleTerminalResponse(response, state, ctx, step) {
  const cut = response.finishReason === 'length' || response.finishReason === 'max_output_tokens';
  return cut
    ? result('truncated', `${response.text ?? ''}\n\n[cut at ${ctx.limits.maxOutputTokens} output tokens]`, state, step)
    : result('answer', response.text ?? '', state, step);
}

export async function runAgent(options) {
  if (!options?.llm?.generate) {
    throw new Error('runAgent needs an llm adapter with generate()');
  }
  const ctx = createContext(options);
  const state = {
    model: options.model,
    limits: ctx.limits,
    usage: 0,
    messages: [...(options.messages ?? []), { role: 'user', content: options.query }],
    settings: { model: options.model, max_tokens: ctx.limits.maxOutputTokens },
  };

  const finish = async (res) => {
    if (options.autoLamarck !== false && res?.end === 'answer') {
      triggerLamarckAfterRun({
        workspaceRoot: ctx.policy?.root ?? process.cwd(),
        sessionId: options.sessionId,
        background: true,
      });
    }
    try {
      await ctx.hooks.afterRun?.({ result: res, state, ctx });
    } catch (hookErr) {
      console.error(`[agent-loop] afterRun hook error: ${hookErr?.message ?? String(hookErr)}`);
    }
    return res;
  };

  for (let step = 1; step <= ctx.limits.maxSteps; step++) {
    if (ctx.signal?.aborted) {
      return finish(result('aborted', 'Run aborted by caller.', state, step - 1));
    }
    const inv = await invokeModel(state, ctx, options.llm.generate, step);
    if (!inv.ok) {
      return finish(inv.errorResult);
    }
    const response = inv.response;
    state.messages.push(response.message ?? { role: 'assistant', content: response.text ?? '' });
    state.usage += response.usage?.total_tokens ?? 0;
    const calls = response.toolCalls ?? [];

    if (calls.length === 0) {
      return finish(handleTerminalResponse(response, state, ctx, step));
    }
    if (state.usage > ctx.budgetTokens) {
      return finish(result('budget', `Stopped: token budget ${ctx.budgetTokens} exceeded (${state.usage}).`, state, step));
    }

    const outputs = await runTools(state, calls, ctx);
    calls.forEach((call, i) => {
      state.messages.push({ role: 'tool', tool_call_id: call.id, content: outputs[i] });
    });
  }
  return finish(
    result(
      'step_limit',
      `Stopped at the step limit (${ctx.limits.maxSteps} steps) without a final answer.`,
      state,
      ctx.limits.maxSteps
    )
  );
}
