// s03e01 verify-live test: proves the production harness can fail. Each case breaks one accepted
// requirement in a copy of a good snapshot and asserts that the matching check goes red, so the
// fourteen PASS lines above the live page are evidence rather than a restatement.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checksFor } from './verify-live.mjs';

const STAMP = '2026-11-10T20:44:00Z';

function goodSnapshot() {
  return {
    feed: {
      updatedAt: STAMP,
      incidents: [
        { id: '6040', line: 'tram 3', opened: '2026-11-01T22:10:00Z', author: 'on-call' },
        { id: '6041', line: 'bus 14', opened: '2026-11-02T23:05:00Z', author: 'night shift' },
        { id: '6042', line: 'tram 3', opened: '2026-11-03T00:30:00Z', author: 'on-call' },
        { id: '6045', line: 'sched-prod', opened: '2026-11-03T03:50:00Z', author: '—' },
      ],
    },
    pageHtml: [
      '<style>.banner { background: #d6453d; color: #fff; }</style>',
      '<h1>Status for the night</h1>',
      `<p class="lede">Data read ${STAMP}.</p>`,
      '<td class="line">sched-prod</td>',
      '<td class="line">tram 3</td>',
      '<td class="line">bus 14</td>',
      '<p class="poll">tram 3 boards poll this page</p>',
      '<footer>all times UTC</footer>',
    ].join('\n'),
    data: {
      updatedAt: STAMP,
      incidents: [
        { id: '6045', openedAt: '2026-11-03T03:50:00Z', line: 'sched-prod', date: '03/11', who: '—' },
        { id: '6042', openedAt: '2026-11-03T00:30:00Z', line: 'tram 3', date: '03/11', who: 'on-call' },
        { id: '6041', openedAt: '2026-11-02T23:05:00Z', line: 'bus 14', date: '02/11', who: 'night shift' },
      ],
    },
    dataHeaders: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=45' },
  };
}

function run(snapshot) {
  return checksFor(snapshot).map((check) => {
    try {
      check.run();
      return { tag: check.tag, ok: true };
    } catch (error) {
      return { tag: check.tag, ok: false, detail: error.message };
    }
  });
}

describe('verify-live: the harness accepts a conforming snapshot', () => {
  it('passes all fourteen checks', () => {
    const results = run(goodSnapshot());
    const failures = results.filter((result) => !result.ok);
    assert.deepEqual(failures, []);
    assert.equal(results.length, 14);
  });
});

describe('verify-live: every check can fail', () => {
  const cases = [
    ['R-H5X', (s) => {
      s.dataHeaders['access-control-allow-origin'] = 'https://tram.example';
    }],
    ['R-L9M', (s) => {
      s.data.updatedAt = '2026-11-10 20:44:00';
    }],
    ['R-Z2X', (s) => {
      s.pageHtml = s.pageHtml.replace('Status for the night', 'Status tonight');
    }],
    ['R-K2L', (s) => {
      s.dataHeaders['cache-control'] = 'public, max-age=300';
    }],
    ['R-M4X', (s) => {
      s.pageHtml = s.pageHtml.replace('<footer>all times UTC</footer>', '');
    }],
    ['R-K4H', (s) => {
      s.pageHtml = s.pageHtml.replace('<td class="line">bus 14</td>', '');
    }],
    ['R-H6X', (s) => {
      s.pageHtml = s.pageHtml.replace('tram 3 boards poll this page', 'boards read this page');
    }],
    ['R-L5X', (s) => {
      s.feed.updatedAt = '2026-11-10T19:29:00Z';
    }],
    ['R-H9X', (s) => {
      s.pageHtml = s.pageHtml.replace('#d6453d', '#e04b43');
    }],
    ['R-L2Z', (s) => {
      s.data.incidents.reverse();
    }],
    ['R-Z2L', (s) => {
      s.data.incidents[0].date = '11/03';
    }],
    ['R-K8X', (s) => {
      s.data.incidents.push({ id: '6040', openedAt: '2026-11-01T22:10:00Z', line: 'tram 3', date: '01/11' });
    }],
    ['R-K5Z', (s) => {
      s.data.incidents[0].who = 'on-call';
    }],
    ['AGREE', (s) => {
      s.pageHtml = s.pageHtml.replace(`Data read ${STAMP}.`, 'Data read earlier.');
    }],
  ];

  for (const [tag, breakIt] of cases) {
    it(`${tag} fails when its requirement is broken`, () => {
      const snapshot = goodSnapshot();
      breakIt(snapshot);
      const results = run(snapshot);
      const target = results.find((result) => result.tag === tag);
      assert.equal(target.ok, false, `${tag} should have failed`);
    });
  }
});
