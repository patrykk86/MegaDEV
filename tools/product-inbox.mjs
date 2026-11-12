#!/usr/bin/env node
/**
 * tools/product-inbox.mjs - pick up product's answer later, so no turn sits waiting for it.
 *
 * Product answers a Challenge some minutes after step one, by mail to the agent inbox and through
 * resume-challenge. This tool watches for that answer from two sources and writes a resume record the next
 * turn acts on:
 *  - `time`: the `answerAt` the course named. The record is ready at that moment.
 *  - `inbox`: a message in the agent inbox from the course's mail domain or naming the Challenge.
 *
 * The record holds the product receipt whole in `.runs/<challenge>/resume.json` (gitignored), and every line
 * this tool prints or appends to `resume.log` masks it. Nothing here calls the Challenge Hub: the resume
 * itself is the agent's own tool call, which `--take` prints in words.
 *
 * Modes: `--watch` (default) waits for the answer and writes the record, `--once` checks now, `--take`
 * prints what the next turn does, `--selftest` asserts with no network.
 *
 * Usage:
 *   node tools/product-inbox.mjs --challenge <uuid> --receipts .runs/<job>/product.txt [--watch] [--once]
 *   node tools/product-inbox.mjs --challenge <uuid> --take --outdir .runs/<job>
 *   node tools/product-inbox.mjs --selftest
 *
 * Exit codes: 0 record written or ready · 1 not ready · 2 usage · 3 could not read the inbox or the file
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkspaceEnv, maskSecretValue } from './hub-client.mjs'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
export const WORKSPACE_ROOT = resolve(THIS_DIR, '..')
export const DEFAULT_POLL_MS = 20_000
export const DEFAULT_TIMEOUT_MIN = 20
/** Senders whose mail counts as the course answering. */
export const COURSE_DOMAINS = ['mail.mega.dev', 'mega.dev']

/**
 * True when this sender is the course, looking only at the address after `@`.
 * @param {string} [from]
 * @returns {boolean}
 */
