# AGENTS.md

## Core Agent Operating Rules

### 1. Project Boundaries & Entrypoints
- **MegaDEV** (`d:/MegaDEV`) and **BioCore-AI** (`D:/Projekt Hajs/biocore_ai`) are distinct projects with separate dependencies. Skills located in `D:/Projekt Hajs/.agents/skills` (such as `code-review`, `openrouter-luna`, `jevgrep`, `changelog`) may be referenced and leveraged for MegaDEV tasks when useful, while keeping dependencies and environment configurations isolated.
- When working inside [`mega-examples/`](./mega-examples/AGENTS.md), follow its top-of-file **Rules for coding agents**. Never run `npx mex` from the workspace root; run `npm --prefix mega-examples start -- <name>` or `cd mega-examples`.
- **Challenge Account Isolation**: Never use the user's primary personal GitHub account (`bl8er`) or `github-mcp-server` for course challenge deliverables. Use the designated challenge identity (`patrykk86`) via authenticated browser DevTools or scoped credentials, and commit using `patrykk86 <patrykk86@users.noreply.github.com>`.
- **Challenge GitHub Token Scoping**: When challenges spawn dedicated repositories from course templates, ensure credentials carry repository-wide issue and push permissions (`repo` scope), avoiding single-repo-scoped fine-grained token 403 blocks.

### 2. Autonomous Execution & Static Verification (Trust Pyramid)
- Proceed autonomously on all internal project work (reading, editing, running local tests/checks). Only ask the user before modifying host/system-wide settings or making paid external model calls in `mega-examples`.
- **Always verify changes via static analysis (`node --run test` or `npm.cmd test` at workspace root)** before finishing a task. `tools/check.mjs` runs secret hygiene scans, single-canonical-tool checks, multi-source handoff validation, `mex check`, `tsc --noEmit`, and Biome linting.
- **Check Existing Handoff Assets First**: Before running package installs or rebuilding project scaffolding, inspect previous episode handoffs (e.g., `rig-handover/`) or local build trees to reuse verified node_modules and configurations.

### 3. Canonical Toolbox & Protocols
- **Transcriber & Handoff CLI**: [`tools/transcribe.mjs`](./tools/transcribe.mjs) (`bin/transcribe.cmd`). Prefer fast native Node 25+ runtimes; do not create duplicate Python/ad-hoc segment parsers.
- **Challenge Hub Client**: [`tools/hub-client.mjs`](./tools/hub-client.mjs). Single canonical client (ES module + CLI) reading `MEGADEV_KEY` and `MEGADEV_TICKET` from `.env` and masking secrets in logs automatically.
- **Multi-Source Isolation Protocol**: When handling multiple recordings or clocks, follow [`multi-source-worker`](./.agents/skills/multi-source-worker/SKILL.md) and validate outputs with `node tools/transcribe.mjs --validate-handoff` and `--aggregate`.
- **Subagent Source Isolation**: For multi-stream media or multi-clock feeds, invoke dedicated subagents (`invoke_subagent`) per source to prevent LLM context blending across clocks.
- **Cross-Session Continuity**: When a challenge pauses for a new session (`resume-challenge`), write all intermediate findings to disk in structured hand-off files first. In the new session, work directly from the resumed record and persisted hand-offs without re-downloading or re-processing raw media.
- **Exported Domain Logic Grounding**: For knowledge systems and data exports (e.g. `support-kb`), ground counts and taxonomy in the exported runtime logic (`causes.ts`, components) rather than ad-hoc text heuristics. Keep prose free of hardcoded dynamic numbers.
- **Two-Phase Challenge Lifecycle & Reviewer Gating**: When a challenge notes the desk or reviewer continues working (`status: "progress"` or `"retry"`), treat it as an active wait. Never close review/preview issues upon sending links; issues waiting on external inspection must remain OPEN until the reviewer acknowledges inspection. Clean-up tasks must remain blocked by the review gate.
- **Zero-Dependency Public Previews**: For deliverables requiring temporary public HTTPS previews, deploy standalone HTML to an orphan `gh-pages` branch on the challenge repo (`https://<user>.github.io/<repo>/`), avoiding external hosting dependencies.
- **Persistent Hosts for Inbound Webhooks**: Reviewer ping and webhook endpoints require always-on cloud hosts (e.g., Firebase Cloud Functions, Cloudflare Workers, VPS). Ephemeral local tunnels (`trycloudflare.com`, ngrok) are rejected by course inspection gates.
- **Contract-First Payloads**: Never guess endpoint payload shapes. Locate formal contracts via machine-readable link headers (`rel="service-desc"`, `rel="describedby"`), `schema.json`, or OpenAPI before submitting data.
- **Masked Evidence Logging**: Maintain an append-only `s01eXX/requests.log` for every challenge interaction, recording timestamps, requests, and responses with secrets masked via `tools/hub-client.mjs` to preserve evidence against conversation compaction.
- **Live Grounding for Mutable Entities**: Always verify fast-moving identifiers (models, API versions, prices) against official live documentation rather than relying on parametric memory.
- **Live Re-Check for Asynchronous Source Feeds**: Never finalize plans, check-ins, or build deliverables solely based on an initial handoff snapshot. Upstream teams, CI runners, and challenge feeds push late asynchronous revisions (e.g. host ports, image versions, database names) during active migration runs. Always re-poll live source archive URLs, feeds, or remote endpoints before submitting deliverables and before declaring task completion, ensuring late-breaking decisions override stale handoffs.

