#!/usr/bin/env node
/**
 * tools/model-limits.test.mjs - Deterministic tests for per-model limits (mean * 1.5).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeLimits, parseCsv, resolveLimits } from './model-limits.mjs';

const HEADER =
  'generation_id,created_at,tokens_prompt,tokens_completion,tokens_reasoning,model_permaslug,cancelled,finish_reason_raw,generation_time_ms,time_to_first_token_ms';

function csv(rows) {
  return [HEADER, ...rows].join('\n');
}

const SAMPLE = csv([
  // deepseek: session A (3 calls within 60s), session B (1 call)
  'g1,2026-10-30 10:00:00.000,100,100,50,deepseek/deepseek-v4.1-flash-20261017,false,tool_calls,1000,200',
  'g2,2026-10-30 10:00:20.000,100,200,50,deepseek/deepseek-v4.1-flash-20261017,false,tool_calls,2000,200',
  'g3,2026-10-30 10:00:50.000,100,300,50,deepseek/deepseek-v4.1-flash-20261017,false,stop,3000,200',
  'g4,2026-10-30 12:00:00.000,100,400,50,deepseek/deepseek-v4.1-flash-20261017,false,stop,2000,200',
  // older deepseek snapshot
  'g5,2026-09-30 12:00:00.000,100,10,0,deepseek/deepseek-v4.1-flash-20260910,false,stop,100,50',
  // provider that reports generation_time_ms = 0 -> falls back to TTFT
  'g6,2026-10-30 13:00:00.000,300,20,,typesafe/jev-1.13-20260917,false,,0,150',
  // cancelled rows are excluded
  'g7,2026-10-30 14:00:00.000,1,99999,,openai/gpt-6-luna-20260922,true,,99999,1',
  'g8,2026-10-30 14:00:00.000,1,40,,openai/gpt-6-luna-20260922,false,completed,1000,100',
  // quoted field with a comma and an escaped quote must not shift columns
  '"g,9","2026-10-30 15:00:00.000",1,10,,"meta-llama/llama-3.1-8b-instruct",false,"st""op",400,100',
]);

describe('parseCsv()', () => {
  it('handles quotes, escaped quotes, CRLF and blank lines', () => {
    const rows = parseCsv('a,b\r\n"x,1","y""z"\r\n\r\n2,3\n');
    assert.deepEqual(rows, [
      { a: 'x,1', b: 'y"z' },
      { a: '2', b: '3' },
    ]);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(parseCsv(''), []);
  });
});

describe('computeLimits() - mean * 1.5 policy', () => {
  const doc = computeLimits(parseCsv(SAMPLE), { generatedAt: 'fixed', source: 'sample.csv' });
  const ds = doc.models['deepseek/deepseek-v4.1-flash-20261017'];

  it('maxOutputTokens = ceil(mean(completion) * 1.5)', () => {
    assert.equal(ds.avgCompletionTokens, 250);
    assert.equal(ds.maxOutputTokens, 375);
  });

  it('timeoutMs = ceil(mean(generation_time_ms) * 1.5)', () => {
    assert.equal(ds.avgLatencyMs, 2000);
    assert.equal(ds.timeoutMs, 3000);
  });

  it('maxSteps = ceil(mean(session length) * 1.5) with 60s gap sessions', () => {
    assert.equal(ds.sessions, 2);
    assert.equal(ds.avgSteps, 2);
    assert.equal(ds.maxSteps, 3);
  });

  it('falls back to time_to_first_token_ms when generation time is 0', () => {
    assert.equal(doc.models['typesafe/jev-1.13-20260917'].timeoutMs, 225);
  });

  it('excludes cancelled rows', () => {
    const luna = doc.models['openai/gpt-6-luna-20260922'];
    assert.equal(luna.samples, 1);
    assert.equal(luna.maxOutputTokens, 60);
  });

  it('keeps quoted CSV rows aligned', () => {
    assert.equal(doc.models['meta-llama/llama-3.1-8b-instruct'].maxOutputTokens, 15);
  });

  it('honours a custom multiplier', () => {
    const d2 = computeLimits(parseCsv(SAMPLE), { multiplier: 2 });
    assert.equal(d2.models['deepseek/deepseek-v4.1-flash-20261017'].maxOutputTokens, 500);
    assert.match(d2.method, /average \+ 100%/);
  });

  it('pools a default for unknown models', () => {
    assert.equal(doc.default.samples, 8);
    assert.ok(doc.default.maxOutputTokens > 0);
  });
});

describe('resolveLimits() - id variant matrix', () => {
  const doc = computeLimits(parseCsv(SAMPLE), {
    aliases: { 'anthropic/claude-5.5-haiku': 'openai/gpt-6-luna-20260922' },
  });
  const cases = [
    ['deepseek/deepseek-v4.1-flash-20261017', 'deepseek/deepseek-v4.1-flash-20261017', 'exact'],
    ['DeepSeek/DeepSeek-v4.1-Flash-20261017', 'deepseek/deepseek-v4.1-flash-20261017', 'exact'],
    ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-20261017', 'family'],
    ['deepseek/deepseek-v4.1-flash-0910', 'deepseek/deepseek-v4.1-flash-20260910', 'family'],
    ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-20261017', 'family'],
    ['openai/gpt-6-luna', 'openai/gpt-6-luna-20260922', 'family'],
    ['gpt-6-luna', 'openai/gpt-6-luna-20260922', 'family'],
    ['anthropic/claude-5.5-haiku', 'openai/gpt-6-luna-20260922', 'alias'],
    ['unknown/model-x', null, 'default'],
    ['', null, 'default'],
    [undefined, null, 'default'],
  ];
  for (const [input, model, matched] of cases) {
    it(`${String(input)} -> ${matched}`, () => {
      const res = resolveLimits(doc, input);
      assert.equal(res.model, model);
      assert.equal(res.matched, matched);
      assert.ok(res.limits.maxOutputTokens > 0);
    });
  }
});

