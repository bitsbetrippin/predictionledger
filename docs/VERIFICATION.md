# Verification matrix

What has actually been executed, where, and what is still static review. Update this file whenever a release is verified on a new platform; never mark a platform as passed without running it there.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## Legend
**Executed** = the command/test ran and passed on that platform. **Static** = code and docs reviewed for that platform's behaviour, not run. **—** = not yet attempted.

## Release 1.1.2

| Check | Linux (cloud sandbox, Node 22.22) | Windows 11 | macOS |
|---|---|---|---|
| `npm run setup` (install + build) | — (registry blocked) | **In progress**: install ✓, shared ✓; server ✗ (4 Zod type errors → fixed 1.1.1), web ✓ earlier; full chain re-run pending | — |
| `npm test` (46 tests) | **Executed** via compiled scratch build with a zod shim; real ffmpeg 6.1.1; fake yt-dlp; fake Transformers.js | — | — |
| `npm start` → ready line → dashboard opens | — | **Executed (1.1.1)** | — |
| Port walk when 7317 is busy | Static | Static | Static |
| Restart recovery (stale running job re-queued) | **Executed** (unit) | — | — |
| Transcript import → extraction → plan (fake model) | **Executed** | — | — |
| Research → evidence → verdict (fake search/fetch) | **Executed** | — | — |
| Local media upload → audio → chunked transcription | **Executed** (real ffmpeg, fake engine) | — | — |
| Real Whisper (Transformers.js) throughput on 30 min (S-3) | — (provider logic executed against a fake module) | — | — |
| YouTube import (real yt-dlp, `--js-runtimes node`) (S-4) | — (fake only) | **Executed (1.1.1)**: install from Setup ✓, auto captions ✓ (45 s video) | — |
| yt-dlp installer download + checksum | — | **Executed (1.1.1)** | — |
| Promptfoo evals with real providers | — | — | — |
| Backups (`VACUUM INTO`, key copy) | **Executed** (unit) | — | — |
| Provider timeout / 429 backoff / 401 no-retry | **Executed** (unit) | — | — |
| Loopback-only binding | Static | Static | Static |
| Secrets absent from logs, public settings, error text, exports | **Executed** (unit); logs static — pino `redact` on auth headers | — | — |
| Upload-name fuzzing (traversal, unicode, null byte, oversized) | **Executed** (unit) | — | — |
| Fastify/Vite/launcher wiring | Static review (see BUILD_PLAN §9) | Static | Static |
| ffmpeg detection with `winget` install / `PL_FFMPEG_PATH` | — | — | — |
| macOS Gatekeeper on downloaded yt-dlp | — | — | — |

## How to fill in a platform column

1. Fresh clone; `node --version` ≥ 22.13.
2. `npm run setup`, then `npm test` — paste the pass count.
3. `npm start`; confirm the ready line and the browser opening; stop with Ctrl+C and confirm a clean exit.
4. Start a second copy while the first runs → expect "port 7317 was busy; using 7318".
5. Import `fixtures/transcripts/data-center-approvals.srt` (published 2025-11-03) → Extract → Research with a configured provider → verdict row.
6. Drop a short MP4 → transcription completes; kill the server mid-way and restart → resumes.
7. Setup → YouTube → Install yt-dlp → import one captioned public video and one without captions.
8. `npm run eval` with at least one provider; record scores below.

## Eval scores (Release 1.0 target: ≥ 0.8 per window, no hard failures)

| Provider / model | worked example | no-predictions | 30-min w1 | 30-min w2 | 30-min w3 | Notes |
|---|---|---|---|---|---|---|
| — | | | | | | |
