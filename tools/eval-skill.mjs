#!/usr/bin/env node
/**
 * tools/eval-skill.mjs - Layer 5: Synthetic Skill & Instruction Evaluation Gate
 *
 * Implements Section 5 of AGENTS.md:
 * - Generates synthetic test matrices crossing user intents, facts, and boundary conditions.
 * - Evaluates skills across trials using policy-as-code deterministic assertions.
 * - Compares baseline (v1) and candidate (v2) outcomes, scoring pass rates and flagging regressions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSkillOverlap, validateSkill } from './check-skills.mjs';

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

async function runCaseAcrossTrials(testCase, runner, policyAssert, trials) {
  let firstOutcome = null;
  let firstAssertion = null;
  let passedAll = true;
  const trialOutcomes = [];

  for (let t = 0; t < trials; t++) {
    const outcome = await runner(testCase, t);
    const assertion = policyAssert(testCase, outcome, t);
    if (t === 0) {
      firstOutcome = outcome;
      firstAssertion = assertion;
    }
    if (!assertion.passed) {
      passedAll = false;
    }
    trialOutcomes.push({ trial: t + 1, passed: assertion.passed, outcome });
  }

  return { firstOutcome, firstAssertion, passedAll, trialOutcomes };
}

function recordCategoryCase(byCategory, category, passedFirst, passedAll) {
  const cat = category || 'general';
  if (!byCategory[cat]) {
    byCategory[cat] = { total: 0, passed: 0, passRate: 0, passedAllTrials: 0, passHatK: 0 };
  }
  byCategory[cat].total++;
  if (passedFirst) {
    byCategory[cat].passed++;
  }
  if (passedAll) {
    byCategory[cat].passedAllTrials++;
  }
}

function finalizeCategoryRates(byCategory) {
  for (const data of Object.values(byCategory)) {
    data.passRate = data.total > 0 ? Number((data.passed / data.total).toFixed(4)) : 0;
    data.passHatK = data.total > 0 ? Number((data.passedAllTrials / data.total).toFixed(4)) : 0;
  }
}

/**
 * Runs evaluation on a suite of test cases against a deterministic policy assertion.
 *
 * @param {object} options
 * @param {Array<Record<string, any>>} options.cases - Synthetic test cases
 * @param {(testCase: Record<string, any>, trialIndex?: number) => any|Promise<any>} options.runner - Model or skill invocation function
 * @param {(testCase: Record<string, any>, outcome: any, trialIndex?: number) => { passed: boolean, category: string, expected: any, actual: any, reason?: string }} options.policyAssert - Deterministic policy checker
 * @param {number} [options.trials=1] - Number of trials per case for pass^k reliability scoring
 * @returns {Promise<{ total: number, passed: number, passRate: number, trials: number, passedAllTrials: number, passHatK: number, byCategory: Record<string, { total: number, passed: number, passRate: number, passedAllTrials: number, passHatK: number }>, details: Array<any> }>}
 */
