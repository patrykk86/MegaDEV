# AGENTS.md

## Core Agent Operating Rules

### 1. Project Boundaries & Entrypoints
- **MegaDEV** (`d:/MegaDEV`) and **BioCore-AI** are distinct projects with separate skills and dependencies. Never mix dependencies or configurations between them.
- When working inside [`mega-examples/`](./mega-examples/AGENTS.md), follow its top-of-file **Rules for coding agents**.

### 2. Autonomous Execution & Static Verification (Trust Pyramid)
- Proceed autonomously on all internal project work (reading, editing, running local tests/checks). Only ask the user before modifying host/system-wide settings or making paid external model calls in `mega-examples`.
- **Always verify changes via static analysis (`node --run test` or `npm.cmd test` at workspace root)** before finishing a task. `tools/check.mjs` runs secret hygiene scans, single-canonical-tool checks, multi-source handoff validation, `mex check`, `tsc --noEmit`, and Biome linting.

### 3. Canonical Toolbox & Protocols
- **Transcriber & Handoff CLI**: [`tools/transcribe.mjs`](./tools/transcribe.mjs) (`bin/transcribe.cmd`). Prefer fast native Node 25+ runtimes; do not create duplicate Python/ad-hoc segment parsers.
- **Challenge Hub Client**: [`tools/hub-client.mjs`](./tools/hub-client.mjs). Single canonical client (ES module + CLI) reading `MEGADEV_KEY` and `MEGADEV_TICKET` from `.env` and masking secrets in logs automatically.
- **Multi-Source Isolation Protocol**: When handling multiple recordings or clocks, follow [`multi-source-worker`](./.agents/skills/multi-source-worker/SKILL.md) and validate outputs with `node tools/transcribe.mjs --validate-handoff` and `--aggregate`.
