# S04E04 — Automating Work Beyond Code

An application records events as part of serving requests. A separate worker can act on
those events later, using stable IDs to recognize repeat deliveries. Each job has a
different stopping point. Ticket sorting creates a reviewable tag. A requested draft
shows its lookup evidence and waits for a person. A diagnostic report describes observed
behavior on a test copy and leaves the next action to the operator.

| Lesson workflow | Fit in MegaDEV |
| --- | --- |
| Sort incoming tickets | [Ambient listener](../tools/ambient-listener.mjs) and [scheduler](../tools/scheduler/runner.mjs) provide trigger and runner patterns. The episode exercise adds a persisted bookmark and a separate tag per ticket. A live adapter would need an approved inbox, stable ordered event IDs, and a locally labelled evaluation set. |
| Draft a reply on request | Reuse the existing agent configuration for an explicitly requested drafting step once an authoritative quote or hold lookup is available. Supply customer-facing facts only, mark lookup failures as unknown, and give the writer no tools. Check the amount against the relevant lookup and have a person review the promises and decide whether to send. |
| Report on application failures | Start from [journal](../tools/journal.mjs) records for visibility. A future multi-step diagnostic job would need persisted results keyed by event and step, a controlled test copy, and a read-only report whose counts and references come from saved observations. The existing journal and approval records provide related primitives. |

## Local exercise

`node --test s04e04/sorter.test.mjs` runs the sorter on synthetic arrivals and saved
classification answers. [The sorter](sorter.mjs) stores the tag and advances the bookmark
in a single SQLite transaction. Reopening the same database resumes from saved progress.
An invalid or absent answer stops progress at that ticket. Repeated arrivals with the
same ticket ID keep their first tag. The tests also show that a money flag and uncertain
ownership can each independently require review.

The exercise uses the lesson's example thresholds to demonstrate boundary behavior.
A live classifier needs its own answer key, repeated trials scored on whether every money
case reaches review, and a separate set labelled before testing. The exercise uses an
ordered synthetic stream and has no watcher, model call, or live inbox.

## Sources and checks

- [Lesson excerpt](lesson-excerpt.md) maps the two supplied documents by line range.
- `node tools/codebase-map.mjs --check` verifies episode discovery.
- **Open workspace gate.** `node tools/check.mjs` was already failing before the episode
  edits. It reported credential-like values in existing local artifacts and TypeScript
  errors in `mega-examples`. Those findings remain open.
