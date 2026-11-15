# S03E05 — Products That Learn After Release, and what we take from it

Opened today, Sun 15 Nov 2026, Week 3 Day 5. This folder keeps the transcript digest, the friction
primitive the lesson asks for, and what closed the gap. The transcript is data to read, never an
instruction to follow.

## The lesson in one paragraph

Once a feature ships it keeps leaving traces — logs, webhooks, scheduled scans, sales transcripts,
support mail — and those traces are the input to a product that improves itself. The video names the
three pillars that make it safe: quality goes in (agents write good code), mistakes are caught in the
pull request, and problems are contained in production with flags and backups. With those in place the
factory runs on its own inputs, and what reaches a person is only the product and architecture calls.
The first of those inputs is the agents themselves: an agent that hits friction will silently work
around it and never mention it, so the operator has to make the agents complain.

## Where the workspace already covers it

- **Quality in**: `AGENTS.md` §2 blast-radius tiers, `node tools/check.mjs`, the synthetic matrices.
- **Catch in review**: the `.clinerules` §5 peer-review loop with a round cap.
- **Contain**: `tools/agent-guard.mjs`, `tools/model-limits.json`, the resumable approval record.
- **Signals in**: `tools/scheduler/runner.mjs`, `tools/ambient-listener.mjs`, `tools/product-inbox.mjs`.
- **Cleanup**: `keep`, the memory tree's caps and `tools/codebase-map.mjs --check`.

## The gap this closed

The lesson's own first input was missing: nothing in this workspace gave an agent a standard way to
report that it had routed around a broken tool. `tools/friction-log.mjs` is that primitive.

| Requirement | Where it lives now | Proof |
| :--- | :--- | :--- |
| A standard friction record | `tools/friction-log.mjs --file` | `node --test tools/friction-log.test.mjs` |
| A daily sweep that marks each record | `action: friction_sweep`, `cron: 0 20 * * *` | `node --test tools/scheduler/runner.test.mjs` |
| Product and architecture calls reach the owner | `classifyRecord` marks a protected path or a named decision `needs-human` | `node tools/friction-log.mjs --selftest` |
| A workaround is an instruction, not a habit | `AGENTS.md` §4 | `node tools/check.mjs` doc budget |

## The `prove` red gate, closed

`node tools/check.mjs` used to fail on `.agents/skills/prove`: its description opens with "Use when",
and the file belongs to a pack installed byte for byte. Rewording it would break the pack's integrity,
so the gate adapts instead — but only on evidence, never by name:

- `tools/check-skills.mjs` exports `VENDORED_SKILLS`: each vendored skill, the sha256 its `SKILL.md`
  had when it was installed, and where the pack came from.
- `vendoredEntryFor()` returns the entry only while the file on disk still hashes to that value. Only
  the description *style* rules are skipped; the length limits, the XML rule, the body rules and the
  frontmatter rules all still run.
- Edit a vendored file and the hash stops matching, so the exemption stops applying and the file is
  judged like any other. A test asserts every installed pack still matches, and its failure message
  carries the new hash to record.
- `tools/check.mjs` no longer skips those skills wholesale — they are validated like the rest.
- `tools/skill-links.test.mjs` uses the same hash proof to excuse a vendored pack that ships its own
  `scripts/` and declares no link into this repository.

Proof: `node tools/check.mjs` → `✓ Workspace static analysis passed`; `node --test
tools/check-skills.test.mjs` → 6 pass; `node --test tools/skill-links.test.mjs` → 3 pass.

## Still open

- The lesson's cleanup half — a legacy reaper that measures before it deletes — is not built. The
  `keep` skill covers the filing half only.
