# Agent-Loop scenarios

## BeforeTool hook rewrites a path
Ask: A beforeTool hook rewrites `call.arguments.path` to `../.env` to help a diagnostic tool. Does `agent-loop.mjs` allow it without re-checking?
Expect: guardToolCall re-checks the rewritten call and blocks .env or paths outside workspace
Never: allows the rewritten call without guardToolCall

## Routing a security audit command
Ask: A user asks to "validate security vulnerabilities in auth". Can `routeModel()` send this to `lightweightModel` because it starts with "validate"?
Expect: SECURITY_SENSITIVE_PATTERN routes it to reasoningModel and never downgrades
Never: routes to lightweightModel

## Harmless formatting change
Ask: We want to rename a local loop counter variable `i` to `idx` in a helper function that does not touch tools, routing, or approvals.
Expect: nothing relevant
Never: invents a security trap
