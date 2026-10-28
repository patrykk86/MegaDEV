#!/usr/bin/env node
/**
 * transcribe.mjs - Canonical Node.js Audio Speech Segment, Transcript Alignment & Handoff CLI
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';

const ALLOWED_FORMATS = new Set(['table', 'json', 'srt', 'text']);
const REQUIRED_HANDOFF_KEYS = [
  'sourceId',
  'originFile',
  'clockReference',
  'clockOffsetHoursFromUtc',
  'findings',
  'verbatimLines',
];

function parseFindingSpec(raw) {
  const eqIdx = raw.indexOf('=');
  if (eqIdx <= 0) {
    throw new Error(`Invalid --finding "${raw}". Use --finding <name>=<search phrase>.`);
  }
  return { key: raw.slice(0, eqIdx).trim(), query: raw.slice(eqIdx + 1).trim() };
}

export function parseArgs(args) {
  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: 'string', short: 'i' },
      transcript: { type: 'string', short: 't' },
      gap: { type: 'string', short: 'g', default: '0.7' },
      format: { type: 'string', short: 'f', default: 'table' },
      find: { type: 'string' },
      finding: { type: 'string', multiple: true, default: [] },
      output: { type: 'string', short: 'o' },
      'export-handoff': { type: 'string' },
      'validate-handoff': { type: 'string' },
      aggregate: { type: 'boolean', default: false },
      'source-id': { type: 'string' },
      'origin-file': { type: 'string' },
      'clock-ref': { type: 'string', default: 'UTC' },
      'clock-offset': { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const gap = Number.parseFloat(values.gap);
  if (Number.isNaN(gap) || gap <= 0) {
    throw new Error('Invalid --gap value. Expected a positive number (e.g. 0.7).');
  }
  if (!ALLOWED_FORMATS.has(values.format)) {
    throw new Error(`Invalid --format "${values.format}". Allowed: table, json, srt, text.`);
  }
  const clockOffsetHours = Number.parseInt(values['clock-offset'], 10);
  if (Number.isNaN(clockOffsetHours)) {
    throw new Error('Invalid --clock-offset. Expected integer hours from UTC (e.g. 0, 2).');
  }

  return {
    input: values.input ?? null,
    transcript: values.transcript ?? null,
    gap,
    format: values.format,
    find: values.find ?? null,
    findings: values.finding.map(parseFindingSpec),
    output: values.output ?? null,
    exportHandoff: values['export-handoff'] ?? null,
    validateHandoff: values['validate-handoff'] ?? null,
    aggregate: values.aggregate ? positionals : [],
    sourceId: values['source-id'] ?? null,
    originFile: values['origin-file'] ?? null,
    clockRef: values['clock-ref'],
    clockOffsetHours,
  };
}

function printHelp() {
  console.log(`
MEGA Transcriber CLI (Canonical Node.js Engine)
Usage:
  node tools/transcribe.mjs -i <file> [options]
  node tools/transcribe.mjs --validate-handoff <handoff.json>
  node tools/transcribe.mjs --aggregate <handoff_video.json> <handoff_audio.json>
`);
}

function readMp3FrameLen(buf, pos) {
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
    return 0;
  }
  const bitratesV1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const sampleRatesV1 = [44100, 48000, 32000, 0];
  const version = (buf[pos + 1] >> 3) & 3;
  const layer = (buf[pos + 1] >> 1) & 3;
  const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
  const srIdx = (buf[pos + 2] >> 2) & 0x03;
  const padding = (buf[pos + 2] >> 1) & 0x01;
  if (version !== 3 || layer !== 1 || bitrateIdx >= 15 || srIdx >= 3) {
    return 0;
  }
  return Math.floor((144 * bitratesV1L3[bitrateIdx] * 1000) / sampleRatesV1[srIdx]) + padding;
}

export function parseMp3Duration(buf) {
  let pos = 0;
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    pos = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
  }
  let frames = 0;
  let totalSamples = 0;
  while (pos < buf.length - 4) {
    const frameLen = readMp3FrameLen(buf, pos);
    if (frameLen > 0) {
      frames++;
      totalSamples += 1152;
      pos += frameLen;
    } else {
      pos++;
    }
  }
  return { frames, duration: totalSamples > 0 ? totalSamples / 44100 : 0 };
}

function summarizeChunk(curr) {
  const start = Number(curr[0].start.toFixed(2));
  const end = Number(curr[curr.length - 1].end.toFixed(2));
  return {
    start,
    end,
    duration: Number((end - start).toFixed(2)),
    subSegments: curr.length,
  };
}

function buildUtterancesFromSplits(segments, splitIndices) {
  const utterances = [];
  let curr = [];
  for (let i = 0; i < segments.length; i++) {
    curr.push(segments[i]);
    if (splitIndices.has(i) || i === segments.length - 1) {
      utterances.push(summarizeChunk(curr));
      curr = [];
    }
  }
  return utterances;
}

function createsMicroBlip(segments, chosen, candidateIdx, minDur) {
  const testSplits = [...chosen, candidateIdx].sort((a, b) => a - b);
  let startIdx = 0;
  for (const sIdx of [...testSplits, segments.length - 1]) {
    if (segments[sIdx].end - segments[startIdx].start < minDur) {
      return true;
    }
    startIdx = sIdx + 1;
  }
  return false;
}

function partitionByTargetCount(segments, targetCount) {
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    throw new Error(`Invalid targetUtteranceCount: ${targetCount}`);
  }
  if (targetCount > segments.length) {
    throw new Error(
      `Cannot partition ${segments.length} raw speech segment(s) into ${targetCount} transcript utterances.`
    );
  }
  if (targetCount === 1) {
    return [summarizeChunk(segments)];
  }

  const gaps = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = Number((segments[i].start - segments[i - 1].end).toFixed(2));
    const minSpan = Math.min(
      segments[i - 1].end - segments[i - 1].start,
      segments[i].end - segments[i].start
    );
    gaps.push({ breakAfterIdx: i - 1, gap, minAdjacentSpan: minSpan });
  }
  gaps.sort((a, b) => b.gap - a.gap || b.minAdjacentSpan - a.minAdjacentSpan);

  const chosen = [];
  const minDur = 0.4;
  for (const g of gaps) {
    if (chosen.length >= targetCount - 1) {
      break;
    }
    if (!createsMicroBlip(segments, chosen, g.breakAfterIdx, minDur)) {
      chosen.push(g.breakAfterIdx);
    }
  }

  if (chosen.length !== targetCount - 1) {
    throw new Error(
      `Failed to partition ${segments.length} speech segments into ${targetCount} valid utterances (>= ${minDur}s): only found ${chosen.length + 1}.`
    );
  }
  return buildUtterancesFromSplits(segments, new Set(chosen));
}

function groupByGapThreshold(segments, gapThreshold) {
  const splits = new Set();
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start - segments[i - 1].end >= gapThreshold) {
      splits.add(i - 1);
    }
  }
  return buildUtterancesFromSplits(segments, splits);
}

export function groupSegments(segments, gapThreshold = 0.7, targetUtteranceCount = null) {
  if (segments.length === 0) {
    return [];
  }
  if (targetUtteranceCount !== null) {
    return partitionByTargetCount(segments, targetUtteranceCount);
  }
  return groupByGapThreshold(segments, gapThreshold);
}

export function formatTime(seconds, srtFormat = false) {
  const totalSec = Math.floor(seconds);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  if (!srtFormat) {
    return `${h}:${m}:${s}`;
  }
  const millis = String(Math.floor((seconds - totalSec) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${millis}`;
}

/**
 * Aligns 1-to-1 utterances and transcript lines using Math.round(u.start) for spokenOffset.
 */
