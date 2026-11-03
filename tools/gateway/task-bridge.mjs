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
import { sanitizeInput } from '../sanitize.mjs';
import { scrubTelegramSecrets, TelegramBotGateway } from './telegram-bot.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_DIR = path.join(ROOT_DIR, '.runs');
const TASKS_FILE = path.join(RUNS_DIR, 'inbound-tasks.jsonl');
const APPROVAL_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function ensureRunsDir() {
  if (!fs.existsSync(RUNS_DIR)) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
  }
}

/**
 * Validates that an approval ID matches strict alphanumeric format and prevents path traversal.
 */
export function isValidApprovalId(approvalId) {
  return typeof approvalId === 'string' && APPROVAL_ID_REGEX.test(approvalId.trim());
}

/**
 * Enqueues a new coding/agent task from mobile or external channels after sanitizing input.
 */
export function enqueueTask(instruction, author = 'telegram', metadata = {}) {
  ensureRunsDir();
  const sanitized = sanitizeInput(String(instruction ?? ''), { neutralizeInjections: true });
  const id = `task-${crypto.randomUUID()}`;
  const record = {
    id,
    author: String(author),
    instruction: sanitized.cleanText.trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    metadata: {
      ...metadata,
      suspicious: sanitized.isSuspicious,
      threats: sanitized.threats ?? [],
    },
  };

  fs.appendFileSync(TASKS_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/**
 * Reads all tasks from disk line-by-line, skipping corrupted lines instead of failing open.
 */
export function loadAllTasks() {
  if (!fs.existsSync(TASKS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf8').trim();
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
export function getPendingTasks() {
  return loadAllTasks().filter((t) => t.status === 'pending');
}

async function dispatchTaskReview(
  bot,
  updatedRecord,
  { summary, filesModified, testStatus, reviewerVerdict },
) {
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
    console.error(`[task-bridge] Failed to dispatch review to Telegram: ${scrubTelegramSecrets(err.message)}`);
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
  ensureRunsDir();
  const tasks = loadAllTasks();
  let updatedRecord = null;

  for (const t of tasks) {
    if (t.id === taskId) {
      t.status = 'completed';
      t.completedAt = new Date().toISOString();
      t.result = { summary, filesModified, testStatus, reviewerVerdict };
      updatedRecord = t;
      break;
    }
  }

  if (!updatedRecord) {
    throw new Error(`Task ${taskId} not found`);
  }

  // Rewrite tasks file atomically via process-unique temp file
  const tempFile = `${TASKS_FILE}.${process.pid}.${Date.now()}.tmp`;
  const lines = tasks.map((t) => JSON.stringify(t)).join('\n');
  fs.writeFileSync(tempFile, `${lines}\n`, 'utf8');
  fs.renameSync(tempFile, TASKS_FILE);

  const bot = options.bot || new TelegramBotGateway();
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
