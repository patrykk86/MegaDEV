import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BackgroundScheduler,
  handleAuditTask,
  handleLaneCheckTask,
  handleMemoryBudgetTask,
  matchCron,
  matchCronField,
  parseScheduleYaml,
} from './runner.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(THIS_DIR, '..', '..');

test('Cron Matcher: matchCronField handles wildcards, steps, ranges, and lists', () => {
  assert.equal(matchCronField('*', 15), true);
  assert.equal(matchCronField('*/5', 20), true);
  assert.equal(matchCronField('*/5', 21), false);
  assert.equal(matchCronField('1-5', 3), true);
  assert.equal(matchCronField('1-5', 6), false);
  assert.equal(matchCronField('1,15,30', 15), true);
  assert.equal(matchCronField('1,15,30', 20), false);
  assert.equal(matchCronField('20', 20), true);
  assert.equal(matchCronField('20', 19), false);
});

test('Cron Matcher: matchCron matches daily at 20:00 (0 20 * * *)', () => {
  const at2000 = new Date('2026-11-03T20:00:00.000Z');
  const at2001 = new Date('2026-11-03T20:01:00.000Z');
  const at1959 = new Date('2026-11-03T19:59:00.000Z');
  const at0800 = new Date('2026-11-03T08:00:00.000Z');

  assert.equal(matchCron('0 20 * * *', at2000, true), true);
  assert.equal(matchCron('0 20 * * *', at2001, true), false);
  assert.equal(matchCron('0 20 * * *', at1959, true), false);
  assert.equal(matchCron('0 20 * * *', at0800, true), false);

  // Invalid cron returns false safely
  assert.equal(matchCron('', at2000), false);
  assert.equal(matchCron('invalid cron', at2000), false);
});

test('YAML Loader: parseScheduleYaml extracts tasks and properties correctly', () => {
  const yamlContent = `
version: "1.0"
timezone: "UTC"
tasks:
  - id: "nightly-audit"
    name: "Nightly Workspace Audit"
    cron: "0 20 * * *"
    enabled: true
    action: "audit"
  - id: "memory-budget"
    cron: "0 20 * * *"
    enabled: false
    action: "memory_budget"
`;

  const parsed = parseScheduleYaml(yamlContent);
  assert.equal(parsed.version, '1.0');
  assert.equal(parsed.timezone, 'UTC');
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].id, 'nightly-audit');
  assert.equal(parsed.tasks[0].enabled, true);
  assert.equal(parsed.tasks[0].action, 'audit');
  assert.equal(parsed.tasks[1].id, 'memory-budget');
  assert.equal(parsed.tasks[1].enabled, false);
});

test('Repeatable Task Handlers: audit, memory budget, and challenge lane', () => {
  const memoryRes = handleMemoryBudgetTask(WORKSPACE_ROOT);
  assert.equal(memoryRes.ok, true);
  assert.ok(memoryRes.tokens > 0);
  assert.ok(memoryRes.bytes > 0);

  const laneRes = handleLaneCheckTask(WORKSPACE_ROOT);
  assert.equal(laneRes.ok, true);
  assert.ok(laneRes.laneId.length > 0);

  const auditRes = handleAuditTask(WORKSPACE_ROOT);
  assert.ok(auditRes.auditId.startsWith('audit-'));
});

test('BackgroundScheduler: tick dispatches daily 20:00 tasks and alerts listeners', async () => {
  const tempRunsDir = path.join(WORKSPACE_ROOT, '.runs', 'test-scheduler');
  fs.mkdirSync(tempRunsDir, { recursive: true });

  const scheduler = new BackgroundScheduler({
    workspaceRoot: WORKSPACE_ROOT,
    runsDir: tempRunsDir,
  });

  const alerts = [];
  scheduler.onAlert((alert) => alerts.push(alert));

  // Trigger tick at 20:00:00 UTC
  const at2000 = new Date('2026-11-03T20:00:00.000Z');
  const tickResult = await scheduler.tick(at2000);

  assert.equal(tickResult.executedCount, 3);
  assert.equal(alerts.length, 3);
  assert.ok(alerts.some((a) => a.taskId === 'nightly-audit'));
  assert.ok(alerts.some((a) => a.taskId === 'memory-budget'));
  assert.ok(alerts.some((a) => a.taskId === 'challenge-lane'));

  // Tick at non-matching time dispatches 0 tasks
  const at1200 = new Date('2026-11-03T12:00:00.000Z');
  const emptyTick = await scheduler.tick(at1200);
  assert.equal(emptyTick.executedCount, 0);

  // Check persisted JSONL dispatches
  const dispatchesFile = path.join(tempRunsDir, 'dispatches.jsonl');
  assert.equal(fs.existsSync(dispatchesFile), true);
  const lines = fs.readFileSync(dispatchesFile, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3);

  // Cleanup test run artifacts
  fs.rmSync(tempRunsDir, { recursive: true, force: true });
});

test('BackgroundScheduler: starts and stops timer gracefully', () => {
  const scheduler = new BackgroundScheduler({ workspaceRoot: WORKSPACE_ROOT });
  scheduler.start(5000);
  assert.ok(scheduler.timer !== null);
  scheduler.stop();
  assert.equal(scheduler.timer, null);
});
