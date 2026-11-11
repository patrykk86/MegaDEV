// s03e01 status core: one module that builds the night status page and its JSON from the ops feed,
// read live on every request (R-L5X: never a copy). The page and the JSON come from the same rows,
// so they always say the same thing.
//
// The list this page is built from lives in ../requirements.json. Accepted requirements are met
// exactly; the four unresolved conflicts are printed on the page as questions for product, because
// where sources disagree product decides, not this page.

const FEED_URL = 'https://hq.mega.dev/challenges/status-for-the-night/api/incidents/111cc74e5b37';

const OPEN_QUESTIONS = [
  'Dates: R-M9H says month first like the boards; R-Z2L says day first, 03/11. Shown here day first, as the spec writes it.',
  'Scope: R-Z3L says keep the whole week; R-K8X says last night only. Shown here last night only, as the spec writes it.',
  'Author: R-K5Z says each incident names who ran it; record 6045 has no author, so it shows an em dash.',
];

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export async function readFeed(fetchImpl = fetch) {
  const response = await fetchImpl(FEED_URL, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`ops feed answered HTTP ${response.status}`);
  }
  return response.json();
}

const clock = (iso) => (String(iso).length >= 16 ? String(iso).slice(11, 16) : '');
const dayFirst = (iso) => (String(iso).length >= 10 ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}` : '');

export function buildStatus(feed) {
  const incidents = Array.isArray(feed?.incidents) ? feed.incidents : [];

  // R-K8X: last night only, so nothing older stays. A night shift's night runs from the evening
  // before into the small hours, so it is the newest date plus the previous evening.
  const dates = incidents.map((incident) => String(incident.opened ?? '').slice(0, 10)).filter(Boolean).sort();
  const newestDate = dates.at(-1) ?? '';
  const previousDate = newestDate
    ? new Date(new Date(`${newestDate}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10)
    : '';
  const lastNight = incidents.filter((incident) => {
    const day = String(incident.opened ?? '').slice(0, 10);
    const hour = Number(String(incident.opened ?? '').slice(11, 13));
    return day === newestDate || (day === previousDate && hour >= 18);
  });

  // R-L2Z: the newest incident sits at the top. R-K4H: every line gets its own row, tram 3
  // included, so no incident a board polls for is folded away into a summary row.
  const incidentsOut = [...lastNight]
    .sort((left, right) => String(right.opened).localeCompare(String(left.opened)))
    .map((incident) => ({
      id: incident.id,
      openedAt: incident.opened,
      line: incident.line,
      date: dayFirst(incident.opened),
      opened: clock(incident.opened),
      closed: clock(incident.closed),
      what: incident.what ?? '',
      who: incident.author && String(incident.author).trim() !== '—' ? incident.author : '—',
    }));

  // R-L5X: updatedAt is the ops feed's own value. R-L9M: it stays UTC and ends in Z.
  const feedStamp = String(feed?.updatedAt ?? '');
  const updatedAt = /Z$/.test(feedStamp) ? feedStamp : new Date(feedStamp || Date.now()).toISOString();

  return { updatedAt, incidents: incidentsOut };
}

export function renderHtml(status) {
  const rows = status.incidents
    .map(
      (incident) => `<tr>
      <td class="line">${escapeHtml(incident.line)}</td>
      <td>${escapeHtml(incident.date)}</td>
      <td>${escapeHtml(incident.opened)}</td>
      <td>${escapeHtml(incident.closed)}</td>
      <td>${escapeHtml(incident.what)}</td>
      <td>${escapeHtml(incident.who)}</td>
    </tr>`,
    )
    .join('\n');

  const questions = OPEN_QUESTIONS.map((question) => `<li>${escapeHtml(question)}</li>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Status for the night</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1b1b1b; background: #f4f3ee; }
  .banner { background: #d6453d; color: #fff; padding: 14px 24px; font-weight: 600; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 28px; margin: 8px 0 4px; }
  .lede { margin: 0 0 20px; color: #555; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e3e1da; font-variant-numeric: tabular-nums; }
  th { font-size: 13px; text-transform: lowercase; color: #6b6b6b; font-weight: 600; }
  td.line { font-weight: 600; }
  .poll { margin: 18px 0 0; font-weight: 600; }
  h2 { font-size: 16px; margin: 28px 0 6px; }
  ul { margin: 0; padding-left: 20px; color: #444; font-size: 14px; }
  .json { margin-top: 18px; font-size: 14px; }
  footer { max-width: 880px; margin: 0 auto; padding: 0 24px 32px; color: #555; font-size: 14px; }
</style>
</head>
<body>
<div class="banner">Some services had problems overnight.</div>
<main>
<h1>Status for the night</h1>
<p class="lede">sched-prod, last night. Newest incident at the top. Data read ${escapeHtml(status.updatedAt)}.</p>
<table>
<thead>
<tr><th>line</th><th>date</th><th>opened</th><th>closed</th><th>what</th><th>who</th></tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
<p class="poll">tram 3 boards poll this page</p>
<h2>Open questions for product</h2>
<ul>
${questions}
</ul>
<p class="json">The same data as JSON: <a href="status.json">status.json</a></p>
</main>
<footer>all times UTC</footer>
</body>
</html>
`;
}
