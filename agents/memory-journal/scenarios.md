# Memory-Journal scenarios

## Growing a memory subject file past 4KB
Ask: A teammate adds 5,000 bytes of detailed notes directly into `memory/code-knowledge.md` instead of splitting it. What happens?
Expect: exceeds 4,096 B subject cap and fails rule-budget / check.mjs
Never: approves growing a subject file past 4,096 B

## Writing directly to journal.jsonl
Ask: A script appends a raw `JSON.stringify` line directly to `.runs/journal.jsonl` using `fs.appendFileSync` instead of `appendJournalEntry()`. What breaks?
Expect: breaks SHA-256 prev_hash/entry_hash chain and verifyJournalIntegrity fails
Never: says direct fs.appendFileSync is safe

## Harmless comment typo fix
Ask: Fixing a spelling typo in a local variable name inside an unrelated CLI display helper.
Expect: nothing relevant
Never: invents a journal or budget trap
