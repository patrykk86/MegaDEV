#!/usr/bin/env node
/**
 * tools/gateway/task-bridge.mjs - Two-Way Task Bridge between Mobile Telegram and Antigravity IDE
 *
 * Implements:
 * 1. Mobile Task Enqueueing: /task <instruction> stores tasks for Antigravity coding execution.
 * 2. Mobile Approvals: /approve <id> and /reject <id> resolve durable tool suspensions.
 * 3. Outbound Review Dispatch: When Antigravity completes a task, the detailed review is sent to Telegram.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSuspension } from '../resumable-approval.mjs';
import { redactOutbound, sanitizeInput } from '../sanitize.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = path.join(ROOT_DIR, '.runs');
const TASKS_FILE = path.join(RUNS_DIR, 'inbound-tasks.jsonl');
const APPROVAL_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOWS_RESERVED_REGEX = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function resolveTasksFile(options = {}) {
  const dir = options.runsDir || process.env.MEGADEV_RUNS_DIR || RUNS_DIR;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return path.join(dir, 'inbound-tasks.jsonl');
}

/**
 * Validates that an approval ID matches strict alphanumeric format and prevents path traversal
 * and Windows reserved device names.
 */
export function isValidApprovalId(approvalId) {
  if (typeof approvalId !== 'string') {
    return false;
  }
  const trimmed = approvalId.trim();
  return APPROVAL_ID_REGEX.test(trimmed) && !WINDOWS_RESERVED_REGEX.test(trimmed);
}

/**
 * Enqueues a new coding/agent task from mobile or external channels after sanitizing input.
 */
