# Telegram Gateway & Remote Operations Hub

The **Telegram Gateway** provides a secure, bidirectional mobile interface connecting authorized operators to the autonomous development and agent environment. It enables worldwide monitoring, natural-language system interaction, remote task delegation, and interactive authorization gates directly from a mobile device without exposing internal infrastructure to the public internet.

---

## High-Level Architecture

The gateway operates on an asynchronous, event-driven model that bridges mobile messaging with the local agent execution runtime.

```
┌────────────────────────────────┐
│   Authorized Mobile Operator   │
│   (Encrypted Telegram Client)  │
└───────────────┬────────────────┘
                │ TLS API
                ▼
┌────────────────────────────────┐
│       Gateway Boundary         │
│  - Fail-Closed User Whitelist  │
│  - Inbound Input Sanitization  │
│  - Outbound Secret Redaction   │
└───────────────┬────────────────┘
                │
        ┌───────┴───────┐
        ▼               ▼
┌──────────────┐ ┌──────────────┐
│  Query & RAG │ │  Task Bridge │
│  Interface   │ │  & Approvals │
└───────┬──────┘ └──────┬───────┘
        │               │
        ▼               ▼
┌────────────────────────────────┐
│      Core Agent Runtime        │
│  (Isolated Execution Engine)   │
└────────────────────────────────┘
```

---

## Key Capabilities

### 1. Context-Aware Mobile Assistant
- **Codebase & Architecture Grounding**: Operators can ask high-level questions about the workspace, architecture, or backend services. The assistant grounds its responses using semantic retrieval across documentation and active session records.
- **Strict Boundary Delimitation**: User input and retrieved context are sandboxed to ensure that reference data cannot hijack or redirect agent instructions.

### 2. Two-Way Task Delegation
- **Asynchronous Task Queueing**: Operators can assign coding, refactoring, or testing tasks remotely. Tasks are queued in a durable ledger on the host.
- **Desktop Agent Execution**: The primary agent picks up enqueued tasks, applies modifications, executes local verification suites, and produces comprehensive review digests.
- **Outbound Review Push**: When a task completes, a summary of modified files, test verdicts, and code review findings is pushed back to the mobile channel.

### 3. Remote Tool Approvals
- **Human-in-the-Loop Governance**: High-stakes or destructive operations (e.g., database modifications, key operations) trigger durable suspensions.
- **Remote Decision Resolution**: Operators receive alert notifications with approval IDs and can authorize or deny pending executions from anywhere.

### 4. Continuous Health & Telemetry
- **Daily Digests & Audits**: Outbound summaries of repository hygiene, nightly automated audits, and cross-model reflections are dispatched automatically.
- **Backend Service Probing**: Real-time health checks verify whether local APIs and worker processes are active.

---

## Command Reference

| Command | Description | Access Level |
| :--- | :--- | :--- |
| `/prompt <text>` | Submit questions or instructions to the grounded AI assistant. | Authorized Users |
| `/task <instruction>` | Queue a coding or testing task for desktop agent execution. | Privileged Operator |
| `/tasks` | View the list of queued and recently completed tasks. | Authorized Users |
| `/approve <id>` | Remotely approve a pending tool execution suspension. | Privileged Operator |
| `/reject <id>` | Remotely deny a pending tool execution suspension. | Privileged Operator |
| `/lookup <topic>` | Perform semantic search across workspace documentation. | Authorized Users |
| `/biocore` | Check FastAPI backend health and API availability. | Authorized Users |
| `/journal` | Inspect recent actions and cross-model self-reflections. | Authorized Users |
| `/status` | View git repository hygiene, active branches, and gateway status. | Authorized Users |
| `/run <audit\|hygiene>` | Trigger an on-demand system audit or hygiene verification. | Privileged Operator |
| `/help` | Display the list of available commands and syntax. | Authorized Users |

---

## Security & Defense Model

The gateway implements a multi-layered defense model designed to protect the host environment:

1. **Fail-Closed Authentication**:
   - Access is restricted to explicitly configured numeric user IDs.
   - Any message from unlisted users or unauthorized channels is immediately dropped without disclosing internal state or executing actions.
   - Sensitive commands (`/task`, `/approve`, `/reject`, `/run`) require individual operator validation even when invoked in a group setting.

2. **Inbound Input Neutralization**:
   - Inbound text is sanitized to strip malicious control characters and prompt-injection patterns before entering the model context.
   - Input lengths are strictly capped to prevent token exhaustion attacks.

3. **Outbound Secret Scrubbing**:
   - All outgoing messages pass through an automated redaction filter.
   - API tokens, passwords, private keys, environment file contents, and internal absolute system paths are masked prior to transmission over external networks.

4. **Replay & State Protection**:
   - Update markers are persisted to prevent duplicate processing or replay attacks upon service restart.
   - Approval IDs enforce strict alphanumeric formatting and single-use resolution.

5. **Local Network Isolation**:
   - The gateway polls securely over standard outbound HTTPS without requiring open inbound ports, port forwarding, or public domain DNS routing.

---

## Operational Status & Monitoring

- **Service Heartbeat**: The gateway continuously writes health and polling timestamps to `.runs/gateway-heartbeat.json`.
- **Audit Trails**: Task lifecycle transitions and approval decisions are logged in an append-only ledger in `.runs/`.
- **Automatic Recovery**: Network timeouts or temporary connection interruptions trigger exponential backoff and automatic reconnects without interrupting host services.

