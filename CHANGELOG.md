# Changelog

All notable changes to Prediction Ledger. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer once 1.0 ships.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## [1.1.0] — 2026-09-12 — First build that runs on real hardware
Consolidates 1.0.0-rc.1 and the two first-run patches into one fresh build (versioned 1.1.0 at the product owner's request; the 1.0.x line is retired). First run on Windows 11 / Node 26.7: `npm install`, the shared and server builds, and — after the fix below — the dashboard build all succeeded. `npm start` and the workflow steps in `docs/FIRST_RUN.md` are the remaining verification.
### Fixed
- Web: `setTemplate` in the API client only accepted the two template names from 0.2; Setup lists four (extraction, plan, evidence, assessment) → `tsc` error, no `web/dist`. (Our stub-based typecheck could not catch it — the stub typed `useState` as `any`; the stub is now typed.)
- Web: added `src/vite-env.d.ts` (Vite ambient types) so CSS side-effect imports type-check on newer TypeScript.
- Server: `tsc` never copied the `.sql` migration files into `server/dist`, so `npm start` failed with ENOENT on the first real start. The server build now copies them (`scripts/copy-migrations.mjs`), and the migration loader falls back to `server/src/db/migrations` if a build skipped the copy.
- `npm run doctor`: npm version probe failed on Windows (Node refuses to spawn `npm.cmd` without a shell); now read from npm's own environment or spawned with a shell.
### Verified on the real machine
- Windows 11 (26200), Node 26.7.0: `npm install` (lockfile produced, optional `@huggingface/transformers` installed), `shared`, `server`, and (after the fix) `web` builds — Vite 5.4.21, 39 modules, 220 kB bundle.

## [1.0.0-rc.1] — 2026-09-12 — Release candidate
Feature-complete for the MVP as specified. Tagged as a release candidate, not 1.0.0, because no machine has yet run `npm run setup`/`npm start` on the real dependencies; `docs/FIRST_RUN.md` is the checklist that closes that gap.
### Added
- `model.download` job, `POST /api/tools/whisper/download`, and Setup → Transcription → **Download model now** with download progress (Transformers.js `progress_callback`).
- Setup → Limits → **Model timeout (seconds per request)**; applied to every model call through the resilience wrapper.
- `npm run doctor` (`scripts/doctor.mjs`): environment report without secrets, for issues and the first-run checklist.
- `docs/FIRST_RUN.md`: step-by-step first-run runbook stating exactly what to report back.
- Tests: LocalWhisperProvider against a fake Transformers.js module (readiness, offline, preload progress, cache reuse) and the download job; upload-name fuzzing (traversal, unicode, null byte, oversized); public settings and error messages never carry secret values. 46 tests total.
### Changed
- Static review of the never-executed wiring (Fastify routes, Vite config, launcher scripts, Windows path handling) recorded in `docs/VERIFICATION.md`.

## [0.6.0] — 2026-09-12 — Evaluation harness and hardening, part 1
### Added
- Fixture B1: synthetic, labelled 30-minute transcript (`fixtures/transcripts/energy-outlook-30min.*`) with canned per-window model replies; pipeline test covering three overlapping windows, a prediction spanning the 720 s window boundary, a repeated statement (one row, two occurrences), the no-predictions transcript (B2), invalid credentials at extraction, and job retry.
- Promptfoo evaluation suite (`evals/`) that renders the app's *built* extraction prompt for each fixture window and scores real-model replies against `expected.json` (`npm run eval`).
- Provider-call resilience: per-request timeout (120 s), bounded retries with backoff for 429/5xx/network errors honouring `Retry-After`; 401/403 fail immediately with the provider's message.
- Job retry: `POST /api/jobs/:id/retry` and a Retry button on the Jobs tab for failed/cancelled jobs.
- Backups: `POST /api/backups` (consistent `VACUUM INTO` copy + secret key), `GET /api/backups`, Setup → Backups, and `npm run backup`.
- `docs/VERIFICATION.md` (platform matrix skeleton), `CHANGELOG.md`, GitHub issue/PR templates.
### Changed
- Deduplication merges a quote truncated at a window edge into the fuller quote from the next window (token containment ≥ 0.9 on overlapping spans).
- Date resolver: "by the end of next year/month" → last day of that period (was statement date + 1 year).
- `npm run setup` messaging for ffmpeg/ffprobe, yt-dlp, and the optional Whisper package.

## [0.5.0] — 2026-09-12 — YouTube ingestion
- YouTube link import via a consent-installed, checksum-verified yt-dlp: creator captions → auto captions → audio download → local transcription; distinct unavailable-video messages with the transcript-import fallback; up-front refusal when internet is off. Migration 005.

## [0.4.0] — 2026-09-11 — Local video
- Raw-stream media upload with hash storage and ffprobe validation; ffmpeg audio extraction with silence detection; resumable chunked transcription (local Whisper via optional Transformers.js, or OpenAI). Migration 004.

## [0.3.0] — 2026-09-11 — Research and verdicts
- Search providers, SSRF-guarded fetcher, evidence extraction with excerpt verification, two-field verdicts with app-enforced guard rules, recheck history, JSON/CSV export. Migration 003.

## [0.2.0] — 2026-09-11 — Analysis core
- Transcript import, prediction extraction with rule-based deadlines and dedupe, editing/merge/split, versioned validation plans. Migration 002.

## [0.1.0] — 2026-09-11 — Foundation
- Localhost Fastify server, Setup tab, encrypted credentials, provider tests, durable SQLite job queue, documentation set.