export function enqueueTask(instruction, author = 'telegram', metadata = {}, options = {}) {
  const tasksFile = resolveTasksFile(options);
  const sanitized = sanitizeInput(String(instruction ?? ''), { neutralizeInjections: true });
  const id = `task-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const record = {
    id,
    author: String(author),
    instruction: sanitized.cleanText.trim(),
    status: 'pending',
    createdAt: nowIso,
    heartbeat: nowIso,
    completedAt: null,
    result: null,
    metadata: {
      ...metadata,
      suspicious: sanitized.isSuspicious,
      threats: sanitized.threats ?? [],
    },
  };

  fs.appendFileSync(tasksFile, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Reads all tasks from disk line-by-line, skipping corrupted lines instead of failing open.
 */
export function loadAllTasks(options = {}) {
  const tasksFile = resolveTasksFile(options);
  if (!fs.existsSync(tasksFile)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(tasksFile, 'utf8').trim();
    if (!raw) {
      return [];
    }
    const records = [];
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        console.warn(`[task-bridge] Skipping corrupted JSONL line: ${err.message}`);
      }
    }
    return records;
  } catch (err) {
    console.error(`[task-bridge] Error reading tasks file: ${err.message}`);
    return [];
  }
}

/**
 * Retrieves pending tasks awaiting execution by Antigravity.
 */
export function getPendingTasks(options = {}) {
  return loadAllTasks(options).filter((t) => t.status === 'pending');
}

async function dispatchTaskReview(
  bot,
  updatedRecord,
  { summary, filesModified, testStatus, reviewerVerdict },
) {
  if (!bot || typeof bot.sendMessage !== 'function') {
    return;
  }
  try {
    const targetChatId = updatedRecord.metadata?.chatId || bot.defaultChatId;
    if (bot.botToken && targetChatId) {
      const reviewLines = [
        `🎉 *Task ${updatedRecord.id} Completed by Antigravity!*`,
        '',
        `*Instruction:* ${updatedRecord.instruction}`,
        '',
        `*Summary:* ${summary || 'Code changes and tests completed successfully.'}`,
        '',
        `- Files Modified: ${filesModified.length > 0 ? filesModified.join(', ') : 'None'}`,
        `- Tests: ${testStatus === 'passed' ? '✅ 100% Passed' : `⚠️ ${testStatus}`}`,
      ];
      if (reviewerVerdict) {
        reviewLines.push(`- Reviewer Verdict: ${reviewerVerdict}`);
      }
      await bot.sendMessage(targetChatId, reviewLines.join('\n'));
    }
  } catch (err) {
    console.error(`[task-bridge] Failed to dispatch review: ${redactOutbound(err.message)}`);
  }
}

/**
 * Marks a task as completed and sends an outbound review digest to Telegram.
 */
export async function completeTask(
  taskId,
  { summary, filesModified = [], testStatus = 'passed', reviewerVerdict = '' } = {},
  options = {},
) {
  const tasksFile = resolveTasksFile(options);
  const tasks = loadAllTasks(options);
  let updatedRecord = null;

  for (const t of tasks) {
    if (t.id === taskId) {
      const nowIso = new Date().toISOString();
      t.status = 'completed';
      t.heartbeat = nowIso;
      t.completedAt = nowIso;
      t.result = { summary, filesModified, testStatus, reviewerVerdict };
      updatedRecord = t;
      break;
    }
  }

  if (!updatedRecord) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Rewrite tasks file atomically via process-unique temp file
  const tempFile = `${tasksFile}.${process.pid}.${Date.now()}.tmp`;
  const lines = tasks.map((t) => JSON.stringify(t)).join('\n');
  fs.writeFileSync(tempFile, `${lines}\n`, 'utf8');
  fs.renameSync(tempFile, tasksFile);

  const bot = options.bot || null;
  await dispatchTaskReview(bot, updatedRecord, { summary, filesModified, testStatus, reviewerVerdict });
  return updatedRecord;
}

/**
 * Handles /approve or /reject command from Telegram with strict ID format validation.
 */
export function handleApprovalDecision(approvalId, decisionOrApproved, feedback = '', options = {}) {
  const cleanId = String(approvalId ?? '').trim();
  if (!isValidApprovalId(cleanId)) {
    throw new Error(`Invalid approval ID format: "${cleanId}". Must match ${APPROVAL_ID_REGEX}`);
  }
  let decision = decisionOrApproved;
  if (typeof decisionOrApproved === 'boolean') {
    decision = decisionOrApproved ? 'approved' : 'rejected';
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new TypeError(`Decision must be "approved" or "rejected", received "${decision}"`);
  }
  const defaultFeedback = `${decision[0].toUpperCase()}${decision.slice(1)} via Telegram Mobile`;
  return resolveSuspension(cleanId, {
    decision,
    feedback: feedback || defaultFeedback,
    workspaceRoot: options.workspaceRoot || ROOT_DIR,
    approvalsDir: options.approvalsDir,
  });
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30_000;
const MAX_STATE_PATCH_BYTES = 32_768;

const TERMINAL_STATES = new Map([
  ['completed', 'completed'],
  ['done', 'completed'],
  ['failed', 'failed'],
  ['error', 'failed'],
  ['rejected', 'failed'],
  ['canceled', 'canceled'],
  ['cancelled', 'canceled'],
]);

const WAITING_STATES = new Set(['waiting', 'input-required', 'suspended']);
const ACTIVE_STATES = new Set(['working', 'pending', 'running']);
const ALLOWED_PATCH_KEYS = new Set([
  'status',
  'step',
  'progress',
  'result',
  'summary',
  'error',
  'metadata',
  'completedAt',
  'completed_at',
]);

function isKnownJobStatus(status) {
  if (typeof status !== 'string') {
    return false;
  }
  const norm = status.toLowerCase();
  return TERMINAL_STATES.has(norm) || WAITING_STATES.has(norm) || ACTIVE_STATES.has(norm);
}

function parseIsoTimestampMs(value) {
  if (typeof value !== 'string' || value.length > 64) {
    return null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const tzHour = match[9] ? Number(match[10]) : 0;
  const tzMin = match[9] ? Number(match[11]) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    tzHour > 23 ||
    tzMin > 59
  ) {
    return null;
  }
  const probeUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    probeUtc.getUTCFullYear() !== year ||
    probeUtc.getUTCMonth() + 1 !== month ||
    probeUtc.getUTCDate() !== day
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function resolveNowMs(nowOption) {
  if (nowOption === undefined || nowOption === null) {
    return Date.now();
  }
  let ms = Number.NaN;
  if (nowOption instanceof Date) {
    ms = nowOption.getTime();
  } else if (typeof nowOption === 'number') {
    ms = nowOption;
  } else {
    ms = Date.parse(String(nowOption));
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error('Invalid options.now timestamp');
  }
  return ms;
}

function sanitizeStatePatch(statePatch) {
  if (!statePatch || typeof statePatch !== 'object' || Array.isArray(statePatch)) {
    throw new TypeError('statePatch must be a plain object');
  }
  const serialized = JSON.stringify(statePatch);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_PATCH_BYTES) {
    throw new Error(`statePatch exceeds maximum size of ${MAX_STATE_PATCH_BYTES} bytes`);
  }
  const filtered = Object.create(null);
  for (const [k, v] of Object.entries(statePatch)) {
    if (Object.hasOwn(statePatch, k) && ALLOWED_PATCH_KEYS.has(k)) {
      filtered[k] = v;
    }
  }
  if (filtered.status !== undefined && !isKnownJobStatus(filtered.status)) {
    throw new Error(`Invalid job status: "${String(filtered.status)}"`);
  }
  return filtered;
}

function tryAcquireLockToken(lockPath, token) {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, token, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function reclaimStaleLockIfExpired(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (Date.now() - stat.mtimeMs > 10_000) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {}
  return false;
}

function releaseOwnedLock(lockPath, token) {
  try {
    const currentOwner = fs.readFileSync(lockPath, 'utf8').trim();
    if (currentOwner === token) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

function withAdvisoryFileLock(lockTarget, fn) {
  const lockPath = `${lockTarget}.lock`;
  const token = crypto.randomUUID();
  let acquired = false;
  try {
    tryAcquireLockToken(lockPath, token);
    acquired = true;
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      throw err;
    }
    if (reclaimStaleLockIfExpired(lockPath)) {
      try {
        tryAcquireLockToken(lockPath, token);
        acquired = true;
      } catch (retryErr) {
        if (retryErr?.code === 'EEXIST') {
          throw new Error('E_STATE_LOCK_BUSY');
        }
        throw retryErr;
      }
    } else {
      throw new Error('E_STATE_LOCK_BUSY');
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      releaseOwnedLock(lockPath, token);
    }
  }
}

function quarantineCorruptFile(filePath) {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt.${crypto.randomUUID()}`);
  } catch {}
  throw new Error('E_STATE_CORRUPT');
}

