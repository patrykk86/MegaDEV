/**
 * Tests for tools/product-inbox.mjs: the sender and message rules, the readiness decision, the masking, and
 * one end-to-end run that writes a resume record without touching the network.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildRecord,
  decide,
  fetchAnswer,
  isCourseSender,
  parseArgs,
  pickAnswer,
  takeLines,
  writeRecord,
} from './product-inbox.mjs'

const toolPath = fileURLToPath(new URL('./product-inbox.mjs', import.meta.url))
// Built piece by piece, so no receipt-shaped literal sits in this file for the secret scan to find.
const receipt = ['v1', 'eyJzaWQiOiJ0ZXN0In0', 'notarealreceipt'].join('.')

/** A throwaway folder that is always removed, even when an assertion fails. */
function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'product-inbox-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('only the course counts as the sender', () => {
  assert.equal(isCourseSender('Product <product@mail.mega.dev>'), true)
  assert.equal(isCourseSender('team@mail.mega.dev'), true)
  assert.equal(isCourseSender('admin@agentmail.to'), false)
  assert.equal(isCourseSender('someone@notmega.dev'), false)
  assert.equal(isCourseSender(''), false)
  assert.equal(isCourseSender(undefined), false)
})

test('the newest course message after the step wins, and admin mail never does', () => {
  const mail = [
    {
      from: 'AgentMail <admin@agentmail.to>',
      subject: 'show me when',
      timestamp: '2026-11-12T19:27:30Z',
    },
    {
      from: 'Product <product@mail.mega.dev>',
      subject: 'Re: show me when',
      timestamp: '2026-11-12T19:27:12Z',
    },
    {
      from: 'Product <product@mail.mega.dev>',
      subject: 'older',
      timestamp: '2026-11-12T18:00:00Z',
    },
  ]
  assert.equal(
    pickAnswer(mail, { after: '2026-11-12T19:20:00Z' }).subject,
    'Re: show me when',
  )
  assert.equal(pickAnswer(mail, { after: '2026-11-12T19:30:00Z' }), null)
  assert.equal(pickAnswer(mail, { name: 'status for the night' }), null)
})

test('ready on the answer time, or on the mail, and not before', () => {
  const answerAt = '2026-11-12T19:27:12.752Z'
  assert.equal(
    decide({ answerAt, now: Date.parse('2026-11-12T19:20:00Z') }).ready,
    false,
  )
  assert.equal(
    decide({ answerAt, now: Date.parse('2026-11-12T19:27:12.752Z') }).source,
    'time',
  )
  assert.equal(
    decide({ answerAt, mail: { subject: 'Re: show me when' } }).source,
    'inbox',
  )
  assert.match(decide({ answerAt: 'not a date' }).reason, /not a date/)
})

test('a refused inbox is reported, not hidden', async () => {
  const refused = await fetchAnswer({
    inbox: 'a@b.c',
    key: 'k',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: new Map(),
      json: async () => ({}),
    }),
  })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /403/)
  assert.equal(refused.answer, null)
})

test('the record names the receipt by file and hash, never by value', () => {
  withTempDir((dir) => {
    const record = buildRecord({
      challenge: 'c1',
      productReceipt: receipt,
      receiptsFile: '.runs/job/product.txt',
      source: 'time',
    })
    const file = writeRecord(record, dir)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.receipt.file, '.runs/job/product.txt')
    assert.equal(saved.receipt.sha256.length, 64)
    assert.equal(saved.receipt.masked.includes(receipt), false)
    assert.equal(readFileSync(file, 'utf8').includes(receipt), false)
    assert.equal(
      readFileSync(join(dir, 'resume.log'), 'utf8').includes(receipt),
      false,
    )
    assert.equal(takeLines(record).join('\n').includes(receipt), false)
  })
})

test('the command line names the mode', () => {
  assert.equal(parseArgs(['--once']).mode, 'once')
  assert.equal(parseArgs(['--take']).mode, 'take')
  assert.equal(parseArgs([]).mode, 'watch')
  assert.equal(parseArgs(['--selftest']).mode, 'selftest')
})

test('one run writes the resume record and never prints the receipt', () => {
  withTempDir((dir) => {
    const receipts = join(dir, 'product.txt')
    writeFileSync(
      receipts,
      `productReceipt: ${receipt}\nanswerAt: 2026-11-12T19:27:12.752Z\nurl: https://example.test/\n`,
    )
    const run = spawnSync(
      process.execPath,
      [
        toolPath,
        '--challenge',
        'c-test',
        '--receipts',
        receipts,
        '--outdir',
        dir,
        '--once',
        '--no-inbox',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(run.status, 0, run.stderr)
    assert.equal(
      run.stdout.includes(receipt),
      false,
      'the receipt must not reach stdout',
    )
    const record = JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8'))
    assert.equal(record.next, 'resume-challenge')
    assert.equal(record.source, 'time')
    assert.equal(record.receipt.file, receipts)
    assert.equal(record.receipt.sha256.length, 64)
    assert.equal(
      readFileSync(join(dir, 'resume.json'), 'utf8').includes(receipt),
      false,
    )
    assert.equal(record.challenge, 'c-test')
    assert.match(readFileSync(join(dir, 'resume.log'), 'utf8'), /resume ready/)
  })
})
