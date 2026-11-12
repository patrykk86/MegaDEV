// The board (plan R1-R6, issues SCHED-4511 to SCHED-4514, product's decision on the ack race).
// The list holds still while it is on screen: incidents that land are counted in a `N new` bar and come in
// when that bar is clicked. Rows are updated in place by incident id, so a pointer resting on a row stays
// on that incident and a click cannot migrate to the row that moved into its place.
import { ack, fetchIncidents } from './api.js';
import { formatLocal } from './time.js';

const REFRESH_MS = 2000;

const list = document.querySelector('[data-testid="incident-list"]');
const news = document.querySelector('.news');
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');

/** Every incident this tab has seen: id -> incident. */
const incidents = new Map();
/** ids on screen. */
const shown = new Set();
/** ids that landed while the list was on screen and are waiting behind the bar. */
const waiting = [];
/** id -> the row's nodes, reused on every render. */
const rows = new Map();
/** ids this viewer has acked in this tab. */
const acked = new Set();
/** ids with an ack in flight, so a second click cannot send twice. */
const pending = new Set();

const viewer = {
  locale: navigator.language,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

let loaded = false;
let running = false;
let bar = null;

function makeRow(incident) {
  const li = document.createElement('li');
  li.dataset.testid = 'incident-row';
  li.dataset.id = incident.id;
  li.className = 'row';

  const id = document.createElement('span');
  id.className = 'id';

  const sev = document.createElement('span');
  sev.className = 'sev';

  const what = document.createElement('span');
  what.className = 'what';

  const time = document.createElement('time');

  const end = document.createElement('span');
  end.className = 'end';

  const button = makeAckButton(incident.id);
  end.append(button);
  li.append(id, sev, what, time, end);

  return { li, id, sev, what, time, end, button, ackedState: false };
}

/** The Ack button for one incident. It is replaced by the acked mark once the ack lands. */

function makeAckButton(id) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.testid = 'ack';
  button.className = 'ack';
  button.textContent = 'Ack';
  button.addEventListener('click', () => take(id, button));
  return button;
}

/** The acked mark. It exists on a row only while that row is acked, so its presence means acked. */
function makeAckedMark() {
  const mark = document.createElement('span');
  mark.dataset.testid = 'acked';
  mark.className = 'acked';
  mark.textContent = 'acked';
  return mark;
}

/** Draws one incident into its own row, updating text instead of replacing the node. */
function paint(incident) {
  let row = rows.get(incident.id);
  if (!row) {
    row = makeRow(incident);
    rows.set(incident.id, row);
  }
  row.li.className = `row ${incident.severity}`;
  row.id.textContent = incident.id;
  row.sev.textContent = incident.severity;
  row.what.textContent = `${incident.service} · ${incident.region} · ${incident.summary}`;
  row.time.dateTime = incident.openedAt;
  row.time.textContent = formatLocal(incident.openedAt, viewer);
  row.time.title = incident.openedAt;

  const isAcked = acked.has(incident.id);
  if (isAcked !== row.ackedState) {
    row.ackedState = isAcked;
    row.button = isAcked ? null : makeAckButton(incident.id);
    row.end.replaceChildren(isAcked ? makeAckedMark() : row.button);
  }
  if (row.button) row.button.disabled = pending.has(incident.id);
  return row.li;
}

/** Puts the rows on screen in newest-first order without moving a row that is already in place. */
function render() {
  const onScreen = [...shown]
    .map((id) => incidents.get(id))
    .filter(Boolean)
    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));

  let cursor = list.firstChild;
  for (const incident of onScreen) {
    const li = paint(incident);
    if (li === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(li, cursor);
  }

  const keep = new Set(onScreen.map((incident) => incident.id));
  for (const [id, row] of rows) {
    if (!keep.has(id)) {
      row.li.remove();
      rows.delete(id);
    }
  }

  empty.hidden = onScreen.length > 0;
  drawBar();
}


/** The `N new` bar: present only while incidents are waiting, so the list never grows on its own. */
function drawBar() {
  if (waiting.length === 0) {
    bar?.remove();
    bar = null;
    return;
  }
  if (!bar) {
    bar = document.createElement('button');
    bar.type = 'button';
    bar.dataset.testid = 'new-bar';
    bar.className = 'newbar';
    bar.addEventListener('click', bringIn);
    news.append(bar);
  }
  bar.textContent = `${waiting.length} new`;
}

/** Brings the waiting incidents into the list, newest first — the viewer's own click (R1). */
function bringIn() {
  for (const id of waiting.splice(0)) shown.add(id);
  render();
}

/** Acks one incident and marks its row (R2). The row is the row the pointer was on. */
async function take(id, button) {
  if (pending.has(id) || acked.has(id)) return;
  pending.add(id);
  button.disabled = true;
  try {
    await ack(id);
    acked.add(id);
  } catch (error) {
    console.error('ack failed', id, error);
    button.disabled = false;
  } finally {
    pending.delete(id);
    render();
  }
}

/** One refresh: remember what came back, then draw (R1, R4). */
async function refresh() {
  if (running) return;
  running = true;
  try {
    const page = await fetchIncidents();
    const arrived = page.incidents ?? [];
    for (const incident of arrived) incidents.set(incident.id, incident);

    if (!loaded) {
      for (const incident of arrived) shown.add(incident.id);
    } else {
      for (const incident of arrived) {
        if (!shown.has(incident.id) && !waiting.includes(incident.id)) waiting.push(incident.id);
      }
    }

    render();
    if (!loaded) {
      loaded = true;
      loader?.remove();
    }
  } catch (error) {
    console.error('refresh failed', error);
    if (!loaded && loader) {
      loader.textContent = `cannot reach the incident API: ${error.message}`;
      loader.classList.add('failed');
    }
  } finally {
    running = false;
  }
}

render();
await refresh();
setInterval(refresh, REFRESH_MS);
