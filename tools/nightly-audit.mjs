#!/usr/bin/env node
/**
 * tools/nightly-audit.mjs - Layer 4: Non-Blocking Nightly Workspace Audit & Report Generator
 *
 * Implements Section 4 of AGENTS.md:
 * - Collects workspace git status, static verification outcomes, and test results headless.
 * - Persists structured audit records to `.runs/audits/<timestamp>/summary.json` and `.md`.
 * - Enables asynchronous, signal-driven reporting without stalling interactive conversations.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactOutbound } from './sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs a command safely and returns its exit code and output.
 */
function runCommand(cmd, args, cwd = ROOT) {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { ok: true, code: 0, output: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      code: err.status ?? 1,
      output: (err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : ''),
    };
  }
}

/**
 * Gathers repository git hygiene status.
 */
export function getGitHygiene(cwd = ROOT) {
  const branchRes = runCommand('git', ['branch', '--show-current'], cwd);
  const statusRes = runCommand('git', ['status', '--porcelain'], cwd);
  const logRes = runCommand('git', ['log', '-n', '3', '--oneline'], cwd);

  const modified = [];
  const untracked = [];

  if (statusRes.ok && statusRes.output) {
    for (const line of statusRes.output.split('\n')) {
      const code = line.slice(0, 2).trim();
      const file = line.slice(3).trim();
      if (code === '??') {
        untracked.push(file);
      } else {
        modified.push(file);
      }
    }
  }

  return {
    branch: branchRes.output || 'unknown',
    isClean: modified.length === 0 && untracked.length === 0,
    modified,
    untracked,
    recentCommits: logRes.output ? logRes.output.split('\n') : [],
  };
}

/**
 * Executes workspace test and verification suites.
 */
export function runWorkspaceChecks(cwd = ROOT) {
  const checkMjs = path.join(cwd, 'tools', 'check.mjs');
  const staticRes = runCommand(process.execPath, [checkMjs], cwd);

  return {
    staticAnalysisPassed: staticRes.ok,
    output: redactOutbound(staticRes.output),
  };
}

/**
 * Generates and persists the complete audit report.
 *
 * @param {object} [options]
 * @param {string} [options.runsDir] - Path to write the run outputs (defaults to ROOT/.runs/audits)
 * @param {string} [options.cwd] - Working directory
 * @returns {{ auditId: string, timestamp: string, passed: boolean, reportPath: string, jsonPath: string, markdown: string }}
 */
export function executeNightlyAudit(options = {}) {
  const cwd = options.cwd ?? ROOT;
  const runsDir = options.runsDir ?? path.join(cwd, '.runs', 'audits');

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const auditId = `audit-${timestamp}`;
  const outDir = path.join(runsDir, auditId);

  fs.mkdirSync(outDir, { recursive: true });

  const git = getGitHygiene(cwd);
  const checks = runWorkspaceChecks(cwd);

  const passed = checks.staticAnalysisPassed;

  const markdownLines = [
    `# Nightly Workspace Audit: ${auditId}`,
    ``,
    `- **Date**: ${now.toISOString()}`,
    `- **Git Branch**: \`${git.branch}\``,
    `- **Status**: ${passed ? '🟢 PASS' : '🔴 FAIL'}`,
    ``,
    `## 1. Git Hygiene`,
    `- Clean Working Tree: ${git.isClean ? 'Yes' : 'No'}`,
    `- Modified Files (${git.modified.length}): ${git.modified.length ? git.modified.map((f) => `\`${f}\``).join(', ') : 'None'}`,
    `- Untracked Files (${git.untracked.length}): ${git.untracked.length ? git.untracked.map((f) => `\`${f}\``).join(', ') : 'None'}`,
    ``,
    `### Recent Commits`,
    ...(git.recentCommits.length ? git.recentCommits.map((c) => `- ${c}`) : ['- No commits']),
    ``,
    `## 2. Static Analysis & Verification`,
    `- Result: ${checks.staticAnalysisPassed ? 'All checks passed' : 'Verification failed'}`,
    '```',
    checks.output || 'No output recorded',
    '```',
  ];

  const markdown = markdownLines.join('\n');
  const reportPath = path.join(outDir, 'report.md');
  const jsonPath = path.join(outDir, 'summary.json');

  const summaryData = {
    auditId,
    timestamp: now.toISOString(),
    passed,
    git,
    checks,
  };

  fs.writeFileSync(reportPath, markdown, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(summaryData, null, 2), 'utf8');

  // Maintain latest pointer
  const latestPath = path.join(runsDir, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(summaryData, null, 2), 'utf8');

  return {
    auditId,
    timestamp: now.toISOString(),
    passed,
    reportPath,
    jsonPath,
    markdown,
  };
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage:',
        '  node tools/nightly-audit.mjs [--runs-dir <dir>]',
      ].join('\n')
    );
    return 0;
  }

  const rIdx = args.indexOf('--runs-dir');
  const runsDir = rIdx !== -1 && args[rIdx + 1] ? path.resolve(args[rIdx + 1]) : undefined;

  const result = executeNightlyAudit({ runsDir });
  console.log(`Nightly audit complete: ${result.auditId}`);
  console.log(`Report written to: ${result.reportPath}`);
  console.log(`Summary written to: ${result.jsonPath}`);
  console.log(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);

  return result.passed ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli(process.argv);
}
