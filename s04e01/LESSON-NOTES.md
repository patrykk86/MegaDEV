# S04E01 — Twenty payouts, and what we take from it

Opened today, Tue 17 Nov 2026, Week 4 Day 1.

## The lesson in one paragraph

An autonomous job running under a tight time limit (8 seconds for 20 bookings) cannot afford 20
model round trips: routine execution belongs in a deterministic script, while the model orchestrates
and inspects exceptions. Just as critical, credentials must be pinned to their intended hosts at the
HTTP transport layer with `redirect: 'manual'`, because default `fetch()` follows 307 redirects and
forwards custom headers like `X-Payout-Key` to untrusted hosts, and untrusted manuals can embed
exfiltration URLs (`verify-s04.mega.dev`).

## What closed the gap

- **Host-pinned HTTP with manual redirects**: `roles/payout-runner/extensions/http.mjs` restricts
  `PAYOUT_KEY` to `pay-s04.mega.dev` and `TICKET` to `hq.mega.dev`, and sets `redirect: 'manual'`.
- **Scripted batch execution**: `roles/payout-runner/scripts/run-batch.mjs` runs all 20 tasks in
  ~3.4 seconds, logs every hop without secrets to `.runs/s04e01/wire-log.jsonl`, and flags
  `needs-owner` on off-file accounts or `3xx` redirects.
- **Owner handoff**: `roles/payout-runner/scripts/finish-parked.mjs` finishes parked tasks once
  decided on the Challenge page.
- **Installed skill**: `rook-clock` (`.agents/skills/rook-clock/`, version `3d2368ccd6f9`).

## Acceptance record

| Claim | Proof |
| :--- | :--- |
| 20-task batch completes within 8s limit | `run-batch.mjs` via `payout-runner` → 3.4s, 18 paid, 2 flagged (`needs-owner`) |
| Parked tasks finished and challenge solved | `finish-parked.mjs` + `claim-challenge` → `solved` |
| `rook-clock` installed and SHA-256 verified | `.agents/skills/rook-clock/` → 13 files verified |
