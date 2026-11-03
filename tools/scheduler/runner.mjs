#!/usr/bin/env node
/**
 * tools/scheduler/runner.mjs - Background Schedule Primitive & Non-Blocking Runner
 *
 * Implements Step 2 & Step 3 of Task 1:
 * - Declarative schedule loader for `schedule.yaml`.
 * - 5-part cron evaluation matching scheduled tasks (including daily at 20:00 `0 20 * * *`).
 * - Dispatches repeatable workspace tasks:
 *   1. Nightly workspace audit (`tools/check.mjs` & `tools/nightly-audit.mjs`)
 *   2. Memory rule budget check (`tools/memory/rule-budget.mjs`)
 *   3. Challenge lane heartbeat inspection
 * - Persistent masked logging in `.runs/scheduler/` and signal-driven alerting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskSecretValue } from '../hub-client.mjs';
import { enforceRuleBudget, loadProjectMemoryRules } from '../memory/rule-budget.mjs';
import { executeNightlyAudit } from '../nightly-audit.mjs';
import { redactOutbound } from '../sanitize.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE_ROOT = path.resolve(THIS_DIR, '..', '..');

/**
 * Matches an individual cron field against a target integer value.
 * @param {string} field
 * @param {number} val
 * @returns {boolean}
 */
export function matchCronField(field, val) {
  if (field === '*') {
    return true;
  }
  if (field.startsWith('*/')) {
    const step = Number.parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && val % step === 0;
  }
  if (field.includes(',')) {
    return field.split(',').some((sub) => matchCronField(sub.trim(), val));
  }
  if (field.includes('-')) {
    const [minStr, maxStr] = field.split('-');
    const min = Number.parseInt(minStr, 10);
    const max = Number.parseInt(maxStr, 10);
    return !Number.isNaN(min) && !Number.isNaN(max) && val >= min && val <= max;
  }
  return Number.parseInt(field, 10) === val;
}

/**
 * Matches a 5-part cron expression against a date.
 * Format: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6).
 * @param {string} cronExpr
 * @param {Date} [targetDate]
 * @param {boolean} [useUtc=true]
 * @returns {boolean}
 */
export function matchCron(cronExpr, targetDate = new Date(), useUtc = true) {
  if (!cronExpr || typeof cronExpr !== 'string') {
    return false;
  }
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const minute = useUtc ? targetDate.getUTCMinutes() : targetDate.getMinutes();
  const hour = useUtc ? targetDate.getUTCHours() : targetDate.getHours();
  const dom = useUtc ? targetDate.getUTCDate() : targetDate.getDate();
  const month = (useUtc ? targetDate.getUTCMonth() : targetDate.getMonth()) + 1;
  const dow = useUtc ? targetDate.getUTCDay() : targetDate.getDay();

  return (
    matchCronField(parts[0], minute) &&
    matchCronField(parts[1], hour) &&
    matchCronField(parts[2], dom) &&
    matchCronField(parts[3], month) &&
    matchCronField(parts[4], dow)
  );
}

function normalizeYamlValue(val) {
  if (val === 'true') {
    return true;
  }
  if (val === 'false') {
    return false;
  }
  return val;
}

function parseKeyValue(str) {
  const colonIdx = str.indexOf(':');
  if (colonIdx <= 0) {
    return null;
  }
  const key = str.slice(0, colonIdx).trim();
  const rawVal = str.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
  return { key, val: normalizeYamlValue(rawVal) };
}

function parseYamlTaskLine(trimmed, currentTask, tasks) {
  if (trimmed.startsWith('- ')) {
    if (currentTask) {
      tasks.push(currentTask);
    }
    const nextTask = {};
    const pair = parseKeyValue(trimmed.slice(2).trim());
    if (pair) {
      nextTask[pair.key] = pair.val;
    }
    return nextTask;
  }

  if (currentTask && trimmed.includes(':')) {
    const pair = parseKeyValue(trimmed);
    if (pair) {
      currentTask[pair.key] = pair.val;
    }
  }
  return currentTask;
}

/**
 * Lightweight deterministic YAML parser for schedule definitions.
 * @param {string} content
 * @returns {{ version: string, timezone: string, tasks: Array<Object> }}
 */
