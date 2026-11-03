/**
 * @fileoverview Unit tests for tools/ambient-listener.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AmbientEventListener,
  assertInsideRoot,
  createTaskReaction,
  createValidationReaction,
} from './ambient-listener.mjs';

test('AmbientEventListener: detects file edits and fires debounced event', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-watch-test-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const listener = new AmbientEventListener({
    workspaceRoot: tmpDir,
    watchDirs: ['.'],
    tasksFile: path.join(tmpDir, 'tasks.jsonl'),
    debounceMs: 50,
  });

  listener.start();
  t.after(() => listener.stop());

  const received = [];
  listener.on('file_edit', (evt) => {
    received.push(evt);
  });

  // Write a file to trigger ambient watcher
  const targetFile = path.join(tmpDir, 'service.mjs');
  fs.writeFileSync(targetFile, 'console.log("hello ambient");', 'utf8');

  // Wait for debounce
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(received.length >= 1, 'Should have received at least one file_edit event');
  assert.ok(received.some((e) => e.path.includes('service.mjs')), 'Event path should match service.mjs');
});

test('AmbientEventListener: ignores files matching ignore patterns', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-ignore-test-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const listener = new AmbientEventListener({
    workspaceRoot: tmpDir,
    watchDirs: ['.'],
    tasksFile: path.join(tmpDir, 'tasks.jsonl'),
    debounceMs: 50,
  });

  assert.equal(listener.isIgnored('node_modules/pkg/index.js'), true);
  assert.equal(listener.isIgnored('.git/HEAD'), true);
  assert.equal(listener.isIgnored('.runs/journal.jsonl'), true);
  assert.equal(listener.isIgnored('file.tmp'), true);
  assert.equal(listener.isIgnored('tools/service.mjs'), false);
});

test('AmbientEventListener: reacts to inbound tasks appended to tasks file', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-task-test-'));
  const tasksFile = path.join(tmpDir, 'tasks.jsonl');
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.writeFileSync(tasksFile, '', 'utf8');

  const listener = new AmbientEventListener({
    workspaceRoot: tmpDir,
    watchDirs: [],
    tasksFile,
    debounceMs: 50,
  });

  listener.start();
  t.after(() => listener.stop());

  const taskEvents = [];
  listener.on('inbound_task', (evt) => {
    taskEvents.push(evt);
  });

  // Append a task
  const taskRecord = {
    id: 'task-ambient-1',
    instruction: 'Run static validation check',
    status: 'pending',
  };
  fs.appendFileSync(tasksFile, `${JSON.stringify(taskRecord)}\n`, 'utf8');

  listener.checkNewTasks();

  assert.equal(taskEvents.length, 1);
  assert.equal(taskEvents[0].task.id, 'task-ambient-1');
  assert.equal(taskEvents[0].task.instruction, 'Run static validation check');
});

test('createValidationReaction: triggers autonomous static check reaction on file edit', async () => {
  let executed = false;
  const reaction = createValidationReaction({
    checkFn: async (evt) => {
      executed = true;
      return { ok: true, inspected: evt.path };
    },
  });

  const outcome = await reaction({ path: 'tools/ambient-listener.mjs', eventType: 'change' });
  assert.equal(executed, true);
  assert.equal(outcome.action, 'auto_validation');
  assert.equal(outcome.result.ok, true);
});

test('createTaskReaction: dispatches inbound task autonomously to agent runner', async () => {
  let runnerInvokedWith = null;
  const reaction = createTaskReaction({
    agentRunner: async (task) => {
      runnerInvokedWith = task;
      return { verdict: 'completed', steps: 2 };
    },
  });

  const outcome = await reaction({
    type: 'inbound_task',
    task: { id: 'ambient-99', instruction: 'Refactor handler' },
  });

  assert.ok(runnerInvokedWith);
  assert.equal(runnerInvokedWith.id, 'ambient-99');
  assert.equal(outcome.action, 'auto_task_execution');
  assert.equal(outcome.result.verdict, 'completed');
});

test('assertInsideRoot: prevents path traversal out of workspace root', () => {
  const root = path.resolve('tools');
  assert.throws(() => {
    assertInsideRoot(root, '../../windows/system32');
  }, /Path escapes workspace boundary/);

  const safePath = assertInsideRoot(root, 'agent-loop.mjs');
  assert.ok(safePath.includes('agent-loop.mjs'));
});

test('AmbientEventListener: deduplicates tasks and avoids replay on re-check', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-dedupe-test-'));
  const tasksFile = path.join(tmpDir, 'tasks.jsonl');
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  fs.writeFileSync(tasksFile, '{"id":"task-once","instruction":"Run once"}\n', 'utf8');

  const listener = new AmbientEventListener({
    workspaceRoot: tmpDir,
    watchDirs: [],
    tasksFile,
  });

  const emitted = [];
  listener.on('inbound_task', (t) => emitted.push(t));

  listener.checkNewTasks();
  assert.equal(emitted.length, 1);

  // Calling checkNewTasks again without new tasks should NOT emit anything
  listener.checkNewTasks();
  assert.equal(emitted.length, 1);
});

