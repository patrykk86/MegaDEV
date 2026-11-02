#!/usr/bin/env node
/**
 * tools/eval-skill.test.mjs - Unit tests for Layer 5 Synthetic Skill Evaluation Gate
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPermutationMatrix,
  evaluateSuite,
  runSyntheticEvalDemo,
  summarizeEvaluation,
} from './eval-skill.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(THIS_DIR, 'eval-skill.mjs');

describe('Layer 5: buildPermutationMatrix()', () => {
  it('computes exact Cartesian product of factor arrays', () => {
    const factors = {
      role: ['admin', 'user'],
      tier: ['free', 'paid'],
      status: [1, 2],
    };
    const matrix = buildPermutationMatrix(factors);
    assert.equal(matrix.length, 8); // 2 * 2 * 2 = 8
    assert.deepEqual(matrix[0], { role: 'admin', tier: 'free', status: 1 });
    assert.deepEqual(matrix[7], { role: 'user', tier: 'paid', status: 2 });
  });

  it('returns empty array when factors object is empty', () => {
    assert.deepEqual(buildPermutationMatrix({}), []);
  });

  it('throws when factor is not an array or is empty', () => {
    assert.throws(() => buildPermutationMatrix({ invalid: 'not-array' }), Error);
    assert.throws(() => buildPermutationMatrix({ empty: [] }), Error);
  });
});

describe('Layer 5: evaluateSuite() & summarizeEvaluation()', () => {
  it('correctly calculates pass rates, identifies improvements and flags regressions', async () => {
    const cases = [
      { id: 1, val: 10 },
      { id: 2, val: 20 },
      { id: 3, val: 30 },
    ];

    const policyAssert = (c, outcome) => {
      const expected = c.val > 15;
      return {
        passed: outcome === expected,
        category: c.val > 20 ? 'high' : 'low',
        expected,
        actual: outcome,
      };
    };

    // V1 gets case 1 and 2 right, fails case 3
    const runnerV1 = (c) => (c.id === 3 ? false : c.val > 15);
    // V2 fixes case 3, but breaks case 1 (a regression!)
    const runnerV2 = (c) => (c.id === 1 ? true : c.val > 15);

    const v1Res = await evaluateSuite({ cases, runner: runnerV1, policyAssert });
    const v2Res = await evaluateSuite({ cases, runner: runnerV2, policyAssert });

    assert.equal(v1Res.passed, 2);
    assert.equal(v2Res.passed, 2);

    const summary = summarizeEvaluation(v1Res, v2Res);

    assert.equal(summary.regressions.length, 1);
    assert.equal(summary.regressions[0].case.id, 1); // Case 1 regressed

    assert.equal(summary.improvements.length, 1);
    assert.equal(summary.improvements[0].case.id, 3); // Case 3 improved

    assert.ok(summary.tableMarkdown.includes('| Category | V1 Pass Rate | V2 Pass Rate | Delta |'));
    assert.ok(summary.tableMarkdown.includes('Overall'));
  });

  it('runs the built-in synthetic evaluation demo cleanly with zero regressions', async () => {
    const { matrix, summary } = await runSyntheticEvalDemo();
    assert.equal(matrix.length, 12);
    assert.equal(summary.regressions.length, 0);
    assert.ok(summary.improvements.length > 0);
    assert.equal(summary.v2PassRate, 1.0);
  });
});

describe('Layer 5: CLI Execution', () => {
  it('executes --demo via child process successfully', () => {
    const stdout = execFileSync(process.execPath, [CLI_PATH, '--demo'], { encoding: 'utf8' });
    assert.ok(stdout.includes('Evaluated 12 synthetic permutation cases.'));
    assert.ok(stdout.includes('Overall'));
    assert.ok(stdout.includes('Regressions: 0'));
  });
});

