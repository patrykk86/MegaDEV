// s03e01 verify: checks the running status page against the accepted requirements, one assertion
// per tag, against the live response rather than a rendered impression.
//
// Usage: node s03e01/site/verify.mjs [base-url]

import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'http://127.0.0.1:8788').replace(/\/$/, '');
const feedUrl = 'https://hq.mega.dev/challenges/status-for-the-night/api/incidents/111cc74e5b37';

const pageResponse = await fetch(`${base}/`, { cache: 'no-store' });
const page = await pageResponse.text();
const jsonResponse = await fetch(`${base}/status.json`, { cache: 'no-store' });
const json = await jsonResponse.json();
const feed = await (await fetch(feedUrl, { cache: 'no-store' })).json();

const rows = json.incidents ?? [];
const results = [];

function check(tag, requirement, run) {
  try {
    run();
    results.push({ tag, requirement, pass: true });
  } catch (error) {
    results.push({ tag, requirement, pass: false, detail: error.message });
  }
}

check('R-Z2X', 'heading says "Status for the night", exact words', () => {
  assert.match(page, /<h1>Status for the night<\/h1>/);
});

check('R-H9X', 'banner stays red, the exact colour from the mock', () => {
  assert.match(page, /\.banner \{ background: #d6453d/);
  assert.match(page, /<div class="banner">Some services had problems overnight\.<\/div>/);
});

check('R-K4H', 'every line gets its own row, tram 3 included', () => {
  const lines = rows.map((row) => row.line);
  for (const line of ['tram 3', 'bus 14', 'night bus N2', 'sched-prod']) {
    assert.ok(lines.includes(line), `${line} has no row`);
  }
});

check('R-K8X', 'last night only, nothing older stays', () => {
  assert.doesNotMatch(page, /cache warmup stalled/);
});

check('R-L2Z', 'newest incident at the top', () => {
  const opened = rows.map((row) => String(row.openedAt));
  const sorted = [...opened].sort().reverse();
  assert.deepEqual(opened, sorted, `rows out of order: ${opened.join(',')}`);
});

check('R-H6X', 'page says "tram 3 boards poll this page"', () => {
  assert.match(page, /tram 3 boards poll this page/);
});

check('R-M4X', 'footer says all times UTC', () => {
  assert.match(page, /<footer>all times UTC<\/footer>/);
});

check('R-L2Z page', 'the older incident is on the page, not truncated', () => {
  assert.match(page, /stop names out of date/);
});

check('R-L9M', 'updatedAt is UTC and ends in Z', () => {
  assert.match(json.updatedAt, /Z$/);
});

check('R-L5X', "updatedAt is the ops feed's own value, not a copy of the clock", () => {
  assert.equal(json.updatedAt, feed.updatedAt);
});

check('R-H5X', 'status.json answers with Access-Control-Allow-Origin: *', () => {
  assert.equal(jsonResponse.headers.get('access-control-allow-origin'), '*');
});

check('R-K2L', 'Cache-Control max-age is 45 seconds or less', () => {
  const header = jsonResponse.headers.get('cache-control') ?? '';
  const maxAge = Number((header.match(/max-age=(\d+)/) ?? [])[1] ?? Number.POSITIVE_INFINITY);
  assert.ok(maxAge <= 45, `max-age was ${maxAge}`);
});

check('page', 'page and JSON agree on the same rows', () => {
  assert.equal(rows.length, (page.match(/<tr>\s*<td class="line">/g) ?? []).length);
});

const failed = results.filter((result) => !result.pass);
console.log(JSON.stringify({ base, rows: rows.length, checked: results.length, failed: failed.length, results }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
