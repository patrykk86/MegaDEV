# Workspace Rules

See [`d:/MegaDEV/AGENTS.md`](../../AGENTS.md) for the canonical workspace operating rules:
1. **Autonomous Action Policy**: Proceed autonomously on internal project activities (reading, editing, local commands). Ask first only for host-wide changes outside project boundaries or paid model runs in `mega-examples`.
2. **Static Verification**: Run `node --run test` (`bin/check.cmd` / `npm.cmd test`) to verify secret hygiene, canonical tooling, `tsc --noEmit`, Biome lint, and handoff schemas.
3. **Node 25+ Tooling & Multi-Source Isolation**: Prefer fast native Node 25+ runtimes ([`tools/transcribe.mjs`](../../tools/transcribe.mjs), [`tools/hub-client.mjs`](../../tools/hub-client.mjs)) and enforce source isolation via [`multi-source-worker`](../skills/multi-source-worker/SKILL.md).
4. **Account & Tool Isolation**: Isolate challenge deliverables to `patrykk86`; never invoke `github-mcp-server` or touch `bl8er` repositories.
5. **Component Grounding**: Base all reported metrics and frontmatter on exported component views, keeping prose free of hardcoded numbers.
