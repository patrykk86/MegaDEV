---
name: multi-source-worker
description: Orchestrates isolated subagents and standardized hand-offs for multiple media streams, recordings, or logs with disparate clocks. Use when a task involves multi-stream or multi-clock recordings. Not for single-stream transcription; use tools/transcribe.mjs directly.
metadata:
  tools: tools/transcribe.mjs
  schema: tools/transcribe.tool.json
---

# Multi-Source Worker Isolation & Hand-off Protocol

When analyzing multiple recordings, feeds, or data sources (such as audio and video streams with separate clocks), **never blend multiple sources into a single script or un-isolated context**. `node tools/check.mjs` statically blocks scripts that reference multiple streams in the same file and enforces fail-closed manifest validation.

---

## 1. Core Operating Rule: One Worker per Source

For every distinct recording or data stream:

0. **Declare Source Manifest (`sources.json`)**:
   In the challenge directory, create `sources.json` declaring all streams before launching workers:
   ```json
   {
     "episode": "s01e02",
     "sources": [
       { "sourceId": "video", "originFile": "crank-review-44a27487.mp4", "clockReference": "UTC", "clockOffsetHoursFromUtc": 0 },
       { "sourceId": "audio", "originFile": "status-line-a3be6d7b.mp3", "clockReference": "local+2h", "clockOffsetHoursFromUtc": 2 }
     ]
   }
   ```
   `node tools/check.mjs` validates `clockReference` syntax (`UTC|local±Nh`), matches offset values, and fails closed if any declared source lacks a handoff file.

1. **Assign a Dedicated Worker Context**:
   - Launch a dedicated subagent (`invoke_subagent`) for each source (e.g. `Worker Video`, `Worker Audio`) to keep clock scopes strictly separated.
   - Each worker inspects and aligns only its assigned media/segments file and transcript.
   - Determine the source's native clock (`UTC`, `local+2h`, etc.) and integer `clockOffsetHoursFromUtc`.

2. **Generate & Validate Standardized Hand-Off Files via CLI**:
   - Use `tools/transcribe.mjs` to align sentences (1-to-1 gap partitioning with micro-blip filtering; fails loudly if counts mismatch):
     ```bash
     node tools/transcribe.mjs \
       -i <segments.json> \
       -t <transcript.txt> \
       --source-id <video|audio> \
       --origin-file <media_filename> \
       --clock-ref <UTC|local+2h> \
       --clock-offset <0|2> \
       --finding "batchStart=Nightly batch started" \
       --finding "firstReportArrival=First report from a user" \
       --export-handoff handoff_<source_id>.json
     ```
   - **Offset Rule**: `transcribe.mjs` computes `spokenOffsetSeconds` as `Math.round(utterance.start)` (matching integer seconds accepted by the Challenge Hub). For long multi-clause utterances where the answer falls significantly after the utterance start, verify against the audio that the offset corresponds to the spoken answer within `[start, end]`.
   - Standalone schema, text-match, and offset bounds check:
     ```bash
     node tools/transcribe.mjs --validate-handoff handoff_<source_id>.json
     ```

---

## 2. Standard Hand-off Schema (`handoff_<source_id>.json`)

```json
{
  "sourceId": "video",
  "originFile": "crank-review-44a27487.mp4",
  "clockReference": "UTC",
  "clockOffsetHoursFromUtc": 0,
  "findings": {
    "batchStart": {
      "rawSpokenTime": "01:50",
      "format": "HH:MM",
      "spokenOffsetSeconds": 42,
      "utteranceIndex": 13
    },
    "firstReportArrival": {
      "rawSpokenTime": "03:19",
      "format": "HH:MM",
      "spokenOffsetSeconds": 99,
      "utteranceIndex": 28
    }
  },
  "verbatimLines": [
    "Summary for last night.",
    "All times are UTC.",
    "Service, calendar invites."
  ]
}
```

---

## 3. Deterministic Aggregation Phase

Instead of concatenating transcripts manually in LLM context, run the CLI aggregator:
```bash
node tools/transcribe.mjs --aggregate handoff_video.json handoff_audio.json -o aggregated_record.json
```
This verifies that all `sourceId`s are distinct, validates every handoff file against the schema, utterance text, and timestamp bounds, and outputs `combinedVerbatimLines` in exact order.

---

## 4. Cross-Session Handoff & Clock Anchors

- **Verbatim Clock Anchors**: When combining multi-source verbatim transcripts into a single record for course evaluation, keep native clock header sentences (`All times are UTC.`, `All times are local...`) intact; they act as provenance anchors without failing word-for-word matching.
- **Cross-Session Continuity**: When pausing for a new session (`resume-challenge`), verify all handoff files exist on disk before printing the resume prompt. The resuming session consumes the handoff directly and must not re-download raw media.

---

## 5. Distributed Local + Remote MCP Worker Split (`two places` Pattern)

When a challenge requires running two isolated MCP jobs on separate machines/networks and joining their outputs across timezones:

1. **Job Split & Host Isolation**:
   - Assign audio/transcription-heavy jobs (`voice-to-memo`) to a local isolated subagent so speech-to-text API keys remain local.
   - Assign pure MCP lookup/redaction jobs (`incident-lookup`) to a remote GitHub Actions runner under the challenge identity (`patrykk86`), keeping active review hosts (`megadevpat`) untouched.
2. **Skill-First MCP Execution**:
   - Each worker must call `resources/read` on `skill://<skill-name>/SKILL.md` and `tools/list` before invoking tools.
   - Inspect `inputSchema.required` dynamically (e.g., passing both `query` and `scope` to `search`) and unwrap nested record containers (`readInner.fields`) before calling `redact` and `submit`.
3. **Secret Isolation & Planned Way Home**:
   - Store `PAYLOAD_KEY` in GitHub Actions repository secrets (never as plaintext `workflow_dispatch` inputs on public repositories).
   - Decrypt the job MCP URL in memory, emit `::add-mask::<mcpUrl>`, and print `ENCRYPTED_JOB1_BUNDLE:<iv>:<tag>:<ciphertext>` (AES-256-GCM) to the job log so the coordinator can fetch and decrypt the result and receipt via the GitHub API without an extra host.
   - Redact `v1.eyJ...` step and receipt tokens before saving `.runs/<job>/result.json` or `execution-result.json`.
4. **Timezone-Aware Join**:
   - Convert each worker's timestamp to UTC (accounting for DST transitions such as `US Eastern` EDT `UTC-4` on Oct 31 vs `CET` `UTC+1` on Nov 1) before matching events across workers.

