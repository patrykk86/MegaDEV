# MegaDEV — Autonomous Multi-Agent Engineering Architecture

> **A deterministic, guarded multi-agent development environment featuring policy-as-code guardrails, empirical model limits, cryptographic audit chains, and seamless cross-platform orchestration.**

---

## 1. System Overview & Architecture

**MegaDEV** (`d:/MegaDEV`) is an autonomous agent workspace built to eliminate common failure modes in LLM-assisted software development—such as prompt drift, hallucinated commands, unbounded retry loops, token exhaustion, and silent security leaks.

The workspace operates in tandem with **BioCore-AI** (`D:/Projekt Hajs/biocore_ai`), maintaining a strict boundary between project dependencies while sharing skills, model bridges, and gateway services.

```
                    ┌────────────────────────────────────────────────────────┐
                    │               Mobile Telegram Gateway                  │
                    │       (/task, /status, /approve, /reject)              │
                    └──────────────────────────┬─────────────────────────────┘
                                               │ (Scrubbed & Sanitized)
                                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   MegaDEV Coordinator                                     │
│                         (AGENTS.md Guarded Agent Loop & Trust Pyramid)                     │
└──────────────┬───────────────────────────────┬──────────────────────────────┬──────────────┘
               │                               │                              │
               ▼                               ▼                              ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐ ┌───────────────────────────┐
│     Worker Bridge & MCP      │ │     Guarded Execution        │ │     Memory & Approvals    │
│  • DeepSeek v4.1 (Coding)    │ │  • tools/agent-guard.mjs     │ │  • Hybrid Context Recall  │
│  • GPT-6 Luna (Architecture) │ │  • tools/agent-loop.mjs      │ │  • Tamper-proof HMAC      │
│  • Claude 5.5 / Gemini Argon │ │  • tools/model-limits.json   │ │    Suspensions            │
│  • Automatic Quota Failover  │ │  • Outbound Secret Redaction │ │  • Rule Token Budgeting   │
└──────────────────────────────┘ └──────────────────────────────┘ └───────────────────────────┘
               │                               │                              │
               ▼                               ▼                              ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐ ┌───────────────────────────┐
│       BioCore Backend        │ │     Verification Suite       │ │    Append-Only Journal    │
│  • FastAPI (Port 8000)       │ │  • npm test (Static analysis)│ │  • SHA-256 Hash Chain     │
│  • Pydantic v2 UTC Parity    │ │  • Biome / TypeScript / mex  │ │  • Immutable Task Log     │
└──────────────────────────────┘ └──────────────────────────────┘ └───────────────────────────┘
```

---

## 2. The 8 Invariant Guardrail Layers (`AGENTS.md`)

All agents and subagents operating inside this workspace are governed by the non-negotiable rules outlined in `AGENTS.md`.

### Layer 1: Project Boundaries & Identity Scoping
* **Workspace Isolation**: MegaDEV and BioCore-AI run separate dependency environments. Shared capabilities (e.g. code review, OpenRouter bridge) are consumed via scoped interfaces without cross-polluting package trees.
* **Account Segregation**: Challenge and external deliverables use isolated identity profiles (`patrykk86`) rather than personal credentials, with repository-wide scoped tokens to prevent fine-grained 403 authorization halts.

### Layer 2: Autonomous Execution & Static Verification (The Trust Pyramid)
* **Autonomous Internal Action**: Agents operate independently on reading, writing, refactoring, and local test execution. Human intervention is reserved strictly for host-wide changes or paid external model runs in demo harnesses.
* **Deterministic Verification Gate**: Every task must pass static analysis before completion:
  ```bash
  npm test
  ```
  This command executes `tools/check.mjs`, running secret hygiene scans, canonical CLI checks, multi-source stream isolation validation, TypeScript (`tsc --noEmit`), and Biome linting.

### Layer 3: Canonical Protocols & Single-Tool Discipline
* **Zero Duplication**: Ad-hoc scripts are banned in favor of single canonical tools:
  * Audio/Video Transcription: `tools/transcribe.mjs`
  * Hub Communication: `tools/hub-client.mjs` (automatic token masking)
* **Contract-First Payloads**: Never guess request schemas. Agents locate and conform to OpenAPI/JSON schema contracts before dispatching network payloads.
* **Multi-Source Isolation Protocol**: When handling multi-channel recordings or feeds with different clocks, dedicated subagents process each feed independently to eliminate context blending.