export function alignTranscript(utterances, lines) {
  if (utterances.length !== lines.length) {
    throw new Error(
      `Transcript alignment mismatch: ${lines.length} transcript line(s) vs ${utterances.length} speech utterance(s).`
    );
  }
  return lines.map((text, i) => {
    const u = utterances[i];
    return {
      index: i + 1,
      text,
      start: u.start,
      end: u.end,
      duration: u.duration,
      spokenOffset: Math.round(u.start),
      timestamp: formatTime(u.start),
    };
  });
}

function extractSpokenTimeToken(text) {
  const match = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  if (!match) {
    return { rawSpokenTime: text, format: 'text' };
  }
  const [hh, mm] = match[0].split(':');
  return { rawSpokenTime: `${hh.padStart(2, '0')}:${mm}`, format: 'HH:MM' };
}

function checkFindingUtteranceBounds(key, finding, utterances, filePath, problems) {
  if (!Array.isArray(utterances) || utterances.length === 0 || !finding.utteranceIndex) {
    return;
  }
  const u = utterances.find((x) => x.index === finding.utteranceIndex);
  if (!u) {
    problems.push(`${filePath}: finding "${key}.utteranceIndex" (${finding.utteranceIndex}) not found in utterances`);
    return;
  }
  if (finding.spokenOffsetSeconds < Math.floor(u.start) || finding.spokenOffsetSeconds > Math.ceil(u.end)) {
    problems.push(
      `${filePath}: finding "${key}.spokenOffsetSeconds" (${finding.spokenOffsetSeconds}s) falls outside utterance #${u.index} bounds [${u.start}s, ${u.end}s]`
    );
  }
  if (finding.format === 'HH:MM' && typeof finding.rawSpokenTime === 'string' && typeof u.text === 'string') {
    const stripped = finding.rawSpokenTime.replace(/^0/, '');
    if (!u.text.includes(finding.rawSpokenTime) && !u.text.includes(stripped)) {
      problems.push(
        `${filePath}: finding "${key}" rawSpokenTime "${finding.rawSpokenTime}" does not appear in utterance #${u.index} text ("${u.text}")`
      );
    }
  }
}

