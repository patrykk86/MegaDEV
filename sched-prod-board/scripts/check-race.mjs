// Regression check for the ack race: a person aims at one row and clicks while an incident lands.
// The row the person meant must be the row that gets acked. No recording, exit code 1 when it is not.
//
//   node scripts/check-race.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? process.env.BOARD_URL ?? 'http://localhost:4173/';

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  const ackLines = [];
  page.on('console', (msg) => msg.text().startsWith('ack ') && ackLines.push(msg.text()));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="incident-row"]', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="incident-row"]').length >= 4, null, {
    timeout: 30000,
  });

  const rows = page.locator('[data-testid="incident-row"]');
  const intended = rows.nth(1);
  const intendedId = await intended.getAttribute('data-id');
  const box = await intended.locator('[data-testid="ack"]').boundingBox();
  if (!box) throw new Error('the Ack button of the row I meant is not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // An incident lands while the pointer rests on the row I meant: the list must hold still.
  const arrivalBox = await page.locator('[data-testid="new-bar"]').waitFor({ timeout: 40000 }).then(() => true);
  const arrivalBar = arrivalBox ? await page.locator('[data-testid="new-bar"]').innerText() : '';
  const sameRowStillUnderPointer = await page
    .locator(`[data-testid="incident-row"][data-id="${intendedId}"] [data-testid="ack"]`)
    .boundingBox();
  const held = sameRowStillUnderPointer && Math.round(sameRowStillUnderPointer.y) === Math.round(box.y);

  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(2500);

  const acked = await page.$$eval('[data-testid="incident-row"]', (nodes) =>
    nodes.filter((node) => node.querySelector('[data-testid="acked"]')).map((node) => node.dataset.id),
  );
  const [, ackedId = ''] = (ackLines.at(-1) ?? '').split(' ');

  const report = { url, intendedId, arrivalBar, heldStill: Boolean(held), ackedId, acked, ok: ackedId === intendedId };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
    console.error(`acked ${ackedId || '(nothing)'} but the row I meant was ${intendedId}`);
  }
} finally {
  await browser.close();
}
