import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseUnifiedDiffHunks, renderSystemDiffHtml } from './system-diff-build.mjs';

test('parseUnifiedDiffHunks extracts add/del lines properly', () => {
  const rawDiff = `@@ -1,3 +1,3 @@
-old line
+new line
 context line`;
  const hunks = parseUnifiedDiffHunks(rawDiff);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].lines.length, 3);
  assert.equal(hunks[0].lines[0].type, 'del');
  assert.equal(hunks[0].lines[1].type, 'add');
});

test('renderSystemDiffHtml generates valid grayscale HTML passing check.mjs', () => {
  const diffData = {
    repo: 'megadev',
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    base7: '1111111',
    head7: '2222222',
    date: '2026-10-30',
    files: [
      {
        path: 'tools/example.mjs',
        added: 5,
        removed: 1,
        binary: false,
        omitHunks: false,
        hunks: [
          {
            header: '@@ -1,2 +1,6 @@',
            lines: [
              { type: 'del', text: 'const oldVal = 1;' },
              { type: 'add', text: 'const newVal = 2;' },
            ],
          },
        ],
      },
    ],
  };

  const spec = {
    title: 'Verification Engine Upgrade',
    answer: 'The system is a validation pipeline and should merge. It prefers strict schema checks before saving data.',
    decisions: [
      {
        title: 'Validation Mode',
        gloss: 'The mechanism determining when file checks execute.',
        options: [
          { letter: 'a', text: 'Run statically during check phase', star: true },
          { letter: 'b', text: 'Defer to runtime' },
        ],
      },
    ],
    map: {
      nodes: [
        { name: 'Validator Engine', gloss: 'Checks rule contracts', state: 'changed-code' },
      ],
    },
    parts: [
      {
        name: 'Validator Engine',
        notice: 'Static check runs before test execution.',
        before: 'No schema check was performed.',
        after: 'Every file is validated against strict schema.',
        why: 'Prevents silent regressions in CI.',
        risk: 'Strictness could flag legacy untyped files.',
        files: ['tools/example.mjs'],
      },
    ],
  };

  const html = renderSystemDiffHtml(diffData, spec);
  assert.ok(html.includes('id="files"'));
  assert.ok(html.includes('Validator Engine'));

  // Test against check.mjs
  const tmpPath = path.resolve('tools/test-report.html');
  fs.writeFileSync(tmpPath, html, 'utf8');

  try {
    const checkScript = path.resolve('.agents/skills/system-diff/scripts/check.mjs');
    execFileSync(process.execPath, [checkScript, tmpPath, '--files', '-'], {
      input: 'tools/example.mjs\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } finally {
    if (fs.existsSync(tmpPath)) { fs.unlinkSync(tmpPath); }
  }
});
