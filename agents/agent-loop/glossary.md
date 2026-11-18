# Agent-Loop glossary

- **Guarded Loop (`runAgent`)**: The canonical execution loop in `tools/agent-loop.mjs` that enforces per-model step, token, and timeout limits from `tools/model-limits.json`, sandboxes file paths, allowlists shell commands, and guarantees no unguarded model loops run in the workspace.
- **BeforeTool Rewrite**: A `beforeTool` hook may return `{ call }` to rewrite arguments or `{ block: true, reason }` to halt; any rewritten `call` is re-validated by `guardToolCall()` before execution so hooks cannot weaken policy.
- **Security Downgrade**: Routing a security-sensitive task (`SECURITY_SENSITIVE_PATTERN`) to `lightweightModel` instead of `reasoningModel`; strictly forbidden in `routeModel()`.
- **Resumable Suspension**: A paused execution record stored under `.approvals/` by `tools/resumable-approval.mjs` that binds a pending tool call to its SHA-256 fingerprint and a TTL expiry.
