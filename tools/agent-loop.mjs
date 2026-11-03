#!/usr/bin/env node
/**
 * tools/agent-loop.mjs - Canonical guarded agent loop for MegaDEV (AGENTS.md sections 7 & 8).
 *
 * Every agent loop in this workspace must run through runAgent(). It enforces, per model:
 * - maxSteps / maxOutputTokens / timeoutMs from tools/model-limits.json (mean * 1.5 of real usage)
 * - unknown tools and thrown tool errors become tool results instead of crashes
 * - default tool policy: paths stay inside the workspace, secrets (.env, keys) are never read,
 *   shell commands must match an allowlist and may not chain or redirect
 * - hooks return decisions: beforeTool -> { block, reason, call }, afterTool -> replacement result
 * - tool results are capped, cut answers (finish_reason "length") are reported, token budget,
 *   AbortSignal and a clean step-limit stop.
 * - Section 8: Contextual recall pre-injection and durable resumable tool approvals.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_JOURNAL_PATH, appendJournalEntry, readJournalEntries } from './journal.mjs';
import { indexDirectories, recallContext } from './memory/contextual-recall.mjs';
import { resolveLimits } from './model-limits.mjs';
import { createSuspension, loadSuspension, resolveSuspension } from './resumable-approval.mjs';
import { redactOutbound } from './sanitize.mjs';

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

/**
 * Canonical model tiers for dynamic agent routing.
 */
export const DEFAULT_ROUTER_CONFIG = {
  lightweightModel: 'deepseek/deepseek-v4.1-flash-20260910',
  reasoningModel: 'anthropic/claude-haiku-5.5-20261007',
};

export const SECURITY_SENSITIVE_PATTERN =
  /\b(security|vulnerab|exploit|secret|credential|encrypt|auth\b|compliance|gdpr|phi|pii)\b/i;

/**
 * Simple router rule in the agent loop routing straightforward validation commands to a
 * lightweight model while reserving larger reasoning models for architecture and complex code generation.
 */
export function routeModel(input, options = {}) {
  const config = { ...DEFAULT_ROUTER_CONFIG, ...options };
  if (options.explicitModel) {
    return { model: options.explicitModel, category: 'explicit', reason: 'Explicit model requested' };
  }

  const rawText = typeof input === 'string' ? input : String(input?.query || input?.instruction || input?.command || '');
  const text = rawText.slice(0, 4096);
  const taskType = input?.taskType || options.taskType;

  // Security-sensitive tasks must never downgrade to lightweight models
  if (SECURITY_SENSITIVE_PATTERN.test(text)) {
    return {
      model: config.reasoningModel,
      category: 'reasoning',
      reason: 'Security-sensitive task routed to reasoning model for thorough analysis',
    };
  }

  if (taskType === 'validation' || taskType === 'lightweight') {
    return { model: config.lightweightModel, category: 'validation', reason: 'Explicit validation task type' };
  }
  if (taskType === 'reasoning' || taskType === 'architecture' || taskType === 'codegen') {
    return { model: config.reasoningModel, category: 'reasoning', reason: 'Explicit reasoning task type' };
  }

  // Straightforward validation commands, static checks, tests, diffs, and health probes
  const isValidation =
    /^(node\s+(--test|tools[\\/]check\.mjs)|npm(\.cmd)?\s+(test|run\s+test|run\s+check)|git\s+(status|diff|log)|mex\s+check|tsc\b|biome\b|tools[\\/]check\.mjs|validate|verify|audit|lint|format|health-check)/i.test(
      text.trim(),
    ) ||
    /\b(run\s+(tests?|checks?|lint|build)|verify\s+(tests?|code|types)|validate\s+handoff|check\s+status|health\s+check|check\.mjs)\b/i.test(
      text,
    );

  if (isValidation) {
    return {
      model: config.lightweightModel,
      category: 'validation',
      reason: 'Routed to lightweight model for straightforward validation/command check',
    };
  }

  return {
    model: config.reasoningModel,
    category: 'reasoning',
    reason: 'Routed to reasoning model for architecture, multi-file changes or complex code generation',
  };
}

/**
 * Helper to inspect entries from the append-only journal during agent execution.
 */
export function inspectJournalEntries(options = {}) {
  return readJournalEntries(options);
}