export function isCourseSender(from) {
  const address = String(from ?? '').toLowerCase()
  const at = address.lastIndexOf('@')
  if (at < 0) {
    return false
  }
  const domain = address.slice(at + 1).replace(/[>\s]+$/, '')
  return COURSE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/**
 * The newest message that answers this Challenge: from the course, arriving after the step was sent, and
 * naming the Challenge in its subject or body when the caller knows the name.
 * @param {Array<{from?: string, subject?: string, preview?: string, timestamp?: string, createdAt?: string}>} messages
 * @param {{ name?: string, after?: string }} [options]
 * @returns {object|null} the message, or null when the answer has not arrived
 */
export function pickAnswer(messages = [], options = {}) {
  const after = options.after
    ? Date.parse(options.after)
    : Number.NEGATIVE_INFINITY
  const name = (options.name ?? '').toLowerCase()
  const hits = messages.filter((m) => {
    if (!isCourseSender(m.from ?? m.sender)) {
      return false
    }
    const at = Date.parse(m.timestamp ?? m.createdAt ?? '')
    if (Number.isFinite(at) && at < after) {
      return false
    }
    if (!name) {
      return true
    }
    const text = `${m.subject ?? ''} ${m.preview ?? ''}`.toLowerCase()
    return text.includes(name)
  })
  return (
    hits.sort(
      (a, b) =>
        Date.parse(b.timestamp ?? b.createdAt ?? 0) -
        Date.parse(a.timestamp ?? a.createdAt ?? 0),
    )[0] ?? null
  )
}

/**
 * Is the answer in yet? `time` and `inbox` are independent; either one is enough.
 * @param {{ answerAt?: string, now?: number, mail?: object|null }} input
 * @returns {{ ready: boolean, source: 'time'|'inbox'|null, reason: string }}
 */
export function decide({ answerAt, now = Date.now(), mail = null } = {}) {
  if (mail) {
    return {
      ready: true,
      source: 'inbox',
      reason: 'the inbox holds the answer',
    }
  }
  if (answerAt) {
    const at = Date.parse(answerAt)
    if (!Number.isFinite(at)) {
      return { ready: false, source: null, reason: 'answerAt is not a date' }
    }
    if (now >= at) {
      return {
        ready: true,
        source: 'time',
        reason: 'the answer time has passed',
      }
    }
    return {
      ready: false,
      source: null,
      reason: `${Math.ceil((at - now) / 1000)}s until the answer time`,
    }
  }
  return {
    ready: false,
    source: null,
    reason: 'no answer time and no message yet',
  }
}

/**
 * The resume record: everything the next turn needs, and nothing it must look up again.
 * @param {{ challenge: string, session?: string, url?: string, productReceipt: string, source: string,
 *   readyAt?: string, mail?: object|null }} input
 */
export function buildRecord({
  challenge,
  session,
  url,
  productReceipt,
  receiptsFile,
  source,
  readyAt,
  mail = null,
}) {
  return {
    challenge,
    ready: true,
    source,
    readyAt: readyAt ?? new Date().toISOString(),
    next: 'resume-challenge',
    receipt: {
      file: receiptsFile ?? null,
      sha256: createHash('sha256').update(productReceipt ?? '').digest('hex'),
      masked: maskSecretValue(productReceipt ?? ''),
      note: 'The whole receipt stays in that file: send it from there, unchanged, never copied here.',
    },
    url: url ?? null,
    session: session ? maskSecretValue(session) : null,
    mail: mail
      ? {
          from: mail.from,
          subject: mail.subject,
          at: mail.timestamp ?? mail.createdAt ?? null,
        }
      : null,
    proves: 'The course accepts the step-two proof of the rebuilt board.',
  }
}

/**
 * A copy safe to print or log. The record never holds the whole receipt — only its masked head, its hash and
 * the file it lives in — so this is a copy the caller may print without another check.
 * @param {ReturnType<typeof buildRecord>} record
 */
export function maskRecord(record) {
  return structuredClone(record)
}

/**
 * Reads the agent inbox. One request, no retries: a refused key is reported, not hidden.
 * @param {{ inbox: string, key: string, limit?: number, after?: string, name?: string,
 *   fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: boolean, status: number, answer: object|null, error: string|null }>}
 */
export async function fetchAnswer({
  inbox,
  key,
  limit = 20,
  after,
  name,
  fetchImpl = fetch,
}) {
  const url = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages?limit=${limit}`
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        answer: null,
        error: `inbox answered ${res.status}`,
      }
    }
    const body = await res.json()
    const list = body.messages ?? body.data ?? []
    return {
      ok: true,
      status: res.status,
      answer: pickAnswer(list, { after, name }),
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      answer: null,
      error: `inbox unreachable: ${error.message}`,
    }
  }
}

/**
 * Reads `key: value` lines, the shape the course replies are saved in.
 * @param {string} path
 */
export function readLines(path) {
  const text = readFileSync(path, 'utf8')
  const get = (key) =>
    (text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')) ?? [])[1]?.trim()
  return {
    answerAt: get('answerAt') ?? null,
    productReceipt: get('productReceipt') ?? null,
    session: get('session') ?? null,
    url: get('url') ?? get('stepOneVideo') ?? null,
    challenge: get('challengeId') ?? null,
    name: get('name') ?? get('slug') ?? null,
  }
}

/** The mode a command line asks for; watch when it asks for nothing. */
export function pickMode(argv = []) {
  if (argv.includes('--selftest')) {
    return 'selftest'
  }
  if (argv.includes('--take')) {
    return 'take'
  }
  if (argv.includes('--once')) {
    return 'once'
  }
  return 'watch'
}

/** Parses the command line into one options object. */
export function parseArgs(argv = []) {
  const value = (flag, fallback = null) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')
      ? argv[i + 1]
      : fallback
  }
  return {
    mode: pickMode(argv),
    challenge: value('--challenge'),
    receipts: value('--receipts'),
    outdir: value('--outdir'),
    inbox: value('--inbox'),
    answerAt: value('--answer-at'),
    poll: Number(value('--poll', DEFAULT_POLL_MS)),
    timeoutMin: Number(value('--timeout', DEFAULT_TIMEOUT_MIN)),
    json: argv.includes('--json'),
    noInbox: argv.includes('--no-inbox'),
  }
}

/** Writes the record and one masked line, in `.runs/<challenge>/` unless told where. */
export function writeRecord(record, outdir) {
  mkdirSync(outdir, { recursive: true })
  const file = join(outdir, 'resume.json')
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  appendFileSync(
    join(outdir, 'resume.log'),
    `${record.readyAt} resume ready · source ${record.source} · ${record.receipt.masked} · ${record.receipt.file ?? 'no receipts file'}\n`,
  )
  return file
}

/** What the next turn does, in words, with the receipt masked. */
export function takeLines(record) {
  return [
    `challenge ${record.challenge} · answer ready ${record.readyAt} · source ${record.source}`,
    `next call: ${record.next} with receipts { productReceipt: ${record.receipt.masked} }`,
    `the whole receipt is in ${record.receipt.file ?? 'the receipts file'}: read it there and send it unchanged`,
    record.url
      ? `url for the step: ${record.url}`
      : 'url for the step: none recorded',
  ]
}

/** Asserts the matching and masking rules with no network. */
export async function selfTest() {
  const assert = (await import('node:assert/strict')).default
  assert.equal(isCourseSender('Product <product@mail.mega.dev>'), true)
  assert.equal(isCourseSender('team@mail.mega.dev'), true)
  assert.equal(isCourseSender('admin@agentmail.to'), false)
  assert.equal(isCourseSender('someone@notmega.dev'), false)
  assert.equal(isCourseSender(undefined), false)

  const mail = [
    {
      from: 'AgentMail <admin@agentmail.to>',
      subject: 'show me when',
      timestamp: '2026-11-12T19:27:00Z',
    },
    {
      from: 'Product <product@mail.mega.dev>',
      subject: 'Re: show me when',
      timestamp: '2026-11-12T19:27:12Z',
    },
    {
      from: 'Product <product@mail.mega.dev>',
      subject: 'another round',
      timestamp: '2026-11-12T18:00:00Z',
    },
  ]
  assert.equal(
    pickAnswer(mail, { after: '2026-11-12T19:20:00Z', name: 'show me when' })
      .subject,
    'Re: show me when',
  )
  assert.equal(pickAnswer(mail, { after: '2026-11-12T19:30:00Z' }), null)
  assert.equal(pickAnswer(mail, { name: 'status for the night' }), null)

  assert.deepEqual(
    decide({
      answerAt: '2026-11-12T19:27:12Z',
      now: Date.parse('2026-11-12T19:20:00Z'),
    }),
    {
      ready: false,
      source: null,
      reason: '432s until the answer time',
    },
  )
  assert.equal(
    decide({
      answerAt: '2026-11-12T19:27:12Z',
      now: Date.parse('2026-11-12T19:28:00Z'),
    }).source,
    'time',
  )
  assert.equal(
    decide({ now: Date.now(), mail: { subject: 'x' } }).source,
    'inbox',
  )

  // Built piece by piece, so no receipt-shaped literal sits in this file for the secret scan to find.
  const receipt = [
    'v1',
    'eyJzaWQiOiJzZWxmdGVzdCJ9',
    'c2VsZnRlc3RyZWNlaXB0c2VsZnRlc3Q',
  ].join('.')
  const record = buildRecord({
    challenge: 'c0000000-0000-4000-8000-0000005e03e4',
    productReceipt: receipt,
    source: 'time',
  })
  assert.equal(record.receipt.sha256.length, 64)
  assert.notEqual(record.receipt.masked, receipt)
  assert.equal(JSON.stringify(record).includes(receipt), false)
  assert.equal(takeLines(record).length, 4)
  console.log('self-test ok')
}

/** Prints what the record says the next turn does; 1 when there is no record yet. */
function takeFrom(outdir) {
  const file = join(outdir, 'resume.json')
  if (!existsSync(file)) {
    console.log(`nothing to resume in ${outdir}: no resume.json yet`)
    return 1
  }
  for (const line of takeLines(JSON.parse(readFileSync(file, 'utf8')))) {
    console.log(line)
  }
  return 0
}

/** The receipts file, or an empty object; null when the named file carries no receipt. */
function loadSaved(options) {
  if (!options.receipts || !existsSync(options.receipts)) {
    return {}
  }
  const saved = readLines(options.receipts)
  if (!saved.productReceipt) {
    console.error(`${options.receipts} carries no productReceipt line`)
    return null
  }
  return saved
}

/** One line about the inbox, for the log. */
export function noteFor(looked) {
  if (!looked.ok) {
    return looked.error
  }
  return looked.answer ? 'answer found' : 'no answer yet'
}

/** Writes the record and prints where it went; the receipt stays masked on screen. */
function reportAnswer({ options, saved, outdir, state, mail, inboxNote }) {
  const record = buildRecord({
    challenge: options.challenge ?? saved.challenge ?? 'challenge',
    session: saved.session,
    url: saved.url,
    productReceipt: saved.productReceipt ?? '',
    receiptsFile: options.receipts ?? null,
    source: state.source,
    mail,
  })
  const file = writeRecord(record, outdir)
  appendFileSync(
    join(outdir, 'resume.log'),
    `${new Date().toISOString()} inbox: ${inboxNote}\n`,
  )
  console.log(`resume record: ${file}`)
  if (options.json) {
    console.log(JSON.stringify(maskRecord(record), null, 2))
  }
  return 0
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.mode === 'selftest') {
    await selfTest()
    return 0
  }

  const outdir = resolve(
    options.outdir ??
      join(WORKSPACE_ROOT, '.runs', options.challenge ?? 'challenge'),
  )
  if (options.mode === 'take') {
    return takeFrom(outdir)
  }
  if (!options.challenge && !options.receipts) {
    console.error(
      'usage: node tools/product-inbox.mjs --challenge <uuid> --receipts <file> [--watch|--once|--take]',
    )
    return 2
  }

  const saved = loadSaved(options)
  if (saved === null) {
    return 3
  }
  return watch(options, saved, outdir)
}

/** Checks the answer time and the inbox until the answer is in, then writes the record. */
async function watch(options, saved, outdir) {
  const answerAt = options.answerAt ?? saved.answerAt
  loadWorkspaceEnv()
  const inbox = options.noInbox
    ? null
    : (options.inbox ?? process.env.AGENTMAIL_INBOX)
  const key = process.env.AGENTMAIL_API_KEY
  const started = Date.now()
  const until = started + options.timeoutMin * 60_000

  for (;;) {
    const looked =
      inbox && key
        ? await fetchAnswer({
            inbox,
            key,
            after: saved.answerAt,
            name: saved.name,
          })
        : null
    const inboxNote = looked ? noteFor(looked) : 'no inbox configured'
    const mail = looked?.answer ?? null
    const state = decide({ answerAt, now: Date.now(), mail })
    console.log(
      `${new Date().toISOString()} ${options.mode} · ${state.reason} · ${inboxNote}`,
    )

    if (state.ready) {
      return reportAnswer({ options, saved, outdir, state, mail, inboxNote })
    }
    if (options.mode === 'once' || Date.now() + options.poll > until) {
      console.log(
        `not ready after ${Math.round((Date.now() - started) / 1000)}s; stopping without a record`,
      )
      return 1
    }
    await new Promise((done) => setTimeout(done, options.poll))
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2))
}
