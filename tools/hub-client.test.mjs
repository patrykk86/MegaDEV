import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadWorkspaceEnv, maskSecretValue } from './hub-client.mjs';

describe('hub-client: secret masking and env loading', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-test-'));
  });

  after(() => {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('masks v1 tickets, UUIDs, and sensitive object keys recursively', () => {
    const ticket = `v1.${'a'.repeat(40)}.sig`;
    const uuid = 'c0000000-0000-4000-8000-0000005e03e5';
    const masked = maskSecretValue({
      ticket,
      sessionId: uuid,
      apiKey: 'secret-value-1234567890',
      nested: [ticket, { batchReceipt: 'short', safe: 'ok' }],
      count: 42,
    });

    assert.match(masked.ticket, /^v1\.aaaaaaa\.\.\.MASKED\.\.\.aa\.sig$/);
    assert.equal(masked.sessionId, 'c0000000...MASKED');
    assert.match(masked.apiKey, /\.\.\.MASKED\.\.\./);
    assert.equal(masked.nested[1].batchReceipt, '***MASKED***');
    assert.equal(masked.nested[1].safe, 'ok');
    assert.equal(masked.count, 42);
  });

  it('loads unset variables from a .env file without overwriting existing ones', () => {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, '# comment\nTEST_HUB_A=from_file\nTEST_HUB_B=new_val\n', 'utf-8');
    const prevA = process.env.TEST_HUB_A;
    const prevB = process.env.TEST_HUB_B;
    process.env.TEST_HUB_A = 'already_set';
    delete process.env.TEST_HUB_B;
    try {
      loadWorkspaceEnv(envFile);
      assert.equal(process.env.TEST_HUB_A, 'already_set');
      assert.equal(process.env.TEST_HUB_B, 'new_val');
    } finally {
      if (prevA === undefined) {
        delete process.env.TEST_HUB_A;
      } else {
        process.env.TEST_HUB_A = prevA;
      }
      if (prevB === undefined) {
        delete process.env.TEST_HUB_B;
      } else {
        process.env.TEST_HUB_B = prevB;
      }
    }
  });
});