export function parseScheduleYaml(content) {
  const result = { version: '1.0', timezone: 'UTC', tasks: [] };
  if (!content || typeof content !== 'string') {
    return result;
  }

  const lines = content.split(/\r?\n/);
  let inTasks = false;
  let currentTask = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.startsWith('tasks:')) {
      inTasks = true;
      continue;
    }

    if (!inTasks) {
      const pair = parseKeyValue(trimmed);
      if (pair) {
        result[pair.key] = pair.val;
      }
      continue;
    }

    currentTask = parseYamlTaskLine(trimmed, currentTask, result.tasks);
  }

  if (currentTask) {
    result.tasks.push(currentTask);
  }

  return result;
}

/**
 * Task Handler: Nightly Workspace Audit
 */
export function handleAuditTask(workspaceRoot = WORKSPACE_ROOT) {
  const outcome = executeNightlyAudit({ cwd: workspaceRoot });
  return {
    ok: outcome.passed,
    auditId: outcome.auditId,
    reportPath: outcome.reportPath,
    message: `Nightly audit ${outcome.auditId}: ${outcome.passed ? 'PASSED' : 'FAILED'}`,
  };
}

/**
 * Task Handler: Memory Rule Budget Verification
 */
export function handleMemoryBudgetTask(workspaceRoot = WORKSPACE_ROOT) {
  const agentsMdPath = path.join(workspaceRoot, 'AGENTS.md');
  const agentsMdContent = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, 'utf8')
    : '';
  const memoryRules = loadProjectMemoryRules(workspaceRoot);

  const budget = enforceRuleBudget({
    agentsMdContent,
    rules: memoryRules,
    workspaceRoot,
  });

  return {
    ok: true,
    tokens: budget.tokens,
    bytes: budget.bytes,
    activeRulesCount: budget.activeRules.length,
    demotedCount: budget.demotedRules.length,
    message: `Rule budget verified: ${budget.tokens} tokens, ${budget.bytes} bytes. Active: ${budget.activeRules.length}, Demoted: ${budget.demotedRules.length}`,
  };
}

/**
 * Task Handler: Challenge Lane Heartbeat & Status Check
 */
export function handleLaneCheckTask(workspaceRoot = WORKSPACE_ROOT) {
  const candidatePaths = [
    path.join(workspaceRoot, 's01e05', 'starter', 'rig', 'var', 'heartbeat.json'),
    path.join(workspaceRoot, 'var', 'heartbeat.json'),
  ];

  let beatData = null;
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        beatData = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      } catch {
        // Continue searching
      }
    }
  }

  const laneId = process.env.LANE_ID || beatData?.laneId || 'lane-07';
  if (!beatData) {
    return {
      ok: true,
      laneId,
      status: 'idle',
      message: `Lane ${laneId}: No active heartbeat recorded (idle state).`,
    };
  }

  const beatTime = new Date(beatData.at).getTime();
  const ageMs = Date.now() - beatTime;
  const isFresh = ageMs < 5 * 60 * 1000; // Under 5 minutes

  return {
    ok: isFresh,
    laneId,
    status: isFresh ? 'healthy' : 'stale',
    ageSeconds: Math.floor(ageMs / 1000),
    message: `Lane ${laneId}: Heartbeat ${isFresh ? 'healthy' : 'stale'} (${Math.floor(ageMs / 1000)}s old).`,
  };
}

/**
 * Core Background Scheduler
 */
export class BackgroundScheduler {
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
    this.configPath =
      options.configPath || path.join(this.workspaceRoot, 'tools', 'scheduler', 'schedule.yaml');
    this.runsDir = options.runsDir || path.join(this.workspaceRoot, '.runs', 'scheduler');
    this.handlers = new Map();
    this.alertListeners = [];
    this.dispatcher = options.dispatcher || null;
    this.timer = null;

