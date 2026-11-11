// s03e01 run 2 verify-local: runs the Worker handler in plain Node and asserts the accepted list
// against it, with the live ops feed as the source of truth. It is the same check the deployed page
// gets from s03e01/verify-live.mjs, run one host earlier so the deploy step is the only thing left.
//
// Usage: node s03e01/run2/worker/verify-local.mjs [--json]

import { checksFor } from '../../verify-live.mjs';
import { getHubJson } from '../../../tools/hub-client.mjs';
import worker from './index.mjs';

const FEED_PATH = '/challenges/status-for-the-night/api/incidents/111cc74e5b37';
const ORIGIN = 'https://night-status.example.workers.dev';

function runOnce(snapshot, feed) {
  return checksFor({ ...snapshot, feed }).map((check) => {
    try {
      check.run();
      return { tag: check.tag, requirement: check.requirement, ok: true };
    } catch (error) {
      return { tag: check.tag, requirement: check.requirement, ok: false, detail: error.message };
    }
  });
}

async function snapshot() {
  const before = (await getHubJson(FEED_PATH)).body;
  const dataResponse = await worker.fetch(new Request(`${ORIGIN}/status.json`));
  const pageResponse = await worker.fetch(new Request(`${ORIGIN}/`));
  const after = (await getHubJson(FEED_PATH)).body;
  return {
    before,
    after,
    snapshot: {
      feed: before,
      pageHtml: await pageResponse.text(),
      data: await dataResponse.json(),
      dataHeaders: Object.fromEntries(dataResponse.headers.entries()),
    },
    rootStatus: await worker.fetch(new Request(`${ORIGIN}/`)).then((r) => r.status),
    notFound: await worker.fetch(new Request(`${ORIGIN}/nope`)).then((r) => r.status),
    post: await worker.fetch(new Request(`${ORIGIN}/`, { method: 'POST' })).then((r) => r.status),
  };
}

function settle(snapshotWithFeed, feed) {
  const results = runOnce(snapshotWithFeed.snapshot, feed);
  return results.map((result) => (result.ok ? result : { ...result, ok: false }));
}

const asJson = process.argv.includes('--json');

const live = await snapshot();

// R-L5X compares the JSON to the feed's own value. The feed advances once a minute, so the Worker may
// have read a later minute than the first probe; the value it served must be one the feed itself
// served during this run, so either probe is a valid source of truth.
let results = settle(live, live.before);
const stamp = results.find((result) => result.tag === 'R-L5X');
if (!stamp.ok) {
  const retried = settle(live, live.after);
  const retriedStamp = retried.find((result) => result.tag === 'R-L5X');
  if (retriedStamp.ok) {
    results = retried;
  }
}

const served = {
  root: live.rootStatus,
  notFound: live.notFound,
  post: live.post,
};

if (asJson) {
  console.log(JSON.stringify({ served, results }, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.tag.padEnd(6)} ${result.requirement}`);
    if (!result.ok) {
      console.log(`      ${result.detail}`);
    }
  }
  console.log(`\nroutes: / ${served.root}, /nope ${served.notFound}, POST / ${served.post}`);
  const passed = results.filter((result) => result.ok).length;
  console.log(`${passed}/${results.length} requirements hold against the Worker handler.`);
}

if (results.some((result) => !result.ok) || served.root !== 200 || served.notFound !== 404) {
  process.exitCode = 1;
}
