/**
 * tools/resource-lease.mjs - Deterministic lease-based resource claims for concurrent agents.
 *
 * Prevents two background runs or agents from modifying the same resource simultaneously.
 * Uses atomic exclusive file creation (`wx`) under `.runs/leases/` with TTL expiration so
 * crashed or hung owners do not leave permanent locks.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_LEASES_DIR = path.join(ROOT, '.runs', 'leases');
export const DEFAULT_LEASE_TTL_MS = 60_000;

export function normalizeResourceKey(resource) {
  const normalized = String(resource ?? '').trim().replace(/\\/g, '/');
  if (!normalized) {
    throw new Error('Resource name must be a non-empty string.');
  }
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function readLeaseFile(leasePath) {
  try {
    return JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  } catch {
    return null;
  }
}

function isLeaseExpired(lease, nowMs) {
  if (!lease || !lease.expiresAt) {
    return true;
  }
  const expiresMs = new Date(lease.expiresAt).getTime();
  return Number.isNaN(expiresMs) || expiresMs <= nowMs;
}

/**
 * Acquire an exclusive lease on a resource.
 * @param {{ resource: string, owner: string, ttlMs?: number, leasesDir?: string, now?: Date }} opts
 */
export function acquireLease(opts) {
  const {
    resource,
    owner,
    ttlMs = DEFAULT_LEASE_TTL_MS,
    leasesDir = DEFAULT_LEASES_DIR,
    now = new Date(),
  } = opts ?? {};

  if (!owner || typeof owner !== 'string') {
    throw new Error('Lease owner must be a non-empty string.');
  }

  const key = normalizeResourceKey(resource);
  const leasePath = path.join(leasesDir, `${key}.json`);
  fs.mkdirSync(leasesDir, { recursive: true });

  const nowMs = now.getTime();
  const lease = {
    leaseId: crypto.randomUUID(),
    resource: String(resource).trim().replace(/\\/g, '/'),
    owner,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Math.max(1, Number(ttlMs))).toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { acquired: true, lease, leasePath };
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      const existing = readLeaseFile(leasePath);
      if (existing && !isLeaseExpired(existing, nowMs)) {
        return { acquired: false, conflict: existing, leasePath };
      }
      // Expired or corrupt lease: remove and retry atomic creation once.
      try {
        fs.unlinkSync(leasePath);
      } catch {
        // Another contender may have already unlinked/reclaimed it.
      }
    }
  }

  const finalExisting = readLeaseFile(leasePath);
  return { acquired: false, conflict: finalExisting, leasePath };
}

/**
 * Renew an active lease held by the same owner (and leaseId if provided).
 */
export function renewLease(opts) {
  const {
    resource,
    owner,
    leaseId,
    ttlMs = DEFAULT_LEASE_TTL_MS,
    leasesDir = DEFAULT_LEASES_DIR,
    now = new Date(),
  } = opts ?? {};

  const key = normalizeResourceKey(resource);
  const leasePath = path.join(leasesDir, `${key}.json`);
  if (!fs.existsSync(leasePath)) {
    return { renewed: false, reason: 'not_found' };
  }

  const existing = readLeaseFile(leasePath);
  const nowMs = now.getTime();
  if (!existing || isLeaseExpired(existing, nowMs)) {
    return { renewed: false, reason: 'expired' };
  }
  if (existing.owner !== owner || (leaseId && existing.leaseId !== leaseId)) {
    return { renewed: false, reason: 'owner_mismatch', conflict: existing };
  }

  const updated = {
    ...existing,
    expiresAt: new Date(nowMs + Math.max(1, Number(ttlMs))).toISOString(),
  };
  fs.writeFileSync(leasePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  return { renewed: true, lease: updated, leasePath };
}

/**
 * Release a held lease.
 */
export function releaseLease(opts) {
  const {
    resource,
    owner,
    leaseId,
    leasesDir = DEFAULT_LEASES_DIR,
  } = opts ?? {};

  const key = normalizeResourceKey(resource);
  const leasePath = path.join(leasesDir, `${key}.json`);
  if (!fs.existsSync(leasePath)) {
    return { released: false, reason: 'not_found' };
  }

  const existing = readLeaseFile(leasePath);
  if (existing && (existing.owner !== owner || (leaseId && existing.leaseId !== leaseId))) {
    return { released: false, reason: 'owner_mismatch', conflict: existing };
  }

  try {
    fs.unlinkSync(leasePath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { released: false, reason: 'not_found' };
    }
    throw err;
  }
  return { released: true, lease: existing };
}

/**
 * List all leases in `leasesDir` with active/expired status.
 */
export function inspectLeases(opts = {}) {
  const { leasesDir = DEFAULT_LEASES_DIR, now = new Date() } = opts;
  if (!fs.existsSync(leasesDir)) {
    return [];
  }
  const nowMs = now.getTime();
  const entries = [];
  for (const name of fs.readdirSync(leasesDir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const lease = readLeaseFile(path.join(leasesDir, name));
    if (lease) {
      entries.push({ ...lease, active: !isLeaseExpired(lease, nowMs) });
    }
  }
  return entries;
}
