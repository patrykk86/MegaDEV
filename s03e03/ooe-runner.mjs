#!/usr/bin/env node
/**
 * s03e03/ooe-runner.mjs - works the out-of-office round alone.
 *
 * One process, no human: it polls the course tracker, marks each new issue, decides per the grown
 * `triage` skill, and ships what it is allowed to ship to the live Worker.
 * - Every model call goes through tools/agent-loop.mjs (runAgent), so limits, guards and budgeting
 *   are the workspace's, not this file's. autoLamarck is off: this loop spawns nothing.
 * - The model returns one JSON decision per issue. This file applies it: `node --check`, backup,
 *   deploy with FEED_URL, then a live read of the acceptance. A deploy that exits zero is not a ship.
 * - A change to what a reader already receives goes to the owner: a proposed record, the
 *   `needs-human` label, the numbered options, then a wait for `/answer <n>`. The owner signs.
 * - One ship line per issue in the product's shape, a masked request log, and `.runs/ooe/result.json`
 *   for the claim. The tracker token never reaches a log line.
 *
 * Usage:
 *   node s03e03/ooe-runner.mjs --selftest                      # one model call, no writes
 *   node s03e03/ooe-runner.mjs --base <url> --token-file <f> --live <url> --feed <url> [--once]
 *                               [--poll 45000] [--until <iso>] [--max-minutes 45]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAgent } from '../tools/agent-loop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STARTER = path.join(HERE, 'starter', 'sched-prod-api');
const WORK = path.join(ROOT, '.runs', 'ooe');
const VERSIONS = path.join(WORK, 'versions');
const STATE_PATH = path.join(WORK, 'state.json');
const RESULT_PATH = path.join(WORK, 'result.json');
const RUN_LOG = path.join(WORK, 'runner.log');
const TRACKER_LOG = path.join(WORK, 'tracker.log.jsonl');

/** The routed reasoning tier for code work here: cheap, and the one .clinerules permits by default. */
export const MODEL = 'anthropic/claude-haiku-5.5-20261007';

export const TERMINAL_VERBS = new Set(['shipped', 'declined', 'closed']);

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function ensureDirs() {
  for (const d of [WORK, VERSIONS]) fs.mkdirSync(d, { recursive: true });
}

