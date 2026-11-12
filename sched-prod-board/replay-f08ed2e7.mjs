#!/usr/bin/env node
// The course's replay of the plan's flows against your deployed board — the final check. Prints one JSON
// result; send it as `replay` with your step-2 claim, as printed. Do not edit it. Exits 1 when a check
// its nonce names does not hold (the Actions run fails with it).
//
//   node replay.mjs https://your-board.example --nonce <replayNonce>     (add --video to keep a recording in ./replay-out/)
//
// Needs playwright where it runs (the starter's devDependency: npm install, npx playwright install chromium).
// It uses the board like a person: watches it, then acks a few incidents the way a person does (looks at a
// row, moves there, clicks; reads what a panel or a confirm says before going on).
import { chromium } from 'playwright';

const VERSION = 'mvp-2';
const ATTEMPTS = 3;
const AIM_MS = 300;
const WATCH_MS = 16_000;

const QUIET_MS = 8_000;

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const url = args.find((a) => a.startsWith('https://'));
const nonce = opt('--nonce');
// The nonce names the checks this run makes (the course knows what they stand for).
const checks = /^([a-j]{1,10})-[0-9a-f]{12}-[0-9a-f]{16}$/.exec(nonce ?? '')?.[1];
if (!url || !checks) {
  console.error('usage: node replay.mjs https://<your board> --nonce <replayNonce> [--video]');
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(args.includes('--video') ? { recordVideo: { dir: 'replay-out' } } : {}) });
const page = await context.newPage();
const receipts = [];
const ackedIds = [];

page.on('response', async (res) => {
  if (!new URL(res.url()).pathname.endsWith('/api/ack')) return;
  try {
    const body = await res.json();
    if (typeof body?.receipt === 'string') {
      receipts.push(body.receipt);
      ackedIds.push(body.id);
    }
  } catch {}
});

// While aiming, the next answer that brings new incidents is passed on mid-aim (a person's board does not
// wait for them either). While `quiet`, answers hold no incidents (the feed's own cursor kept).
let lastTop = null;
let hold = null;
let quiet = false;
await page.route('**/api/incidents**', async (route) => {
  const res = await route.fetch();
  let body = await res.text();
  if (quiet) {
    try {
      body = JSON.stringify({ ...JSON.parse(body), incidents: [] });
    } catch {}
  }
  let top = null;
  try {
    top = JSON.parse(body).incidents?.[0]?.id ?? null;
  } catch {}
  const fresh = lastTop !== null && top !== null && top !== lastTop;
  if (top) lastTop = top;
  if (fresh && hold?.armed) await new Promise((release) => hold.wait(release));
  await route.fulfill({ response: res, body });
});

const rows = page.locator('[data-testid="incident-row"]');
const topId = () => rows.first().getAttribute('data-id').catch(() => null);
const visible = async (testid) => (await page.locator(`[data-testid="${testid}"]:visible`).count()) > 0;
const textOf = async (testid) => (await page.locator(`[data-testid="${testid}"]:visible`).first().innerText().catch(() => '')) ?? '';

// Rows taken off the board, counted in the page.
await page.addInitScript(() => {
  window.__rowsRemoved = 0;
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches?.('[data-testid="incident-row"]') || n.querySelector?.('[data-testid="incident-row"]'))) window.__rowsRemoved += n.matches?.('[data-testid="incident-row"]') ? 1 : n.querySelectorAll('[data-testid="incident-row"]').length;
  }).observe(document, { childList: true, subtree: true });
});

const t0 = Date.now();
// Observations, neutral: t u v w x y (yes / no), z (a count). The checks at the end read them.
const o = { t: false, u: false, v: false, w: false, x: false, y: false, z: 0 };
quiet = true;
await page.goto(url, { waitUntil: 'domcontentloaded' });
for (const until = Date.now() + QUIET_MS; Date.now() < until && !o.y; ) {
  await page.waitForTimeout(500);
  o.y = !(await visible('loader')) && (await visible('empty'));
}
quiet = false;
await page.goto(url, { waitUntil: 'domcontentloaded' });
await rows.first().waitFor({ timeout: 20_000 });