    // Register built-in default task handlers
    this.registerHandler('audit', () => handleAuditTask(this.workspaceRoot));
    this.registerHandler('memory_budget', () => handleMemoryBudgetTask(this.workspaceRoot));
    this.registerHandler('lane_check', () => handleLaneCheckTask(this.workspaceRoot));
  }

  registerHandler(action, fn) {
    this.handlers.set(action, fn);
  }

  onAlert(fn) {
    this.alertListeners.push(fn);
  }

  emitAlert(alert) {
    const masked = maskSecretValue(alert);
    if (this.dispatcher) {
      this.dispatcher
        .dispatch({
          type: alert.type || 'alert',
          title: alert.title || `Scheduler: ${alert.taskId || 'Task'}`,
          body: alert.message || '',
          priority: alert.ok === false ? 'high' : 'normal',
          metadata: masked,
        })
        .catch(() => {});
    }
    for (const listener of this.alertListeners) {
      try {
        listener(masked);
      } catch {
        // Contain listener errors
      }
    }
  }

  loadConfig() {
    if (!fs.existsSync(this.configPath)) {
      return { version: '1.0', timezone: 'UTC', tasks: [] };
    }
    const raw = fs.readFileSync(this.configPath, 'utf8');
    return parseScheduleYaml(raw);
  }

  recordDispatch(record) {
    fs.mkdirSync(this.runsDir, { recursive: true });
    const logPath = path.join(this.runsDir, 'dispatches.jsonl');
    const safeRecord = maskSecretValue(record);
    fs.appendFileSync(logPath, `${JSON.stringify(safeRecord)}\n`, 'utf8');
  }

  async dispatchTask(task, now = new Date()) {
    const handler = this.handlers.get(task.action);
    const startMs = Date.now();
    let outcome = null;

    try {
      if (!handler) {
        throw new Error(`No registered handler for action: ${task.action}`);
      }
      const res = await handler(this.workspaceRoot);
      outcome = {
        ok: res?.ok !== false,
        durationMs: Date.now() - startMs,
        details: res,
      };
    } catch (err) {
      outcome = {
        ok: false,
        durationMs: Date.now() - startMs,
        error: redactOutbound(err.message),
      };
    }

    const record = {
      taskId: task.id,
      action: task.action,
      cron: task.cron,
      timestamp: now.toISOString(),
      outcome,
    };

    this.recordDispatch(record);

    this.emitAlert({
      type: 'scheduler_dispatch',
      taskId: task.id,
      ok: outcome.ok,
      message: outcome.error || outcome.details?.message || `Task ${task.id} executed`,
      timestamp: now.toISOString(),
    });

    return record;
  }

  async tick(now = new Date()) {
    const config = this.loadConfig();
    const useUtc = config.timezone?.toUpperCase() === 'UTC';
    const executed = [];

    for (const task of config.tasks) {
      if (task.enabled === false) {
        continue;
      }
      if (matchCron(task.cron, now, useUtc)) {
        const record = await this.dispatchTask(task, now);
        executed.push(record);
      }
    }

    return { timestamp: now.toISOString(), executedCount: executed.length, executed };
  }

  start(intervalMs = 60000) {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

async function handleCliTick(scheduler, targetDate) {
  const res = await scheduler.tick(targetDate);
  console.log(`Tick at ${res.timestamp}: ${res.executedCount} task(s) dispatched.`);
  for (const item of res.executed) {
    console.log(`  - ${item.taskId} (${item.action}): ${item.outcome.ok ? 'OK' : 'FAIL'}`);
  }
  return 0;
}

async function handleCliRunNow(scheduler, targetId, targetDate) {
  const cfg = scheduler.loadConfig();
  const task = cfg.tasks.find((t) => t.id === targetId);
  if (!task) {
    console.error(`Task not found: ${targetId}`);
    return 1;
  }
  const res = await scheduler.dispatchTask(task, targetDate);
  console.log(`Dispatched ${res.taskId}: ${res.outcome.ok ? 'OK' : 'FAIL'}`);
  return res.outcome.ok ? 0 : 1;
}

/**
 * CLI Entrypoint
 */
export async function runCli(argv = process.argv) {
  const args = argv.slice(2);
  const scheduler = new BackgroundScheduler();

  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'MegaDEV Schedule Runner',
        'Usage:',
        '  node tools/scheduler/runner.mjs --tick [--now <ISO_DATE>]',
        '  node tools/scheduler/runner.mjs --run-now <task-id>',
      ].join('\n')
    );
    return 0;
  }

  const nowIdx = args.indexOf('--now');
  const targetDate = nowIdx !== -1 && args[nowIdx + 1] ? new Date(args[nowIdx + 1]) : new Date();

  if (args.includes('--tick')) {
    return handleCliTick(scheduler, targetDate);
  }

  const runIdx = args.indexOf('--run-now');
  if (runIdx !== -1 && args[runIdx + 1]) {
    return handleCliRunNow(scheduler, args[runIdx + 1], targetDate);
  }

  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
