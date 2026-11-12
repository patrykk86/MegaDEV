// Walks the plan's flows in a real browser against one board URL and asserts what it saw.
// No recording here: this is the fast check. Exit code 1 on the first broken requirement.
//
//   node scripts/check-board.mjs [url]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.argv[2] ?? process.env.BOARD_URL ?? 'http://localhost:4173/';
const viewer = { locale: 'de-DE', timeZoneId: 'Europe/Berlin' };

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ locale: viewer.locale, timezoneId: viewer.timeZoneId });
  const page = await context.newPage();
  const faults = [];
  page.on('pageerror', (error) => faults.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') faults.push(`console: ${msg.text()}`);
  });

  let ackRequests = 0;
  let incidentRequests = 0;
  page.on('request', (req) => {
    if (req.url().includes('/ack?')) ackRequests += 1;
    if (req.url().includes('/incidents?')) incidentRequests += 1;
  });

  // Hold the first incidents answer back, so the loader is observable (R3).
  await page.route('**/incidents?**', async (route) => {
    await new Promise((done) => setTimeout(done, 900));
    await route.continue();
  });

  const loads = [];
  page.on('load', () => loads.push(Date.now()));

  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForSelector('[data-testid="loader"]', { timeout: 5000 });
  assert.equal(await page.locator('[data-testid="loader"]').count(), 1, 'R3: loader shows on open');

  await page.waitForSelector('[data-testid="incident-row"]', { timeout: 15000 });
  assert.equal(await page.locator('[data-testid="loader"]').count(), 0, 'R3: loader gone once loaded');

  const rows = page.locator('[data-testid="incident-row"]');
  const count = await rows.count();
  assert.ok(count > 0, 'R1: the board shows incidents');

  const order = await rows.evaluateAll((nodes) =>
    nodes.map((node) => ({ id: node.dataset.id, at: node.querySelector('time')?.dateTime ?? '' })),
  );
  const sorted = [...order].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  assert.deepEqual(order.map((r) => r.id), sorted.map((r) => r.id), 'R1: newest first');

  const shown = await rows.first().locator('time').innerText();
  assert.match(shown, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/, 'R5: a Berlin viewer reads dd/mm and a time');
  const isoKept = await rows.first().locator('time').getAttribute('datetime');
  assert.match(isoKept, /^\d{4}-\d{2}-\d{2}T/, 'R5: the UTC value stays in datetime');

  const build = await page.locator('head meta[name="build"]').getAttribute('content');
  const footer = await page.locator('[data-testid="build-sha"]').innerText();
  assert.ok(build && build !== 'dev', 'R6: the page names its build');
  assert.equal(footer, build, 'R6: head and footer carry the same sha');

  // R2: ack the first row and watch it turn acked.
  const first = order[0].id;
  const acked = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('ack ')) acked.push(text);
  });
  await rows.first().locator('[data-testid="ack"]').click();
  await page.waitForSelector(`[data-testid="incident-row"][data-id="${first}"] [data-testid="acked"]`, {
    timeout: 10000,
  });
  assert.equal(ackRequests, 1, 'R2: one ack request for one click');
  assert.equal(acked.length, 1, 'R2: the receipt reached the console');

  // R1 (product's decision): the list holds still; a `N new` bar brings arrivals in on click.
  const held = await rows.count();
  await page.waitForSelector('[data-testid="new-bar"]', { timeout: 40000 });
  const barText = await page.locator('[data-testid="new-bar"]').innerText();
  assert.match(barText, /^\d+ new$/, `R1: the bar counts what landed, read "${barText}"`);
  assert.equal(await rows.count(), held, 'R1: the list holds still while the bar shows');

  const brought = Number(barText.split(' ')[0]);
  await page.locator('[data-testid="new-bar"]').click();
  await page.waitForFunction(
    (want) => document.querySelectorAll('[data-testid="incident-row"]').length >= want,
    held + brought,
    { timeout: 10000 },
  );
  assert.equal(await page.locator('[data-testid="new-bar"]').count(), 0, 'R1: the bar goes once they are in');

  const after = await rows.evaluateAll((nodes) =>
    nodes.map((node) => ({ id: node.dataset.id, at: node.querySelector('time')?.dateTime ?? '' })),
  );
  const newestFirst = [...after].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  assert.deepEqual(after.map((r) => r.id), newestFirst.map((r) => r.id), 'R1: brought in newest first');

  // R4: the board keeps polling and never reloads (R1: no reload).
  const before = incidentRequests;
  await page.waitForTimeout(5000);
  assert.ok(incidentRequests > before, 'R4: the board refreshes itself');
  assert.equal(loads.length, 1, 'R1: still the same page load');

  assert.deepEqual(faults, [], `no page or console errors: ${faults.join('; ')}`);

  console.log(
    JSON.stringify(
      { ok: true, url, rows: count, build, time: shown, acked: first, incidentRequests, fault: null },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
