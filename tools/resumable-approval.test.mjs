/**
 * @fileoverview Unit tests for tools/resumable-approval.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createSuspension,
  listPendingApprovals,
  loadSuspension,
  resolveSuspension,
} from './resumable-approval.mjs';

describe('Resumable Approvals: Creation & Serialization', () => {
  it('creates a serialized suspension file with HMAC fingerprint', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-approvals-test-'));
    try {
      const toolCall = { id: 'tc-123', name: 'publish_release', arguments: { tag: 'v2.0.0' } };
      const state = {
        step: 2,
        messages: [
          { role: 'user', content: 'Deploy release' },
          { role: 'assistant', content: 'Publishing release tag v2.0.0' },
        ],
        usage: 450,
        model: 'test-model',
      };

      const res = createSuspension({
        toolCall,
        state,
        prompt: 'Publish tag v2.0.0 to public repository',
        workspaceRoot: tmpDir,
      });

      assert.ok(res.approvalId.startsWith('appr-'));
      assert.ok(fs.existsSync(res.filePath));

      const loaded = loadSuspension(res.approvalId, { workspaceRoot: tmpDir });
      assert.equal(loaded.approvalId, res.approvalId);
      assert.equal(loaded.status, 'pending');
      assert.equal(loaded.toolCall.name, 'publish_release');
      assert.equal(loaded.state.step, 2);
      assert.equal(loaded.state.messages.length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects tampered suspension files via HMAC integrity verification', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-approvals-test-'));
    try {
      const toolCall = { id: 'tc-1', name: 'safe_tool', arguments: {} };
      const state = { step: 1, messages: [] };

      const res = createSuspension({
        toolCall,
        state,
        workspaceRoot: tmpDir,
      });

      // Tamper with the toolCall arguments directly on disk
      const content = JSON.parse(fs.readFileSync(res.filePath, 'utf-8'));
      content.toolCall.name = 'malicious_tool';
      fs.writeFileSync(res.filePath, JSON.stringify(content), 'utf-8');

      // Attempt to load tampered record
      assert.throws(
        () => loadSuspension(res.approvalId, { workspaceRoot: tmpDir }),
        /failed HMAC integrity verification/
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects expired TTL and marks status as expired', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-approvals-test-'));
    try {
      const toolCall = { id: 'tc-1', name: 'test_tool', arguments: {} };
      const state = { step: 1, messages: [] };

      // Set negative TTL so it is already expired
      const res = createSuspension({
        toolCall,
        state,
        ttlMs: -1000,
        workspaceRoot: tmpDir,
      });

      const loaded = loadSuspension(res.approvalId, { workspaceRoot: tmpDir });
      assert.equal(loaded.status, 'expired');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Resumable Approvals: Resolution & Listing', () => {
  it('resolves pending approval to approved or rejected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-approvals-test-'));
    try {
      const toolCall = { id: 'tc-1', name: 'deploy_service', arguments: {} };
      const state = { step: 1, messages: [] };

      const res = createSuspension({
        toolCall,
        state,
        workspaceRoot: tmpDir,
      });

      const resolved = resolveSuspension(res.approvalId, {
        decision: 'approved',
        responder: 'patryk',
        feedback: 'Looks good to go',
        workspaceRoot: tmpDir,
      });

      assert.equal(resolved.status, 'approved');
      assert.equal(resolved.decision, 'approved');
      assert.equal(resolved.resolvedBy, 'patryk');
      assert.equal(resolved.feedback, 'Looks good to go');

      // Cannot re-resolve already resolved suspension
      assert.throws(
        () => resolveSuspension(res.approvalId, { decision: 'rejected', workspaceRoot: tmpDir }),
        /Cannot resolve suspension .* with status "approved"/
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lists pending approvals and excludes resolved ones', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-approvals-test-'));
    try {
      const state = { step: 1, messages: [] };

      const r1 = createSuspension({
        toolCall: { id: 'tc-1', name: 'job_a', arguments: {} },
        state,
        prompt: 'Run Job A',
        workspaceRoot: tmpDir,
      });

      const r2 = createSuspension({
        toolCall: { id: 'tc-2', name: 'job_b', arguments: {} },
        state,
        prompt: 'Run Job B',
        workspaceRoot: tmpDir,
      });

      let pending = listPendingApprovals({ workspaceRoot: tmpDir });
      assert.equal(pending.length, 2);

      // Resolve r1
      resolveSuspension(r1.approvalId, { decision: 'rejected', workspaceRoot: tmpDir });

      pending = listPendingApprovals({ workspaceRoot: tmpDir });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].approvalId, r2.approvalId);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
