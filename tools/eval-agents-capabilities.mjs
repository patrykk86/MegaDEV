#!/usr/bin/env node
/**
 * @fileoverview Synthetic Evaluation Matrix for AGENTS.md Section 2 (Proportional Verification)
 * and Section 3 (Bidirectional Tool-Skill Augmentation).
 *
 * Implements Section 5 of AGENTS.md:
 * - Matrix-Driven Verification: Cartesian permutation matrix crossing intent variants, edge cases, and constraints.
 * - Policy-as-Code Assertion: Deterministic code assertions verifying rule compliance.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './check-skills.mjs';
import { buildPermutationMatrix, evaluateSuite } from './eval-skill.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(THIS_DIR, '..');
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Declarative ground truth oracle for Section 2 proportional verification.
 */
export const VERIFICATION_GROUND_TRUTH = {
  localized_code: {
    targeted_test: true,
    tools_check: true,
    matrix_eval: true,
    full_suite: true,
    skip_verification: false,
  },
  doc_only: {
    targeted_test: true,
    tools_check: true,
    matrix_eval: false,
    full_suite: false,
    skip_verification: false,
  },
  policy_change: {
    targeted_test: false,
    tools_check: false,
    matrix_eval: true,
    full_suite: true,
    skip_verification: false,
  },
  cross_cutting_security: {
    targeted_test: false,
    tools_check: false,
    matrix_eval: false,
    full_suite: true,
    skip_verification: false,
  },
  workspace_architecture: {
    targeted_test: false,
    tools_check: false,
    matrix_eval: false,
    full_suite: true,
    skip_verification: false,
  },
};

/**
 * Deterministic policy evaluator for Section 2: Proportional Verification.
 */
export function evaluateVerificationPolicy(changeScope, verificationAction) {
  if (verificationAction === 'skip_verification') {
    return { ok: false, reason: 'Unverified changes violate trust pyramid' };
  }

  const scopeRules = VERIFICATION_GROUND_TRUTH[changeScope];
  if (!scopeRules) {
    return { ok: false, reason: `Unknown change scope "${changeScope}"` };
  }

  const isAllowed = scopeRules[verificationAction] ?? false;
  if (isAllowed) {
    return { ok: true, reason: `Action "${verificationAction}" satisfies "${changeScope}" requirements` };
  }

  return { ok: false, reason: `Action "${verificationAction}" is insufficient or disproportionate for "${changeScope}"` };
}

/**
 * Deterministic policy evaluator for Section 3: Bidirectional Tool-Skill Augmentation.
 */
export function evaluateToolSkillLinkPolicy(toolAdvertises, skillDeclares, loadMode) {
  if (loadMode === 'monolithic') {
    return { ok: false, reason: 'Monolithic upfront loading violates context budget guidelines' };
  }

  const isBidirectional = toolAdvertises === 'tool_advertises_skill' && skillDeclares === 'skill_declares_tool';
  if (!isBidirectional) {
    return { ok: false, reason: 'Siloed capability: missing bidirectional cross-reference' };
  }

  if (loadMode === 'progressive' || loadMode === 'decoupled') {
    return { ok: true, reason: 'Valid progressive discovery and loose coupling' };
  }

  return { ok: false, reason: 'Unknown loading mode' };
}

function verifySkillReverseLink(skillMdPath, targetSkill, toolScript, relSchema, problems) {
  let parsedSkill = null;
  try {
    parsedSkill = parseFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
  } catch (err) {
    problems.push(`${targetSkill}/SKILL.md: failed frontmatter parsing (${err.message})`);
    return false;
  }

  const fmTools = parsedSkill.fm?.metadata?.tools ?? '';
  const fmSchema = parsedSkill.fm?.metadata?.schema ?? '';
  const bodyText = parsedSkill.body ?? '';

  const referencesTool =
    fmTools.includes(toolScript) ||
    fmSchema.includes(path.basename(relSchema)) ||
    bodyText.includes(toolScript);

  if (!referencesTool) {
    problems.push(`${targetSkill}/SKILL.md: reverse link missing for "${toolScript}"`);
    return false;
  }
  return true;
}

