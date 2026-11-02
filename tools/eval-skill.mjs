#!/usr/bin/env node
/**
 * tools/eval-skill.mjs - Layer 5: Synthetic Skill & Instruction Evaluation Gate
 *
 * Implements Section 5 of AGENTS.md:
 * - Generates synthetic test matrices crossing user intents, facts, and boundary conditions.
 * - Evaluates skills across trials using policy-as-code deterministic assertions.
 * - Compares baseline (v1) and candidate (v2) outcomes, scoring pass rates and flagging regressions.
 */

import { fileURLToPath } from 'node:url';

/**
 * Computes the Cartesian product of factor arrays into a test permutation matrix.
 *
 * @param {Record<string, Array<any>>} factors - Object where each key maps to an array of values
 * @returns {Array<Record<string, any>>} Array of combined permutation objects
 */
export function buildPermutationMatrix(factors) {
  const keys = Object.keys(factors);
  if (keys.length === 0) {
    return [];
  }

  const results = [];

  function helper(depth, current) {
    if (depth === keys.length) {
      results.push({ ...current });
      return;
    }
    const key = keys[depth];
    const values = factors[key];
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Factor "${key}" must be a non-empty array`);
    }
    for (const val of values) {
      current[key] = val;
      helper(depth + 1, current);
    }
  }

  helper(0, {});
  return results;
}

/**
 * Runs evaluation on a suite of test cases against a deterministic policy assertion.
 *
 * @param {object} options
 * @param {Array<Record<string, any>>} options.cases - Synthetic test cases
 * @param {(testCase: Record<string, any>) => any|Promise<any>} options.runner - Model or skill invocation function
 * @param {(testCase: Record<string, any>, outcome: any) => { passed: boolean, category: string, expected: any, actual: any, reason?: string }} options.policyAssert - Deterministic policy checker
 * @returns {Promise<{ total: number, passed: number, passRate: number, byCategory: Record<string, { total: number, passed: number, passRate: number }>, details: Array<any> }>}
 */
export async function evaluateSuite({ cases, runner, policyAssert }) {
  if (!Array.isArray(cases)) {
    throw new TypeError('cases must be an array');
  }
  if (typeof runner !== 'function' || typeof policyAssert !== 'function') {
    throw new TypeError('runner and policyAssert must be functions');
  }

  const details = [];
  const byCategory = {};
  let totalPassed = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const outcome = await runner(testCase);
    const assertion = policyAssert(testCase, outcome);

    const category = assertion.category || 'general';
    if (!byCategory[category]) {
      byCategory[category] = { total: 0, passed: 0, passRate: 0 };
    }
    byCategory[category].total++;

    if (assertion.passed) {
      totalPassed++;
      byCategory[category].passed++;
    }

    details.push({
      index: i,
      case: testCase,
      outcome,
      assertion,
    });
  }

  for (const cat of Object.keys(byCategory)) {
    const data = byCategory[cat];
    data.passRate = data.total > 0 ? Number((data.passed / data.total).toFixed(4)) : 0;
  }

  const passRate = cases.length > 0 ? Number((totalPassed / cases.length).toFixed(4)) : 0;

  return {
    total: cases.length,
    passed: totalPassed,
    passRate,
    byCategory,
    details,
  };
}

/**
 * Compares two evaluation runs (e.g. baseline v1 vs candidate v2) and identifies regressions.
 *
 * @param {object} v1Result - Baseline evaluation summary
 * @param {object} v2Result - Candidate evaluation summary
 * @returns {{ regressions: Array<any>, improvements: Array<any>, v1PassRate: number, v2PassRate: number, tableMarkdown: string }}
 */
export function summarizeEvaluation(v1Result, v2Result) {
  const regressions = [];
  const improvements = [];

  const count = Math.min(v1Result.details.length, v2Result.details.length);
  for (let i = 0; i < count; i++) {
    const v1Case = v1Result.details[i];
    const v2Case = v2Result.details[i];

    if (v1Case.assertion.passed && !v2Case.assertion.passed) {
      regressions.push({
        index: i,
        case: v1Case.case,
        v1Outcome: v1Case.outcome,
        v2Outcome: v2Case.outcome,
        expected: v1Case.assertion.expected,
        reason: v2Case.assertion.reason,
      });
    } else if (!v1Case.assertion.passed && v2Case.assertion.passed) {
      improvements.push({
        index: i,
        case: v2Case.case,
        v1Outcome: v1Case.outcome,
        v2Outcome: v2Case.outcome,
        expected: v2Case.assertion.expected,
      });
    }
  }

  // Generate markdown table
  const allCategories = Array.from(
    new Set([...Object.keys(v1Result.byCategory), ...Object.keys(v2Result.byCategory)])
  ).sort();

  const lines = [
    '| Category | V1 Pass Rate | V2 Pass Rate | Delta |',
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const cat of allCategories) {
    const r1 = v1Result.byCategory[cat]?.passRate ?? 0;
    const r2 = v2Result.byCategory[cat]?.passRate ?? 0;
    const diff = (r2 - r1) * 100;
    const deltaStr = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
    lines.push(`| ${cat} | ${(r1 * 100).toFixed(1)}% | ${(r2 * 100).toFixed(1)}% | ${deltaStr} |`);
  }

  const totalDiff = (v2Result.passRate - v1Result.passRate) * 100;
  lines.push(
    `| **Overall** | **${(v1Result.passRate * 100).toFixed(1)}%** | **${(v2Result.passRate * 100).toFixed(1)}%** | **${totalDiff >= 0 ? '+' : ''}${totalDiff.toFixed(1)}%** |`
  );

  return {
    regressions,
    improvements,
    v1PassRate: v1Result.passRate,
    v2PassRate: v2Result.passRate,
    tableMarkdown: lines.join('\n'),
  };
}

/**
 * Built-in demo verifying synthetic evaluation logic.
 */
export async function runSyntheticEvalDemo() {
  const factors = {
    plan: ['monthly', 'annual'],
    daysSinceCharge: [5, 15, 35],
    priorRefunds: [0, 2],
  };

  const matrix = buildPermutationMatrix(factors);

  // Deterministic policy as code
  const policy = (c) => {
    if (c.priorRefunds >= 2) {
      return 'escalate';
    }
    if (c.plan === 'monthly' && c.daysSinceCharge > 7) {
      return 'deny';
    }
    if (c.plan === 'annual' && c.daysSinceCharge > 30) {
      return 'deny';
    }
    return 'approve';
  };

  // V1 skill (buggy: treats annual as 7 days too)
  const runnerV1 = (c) => {
    if (c.priorRefunds >= 2) {
      return 'escalate';
    }
    if (c.daysSinceCharge > 7) {
      return 'deny';
    }
    return 'approve';
  };

  // V2 skill (fixed: respects 30 days for annual)
  const runnerV2 = (c) => {
    return policy(c);
  };

  const policyAssert = (c, outcome) => {
    const exp = policy(c);
    const category = `${c.plan}-refunds_${c.priorRefunds}`;
    return {
      passed: outcome === exp,
      category,
      expected: exp,
      actual: outcome,
    };
  };

  const v1Results = await evaluateSuite({ cases: matrix, runner: runnerV1, policyAssert });
  const v2Results = await evaluateSuite({ cases: matrix, runner: runnerV2, policyAssert });
  const summary = summarizeEvaluation(v1Results, v2Results);

  return { matrix, v1Results, v2Results, summary };
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(
      [
        'Usage:',
        '  node tools/eval-skill.mjs --demo',
        '  node tools/eval-skill.mjs --matrix <factors.json>',
      ].join('\n')
    );
    return 0;
  }

  if (args.includes('--demo')) {
    runSyntheticEvalDemo().then(({ matrix, summary }) => {
      console.log(`Evaluated ${matrix.length} synthetic permutation cases.\n`);
      console.log(summary.tableMarkdown);
      console.log(`\nImprovements: ${summary.improvements.length}, Regressions: ${summary.regressions.length}`);
      process.exit(summary.regressions.length > 0 ? 1 : 0);
    });
    return 0;
  }

  console.error(`Unknown argument: ${args.join(' ')}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv);
}
