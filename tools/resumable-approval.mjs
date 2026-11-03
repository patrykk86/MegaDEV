/**
 * @fileoverview Durable Resumable Tool Approval Engine for MegaDEV (AGENTS.md Section 8).
 *
 * Implements durable, serialized suspension mechanism allowing tool approval pauses
 * to persist across days in .approvals/<approval-id>.json without holding process resources,
 * with HMAC-SHA256 tamper-proofing and clean resumption.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_APPROVALS_DIR = '.approvals';
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_HMAC_SECRET = process.env.MEGADEV_APPROVAL_SECRET || 'megadev-canonical-approval-secret-v1';

/**
 * Computes deterministic HMAC-SHA256 fingerprint for approval state.
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
export function computeFingerprint(payload, secret = DEFAULT_HMAC_SECRET) {
  const canonical = JSON.stringify({
    approvalId: payload.approvalId,
    toolCall: payload.toolCall,
    state: payload.state,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    status: payload.status,
  });
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Generates safe unique approval ID: appr-<timestamp>-<8-char-hex>
 * @returns {string}
 */
export function generateApprovalId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `appr-${ts}-${rand}`;
}

/**
 * Creates a durable suspension record on disk.
 *
 * @param {object} params
 * @param {object} params.toolCall - Pending tool call { id, name, arguments }
 * @param {object} params.state - Current agent state { step, messages, usage, model, limits, settings }
 * @param {string} [params.prompt] - User-facing description of what tool wants to do
 * @param {string} [params.runId] - Associated run ID
 * @param {string} [params.sessionId] - Associated session ID
 * @param {number} [params.ttlMs=DEFAULT_TTL_MS] - Time to live in milliseconds
 * @param {string} [params.approvalsDir=DEFAULT_APPROVALS_DIR] - Directory to store suspensions
 * @param {string} [params.workspaceRoot=process.cwd()]
 * @param {string} [params.secret=DEFAULT_HMAC_SECRET]
 * @returns {{ approvalId: string, filePath: string, record: object }}
 */