### 4. Background Workers & Asynchronous Delegation Protocol
- **Non-Blocking Coordination**: The primary agent acts as coordinator and must never stall user interaction while waiting for long-running jobs. Delegate intensive processing (audits, digest collation, batch transforms) to asynchronous background workers or subagents via `invoke_subagent` or `schedule`.
- **Living Standby Watchers**: When a challenge notes the reviewer continues working (`status: "progress"` or `"retry"` with `retryAfter`), keep an active background watcher or timer alive to monitor the verdict autonomously and alert the coordinator without prompting the user.
- **Persisted Job Handoffs**: Workers must communicate intermediate steps and final outcomes through structured disk-backed handoff records (`.runs/<job-id>/result.json` or append-only task logs) rather than relying on conversational memory.
- **Signal-Driven Wakeup**: Background workers notify the coordinator on completion; avoid busy-polling loops.

### 5. Synthetic Evaluation Gate for Skills & Instructions
- **Matrix-Driven Verification**: Never validate edits to agent instructions (`AGENTS.md`) or skills (`SKILL.md`) solely on hand-picked happy paths. Always generate and run a synthetic permutation matrix crossing user intent variants, edge cases, and constraint violations.
- **Policy-as-Code Assertion**: Ground evaluations in deterministic code-level assertions rather than subjective LLM self-reviews. Compare versioned pass rates and diffs before landing skill updates.

### 6. Layered Defense & Outbound Redaction Protocol
- **Deterministic Input Sanitization**: Clean all untrusted external content (emails, web fetches, challenge feeds) through a deterministic pre-processor that strips hidden elements (`display:none`), normalizes unicode lookalikes, decodes base64/hex payloads, and filters common injection patterns before passing text to model contexts.
- **Outbound Redaction Gate**: All network-facing tools and logging pipelines must run through an automated masking filter (as in `tools/hub-client.mjs`) to scrub tokens, keys, credentials, and sensitive internal paths before transmission.
- **Least-Privilege Tool Scoping**: Do not grant irreversible write, network dispatch, or credentialed tools to agents processing untrusted external inputs without an explicit user approval gate.
- **Read/Write Agent Separation & Webhook Verification**: In autonomous host deployments, separate rights strictly between reading (e.g. answer-only) and writing (e.g. test or mutation) agents in rights manifests. Always cryptographically verify incoming webhook signatures (HMAC-SHA256) before executing actions.

### 7. Guarded Agent Execution & Lamarckian Memory Evolution
- **Guarded Agent Loop**: Every autonomous loop runs via [`tools/agent-loop.mjs`](./tools/agent-loop.mjs), enforcing empirical model limits (`tools/model-limits.json`), sandboxed path checks, shell allowlisting, and error containment. Any tool call modified or rewritten by a `beforeTool` hook must be strictly re-evaluated against the security guard policy before invocation.
- **Fail-Closed & Prototype-Safe Dispatch**: Tool dispatch must strictly verify own-properties (`Object.hasOwn`), rejecting prototype pollution attempts (`__proto__`, `constructor`, `toString`). Security policy defaults must fail-closed (default-deny on empty/missing policies).
- **Adversarial Command & Secret Boundaries**: Shell checking must reject all command chaining, subshells, and execution modifiers (`;`, `&&`, `||`, `&`, `$()`, backticks, redirects). Secret filtering must comprehensively cover `.env*`, `.ssh/id_rsa`, `*.pem`, `*.key`, `.npmrc`, credentials manifests, and out-of-root traversals.
- **Deterministic Test Hygiene & Precision Assertions**: Guard test suites must enforce exception-safe cleanup (`t.after()`), collision-free session identifiers (`crypto.randomUUID()`), exact rule set assertions (`assert.deepEqual`), and ID-based tool call message correlation (`tool_call_id`) with derived arithmetic constants.
- **Lamarckian Inter-Session Evolution**: At the conclusion of successful agent sessions (`end === 'answer'`), Lamarck (`lamarck --project <workspaceRoot>`) triggers asynchronously via `triggerLamarckAfterRun`. It enforces re-entrancy prevention (`LAMARCK_ACTIVE`), traps spawn errors (`child.on('error')`), and routes LLM reflection calls through the local worker-bridge via `bin/claude.cmd` (`CLAUDE_BIN`). On Windows, it spawns Node directly against the entry point to avoid `.cmd` shell invocation risks.
- **Context Budget Priority**: Dynamic project learnings in `memory/MEMORY.md` are loaded as soft rules via [`tools/memory/rule-budget.mjs`](./tools/memory/rule-budget.mjs). If the active context exceeds 20,000 tokens / 24KB, soft rules are demoted into the advisory manifest, preserving invariant hard rules in `AGENTS.md`.

### 8. Contextual Recall Pipeline & Resumable Tool Approvals
- **Contextual Recall Pipeline**: Retrieve past session notes, handoffs, and domain facts dynamically using hybrid sparse vector similarity and knowledge graph tag/link boosting ([`tools/memory/contextual-recall.mjs`](./tools/memory/contextual-recall.mjs)). Queries are grounded in active user conversation turns and pre-injected into the agent loop before model invocation, strictly bounded by the token and byte budget in [`tools/memory/rule-budget.mjs`](./tools/memory/rule-budget.mjs) without context window bloat.
- **Durable Resumable Approvals**: Tool approvals requiring human authorization across sessions or days must not hold blocking interactive prompts or long-running process threads. The guarded agent loop serializes execution state and tool call metadata into a durable, HMAC-SHA256 tamper-proof suspension record (`.approvals/<approval-id>.json` via [           `tools/resumable-approval.mjs`](./tools/resumable-approval.mjs)), cleanly exiting with `{ end: 'suspended' }`. Resumption via `resumeAgent` restores state, validates tamper-proof fingerprints and TTL expiration, executes or rejects the pending tool call with recorded user feedback, and completes the loop autonomously.


