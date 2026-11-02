/**
 * @fileoverview Core types, validation routines, cryptographic helpers, and custom errors
 * for Phase 1 of the Memory Architecture.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Regular Expressions
// ============================================================================

/**
 * Matches Windows reserved filenames (case-insensitive), with or without extensions.
 */
export const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Matches safe, standard identifiers: starts with alphanumeric, followed by
 * up to 63 alphanumeric, underscore, or hyphen characters (1-64 chars total).
 */
export const ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Matches Event IDs formatted as: evt-<agent_id>-<6_digit_sequence>
 * Enforces a total maximum length of 64 characters via positive lookahead.
 */
export const EVENT_ID_REGEX = /^(?=.{12,64}$)^evt-[a-zA-Z0-9][a-zA-Z0-9_-]*-\d{6}$/;

/**
 * Matches a standard 64-character lowercase hexadecimal SHA-256 hash.
 */
export const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Matches a standard 40-character lowercase hexadecimal Git commit SHA-1 hash.
 */
export const GIT_COMMIT_SHA = /^[a-f0-9]{40}$/;

/**
 * Matches and parses a symbol pointer URI:
 * Format: symbol://<relative_file_path>#<symbol_name>?sha=<symbol_sha256>
 */
export const SYMBOL_POINTER_REGEX =
  /^symbol:\/\/((?!\.{1,2}(?:\/|#))[A-Za-z0-9_\-.]+(?:\/(?!\.{1,2}(?:\/|#))[A-Za-z0-9_\-.]+)*)#([A-Za-z_][A-Za-z0-9_]*)\?sha=([a-f0-9]{64})$/;

// ============================================================================
// Custom Error Classes
// ============================================================================

export class SecurityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SecurityError';
    this.code = 'ERR_MEMORY_SECURITY';
    this.details = details;
    Error.captureStackTrace?.(this, SecurityError);
  }
}

export class StaleSymbolPointerError extends Error {
  constructor(pointer, expectedSha, actualSha) {
    super(`Stale symbol pointer "${pointer}": expected SHA ${expectedSha}, got ${actualSha}`);
    this.name = 'StaleSymbolPointerError';
    this.code = 'ERR_STALE_SYMBOL_POINTER';
    this.pointer = pointer;
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
    Error.captureStackTrace?.(this, StaleSymbolPointerError);
  }
}

export class EventSequenceExhaustedError extends Error {
  constructor(agentId, lastSequence = 999999) {
    super(`Event sequence exhausted for agent "${agentId}" at sequence ${lastSequence}`);
    this.name = 'EventSequenceExhaustedError';
    this.code = 'ERR_EVENT_SEQUENCE_EXHAUSTED';
    this.agentId = agentId;
    this.lastSequence = lastSequence;
    Error.captureStackTrace?.(this, EventSequenceExhaustedError);
  }
}

export class RuleBudgetExceededError extends Error {
  constructor(message, metrics) {
    super(message);
    this.name = 'RuleBudgetExceededError';
    this.code = 'ERR_RULE_BUDGET_EXCEEDED';
    this.metrics = metrics;
    Error.captureStackTrace?.(this, RuleBudgetExceededError);
  }
}

// ============================================================================
// Validation Functions
// ============================================================================

export function validateId(id, label = 'id') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new SecurityError(`Invalid ${label}: must be a non-empty string.`, { id, label });
  }

  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new SecurityError(`Security violation in ${label}: path traversal or separator characters detected.`, { id, label });
  }

  if (WINDOWS_RESERVED.test(id)) {
    throw new SecurityError(`Security violation in ${label}: "${id}" is a Windows reserved filename.`, { id, label });
  }

  if (!ID_REGEX.test(id)) {
    throw new SecurityError(
      `Invalid ${label} "${id}": must match ${ID_REGEX.source} (1-64 alphanumeric, underscore, or hyphen chars).`,
      { id, label }
    );
  }

  return id;
}

function validatePointerPathSegments(rawFilePath, pointer) {
  if (
    rawFilePath.includes('\\') ||
    rawFilePath.includes('\0') ||
    rawFilePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(rawFilePath)
  ) {
    throw new SecurityError(`Invalid path format in symbol pointer: "${rawFilePath}". Must be a POSIX relative path.`, {
      pointer,
      rawFilePath,
    });
  }

  const segments = rawFilePath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[. ]$/.test(segment)) {
      throw new SecurityError(`Path traversal, empty, or trailing dot/space segment in symbol pointer: "${rawFilePath}".`, {
        pointer,
        segment,
      });
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new SecurityError(`Windows reserved filename "${segment}" detected in symbol pointer path.`, {
        pointer,
        segment,
      });
    }
  }
  return segments;
}

function verifySymlinkContainment(resolvedRoot, resolvedTarget, rawFilePath, pointer) {
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realTarget = fs.realpathSync(resolvedTarget);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new SecurityError(`Symlink escape detected: "${rawFilePath}" resolves outside workspace root.`, {
        pointer,
        realRoot,
        realTarget,
      });
    }
  } catch (err) {
    if (err instanceof SecurityError) {
      throw err;
    }
    throw new SecurityError(`Failed resolving canonical realpath for "${rawFilePath}": ${err.message}`, { pointer });
  }
}

export function validateSymbolPointer(pointer, workspaceRoot, options = {}) {
  if (typeof pointer !== 'string' || pointer.length === 0) {
    throw new SecurityError('Symbol pointer must be a non-empty string.', { pointer });
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new SecurityError('Workspace root must be a non-empty string.', { workspaceRoot });
  }

  const match = SYMBOL_POINTER_REGEX.exec(pointer);
  if (!match) {
    throw new SecurityError(`Malformed symbol pointer: "${pointer}". Expected format: symbol://<path>#<symbol>?sha=<sha256>`, {
      pointer,
    });
  }

  const [, rawFilePath, symbolName, sha256] = match;
  const segments = validatePointerPathSegments(rawFilePath, pointer);

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(resolvedRoot, rawFilePath);
  const relFromRoot = path.relative(resolvedRoot, resolvedTarget);

  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot) || resolvedTarget === resolvedRoot) {
    throw new SecurityError(`Symbol pointer path "${rawFilePath}" escapes or equals workspace root.`, {
      pointer,
      resolvedRoot,
      resolvedTarget,
    });
  }

  if (options.verifyRealpath !== false && fs.existsSync(resolvedTarget)) {
    verifySymlinkContainment(resolvedRoot, resolvedTarget, rawFilePath, pointer);
  }

  return {
    uri: pointer,
    relativePath: segments.join('/'),
    absolutePath: resolvedTarget,
    symbolName,
    sha256,
  };
}

// ============================================================================
// Hash Helpers
// ============================================================================

export function computeContentSha256(content) {
  if (typeof content !== 'string' && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw new TypeError('Content must be a string, Buffer, or Uint8Array.');
  }
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function computeSymbolSha(astBody) {
  if (typeof astBody !== 'string') {
    throw new TypeError('astBody must be a string.');
  }
  // Normalize Unicode to NFC, normalize CRLF/CR to LF, and trim
  const normalized = astBody.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