function readExistingJobState(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('E_STATE_INVALID_FILE');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    quarantineCorruptFile(filePath);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    quarantineCorruptFile(filePath);
  }
  return parsed;
}

function writeAtomicJsonFile(filePath, payloadStr) {
  const tempFile = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempFile, 'wx', 0o600);
    fs.writeFileSync(fd, payloadStr, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {}
    }
    throw err;
  }
}

function verifyTenantOwnership(record, expectedTenantId, cleanId) {
  const recordTenant = record.tenantId || record.author || null;
  if (!recordTenant && !expectedTenantId) {
    return;
  }
  if (recordTenant !== expectedTenantId) {
    throw new Error(`Job state not found for "${cleanId}"`);
  }
}

/**
 * Writes or updates a delegated worker job state file at .runs/<jobId>/result.json
 * with a timestamped `heartbeat` field. Enforces terminal-state immutability and allowlisted fields.
 */
export function writeJobState(jobId, statePatch = {}, options = {}) {
  const cleanId = String(jobId ?? '').trim();
  if (!isValidApprovalId(cleanId)) {
    throw new Error('Invalid job ID format');
  }
  const baseRunsDir = options.runsDir || RUNS_DIR;
  const jobDir = path.join(baseRunsDir, cleanId);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(jobDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('E_STATE_INVALID_DIR');
  }
  const filePath = path.join(jobDir, 'result.json');

  const nowMs = resolveNowMs(options.now);
  const candidateHeartbeat = statePatch.heartbeat || new Date(nowMs).toISOString();
  const beatMs = parseIsoTimestampMs(candidateHeartbeat);
  if (beatMs === null) {
    throw new Error('Invalid ISO-8601 heartbeat timestamp');
  }
  if (!options.allowFutureSkew && beatMs - nowMs > CLOCK_SKEW_MS) {
    throw new Error('E_HEARTBEAT_FUTURE_SKEW');
  }

  const safePatch = sanitizeStatePatch(statePatch);

  return withAdvisoryFileLock(filePath, () => {
    const existing = readExistingJobState(filePath);
    if (Object.keys(existing).length > 0) {
      verifyTenantOwnership(existing, options.tenantId, cleanId);
    }
    const existingTerminal = TERMINAL_STATES.get(String(existing.status ?? '').toLowerCase());
    const resolvedStatus = existingTerminal
      ? existing.status
      : (safePatch.status ?? existing.status ?? 'working');

    const nextState = existingTerminal
      ? {
          ...existing,
          jobId: cleanId,
          status: existing.status,
          heartbeat: existing.heartbeat ?? candidateHeartbeat,
        }
      : {
          ...existing,
          ...safePatch,
          jobId: cleanId,
          ...(options.tenantId && !existing.tenantId ? { tenantId: options.tenantId } : {}),
          status: resolvedStatus,
          heartbeat: candidateHeartbeat,
        };

    writeAtomicJsonFile(filePath, `${JSON.stringify(nextState, null, 2)}\n`);
    return nextState;
  });
}

