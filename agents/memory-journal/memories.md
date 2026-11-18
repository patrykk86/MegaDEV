# Memory-Journal memories

## Internal engineering
- `memory/MEMORY.md` is a hard index (3,072 B cap) and each subject file is a soft rule (4,096 B cap) sharing a 24,000-token / 36,864 B budget with `AGENTS.md`; exceeding caps or unlinking a subject breaks `tools/check.mjs`. [commit 1ce6ea3]
- `appendJournalEntry()` in `tools/journal.mjs` maintains a SHA-256 `prev_hash` -> `entry_hash` chain and applies `redactOutbound()` before writing to `.runs/journal.jsonl`; bypassing it breaks `verifyJournalIntegrity()`. [commit f85eb1b]
- `tools/journal.mjs` records `config_hash` (`computeConfigHash()`) on guarded loop and scheduler runs so every run is traceable to the exact rule/routing configuration that executed it. [commit c3e9253]
- `tools/memory/contextual-recall.mjs` injects bounded memory snippets into `runAgent()` via `initContextualRecall()`; never paste raw conversation transcripts into `memory/` files. [commit 5e35c68]

## Customer facing
- Audit trails in `.runs/journal.jsonl` are tamper-evident and automatically redact secrets before persistence. [commit f85eb1b]
