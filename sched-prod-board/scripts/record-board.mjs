// Records the board in use against one URL and writes what the recording shows:
// the ack receipt, its second in the video, the build sha and the video file.
//
//   node scripts/record-board.mjs [url] [outFile]
//
// Prints JSON with the receipt masked; the whole record lands in <outFile>.json.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2] ?? process.env.BOARD_URL ?? 'http://localhost:4173/';
const outFile = process.argv[3] ?? 'recording.webm';
const viewer = { locale: 'de-DE', timeZoneId: 'Europe/Berlin' };

const mask = (value) => (value ? `${value.slice(0, 8)}…${value.slice(-6)} (${value.length} chars)` : '');

/** A caption the viewer can read while the recording runs. It is not a hook and not part of the board. */
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
let record;
try {
  const context = await browser.newContext({
    locale: viewer.locale,
    timezoneId: viewer.timeZoneId,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: 'recordings', size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();

  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));

  // Slow the first answer down so the loader is visible in the video (R3).
  await page.route('**/incidents?**', async (route) => {
    await new Promise((done) => setTimeout(done, 1200));
    await route.continue();
  });

  await caption(page, 'opening the board: the loader shows until the incidents arrive');
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForTimeout(2000);

  await caption(page, 'incidents, newest first, in this viewer’s time zone (dd/mm)');
  await page.waitForSelector('[data-testid="incident-row"]', { timeout: 15000 });
  const rows = page.locator('[data-testid="incident-row"]');
  const count = await rows.count();
  await page.waitForTimeout(2500);

  const id = await rows.first().getAttribute('data-id');
  const shownTime = await rows.first().locator('time').innerText();
  await caption(page, `taking ${id} to send the ack`);
  await page.waitForTimeout(1200);

  await rows.first().locator('[data-testid="ack"]').click();
  const at = since();
  await page.waitForSelector(`[data-testid="incident-row"][data-id="${id}"] [data-testid="acked"]`, {
    timeout: 10000,
  });
  await caption(page, `${id} is acked — receipt sealed for ${at} in this recording`);
  await page.waitForTimeout(3000);

  await caption(page, 'the board stays current on its own: refreshing every 2 s, no reload');
  await page.waitForTimeout(4500);

  const build = await page.locator('head meta[name="build"]').getAttribute('content');
  const footer = await page.locator('[data-testid="build-sha"]').innerText();
  const ackLine = consoleLines.find((line) => line.startsWith(`ack ${id} `)) ?? '';
  const receipt = ackLine.split(' ').at(-1) ?? '';

  record = {
    url,
    flow: 'ack-incident',
    at,
    build,
    footer,
    ackedId: id,
    shownTime,
    rows: count,
    receipt,
  };

  await context.close();
  const video = await page.video().path();
  await copyFile(video, outFile);
  await writeFile(`${outFile}.json`, JSON.stringify({ ...record, receipt }, null, 2));

  console.log(
    JSON.stringify(
      {
        ...record,
        receipt: mask(receipt),
        video,
        outFile,
        consoleHadAckLine: Boolean(ackLine),
      },
      null,
      2,
    ),
  );
  if (!receipt) throw new Error('no ack receipt in the console: the video would prove nothing');
} finally {
  await browser.close();
}