function validateFindingEntry(key, val, utterances, filePath, problems) {
  if (!val || typeof val !== 'object') {
    problems.push(`${filePath}: finding "${key}" must be an object`);
    return;
  }
  if (typeof val.rawSpokenTime !== 'string' || !val.rawSpokenTime) {
    problems.push(`${filePath}: finding "${key}" is missing "rawSpokenTime"`);
  }
  if (typeof val.format !== 'string' || !val.format) {
    problems.push(`${filePath}: finding "${key}" is missing "format"`);
  }
  if ('spokenOffsetSeconds' in val) {
    if (!Number.isInteger(val.spokenOffsetSeconds) || val.spokenOffsetSeconds < 0) {
      problems.push(`${filePath}: finding "${key}.spokenOffsetSeconds" must be a non-negative integer`);
    }
    checkFindingUtteranceBounds(key, val, utterances, filePath, problems);
  }
}

function validateTopLevelHandoffFields(handoff, filePath, problems) {
  if (typeof handoff.sourceId !== 'string' || !handoff.sourceId.trim() || handoff.sourceId === 'source') {
    problems.push(`${filePath}: "sourceId" must be a specific non-default identifier (e.g. "video" or "audio")`);
  }
  if (typeof handoff.originFile !== 'string' || !handoff.originFile.trim()) {
    problems.push(`${filePath}: "originFile" must be a non-empty string`);
  }
  if (typeof handoff.clockReference !== 'string' || !handoff.clockReference.trim()) {
    problems.push(`${filePath}: "clockReference" must be a non-empty string (e.g. "UTC", "local+2h")`);
  }
  if (!Number.isInteger(handoff.clockOffsetHoursFromUtc)) {
    problems.push(`${filePath}: "clockOffsetHoursFromUtc" must be an integer (e.g. 0, 2)`);
  }
}

function validateVerbatimAndFindings(handoff, filePath, problems) {
  if (!Array.isArray(handoff.verbatimLines) || handoff.verbatimLines.length === 0) {
    problems.push(`${filePath}: "verbatimLines" must be a non-empty array of strings`);
  } else if (
    Array.isArray(handoff.utterances) &&
    handoff.utterances.length > 0 &&
    handoff.utterances.length !== handoff.verbatimLines.length
  ) {
    problems.push(
      `${filePath}: "utterances" count (${handoff.utterances.length}) does not match "verbatimLines" count (${handoff.verbatimLines.length})`
    );
  }

  if (!handoff.findings || typeof handoff.findings !== 'object' || Array.isArray(handoff.findings)) {
    problems.push(`${filePath}: "findings" must be an object mapping finding keys to metadata`);
    return;
  }
  for (const [k, v] of Object.entries(handoff.findings)) {
    validateFindingEntry(k, v, handoff.utterances, filePath, problems);
  }
}

