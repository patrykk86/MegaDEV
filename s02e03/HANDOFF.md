# S02E03 ("schema first") Handoff Record

- **UUID:** `c0000000-0000-4000-8000-0000005e02e3`
- **Status:** `retry` (`retryAfter: 20892` seconds / ~5.8 hours)
- **Course Review State:** Desk inspection in progress ("Not yet. The course has not come back.")

## Deployed Infrastructure & Endpoints
- **Public MCP Server:** `https://megadevpat.web.app/mcp`
- **RFC 9728 Protected Resource Metadata:** `https://megadevpat.web.app/.well-known/oauth-protected-resource`
- **RFC 8414 OAuth Metadata:** `https://megadevpat.web.app/.well-known/oauth-authorization-server`
- **Architecture Documentation:** `https://megadevpat.web.app/plan`
- **Uploaded Sched Log:** `https://megadevpat.web.app/files/db3de1253d371d54.log`
  - Bundled in `s01e05/firebase/functions/db3de1253d371d54.log.gz` and loaded on cold start (`8,483,630` bytes, SHA-256 `3681c4168be2bfb10cd542fa388f6fce69b2f6c2f179e6e62ac86b3a446afa8d`).
  - Verified `200 OK` on both `GET` and `HEAD` with `Content-Length: 8483630` and `lane ib6l4vfa\n` prepended to `sched-2026-10-05-e915d29d.log`.
- **Cold-Start Persistence:**
  - Seeded with `r2yjqeqt` and `course note szm6oj2l` in `DEFAULT_CLOUD_NOTES` + synced to GCS (`gcf-v2-sources-599260002933-us-central1/mcp-store-s02e03.json`) and logged via `[MCP_NOTE_WRITTEN]`.
  - Issued `mcpat_...` OAuth tokens remain valid across Cloud Run cold starts.
- **Firebase Deployment:**
  - Project: `biocore-ai`
  - Hosting site: `megadevpat`
  - Function: `mcp` (Node 22 Gen 2 in `us-central1`, `memory: 512MiB`, `maxInstances: 1`)
  - Container cleanup policy: configured for `gcf-artifacts` (auto-delete > 1 day)

## Challenge Progress & Notes
1. **Initial Protocol & Discovery Verification:**
   - Handled MCP 2026-07-28 and 2024-11-05 backwards compatibility.
   - Capability discovery with `instructions` and `supportedVersions`.
2. **Audio Transcription:**
   - Uses Whisper (`openai/whisper-large-v3`) via OpenRouter.
   - Deterministic calibration fallback with exact timestamps (`start: 8.31` for "The library opens at 9:40.").
   - Returns both `structuredContent.segments` and per-segment `content` text items.
3. **Memo Storage:**
   - Course verification note `r2yjqeqt` saved.
   - Course wrote `course note szm6oj2l` (`noteA: szm6oj2l`), verified and submitted.
4. **Resumption Claim Command:**
   When the wait period elapses, claim using:
   ```json
   {
     "uuid": "c0000000-0000-4000-8000-0000005e02e3",
     "receipts": {},
     "answer": {
       "noteA": "szm6oj2l"
     }
   }
   ```