/**
 * Creates an agent-callable inspection tool exposing the persistent journal ledger.
 */
export function createJournalInspectionTool(options = {}) {
  const targetPath = options.journalPath ?? DEFAULT_JOURNAL_PATH;
  return async function inspect_journal(args = {}) {
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
    const entries = readJournalEntries({
      journalPath: targetPath,
      action_type: args.action_type,
      actor_id: args.actor_id,
      day: args.day,
    });
    const slice = entries.slice(-limit);
    return JSON.stringify(slice);
  };
}

function insideRoot(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, String(target ?? ''));
  const rel = path.relative(rootAbs, targetAbs);
  return rel !== '' && rel !== '.' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

function checkPathArguments(args, root) {
  for (const key of ['path', 'file', 'filePath', 'file_path', 'cwd', 'dir', 'directory', 'target', 'folder']) {
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

function recordToolJournal(ctx, effective, outcome, err) {
  if (!ctx.journalToolCalls) {
    return;
  }
  const isSuccess = !err;
  const rawSummary = isSuccess
    ? `Executed tool '${effective.name}' successfully`
    : `Failed tool '${effective.name}': ${err?.message ?? String(err)}`;
  const safeSummary = redactOutbound(rawSummary.replace(/[\r\n\t]/g, ' ').slice(0, 512));

  try {
    appendJournalEntry(
      {
        actor_id: ctx.actorId,
        action_type: 'tool_call',
        summary: safeSummary,
        payload: {
          tool: effective.name,
          arguments: effective.arguments ?? {},
          outcome: outcome ?? null,
          error: err ? (err?.message ?? String(err)) : null,
          success: isSuccess,
        },
      },
      { journalPath: ctx.journalPath },
    );
  } catch (jErr) {
    console.error(`[agent-loop] Journal append error: ${jErr?.message ?? String(jErr)}`);
  }
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
    const finalOutcome = truncate(replaced ?? text, ctx.maxResultChars);
    recordToolJournal(ctx, effective, finalOutcome, null);
    return finalOutcome;
  } catch (err) {
    const errText = asError(err?.message ?? String(err));
    recordToolJournal(ctx, effective, null, err);
    return errText;
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
  return {
    end,
    text,
    steps: step,
    usage: state.usage,
    model: state.model,
    routing: state.routing ?? undefined,
    limits: state.limits,
  };
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
    approvalRequiredTools: new Set(options.approvalRequiredTools ?? []),
    approvalPolicy: options.approvalPolicy,
    approvalsDir: options.approvalsDir,
    maxResultChars: options.maxResultChars ?? DEFAULT_RESULT_CHARS,
    budgetTokens: options.budgetTokens ?? Number.POSITIVE_INFINITY,
    schemas: options.toolSchemas ?? [],
    contextualRecall: options.contextualRecall,
    journalToolCalls: options.journalToolCalls ?? (options.journal === true || Boolean(options.journalPath)),
    journalPath: options.journalPath ?? DEFAULT_JOURNAL_PATH,
    actorId: options.actorId ?? options.model ?? 'agent-loop',
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

function initContextualRecall(options, ctx, state) {
  if (!ctx.contextualRecall || !options.query) {
    return;
  }
  let index = ctx.contextualRecall.index;
  if (!index && Array.isArray(ctx.contextualRecall.corpusDirs)) {
    index = indexDirectories(ctx.contextualRecall.corpusDirs, {
      workspaceRoot: ctx.policy?.root ?? process.cwd(),
    });
  }
  if (!index) {
    return;
  }
  const recalled = recallContext(options.query, index, ctx.contextualRecall);
  if (recalled.results.length > 0 && recalled.formattedPrompt) {
    state.contextualRecall = recalled.results;
    state.messages.unshift({ role: 'system', content: recalled.formattedPrompt });
  }
}

function checkApprovalSuspension(calls, state, ctx, options, step) {
  for (const c of calls) {
    const isRequired = ctx.approvalRequiredTools.has(c.name);
    const policyResult = ctx.approvalPolicy?.(c, state);
    if (isRequired || policyResult?.needsApproval) {
      const prompt = policyResult?.prompt || `Tool "${c.name}" requires user approval before execution.`;
      const suspension = createSuspension({
        toolCall: c,
        state: { ...state, step },
        prompt,
        sessionId: options.sessionId,
        runId: options.runId,
        approvalsDir: ctx.approvalsDir,
        workspaceRoot: ctx.policy?.root ?? process.cwd(),
      });
      return {
        ...result('suspended', `Execution suspended: tool "${c.name}" requires user approval (${suspension.approvalId})`, state, step),
        approvalId: suspension.approvalId,
        suspensionPath: suspension.filePath,
        toolCall: c,
        approvalPrompt: prompt,
      };
    }
  }
  return null;
}

function createFinishCallback(options, ctx, state) {
  return async (res) => {
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
}

async function executeStepTools(calls, state, ctx) {
  const outputs = await runTools(state, calls, ctx);
  for (let i = 0; i < calls.length; i++) {
    state.messages.push({ role: 'tool', tool_call_id: calls[i].id, content: outputs[i] });
  }
}

async function runAgentLoop(startStep, state, ctx, options, finish) {
  for (let step = startStep; step <= ctx.limits.maxSteps; step++) {
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

    const suspended = checkApprovalSuspension(calls, state, ctx, options, step);
    if (suspended) {
      return finish(suspended);
    }

    await executeStepTools(calls, state, ctx);
  }
  return finish(result('step_limit', `Stopped at the step limit (${ctx.limits.maxSteps} steps) without a final answer.`, state, ctx.limits.maxSteps));
}

export async function runAgent(options) {
  if (!options?.llm?.generate) {
    throw new Error('runAgent needs an llm adapter with generate()');
  }

  let routing = null;
  let selectedModel = options.model;
  if (!selectedModel || options.autoRoute) {
    routing = routeModel({ query: options.query, taskType: options.taskType }, options.routerConfig);
    selectedModel = routing.model;
  }

  const effectiveOptions = {
    ...options,
    model: selectedModel,
  };

  const ctx = createContext(effectiveOptions);
  const state = {
    model: selectedModel,
    routing,
    limits: ctx.limits,
    usage: 0,
    messages: [...(options.messages ?? []), { role: 'user', content: options.query }],
    settings: { model: selectedModel, max_tokens: ctx.limits.maxOutputTokens },
  };

  initContextualRecall(options, ctx, state);
  const finish = createFinishCallback(effectiveOptions, ctx, state);
  return runAgentLoop(1, state, ctx, effectiveOptions, finish);
}

function resolvePendingRecord(options, workspaceRoot) {
  let record = loadSuspension(options.approvalId, {
    approvalsDir: options.approvalsDir,
    workspaceRoot,
  });

  if (options.decision) {
    record = resolveSuspension(options.approvalId, {
      decision: options.decision,
      responder: options.responder ?? 'user',
      feedback: options.feedback ?? '',
      approvalsDir: options.approvalsDir,
      workspaceRoot,
    });
  }

  if (record.status !== 'approved' && record.status !== 'rejected') {
    throw new Error(`Cannot resume execution for approval "${options.approvalId}": status is "${record.status}"`);
  }
  return record;
}

export async function resumeAgent(options) {
  if (!options?.approvalId) {
    throw new Error('resumeAgent requires an approvalId');
  }
  if (!options?.llm?.generate) {
    throw new Error('resumeAgent needs an llm adapter with generate()');
  }

  const workspaceRoot = options.workspaceRoot ?? options.policy?.root ?? process.cwd();
  const record = resolvePendingRecord(options, workspaceRoot);

  const ctx = createContext(options);
  const state = {
    model: options.model ?? record.state.model,
    limits: ctx.limits,
    usage: record.state.usage ?? 0,
    messages: [...record.state.messages],
    settings: {
      model: options.model ?? record.state.model,
      max_tokens: ctx.limits.maxOutputTokens,
      ...(record.state.settings ?? {}),
    },
  };

  const finish = createFinishCallback(options, ctx, state);
  if (record.status === 'approved') {
    const toolOutput = await runTool(state, record.toolCall, ctx);
    state.messages.push({ role: 'tool', tool_call_id: record.toolCall.id, content: toolOutput });
  } else {
    state.messages.push({
      role: 'tool',
      tool_call_id: record.toolCall.id,
      content: JSON.stringify({ error: `Tool execution rejected by user: ${record.feedback || 'User denied permission'}` }),
    });
  }

  return runAgentLoop((record.state.step ?? 1) + 1, state, ctx, options, finish);
}
