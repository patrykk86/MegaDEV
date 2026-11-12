// Records a person-like ack: the viewer picks a row, moves to its Ack button, and clicks while the board
// is still changing. Reports which row was meant, which row the board acked, and the receipt.
//
//   node scripts/record-race.mjs [url] [outFile]
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2] ?? process.env.BOARD_URL ?? 'http://localhost:4173/';
const outFile = process.argv[3] ?? 'race.webm';

const mask = (value) => (value ? `${value.slice(0, 8)}…${value.slice(-6)} (${value.length} chars)` : '');

async function caption(page, text) {
  await page.evaluate((line) => {
    let node = document.getElementById('rec-caption');
    if (!node) {
      node = document.createElement('div');
      node.id = 'rec-caption';
      node.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;padding:10px 16px;background:#1d1d1f;color:#fff;' +
        'font:15px/1.3 system-ui,sans-serif;z-index:9';
      document.body.append(node);
    }
    node.textContent = line;
  }, text);
}

const started = Date.now();
const since = () => {
  const total = Math.round((Date.now() - started) / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

await mkdir(dirname(outFile), { recursive: true });

const browser = await chromium.launch();
let result;
try {
  const context = await browser.newContext({
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: 'recordings', size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));

  await caption(page, 'the on-call board, left open: incidents keep landing at the top');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="incident-row"]', { timeout: 20000 });
  await page.waitForTimeout(2500);

  const rows = page.locator('[data-testid="incident-row"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="incident-row"]').length >= 4, null, {
    timeout: 30000,
  });

  const intended = rows.nth(1);
  const intendedId = await intended.getAttribute('data-id');
  const intendedText = (await intended.locator('.what').innerText()).trim();
  const target = intended.locator('[data-testid="ack"]');
  const box = await target.boundingBox();
  if (!box) throw new Error('the Ack button of the row I meant is not laid out');

  // A person: reads the row, moves the pointer to its Ack button and holds it there.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await caption(page, `I want ${intendedId} (${intendedText}) — pointer on its Ack`);
  await page.waitForTimeout(1200);

  // Wait for the next incident to land: the list re-renders and every row below the new one moves down.
  const before = await rows.first().getAttribute('data-id');
  await page.waitForFunction(
    (prev) => document.querySelector('[data-testid="incident-row"]')?.dataset.id !== prev,
    before,
    { timeout: 40000 },
  );
  const arrivalId = await rows.first().getAttribute('data-id');
  await caption(page, `${arrivalId} just landed at the top — clicking where my pointer was`);

  // The click lands on whatever holds that point now, exactly as a person's click would.
  const at = since();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(2500);

  const ackedIds = await page.$$eval('[data-testid="incident-row"]', (nodes) =>
    nodes.filter((node) => node.querySelector('[data-testid="acked"]')).map((node) => node.dataset.id),
  );
  const ackLines = consoleLines.filter((line) => line.startsWith('ack '));
  const lastAck = ackLines.at(-1) ?? '';
  const [, ackedId = '', , receipt = ''] = lastAck.split(' ');
  const rowStillThere = await page.locator(`[data-testid="incident-row"][data-id="${intendedId}"]`).count();
  const intendedStillAcked = ackedIds.includes(intendedId);

  await caption(
    page,
    intendedStillAcked
      ? `the ack landed on ${intendedId}, the row I meant`
      : `${ackedId ? `${ackedId} is acked` : 'nothing is acked'} — I meant ${intendedId}`,
  );
  await page.waitForTimeout(3500);

  const build = await page.locator('head meta[name="build"]').getAttribute('content');

  result = {
    url,
    flow: 'ack-incident',
    at,
    build,
    intendedId,
    intendedText,
    arrivalId,
    ackedId,
    ackedIds,
    intendedStillAcked,
    rowStillThere,
    receipt,
  };

  await context.close();
  await copyFile(await page.video().path(), outFile);
  await writeFile(`${outFile}.json`, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({ ...result, receipt: mask(receipt) }, null, 2));
} finally {
  await browser.close();
}