export function validateHandoffObject(handoff, filePath = 'handoff.json') {
  if (!handoff || typeof handoff !== 'object') {
    return [`${filePath}: root must be a JSON object`];
  }
  const problems = [];
  for (const reqKey of REQUIRED_HANDOFF_KEYS) {
    if (!(reqKey in handoff)) {
      problems.push(`${filePath}: missing required field "${reqKey}"`);
    }
  }
  validateTopLevelHandoffFields(handoff, filePath, problems);
  validateVerbatimAndFindings(handoff, filePath, problems);
  return problems;
}

export function aggregateHandoffs(files) {
  if (files.length < 2) {
    throw new Error('--aggregate requires at least 2 handoff JSON files.');
  }
  const loaded = [];
  const seenSources = new Set();

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const problems = validateHandoffObject(raw, file);
    if (problems.length > 0) {
      throw new Error(`Handoff validation failed:\n  - ${problems.join('\n  - ')}`);
    }
    if (seenSources.has(raw.sourceId)) {
      throw new Error(`Duplicate sourceId "${raw.sourceId}" across handoff files.`);
    }
    seenSources.add(raw.sourceId);
    loaded.push(raw);
  }

  return {
    sources: loaded.map((h) => ({
      sourceId: h.sourceId,
      originFile: h.originFile,
      clockReference: h.clockReference,
      clockOffsetHoursFromUtc: h.clockOffsetHoursFromUtc,
      findings: h.findings,
    })),
    combinedVerbatimLines: loaded.flatMap((h) => h.verbatimLines),
  };
}

function loadSegments(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.json') {
    const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : parsed.speechSegments || parsed.segments || [];
  }
  if (ext === '.mp3') {
    const stats = parseMp3Duration(fs.readFileSync(inputPath));
    process.stderr.write(`MP3 parsed: ${stats.frames} frames, duration: ${stats.duration.toFixed(2)}s\n`);
    const companionJson = inputPath.replace(/\.[^.]+$/, '_segments.json');
    if (fs.existsSync(companionJson)) {
      return JSON.parse(fs.readFileSync(companionJson, 'utf-8')).speechSegments || [];
    }
  }
  return [];
}

