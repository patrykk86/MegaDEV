import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseFrontmatter, validateSupportKb } from './kb-check.mjs';

describe('kb-check: frontmatter and support-kb validation', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-check-test-'));
  });

  after(() => {
    if (root && fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses YAML frontmatter and strips quotes', () => {
    const { data, body } = parseFrontmatter(
      '---\ntitle: "Reset Guide"\nowner: "support"\nstatus: living\nreviewed: 2026-11-01\n---\n\nOpening BLUF paragraph.\n',
    );
    assert.equal(data.title, 'Reset Guide');
    assert.equal(data.status, 'living');
    assert.ok(body.startsWith('\nOpening BLUF'));
  });

  it('passes valid /kb notes and flags missing BLUF or broken internal links', () => {
    const kbDir = path.join(root, 'src', 'routes', 'kb');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(
      path.join(kbDir, '+page.svx'),
      '---\ntitle: Home\nowner: ops\nstatus: living\nreviewed: 2026-11-01\n---\n\nStart here and read [guide](/kb/guide).\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(kbDir, 'guide.md'),
      '---\ntitle: Guide\nowner: ops\nstatus: living\nreviewed: 2026-11-01\n---\n\nShort summary before details.\n\n## Details\n\nBody.\n',
      'utf-8',
    );
    const okRes = validateSupportKb(root);
    assert.equal(okRes.skipped, false);
    assert.equal(okRes.errors.length, 0);

    fs.writeFileSync(
      path.join(kbDir, 'bad.md'),
      '---\ntitle: Bad\nowner: ops\nstatus: living\nreviewed: 2026-11-01\n---\n\n## Subheading first\n\nSee [missing](/kb/nope).\n',
      'utf-8',
    );
    const badRes = validateSupportKb(root);
    assert.ok(badRes.errors.some((e) => e.includes('Rule 1')));
    assert.ok(badRes.errors.some((e) => e.includes('/kb/nope')));
  });
});
