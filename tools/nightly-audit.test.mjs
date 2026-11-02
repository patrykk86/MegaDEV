#!/usr/bin/env node
/**
 * tools/nightly-audit.test.mjs - Unit tests for Layer 4 Nightly Audit Runner
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeNightlyAudit, getGitHygiene } from './nightly-audit.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(THIS_DIR, 'nightly-audit.mjs');

describe('Layer 4: getGitHygiene()', () => {
  it('reads git branch and status without throwing', () => {
    const git = getGitHygiene();
    assert.ok(typeof git.branch === 'string');
    assert.ok(Array.isArray(git.modified));
    assert.ok(Array.isArray(git.untracked));
    assert.ok(Array.isArray(git.recentCommits));
  });
});

describe('Layer 4: executeNightlyAudit()', () => {
  it('executes audit and outputs persisted report.md, summary.json, and latest.json in isolated dir', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-audit-test-'));

    try {
      const res = executeNightlyAudit({ runsDir: tempDir });

      assert.ok(res.auditId.startsWith('audit-'));
      assert.ok(fs.existsSync(res.reportPath));
      assert.ok(fs.existsSync(res.jsonPath));

      const latestPath = path.join(tempDir, 'latest.json');
      assert.ok(fs.existsSync(latestPath));

      const jsonContent = JSON.parse(fs.readFileSync(res.jsonPath, 'utf8'));
      assert.equal(jsonContent.auditId, res.auditId);
      assert.ok(jsonContent.git);
      assert.ok(jsonContent.checks);

      const reportMarkdown = fs.readFileSync(res.reportPath, 'utf8');
      assert.ok(reportMarkdown.includes('Nightly Workspace Audit:'));
      assert.ok(reportMarkdown.includes('## 1. Git Hygiene'));
      assert.ok(reportMarkdown.includes('## 2. Static Analysis & Verification'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Layer 4: CLI Execution', () => {
  it('runs CLI with isolated runs directory cleanly', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-audit-cli-test-'));

    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, '--runs-dir', tempDir], {
        encoding: 'utf8',
      });
      assert.ok(stdout.includes('Nightly audit complete:'));
      assert.ok(stdout.includes('Report written to:'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
