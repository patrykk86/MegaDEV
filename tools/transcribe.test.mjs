import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { maskSecretValue } from './hub-client.mjs';
import {
  aggregateHandoffs,
  alignTranscript,
  groupSegments,
  parseArgs,
  validateHandoffObject,
} from './transcribe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('partitions segments into exact sentence utterances while ignoring <0.4s micro-blips', () => {
  const segments = [
    { start: 0.0, end: 2.0 },
    { start: 3.5, end: 5.0 },
    { start: 6.2, end: 6.35 },
    { start: 7.5, end: 9.2 },
  ];
  const lines = ['Sentence one.', 'Sentence two.', 'Sentence three.'];
  const utterances = groupSegments(segments, 0.7, lines.length);
  assert.equal(utterances.length, 3);
  const aligned = alignTranscript(utterances, lines);
  assert.equal(aligned.length, 3);
  assert.equal(aligned[0].spokenOffset, 0);
  assert.equal(aligned[1].spokenOffset, 4);
  assert.ok(aligned[2].duration >= 0.4);
});

test('fails loudly when segments cannot be partitioned into N valid utterances or counts mismatch', () => {
  assert.throws(
    () => groupSegments([{ start: 0.0, end: 1.5 }], 0.7, 3),
    /Cannot partition 1 raw speech segment/
  );
  assert.throws(
    () =>
      groupSegments(
        [
          { start: 0.0, end: 0.2 },
          { start: 1.0, end: 1.2 },
        ],
        0.7,
        2
      ),
    /Failed to partition/
  );
  assert.throws(
    () => alignTranscript([{ start: 0, end: 1, duration: 1 }], ['Line 1', 'Line 2']),
    /Transcript alignment mismatch/
  );
});

test('rejects handoff objects with missing fields, out-of-bounds offsets, or mismatched utterance text', () => {
  const invalid = { sourceId: 'source', clockReference: 'UTC', totalUtterances: 5 };
  const problems = validateHandoffObject(invalid, 'bad_handoff.json');
  assert.ok(problems.some((p) => p.includes('originFile')));
  assert.ok(problems.some((p) => p.includes('clockOffsetHoursFromUtc')));
  assert.ok(problems.some((p) => p.includes('sourceId')));

  const misaligned = {
    sourceId: 'video',
    originFile: 'clip.mp4',
    clockReference: 'UTC',
    clockOffsetHoursFromUtc: 0,
    findings: {
      batchStart: {
        rawSpokenTime: '01:50',
        format: 'HH:MM',
        spokenOffsetSeconds: 10,
        utteranceIndex: 1,
      },
    },
    verbatimLines: ['All times are UTC.'],
    utterances: [{ index: 1, text: 'All times are UTC.', start: 5.35, end: 7.2, duration: 1.85 }],
  };
  const misalignedProblems = validateHandoffObject(misaligned, 'misaligned.json');
  assert.ok(misalignedProblems.some((p) => p.includes('falls outside utterance #1 bounds')));
  assert.ok(misalignedProblems.some((p) => p.includes('does not appear in utterance #1 text')));
});

test('validates s01e02 handoffs with Hub-accepted round(start) offsets (42s video, 30s audio)', () => {
  const videoHandoff = path.join(ROOT, 's01e02', 'handoff_video.json');
  const audioHandoff = path.join(ROOT, 's01e02', 'handoff_audio.json');
  const parsed = parseArgs(['--aggregate', videoHandoff, audioHandoff]);
  assert.deepEqual(parsed.aggregate, [videoHandoff, audioHandoff]);

  const aggregated = aggregateHandoffs(parsed.aggregate);
  assert.equal(aggregated.sources.length, 2);
  assert.equal(aggregated.sources[0].findings.batchStart.rawSpokenTime, '01:50');
  assert.equal(aggregated.sources[0].findings.batchStart.spokenOffsetSeconds, 42);
  assert.equal(aggregated.sources[1].findings.batchStart.rawSpokenTime, '03:50');
  assert.equal(aggregated.sources[1].findings.batchStart.spokenOffsetSeconds, 30);
  assert.equal(aggregated.combinedVerbatimLines.length, 59);
});

test('masks tickets and UUID keys in hub-client.mjs', () => {
  const fakeTicket = ['v1', 'eyJ0ZXN0UGF5bG9hZDEyMzQ1Njc4OTA', 'signatureXYZ123'].join('.');
  const masked = maskSecretValue({
    ticket: fakeTicket,
    nested: '00000000-1111-2222-3333-444444444444',
  });
  assert.ok(masked.ticket.includes('...MASKED...'));
  assert.ok(!masked.ticket.includes('eyJ0ZXN0UGF5bG9hZA'));
  assert.equal(masked.nested, '00000000...MASKED');
});
