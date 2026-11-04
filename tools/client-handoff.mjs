#!/usr/bin/env node
/**
 * tools/client-handoff.mjs - Freelance Deliverable Audit & Handoff Packager
 *
 * Audits deliverable files against freelance quality contracts:
 * - Enforces path containment inside project root (no traversal or symlink escapes).
 * - Verifies file presence and non-zero byte size.
 * - Single-pass buffer hashing (SHA-256) and credential pattern scanning.
 * - Generates sanitized, escaped client-facing DELIVERY.md manifest.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
});

const NON_RELATIVE_PATH_RE = /^(?:[A-Za-z]:|\\\\|\/\/)/;
const MAX_SCAN_BYTES = 5 * 1024 * 1024; // 5MB scan limit

export const SECRET_RULES = Object.freeze([
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { id: 'github-token', re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9_]{36,255}/ },
  { id: 'openai-api-key', re: /(?<![A-Za-z0-9])sk-[a-zA-Z0-9_-]{20,}/ },
  { id: 'aws-access-key', re: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'generic-credential', re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?([a-zA-Z0-9_\-.~+]{12,})/i },
]);

export function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function resolveSyntacticInside(rootDir, relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('Path must be a non-empty string');
  }
  if (isAbsolute(relPath) || NON_RELATIVE_PATH_RE.test(relPath)) {
    throw new Error(`Absolute path forbidden: "${relPath}"`);
  }
  const root = fs.realpathSync(rootDir);
  const candidate = resolve(root, relPath);
  if (!isInside(root, candidate)) {
    throw new Error(`Path escapes project root: "${relPath}"`);
  }
  return candidate;
}

export function resolveRealInside(rootDir, relPath) {
  const rootReal = fs.realpathSync(rootDir);
  const lexical = resolveSyntacticInside(rootDir, relPath);
  if (!fs.existsSync(lexical)) {
    throw new Error(`File not found: "${relPath}"`);
  }
  const real = fs.realpathSync(lexical);
  if (!isInside(rootReal, real)) {
    throw new Error(`Symlink escapes project root: "${relPath}"`);
  }
  return real;
}

function scanBufferForSecrets(buffer, relPath) {
  const issues = [];
  const text = buffer.toString('latin1');
  for (const rule of SECRET_RULES) {
    if (rule.re.test(text)) {
      issues.push(`Credential detected [rule: ${rule.id}] in "${relPath}"`);
    }
  }
  return issues;
}

export function auditFile(relPath, rootDir) {
  let realPath;
  try {
    realPath = resolveRealInside(rootDir, relPath);
  } catch (err) {
    return {
      path: relPath,
      exists: false,
      size: 0,
      sha256: null,
      issues: [err.message],
    };
  }

  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch (err) {
    return {
      path: relPath,
      exists: false,
      size: 0,
      sha256: null,
      issues: [`Failed to stat file "${relPath}": ${err.message}`],
    };
  }

  if (stat.isDirectory()) {
    return {
      path: relPath,
      exists: true,
      size: 0,
      sha256: null,
      issues: [`Item is a directory, not a deliverable file: "${relPath}"`],
    };
  }

  const issues = [];
  if (stat.size === 0) {
    issues.push(`Empty file (0 bytes): "${relPath}"`);
  }

  if (stat.size > MAX_SCAN_BYTES) {
    issues.push(`File too large to scan for credentials (>5MB): "${relPath}"`);
    return {
      path: relPath,
      exists: true,
      size: stat.size,
      sha256: null,
      issues,
    };
  }

  let sha256 = null;
  try {
    const buffer = fs.readFileSync(realPath);
    sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const secretIssues = scanBufferForSecrets(buffer, relPath);
    issues.push(...secretIssues);
  } catch (err) {
    issues.push(`Failed to read/hash file "${relPath}": ${err.message}`);
  }

  return {
    path: relPath,
    exists: true,
    size: stat.size,
    sha256,
    issues,
  };
}

const escapeText = (s) =>
  String(s).replace(/[\\`*_[\]<>|\r\n]/g, (c) => (c === '\r' || c === '\n' ? ' ' : `\\${c}`));
const sanitizeCodeSpan = (s) =>
  `\`${String(s).replace(/[`\r\n]/g, "'").replace(/\|/g, '\\|')}\``;

export function buildManifest({ milestone, client, results, totalBytes, status }) {
  const clientLine = client ? `\n**Client:** ${escapeText(client)}` : '';
  const rows = results.map((r) => {
    const auditStatus = r.issues.length === 0 ? '✓ Ready' : `✗ Issues (${r.issues.length})`;
    const hash = r.sha256 ? sanitizeCodeSpan(`${r.sha256.slice(0, 12)}...`) : 'N/A';
    const kb = (r.size / 1024).toFixed(1);
    return `| ${sanitizeCodeSpan(r.path)} | ${kb} KB | ${hash} | ${auditStatus} |`;
  });

  const statusNotice =
    status === STATUS.PASSED
      ? 'All listed files were checked for existence, root containment, and known credential patterns. Detection only; no content was redacted.'
      : '⚠️ Audit failed. Deliverables contain unresolved validation issues that must be remediated before handoff.';

  return `# Client Delivery Manifest: ${escapeText(milestone)}
${clientLine}
**Deliverable Files:** ${results.length}  
**Total Size:** ${(totalBytes / 1024).toFixed(1)} KB  
**Status:** ${status.toUpperCase()}  

## Deliverable File Integrity

| File Path | Size | SHA-256 (prefix) | Audit Status |
| :--- | :--- | :--- | :--- |
${rows.join('\n')}

## Acceptance & Verification
${statusNotice}
`;
}

function assertNotSymlink(targetPath, label) {
  let st;
  try {
    st = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link ${label}: "${targetPath}"`);
  }
}

export function writeManifestSafely(rootDir, outputManifest, content) {
  const rootReal = fs.realpathSync(rootDir);
  const manifestLexical = resolveSyntacticInside(rootDir, outputManifest);
  const parentLexical = dirname(manifestLexical);
  if (!fs.existsSync(parentLexical)) {
    throw new Error(`Manifest parent directory does not exist: "${parentLexical}"`);
  }
  const parentReal = fs.realpathSync(parentLexical);
  if (!isInside(rootReal, parentReal)) {
    throw new Error(`Manifest directory escapes project root: "${outputManifest}"`);
  }

  assertNotSymlink(manifestLexical, 'manifest');

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW ?? 0);

  const fd = fs.openSync(manifestLexical, flags, 0o644);
  try {
    fs.writeSync(fd, content, null, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
  return manifestLexical;
}

export function auditDeliverables(options, rootDir = process.cwd()) {
  const { milestone, client, files = [], outputManifest = 'DELIVERY.md' } = options;

  if (!milestone) {
    throw new Error('Missing required parameter: "milestone"');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Parameter "files" must be a non-empty array of file paths');
  }

  const results = files.map((f) => auditFile(f, rootDir));
  const allIssues = results.flatMap((r) => r.issues);
  const totalBytes = results.reduce((acc, r) => acc + (r.size || 0), 0);
  const clean = allIssues.length === 0;
  const status = clean ? STATUS.PASSED : STATUS.FAILED;

  let writtenPath = null;
  if (outputManifest) {
    const manifestContent = buildManifest({ milestone, client, results, totalBytes, status });
    writtenPath = writeManifestSafely(rootDir, outputManifest, manifestContent);
  }

  return {
    status,
    milestone,
    client: client || null,
    manifestPath: writtenPath,
    summary: {
      totalFiles: files.length,
      totalBytes,
      clean,
      issueCount: allIssues.length,
    },
    files: results,
    issues: allIssues,
  };
}

// CLI Execution
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  try {
    const { values } = parseArgs({
      options: {
        milestone: { type: 'string' },
        client: { type: 'string' },
        file: { type: 'string', multiple: true, default: [] },
        output: { type: 'string', default: 'DELIVERY.md' },
        stdin: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });

    let options;
    if (values.stdin) {
      const raw = fs.readFileSync(0, 'utf-8');
      options = JSON.parse(raw);
    } else {
      if (!values.milestone || values.file.length === 0) {
        console.error('Usage: node tools/client-handoff.mjs --milestone <name> --file <path> [--file <path>] [--client <name>] [--output <path>]');
        process.exit(2);
      }
      options = {
        milestone: values.milestone,
        client: values.client,
        files: values.file,
        outputManifest: values.output,
      };
    }

    const result = auditDeliverables(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === STATUS.FAILED) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
}
