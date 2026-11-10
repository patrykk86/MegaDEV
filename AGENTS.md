# AGENTS.md

MegaDEV is a pure Node.js 25 workspace: an agent harness in `tools/`, course episodes in `s0Xe0Y/`,
a knowledge base in `support-kb/`, examples in `mega-examples/`, skills in `.agents/skills/`. This
file is the entry point - the hard rules, one line each, with the detail behind a pointer. Cost,
routing and shell hygiene live in [`.clinerules`](./.clinerules); learned rules live in
[`memory/MEMORY.md`](./memory/MEMORY.md); episode detail lives in
[`.agents/rules/challenge_playbook.md`](./.agents/rules/challenge_playbook.md).

This file stays at or under 12,000 characters. A rule that needs a paragraph belongs in a skill, a
tool schema or a playbook, not here.

## 1. Boundaries and entry points
- MegaDEV and BioCore-AI are separate projects with separate dependencies; never import clinical
  skills or knowledge bases here. Sibling skills may be read for technique only.
- No absolute filesystem paths in tracked files: resolve through `import.meta.url` with
  `fileURLToPath`, or a documented environment variable. `%~dp0` is for `.cmd` launchers only.
- `mega-examples/` is its own git repo: run `npm --prefix mega-examples start -- <name>`, never
  `npx mex` from the root.
- Course deliverables use the challenge identity, never the operator's personal account or
  `github-mcp-server`.

## 2. Autonomous execution and proportional verification
- Act on internal work without asking: reading, editing, local commands, local tests. Ask before
  host-wide or system-wide changes, and before paid model runs in `mega-examples`.
- Verify by blast radius, not with blanket suites, and report which command ran and why:
  - `localized_code` - targeted unit tests for the module or utility touched.
  - `doc_only` - `node tools/check.mjs`.
  - `policy_change` - `AGENTS.md`, `SKILL.md`, `.agents/rules/*`, `*.tool.json`: the synthetic
    matrix of section 5, plus static analysis.
  - `cross_cutting_security` - `tools/agent-guard.mjs`, `tools/agent-loop.mjs`,
    `tools/journal.mjs`, `tools/sanitize.mjs`, `tools/resumable-approval.mjs`, root architecture:
    `node --run test`.
- Peer review gates non-trivial work, but the loop itself is not restated here: `.clinerules` §5
  owns the reviewer tier, the evidence a dispatch must carry and the round cap. Report the verdict
  and what changed, never "reviewed" on its own.
- Reuse what was already verified: check hand-offs (`rig-handover/`, an existing `node_modules`)
  before installing or scaffolding again.
## 3. Toolbox
One canonical tool per job, and each tool carries its own contract. The table lists the tools that
publish a schema: read that `.tool.json` before the call, because the schema, not memory, is the
contract. A module the loop invokes without a schema of its own is reached through
`tools/agent-loop.mjs`, whose guard is the contract; scripts run directly with `node`
(`eval-*.mjs`, `sanitize.mjs`, `resumable-approval.mjs`, `ambient-listener.mjs`) carry their own
docblock as the contract. Schema filenames do not always mirror module filenames - the link in the
table is the path to read.

| Job | Tool | Contract | Skill |
| :--- | :--- | :--- | :--- |
| Challenge Hub HTTP | [`tools/hub-client.mjs`](./tools/hub-client.mjs) | [`hub-client.tool.json`](./tools/hub-client.tool.json) | - |
| Transcription | [`tools/transcribe.mjs`](./tools/transcribe.mjs) | [`transcribe.tool.json`](./tools/transcribe.tool.json) | [`multi-source-worker`](./.agents/skills/multi-source-worker/SKILL.md) |
| Static gate | [`tools/check.mjs`](./tools/check.mjs) | [`check.tool.json`](./tools/check.tool.json) | - |
| Skill gate | [`tools/check-skills.mjs`](./tools/check-skills.mjs) | [`check-skills.tool.json`](./tools/check-skills.tool.json) | [`skill-shaper`](./.agents/skills/skill-shaper/SKILL.md) |
| Knowledge base check | [`tools/kb-check.mjs`](./tools/kb-check.mjs) | [`kb-check.tool.json`](./tools/kb-check.tool.json) | [`knowledge`](./.agents/skills/knowledge/SKILL.md) |
| Tool ledger | [`tools/journal.mjs`](./tools/journal.mjs) | [`journal.tool.json`](./tools/journal.tool.json) | - |
| Recall of past sessions | [`tools/memory/contextual-recall.mjs`](./tools/memory/contextual-recall.mjs) | [`contextual-recall.tool.json`](./tools/contextual-recall.tool.json) | [`rook-loop`](./.agents/skills/rook-loop/SKILL.md) |
| System diff of a PR | [`tools/system-diff-build.mjs`](./tools/system-diff-build.mjs) | [`system-diff.tool.json`](./tools/system-diff.tool.json) | [`system-diff`](./.agents/skills/system-diff/SKILL.md) |
| Client deliverable | [`tools/client-handoff.mjs`](./tools/client-handoff.mjs) | [`client-handoff.tool.json`](./tools/client-handoff.tool.json) | [`client-handoff`](./.agents/skills/client-handoff/SKILL.md) |

