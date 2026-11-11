#!/usr/bin/env node
// s03e02 triage: the collected requests and backlog, turned into a marked tracker.
//
// Reads nothing from the network: the collectors have already filed one Markdown file per issue
// under starter/sched-prod/doc/issues/. This script rewrites every file into its triaged shape
// (README.md of the kit: frontmatter fields, the two marks, the two body shapes) and then proves
// the tracker holds the rules that make it usable:
//
//   - every request (IN-...) sits in the sources of exactly one issue, open, done or closed;
//   - every open issue carries exactly one mark, agent-ready or needs-human;
//   - an agent-ready issue cites an AUT-1 line, and that line is really in specs/autonomy.md;
//   - a needs-human issue is a question a person can answer (question, options, recommendation, why);
//   - a closed issue carries a reason, and a duplicate names the issue it duplicates;
//   - every blocked-by points at an issue that is still open.
//
// Usage: node s03e02/triage.mjs [--check]   (--check writes nothing and only reports)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACKER = path.join(HERE, 'starter', 'sched-prod', 'doc', 'issues');
const SPECS = path.join(HERE, 'starter', 'sched-prod', 'specs');
const REPORT = path.join(HERE, 'triage-report.json');
const CHECK_ONLY = process.argv.includes('--check');

const AGENT_READY = 'agent-ready';
const NEEDS_HUMAN = 'needs-human';
const REASONS = new Set(['duplicate', 'obsolete', 'contradicts-spec', 'not-planned']);
const LABEL_RE = /^(agent-ready|needs-human|from:[a-z][a-z-]*)$/;
const CITE_RE = /\b(?:PRD|AUT|DES|ADR)-\d+\b|\b(?:SCHED|IN)-\d+\b/;

