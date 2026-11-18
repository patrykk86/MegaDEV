# Agent-Loop memories

## Internal engineering
- A tool call rewritten by a `beforeTool` hook must be re-checked by `guardToolCall()` before execution, or a hook can bypass path sandboxing, secret-file blocking, or shell allowlisting. [commit 8c64208]
- `routeModel()` must route any input matching `SECURITY_SENSITIVE_PATTERN` to `reasoningModel` and never downgrade it to `lightweightModel`, even if the prompt looks like a simple validation command. [commit 8c64208]
- Tool dispatch in `tools/agent-loop.mjs` must use `Object.hasOwn(ctx.tools, name)` so prototype properties (`toString`, `constructor`) cannot be invoked as tools. [commit 9ab9076]
- `tools/resumable-approval.mjs` suspensions must verify both the tool-call SHA-256 fingerprint and TTL expiration on resume; skipping either allows replaying stale or altered approvals. [commit 9ab9076]
- Every model API call outside the canonical modules (`agent-loop.mjs`, `model-limits.mjs`, `agent-guard.mjs`) must read `max_tokens` and `timeoutMs` from `tools/model-limits.json` and avoid unbounded loops (`AG1`-`AG4`). [commit c3e9253]

## Customer facing
- Sensitive operations that require human sign-off suspend cleanly with an approval ID under `.approvals/` rather than hanging or auto-approving. [commit 9ab9076]
- Untrusted external input is sanitized through `tools/sanitize.mjs` and outbound logs/results are redacted before leaving the loop. [commit 5e35c68]
