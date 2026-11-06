import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSuspension } from '../resumable-approval.mjs';
import {
  completeTask,
  enqueueTask,
  getPendingTasks,
  handleApprovalDecision,
  inspectWorkerHeartbeat,
  loadAllTasks,
  touchJobHeartbeat,
  writeJobState,
} from './task-bridge.mjs';

test('task-bridge: enqueueTask and loadAllTasks persistence', (t) => {
  const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'task-bridge-persist-'));
  t.after(() => {
    fs.rmSync(tmpRuns, { recursive: true, force: true });
  });

  // Verify enqueue
  const t1 = enqueueTask('Refactor auth middleware', 'test-user-1', { source: 'mobile' }, { runsDir: tmpRuns });
  assert.ok(t1.id.startsWith('task-'));
  assert.equal(t1.status, 'pending');
  assert.ok(t1.heartbeat);
  assert.equal(t1.instruction, 'Refactor auth middleware');

  const all = loadAllTasks({ runsDir: tmpRuns });
  assert.ok(all.length >= 1);
  const found = all.find((x) => x.id === t1.id);
  assert.ok(found);
  assert.equal(found.author, 'test-user-1');

  const pending = getPendingTasks({ runsDir: tmpRuns });
  assert.ok(pending.some((x) => x.id === t1.id));
});

test('task-bridge: completeTask updates task status and records results', async (t) => {
  const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'task-bridge-complete-'));
  t.after(() => {
    fs.rmSync(tmpRuns, { recursive: true, force: true });
  });

  const task = enqueueTask('Add healthcheck probe', 'mobile-user', {}, { runsDir: tmpRuns });
  assert.equal(task.status, 'pending');

  const completed = await completeTask(
    task.id,
    {
      summary: 'Added probe and unit tests',
      filesModified: ['tools/service/health-check.mjs'],
      testStatus: 'passed',
      reviewerVerdict: 'DeepSeek approved',
    },
    { runsDir: tmpRuns },
  );

  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.ok(completed.heartbeat);
  assert.equal(completed.result.summary, 'Added probe and unit tests');
  assert.deepEqual(completed.result.filesModified, ['tools/service/health-check.mjs']);

  // Completing non-existent task throws
  await assert.rejects(
    () => completeTask('non-existent-task-999', { summary: 'test' }, { runsDir: tmpRuns }),
    /not found/,
  );
});