/** The AUT-1 lines, read from the spec itself, so a citation cannot drift from the rule. */
function autOneLines() {
  const text = fs.readFileSync(path.join(SPECS, 'autonomy.md'), 'utf-8');
  const section = text.split(/^## /m).find((s) => s.startsWith('AUT-1'));
  return section
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

function frontmatter(issue) {
  const fm = [`key: ${issue.key}`, `title: ${JSON.stringify(issue.title)}`, `status: ${issue.status}`];
  if (issue.reason) fm.push(`reason: ${issue.reason}`);
  fm.push(`labels: [${issue.labels.join(', ')}]`);
  if (issue.sources?.length) fm.push(`sources: [${issue.sources.join(', ')}]`);
  if (issue.blockedBy?.length) fm.push(`blocked-by: [${issue.blockedBy.join(', ')}]`);
  if (issue.duplicateOf) fm.push(`duplicate-of: ${issue.duplicateOf}`);
  return `---\n${fm.join('\n')}\n---\n\n${issue.body.trim()}\n`;
}


/** Every rule the tracker must hold, checked against the finished list. */
function checkTracker(issues, requestKeys) {
  const problems = [];
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const sourceOf = new Map();
  const aut1 = autOneLines();

  for (const issue of issues) {
    if (!issue.key || !issue.title || !issue.status) problems.push(`${issue.key}: missing key, title or status`);
    else if (byKey.get(issue.key) !== issue) problems.push(`${issue.key}: duplicate key`);
    for (const label of issue.labels) {
      if (!LABEL_RE.test(label)) problems.push(`${issue.key}: label "${label}" is not a mark or from:<channel>`);
    }
    for (const source of issue.sources ?? []) sourceOf.set(source, [...(sourceOf.get(source) ?? []), issue.key]);
    for (const key of issue.blockedBy ?? []) {
      const target = byKey.get(key);
      if (!target) problems.push(`${issue.key}: blocked-by ${key} is not in the tracker`);
      else if (target.status !== 'open') problems.push(`${issue.key}: blocked-by ${key}, which is ${target.status}`);
    }
    if (issue.status === 'open') checkOpen(issue, aut1, problems);
    if (issue.status === 'closed') checkClosed(issue, byKey, problems);
  }

  for (const key of requestKeys) {
    const owners = sourceOf.get(key) ?? [];
    if (owners.length !== 1) problems.push(`${key}: request sits in ${owners.length} issue(s) (${owners.join(', ') || 'none'})`);
  }
  for (const source of sourceOf.keys()) {
    if (!requestKeys.includes(source)) problems.push(`${source}: a source that is not a collected request`);
  }
  return problems;
}

function checkOpen(issue, aut1, problems) {
  const marks = issue.labels.filter((l) => l === AGENT_READY || l === NEEDS_HUMAN);
  if (marks.length !== 1) {
    problems.push(`${issue.key}: open with ${marks.length} mark(s)`);
    return;
  }
  if (!CITE_RE.test(issue.body)) problems.push(`${issue.key}: cites no rule, issue or request`);
  if (marks[0] === AGENT_READY) checkAgentReady(issue, aut1, problems);
  else checkNeedsHuman(issue, problems);
}

function checkAgentReady(issue, aut1, problems) {
  for (const heading of ['## Intent', '## Acceptance', '## Boundaries']) {
    if (!issue.body.includes(heading)) problems.push(`${issue.key}: agent-ready without ${heading}`);
  }
  const acceptance = issue.body.split('## Acceptance')[1]?.split('## Boundaries')[0] ?? '';
  const givens = acceptance.split(/\r?\n/).filter((l) => l.trim().startsWith('- Given'));
  if (givens.length < 2) problems.push(`${issue.key}: acceptance has ${givens.length} Given/When/Then line(s)`);
  if (!/must not/i.test(acceptance)) problems.push(`${issue.key}: acceptance has no line for what must not happen`);

  const allowed = issue.body.match(/^Allowed by AUT-1[^\n]*$/m)?.[0] ?? '';
  if (!allowed) {
    problems.push(`${issue.key}: agent-ready without an "Allowed by AUT-1" line`);
    return;
  }
  const cited = allowed.replace(/^Allowed by AUT-1\s*[—-]\s*/, '').replace(/[.;]+$/, '').trim();
  const bare = (s) => s.replace(/`/g, '');
  if (!aut1.some((line) => bare(cited).startsWith(bare(line.split(' (')[0])))) {
    problems.push(`${issue.key}: "${cited}" is not an AUT-1 line`);
  }
}

function checkNeedsHuman(issue, problems) {
  for (const heading of ['## Question', '## Options', '## Recommendation', '## Why']) {
    if (!issue.body.includes(heading)) problems.push(`${issue.key}: needs-human without ${heading}`);
  }
  const options = issue.body.split('## Options')[1]?.split('## Recommendation')[0] ?? '';
  if (options.split(/\r?\n/).filter((l) => /^\d+\.\s/.test(l.trim())).length < 2) {
    problems.push(`${issue.key}: needs-human with fewer than two options`);
  }
}

function checkClosed(issue, byKey, problems) {
  if (!REASONS.has(issue.reason)) problems.push(`${issue.key}: closed with reason "${issue.reason}"`);
  if (!CITE_RE.test(issue.body)) problems.push(`${issue.key}: closed without citing what decided it`);
  if (issue.reason !== 'duplicate') return;
  const target = byKey.get(issue.duplicateOf);
  if (!target) problems.push(`${issue.key}: duplicate-of ${issue.duplicateOf} is not in the tracker`);
  else if (target.status === 'closed') problems.push(`${issue.key}: duplicate-of ${issue.duplicateOf}, which is itself closed`);
}

// --- the tracker, issue by issue -------------------------------------------------------------
// The backlog as the product filed it (keys and labels kept), now with a mark on every open one,
// and one issue per request. Bodies follow the two shapes in the kit's README.
const issues = [
  // the backlog: shipped work, left as it arrived
  {
    key: 'SCHED-4423',
    title: 'invite links expire after one hour',
    status: 'done',
    labels: ['from:support'],
    body: 'Invite links now expire one hour after they are sent.',
  },
  {
    key: 'SCHED-4434',
    title: 'booking page: the list of times scrolls on small phones',
    status: 'done',
    labels: ['from:support'],
    body: 'On small phones the list of times was cut off at the bottom. It now scrolls.',
  },
  {
    key: 'SCHED-4439',
    title: 'reminder emails go out 24 h before the slot',
    status: 'done',
    labels: ['from:product'],
    body: 'One reminder email, 24 hours before each booking.',
  },
  {
    key: 'SCHED-4442',
    title: 'search: names match with or without accents',
    status: 'done',
    labels: ['from:support'],
    body: 'Searching for "Zoe" now finds "Zoe with a diaeresis", and the other way round.',
  },
  {
    key: 'SCHED-4458',
    title: 'invoice PDF shows net and gross',
    status: 'done',
    labels: ['from:finance'],
    body: 'Invoice PDFs list net, tax and gross on separate lines.',
  },
  {
    key: 'SCHED-4471',
    title: 'dates parse mm/dd in eu locales',
    status: 'done',
    labels: ['from:support'],
    body: '412 reports · merged by tove · closed 04:04 · by —\n\nIN-8455 is the same defect, filed from the old desk queue before this fix shipped; it is closed as a duplicate of this issue.',
  },

  // the backlog: code brought in line with a rule in specs/, nothing visible changes (AUT-1)
  {
    key: 'SCHED-4412',
    title: 'colours: move hard-coded colours to design tokens',
    status: 'open',
    labels: ['agent-ready', 'from:product'],
    body: [
      '## Intent',
      'Every colour in a component comes from a --color-* token, with the same rendered values, so a new token set can reach the whole interface (DES-2).',
      '',
      '## Acceptance',
      '- Given a component that renders a raw hex, rgb or named colour, when the change lands, then the colour comes from a --color-* token and the rendered value is unchanged.',
      '- Given any page of the product, when it renders before and after, then the two screenshots match.',
      '- Given the diff is read, when it is reviewed, then no raw colour is left in a component and no new value was added to the tokens; must not change a rendered colour, and must not add a colour to the palette.',
      '',
      '## Boundaries',
      '- Must not change layout, spacing or type, or add a token set of its own.',
      '',
      'Allowed by AUT-1 — bringing code in line with a rule in specs/ when nothing visible changes (DES-2).',
    ].join('\n'),
  },
  {
    key: 'SCHED-4463',
    title: 'type: move hard-coded font sizes to the type scale',
    status: 'open',
    labels: ['agent-ready', 'from:product'],
    body: [
      '## Intent',
      'Every font size in the product comes from a step on the type scale, with nothing visible changing (DES-1).',
      '',
      '## Acceptance',
      '- Given a component that sets its own font size, when the change lands, then the size comes from a step in the tokens and the rendered size is unchanged.',
      '- Given any page of the product, when it renders before and after, then the two screenshots match.',
      '- Given the change is in review, when the diff is read, then no font size is set in a component and no new step was added; must not change a rendered size, and must not leave a size outside the scale.',
      '',
      '## Boundaries',
      '- Must not change line heights, spacing or colours.',
      '',
      'Allowed by AUT-1 — bringing code in line with a rule in specs/ when nothing visible changes (DES-1).',
    ].join('\n'),
  },
  {
    key: 'SCHED-4468',
    title: 'spacing: move hard-coded margins to the spacing scale',
    status: 'open',
    labels: ['agent-ready', 'from:product'],
    body: [
      '## Intent',
      'Every margin and padding comes from the 4 px scale in the tokens, with nothing visible changing (DES-3).',
      '',
      '## Acceptance',
      '- Given a component that sets its own margin or padding, when the change lands, then the value comes from the spacing scale and the rendered spacing is unchanged.',
      '- Given any page of the product, when it renders before and after, then the two screenshots match.',
      '- Given a value that sits between two steps, when it is met, then it is reported on its own issue; must not round a spacing onto the scale when that moves something on the page.',
      '',
      '## Boundaries',
      '- Must not change type sizes or colours.',
      '',
      'Allowed by AUT-1 — bringing code in line with a rule in specs/ when nothing visible changes (DES-3).',
    ].join('\n'),
  },

  // the backlog: bug fixes and small features inside the specs (AUT-1)
  {
    key: 'SCHED-4418',
    title: 'week view: first day of the week follows the account locale',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    body: [
      '## Intent',
      'Week view starts on the first day the account locale says, instead of always starting on Sunday.',
      '',
      '## Acceptance',
      '- Given an account whose locale starts the week on Monday, when week view opens, then the first column is Monday.',
      '- Given an account whose locale starts the week on Sunday, when week view opens, then the first column is still Sunday.',
      '- Given a booking on the last day the locale shows, when week view renders, then the booking is in that day and its start and end are unchanged; must not renumber or re-time any booking to fit the new first day (PRD-2).',
      '- Given the change is in review, when the test runs, then it fails before the change and passes after.',
      '',
      '## Boundaries',
      '- Must not change how times are stored (PRD-2, ADR-0001).',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },
  {
    key: 'SCHED-4431',
    title: 'booking page: show remaining seats',
    status: 'open',
    labels: ['agent-ready', 'from:client'],
    body: [
      '## Intent',
      'A group slot on the booking page shows how many of its seats are left.',
      '',
      '## Acceptance',
      '- Given a slot with 10 seats and 3 bookings, when the booking page renders, then it shows 7 seats left.',
      '- Given a slot with every seat taken, when the page renders, then it shows no seats left and offers no booking.',
      '- Given the page renders, when the count is read, then it is counted from the seats on the slot; must not add a stored field, change the number of seats or hide the slot time.',
      '',
      '## Boundaries',
      '- Must not change booking, cancellation or the seat count itself (PRD-1).',
      '',
      'Allowed by AUT-1 — new columns, filters or fields that add to what is there and take nothing away.',
    ].join('\n'),
  },
  {
    key: 'SCHED-4446',
    title: 'CSV export: times carry no UTC offset',
    status: 'open',
    labels: ['agent-ready', 'from:analytics'],
    body: [
      '## Intent',
      'The CSV export says which zone its times are in, as ADR-0001 requires, by adding an offset column beside the times.',
      '',
      '## Acceptance',
      '- Given a booking from 09:00 to 10:00 UTC, when the export is written, then the start and end columns read as they do today and a new column carries the UTC offset.',
      '- Given a tool that read the old export, when it parses the new one, then it reads the same start and end times.',
      '- Given the export is written, when its header is compared with the old one, then it has every column it had plus the new one; must not rewrite, rename or reorder an existing column (PRD-3), and must not lose a column.',
      '',
      '## Boundaries',
      '- Must not change the date format of the columns that are there now while the format question is open (IN-2210).',
      '- Must not convert the times themselves; only say which zone they are in (ADR-0001).',
      '',
      'Allowed by AUT-1 — new columns, filters or fields that add to what is there and take nothing away.',
    ].join('\n'),
  },
  {
    key: 'SCHED-4452',
    title: 'calendar sync: Outlook events arrive twice',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    body: [
      '## Intent',
      'A booking pushed to an Outlook calendar shows up once, not twice.',
      '',
      '## Acceptance',
      '- Given an account with a connected Outlook calendar, when a booking is pushed, then the calendar holds one event for it.',
      '- Given the same booking is pushed again after an edit, when the calendar syncs, then it still holds one event, because the stable id tells an update from a new event (ADR-0002).',
      '- Given the sync has run, when the calendar is inspected, then no event was created twice; must not delete an event sched-prod did not create.',
      '',
      '## Boundaries',
      '- Must not read events back from the calendar: sync stays one-way (ADR-0002).',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },
  {
    key: 'SCHED-4465',
    title: 'API: rate-limit replies carry no Retry-After header',
    status: 'open',
    labels: ['agent-ready', 'from:client'],
    body: [
      '## Intent',
      'A rate-limited API caller is told when it may try again.',
      '',
      '## Acceptance',
      '- Given a caller over the rate limit, when the API answers, then the 429 reply carries a Retry-After header with the seconds to wait.',
      '- Given a caller inside the limit, when it calls, then the reply carries no Retry-After and its body is unchanged.',
      '- Given a client that reads booking times, when it calls, then the times are the same epoch seconds it read before; must not change a time, a status code or the limit itself (IN-5315).',
      '',
      '## Boundaries',
      '- Must not change the times, the status codes or the limit: the API time format is a question of its own (IN-5315).',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },
  {
    key: 'SCHED-4494',
    title: 'week view: a booking across midnight shows on its first day only',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    body: [
      '## Intent',
      'A booking that runs past midnight shows on both days it covers in week view.',
      '',
      '## Acceptance',
      '- Given a booking from 23:00 to 01:00 in the viewer zone, when week view renders, then it shows on its first day and on the day after.',
      '- Given the same booking, when it is read back, then its start and end are unchanged and still stored in UTC (PRD-2, ADR-0001).',
      '- Given the week renders, when bookings are counted, then the booking is one booking with one slot (PRD-1); must not create a second booking to draw the second day, and must not timeshift it into the viewer zone on save.',
      '',
      '## Boundaries',
      '- Must not change stored times or the zone conversion at the edges (ADR-0001).',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },
  {
    key: 'SCHED-4498',
    title: 'confirmation email: the cancel link opens the login page',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    body: [
      '## Intent',
      'The cancel link in the booking confirmation email opens the booking, without asking the person who booked to log in.',
      '',
      '## Acceptance',
      '- Given a person who booked without an account, when they open the cancel link in the confirmation email, then the booking opens and they can cancel it.',
      '- Given a link whose token has been changed, when it is opened, then the page refuses it and the booking is not cancelled.',
      '- Given a link that was already used, when it is opened again, then the page says so and offers no second cancel.',
      '- Given the reminder email, when its cancel link is opened, then it behaves as it does today; must not change that link (PRD-4).',
      '',
      '## Boundaries',
      '- Must not create an account for the person who booked, and must not weaken the token to a guessable booking id.',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },

  // the backlog: the one that needs a person (AUT-2)
  {
    key: 'SCHED-4486',
    title: 'audit log: keep 90 days',
    status: 'open',
    labels: ['needs-human', 'from:finance'],
    body: [
      '## Question',
      'Should audit log entries be deleted once they are 90 days old?',
      '',
      '## Options',
      '1. Delete every entry older than 90 days, on a nightly job, as asked.',
      '2. Keep every entry, and give finance a 90-day view and an export instead.',
      '3. Keep every entry until finance names the retention period its audit obligation needs, then delete to that period.',
      '',
      '## Recommendation',
      'Option 3, then option 1 once the period is agreed.',
      '',
      '## Why',
      'Because the request deletes data that is already stored, which a person decides (AUT-2), and finance owns the audit obligation behind the period, so the length of it cannot be an agent call.',
    ].join('\n'),
  },

  // the requests, one issue each, keyed by the request id they answer
  {
    key: 'IN-1628',
    title: 'bookings list: search by booking reference as well as by name',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    sources: ['IN-1628'],
    body: [
      '## Intent',
      'Staff can find a booking in the bookings list by its booking reference as well as by name.',
      '',
      '## Acceptance',
      '- Given a booking with reference ABC-1234, when staff search ABC-1234, then that booking is in the results.',
      '- Given a search for part of a reference, when it runs, then bookings whose reference contains it are in the results.',
      '- Given a search for a name, when it runs, then it still matches with or without accents (SCHED-4442); must not narrow the name search or drop a booking it found before.',
      '',
      '## Boundaries',
      '- Must not change how a reference is generated, stored or shown, and must not add a field to the booking (PRD-4).',
      '',
      'Allowed by AUT-1 — new columns, filters or fields that add to what is there and take nothing away.',
    ].join('\n'),
  },
  {
    key: 'IN-4183',
    title: 'booking page: call a group slot a class',
    status: 'closed',
    reason: 'obsolete',
    labels: ['from:product'],
    sources: ['IN-4183', 'IN-1552'],
    body: [
      'Withdrawn: product took the rename back after the clinic survey (IN-1552), and the booking page keeps saying group slot. No work here.',
      '',
      'Decided by: IN-1552.',
    ].join('\n'),
  },
  {
    key: 'IN-4819',
    title: 'booking page: offer 15-minute slots',
    status: 'open',
    labels: ['agent-ready', 'from:client'],
    sources: ['IN-4819'],
    body: [
      '## Intent',
      'An account can offer 15-minute slots as well as the 30-minute ones it offers today.',
      '',
      '## Acceptance',
      '- Given an account that turns 15-minute slots on, when a client opens its booking page, then the page offers slots that are 15 minutes long.',
      '- Given a 15-minute booking, when it is stored, then it is one booking on one slot like any other (PRD-1).',
      '- Given accounts that did not turn it on, when their pages render, then their slot lengths and their bookings are unchanged; must not shorten a slot that is already booked.',
      '',
      '## Boundaries',
      '- Must not change how start and end are stored (PRD-2), and must not touch reminder timing (SCHED-4439).',
      '',
      'Allowed by AUT-1 — new columns, filters or fields that add to what is there and take nothing away.',
    ].join('\n'),
  },
  {
    key: 'IN-4841',
    title: 'booking page: a larger text setting',
    status: 'open',
    labels: ['agent-ready', 'from:client'],
    sources: ['IN-4841'],
    blockedBy: ['SCHED-4463'],
    body: [
      '## Intent',
      'The booking page offers a larger text setting, built on the type scale, so older patients can read it.',
      '',
      '## Acceptance',
      '- Given a viewer who turns the larger text setting on, when the booking page renders, then every font size comes from a step on the type scale and nothing overflows its button or field.',
      '- Given the setting is off, when the page renders, then it looks as it does today.',
      '- Given the change is in review, when the diff is read, then no font size is set outside the scale; must not add a step to the scale and must not set a size in a component (DES-1).',
      '',
      '## Boundaries',
      '- Must not ship before SCHED-4463: while sizes sit in components, a setting cannot follow the type scale.',
      '- Must not change colours or spacing.',
      '',
      'Allowed by AUT-1 — a larger text setting built on the type scale (DES-1).',
    ].join('\n'),
  },
  {
    key: 'IN-5645',
    title: 'booking page: the date picker works with the keyboard',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    sources: ['IN-5645'],
    body: [
      '## Intent',
      'A person can open the booking page date picker and choose a date with the keyboard alone.',
      '',
      '## Acceptance',
      '- Given a person tabbing through the booking page, when focus reaches the date picker, then it opens and a date can be chosen without a mouse.',
      '- Given a person using a screen reader, when the picker opens, then it says which date has focus and which is chosen.',
      '- Given focus is inside the picker, when the person presses Escape or tabs past the end, then focus returns to the field; must not trap focus or change the dates offered.',
      '',
      '## Boundaries',
      '- Must not change how a chosen date is parsed or stored (SCHED-4471, PRD-2), and must not replace the picker with a text field.',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },
  {
    key: 'IN-8383',
    title: 'booking page: the Cancel button says Cancel booking',
    status: 'open',
    labels: ['agent-ready', 'from:product'],
    sources: ['IN-8383'],
    body: [
      '## Intent',
      'The button on the booking page that cancels a booking says Cancel booking, so nobody reads it as closing the dialog.',
      '',
      '## Acceptance',
      '- Given a booking page, when it renders, then the button that cancels the booking reads Cancel booking.',
      '- Given a person reading the button, when they read it, then the label names the verb and its object (DES-5).',
      '- Given the other controls on the page, when they render, then their labels and what they do are unchanged; must not change what this button does or where it sits.',
      '',
      '## Boundaries',
      '- Must not rename controls whose cancel means something else, in emails or in exports.',
      '',
      "Allowed by AUT-1 — copy changes in the product's own interface.",
    ].join('\n'),
  },
  {
    key: 'IN-2210',
    title: 'CSV export: month-first dates, or day-first for EU accounts',
    status: 'open',
    labels: ['needs-human', 'from:client'],
    sources: ['IN-2210', 'IN-7923'],
    body: [
      '## Question',
      'Should the CSV export keep its month-first dates, or offer day-first dates to accounts in EU locales?',
      '',
      '## Options',
      '1. Keep month-first everywhere, as the payroll import reads them today (IN-2210).',
      '2. Write dates in the account locale format, day-first for EU accounts (IN-7923).',
      '3. Keep the start and end columns as they are, and add a second pair of date columns in the account locale.',
      '',
      '## Recommendation',
      'Option 3, then option 2 once the payroll importer has moved.',
      '',
      '## Why',
      'Because a client has told us their payroll import reads the month-first format and relies on it, so changing it is a person decision (AUT-2), and support has an EU account asking for the opposite (IN-7923), while PRD-3 forbids losing a column either side depends on.',
    ].join('\n'),
  },
  {
    key: 'IN-5315',
    title: 'API times: epoch seconds, or ISO strings with an offset',
    status: 'open',
    labels: ['needs-human', 'from:client'],
    sources: ['IN-5315', 'IN-2741'],
    body: [
      '## Question',
      'Should the API keep returning booking times as epoch seconds, or switch them to ISO strings with an offset?',
      '',
      '## Options',
      '1. Keep epoch seconds on the current fields, as the client integration has read them for years (IN-5315).',
      '2. Return ISO strings with an offset on the current fields (IN-2741).',
      '3. Keep epoch seconds on the current fields and add ISO string fields with an offset beside them, then retire the old ones in a dated release.',
      '',
      '## Recommendation',
      'Option 3.',
      '',
      '## Why',
      'Because a client has told us their integration relies on epoch seconds, so changing it is a person decision (AUT-2), while product wants ISO strings with an offset (IN-2741) and ADR-0001 expects the API to say which zone a time is in, so the two asks need one owner and one release date.',
    ].join('\n'),
  },
  {
    key: 'IN-8455',
    title: 'old ticket: 03/04 read as 4 March in Germany',
    status: 'closed',
    reason: 'duplicate',
    labels: ['from:support'],
    sources: ['IN-8455'],
    duplicateOf: 'SCHED-4471',
    body: [
      'The same defect SCHED-4471 fixed: a date typed 03/04 in an EU locale was read month-first and landed on 4 March instead of 3 April.',
      '',
      'This ticket came from the old desk queue and was filed before that fix shipped, so it needs no work of its own. Anything it adds about the switch to day-first input belongs to SCHED-4471.',
      '',
      'Decided by: SCHED-4471.',
    ].join('\n'),
  },
  {
    key: 'IN-1839',
    title: 'settings page: the typo Calender reads Calendar',
    status: 'open',
    labels: ['agent-ready', 'from:product'],
    sources: ['IN-1839'],
    body: [
      '## Intent',
      'The settings page spells Calendar correctly.',
      '',
      '## Acceptance',
      '- Given the settings page, when it renders, then no visible string on it reads Calender.',
      '- Given the settings page, when it renders, then every other label and control reads as it does today (DES-5).',
      '- Given emails and exports, when they are read, then their wording is unchanged; must not rename a field or a setting while fixing the typo.',
      '',
      '## Boundaries',
      '- Must not change what the setting does, where it sits, or the stored key behind it (PRD-4).',
      '',
      "Allowed by AUT-1 — copy changes in the product's own interface.",
    ].join('\n'),
  },
  {
    key: 'IN-5886',
    title: 'API: 429 replies carry no hint of when to retry',
    status: 'closed',
    reason: 'duplicate',
    labels: ['from:client'],
    sources: ['IN-5886'],
    duplicateOf: 'SCHED-4465',
    body: [
      'The same defect as SCHED-4465: a rate-limited reply says nothing about when to try again, and that issue adds the Retry-After header.',
      '',
      'Decided by: SCHED-4465.',
    ].join('\n'),
  },
  {
    key: 'IN-6203',
    title: 'week view on phones: the today button is missing',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    sources: ['IN-6203'],
    body: [
      '## Intent',
      'Week view on a phone shows the today button, so a person can get back to the current week.',
      '',
      '## Acceptance',
      '- Given week view on a phone, when it renders, then the today button is there and returns the view to the week that holds today.',
      '- Given week view on a desktop, when it renders, then the button and its behaviour are unchanged.',
      '- Given a narrow screen, when the toolbar renders, then no control overlaps another; must not hide the week navigation or drop a control to make room.',
      '',
      '## Boundaries',
      '- Must not change which day the week starts on (SCHED-4418) or how bookings are placed (PRD-2).',
      '',
      'Allowed by AUT-1 — bug fixes and small features inside the specs, with a test that shows the change.',
    ].join('\n'),
  },
  {
    key: 'IN-6524',
    title: 'invoices: list net and tax as well as gross',
    status: 'closed',
    reason: 'duplicate',
    labels: ['from:finance'],
    sources: ['IN-6524'],
    duplicateOf: 'SCHED-4458',
    body: [
      'Forwarded from an older mail: invoice PDFs should list net and tax as well as gross, which is what SCHED-4458 shipped. The mail predates that change.',
      '',
      'Decided by: SCHED-4458.',
    ].join('\n'),
  },
  {
    key: 'IN-7254',
    title: 'bookings: a 15-minute slot granularity',
    status: 'closed',
    reason: 'duplicate',
    labels: ['from:support'],
    sources: ['IN-7254'],
    duplicateOf: 'IN-4819',
    body: [
      'The same request as IN-4819: 15-minute slots, because the smallest slot today is 30 minutes. The work belongs there.',
      '',
      'Decided by: IN-4819.',
    ].join('\n'),
  },
  {
    key: 'IN-7998',
    title: 'bookings list: a column for how often a person did not turn up',
    status: 'open',
    labels: ['agent-ready', 'from:support'],
    sources: ['IN-7998'],
    body: [
      '## Intent',
      'The bookings list shows a no-show column, so a studio can see how often a person failed to turn up.',
      '',
      '## Acceptance',
      '- Given a person with two no-shows, when the bookings list renders, then the row for their booking shows two.',
      '- Given a person with no bookings missed, when the list renders, then the column shows zero.',
      '- Given a booking that was cancelled or moved, when the count is taken, then it is not counted as a no-show (PRD-1); must not add a stored field or change a booking to produce the count.',
      '',
      '## Boundaries',
      '- Must not hide or reorder the columns that are there now, and must not change how a booking is marked.',
      '',
      'Allowed by AUT-1 — new columns, filters or fields that add to what is there and take nothing away.',
    ].join('\n'),
  },
  {
    key: 'IN-9229',
    title: 'failed booking: show a red box over the page to click away',
    status: 'closed',
    reason: 'contradicts-spec',
    labels: ['from:product'],
    sources: ['IN-9229'],
    body: [
      'Refused as written: DES-4 keeps errors inline, next to what caused them, or in a banner at the top of the page, and allows no modal dialog for an error, because it blocks the booking flow and screen readers lose their place.',
      '',
      'The intent behind it, that nobody misses a failed booking, is met inside that rule: the message goes beside the field that failed, or in the page banner, in the tone the interface already uses. If product wants the modal anyway, it is a change to DES-4 itself, and that is a person decision (AUT-2, PRD-4).',
      '',
      'Decided by: DES-4, PRD-4.',
    ].join('\n'),
  },
  {
    key: 'IN-9467',
    title: 'audit log: ninety days would be enough for finance',
    status: 'closed',
    reason: 'duplicate',
    labels: ['from:finance'],
    sources: ['IN-9467'],
    duplicateOf: 'SCHED-4486',
    body: [
      'The same request as SCHED-4486: audit log entries kept for 90 days instead of forever. The decision belongs in that question.',
      '',
      'Decided by: SCHED-4486.',
    ].join('\n'),
  },
  {
    key: 'IN-9919',
    title: 'confirmation page: show the time zone next to the time',
    status: 'open',
    labels: ['agent-ready', 'from:client'],
    sources: ['IN-9919'],
    body: [
      '## Intent',
      'The booking confirmation shows which zone the time is in, so a client abroad does not turn up an hour off.',
      '',
      '## Acceptance',
      '- Given a booking confirmed for 14:00 in the account zone, when the confirmation page renders, then the time is shown with the zone it is in (PRD-2).',
      '- Given a viewer in another zone, when the page renders, then the zone shown is the one the time is stated in, not the viewer browser zone.',
      '- Given the confirmation email, when it is read, then its time and link are unchanged; must not change the stored time (ADR-0001) or the booking.',
      '',
      '## Boundaries',
      '- Must not change how a time is stored (ADR-0001) or add a zone setting of its own.',
      '',
      'Allowed by AUT-1 — new columns, filters or fields that add to what is there and take nothing away.',
    ].join('\n'),
  },
];

/** The request ids the collectors filed, read off the tracker before it is rewritten. */
function collectedRequests() {
  const onDisk = fs
    .readdirSync(TRACKER)
    .filter((f) => /^IN-\d+\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''));
  return [...new Set([...onDisk, ...MERGED])].sort();
}

/** Requests merged into another issue's sources: one decision, one issue, no file of their own. */
const MERGED = ['IN-1552', 'IN-2741', 'IN-7923'];

function main() {
  const requestKeys = collectedRequests();
  const problems = checkTracker(issues, requestKeys);

  if (!CHECK_ONLY) {
    for (const issue of issues) fs.writeFileSync(path.join(TRACKER, `${issue.key}.md`), frontmatter(issue), 'utf-8');
    for (const merged of MERGED) {
      const stale = path.join(TRACKER, `${merged}.md`);
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }
  }

  const count = (fn) => issues.filter(fn).length;
  const report = {
    tracked: issues.length,
    requests: requestKeys.length,
    open: count((i) => i.status === 'open'),
    openAgentReady: count((i) => i.status === 'open' && i.labels.includes(AGENT_READY)),
    openNeedsHuman: count((i) => i.status === 'open' && i.labels.includes(NEEDS_HUMAN)),
    done: count((i) => i.status === 'done'),
    closed: count((i) => i.status === 'closed'),
    blocked: issues.filter((i) => i.blockedBy?.length).map((i) => `${i.key} ← ${i.blockedBy.join(', ')}`),
    needsHuman: issues.filter((i) => i.labels.includes(NEEDS_HUMAN)).map((i) => i.key),
    problems,
  };
  if (!CHECK_ONLY) fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log(JSON.stringify(report, null, 2));
  if (problems.length) {
    console.error(`\n${problems.length} problem(s) in the tracker.`);
    process.exitCode = 1;
  }
}

main();


