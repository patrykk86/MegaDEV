import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireLease,
  inspectLeases,
  releaseLease,
  renewLease,
} from './resource-lease.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-lease-test-'));
}

test('acquireLease grants exclusive lock and blocks competing owner until released', () => {
  const leasesDir = makeTempDir();
  try {
    const t0 = new Date('2026-11-17T18:00:00.000Z');
    const first = acquireLease({
      resource: 'tools/scheduler/runner.mjs',
      owner: 'agent-a',
      ttlMs: 30_000,
      leasesDir,
      now: t0,
    });
    assert.equal(first.acquired, true);
    assert.equal(first.lease.owner, 'agent-a');

    const second = acquireLease({
      resource: 'tools/scheduler/runner.mjs',
      owner: 'agent-b',
      ttlMs: 30_000,
      leasesDir,
      now: new Date(t0.getTime() + 5_000),
    });
    assert.equal(second.acquired, false);
    assert.equal(second.conflict.owner, 'agent-a');

    const wrongRelease = releaseLease({
      resource: 'tools/scheduler/runner.mjs',
      owner: 'agent-b',
      leasesDir,
    });
    assert.equal(wrongRelease.released, false);
    assert.equal(wrongRelease.reason, 'owner_mismatch');

    const released = releaseLease({
      resource: 'tools/scheduler/runner.mjs',
      owner: 'agent-a',
      leaseId: first.lease.leaseId,
      leasesDir,
    });
    assert.equal(released.released, true);

    const third = acquireLease({
      resource: 'tools/scheduler/runner.mjs',
      owner: 'agent-b',
      ttlMs: 30_000,
      leasesDir,
      now: new Date(t0.getTime() + 6_000),
    });
    assert.equal(third.acquired, true);
  } finally {
    fs.rmSync(leasesDir, { recursive: true, force: true });
  }
});

test('acquireLease reclaims expired lease and renewLease extends active lease', () => {
  const leasesDir = makeTempDir();
  try {
    const t0 = new Date('2026-11-17T18:00:00.000Z');
    const first = acquireLease({
      resource: 'task:nightly-audit',
      owner: 'agent-a',
      ttlMs: 10_000,
      leasesDir,
      now: t0,
    });
    assert.equal(first.acquired, true);

    const renewed = renewLease({
      resource: 'task:nightly-audit',
      owner: 'agent-a',
      leaseId: first.lease.leaseId,
      ttlMs: 20_000,
      leasesDir,
      now: new Date(t0.getTime() + 5_000),
    });
    assert.equal(renewed.renewed, true);

    // Still active at +15s because it was renewed to +25s.
    const blocked = acquireLease({
      resource: 'task:nightly-audit',
      owner: 'agent-b',
      ttlMs: 10_000,
      leasesDir,
      now: new Date(t0.getTime() + 15_000),
    });
    assert.equal(blocked.acquired, false);

    // Expired at +30s -> agent-b reclaims it.
    const reclaimed = acquireLease({
      resource: 'task:nightly-audit',
      owner: 'agent-b',
      ttlMs: 10_000,
      leasesDir,
      now: new Date(t0.getTime() + 30_000),
    });
    assert.equal(reclaimed.acquired, true);
    assert.equal(reclaimed.lease.owner, 'agent-b');

    const active = inspectLeases({ leasesDir, now: new Date(t0.getTime() + 31_000) });
    assert.equal(active.length, 1);
    assert.equal(active[0].active, true);
  } finally {
    fs.rmSync(leasesDir, { recursive: true, force: true });
  }
});
