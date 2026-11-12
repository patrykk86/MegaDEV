// Records the new build in use: the list holds still while incidents land, the `N new` bar brings them in on
// click, and an ack then lands on the row the pointer was on.
//
//   node scripts/record-step2.mjs [url] [outFile]
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2] ?? process.env.BOARD_URL ?? 'http://localhost:4173/';
const outFile = process.argv[3] ?? 'step2.webm';

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

  await caption(page, 'the board, open and holding still');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="incident-row"]', { timeout: 20000 });
  await page.waitForTimeout(2000);

  const rows = page.locator('[data-testid="incident-row"]');
  const heldBefore = await rows.count();
  const topBefore = await rows.first().getAttribute('data-id');

  await caption(page, 'an incident lands: the list does not move, a bar counts it');
  await page.waitForSelector('[data-testid="new-bar"]', { timeout: 40000 });
  const barText = await page.locator('[data-testid="new-bar"]').innerText();
  await page.waitForTimeout(1200);
  const heldDuring = await rows.count();
  const topDuring = await rows.first().getAttribute('data-id');

  await caption(page, `${barText} waiting — bringing them in on my click`);
  await page.locator('[data-testid="new-bar"]').click();
  const atBringIn = since();
  await page.waitForFunction((want) => document.querySelectorAll('[data-testid="incident-row"]').length > want, heldDuring, {
    timeout: 10000,
  });
  await page.waitForTimeout(1800);
  const topAfter = await rows.first().getAttribute('data-id');

  // A person picks a row, moves to its Ack and clicks with the list at rest.
  const target = rows.filter({ hasNot: page.locator('[data-testid="acked"]') }).nth(2);
  const intendedId = await target.getAttribute('data-id');
  const intendedText = (await target.locator('.what').innerText()).trim();
  const box = await target.locator('[data-testid="ack"]').boundingBox();
  if (!box) throw new Error('no Ack button to aim at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await caption(page, `I want ${intendedId} (${intendedText}) — clicking its Ack`);
  await page.waitForTimeout(900);

  const at = since();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector(`[data-testid="incident-row"][data-id="${intendedId}"] [data-testid="acked"]`, {
    timeout: 10000,
  });
  await page.waitForTimeout(2500);

  const ackLines = consoleLines.filter((line) => line.startsWith('ack '));
  const [, ackedId = '', , receipt = ''] = (ackLines.at(-1) ?? '').split(' ');
  await caption(
    page,
    ackedId === intendedId ? `${intendedId} acked — the row I meant` : `acked ${ackedId || 'nothing'}, I meant ${intendedId}`,
  );
  await page.waitForTimeout(3000);

  const build = await page.locator('head meta[name="build"]').getAttribute('content');

  result = {
    url,
    flow: 'ack-incident',
    at,
    atBringIn,
    build,
    heldBefore,
    heldDuring,
    topBefore,
    topDuring,
    topAfter,
    barText,
    intendedId,
    ackedId,
    receipt,
    listHeldStill: heldBefore === heldDuring && topBefore === topDuring,
    ackedTheRowIMeant: ackedId === intendedId,
  };

  await context.close();
  await copyFile(await page.video().path(), outFile);
  await writeFile(`${outFile}.json`, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({ ...result, receipt: mask(receipt) }, null, 2));
} finally {
  await browser.close();
}
