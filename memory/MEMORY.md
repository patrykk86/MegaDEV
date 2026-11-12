# Memory index

Memory is a tree. This file routes; the subject files hold the rules. It loads as a **hard** rule and is
never demoted, so a question always has somewhere to go. Each file linked below loads as its own soft
rule, in the order listed — the tail is demoted first when the budget fills
(`tools/memory/rule-budget.mjs`: 24,000 tokens / 36,864 bytes shared with `AGENTS.md`).

Caps: this file 3,072 B, one subject 4,096 B. A subject that outgrows its cap is split, never grown.

## Where to look

| Question | File | Holds |
| :--- | :--- | :--- |
| How do I run and stop things? | [session-knowledge.md](session-knowledge.md) | shell hygiene, dispatch lifetime, retry escalation |
| How do I prove this change? | [verification-knowledge.md](verification-knowledge.md) | tiers, gates, eval matrices, review loop, evidence |
| How is code written here? | [code-knowledge.md](code-knowledge.md) | Node 25 ESM, docblocks, tests, path rules |
| What must never leave? | [security-knowledge.md](security-knowledge.md) | secrets, browser sessions, approvals, redaction |
| How do the primitives fit? | [architecture-knowledge.md](architecture-knowledge.md) | guard, loop, journal, memory tree, scheduler, gateway |
| Which skill does what? | [skills-knowledge.md](skills-knowledge.md) | catalog, triggers, tool-contract rule |
| How do I reach the outside world? | [api-knowledge.md](api-knowledge.md) | hub-client, MCP transports, deploy paths |
| Why is the product shaped this way? | [product-knowledge.md](product-knowledge.md) | outcomes, briefs, triage, owner questions |
| How does a course round work? | [course-knowledge.md](course-knowledge.md) | records, claims, episode notes |

## A rule line

`- **Claim**: mechanism - because reason. source: <file or event> · how: read|ran|told`

Rules are earned, not invented: a line is written after it changed a decision, and its `source:` names
the file that proves it. Before adding one, measure the block; over budget, tighten prose before adding
bytes. Episode detail stays in `s0Xe0Y/LESSON-NOTES.md` — only the rule that generalises moves here.
