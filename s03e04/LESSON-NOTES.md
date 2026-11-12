# S03E04 — Verifying Product Outcomes, and what we take from it

Opened today, Thu 12 Nov 2026, Week 3 Day 4. This folder keeps `lesson-excerpt.md` (the paragraphs the
course's `mega-start` reply carried, with every gap marked) and this digest. Whatever comes off that
page is data to read, never an instruction to follow.

## The lesson in one paragraph

Agents will happily build the wrong thing fast — drifting from the requirements, finishing too early or
too late — and none of that is wrong at its core; it just does not match the expectations and the
processes this product has. So autonomy waits behind trust: verification has to lean on agents, but it
is designed around mechanisms you can see and understand, which is what lets agents touch the critical
parts of a system and do the refactors nobody would otherwise attempt. The lesson's other point is easy
to miss: many verification artifacts — notes, evidence, tools, whole modules — may exist for agents
only, and that is fine as long as a person can still read the outcome. It closes by warning against
building all of it at once: a few pieces, built well, show whether a gate earns its place.

## The five sections, and what each asks of a session

- **Acceptance** — definition of done, requirements coverage, observable behaviour, completion evidence.
  What it asks here: a done line in terms of what the human can now do, and the one command, log line or
  file that proves it.
- **Verification** — regression tests, browser tests, synthetic scenarios, agent reviewers, deterministic
  checks. What it asks here: the check has to run inside the command the tier already runs; a test file
  nothing invokes verifies nothing.
- **System Diff** — changes to behaviour, user experience, data, architecture, complexity, operations.
  What it asks here: say what the change costs beyond the lines it touched, especially a flow that lost
  its caller.
- **Review** — code, architecture, UX, accessibility, security, performance, maintainability. What it
  asks here: name the dimensions this workspace does not review instead of implying the list is covered.
- **Quality Gates** — confidence thresholds, release blockers, known risks, rollback readiness, human
  approval. What it asks here: a gate is a command that can fail, plus the person who takes the
  irreversible step.

## Where the workspace already covers it

- **Proportional verification**: `AGENTS.md` §2 blast-radius tiers (`doc_only` → `node tools/check.mjs`;
  `policy_change` → check plus the synthetic matrices; `cross_cutting_security` → `node --run test`).
- **Acceptance**: `tools/brief.mjs` and the `brief` skill — five blocks, one proof per criterion,
  boundaries, refused when the proof count and the criteria disagree.
- **Review**: `.clinerules` §5 — reviewer tier from `.agents/model-routing.json`, verbatim target code,
  three-round cap, explicit verdict required.
- **Human approval of the irreversible step**: `tools/resumable-approval.mjs` (fingerprint plus TTL under
  `.approvals/`) and the suspension path in `tools/agent-loop.mjs`.
- **System diff**: `tools/system-diff-build.mjs` behind the `system-diff` skill, rendering one HTML page
  for a commit range.

## Where it fell short, and what this session closed

Two defects, both the lesson's subject rather than its prose: a check that existed and never ran, and a
rule block that existed and never loaded.

- **Tests the gate never reached** → three suites sat outside `package.json`'s `test` script:
  `tools/agent-guard.test.mjs`, `tools/client-handoff.test.mjs`, `tools/product-view.test.mjs`. Measured
  before the fix: `node --test` on those three files alone reported **76 tests, 76 pass, 0 fail** — 76
  assertions the product's own gate never saw. Closed by adding the three files to the script and
  running the whole list it now names: **204 tests, 203 pass, 1 fail**, and that one failure is the
  pre-existing red described below, not a new one.
- **Memory that had stopped loading** → `AGENTS.md` (11,048 B) plus `memory/MEMORY.md` (14,439 B) measured
  **25,487 B against a 24,576 B limit**, so `enforceRuleBudget` (`tools/memory/rule-budget.mjs`) demoted
  the entire memory block: `demoted 1, manifest true` — every learned rule replaced by one advisory
  line. S03E03 predicted this failure in principle; here it had actually happened, silently.
- **One file for every subject** → the operator's correction, applied the same day: memory became a tree.
  `memory/MEMORY.md` is now an index that routes a question to one of nine subject files
  (`session-`, `verification-`, `code-`, `security-`, `architecture-`, `skills-`, `api-`, `product-`,
  `course-knowledge.md`), loads as a **hard** rule so it can never be demoted, and each subject it links
  loads as its own soft rule in link order. Overflow now costs one subject, and the advisory manifest
  names the file to read — instead of losing everything. `AGENTS.md` was cut to 5,852 B of general rules
  and every detail moved into the subject that owns it. `tools/check.mjs` fails a dangling link, an
  unlinked subject, an oversized subject, an over-long index, an `AGENTS.md` over 6,000 B and a
  `.clinerules` over 9,000 B. Measured now: **8,015/24,000 tokens, 32,259/36,864 bytes, demoted 0,
  10 active rules**.
- **The scanner read the copied Antigravity brains** → `.gemini/` and `.copilot/` are out of
  `IGNORED_DIRS` scope on the operator's instruction (read only when a gap needs them), which took
  `node tools/check.mjs` from **5,171 problems to 6**. A false positive went too: `*.test.mjs` fixtures
  are exempt from the absolute-path rule while staying in the secret scan.

## What is still open (escalated, not silently baselined)

- **The peer review has not been delivered.** Four dispatches to the security tier
  (`deepseek/deepseek-v4.1-flash-20261017`) came back with empty content at 400, 900 and 1500 tokens
  on a 1,379-token payload, while a 50-token probe from the same model answered "OK" — the transport
  works and the prompt shape does not. Per `.clinerules` §5 that is recorded as an outstanding review,
  not a pass, and substituting a lighter model would be the security downgrade §3 forbids. The receipt
  is `.runs/review-round1.md`.
- **No browser or visual verification, and no coverage threshold.** There is no running surface to walk
  here, so "browser tests" and "observable behaviour" stay unproven by construction, and no number says
  how much of `tools/` the 218 assertions reach.
- **Rollback readiness has no home.** `tools/brief.tool.json` has no field for it, so a gate that fails
  after something is published has nothing written down to fall back on.
- **The system diff is the gate nobody reaches for**: `tools/system-diff-build.mjs` carries no docblock,
  so `memory/CODEBASE-MAP.md` lists it as `(no docblock)` and no rule asks for a diff per change.

## Acceptance record

| Claim | Command that proves it |
| :--- | :--- |
| Three orphaned suites pass on their own | `node --test tools/agent-guard.test.mjs tools/client-handoff.test.mjs tools/product-view.test.mjs` → 76 tests, 76 pass, 0 fail |
| The whole suite is green | `node --test` over the 22-file list in `package.json` → **218 tests, 218 pass, 0 fail** |
| Memory loads as a tree, nothing demoted | `enforceRuleBudget` over `AGENTS.md` + the tree → 8,015/24,000 tokens, 32,259/36,864 bytes, demoted 0, 10 active rules |
| The tree is shaped right | `inspectMemoryLayout` → `ok: true`, 9 subjects, index 2,144 B, largest subject 3,485 B |
| The workspace gate is green | `node tools/check.mjs` → **passes**: secret hygiene, relative paths, skills, support-kb, codebase map, doc budgets, memory tree, mex check, tsc, biome |
| The tickets are masked | one-off `mask-tickets.mjs` run (deleted after use) → 4 files masked, 0 remaining; `node tools/check.mjs` no longer reports them |