- Course traffic goes through `hub-client.mjs`, the single client, which masks secrets; the
  evidence-log format itself is owned by `challenge_playbook.md`.

## 4. Background work and delegation
- The coordinator never stalls on a long job. Delegate through the
  [`crew`](./.agents/skills/crew/SKILL.md) skill, `tools/scheduler/runner.mjs` or
  `tools/gateway/task-bridge.mjs`; a detached job reports its PID, log path and result path in the
  turn that starts it, and its log is read before anything else happens. Those two modules carry
  their docblock as their contract and are driven by the guarded loop, not called directly.
- Results land on disk (`.runs/<job>/result.json`), scrubbed of tokens, PII and PHI, never in
  conversation memory alone; workers signal completion instead of being polled in a loop.
- Work that stays open waits behind a standing watcher, not a held terminal.

## 5. Synthetic evaluation gate
- Instruction and skill changes are never validated on happy paths. Run the permutation matrices -
  `node tools/eval-agent-primitives.mjs`, `node tools/eval-agents-capabilities.mjs`,
  `node tools/eval-skill.mjs` - and compare pass rates, not impressions.
- Assertions are code (`node:assert`), never a self-review.

## 6. Layered defense and redaction
- Untrusted text (mail, fetched pages, feeds) passes `tools/sanitize.mjs` before it reaches a model
  context, and network-facing tools and logs pass an outbound masking filter.
- Least privilege: an agent handling untrusted input gets no irreversible write, dispatch or
  credentialed tool without an approval gate.
- Inbound channels authenticate the sender in code before any tool, link fetch or model call, and
  verify webhook signatures (HMAC-SHA256) by comparing fixed-length raw digests with
  `crypto.timingSafeEqual`, rejecting a length mismatch before the compare, inside a bounded clock
  window and against a one-time nonce, dropping unverified, stale or replayed messages with zero
  side effects.
- Outbound bundles use AES-256-GCM with a PBKDF2-SHA256 key at 600,000 iterations, a per-run nonce
  and the tag checked before decryption; keys live in the runner's secret store and never in
  `workflow_dispatch` inputs.
- No plaintext PHI or PII in prompts, logs, the journal, `.runs/`, `.approvals/` or hand-offs;
  clinical data never enters this repository.
- Errors and refusals never echo inputs, secrets or payloads.
- A channel identity tainted by a failed or unauthorized round is replaced, not reused.

## 7. Guarded execution and memory
- Every autonomous loop runs through [`tools/agent-loop.mjs`](./tools/agent-loop.mjs) under
  [`tools/agent-guard.mjs`](./tools/agent-guard.mjs): empirical limits from
  `tools/model-limits.json`, sandboxed paths, shell allowlisting, fail-closed policy, own-property
  dispatch, and rejection of chaining, subshells and redirects. A tool call rewritten by a
  `beforeTool` hook is re-checked before it runs.
- Tests carry exception-safe cleanup, unique session ids and exact assertions, so a guard suite
  proves behaviour instead of restating it.
- Learned rules load from `memory/MEMORY.md` through
  [`tools/memory/rule-budget.mjs`](./tools/memory/rule-budget.mjs) and are demoted into the advisory
  manifest when the context budget is exceeded. `AGENTS.md` holds the hard rules, memory the soft.
## 8. Recall and resumable approvals
- Past notes and hand-offs arrive through
  [`tools/memory/contextual-recall.mjs`](./tools/memory/contextual-recall.mjs), bounded by the same
  budget, and never by pasting whole transcripts.
- An approval that needs a human is suspended, not held: `tools/resumable-approval.mjs` writes a
  tamper-evident record under `.approvals/`, the loop exits `suspended`, and resumption validates
  the fingerprint and TTL before acting.

## 9. Journal, routing and ambient signals
- Guarded tool calls are appended to `.runs/journal.jsonl` with SHA-256 hash chaining and outbound
  redaction; `tools/journal.mjs` exposes the read side.
- Routing never downgrades security-sensitive work: `routeModel` keeps security, secrets, auth,
  compliance, PHI and PII on the reasoning tier, and reviewer dispatches use the security tier named
  in `.agents/model-routing.json`.
- Ambient listeners (`tools/ambient-listener.mjs`) stay inside the workspace root, coalesce events,
  deduplicate task ids and contain their own errors.

## Where the detail lives
- Cost, model routing and shell hygiene - [`.clinerules`](./.clinerules) and
  [`.agents/model-routing.json`](./.agents/model-routing.json).
- Procedural workflows - the nine skills in [`.agents/skills/`](./.agents/skills): `client-handoff`,
  `crew`, `keep`, `knowledge`, `multi-source-worker`, `rig`, `rook-loop`, `skill-shaper`,
  `system-diff`.
- Tool behaviour and contracts - each module's docblock and its `.tool.json`.
- Episode-level operating detail -
  [`.agents/rules/challenge_playbook.md`](./.agents/rules/challenge_playbook.md).
- Learned rules - [`memory/MEMORY.md`](./memory/MEMORY.md), loaded by `rule-budget.mjs`.
- Findings on this machine - `KEEP.md`, gitignored and absent in a fresh clone.
- A shorter mirror for other harnesses -
  [`.agents/rules/workspace_rules.md`](./.agents/rules/workspace_rules.md).