test('task-bridge: handleApprovalDecision resolves suspensions cleanly', () => {
  const tmpApprovals = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-test-'));
  const suspension = createSuspension({
    toolCall: { id: 'call_1', name: 'delete_old_logs', arguments: {} },
    state: { step: 1, messages: [] },
    prompt: 'Authorize log cleanup',
    approvalsDir: tmpApprovals,
  });

  // Approve
  const approved = handleApprovalDecision(suspension.approvalId, true, 'User approved via Telegram', {
    approvalsDir: tmpApprovals,
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.feedback, 'User approved via Telegram');

  // Reject another suspension
  const suspension2 = createSuspension({
    toolCall: { id: 'call_2', name: 'drop_database', arguments: {} },
    state: { step: 1, messages: [] },
    prompt: 'Authorize database drop',
    approvalsDir: tmpApprovals,
  });

  const rejected = handleApprovalDecision(suspension2.approvalId, false, 'User denied destructive tool', {
    approvalsDir: tmpApprovals,
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.feedback, 'User denied destructive tool');
});

test('task-bridge: writeJobState, touchJobHeartbeat, and inspectWorkerHeartbeat detect progressing vs stalled workers', (t) => {
  const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-heartbeat-test-'));
  t.after(() => {
    fs.rmSync(tmpRuns, { recursive: true, force: true });
  });

  const baseTime = new Date('2026-11-06T12:00:00.000Z');
  const jobId = `job-${crypto.randomUUID().slice(0, 8)}`;

  const initial = writeJobState(
    jobId,
    { status: 'working', step: 'downloading-source', heartbeat: baseTime.toISOString() },
    { runsDir: tmpRuns, now: baseTime },
  );
  assert.equal(initial.jobId, jobId);
  assert.equal(initial.heartbeat, '2026-11-06T12:00:00.000Z');

  const checkFresh = inspectWorkerHeartbeat(jobId, {
    runsDir: tmpRuns,
    now: new Date('2026-11-06T12:01:00.000Z'),
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(checkFresh.state, 'progressing');
  assert.equal(checkFresh.isStalled, false);
  assert.equal(checkFresh.ageMs, 60_000);

  const checkStalled = inspectWorkerHeartbeat(jobId, {
    runsDir: tmpRuns,
    now: new Date('2026-11-06T12:10:00.000Z'),
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(checkStalled.state, 'stalled');
  assert.equal(checkStalled.isStalled, true);

  touchJobHeartbeat(
    jobId,
    { status: 'working', step: 'validating-output', heartbeat: '2026-11-06T12:09:30.000Z' },
    { runsDir: tmpRuns, now: new Date('2026-11-06T12:09:30.000Z') },
  );
  const checkRecovered = inspectWorkerHeartbeat(jobId, {
    runsDir: tmpRuns,
    now: new Date('2026-11-06T12:10:00.000Z'),
    maxAgeMs: 5 * 60 * 1000,
  });
  assert.equal(checkRecovered.state, 'progressing');
  assert.equal(checkRecovered.isStalled, false);
  assert.equal(checkRecovered.ageMs, 30_000);
});

test('task-bridge: heartbeat security guards reject clock skew, calendar anomalies, and terminal state replay', (t) => {
  const tmpRuns = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-heartbeat-sec-'));
  t.after(() => {
    fs.rmSync(tmpRuns, { recursive: true, force: true });
  });

  const jobId = `job-${crypto.randomUUID().slice(0, 8)}`;
  const nowRef = new Date('2026-11-06T12:10:00.000Z');
  writeJobState(jobId, { status: 'working', heartbeat: '2026-11-06T12:09:30.000Z' }, { runsDir: tmpRuns, now: nowRef });

  assert.throws(
    () =>
      touchJobHeartbeat(
        jobId,
        { status: 'working', heartbeat: '2026-11-06T13:00:00.000Z' },
        { runsDir: tmpRuns, now: nowRef },
      ),
    /E_HEARTBEAT_FUTURE_SKEW/,
  );
  const checkForgedFuture = inspectWorkerHeartbeat(
    { jobId, status: 'working', heartbeat: '2026-11-06T13:00:00.000Z' },
    { runsDir: tmpRuns, now: nowRef, maxAgeMs: 5 * 60 * 1000 },
  );
  assert.equal(checkForgedFuture.state, 'stalled');
  assert.equal(checkForgedFuture.isStalled, true);

  assert.throws(
    () =>
      writeJobState(
        jobId,
        { status: 'working', heartbeat: '2026-02-30T12:00:00.000Z' },
        { runsDir: tmpRuns, now: nowRef },
      ),
    /Invalid ISO-8601 heartbeat timestamp/,
  );

  writeJobState(jobId, { status: 'completed', heartbeat: '2026-11-06T12:10:00.000Z' }, { runsDir: tmpRuns, now: nowRef });
  const afterReplay = touchJobHeartbeat(
    jobId,
    { status: 'working', heartbeat: '2026-11-06T12:11:00.000Z' },
    { runsDir: tmpRuns, now: new Date('2026-11-06T12:11:00.000Z') },
  );
  assert.equal(afterReplay.status, 'completed');
  const checkCompleted = inspectWorkerHeartbeat(jobId, {
    runsDir: tmpRuns,
    now: new Date('2026-11-06T12:20:00.000Z'),
  });
  assert.equal(checkCompleted.state, 'completed');
  assert.equal(checkCompleted.isStalled, false);

  assert.throws(() => writeJobState('nul', { status: 'working' }, { runsDir: tmpRuns }), /Invalid job ID format/);
});
