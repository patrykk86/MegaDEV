#!/usr/bin/env node
/**
 * tools/client-handoff.test.mjs - Unit tests for client-handoff tool
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STATUS, auditDeliverables } from './client-handoff.mjs';

// A key-shaped fixture, assembled at runtime so no 39-character key sits in tracked source: the
// auditor still reads the real string out of the temp file, so the google-api-key rule fires exactly
// as before. Same convention as the fake OpenRouter key in tools/sanitize.test.mjs.
const FAKE_GOOGLE_KEY = ['AIza', 'SyA', '1234567890', '1234567890', '123456789012'].join('');

describe('client-handoff: valid delivery flow', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-handoff-valid-'));
    fs.writeFileSync(path.join(tmpDir, 'valid.txt'), 'Hello world deliverable', 'utf-8');
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes on valid clean deliverable files and generates manifest', () => {
    const result = auditDeliverables(
      {
        milestone: 'Sprint 1 [Alpha] *Final*',
        client: 'Acme <Corp> & Co.',
        files: ['valid.txt'],
        outputManifest: 'DELIVERY.md',
      },
      tmpDir
    );

    assert.equal(result.status, STATUS.PASSED);
    assert.equal(result.summary.clean, true);
    assert.equal(result.summary.totalFiles, 1);
    assert.equal(result.issues.length, 0);

    const manifestPath = path.join(tmpDir, 'DELIVERY.md');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = fs.readFileSync(manifestPath, 'utf-8');
    assert.ok(manifest.includes('Sprint 1 \\[Alpha\\]'));
    assert.ok(manifest.includes('PASSED'));
    assert.ok(manifest.includes('valid.txt'));
  });
});

describe('client-handoff: policy violations', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-handoff-viol-'));
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), '', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'leaky.env'), FAKE_GOOGLE_KEY, 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'somedir'));
  });

  after(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('flags missing files', () => {
    const result = auditDeliverables({ milestone: 'M1', files: ['missing.txt'], outputManifest: null }, tmpDir);
    assert.equal(result.status, STATUS.FAILED);
    assert.ok(result.issues.some((i) => i.includes('File not found')));
  });

  it('flags empty files and directories', () => {
    const result = auditDeliverables({ milestone: 'M1', files: ['empty.txt', 'somedir'], outputManifest: null }, tmpDir);
    assert.equal(result.status, STATUS.FAILED);
    assert.ok(result.issues.some((i) => i.includes('Empty file')));
    assert.ok(result.issues.some((i) => i.includes('Item is a directory')));
  });

  it('detects credentials with rule IDs', () => {
    const result = auditDeliverables({ milestone: 'M1', files: ['leaky.env'], outputManifest: null }, tmpDir);
    assert.equal(result.status, STATUS.FAILED);
    assert.ok(result.issues.some((i) => i.includes('google-api-key')));
  });

  it('rejects path traversal and absolute paths before reading', () => {
    const absFixture = `${'C:'}\\absolute\\path.txt`;
    const result = auditDeliverables({ milestone: 'M1', files: ['../outside.txt', absFixture], outputManifest: null }, tmpDir);
    assert.equal(result.status, STATUS.FAILED);
    assert.ok(result.issues.some((i) => i.includes('escapes project root') || i.includes('Absolute path forbidden')));
  });
});