// Watch the board for a while, untouched.
const firstTop = await topId();
await page.evaluate(() => (window.__rowsRemoved = 0));
const watchUntil = Date.now() + WATCH_MS;
while (Date.now() < watchUntil && !o.t) {
  await page.waitForTimeout(500);
  if ((await topId()) !== firstTop) o.t = true;
  if (await visible('new-bar')) break;
}
while (Date.now() < watchUntil - WATCH_MS / 2) await page.waitForTimeout(500);
o.z = await page.evaluate(() => window.__rowsRemoved);
if (await visible('new-bar')) {
  const before = await topId();
  await page.locator('[data-testid="new-bar"]:visible').first().click();
  await page.waitForTimeout(600);
  o.u = (await topId()) !== before;
}
o.v = (await rows.first().locator('[data-testid="ack"]').count()) > 0;

// A native confirm(): accept only when it names the incident the person picked.
let picking = null;
let nativeConfirm = null;
page.on('dialog', async (d) => {
  nativeConfirm = d.message();
  if (picking && d.message().includes(picking)) await d.accept();
  else await d.dismiss();
});

async function ackLikeAPerson() {
  // The third row not acked yet — a person does not ack the same incident twice.
  const target = rows.filter({ hasNot: page.locator('[data-testid="acked"]') }).nth(2);
  const intended = await target.getAttribute('data-id');
  picking = intended;
  nativeConfirm = null;
  const ackButton = target.locator('[data-testid="ack"]');
  const point = (await ackButton.count()) ? ackButton : target;
  const box = await point.boundingBox();
  if (!box) return { intended, acked: null };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  let release;
  const landed = new Promise((ok) => (hold = { armed: true, wait: (r) => ((release = r), ok()) }));
  await page.mouse.move(x, y, { steps: 8 });
  await Promise.race([landed, page.waitForTimeout(15_000)]);
  release?.();
  hold = null;
  await page.waitForTimeout(AIM_MS);
  const before = receipts.length;
  await page.mouse.click(x, y);
  await page.waitForTimeout(400);
  // A panel: read which incident it names; the wrong one → pick the row again, now it holds still.
  if (await visible('incident-panel')) {
    if (!(await textOf('incident-panel')).includes(intended)) {
      await page.locator(`[data-testid="incident-row"][data-id="${intended}"]`).click();
      await page.waitForTimeout(300);
    }
    if ((await textOf('incident-panel')).includes(intended)) o.w = true;
    await page.locator('[data-testid="panel-ack"]:visible').first().click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  // A confirm in the page: read it; not the one picked → cancel, pick again.
  for (let tries = 0; tries < 2 && (await visible('confirm')); tries++) {
    if ((await textOf('confirm')).includes(intended)) {
      o.x = true;
      await page.locator('[data-testid="confirm-ack"]:visible').first().click();
    } else {
      await page.locator('[data-testid="confirm-cancel"]:visible').first().click().catch(() => page.keyboard.press('Escape'));
      await page.locator(`[data-testid="incident-row"][data-id="${intended}"] [data-testid="ack"]`).click().catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  if (nativeConfirm?.includes(intended)) o.x = true;
  else if (nativeConfirm !== null && receipts.length === before) {
    await page.locator(`[data-testid="incident-row"][data-id="${intended}"] [data-testid="ack"]`).click().catch(() => {});
    await page.waitForTimeout(400);
    if (nativeConfirm?.includes(intended)) o.x = true;
  }
  // The ack this attempt caused: the first answer of the ack API after the click (up to 3 s).
  for (let waited = 0; receipts.length === before && waited < 3_000; waited += 100) await page.waitForTimeout(100);
  return { intended, acked: receipts.length > before ? ackedIds[before] : null };
}

const attempts = [];
for (let i = 0; i < ATTEMPTS; i++) attempts.push(await ackLikeAPerson());
const build = await page.locator('meta[name="build"]').getAttribute('content').catch(() => null);
await context.close();
await browser.close();

const holds = {
  a: o.t,
  b: !o.t,
  c: o.u,
  d: o.v,
  e: !o.v,
  f: o.w,
  g: o.x,
  h: attempts.every((a) => a.acked === a.intended),
  i: o.y,
  j: o.z === 0,
};
const unmet = checks.split('').filter((c) => !holds[c]);
console.log(JSON.stringify({ runner: process.env.GITHUB_ACTIONS ? 'actions' : 'local', version: VERSION, url, nonce, build, ranAt: new Date(t0).toISOString(), observed: o, attempts, unmet, receipts }, null, 2));
process.exit(unmet.length ? 1 : 0);
