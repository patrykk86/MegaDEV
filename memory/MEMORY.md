# Project Memory & Learned Invariants

## Security & Peer Review Invariants
- **Iterative Security Re-Verification Loop (Mandatory)**: Never stop after a single `ask_openrouter` audit round and merely apply fixes locally. Whenever DeepSeek (`deepseek/deepseek-v4.1-flash-1017`) or another OpenRouter reviewer flags blocking issues (`FAIL`, `REJECT`, `CONDITIONAL PASS`), remediate the code, run local unit tests and `node tools/check.mjs`, and **re-call `ask_openrouter` with the updated verbatim code in a loop until the reviewer explicitly confirms `VERDICT: APPROVED / PASS`**.
- **Worker-Bridge Context**: When calling `ask_openrouter` from `MegaDEV`, always include the complete verbatim code (including helper functions) in the `prompt` payload and specify that the target is the pure Node.js 25 `MegaDEV` repository so the reviewer does not hallucinate missing helpers or apply unrelated Flutter/FastAPI framework checks.