function loadTranscript(transcriptArg) {
  if (!transcriptArg) {
    return [];
  }
  const raw = fs.existsSync(transcriptArg) ? fs.readFileSync(transcriptArg, 'utf-8') : transcriptArg;
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildAlignedRecords(utterances, transcriptLines) {
  if (utterances.length > 0 && transcriptLines.length > 0) {
    return alignTranscript(utterances, transcriptLines);
  }
  if (utterances.length > 0) {
    return utterances.map((u, i) => ({
      index: i + 1,
      text: `Utterance ${i + 1}`,
      start: u.start,
      end: u.end,
      duration: u.duration,
      spokenOffset: Math.round(u.start),
      timestamp: formatTime(u.start),
    }));
  }
  return transcriptLines.map((text, i) => ({
    index: i + 1,
    text,
    start: 0,
    end: 0,
    duration: 0,
    spokenOffset: 0,
    timestamp: '00:00:00',
  }));
}

function formatAlignedOutput(results, format) {
  if (format === 'json') {
    return JSON.stringify(results, null, 2);
  }
  if (format === 'srt') {
    return results
      .map((r) => `${r.index}\n${formatTime(r.start, true)} --> ${formatTime(r.end, true)}\n${r.text}\n`)
      .join('\n');
  }
  if (format === 'text') {
    return results
      .map((r) => `[${r.timestamp} - ${r.end.toFixed(2)}s | offset: ${String(r.spokenOffset).padStart(3)}s] ${r.text}`)
      .join('\n');
  }
  const header = `${'#'.padStart(3)} | ${'Start'.padStart(8)} | ${'End'.padStart(8)} | ${'Dur'.padStart(6)} | ${'Offset'.padStart(6)} | Text`;
  const rows = [header, '-'.repeat(header.length + 30)];
  for (const r of results) {
    rows.push(
      `${String(r.index).padStart(3)} | ${r.start.toFixed(2).padStart(7)}s | ${r.end.toFixed(2).padStart(7)}s | ${r.duration.toFixed(2).padStart(5)}s | ${String(r.spokenOffset).padStart(5)}s | ${r.text}`
    );
  }
  return rows.join('\n');
}

function exportValidatedHandoff(options, aligned) {
  if (!options.sourceId) {
    throw new Error('--source-id <id> (e.g. "video" or "audio") is required with --export-handoff');
  }
  const findingsObj = {};
  for (const f of options.findings) {
    const match = aligned.find((r) => r.text.toLowerCase().includes(f.query.toLowerCase()));
    if (!match) {
      throw new Error(`--finding "${f.key}=${f.query}" did not match any utterance.`);
    }
    const token = extractSpokenTimeToken(match.text);
    findingsObj[f.key] = {
      rawSpokenTime: token.rawSpokenTime,
      format: token.format,
      spokenOffsetSeconds: match.spokenOffset,
      utteranceIndex: match.index,
    };
  }

  const handoff = {
    sourceId: options.sourceId,
    originFile: options.originFile || path.basename(options.input),
    clockReference: options.clockRef,
    clockOffsetHoursFromUtc: options.clockOffsetHours,
    findings: findingsObj,
    verbatimLines: aligned.map((r) => r.text),
    utterances: aligned,
  };

  const problems = validateHandoffObject(handoff, options.exportHandoff);
  if (problems.length > 0) {
    throw new Error(`Handoff schema check failed:\n  - ${problems.join('\n  - ')}`);
  }
  fs.writeFileSync(options.exportHandoff, JSON.stringify(handoff, null, 2), 'utf-8');
  process.stderr.write(`✓ Standardized hand-off saved and validated: ${options.exportHandoff}\n`);
}

function handleSpecialModes(options) {
  if (options.validateHandoff) {
    const raw = JSON.parse(fs.readFileSync(options.validateHandoff, 'utf-8'));
    const problems = validateHandoffObject(raw, options.validateHandoff);
    if (problems.length > 0) {
      throw new Error(problems.join('\n✗ '));
    }
    console.log(`✓ ${options.validateHandoff} conforms to multi-source-worker schema.`);
    return true;
  }
  if (options.aggregate.length > 0) {
    const out = JSON.stringify(aggregateHandoffs(options.aggregate), null, 2);
    if (options.output) {
      fs.writeFileSync(options.output, out, 'utf-8');
      console.log(`Saved aggregated handoff to ${options.output}`);
    } else {
      console.log(out);
    }
    return true;
  }
  return false;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (handleSpecialModes(options)) {
    return;
  }
  if (!options.input) {
    printHelp();
    throw new Error('--input is required (or use --validate-handoff / --aggregate)');
  }

  const segments = loadSegments(options.input);
  const transcriptLines = loadTranscript(options.transcript);
  const targetCount = transcriptLines.length > 0 ? transcriptLines.length : null;
  const utterances = segments.length > 0 ? groupSegments(segments, options.gap, targetCount) : [];
  const aligned = buildAlignedRecords(utterances, transcriptLines);

  const results = options.find
    ? aligned.filter((r) => r.text.toLowerCase().includes(options.find.toLowerCase()))
    : aligned;
  if (options.find && results.length === 0) {
    throw new Error(`No matches found for: "${options.find}"`);
  }

  const output = formatAlignedOutput(results, options.format);
  if (options.output) {
    fs.writeFileSync(options.output, output, 'utf-8');
    console.log(`Saved output to ${options.output}`);
  } else {
    console.log(output);
  }

  if (options.exportHandoff) {
    exportValidatedHandoff(options, aligned);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  run().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
