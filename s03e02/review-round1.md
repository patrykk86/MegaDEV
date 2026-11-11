# S03E02 · peer review of the skill-gate change

The change: `tools/check-skills.mjs` moved the description target from a literal 300 to
`DESC_TARGET = 512`, so the `ask` skill the course hands out stays byte-exact, plus one test.

Reviewer: `deepseek/deepseek-v4.1-flash-20261017` (the security tier of `.agents/model-routing.json`),
dispatched by `s03e02/review-gate.mjs`, payload 4.1–3.7k prompt tokens, well under the 5,000 cap.

## Round 1 — BLOCKED, two findings

Verbatim, as it arrived (the answer was cut by its own token budget after finding 2):

> BLOCKED
> 1. tools/check-skills.test.mjs, `test('a description from an outside pack fits, one past the target
> does not', ...)`: the test hardcodes `512` in the assertion `/513 chars > 512 target limit/`, so it
> does not prove the message tracks `DESC_TARGET`; if the constant changes, the test fails for the
> wrong reason or passes only by coincidence. Smallest fix: import/export `DESC_TARGET` or assert
> against a computed boundary, e.g. build the over-limit string from the constant and match
> `${tooLong.length} chars > ${DESC_TARGET} target limit`.
> 2. tools/check-skills.mjs, `checkDescription`: the 1024 hard cap remains a bare literal while the
> comment says "the 1024 hard cap above stays as the portability limit"; the cap is below the comment,
> not above, and the two limits are now split between a named constant and a magic number. Smallest

## Remediation, both findings

- `DESC_MAX = 1024` names the portability cap; both checks and both messages use their own constant;
  the comment sits with the two constants and says which is which.
- Both constants are exported, the test imports them, builds a description of exactly `DESC_TARGET`,
  `DESC_TARGET + 1` and `DESC_MAX + 1` characters, and matches the message built from them.
- `node --test tools/check-skills.test.mjs`: 4 tests, 4 pass.

## Round 2 — no verdict

Six dispatches after round 1 returned **no text at all**: the model spent every completion token on
reasoning (1600 → 1602 reasoning tokens, 4000 → 4000, 2600 → 2604, 1400 → 1402, 900 → 900). One 400
came back for `reasoning.effort` plus `reasoning.max_tokens` sent together. Total spend across all
dispatches: about 0.016 USD.

So the peer-review loop stopped at its own rule: the tier cannot confirm the fix, and further
dispatches would be spending without a result. The two round-1 findings are fixed and gated locally;
no confirming APPROVED verdict exists.

## Decision — accepted by the operator, 2026-11-10

Asked to choose between accepting round 1, one more trimmed dispatch, or a different reviewer tier,
the operator answered `accept`: round 1 is the review. Both blocking findings are closed with code and
tests, and the gates below were run after the remediation:

- `node --test tools/check-skills.test.mjs` — 4 tests, 4 pass, 0 fail.
- `node tools/check.mjs` — no finding for any `.agents/skills` path, no stale codebase map.
- `node tools/eval-agent-primitives.mjs` — 10/10.
- `node tools/eval-agents-capabilities.mjs` — 37/37, 9 tool-skill links across 11 schemas.
- `node tools/eval-skill.mjs --check-skills` — 10 cases, pass@1 100%, pass^3 100%.

Accepted state: the description target is 512 with `DESC_MAX = 1024` as the portability cap, the test
follows both constants, and the installed `ask` skill is unchanged at version `3c51fd6aad28`. The
residual risk the operator accepted: findings the round-1 answer never printed were never reviewed.

