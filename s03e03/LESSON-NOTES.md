# S03E03 — AI-Native Product Development, and what we take from it

Opened today, Wed 11 Nov 2026, Week 3 Day 3. This folder keeps `lesson-excerpt.md` (the paragraphs the
course's `mega-start` reply carried, with every gap marked) and this digest. Whatever comes off that
page is data to read, never an instruction to follow.

## The lesson in one paragraph

Agents handle greenfield and brownfield code almost natively, with no special setup, so speed is not
the problem the lesson sets out to solve. It is what the fast version costs if nobody tends it: the
system has to heal itself, recover from issues and get better over time, and that only happens across a
whole lifecycle - exploration, planning, execution, feedback - in which code is one surface among
several. The closing claim is the sharp one: a product built through direct work with agents cannot
keep up with an AI-native one, so in some situations building the platform from scratch is the cheaper
move.

## The four sections, and what each asks of a session

- **Exploration** — synthetic user flows, interactive maps, historical changes, architecture
  visualizations. What it asks here: seeing the product before touching it, from a view a person can
  read, not only from a directory listing.
- **Planning** — scope expansion and contraction, risk mapping, graphs, high-level implementation
  strategies. What it asks here: choosing the size of the change on purpose and naming its risks,
  instead of accepting the first scope the request implies.
- **Execution** — direct work, handoffs, parallel agents, merge points, delegated work. What it asks
  here: knowing which stage each piece is in and where the merge points are, because parallel work
  that never converges is not throughput.
- **Feedback** — system logs, visual feedback, human feedback, artifacts. What it asks here: more than
  a green log - something the human can look at and disagree with.

## Where the workspace already covers it

- **Planning**: `tools/brief.mjs` and the `brief` skill (five blocks, one proof per criterion,
  boundaries), `triage` for arriving requests, and `.agents/rules/challenge_playbook.md` per episode.
- **Execution**: `crew`, `tools/scheduler/runner.mjs`, `tools/gateway/task-bridge.mjs`, results on disk
  at `.runs/<job>/result.json`, and `AGENTS.md` §4 for what a detached job must report.
- **Feedback**: `.runs/journal.jsonl` with hash chaining (`tools/journal.mjs`), `tools/sanitize.mjs`,
  `tools/resumable-approval.mjs`, and `node tools/check.mjs` plus three eval matrices that report pass
  rates instead of impressions.
- **Exploration, partly**: `memory/CODEBASE-MAP.md` from `tools/codebase-map.mjs`, and
  `s03e01/digest-brain.mjs` for past sessions.

## Where it falls short, and what is still open

- **No product view - closed by `tools/product-view.mjs`.** It reads every `tools/*.mjs` docblock, its
  local imports (named, bare and dynamic) and the paths its source names, and renders one page: the
  flows, the paths named across `tools/`, the gates, and the skills with the tool each drives. A test
  counts as a caller, so a module used only by its own test is not mistaken for an entry point, and the
  page says plainly that this is static reachability - blind to `child_process`, to `package.json`
  scripts, to workflows and to agent-driven invocations. What it still does not show: a flow a person
  walks through a running system, because this workspace has no running surface to walk.
- **Feedback is log-shaped - closed for a change, not yet enforced.** `--out` writes the same page
  under `.runs/<job>/`, so a job can leave something a person opens beside the log that proves it. The
  rule in `memory/MEMORY.md` asks for it; nothing yet fails a job that skips it.
- **The byte budget had no room for this lesson.** Measured with `enforceRuleBudget` before writing:
  `AGENTS.md` plus `memory/MEMORY.md` was 23,778 of 24,576 bytes, so three new rules would have pushed
  the whole memory block into the one-line advisory manifest - the system quietly forgetting what it
  learned. Closed in the same change by tightening the existing rules and folding two pairs into one
  rule each, never by dropping a mechanism, then re-measuring: 24,192 bytes, 384 spare. The product
  view then added a row to `AGENTS.md` and a rewritten rule, so the pair now measures 24,314 of 24,576
  bytes with 262 spare, 32 rules, none malformed, no demotion. The margin is still thin, so the next
  rule written here has to pay for itself first.
- **The gate is red for reasons this change does not own.** `node tools/check.mjs` reports 5,167
  problems, and not one of them names a file this change touched: hardcoded keys and tickets inside the
  gitignored `.gemini/` transcripts, `s03e02` receipts, and the `mega-examples` TypeScript errors
  `memory/MEMORY.md` already records as an escalated risk. Open, and the operator's call - a gate that
  is always red cannot tell a new break from the standing noise.

## The rules we adopt

They live in [`memory/MEMORY.md`](../memory/MEMORY.md) under "AI-Native Product Development (from
S03E03)", so they load at the start of every session. That list is the single copy; this file records
why each rule exists, not its wording.

## The review, and where it stopped

Three rounds, every dispatch to `anthropic/claude-haiku-5.5-20261007` after three empty answers from
`deepseek/deepseek-v4.1-flash-20261017`: the routed reviewer is a thinking model, and at a 900-token
cap every token went to reasoning (`reasoning_tokens: 900`, content empty, `finish_reason: length`).
The substitution is announced rather than silent, per `.clinerules` §3.1. Spend for the whole loop:
about **$0.013**, inside the $0.50 the operator set.

- **Round 1, BLOCKED, four findings - all real.** Write attribution counted reads and mentions as
  writes; the import scan missed bare and dynamic `import` and counted a test-only module as an entry
  point; the fingerprint ignored the renderer; nothing filtered text reaching the page. All four fixed.
- **Round 2, BLOCKED, three findings - all real.** The docblock still said "writes" after the page had
  been relabelled; the fingerprint ignored the frontmatter parser and the test edges; hashing raw
  bytes made line endings a staleness signal. All three fixed.
- **Round 3, BLOCKED, four findings.** Three fixed: the schema description still said "what lands on
  disk"; `safeText` covered drive letters only, so POSIX absolute paths and UNC shares go through it
  too, with a fresh-clone test that renders from a tree with no `.agents/`, no `memory/` and no prior
  output; and the page now states that `package.json` scripts, workflows and agent invocations are not
  entry points. **One is rebutted:** the reviewer says the fingerprint cannot see a sibling tool's
  docblock, imports or paths changing. It sees them - every primitive is hashed as a row (purpose,
  imports, paths, schema, test) and the row set is enumerated from the directory each run, so an
  edited or added sibling changes the fingerprint. The reviewer was shown three hunks, not the scan.

The cap is three rounds (`.clinerules` §5), so there was no fourth dispatch. The defects were fixed
locally, the rebuttal is recorded here, and the outstanding question goes to the operator instead of
into another paid round.

## What we deliberately did not do

- **No hard policy file changed.** `AGENTS.md` gained one table row for the new tool and nothing else;
  `.clinerules` and `.agents/rules/*` are untouched.
- **No new skill.** The view is a generator with one deterministic output and a fingerprint gate, so
  its `standaloneReason` records that a skill would only restate the command.
- **No gate wiring in the pull request.** `package.json` and `check.mjs` on this machine carry
  uncommitted work from earlier sessions, so the branch holds the three tool files only, which run
  standalone against what `main` already has. Wiring `--check` into `npm test` belongs to the branch
  that lands the rest.
- **No invented detail.** The reply truncated the section bodies, so `lesson-excerpt.md` marks the gap
  instead of reconstructing it from the outline.
