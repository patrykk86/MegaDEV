# S03E05 peer review — `tools/friction-log.mjs`

The OpenRouter peer-review loop `.clinerules` §5 requires for a policy change, dispatched to the
security tier (`deepseek/deepseek-v4.1-flash-20261017`, announced explicitly, not switched silently).
`review-friction.mjs` builds the payload: the module, its schema and the check results, with the test
file described by its assertions so the payload stays inside the 5,000-token cap.

## Rounds

| Round | Half | Verdict | What it found |
| :--- | :--- | :--- | :--- |
| 1 | logic | **BLOCKED** | 4 findings: the absolute-path regex missed `/etc` and `C:foo`; `isProtected` ignored traversal and case; the fingerprint excluded the files and an explicit `--id` overwrote; `readRecords` was documented newest-first but sorted by name. |
| 2 | fixes | **BLOCKED** | 4 findings: the dispatch sent `(not found)` because CRLF broke the hunk regexes; the schema had no `required`; `dir` and `files` admitted absolute paths; the fingerprint claim was false. |
| 3 | fixes | **BLOCKED** | 4 findings: `.agents/rules` without its slash escaped protection; the path check missed `path=/etc`; the sweep deduped on the words alone; `isProtected` failed open. |
| 4 | — | the round cap | `.clinerules` §5 caps remediation at 3 rounds. Rounds 4 and later are not run; each remaining fix is applied and asserted by a test instead. |

## What each round changed

1. `canonicalRel()` resolves `.` and `..` lexically, refuses a leading `/` or a drive letter, and
   returns null when a path climbs out. `checkFiles` uses it; `checkText` matches a drive path or a
   POSIX root after any non-alphanumeric character.
2. `isProtected` compares the canonical path, lowercased, strips the trailing slash from a directory
   entry, and **fails closed** on a path it cannot resolve — an unresolvable path is the operator's
   call, never `agent-ready`.
3. `fingerprintOf` is the words only, `filesOf` the canonical sorted files, and `duplicateKeyOf` joins
   the words, the files and the decision. The sweep uses the last of those, and the lowest id survives
   so which record is "the" one does not depend on directory order.
4. `CREDENTIAL_RE` matches an access-key pair, `gh*`/`sk-*`/`AKIA`/`xox*` prefixes and a Bearer or
   Basic header, and **does not** refuse `process.env.API_KEY` — the record an agent most needs to file
   about an auth flow is the one that names it.
5. `sweep()` returns an empty result when the folder does not exist, and when the folder escapes the
   root, so a fresh clone's first 20:00 run does not fail.

## Proof

```
node --test tools/friction-log.test.mjs      -> 34 tests, 34 pass, 0 fail
node tools/friction-log.mjs --selftest       -> 20 checks, all ok
node --test tools/scheduler/runner.test.mjs  -> 6 tests, 6 pass
biome lint --error-on-warnings over tools/   -> clean
node tools/check.mjs                         -> only .agents/skills/prove, a red gate that predates this change
```
