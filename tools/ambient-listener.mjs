#!/usr/bin/env node
/**
 * tools/ambient-listener.mjs - Ambient Event Listener & Reactive Agent Trigger
 *
 * Implements Experiment 3:
 * - Monitors ambient signals: file system edits (workspace source files) and inbound notifications (inbound-tasks.jsonl).
 * - Reacts autonomously to ambient signals rather than waiting for direct manual prompts.
 * - Supports debounce, path filtering, and automatic task execution or validation triggers.
 * - Optionally logs ambient reactions to the append-only journal (.runs/journal.jsonl).
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_JOURNAL_PATH, appendJournalEntry } from './journal.mjs';
import { redactOutbound } from './sanitize.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(THIS_DIR, '..');
export const DEFAULT_TASKS_FILE = path.join(ROOT_DIR, '.runs', 'inbound-tasks.jsonl');

export const DEFAULT_IGNORE_PATTERNS = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.runs([\\/]|$)/,
  /(^|[\\/])\.audits([\\/]|$)/,
  /\.(swp|tmp|bak|log)$/i,
  /~$/,
];

/**
 * Asserts that a target path is contained strictly within the workspace root.
 */
export function assertInsideRoot(root, targetPath) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, String(targetPath ?? ''));
  const rel = path.relative(rootAbs, targetAbs);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace boundary: ${targetPath}`);
  }
  return targetAbs;
}

/**
 * AmbientEventListener monitors file system modifications and inbound tasks.
 */
export class AmbientEventListener extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.workspaceRoot]
   * @param {string[]} [options.watchDirs] - Directories or files to watch
   * @param {string} [options.tasksFile] - Path to inbound tasks jsonl
   * @param {number} [options.debounceMs=150] - Debounce period for file system events
   * @param {Array<RegExp|string>} [options.ignorePatterns]
   * @param {boolean} [options.journal=false] - Whether to journal ambient reactions
   * @param {string} [options.journalPath]
   */
  constructor(options = {}) {
    super();
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? ROOT_DIR);
    const defaultTasks = options.workspaceRoot
      ? path.join(this.workspaceRoot, '.runs', 'inbound-tasks.jsonl')
      : DEFAULT_TASKS_FILE;
    const defaultJournal = options.workspaceRoot
      ? path.join(this.workspaceRoot, '.runs', 'journal.jsonl')
      : DEFAULT_JOURNAL_PATH;
    this.tasksFile = assertInsideRoot(this.workspaceRoot, options.tasksFile ?? defaultTasks);
    this.journalPath = assertInsideRoot(this.workspaceRoot, options.journalPath ?? defaultJournal);
    this.watchDirs = (options.watchDirs ?? ['tools']).map((d) => assertInsideRoot(this.workspaceRoot, d));
    this.debounceMs = options.debounceMs ?? 150;
    this.ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;
    this.journal = options.journal ?? false;

    this.watchers = [];
    this.debounceTimers = new Map();
    this.lastTaskCount = 0;
    this.processedTaskIds = new Set();
    this.active = false;

    // Attach default error handler to prevent unhandled EventEmitter throw
    this.on('error', (err) => {
      console.warn(`[ambient-listener] Listener event warning: ${err?.message ?? String(err)}`);
    });
  }

  /**
   * Determines if a relative or absolute path should be ignored.
   */
  isIgnored(targetPath) {
    const rootAbs = path.resolve(this.workspaceRoot);
    const targetAbs = path.resolve(rootAbs, targetPath);
    const rel = path.relative(rootAbs, targetAbs);
    if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
      return true;
    }
    return this.ignorePatterns.some((pattern) => {
      if (pattern instanceof RegExp) {
        return pattern.test(rel) || pattern.test(targetPath);
      }
      return rel.includes(pattern) || targetPath.includes(pattern);
    });
  }

  /**
   * Starts ambient monitoring on configured watch directories and tasks file.
   */
  start() {
    if (this.active) {
      return this;
    }
    this.active = true;

    // 1. Watch directories for source code edits
    for (const targetDir of this.watchDirs) {
      const fullPath = path.isAbsolute(targetDir) ? targetDir : path.join(this.workspaceRoot, targetDir);
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      try {
        const watcher = fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
          if (!this.active || !filename) {
            return;
          }
          const changedRel = path.join(targetDir, filename.toString()).replace(/\\/g, '/');
          if (this.isIgnored(changedRel)) {
            return;
          }
          this.handleFileChangeEvent(eventType, changedRel);
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.emit('error', new Error(`Failed to watch ${fullPath}: ${err.message}`));
      }
    }

    // 2. Watch tasks file for inbound ambient tasks
    this.initTasksWatcher();

    this.emit('started', { watchDirs: this.watchDirs, tasksFile: this.tasksFile });
    return this;
  }

  /**
   * Initializes watcher or polling for inbound tasks ledger.
   */
  initTasksWatcher() {
    const tasksDir = path.dirname(this.tasksFile);
    if (!fs.existsSync(tasksDir)) {
      try {
        fs.mkdirSync(tasksDir, { recursive: true });
      } catch {
        // ignore
      }
    }

    this.lastTaskCount = this.readCurrentTasks().length;

    if (fs.existsSync(this.tasksFile)) {
      try {
        const taskWatcher = fs.watch(this.tasksFile, (_eventType) => {
          if (!this.active) {
            return;
          }
          this.checkNewTasks();
        });
        this.watchers.push(taskWatcher);
      } catch {
        // Fallback handled via manual checkNewTasks()
      }
    }
  }

  /**
   * Debounced file change handler.
   */
  handleFileChangeEvent(eventType, relativePath) {
    if (this.debounceTimers.has(relativePath)) {
      clearTimeout(this.debounceTimers.get(relativePath));
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(relativePath);
      const event = {
        type: 'file_edit',
        path: relativePath,
        eventType,
        timestamp: new Date().toISOString(),
      };
      this.emit('file_edit', event);
      if (this.journal) {
        this.recordJournalSignal('ambient_file_edit', `File changed: ${relativePath}`, event);
      }
    }, this.debounceMs);

    this.debounceTimers.set(relativePath, timer);
  }

  /**
   * Reads all valid tasks currently in the tasks file.
   */
  readCurrentTasks() {
    if (!fs.existsSync(this.tasksFile)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.tasksFile, 'utf8').trim();
      if (!raw) {
        return [];
      }
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Checks whether new tasks were appended and emits 'inbound_task'.
   */
  checkNewTasks() {
    const currentTasks = this.readCurrentTasks();
    this.lastTaskCount = currentTasks.length;
    for (const task of currentTasks) {
      const taskId = String(task.id || `${task.instruction}-${task.createdAt}`);
      if (this.processedTaskIds.has(taskId)) {
        continue;
      }
      this.processedTaskIds.add(taskId);
      const event = {
        type: 'inbound_task',
        task,
        timestamp: new Date().toISOString(),
      };
      this.emit('inbound_task', event);
      if (this.journal) {
        const safeSummary = `New inbound task: ${task.id || 'unnamed'}`.slice(0, 128);
        this.recordJournalSignal('ambient_inbound_task', safeSummary, event);
      }
    }
  }

  /**
   * Records ambient signal to the append-only journal.
   */
  recordJournalSignal(actionType, summary, payload) {
    try {
      const safeSummary = redactOutbound(String(summary ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 512));
      appendJournalEntry(
        {
          actor_id: 'ambient-listener',
          action_type: actionType,
          summary: safeSummary,
          payload,
        },
        { journalPath: this.journalPath },
      );
    } catch (err) {
      this.emit('error', new Error(`Journal append failed: ${err.message}`));
    }
  }

  /**
   * Closes all active watchers and clears pending debounce timers.
   */
  stop() {
    this.active = false;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
    this.emit('stopped');
  }
}

/**
 * Creates an autonomous reactive validation listener that triggers static checks
 * whenever code files are edited.
 */
export function createValidationReaction(options = {}) {
  const checkFn = options.checkFn || (() => ({ status: 'passed' }));
  return async function onFileEdit(event) {
    const res = await checkFn(event);
    return {
      action: 'auto_validation',
      file: event.path,
      result: res,
      timestamp: new Date().toISOString(),
    };
  };
}

/**
 * Creates an autonomous reactive task handler that dispatches inbound tasks
 * to an agent runner without waiting for direct manual prompts.
 */
export function createTaskReaction(options = {}) {
  const runner = options.agentRunner || (async (task) => ({ status: 'processed', taskId: task.id }));
  return async function onInboundTask(event) {
    const res = await runner(event.task);
    return {
      action: 'auto_task_execution',
      task: event.task,
      result: res,
      timestamp: new Date().toISOString(),
    };
  };
}

