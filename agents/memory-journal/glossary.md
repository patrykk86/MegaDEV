# Memory-Journal glossary

- **Hard Rule vs Soft Rule**: `AGENTS.md` and `memory/MEMORY.md` load as hard rules that are never demoted; linked `memory/*-knowledge.md` subject files load as soft rules and demote tail-first when the 24,000-token / 36,864-byte budget fills.
- **Journal Hash Chain**: Each line in `.runs/journal.jsonl` carries `prev_hash` and `entry_hash` (SHA-256 over canonical JSON) verified by `verifyJournalIntegrity()`.
- **Config Hash (`config_hash`)**: SHA-256 digest over `AGENTS.md`, `.clinerules`, `memory/MEMORY.md`, and `.agents/model-routing.json` recorded in journal entries.
- **Contextual Recall**: Bounded pre-injection of indexed workspace knowledge into `runAgent()` via `tools/memory/contextual-recall.mjs`.
