# AGENTS.md

## Core Agent Operating Rules

### 1. Project Boundaries & Entrypoints
- **MegaDEV** (`d:/MegaDEV`) and **BioCore-AI** are distinct projects with separate skills and dependencies. Never mix dependencies or configurations between them.
- When working inside [`mega-examples/`](./mega-examples/AGENTS.md), follow its top-of-file **Rules for coding agents**.
- **Challenge Account Isolation**: Never use the user's primary personal GitHub account (`bl8er`) or `github-mcp-server` for course challenge deliverables. Use the designated challenge identity (`patrykk86`) via authenticated browser DevTools or scoped credentials, and commit using `patrykk86 <patrykk86@users.noreply.github.com>`.

### 2. Autonomous Execution & Static Verification (Trust Pyramid)
- Proceed autonomously on all internal project work (reading, editing, running local tests/checks). Only ask the user before modifying host/system-wide settings or making paid external model calls in `mega-examples`.
- **Always verify changes via static analysis (`node --run test` or `npm.cmd test` at workspace root)** before finishing a task. `tools/check.mjs` runs secret hygiene scans, single-canonical-tool checks, multi-source handoff validation, `mex check`, `tsc --noEmit`, and Biome linting.

### 3. Canonical Toolbox & Protocols
- **Transcriber & Handoff CLI**: [`tools/transcribe.mjs`](./tools/transcribe.mjs) (`bin/transcribe.cmd`). Prefer fast native Node 25+ runtimes; do not create duplicate Python/ad-hoc segment parsers.
- **Challenge Hub Client**: [`tools/hub-client.mjs`](./tools/hub-client.mjs). Single canonical client (ES module + CLI) reading `MEGADEV_KEY` and `MEGADEV_TICKET` from `.env` and masking secrets in logs automatically.
- **Multi-Source Isolation Protocol**: When handling multiple recordings or clocks, follow [`multi-source-worker`](./.agents/skills/multi-source-worker/SKILL.md) and validate outputs with `node tools/transcribe.mjs --validate-handoff` and `--aggregate`.
- **Subagent Source Isolation**: For multi-stream media or multi-clock feeds, invoke dedicated subagents (`invoke_subagent`) per source to prevent LLM context blending across clocks.
- **Cross-Session Continuity**: When a challenge pauses for a new session (`resume-challenge`), write all intermediate findings to disk in structured hand-off files first. In the new session, work directly from the resumed record and persisted hand-offs without re-downloading or re-processing raw media.
- **Exported Domain Logic Grounding**: For knowledge systems and data exports (e.g. `support-kb`), ground counts and taxonomy in the exported runtime logic (`causes.ts`, components) rather than ad-hoc text heuristics. Keep prose free of hardcoded dynamic numbers.
- **Two-Phase Challenge Lifecycle**: When a challenge notes the desk continues working, treat `status: "progress"` as a cue to re-fetch the live challenge page for updates, close issues with accurate `--reason` flags (`completed` vs `not planned`), and resubmit.
