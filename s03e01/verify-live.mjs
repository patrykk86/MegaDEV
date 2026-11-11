// s03e01 verify-live: checks the deployed night status page against the accepted requirements list,
// with the ops feed as the source of truth. This is approach two: the artefact is tested where it
// runs, against live data, instead of trusting a local build and a hand-read page.
//
// Usage: node s03e01/verify-live.mjs [--url <base>] [--json]
//
// The base defaults to the run-1 page; pass --url to check another host that serves the same shape,
// which is how the run-2 Worker was verified before its claim.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getHubJson } from '../tools/hub-client.mjs';

const FEED = '/challenges/status-for-the-night/api/incidents/111cc74e5b37';
const DEFAULT_BASE = 'https://megadevpat.web.app/status';
const BANNER = '#d6453d';

const dayFirst = (iso) => `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}`;

function maxAge(header) {
  const match = String(header ?? '').match(/max-age=(\d+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

// The night shift's night, as product decided it: the newest date plus the previous evening.
function expectedNight(feed) {
  const incidents = Array.isArray(feed?.incidents) ? feed.incidents : [];
  const dates = incidents.map((incident) => String(incident.opened).slice(0, 10)).sort();
  const newest = dates.at(-1) ?? '';
  const previous = newest
    ? new Date(new Date(`${newest}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)
    : '';
  return incidents
    .filter((incident) => {
      const day = String(incident.opened).slice(0, 10);
      const hour = Number(String(incident.opened).slice(11, 13));
      return day === newest || (day === previous && hour >= 18);
    })
    .sort((left, right) => String(right.opened).localeCompare(String(left.opened)));
}

export function checksFor({ feed, pageHtml, data, dataHeaders }) {
  const night = expectedNight(feed);
  const rows = [...pageHtml.matchAll(/<td class="line">([^<]+)<\/td>/g)].map((match) => match[1]);
  return [
    {
      tag: 'R-H5X',
      requirement: 'status JSON answers Access-Control-Allow-Origin: *',
      run: () => assert.equal(dataHeaders['access-control-allow-origin'], '*'),
    },
    {
      tag: 'R-L9M',
      requirement: 'updatedAt is UTC and ends in Z',
      run: () => assert.match(data.updatedAt, /Z$/),
    },
    {
      tag: 'R-Z2X',
      requirement: 'heading says "Status for the night", those exact words',
      run: () => assert.match(pageHtml, /<h1>Status for the night<\/h1>/),
    },
    {
      tag: 'R-K2L',
      requirement: 'Cache-Control max-age is 45 seconds or less',
      run: () => assert.ok(maxAge(dataHeaders['cache-control']) <= 45),
    },
    {
      tag: 'R-M4X',
      requirement: 'footer states all times are UTC',
      run: () => assert.match(pageHtml, /<footer>all times UTC<\/footer>/),
    },
    {
      tag: 'R-K4H',
      requirement: 'every line gets its own row, tram 3 included',
      run: () => {
        assert.deepEqual(rows, night.map((incident) => incident.line));
        assert.ok(rows.includes('tram 3'));
      },
    },
    {
      tag: 'R-H6X',
      requirement: 'the page says "tram 3 boards poll this page"',
      run: () => assert.match(pageHtml, /tram 3 boards poll this page/),
    },
    {
      tag: 'R-L5X',
      requirement: 'updatedAt is the ops feed own value, read live, never a copy',
      run: () => assert.equal(data.updatedAt, feed.updatedAt),
    },
    {
      tag: 'R-H9X',
      requirement: 'the banner is the red from the mock',
      run: () => assert.ok(pageHtml.includes(`.banner { background: ${BANNER}`)),
    },
    {
      tag: 'R-L2Z',
      requirement: 'newest incident at the top',
      run: () => {
        const opened = data.incidents.map((incident) => incident.openedAt);
        assert.deepEqual(opened, [...opened].sort().reverse());
      },
    },
    {
      tag: 'R-Z2L',
      requirement: 'dates ship day first, as the spec writes them',
      run: () => {
        for (const incident of data.incidents) {
          assert.equal(incident.date, dayFirst(incident.openedAt));
        }
      },
    },
    {
      tag: 'R-K8X',
      requirement: 'scope is last night only, so the older night stays off the page',
      run: () => {
        assert.deepEqual(
          data.incidents.map((incident) => incident.id),
          night.map((incident) => incident.id),
        );
        assert.ok(!data.incidents.some((incident) => incident.id === '6040'));
      },
    },
    {
      tag: 'R-K5Z',
      requirement: 'record 6045 ships unnamed, as product decided',
      run: () => assert.equal(data.incidents.find((incident) => incident.id === '6045')?.who, '—'),
    },
    {
      tag: 'AGREE',
      requirement: 'the page and the JSON report the same instant',
      run: () => assert.ok(pageHtml.includes(`Data read ${data.updatedAt}.`)),
    },
  ];
}

async function load(base = DEFAULT_BASE) {
  const root = base.replace(/\/+$/, '');
  const [feed, page, data] = await Promise.all([
    getHubJson(FEED),
    fetch(`${root}/`, { cache: 'no-store' }),
    fetch(`${root}/status.json`, { cache: 'no-store' }),
  ]);
  return {
    feed: feed.body,
    pageHtml: await page.text(),
    data: JSON.parse(await data.text()),
    dataHeaders: Object.fromEntries(data.headers.entries()),
  };
}

function report(results, asJson) {
  const passed = results.filter((result) => result.ok).length;
  if (asJson) {
    console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
    return passed === results.length;
  }
  for (const result of results) {
    const verdict = result.ok ? 'PASS' : 'FAIL';
    console.log(`${verdict}  ${result.tag.padEnd(6)} ${result.requirement}`);
    if (!result.ok) {
      console.log(`      ${result.detail}`);
    }
  }
  console.log(`\n${passed}/${results.length} requirements hold against the deployed page.`);
  return passed === results.length;
}

function runChecks(snapshot) {
  return checksFor(snapshot).map((check) => {
    try {
      check.run();
      return { tag: check.tag, requirement: check.requirement, ok: true };
    } catch (error) {
      return { tag: check.tag, requirement: check.requirement, ok: false, detail: error.message };
    }
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { values } = parseArgs({
    options: { json: { type: 'boolean', default: false }, url: { type: 'string' } },
    allowPositionals: false,
  });
  load(values.url)
    .then((snapshot) => {
      if (!report(runChecks(snapshot), values.json)) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(`verify-live could not read the page or the feed: ${error.message}`);
      process.exitCode = 2;
    });
}
