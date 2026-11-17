import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJournalEntries } from '../journal.mjs';
import { acquireLease, releaseLease } from '../resource-lease.mjs';
import {
  BackgroundScheduler,
  handleAuditTask,
  handleLaneCheckTask,
  handleFrictionSweepTask,
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

test('Repeatable Task Handlers: audit, memory budget, challenge lane and friction sweep', () => {
  const memoryRes = handleMemoryBudgetTask(WORKSPACE_ROOT);
  assert.equal(memoryRes.ok, true);
  assert.ok(memoryRes.tokens > 0);
  assert.ok(memoryRes.bytes > 0);

  const laneRes = handleLaneCheckTask(WORKSPACE_ROOT);
  assert.equal(laneRes.ok, true);
  assert.ok(laneRes.laneId.length > 0);

  const auditRes = handleAuditTask(WORKSPACE_ROOT);
  assert.ok(auditRes.auditId.startsWith('audit-'));

  const frictionRes = handleFrictionSweepTask(WORKSPACE_ROOT);
  assert.equal(frictionRes.ok, true);
  assert.equal(
    frictionRes.agentReady + frictionRes.needsHuman + frictionRes.blocked,
    frictionRes.total,
  );
  assert.ok(frictionRes.message.startsWith('Friction sweep:'));
});

test('BackgroundScheduler: tick dispatches daily 20:00 tasks and alerts listeners', async () => {
  const tempRunsDir = path.join(WORKSPACE_ROOT, '.runs', 'test-scheduler');
  const tempJournal = path.join(tempRunsDir, 'journal.jsonl');
  const tempLeases = path.join(tempRunsDir, 'leases');
  fs.mkdirSync(tempRunsDir, { recursive: true });

  const scheduler = new BackgroundScheduler({
    workspaceRoot: WORKSPACE_ROOT,
    runsDir: tempRunsDir,
    journalPath: tempJournal,
    leasesDir: tempLeases,
  });

  const alerts = [];
  scheduler.onAlert((alert) => alerts.push(alert));

  // Trigger tick at 20:00:00 UTC
  const at2000 = new Date('2026-11-03T20:00:00.000Z');
  const tickResult = await scheduler.tick(at2000);

  assert.equal(tickResult.executedCount, 4);
  assert.equal(alerts.length, 4);
  assert.ok(alerts.some((a) => a.taskId === 'nightly-audit'));
  assert.ok(alerts.some((a) => a.taskId === 'memory-budget'));
  assert.ok(alerts.some((a) => a.taskId === 'challenge-lane'));
  assert.ok(alerts.some((a) => a.taskId === 'friction-sweep'));

  // Tick at non-matching time dispatches 0 tasks
  const at1200 = new Date('2026-11-03T12:00:00.000Z');
  const emptyTick = await scheduler.tick(at1200);
  assert.equal(emptyTick.executedCount, 0);

  // Check persisted JSONL dispatches and journal config_hash
  const dispatchesFile = path.join(tempRunsDir, 'dispatches.jsonl');
  assert.equal(fs.existsSync(dispatchesFile), true);
  const lines = fs.readFileSync(dispatchesFile, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3);

  const journalEntries = readJournalEntries({ journalPath: tempJournal });
  assert.equal(journalEntries.length, 4);
  assert.match(journalEntries[0].payload.config_hash, /^[0-9a-f]{64}$/);

  // Cleanup test run artifacts
  fs.rmSync(tempRunsDir, { recursive: true, force: true });
});

test('BackgroundScheduler: skips task on active lease conflict and records conflict in journal', async () => {
  const tempRunsDir = path.join(WORKSPACE_ROOT, '.runs', 'test-scheduler-lease');
  const tempJournal = path.join(tempRunsDir, 'journal.jsonl');
  const tempLeases = path.join(tempRunsDir, 'leases');
  fs.mkdirSync(tempRunsDir, { recursive: true });

  const now = new Date('2026-11-17T18:00:00.000Z');
  const held = acquireLease({
    resource: 'task:shared-job',
    owner: 'other-agent',
    ttlMs: 30_000,
    leasesDir: tempLeases,
    now,
  });
  assert.equal(held.acquired, true);

  let ran = false;
  const scheduler = new BackgroundScheduler({
    workspaceRoot: WORKSPACE_ROOT,
    runsDir: tempRunsDir,
    journalPath: tempJournal,
    leasesDir: tempLeases,
    ownerId: 'scheduler-test',
  });
  scheduler.registerHandler('custom', () => {
    ran = true;
    return { ok: true };
  });

  try {
    const res = await scheduler.dispatchTask(
      { id: 'shared-job', action: 'custom', cron: '* * * * *' },
      now,
    );
    assert.equal(ran, false);
    assert.equal(res.outcome.ok, false);
    assert.equal(res.outcome.skipped, true);
    assert.equal(res.outcome.reason, 'lease_conflict');

    const entries = readJournalEntries({ journalPath: tempJournal });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].payload.skipped, true);
    assert.match(entries[0].payload.config_hash, /^[0-9a-f]{64}$/);
  } finally {
    releaseLease({
      resource: 'task:shared-job',
      owner: 'other-agent',
      leaseId: held.lease.leaseId,
      leasesDir: tempLeases,
    });
    fs.rmSync(tempRunsDir, { recursive: true, force: true });
  }
});

test('BackgroundScheduler: starts and stops timer gracefully', () => {
  const scheduler = new BackgroundScheduler({ workspaceRoot: WORKSPACE_ROOT });
  scheduler.start(5000);
  assert.ok(scheduler.timer !== null);
  scheduler.stop();
  assert.equal(scheduler.timer, null);
});