export async function evaluateSuite({ cases, runner, policyAssert, trials = 1 }) {
  if (!Array.isArray(cases)) {
    throw new TypeError('cases must be an array');
  }
  if (typeof runner !== 'function' || typeof policyAssert !== 'function') {
    throw new TypeError('runner and policyAssert must be functions');
  }
  const k = Math.max(1, Math.floor(Number(trials) || 1));

  const details = [];
  const byCategory = {};
  let totalPassed = 0;
  let totalPassedAll = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const { firstOutcome, firstAssertion, passedAll, trialOutcomes } =
      await runCaseAcrossTrials(testCase, runner, policyAssert, k);

    recordCategoryCase(byCategory, firstAssertion.category, firstAssertion.passed, passedAll);
    totalPassed += firstAssertion.passed ? 1 : 0;
    totalPassedAll += passedAll ? 1 : 0;

    details.push({
      index: i,
      case: testCase,
      outcome: firstOutcome,
      assertion: firstAssertion,
      passedAllTrials: passedAll,
      trials: trialOutcomes,
    });
  }

  finalizeCategoryRates(byCategory);
  const total = cases.length;
  const passRate = total > 0 ? Number((totalPassed / total).toFixed(4)) : 0;
  const passHatK = total > 0 ? Number((totalPassedAll / total).toFixed(4)) : 0;

  return {
    total,
    passed: totalPassed,
    passRate,
    trials: k,
    passedAllTrials: totalPassedAll,
    passHatK,
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

/**
 * Ten-case evaluation dataset for tools/check-skills.mjs (skill-shaper rules).
 */
export const CHECK_SKILLS_EVAL_CASES = [
  {
    id: 'valid-client-handoff-style',
    category: 'valid_manifest',
    folder: 'release-packager',
    raw: `---\nname: release-packager\ndescription: Audits and packages milestone deliverables, verifying checksums and scanning for leaked secrets. Not for session notes; use 'keep'.\nmetadata:\n  version: "1.0.0"\n---\n\n# release-packager\nPackages verified client releases.\n`,
    expectedValid: true,
    expectedMatch: null,
  },
  {
    id: 'valid-linked-reference',
    category: 'valid_manifest',
    folder: 'schema-guard',
    extraFile: 'references/guide.md',
    raw: `---\nname: schema-guard\ndescription: Validates JSON schemas and API contracts before outbound dispatch. Use when checking payload shapes.\n---\n\n# schema-guard\nSee [guide](references/guide.md).\n`,
    expectedValid: true,
    expectedMatch: null,
  },
  {
    id: 'invalid-reserved-name',
    category: 'frontmatter_identity',
    folder: 'skill-creator',
    raw: `---\nname: skill-creator\ndescription: Generates a new skill folder from a template.\n---\n\n# skill-creator\n`,
    expectedValid: false,
    expectedMatch: /is reserved/,
  },
  {
    id: 'invalid-folder-mismatch',
    category: 'frontmatter_identity',
    folder: 'actual-folder',
    raw: `---\nname: different-name\ndescription: Audits configuration drift across environments.\n---\n\n# different-name\n`,
    expectedValid: false,
    expectedMatch: /≠ folder/,
  },
  {
    id: 'invalid-overtrigger-phrase',
    category: 'description_guard',
    folder: 'broad-helper',
    raw: `---\nname: broad-helper\ndescription: Helps whenever the user asks for code formatting or linting.\n---\n\n# broad-helper\n`,
    expectedValid: false,
    expectedMatch: /over-triggering phrase/,
  },
  {
    id: 'invalid-imperative-opening',
    category: 'description_guard',
    folder: 'imperative-skill',
    raw: `---\nname: imperative-skill\ndescription: Use this to inspect database migrations before deployment.\n---\n\n# imperative-skill\n`,
    expectedValid: false,
    expectedMatch: /description must be third person/,
  },
  {
    id: 'invalid-first-person-and-xml',
    category: 'description_guard',
    folder: 'voice-xml-skill',
    raw: `---\nname: voice-xml-skill\ndescription: I can format <xml> payloads and validate schemas.\n---\n\n# voice-xml-skill\n`,
    expectedValid: false,
    expectedMatch: /description contains XML|first person/,
  },
  {
    id: 'invalid-extension-list',
    category: 'description_guard',
    folder: 'media-parser',
    raw: `---\nname: media-parser\ndescription: Parses recordings and transcripts from .mp3, .wav, .mp4 files.\n---\n\n# media-parser\n`,
    expectedValid: false,
    expectedMatch: /no lists of file extensions/,
  },
  {
    id: 'invalid-not-for-missing-target',
    category: 'body_and_routing',
    folder: 'orphaned-negation',
    raw: `---\nname: orphaned-negation\ndescription: Formats weekly status reports for stakeholders. Not for internal engineering notes.\n---\n\n# orphaned-negation\n`,
    expectedValid: false,
    expectedMatch: /"Not for X" must name the owning skill/,
  },
  {
    id: 'invalid-placeholder-and-overlap',
    category: 'body_and_routing',
    folder: 'overlap-skill',
    raw: `---\nname: overlap-skill\ndescription: Audits and packages milestone deliverables, verifying checksums and scanning for leaked secrets.\n---\n\n# overlap-skill\nComplete <TODO> and read [missing](missing-doc.md).\n`,
    overlapPeer: {
      name: 'peer-packager',
      description: 'Audits and packages milestone deliverables, verifying checksums and scanning for leaked secrets.',
    },
    expectedValid: false,
    expectedMatch: /placeholder text in body/,
  },
];

function executeCheckSkillsCase(testCase) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-check-skills-'));
  try {
    const skillDir = path.join(tmpRoot, testCase.folder);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), testCase.raw, 'utf8');

    if (testCase.extraFile) {
      const extraPath = path.join(skillDir, testCase.extraFile);
      fs.mkdirSync(path.dirname(extraPath), { recursive: true });
      fs.writeFileSync(extraPath, '# Extra reference\n', 'utf8');
    }

    const problems = [];
    validateSkill(skillDir, problems);

    if (testCase.overlapPeer) {
      checkSkillOverlap(
        [
          { name: testCase.folder, description: testCase.overlapPeer.description },
          testCase.overlapPeer,
        ],
        problems,
      );
    }

    return { valid: problems.length === 0, problems };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Evaluates tools/check-skills.mjs across the 10-case dataset over k trials (default pass^3).
 *
 * @param {{ trials?: number }} [options]
 */
export async function runCheckSkillsEval({ trials = 3 } = {}) {
  const policyAssert = (testCase, outcome) => {
    const validMatches = outcome.valid === testCase.expectedValid;
    const patternMatches = testCase.expectedMatch
      ? outcome.problems.some((p) => testCase.expectedMatch.test(p))
      : outcome.problems.length === 0;
    const passed = validMatches && patternMatches;

    return {
      passed,
      category: testCase.category,
      expected: testCase.expectedValid ? 'valid (0 problems)' : String(testCase.expectedMatch),
      actual: outcome.problems.length === 0 ? 'valid (0 problems)' : outcome.problems.join('; '),
      reason: passed ? undefined : `Unexpected check-skills output: ${outcome.problems.join('; ')}`,
    };
  };

  return evaluateSuite({
    cases: CHECK_SKILLS_EVAL_CASES,
    runner: executeCheckSkillsCase,
    policyAssert,
    trials,
  });
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(
      [
        'Usage:',
        '  node tools/eval-skill.mjs --demo',
        '  node tools/eval-skill.mjs --check-skills [--trials <k>]',
      ].join('\n')
    );
    return 0;
  }

  if (args.includes('--check-skills')) {
    const trialsIdx = args.indexOf('--trials');
    const trials = trialsIdx !== -1 ? Number(args[trialsIdx + 1]) || 3 : 3;
    runCheckSkillsEval({ trials }).then((res) => {
      console.log(
        `Evaluated ${res.total} check-skills cases across ${res.trials} trials (pass@1: ${(res.passRate * 100).toFixed(1)}%, pass^${res.trials}: ${(res.passHatK * 100).toFixed(1)}%).`
      );
      process.exit(res.passHatK === 1 ? 0 : 1);
    });
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