function syncTaskHeartbeatInQueue(cleanId, heartbeatIso, status, options) {
  if (options.runsDir || !fs.existsSync(TASKS_FILE)) {
    return;
  }
  try {
    const tasks = loadAllTasks();
    const targetTask = tasks.find((t) => t.id === cleanId);
    if (!targetTask) {
      return;
    }
    const existingTerminal = TERMINAL_STATES.get(String(targetTask.status ?? '').toLowerCase());
    if (existingTerminal) {
      return;
    }
    targetTask.heartbeat = heartbeatIso;
    if (status && isKnownJobStatus(status)) {
      targetTask.status = status;
    }
    const lines = tasks.map((t) => JSON.stringify(t)).join('\n');
    writeAtomicJsonFile(TASKS_FILE, `${lines}\n`);
  } catch (err) {
    console.warn(`[task-bridge] Queue heartbeat sync skipped: ${redactOutbound(err.message)}`);
  }
}

/**
 * Updates the timestamped `heartbeat` field for a delegated background job in .runs/<jobId>/result.json
 * (and in inbound-tasks.jsonl if a matching task record exists).
 */
export function touchJobHeartbeat(jobId, patch = {}, options = {}) {
  const cleanId = String(jobId ?? '').trim();
  const nowMs = resolveNowMs(options.now);
  const heartbeatIso = patch.heartbeat || new Date(nowMs).toISOString();
  const updatedState = writeJobState(cleanId, { ...patch, heartbeat: heartbeatIso }, options);
  syncTaskHeartbeatInQueue(cleanId, updatedState.heartbeat, updatedState.status, options);
  return updatedState;
}

function loadTargetJobRecord(target, baseRunsDir, expectedTenantId) {
  if (target && typeof target === 'object') {
    const rawId = String(target.jobId ?? target.id ?? '').trim();
    if (!isValidApprovalId(rawId)) {
      throw new Error('Invalid job ID format in target object');
    }
    verifyTenantOwnership(target, expectedTenantId, rawId);
    return { record: target, resolvedId: rawId };
  }
  const cleanId = String(target ?? '').trim();
  if (!isValidApprovalId(cleanId)) {
    throw new Error('Invalid job ID format');
  }
  const filePath = path.join(baseRunsDir, cleanId, 'result.json');
  if (fs.existsSync(filePath)) {
    const record = readExistingJobState(filePath);
    verifyTenantOwnership(record, expectedTenantId, cleanId);
    return { record, resolvedId: cleanId };
  }
  const tasks = loadAllTasks({ runsDir: baseRunsDir });
  const found = tasks.find((t) => t.id === cleanId);
  if (found) {
    verifyTenantOwnership(found, expectedTenantId, cleanId);
    return { record: found, resolvedId: cleanId };
  }
  throw new Error('E_JOB_NOT_FOUND');
}

function extractHeartbeatTimestamp(record) {
  if (typeof record.heartbeat === 'string') {
    return record.heartbeat;
  }
  return record.heartbeat?.at || null;
}

function classifyWorkerState(rawStatus, isFresh) {
  if (TERMINAL_STATES.has(rawStatus)) {
    return { state: TERMINAL_STATES.get(rawStatus), isStalled: false };
  }
  if (WAITING_STATES.has(rawStatus)) {
    return { state: 'waiting', isStalled: false };
  }
  return { state: isFresh ? 'progressing' : 'stalled', isStalled: !isFresh };
}

/**
 * Inspects a `.runs` job state record or jobId and classifies whether the delegated
 * background worker is still progressing, waiting, completed, failed, or stalled based on its
 * timestamped `heartbeat` field.
 */
export function inspectWorkerHeartbeat(target, options = {}) {
  const baseRunsDir = options.runsDir || RUNS_DIR;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error('options.maxAgeMs must be a positive finite number');
  }
  const nowMs = resolveNowMs(options.now);
  const { record, resolvedId } = loadTargetJobRecord(target, baseRunsDir, options.tenantId);

  const rawStatus = typeof record.status === 'string' ? record.status.toLowerCase() : 'working';
  const rawHeartbeat = extractHeartbeatTimestamp(record);

  const beatMs = parseIsoTimestampMs(rawHeartbeat);
  const isValidAndNotFuture = beatMs !== null && beatMs - nowMs <= CLOCK_SKEW_MS;
  const ageMs = isValidAndNotFuture ? Math.max(0, nowMs - beatMs) : null;
  const isFresh = ageMs !== null && ageMs <= maxAgeMs;
  const { state, isStalled } = classifyWorkerState(rawStatus, isFresh);

  return {
    jobId: resolvedId,
    status: rawStatus,
    heartbeat: isValidAndNotFuture ? rawHeartbeat : null,
    ageMs,
    state,
    isStalled,
  };
}