export function createSuspension({
  toolCall,
  state,
  prompt = '',
  runId = null,
  sessionId = null,
  ttlMs = DEFAULT_TTL_MS,
  approvalsDir = DEFAULT_APPROVALS_DIR,
  workspaceRoot = process.cwd(),
  secret = DEFAULT_HMAC_SECRET,
}) {
  if (!toolCall || typeof toolCall.name !== 'string') {
    throw new TypeError('createSuspension requires a valid toolCall object');
  }
  if (!state || !Array.isArray(state.messages)) {
    throw new TypeError('createSuspension requires a valid agent state with messages');
  }

  const approvalId = generateApprovalId();
  const targetDir = path.resolve(workspaceRoot, approvalsDir);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();

  // Create deep clone of state to avoid mutated references
  const stateSnapshot = {
    step: state.step ?? 1,
    messages: JSON.parse(JSON.stringify(state.messages)),
    usage: state.usage ?? 0,
    model: state.model,
    limits: state.limits ? { ...state.limits } : undefined,
    settings: state.settings ? { ...state.settings } : undefined,
  };

  const record = {
    approvalId,
    runId,
    sessionId,
    createdAt,
    expiresAt,
    status: 'pending',
    toolCall: JSON.parse(JSON.stringify(toolCall)),
    prompt,
    state: stateSnapshot,
    resolvedAt: null,
    resolvedBy: null,
    decision: null,
    feedback: null,
  };

  record.fingerprint = computeFingerprint(record, secret);

  const filePath = path.join(targetDir, `${approvalId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');

  return {
    approvalId,
    filePath,
    record,
  };
}

/**
 * Loads and verifies a suspension record from disk.
 *
 * @param {string} approvalId - The ID of the approval
 * @param {object} [options]
 * @param {string} [options.approvalsDir=DEFAULT_APPROVALS_DIR]
 * @param {string} [options.workspaceRoot=process.cwd()]
 * @param {string} [options.secret=DEFAULT_HMAC_SECRET]
 * @returns {object} The verified suspension record
 */
export function loadSuspension(approvalId, {
  approvalsDir = DEFAULT_APPROVALS_DIR,
  workspaceRoot = process.cwd(),
  secret = DEFAULT_HMAC_SECRET,
} = {}) {
  if (!approvalId || typeof approvalId !== 'string' || !/^appr-[a-zA-Z0-9_-]+$/.test(approvalId)) {
    throw new Error(`Invalid approvalId format: "${approvalId}"`);
  }

  const filePath = path.resolve(workspaceRoot, approvalsDir, `${approvalId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Suspension record not found for approval "${approvalId}" at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  let record;
  try {
    record = JSON.parse(content);
  } catch (err) {
    throw new Error(`Corrupted JSON in suspension record "${approvalId}": ${err.message}`);
  }

  // Verify HMAC fingerprint against tampering
  const expectedFingerprint = computeFingerprint(record, secret);
  if (record.fingerprint !== expectedFingerprint) {
    throw new Error(`Security error: suspension record "${approvalId}" failed HMAC integrity verification (tampered or corrupted)`);
  }

  // Check TTL expiration
  if (record.status === 'pending' && new Date(record.expiresAt).getTime() < Date.now()) {
    record.status = 'expired';
    record.fingerprint = computeFingerprint(record, secret);
    try {
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    } catch {
      // Best-effort write for expired marker
    }
  }

  return record;
}

/**
 * Resolves a pending suspension with an approval or rejection decision.
 *
 * @param {string} approvalId
 * @param {object} options
 * @param {'approved'|'rejected'} options.decision
 * @param {string} [options.responder='user']
 * @param {string} [options.feedback='']
 * @param {string} [options.approvalsDir=DEFAULT_APPROVALS_DIR]
 * @param {string} [options.workspaceRoot=process.cwd()]
 * @param {string} [options.secret=DEFAULT_HMAC_SECRET]
 * @returns {object} Updated record
 */
export function resolveSuspension(approvalId, {
  decision,
  responder = 'user',
  feedback = '',
  approvalsDir = DEFAULT_APPROVALS_DIR,
  workspaceRoot = process.cwd(),
  secret = DEFAULT_HMAC_SECRET,
}) {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new TypeError(`Decision must be "approved" or "rejected", received "${decision}"`);
  }

  const record = loadSuspension(approvalId, { approvalsDir, workspaceRoot, secret });
  if (record.status !== 'pending') {
    throw new Error(`Cannot resolve suspension "${approvalId}" with status "${record.status}"`);
  }

  record.status = decision;
  record.decision = decision;
  record.resolvedAt = new Date().toISOString();
  record.resolvedBy = responder;
  record.feedback = feedback;
  record.fingerprint = computeFingerprint(record, secret);

  const filePath = path.resolve(workspaceRoot, approvalsDir, `${approvalId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');

  return record;
}

/**
 * Lists all pending approvals in the approvals directory.
 *
 * @param {object} [options]
 * @param {string} [options.approvalsDir=DEFAULT_APPROVALS_DIR]
 * @param {string} [options.workspaceRoot=process.cwd()]
 * @param {string} [options.secret=DEFAULT_HMAC_SECRET]
 * @returns {Array<object>}
 */
export function listPendingApprovals({
  approvalsDir = DEFAULT_APPROVALS_DIR,
  workspaceRoot = process.cwd(),
  secret = DEFAULT_HMAC_SECRET,
} = {}) {
  const targetDir = path.resolve(workspaceRoot, approvalsDir);
  if (!fs.existsSync(targetDir)) {
    return [];
  }

  const files = fs.readdirSync(targetDir).filter((f) => f.startsWith('appr-') && f.endsWith('.json'));
  const pending = [];

  for (const f of files) {
    const approvalId = path.basename(f, '.json');
    try {
      const record = loadSuspension(approvalId, { approvalsDir, workspaceRoot, secret });
      if (record.status === 'pending') {
        pending.push({
          approvalId: record.approvalId,
          toolName: record.toolCall?.name,
          prompt: record.prompt,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          sessionId: record.sessionId,
          runId: record.runId,
        });
      }
    } catch {
      // Ignore corrupted or invalid files in directory
    }
  }

  return pending;
}
