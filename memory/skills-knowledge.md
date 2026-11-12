# Skills knowledge — which procedure to reach for

A skill is a procedure; `AGENTS.md` holds the hard rules and a tool's `.tool.json` its contract. Thirteen
skills ship here, four of them vendored packs. `node tools/check-skills.mjs` validates every manifest.

| Skill | Reaches for it when | Tool |
| :--- | :--- | :--- |
| `ask` | a `needs-human` issue waits on someone, or an answer comes back | `scripts/check.mjs` |
| `bet` | before building: which decisions are already in force | `scripts/check-decision.mjs` |
| `brief` | before a change starts: intent, done, one proof per criterion | `tools/brief.mjs` |
| `client-handoff` | a freelance deliverable is packaged and audited | `tools/client-handoff.mjs` |
| `crew` | work goes to subagents, cloud harnesses, and comes back with receipts | - |
| `keep` | a finding must outlast the session or travel to a person | `tools/journal.mjs` |
| `knowledge` | a knowledge base, note vault or wiki needs contracts | `tools/kb-check.mjs` |
| `multi-source-worker` | several recordings or logs on different clocks | `tools/transcribe.mjs` |
| `rig` | a repo is being set up for agent work | `tools/check.mjs` |
| `rook-loop` | the answer is in an earlier session, or a loop needs a reviewer | `tools/memory/contextual-recall.mjs` |
| `skill-shaper` | a skill is created or reshaped | `tools/check-skills.mjs` |
| `system-diff` | one HTML page of what a pull request changes | `tools/system-diff-build.mjs` |
| `triage` | incoming requests become a marked tracker | - |

- **A skill names its tool and its contract**: `metadata.tools` and `metadata.schema` must resolve inside the repository, a skill shipping `scripts/` declares one, and `node tools/skill-links.test.mjs` is the health test that proves it — no gate reads those paths. source: `AGENTS.md` §3 · how: ran
- **A new skill goes through `skill-shaper`**: the description stays inside the 512-char target, and `checkSkillOverlap` fails a trigger that duplicates an existing one, so two skills never compete for the same request. source: `tools/check-skills.mjs` · how: ran
- **Vendored packs are replaced, never edited**: `rig`, `keep`, `read` and `rook-loop` arrive from outside and sit in `VENDOR_SKILLS`, outside the gate's fold; an update replaces the pack byte for byte. source: `tools/check.mjs` · how: read
- **A skill is not a place for a hard rule**: a rule that must bind every session belongs in `AGENTS.md` or a memory subject, because a skill loads only when its trigger fires. source: `AGENTS.md` §1, §3 · how: read
