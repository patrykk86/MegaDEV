# AGENTS.md

MegaDEV is a pure Node.js 25 workspace: the agent harness in `tools/`, course episodes in `s0Xe0Y/`, a
knowledge base in `support-kb/`, examples in `mega-examples/`, skills in `.agents/skills/`. This file holds
only hard rules, one line each. Cost, routing and shell hygiene live in `.clinerules`; learned rules live in
[`memory/MEMORY.md`](./memory/MEMORY.md) — an **index**: read the subject it points to, and file a new rule
in the subject that owns it. Episode detail lives in `.agents/rules/challenge_playbook.md`.

Hard cap: 6,000 characters. A rule needing a paragraph belongs in a skill, a memory subject, a tool schema
or a playbook.

## Where the detail lives

| Topic | Read |
| :--- | :--- |
| routing a question to a memory file | [memory/MEMORY.md](./memory/MEMORY.md) |
| guard, loop, journal, budget, scheduler, gateway | `memory/architecture-knowledge.md` |
| conventions, docblocks, tests, canonical tools | `memory/code-knowledge.md` |
| verification tiers, review loop, evidence | `memory/verification-knowledge.md` |
| secrets, approvals, redaction | `memory/security-knowledge.md` |
| skills catalog and their tools | `memory/skills-knowledge.md` |
| hub client, MCP transports, deploys | `memory/api-knowledge.md` |
| outcomes, briefs, triage marks | `memory/product-knowledge.md` |
| course rounds, episode notes | `memory/course-knowledge.md` |
| a tool's behaviour | its docblock, its `.tool.json`, `memory/CODEBASE-MAP.md` |

## 1. Boundaries
- MegaDEV and BioCore-AI are separate projects; never import clinical skills or knowledge bases here.
- No absolute paths in tracked files: resolve through `import.meta.url`/`fileURLToPath` or a documented env
  var. `%~dp0` is for `.cmd` launchers only.
- `mega-examples/` is its own repo: `npm --prefix mega-examples start -- <name>`, never `npx mex` at the root.
- Course deliverables use the challenge identity, never the operator's personal account or `github-mcp-server`.
- `.gemini/` and `.copilot/` are copied Antigravity brains: out of the scanner, read only when a gap needs
  them, never committed.

## 2. Autonomy and proportional verification
- Act on internal work without asking. Ask before host-wide or system-wide changes and before paid model
  runs in `mega-examples`.
- Verify by blast radius and report the command and why: `localized_code` - the module's unit tests;
  `doc_only` - `node tools/check.mjs`; `policy_change` (this file, `SKILL.md`, `.agents/rules/*`,
  `*.tool.json`) - synthetic matrix plus static analysis; `cross_cutting_security` (`agent-guard`,
  `agent-loop`, `journal`, `sanitize`, `resumable-approval`, root architecture) - `node --run test`.
- A red gate is never a baseline: escalate it and record it as open.
- Peer review gates non-trivial work; `.clinerules` §5 owns the tier, the evidence and the round cap.

## 3. Toolbox and skills
- One canonical tool per job. Read the `.tool.json` before the call; the schema, not memory, is the
  contract. A module without one is reached through `tools/agent-loop.mjs`.
- A skill names its tool in `metadata.tools` and its contract in `metadata.schema`, both inside this
  repository; `node tools/skill-links.test.mjs` proves the links.
- The catalog is `memory/skills-knowledge.md` and `memory/CODEBASE-MAP.md`; never restate it here.

## 4. Background work
- Never stall on a long job: `crew`, `tools/scheduler/runner.mjs`, `tools/gateway/task-bridge.mjs`. Report
  PID, log and result path as it starts, and read the log first on the next turn.
- Results land at `.runs/<job>/result.json`, scrubbed; open work waits behind a watcher, not a shell.

## 5. Synthetic evaluation gate
- Instruction and skill changes are never validated on happy paths: run
  `node tools/eval-agent-primitives.mjs`, `node tools/eval-agents-capabilities.mjs`, `node tools/eval-skill.mjs`,
  and compare pass rates.
- Assertions are code (`node:assert`), never self-review.

## 6. Layered defense
- Untrusted text passes `tools/sanitize.mjs` before a model reads it; outbound tools and logs pass a masking
  filter.
- Least privilege: no irreversible write, dispatch or credentialed tool for untrusted input without an
  approval gate.
- No plaintext PHI or PII in prompts, logs, `.runs/`, `.approvals/` or hand-offs; errors and refusals echo
  nothing.
- Sender authentication, bundle encryption and channel replacement: `memory/security-knowledge.md`.

## 7. Guarded execution and memory
- Every autonomous loop runs through `tools/agent-loop.mjs` under `tools/agent-guard.mjs`: limits from
  `tools/model-limits.json`, sandboxed paths, shell allowlisting, fail-closed policy, own-property dispatch.
  A call rewritten by a `beforeTool` hook is re-checked before it runs.
- Tests carry exception-safe cleanup, unique ids and exact assertions.
- Memory loads as a tree through `tools/memory/rule-budget.mjs`: the index is hard, each subject soft, the
  tail demotes first. `AGENTS.md` holds hard rules, memory the soft; measure before adding.

## 8. Recall and resumable approvals
- Past notes arrive through `tools/memory/contextual-recall.mjs`, bounded by the same budget, never as a
  pasted transcript.
- An approval needing a human is suspended, not held: `tools/resumable-approval.mjs` writes a tamper-evident
  record under `.approvals/`, the loop exits `suspended`, and resumption checks fingerprint and TTL.

## 9. Journal, routing, ambient
- Guarded calls append to `.runs/journal.jsonl` with SHA-256 hash chaining and outbound redaction;
  `tools/journal.mjs` reads it.
- Routing never downgrades security work; reviewer dispatches use the security tier in
  `.agents/model-routing.json`.
- Ambient listeners stay inside the workspace root, coalesce, deduplicate and contain their own errors.
