---
name: multi-source-worker
description: >-
  Use this skill whenever a challenge or task involves multiple media streams, recordings,
  logs, or documents with disparate clocks, timezones, formats, or schemas (e.g., audio vs video in S01E02).
  Enforces isolated subagents/workers per source with standardized hand-off files validated by tools/transcribe.mjs.
---

# Multi-Source Worker Isolation & Hand-off Protocol

When analyzing multiple recordings, feeds, or data sources (such as audio and video streams with separate clocks), **never blend multiple sources into a single script or un-isolated context**. `node tools/check.mjs` statically blocks scripts that reference both video and audio streams in the same file.

---

## 1. Core Operating Rule: One Worker per Source

For every distinct recording or data stream:
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
   - **Offset Rule**: `transcribe.mjs` computes `spokenOffsetSeconds` as `Math.round(utterance.start)` (matching the integer second accepted by the Challenge Hub, e.g., `41.55s -> 42`, `29.75s -> 30`). For long multi-clause utterances where the answer falls significantly after the utterance start, listen/verify against the audio that the offset corresponds to the spoken answer within `[start, end]`.
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