function auditSingleSchemaFile(sf, skillsDir, problems) {
  const relSchema = path.relative(ROOT_DIR, sf).replace(/\\/g, '/');
  let schemaObj = null;
  try {
    schemaObj = JSON.parse(fs.readFileSync(sf, 'utf-8'));
  } catch (err) {
    problems.push(`${relSchema}: invalid JSON (${err.message})`);
    return false;
  }

  if (!schemaObj.name || !schemaObj.description || (!schemaObj.properties && !schemaObj.parameters)) {
    problems.push(`${relSchema}: missing name, description, or properties/parameters`);
    return false;
  }

  const targetSkill = schemaObj.metadata?.skill;
  if (targetSkill === undefined) {
    problems.push(`${relSchema}: metadata.skill must be specified (or null)`);
    return false;
  }
  if (targetSkill === null) {
    if (!schemaObj.metadata?.standaloneReason) {
      problems.push(`${relSchema}: standalone tool requires metadata.standaloneReason`);
    }
    return false;
  }

  if (!SKILL_NAME_RE.test(targetSkill)) {
    problems.push(`${relSchema}: invalid skill identifier "${targetSkill}"`);
    return false;
  }

  const skillDir = path.resolve(skillsDir, targetSkill);
  if (!skillDir.startsWith(skillsDir + path.sep)) {
    problems.push(`${relSchema}: skill path traversal escapes .agents/skills`);
    return false;
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    problems.push(`${relSchema}: targets non-existent skill "${targetSkill}"`);
    return false;
  }

  return verifySkillReverseLink(skillMdPath, targetSkill, schemaObj.metadata.script, relSchema, problems);
}

/**
 * Audits all tools/*.tool.json schemas against .agents/skills manifests.
 */
export function validateWorkspaceToolSkillRegistry() {
  const problems = [];
  const toolsDir = path.join(ROOT_DIR, 'tools');
  const skillsDir = path.join(ROOT_DIR, '.agents', 'skills');

  const toolSchemaFiles = fs
    .readdirSync(toolsDir)
    .filter((f) => f.endsWith('.tool.json'))
    .map((f) => path.join(toolsDir, f));

  let bidirectionalLinks = 0;
  for (const sf of toolSchemaFiles) {
    if (auditSingleSchemaFile(sf, skillsDir, problems)) {
      bidirectionalLinks++;
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    bidirectionalLinks,
    totalSchemas: toolSchemaFiles.length,
  };
}

export async function runAgentsMdCapabilitiesMatrix() {
  const verificationFactors = {
    changeScope: ['localized_code', 'doc_only', 'policy_change', 'cross_cutting_security', 'workspace_architecture'],
    verificationAction: ['targeted_test', 'tools_check', 'matrix_eval', 'full_suite', 'skip_verification'],
  };

  const toolSkillFactors = {
    toolAdvertises: ['tool_advertises_skill', 'tool_silent'],
    skillDeclares: ['skill_declares_tool', 'skill_silent'],
    loadMode: ['progressive', 'monolithic', 'decoupled'],
  };

  const verificationCases = buildPermutationMatrix(verificationFactors).map((c) => ({
    ...c,
    type: 'proportional_verification',
  }));

  const toolSkillCases = buildPermutationMatrix(toolSkillFactors).map((c) => ({
    ...c,
    type: 'tool_skill_augmentation',
  }));

  const allCases = [...verificationCases, ...toolSkillCases];

  const runner = (c) => {
    if (c.type === 'proportional_verification') {
      return evaluateVerificationPolicy(c.changeScope, c.verificationAction);
    }
    return evaluateToolSkillLinkPolicy(c.toolAdvertises, c.skillDeclares, c.loadMode);
  };

  const policyAssert = (c, outcome) => {
    let expectedOk = false;
    if (c.type === 'proportional_verification') {
      expectedOk = VERIFICATION_GROUND_TRUTH[c.changeScope]?.[c.verificationAction] ?? false;
    } else {
      const isBidirectional = c.toolAdvertises === 'tool_advertises_skill' && c.skillDeclares === 'skill_declares_tool';
      expectedOk = isBidirectional && c.loadMode !== 'monolithic';
    }

    const passed = outcome.ok === expectedOk;
    return {
      passed,
      category: `${c.type}`,
      expected: expectedOk,
      actual: outcome.ok,
      reason: outcome.reason,
    };
  };

  return evaluateSuite({ cases: allCases, runner, policyAssert });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  console.log('Running AGENTS.md Capabilities Synthetic Permutation Matrix...');
  runAgentsMdCapabilitiesMatrix()
    .then((res) => {
      console.log(`Evaluated ${res.total} synthetic permutations.`);
      console.log(`Pass Rate: ${(res.passRate * 100).toFixed(1)}% (${res.passed}/${res.total})`);
      for (const [cat, data] of Object.entries(res.byCategory)) {
        console.log(`- ${cat}: ${(data.passRate * 100).toFixed(1)}% (${data.passed}/${data.total})`);
      }

      console.log('\nAuditing Workspace Tool-Skill Schema Registry...');
      const reg = validateWorkspaceToolSkillRegistry();
      if (!reg.ok) {
        console.error('✗ Tool-Skill Registry Problems:');
        for (const p of reg.problems) {
          console.error(`  - ${p}`);
        }
        process.exit(1);
      }
      console.log(`✓ Verified ${reg.bidirectionalLinks} bidirectional tool-skill links across ${reg.totalSchemas} schemas.`);

      if (res.passed !== res.total) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