### Layer 4: Background Workers & Non-Blocking Delegation
* **Non-Blocking Coordinator**: The primary agent coordinates without blocking interaction on long-running jobs (transcription, batch transforms, deep audits).
* **Living Standby Watchers**: When upstream services return retry or progress states (`status: "progress"` or `status: "retry"` with `retryAfter`), agents spawn persistent background watchers or scheduled tasks rather than busy-polling loops.
* **Disk-Backed Handoffs**: Subagent results are persisted to structured disk records in `.runs/` rather than depending on conversational context memory.

### Layer 5: Synthetic Evaluation Matrix Gate
* **Matrix-Driven Verification**: Updates to agent instructions (`AGENTS.md`) or skills (`SKILL.md`) are never evaluated on hand-picked happy paths.
* **Cartesian Permutation Testing**: The system runs automated Cartesian permutation matrices across user intents, boundary edge cases, and injection attempts, requiring 100% deterministic assertion pass rates before landing changes.

### Layer 6: Layered Defense & Outbound Redaction Protocol
* **Deterministic Input Sanitization (`tools/sanitize.mjs`)**: Untrusted external inputs (prompts, web scrapes, emails) pass through a pre-processor that strips invisible tags (`display:none`), normalizes unicode homoglyphs, decodes embedded base64/hex payloads, and neutralizes prompt injection attempts.
* **Outbound Secret Scrubbing**: All logging, Telegram messages, and network payloads are filtered through regex masks scrubbing API keys, tokens, UUIDs, and sensitive system paths.
* **Least Privilege**: Destructive write tools and unsandboxed commands require explicit policy authorization.

### Layer 7: Guarded Agent Loop & Lamarckian Evolution
* **Canonical Runner (`tools/agent-loop.mjs`)**: Every agent loop executes through `runAgent()`, enforcing:
  * **AG1**: No unbounded loops (`while(true)`).
  * **AG2**: Mandatory output token ceiling (`max_tokens`).
  * **AG3**: Mandatory timeout via `AbortSignal`.
  * **AG4**: Empirical limit grounding via `tools/model-limits.json`.
* **Stop Hook Enforcement (`tools/agent-guard.mjs`)**: If an agent attempts to stop while rule violations remain, the Stop Hook halts termination and commands a retry (capped at `STOP_RETRY_CAP = 2`).
* **Lamarckian Memory Evolution**: Successful runs trigger asynchronous reflection (`triggerLamarckAfterRun`) routing through `tools/claude-bridge.py` to update persistent memory.

### Layer 8: Contextual Recall & Durable Resumable Approvals
* **Hybrid Contextual Recall (`tools/memory/contextual-recall.mjs`)**: Session handoffs and documentation are dynamically indexed and recalled using BM25-style sparse vector matching combined with markdown link/tag graph boosting.
* **Token Budget Priority (`tools/memory/rule-budget.mjs`)**: Soft rules in memory are constrained to 20,000 tokens / 24KB. If exceeded, soft rules are demoted into an advisory manifest, preserving invariant hard rules in `AGENTS.md`.
* **Durable Resumable Approvals (`tools/resumable-approval.mjs`)**: High-risk tool calls are serialized into HMAC-SHA256 signed suspension files (`.approvals/`), allowing safe multi-day pause and resume via Telegram or CLI without keeping live processes in memory.

---

## 3. Multi-Model Cooperation & Routing

MegaDEV employs specialized models routed via the local **Worker Bridge** MCP server (`worker_bridge.py`):

| Model Alias | Canonical Identifier | Specialization / Role |
| :--- | :--- | :--- |
| **DeepSeek Flash** | `deepseek/deepseek-v4.1-flash-1017` | High-speed coding, static checks, GDPR & encryption security audits |
| **GPT-6 Luna** | `openai/gpt-6-luna` | Python & FastAPI architecture, Pydantic v2 schemas, DTO parity |
| **Claude Haiku** | `anthropic/claude-5.5-haiku` | Digest synthesis, markdown formatting, fast classification |
| **Gemini Argon** | `google/gemini-4-argon` | Deep architectural reasoning, high-stakes refactoring, quota failover |

### Quota Failover Chain
When OpenRouter returns HTTP `429` (Rate Limit) or `402` (Payment Required), the bridge automatically preserves the system prompt and transitions along the fallback chain:
$$\text{DeepSeek Flash} \longrightarrow \text{GPT-6 Luna} \longrightarrow \text{Claude Haiku} \longrightarrow \text{Gemini Argon}$$

---

## 4. Upgrades Implemented in MegaDEV & BioCore-AI

The following foundational upgrades were designed, implemented, and verified in this architecture:

1. **Empirical Model Limits Grounding (`tools/model-limits.json`)**
   * Limits are no longer arbitrary guesses. They are mathematically derived from thousands of actual OpenRouter execution traces using the formula:
     $$\text{Limit} = \mu(\text{observed}) \times 1.5$$
   * Enforces exact limits for `maxSteps`, `maxOutputTokens`, and `timeoutMs`.

2. **Tamper-Proof Resumable Approvals (`tools/resumable-approval.mjs`)**
   * Suspends dangerous or sensitive tool calls into an HMAC-SHA256 signed snapshot.
   * Protects against replay attacks, tampering, and TTL expiration.
   * Enables asynchronous approval or rejection over mobile Telegram or CLI.

3. **Two-Way Mobile Telegram Gateway (`tools/gateway/telegram-bot.mjs`)**
   * Full remote command center supporting `/task`, `/status`, `/biocore`, `/journal`, `/approve`, and `/reject`.
   * Enforces fail-closed authentication (rejects unauthorized users with zero execution).
   * Automatically scrubs outbound secrets before messages reach Telegram servers.

4. **Cryptographic Append-Only Journal (`tools/journal.mjs`)**
   * Every major agent action, decision, and run outcome is recorded in a SHA-256 hash-chained JSONL ledger.
   * Modifying historical records immediately breaks the cryptographic chain and triggers tamper alerts.

5. **Unified Background Scheduler (`tools/scheduler/runner.mjs`)**
   * Zero-dependency UTC cron runner executing daily 20:00 audits, memory budget checks, and lane health checks.

6. **Windows Service Management Suite (`tools/service/`)**
   * Headless VBScript and batch controllers (`start-background-services.vbs`, `health-check.mjs`) to monitor and boot both the BioCore FastAPI backend and the MegaDEV Telegram Gateway in the background.

---

## 5. System Limitations & Intentional Constraints

Understanding the guardrails means understanding what the agent is **intentionally forbidden** from doing:

1. **No In-Place Retries on Hard Model Failures**:
   If an LLM provider crashes (5xx) or times out beyond `timeoutMs`, `agent-loop.mjs` immediately terminates with an error instead of looping blindly. This prevents uncontrolled token burn.
2. **Fail-Closed Shell Execution**:
   Command chaining (`&&`, `||`, `;`), subshells (`$()`, backticks), and backgrounding (`&`) are blocked by the security policy. Every command must match an approved allowlist prefix.
3. **Workspace Boundary Lockdown**:
   Tools cannot traverse outside `d:/MegaDEV`. Any attempt to read or modify `.env*`, `.ssh`, or `*.pem` files is intercepted and blocked.
4. **Prototype Pollution Protection**:
   All tool dispatchers check `Object.hasOwn` to guard against prototype poisoning (`__proto__`, `constructor`).

---

## 6. Developer & Operator Guide

### Running Static Checks and Tests
```bash
# Run full static analysis suite, test runners, and synthetic matrices
npm test

# Run static hygiene checks only
npm run check
```

### Background Service Management
```bash
# Check health of BioCore Backend (port 8000) and Telegram Gateway
npm run services:check

# Start services headlessly in background (VBScript launcher)
npm run services:start

# Stop background services
npm run services:stop
```

### Manual CLI Transcription
```bash
# Run canonical Node.js transcriber
npm run transcribe -- input.mp3 --sourceId audio-main
```

---

## 7. Directory Structure

```
d:/MegaDEV/
├── .agents/               # Skills library and MCP server definitions
├── .runs/                 # Disk-backed task handoffs, audits, and journals
├── tools/
│   ├── agent-guard.mjs    # Static AST/regex scanner & Stop Hook rule enforcer
│   ├── agent-loop.mjs     # Canonical guarded loop (runAgent, resumeAgent)
│   ├── model-limits.json  # Empirical per-model tokens, steps, and timeouts
│   ├── check.mjs          # Static analysis pipeline for git & CI
│   ├── sanitize.mjs       # Deterministic input cleaning & prompt-injection blocker
│   ├── journal.mjs        # Cryptographic hash-chained activity logger
│   ├── resumable-approval.mjs # HMAC-SHA256 tool suspension manager
│   ├── memory/            # Contextual recall (BM25 + graph tags) & rule budgeting
│   ├── gateway/           # Mobile Telegram Gateway & Task Bridge
│   ├── scheduler/         # Automated cron runner & schedule definition
│   └── service/           # Health monitor & headless service launchers
├── AGENTS.md              # Invariant core operating rules
└── package.json           # Scripts and test matrix definition
```
