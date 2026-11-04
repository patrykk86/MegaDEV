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
  - Verified with `lane ib6l4vfa` prepended to top of `sched-2026-10-05-e915d29d.log`.
- **Firebase Deployment:**
  - Project: `biocore-ai`
  - Hosting site: `megadevpat`
  - Function: `mcp` (Node 22 Gen 2 in `us-central1`)
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