function log(level, message, extra) {
  ensureDirs();
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(extra ? { extra } : {}) });
  fs.appendFileSync(RUN_LOG, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

function mask(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[masked]');
  }
  return out
    .replace(/\b(cfut_|sk-or-v1-|sk-|ghp_|xoxb-)[A-Za-z0-9._-]{6,}/g, '[masked]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer [masked]');
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { issues: {}, records: [], startedAt: new Date().toISOString() };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function writeState(state) {
  ensureDirs();
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function slugify(text, max = 40) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'change';
}

function readStarterFile(rel) {
  const file = path.join(STARTER, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

/** The triage steps the model must follow, read from the skill itself so the prompt cannot drift. */
export function triageSteps() {
  const skill = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'triage', 'SKILL.md'), 'utf-8');
  const start = skill.indexOf('## Running unattended');
  return start === -1 ? skill : skill.slice(start, skill.indexOf('## Failure modes', start));
}

export function makeLlm({ model = MODEL } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing');
  return {
    async generate({ messages, settings }) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'MegaDEV out-of-office runner',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: Math.min(Number(settings?.max_tokens) || 4096, 8192),
          temperature: 0.1,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`openrouter ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      return {
        message: { role: 'assistant', content: text },
        text,
        toolCalls: [],
        usage: { total_tokens: data.usage?.total_tokens ?? 0 },
        finishReason: choice?.finish_reason,
      };
    },
  };
}

export function parseDecision(text) {
  const raw = String(text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first === -1 || last <= first) throw new Error('decision is not JSON');
  const parsed = JSON.parse(raw.slice(first, last + 1));
  if (!['build', 'ask', 'decline', 'close'].includes(parsed.action)) {
    throw new Error(`unknown action: ${parsed.action}`);
  }
  return parsed;
}

export function makeTracker({ base, token, secrets = [] }) {
  ensureDirs();
  const root = String(base).replace(/\/+$/, '');
  async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(`${root}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const entry = {
      at: new Date().toISOString(),
      method,
      path: pathname,
      status: res.status,
      sent: body ?? null,
      answer: json ?? text.slice(0, 600),
    };
    fs.appendFileSync(TRACKER_LOG, `${mask(JSON.stringify(entry), secrets)}\n`);
    if (!res.ok) {
      throw new Error(`${method} ${pathname} -> ${res.status} ${json?.message ?? text.slice(0, 200)}`);
    }
    return json;
  }
  return {
    call,
    get: (p) => call(p),
    post: (p, body) => call(p, { method: 'POST', body }),
    put: (p, body) => call(p, { method: 'PUT', body }),
  };
}

export const SYSTEM_PROMPT = `You are the delivery agent the product's AGENTS.md describes, working one tracker issue of sched-prod-api at a time. You answer with one JSON object and nothing else: no prose before or after, no code fences.

Hard rules:
- The only file you change is src/index.js. Never touch wrangler.toml, package.json, contract/api.md or research/.
- GET /incidents keeps its exact answer: { "incidents": [ { "id", "service", "summary", "status", "openedAt" } ] }, newest first, ISO 8601 UTC. Anything else is 404 with { "error": "not found" }.
- An additive read (a new path, or a new query parameter whose answers keep every existing field exactly as it is) needs no record.
- A change to what an existing answer carries (a field added, dropped, renamed or reshaped) changes what every reader sees: it needs a decision record and the owner's choice. Never ship one on your own.
- Never invent an incident, a field value or a rule. The feed is the only source of incidents; contract/api.md and research/ are the only sources of rules.
- A reader already exists for GET /incidents: the status page, the on-call board and the support console.
- A record the owner signed is authoritative. Build what it names; never close or decline an issue whose signed record names a build.
- An unsigned record licenses nothing: not a build, not a decline, not a close. Record 0006 is a draft with no status and no signature, so it is not a decision. When the only record that speaks to an issue is unsigned, the action is "ask": the owner answers and signs, then the work starts.
- When an issue needs the owner, do nothing before the answer arrives: no close, no decline, no ship line, no code. Ask, then wait for the answer and the signature.
- A close or a decline may rest only on a signed record or on a line of contract/api.md, and it must quote that record id or that line.
- When a signed record names an option but not its exact wording, ask one precise question whose options carry the exact field text and the exact condition it appears under. Then build exactly that answer.

Decide from the issue and the product's own text, never from how hard it looks. Reply with:
{
  "action": "build" | "ask" | "decline" | "close",
  "why": "at most 200 chars, the rule this rests on",
  "contract_rule": "the line you rest on, quoted from contract/api.md or research/interview.md",
  "verb": "shipped" | "declined" | "closed" | "asked",
  "risk": "<issue number + who reads it> | none",
  "comment": "what you post on the issue, plain words, no JSON",
  "new_source": "the complete new src/index.js, only for build",
  "checks": [{ "path": "/incidents", "expect": 200 }],
  "record": { "title": "short title", "text": "the full decision record markdown, only for ask" },
  "question": "the one line the owner must decide, only for ask",
  "options": ["option one", "option two"]
}`;

export function productContext() {
  return [
    '# contract/api.md',
    readStarterFile('contract/api.md'),
    '# research/interview.md',
    readStarterFile('research/interview.md'),
    '# src/index.js (current)',
    readStarterFile('src/index.js'),
  ].join('\n\n');
}

function issueBrief(issue, records = []) {
  const thread = (issue.thread ?? [])
    .map((t) => `- ${t.by} (${t.kind})${t.label ? ` [${t.label}]` : ''}: ${t.body ?? ''}`)
    .join('\n');
  const known = records.length
    ? records.map((r) => `- ${r.id} · ${r.status} · ${r.title ?? ''}\n${String(r.text ?? '').trim().slice(0, 700)}`).join('\n\n')
    : '- none';
  return [
    `# Issue ${issue.n}: ${issue.title}`,
    `opened ${issue.openedAt} · labels: ${(issue.labels ?? []).join(', ') || 'none'} · closed: ${issue.closed}`,
    '',
    issue.body ?? '',
    '',
    '## Thread',
    thread || '- empty',
    '',
    '## Decision records already on the tracker',
    known,
  ].join('\n');
}

export async function askModel({ llm, query, system, sessionId }) {
  const res = await runAgent({
    model: MODEL,
    sessionId,
    query,
    messages: system ? [{ role: 'system', content: system }] : undefined,
    llm,
    autoLamarck: false,
    policy: { root: ROOT, allowCommands: [] },
  });
  if (res.end !== 'answer') {
    throw new Error(`model stopped early: ${res.end} ${String(res.text ?? '').slice(0, 200)}`);
  }
  return parseDecision(res.text);
}

async function applyBuild({ tracker, issue, decision, ctx }) {
  const n = issue.n;
  const source = String(decision.new_source ?? '');
  if (!source.includes('export default')) throw new Error('new_source has no export default');
  const syntax = syntaxOk(source);
  if (!syntax.ok) throw new Error(`syntax: ${syntax.out}`);
  const backup = backupSource(n);
  writeSource(source);
  const deploy = deployLive({ feed: ctx.feed, dry: ctx.dry });
  if (!deploy.ok) {
    fs.copyFileSync(backup, path.join(STARTER, 'src', 'index.js'));
    deployLive({ feed: ctx.feed, dry: ctx.dry });
    throw new Error(`deploy failed: ${deploy.out.slice(-300)}`);
  }
  const verified = await verifyLive(ctx.live, decision.checks ?? []);
  if (!verified.ok) {
    fs.copyFileSync(backup, path.join(STARTER, 'src', 'index.js'));
    const revert = deployLive({ feed: ctx.feed, dry: ctx.dry });
    throw new Error(`live verification failed, reverted (${revert.ok ? 'ok' : 'revert failed'}): ${JSON.stringify(verified.results).slice(0, 400)}`);
  }
  if (decision.comment) await tracker.post(`/issues/${n}/comments`, { body: decision.comment });
  const line = shipLine(n, 'shipped', true, decision.risk);
  await tracker.post('/shiplog', { line });
  try {
    await tracker.post(`/issues/${n}/close`, {});
  } catch (err) {
    log('warn', `closing issue ${n} failed`, String(err?.message ?? err));
  }
  return { verb: 'shipped', live: true, line, verified: verified.results, backup };
}

async function applyAsk({ tracker, issue, decision, state }) {
  const n = issue.n;
  const st = (state.issues[n] ??= { n });
  const title = decision.record?.title ?? issue.title;
  const id = `${String(nextRecordNumber(state.records)).padStart(4, '0')}-${slugify(title)}`;
  const text = ensureRecordFrontmatter(decision.record?.text ?? '', { id, title, issue: n });
  await tracker.put(`/records/${id}`, { text });
  state.records.push(id);
  st.ownRecords = [...(st.ownRecords ?? []), id];
  await tracker.post(`/issues/${n}/labels`, { label: 'needs-human' });
  const options = Array.isArray(decision.options) ? decision.options : [];
  const body = [
    decision.question ?? 'A decision is needed.',
    '',
    ...options.map((o, i) => `${i + 1}. ${o}`),
    '',
    `Record ${id} is proposed on the tracker. Answer with /answer <n>. The record needs your signature on the round page before the round is claimed.`,
  ].join('\n');
  await tracker.post(`/issues/${n}/comments`, { body });
  const line = shipLine(n, 'asked', false, decision.risk);
  await tracker.post('/shiplog', { line });
  return { verb: 'asked', record: id, recordText: text, options, line };
}

async function applyClose({ tracker, issue, decision }) {
  const n = issue.n;
  const verb = decision.verb === 'declined' ? 'declined' : 'closed';
  if (decision.comment) await tracker.post(`/issues/${n}/comments`, { body: decision.comment });
  try {
    await tracker.post(`/issues/${n}/close`, {});
  } catch (err) {
    log('warn', `closing issue ${n} failed`, String(err?.message ?? err));
  }
  const line = shipLine(n, verb, false, decision.risk);
  await tracker.post('/shiplog', { line });
  return { verb, live: false, line };
}

export async function handleAnswer({ tracker, llm, issue, entry, state, records = [], ctx }) {
  const n = issue.n;
  const st = state.issues[n];
  if (!st?.record) return null;
  const choice = Number((String(entry.body ?? '').match(/\/answer\s+(\d+)/i) ?? [])[1] ?? 0);
  if (!choice || st.answeredWith === choice) return null;
  const record = await tracker.get(`/records/${st.record}`);
  const accepted = acceptRecord(record?.text ?? st.recordText ?? '', choice, st.options ?? []);
  await tracker.put(`/records/${st.record}`, { text: accepted });
  st.answeredWith = choice;
  st.acceptedAt = new Date().toISOString();
  st.awaitingSignature = st.record;
  const line = shipLine(n, 'waiting', false, `signature pending on ${st.record}`);
  await tracker.post('/shiplog', { line });
  await tracker.post(`/issues/${n}/comments`, {
    body: `Record ${st.record} is accepted for option ${choice}. Please sign it on your round page. No work starts until the record is signed.`,
  });
  Object.assign(st, { verb: 'waiting', live: false, shipLine: line, answeredAt: new Date().toISOString() });
  writeState(state);
  return { verb: 'waiting', live: false, line };
}

export async function doSignedWork({ tracker, llm, issue, record, state, records = [], ctx }) {
  const n = issue.n;
  const st = state.issues[n];
  const choice = st.answeredWith;
  const query = [
    '# How you work each issue (the triage skill, run unattended)',
    triageSteps(),
    '',
    '# The product',
    productContext(),
    '',
    `# The record the owner answered and signed (option ${choice})`,
    record.text,
    '',
    '# The issue',
    issueBrief(issue, records),
    '',
    'The record is signed, so the work starts now. Carry out the option it names. Do not ask again and do not write another record. Reply with action "build" and the complete src/index.js plus live checks, or action "decline" with the rule that forbids it.',
  ].join('\n');
  let decision = await askModel({ llm, query, system: SYSTEM_PROMPT, sessionId: `ooe-issue-${n}-signed` });
  if (decision.action === 'ask') {
    decision = await askModel({
      llm,
      query: `${query}\n\nYou asked again. The owner signed. Return action "build" now, or action "decline" with the rule.`,
      system: SYSTEM_PROMPT,
      sessionId: `ooe-issue-${n}-signed-forced`,
    });
  }
  const outcome = decision.action === 'build'
    ? await applyBuild({ tracker, issue, decision, ctx })
    : await applyClose({ tracker, issue, decision });
  Object.assign(st, {
    verb: outcome.verb,
    live: outcome.live ?? false,
    shipLine: outcome.line,
    signedWorkAt: new Date().toISOString(),
    awaitingSignature: null,
    seen: (issue.thread ?? []).length,
  });
  writeState(state);
  return outcome;
}

export async function resumeAccepted({ tracker, llm, issue, record, state, records = [], ctx }) {
  const n = issue.n;
  const st = state.issues[n];
  const query = [
    '# How you work each issue (the triage skill, run unattended)',
    triageSteps(),
    '',
    '# The product',
    productContext(),
    '',
    `# The signed record that decides issue ${n}`,
    record.text,
    '',
    '# The issue',
    issueBrief(issue, records),
    '',
    'The owner signed this record. Build the option it names now. Do not ask again and do not write another record. Reply with action "build" with the complete src/index.js and the live checks, or action "decline" with the rule that forbids it.',
  ].join('\n');
  let decision = await askModel({ llm, query, system: SYSTEM_PROMPT, sessionId: `ooe-issue-${n}-resume` });
  if (decision.action !== 'build') {
    decision = await askModel({
      llm,
      query: `${query}\n\nYou asked again. The owner has signed. Return action "build" now, or action "decline" with the rule.`,
      system: SYSTEM_PROMPT,
      sessionId: `ooe-issue-${n}-resume-forced`,
    });
  }
  let outcome;
  if (decision.action === 'build') {
    outcome = await applyBuild({ tracker, issue, decision, ctx });
  } else if (decision.action === 'ask') {
    outcome = await applyAsk({ tracker, issue, decision, state });
  } else {
    outcome = await applyClose({ tracker, issue, decision });
  }
  const redundant = st.record && st.record !== record.id ? ` Record ${st.record} is withdrawn as a duplicate of ${record.id}.` : '';
  try {
    await tracker.post(`/issues/${n}/comments`, {
      body: `Built from record ${record.id}, which the owner signed.${redundant}`,
    });
  } catch (err) {
    log('warn', `resume comment on ${n} failed`, String(err?.message ?? err));
  }
  Object.assign(st, {
    verb: outcome.verb,
    live: outcome.live ?? false,
    shipLine: outcome.line,
    resumedFrom: record.id,
    seen: (issue.thread ?? []).length,
  });
  if (st.record && st.record !== record.id) {
    state.records = (state.records ?? []).filter((id) => id !== st.record);
    st.withdrawn = st.record;
    delete st.record;
  }
  writeState(state);
  return outcome;
}

async function safe(step, n, fn) {
  try {
    await fn();
    return 1;
  } catch (err) {
    log('error', `${step} ${n} failed`, String(err?.message ?? err).slice(0, 600));
    return 0;
  }
}

export function completionState(feed, state, issues) {
  const lastIssueBy = feed?.lastIssueBy ? Date.parse(feed.lastIssueBy) : null;
  const arrived = Number.isFinite(lastIssueBy) && Date.now() > lastIssueBy;
  const blocks = [];
  for (const issue of issues) {
    const st = state.issues[issue.n];
    if (!st?.verb) blocks.push({ n: issue.n, waiting: 'no ship line yet' });
    else if (!TERMINAL_VERBS.has(st.verb)) blocks.push({ n: issue.n, waiting: `verb=${st.verb}` });
  }
  return { arrived, lastIssueBy: feed?.lastIssueBy ?? null, blocks, ready: false };
}

function writeResult({ feed, state, ctx, done, unsigned = [] }) {
  const ready = done.arrived && done.blocks.length === 0 && unsigned.length === 0;
  const doc = {
    at: new Date().toISOString(),
    live: ctx.live,
    lastIssueBy: done.lastIssueBy,
    arrived: done.arrived,
    claimReady: ready,
    blockers: [...done.blocks, ...unsigned.map((id) => ({ record: id, waiting: 'owner signature' }))],
    issues: Object.values(state.issues).map((s) => ({
      n: s.n,
      action: s.action,
      verb: s.verb,
      live: s.live,
      rule: s.rule,
      why: s.why,
      record: s.record,
      shipLine: s.shipLine,
      pickedAt: s.pickedAt,
      handledAt: s.handledAt,
    })),
  };
  ensureDirs();
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

export async function cycle({ tracker, llm, state, ctx }) {
  const feed = await tracker.get('/issues');
  const issues = Array.isArray(feed?.issues) ? feed.issues : [];
  const records = (await tracker.get('/records'))?.records ?? [];
  let acted = 0;
  for (const issue of issues) {
    const st = state.issues[issue.n];
    const thread = issue.thread ?? [];
    const ownerAnswers = thread.filter((t) => t.by === 'owner' && /\/answer\s+\d+/i.test(String(t.body ?? '')));
    const answer = ownerAnswers[ownerAnswers.length - 1];
    if (st?.awaitingSignature) {
      const rec = records.find((r) => r.id === st.awaitingSignature);
      if (rec?.signedAt) {
        acted += await safe('signed-work', issue.n, () => doSignedWork({ tracker, llm, issue, record: rec, state, records, ctx }));
      }
      continue;
    }
    if (st?.record && answer) {
      const choice = Number((String(answer.body).match(/\/answer\s+(\d+)/i) ?? [])[1] ?? 0);
      if (choice && st.answeredWith !== choice) {
        acted += await safe('answer', issue.n, () => handleAnswer({ tracker, llm, issue, entry: answer, state, records, ctx }));
        continue;
      }
    }
    if (st?.verb === 'asked' && !st.resumedFrom) {
      const own = new Set(st.ownRecords ?? []);
      const signed = records.find((r) => own.has(r.id) && r.status === 'accepted' && r.signedAt);
      if (signed) {
        acted += await safe('resume', issue.n, () => resumeAccepted({ tracker, llm, issue, record: signed, state, records, ctx }));
        continue;
      }
    }
    const fresh = !st?.action;
    const grew = Boolean(st?.action) && thread.length > (st.seen ?? 0)
      && thread.slice(st.seen ?? 0).some((t) => t.by === 'course' || t.by === 'owner');
    const attempts = st?.attempts ?? 0;
    if ((fresh || grew) && attempts < 3) {
      acted += await safe('issue', issue.n, () => handleIssue({ tracker, llm, issue, state, records, ctx }));
    }
  }
  const done = completionState(feed, state, issues);
  const unsigned = [];
  for (const id of state.records ?? []) {
    const rec = await tracker.get(`/records/${id}`);
    if (!rec?.signedAt && !rec?.signedBy) unsigned.push(id);
  }
  const doc = writeResult({ feed, state, ctx, done, unsigned });
  return { issues, done: { ...done, ready: doc.claimReady }, acted, unsigned };
}

export function closeSupported(decision, records = []) {
  const cited = `${decision?.contract_rule ?? ''}\n${decision?.why ?? ''}`;
  const bySignedRecord = records.some((r) => r.signedAt && cited.includes(String(r.id).slice(0, 4)));
  const byContract = /not found|anything else|\b404\b/i.test(cited);
  const byExisting = /already (ships?|shipped|serves?|implemented|exists?|in src)|no (new )?change is needed/i.test(cited);
  return bySignedRecord || byContract || byExisting;
}

export async function handleIssue({ tracker, llm, issue, state, records = [], ctx }) {
  const n = issue.n;
  const st = (state.issues[n] ??= { n, firstSeenAt: new Date().toISOString(), attempts: 0 });
  st.attempts += 1;
  if (!st.pickupPosted) {
    await tracker.post(`/issues/${n}/comments`, {
      body: 'Picked up. Reading contract/api.md, research/ and the tracker records before deciding.',
    });
    await tracker.post(`/issues/${n}/labels`, { label: 'agent-picked' });
    st.pickupPosted = true;
    st.pickedAt = new Date().toISOString();
    writeState(state);
  }
  const query = [
    '# How you work each issue (the triage skill, run unattended)',
    triageSteps(),
    '',
    '# The product',
    productContext(),
    '',
    '# The issue to work now',
    issueBrief(issue, records),
  ].join('\n');
  let decision = await askModel({ llm, query, system: SYSTEM_PROMPT, sessionId: `ooe-issue-${n}` });
  if ((decision.action === 'close' || decision.action === 'decline') && !closeSupported(decision, records)) {
    log('guard', `issue ${n}: ${decision.action} refused — no signed record and no contract line`, {
      why: decision.why,
      rule: decision.contract_rule,
    });
    decision = await askModel({
      llm,
      query: `${query}\n\nYou answered "${decision.action}", but that rests on no signed record and on no line of contract/api.md. An unsigned record licenses nothing. Ask the owner now: action "ask", one record with numbered options, a recommendation, and the question they must answer and sign.`,
      system: SYSTEM_PROMPT,
      sessionId: `ooe-issue-${n}-forced-ask`,
    });
    if (decision.action !== 'ask') {
      decision = {
        action: 'ask',
        why: `No signed record licenses closing issue ${n}, so the owner decides.`,
        contract_rule: 'A change to what an existing answer carries needs a decision record on the tracker.',
        verb: 'asked',
        risk: `${n} + the readers of GET /incidents`,
        comment: `The agent cannot close this without a record the owner signed.`,
        record: {
          title: String(issue.title).slice(0, 60),
          text: [
            '## Ask',
            issue.title,
            '',
            '## Options',
            '1. Decline it — kind: decline',
            '2. Build it — kind: full',
            '',
            'Recommendation: 1, because no signed record licenses a build.',
            '',
            '## Decision',
            '(pending the owner)',
          ].join('\n'),
        },
        question: `Issue ${n}: ${issue.title} — build it, or decline it?`,
        options: ['Decline it', 'Build it'],
      };
    }
  }
  log('decision', `issue ${n}: ${decision.action}`, { why: decision.why, rule: decision.contract_rule });

  let outcome;
  if (decision.action === 'build') {
    outcome = await applyBuild({ tracker, issue, decision, ctx });
  } else if (decision.action === 'ask') {
    outcome = await applyAsk({ tracker, issue, decision, state });
  } else {
    outcome = await applyClose({ tracker, issue, decision });
  }
  Object.assign(st, {
    action: decision.action,
    why: decision.why,
    rule: decision.contract_rule,
    verb: outcome.verb,
    live: outcome.live ?? false,
    shipLine: outcome.line,
    record: outcome.record,
    recordText: outcome.recordText,
    options: outcome.options,
    handledAt: new Date().toISOString(),
    seen: (issue.thread ?? []).length,
    checkedAt: new Date().toISOString(),
  });
  writeState(state);
  return outcome;
}


export function deployLive({ feed, dry = false }) {
  if (dry) return { ok: true, out: 'dry run: deploy skipped' };
  const wrangler = path.join(STARTER, 'node_modules', '.bin', 'wrangler.cmd');
  const res = spawnSync(wrangler, ['deploy', '--env', 'production', '--var', `FEED_URL:${feed}`], {
    cwd: STARTER,
    encoding: 'utf-8',
    shell: true,
    timeout: 180000,
    env: { ...process.env },
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { ok: res.status === 0 && /Deployed|No changes/i.test(out), out: mask(out.slice(-2000), [process.env.CLOUDFLARE_API_TOKEN]) };
}

export async function verifyLive(live, checks = []) {
  const base = String(live).replace(/\/+$/, '');
  const list = [{ path: '/incidents', expect: 200, json: true }, ...checks.filter((c) => c && c.path)];
  const results = [];
  for (const check of list) {
    const url = `${base}${check.path}`;
    try {
      const res = await fetch(url, { method: check.method ?? 'GET', signal: AbortSignal.timeout(20000) });
      const body = await res.text();
      let ok = res.status === Number(check.expect ?? 200);
      if (ok && (check.json || check.path === '/incidents')) {
        try {
          JSON.parse(body);
        } catch {
          ok = false;
        }
      }
      results.push({ url, status: res.status, expect: Number(check.expect ?? 200), ok, sample: body.slice(0, 240) });
    } catch (err) {
      results.push({ url, status: 0, expect: Number(check.expect ?? 200), ok: false, error: String(err?.message ?? err) });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

export function shipLine(issueNumber, verb, live, risk) {
  return `#${issueNumber} · ${verb} · live: ${live ? '✓' : '✗'} · open risks: ${risk && String(risk).trim() ? String(risk).trim() : 'none'}`;
}

function backupSource(issueNumber) {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(VERSIONS, `${stamp}-issue${issueNumber}.js`);
  fs.copyFileSync(path.join(STARTER, 'src', 'index.js'), target);
  return target;
}

function writeSource(source) {
  fs.writeFileSync(path.join(STARTER, 'src', 'index.js'), source.endsWith('\n') ? source : `${source}\n`);
}

export function syntaxOk(source) {
  ensureDirs();
  const tmp = path.join(WORK, 'syntax-check.mjs');
  fs.writeFileSync(tmp, source);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf-8' });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.slice(0, 400) };
}

export function nextRecordNumber(taken = []) {
  const used = new Set(taken.map((id) => Number(String(id).slice(0, 4))).filter((n) => Number.isFinite(n)));
  let n = 7;
  while (used.has(n)) n += 1;
  return n;
}

export function ensureRecordFrontmatter(text, { id, title, issue }) {
  const body = String(text ?? '').trim();
  const number = String(id).slice(0, 4);
  const setField = (block, key, value) => {
    const re = new RegExp(`^${key}:.*$`, 'm');
    const line = value === '' ? `${key}:` : `${key}: ${value}`;
    return re.test(block) ? block.replace(re, line) : block.replace(/^---\r?\n/, (m) => `${m}${line}\n`);
  };
  if (/^---\s*(\r?\n)/.test(body)) {
    const fixed = body.replace(/^---\s*\r?\n[\s\S]*?\r?\n---/, (block) => {
      let head = block.replace(/^status:.*$/m, 'status: proposed').replace(/^signed-by:.*$/m, 'signed-by:');
      head = setField(head, 'id', number);
      head = setField(head, 'title', title);
      head = setField(head, 'issue', issue);
      return head;
    });
    return `${fixed}\n`;
  }
  return ['---', `id: ${number}`, `title: ${title}`, `issue: ${issue}`, 'status: proposed', 'signed-by:', '---', '', body, ''].join('\n');
}

export function acceptRecord(text, choice, options) {
  const chosen = options?.[choice - 1] ?? `option ${choice}`;
  return String(text)
    .replace(/^status:.*$/m, 'status: accepted')
    .replace(/^## Decision\s*$/m, `## Decision\nOption ${choice}: ${chosen}. Answered by the owner in the issue as /answer ${choice}.`);
}

export async function selftest() {
  const llm = makeLlm();
  const issue = {
    n: 99,
    title: 'A count of incidents per service, on its own call',
    body: 'Support wants a per-service count for the board. It reads GET /incidents today and cannot add up fast in the browser. They asked for a separate call that answers counts only, and said the existing answer must not change.',
    openedAt: '2026-11-11T18:10:00Z',
    labels: [],
    closed: false,
    thread: [],
  };
  const query = [
    '# How you work each issue (the triage skill, run unattended)',
    triageSteps(),
    '',
    '# The product',
    productContext(),
    '',
    '# The issue to work now',
    issueBrief(issue, []),
  ].join('\n');
  const decision = await askModel({ llm, query, system: SYSTEM_PROMPT, sessionId: 'ooe-selftest' });
  const syntax = decision.action === 'build' ? syntaxOk(decision.new_source ?? '') : { ok: true, out: 'not a build' };
  process.stdout.write(`${JSON.stringify({
    action: decision.action,
    why: decision.why,
    rule: decision.contract_rule,
    verb: decision.verb,
    risk: decision.risk,
    syntax,
    sourceBytes: String(decision.new_source ?? '').length,
    checks: decision.checks,
    record: decision.record?.title,
    options: decision.options,
  }, null, 2)}\n`);
  return decision.action === 'build' && syntax.ok ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)) {
  loadEnvFile();
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      'token-file': { type: 'string' },
      live: { type: 'string' },
      feed: { type: 'string' },
      poll: { type: 'string', default: '45000' },
      'max-minutes': { type: 'string', default: '45' },
      until: { type: 'string' },
      'build-issue': { type: 'string' },
      once: { type: 'boolean', default: false },
      dry: { type: 'boolean', default: false },
      selftest: { type: 'boolean', default: false },
    },
  });

  const token = fs.readFileSync(values['token-file'], 'utf-8').trim();
  const tracker = makeTracker({ base: values.base, token, secrets: [token] });
  const llm = makeLlm();
  const ctx = { live: values.live, feed: values.feed, dry: Boolean(values.dry) };
  const state = readState();

  if (values['build-issue']) {
    const n = Number(values['build-issue']);
    const feed = await tracker.get('/issues');
    const issue = (feed?.issues ?? []).find((i) => i.n === n);
    if (!issue) throw new Error(`issue ${n} not found`);
    const records = (await tracker.get('/records'))?.records ?? [];
    const signed = records.find((r) => r.status === 'accepted' && r.signedBy);
    const query = [
      '# The record the owner signed',
      signed?.text ?? '',
      '',
      '# The issue',
      issueBrief(issue, records),
      '',
      `The owner signed a record for issue ${n}. Its Decision section is the option to build. Build that option now, in src/index.js, leaving every existing field of every existing answer exactly as it is.`,
      'Reply with action "build", the complete src/index.js and the live checks that prove it. Never answer ask, close or decline.',
    ].join('\n');
    const decision = await askModel({ llm, query, system: SYSTEM_PROMPT, sessionId: `ooe-issue-${n}-forced-build` });
    if (decision.action !== 'build') {
      throw new Error(`model would not build: ${decision.action} — ${decision.why}`);
    }
    const outcome = await applyBuild({ tracker, issue, decision, ctx });
    const st = (state.issues[n] ??= { n });
    Object.assign(st, { verb: outcome.verb, live: outcome.live, shipLine: outcome.line, action: 'build', resumedFrom: signed?.id, why: decision.why });
    writeState(state);
    log('built', `issue ${n} built from the signed record`, { line: outcome.line });
    return 0;
  }

  if (values.selftest) {
    return selftest();
  }

  for (const required of ['base', 'token-file', 'live', 'feed']) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }

  const poll = Math.max(15_000, Number(values.poll));
  const deadline = values.until ? Date.parse(values.until) : Date.now() + Number(values['max-minutes']) * 60_000;
  log('start', 'runner up', { base: values.base, live: values.live, dry: ctx.dry, deadline: new Date(deadline).toISOString() });

  while (Date.now() < deadline) {
    try {
      const { done, unsigned, issues } = await cycle({ tracker, llm, state, ctx });
      log('cycle', `${issues.length} issues seen · claimReady=${done.ready}`, { unsigned, blocks: done.blocks });
      if (done.ready) {
        log('done', 'round complete: every issue arrived and every mark is terminal');
        return 0;
      }
      if (values.once) {
        return 0;
      }
    } catch (err) {
      log('error', 'cycle failed', String(err?.message ?? err).slice(0, 600));
      if (values.once) {
        return 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  log('timeout', 'deadline reached without a complete round');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      log('fatal', String(err?.message ?? err));
      process.exitCode = 1;
    });
}



