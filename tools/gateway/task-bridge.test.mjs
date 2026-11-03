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
  loadAllTasks,
} from './task-bridge.mjs';

test('task-bridge: enqueueTask and loadAllTasks persistence', () => {
  // Verify enqueue
  const t1 = enqueueTask('Refactor auth middleware', 'test-user-1', { source: 'mobile' });
  assert.ok(t1.id.startsWith('task-'));
  assert.equal(t1.status, 'pending');
  assert.equal(t1.instruction, 'Refactor auth middleware');

  const all = loadAllTasks();
  assert.ok(all.length >= 1);
  const found = all.find((x) => x.id === t1.id);
  assert.ok(found);
  assert.equal(found.author, 'test-user-1');

  const pending = getPendingTasks();
  assert.ok(pending.some((x) => x.id === t1.id));
});

test('task-bridge: completeTask updates task status and records results', async () => {
  const t = enqueueTask('Add healthcheck probe', 'mobile-user');
  assert.equal(t.status, 'pending');

  const completed = await completeTask(t.id, {
    summary: 'Added probe and unit tests',
    filesModified: ['tools/service/health-check.mjs'],
    testStatus: 'passed',
    reviewerVerdict: 'DeepSeek approved',
  });

  assert.equal(completed.status, 'completed');
  assert.ok(completed.completedAt);
  assert.equal(completed.result.summary, 'Added probe and unit tests');
  assert.deepEqual(completed.result.filesModified, ['tools/service/health-check.mjs']);

  // Completing non-existent task throws
  await assert.rejects(
    () => completeTask('non-existent-task-999', { summary: 'test' }),
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
