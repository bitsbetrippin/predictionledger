# HTTP API (localhost only)

Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0

Base URL `http://127.0.0.1:7317`. JSON in/out. Every `POST`/`PUT`/`PATCH`/`DELETE` must carry the header `x-prediction-ledger: 1` (CSRF guard); cross-origin requests are refused. Types live in `shared/src/index.ts`. Long operations return `202 { jobId }` — poll `GET /api/jobs/:id`.

## Release 0.1

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Version, Node version, data directory, schema version. |
| GET | `/api/settings` | Settings with secret presence + masked hints (never the secret). |
| PUT | `/api/settings` | `{ settings, secrets? }` — secrets map: `""` clears a key. |
| POST | `/api/providers/test` | `{ provider, apiKey?, baseUrl? }` → `ProviderTestResult` (models listed when supported). |
| GET | `/api/jobs` · `/api/jobs/:id` | Job list / one job. |
| POST | `/api/jobs/:id/cancel` | Cancel a queued/running job. |

## Release 0.2

### Videos and transcripts
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/videos` | `VideoSummary[]` with segment and prediction counts. |
| POST | `/api/videos/import-transcript` | `TranscriptImportRequest` `{ title, content, format: srt\|vtt\|txt\|json\|auto, filename?, publishedAt?, language? }` → `201 { video, warnings[] }`. `422` if nothing parseable. `publishedAt` is the statement-date proxy; never inferred. |
| GET | `/api/videos/:id` | `VideoDetail` incl. ordered segments (`textOriginal`, optional `textCorrected`). |
| PATCH | `/api/videos/:id` | `{ title?, publishedAt?: string\|null, language?: string\|null }`. |
| PATCH | `/api/videos/:id/segments/:segmentId` | `{ textCorrected: string\|null }` — original text is never overwritten. |
| DELETE | `/api/videos/:id` | Cascades to segments, predictions, components, revisions, plans. |
| POST | `/api/videos/:id/extract` | Enqueue `prediction.extract` (deduped per video) → `202 { jobId }`; `409` when no transcript. |

### Predictions
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/predictions` | Query: `videoId, topic, userStatus, deadlineBefore, deadlineAfter, includeDismissed=1`. Returns rows with computed `timeStatus` (`pending\|reached\|unknown`). Default excludes dismissed/merged. |
| GET | `/api/predictions/topics` | Distinct topics for the filter. |
| GET | `/api/predictions/:id` | Prediction + `plans[]` (newest first) + `revisions[]`. |
| PATCH | `/api/predictions/:id` | `PredictionEdit` — snapshots a revision first. Changing dates sets basis `user`. |
| POST | `/api/predictions/:id/accept` · `/dismiss` · `/restore` | Review status. |
| POST | `/api/predictions/:id/merge` | `{ sourceIds[] }` — sources become `merged`, occurrences appended to target. |
| POST | `/api/predictions/:id/split` | `{ componentId }` → `{ parent, child }`; `409` if only one component. |
| DELETE | `/api/predictions/:id` | Hard delete (rare; prefer dismiss). |

### Validation plans
| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/predictions/:id/plan` | Enqueue `plan.generate` → `202 { jobId }`. Each run stores a new immutable version. |
| GET | `/api/predictions/:id/plans` | All versions, newest first. |
| POST | `/api/predictions/:id/plans` | `{ plan: Partial<ValidationPlanBody>, researchPrompt }` — user edit saved as version n+1 with `provider: "user"`. |

### Prompt templates
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/templates` | Built-in version + body, and any override, for `extraction` and `plan`. |
| PUT | `/api/templates/:name` | `{ body: string\|null }` — override the system instructions; `null` resets. |

## Release 0.3

### Research and assessments
| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/predictions/:id/research` | `{ planId?, autoPlan? }` → `202 { jobId, stage: "plan"\|"research" }`. Uses the latest plan (or generates one first when `autoPlan` and review mode is off). `409` with a reason when no search provider, internet off, or review mode requires a plan — nothing is enqueued. Recheck = call again. |
| GET | `/api/predictions/:id/runs` | Research runs, newest first (status, queries with per-query result counts/errors, coverage notes, budgets used). |
| GET | `/api/runs/:id` | Run + its `evidence[]` (each with `source`). |
| GET | `/api/predictions/:id/assessments` | Assessment versions, newest first, each with component assessments, citations, guard notes. |
| GET | `/api/sources/:id` | Source record + extracted text (≤ 200k chars). |
| GET | `/api/export/json` | `ExportBundle` (videos, predictions, plans, runs, sources, evidence, assessments). Never settings or secrets. |
| GET | `/api/export/csv` | One row per prediction with latest assessment; UTF-8 BOM. |

`GET /api/predictions` now includes `result` (latest `ResultSummary`) and `processingStatus` (`not_researched\|running\|completed\|failed`), and accepts `result=<evidence assessment>` or `result=not_researched` as a filter. `GET /api/predictions/:id` adds `runs[]` and `assessments[]`.

## Release 0.4

### Local media and transcription
| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/videos/upload` | **Raw file bytes** with `content-type: application/octet-stream` (no multipart). Metadata rides in headers: `x-file-name` (percent-encoded, required — only its extension and stem are used), `x-file-size` (bytes, optional), `x-published-at` (`YYYY-MM-DD`, optional), `x-language` (optional), `x-title` (percent-encoded, optional). Streams to `media/upload-<uuid>.tmp` while hashing; validated with ffprobe *before* the video is registered; stored as `media/<sha256><ext>`. → `201 { video, duplicate: false, jobId }` (an `audio.extract` job is queued) or `200 { video, duplicate: true }` when the same bytes were imported before. Errors: `400` bad name/extension/empty, `413` over 8 GiB, `422` unreadable or no audio track, `503` ffmpeg/ffprobe not found (message carries per-OS install hints). Allowed extensions: `.mp4 .m4v .mpg .mpeg .mov .mkv .webm .m4a .mp3 .wav .aac .ogg .flac`. |
| POST | `/api/videos/:id/transcribe` | `{ restart?: boolean }` → `202 { jobId, stage: "audio.extract"\|"transcript.generate" }`. Without `restart` it resumes: audio is extracted only if missing, and only chunks not yet `done` are transcribed (safe after a crash or engine failure). With `restart: true` it deletes the transcript segments, chunk states, and any user corrections, then starts over. `404` when the video has no local media (transcript-only imports). |
| GET | `/api/media/status` | `MediaStatus`: `{ ffmpeg: { ok, message, source? }, engine: { id, ok, message, needsDownload? } }` for the engine currently selected in Setup. The local engine reports `needsDownload` when the model is not in `models/` yet. |
| DELETE | `/api/videos/:id` | (0.2 route) now also removes the stored media file, extracted WAV, and chunk scratch files before deleting the row. |

`VideoSummary`/`VideoDetail` gain `mediaSize`, `transcriptionEngine`, `transcriptionModel`, `error`, `chunksDone`, `chunksTotal`. Video `status` moves `importing` → `transcribing` → `ready` (or `failed` with `error` set; Retry re-enqueues without restart).

## Release 0.5

### YouTube import and helper tools
| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/videos/import-youtube` | `{ url, publishedAt?, language?, title? }`. Accepts `youtube.com/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, or a bare 11-character id; anything else → `400 invalid_url`. Refused **before anything is queued** with `409 offline` when internet is off in Setup → Privacy, or `409 tool_missing` when yt-dlp is not installed (message names Setup → YouTube → Install). → `202 { video, duplicate: false, jobId }` (a `video.import` job runs) or `200 { video, duplicate: true }` when that video id was imported before. `publishedAt` overrides YouTube's upload date; `title`/`language` likewise. |
| POST | `/api/videos/:id/transcribe` | (0.4 route) for a YouTube video whose transcript came from captions: `{ restart: false }` re-runs the whole import (Retry); `{ restart: true }` skips captions and downloads the audio for your own engine (Re-transcribe). Same 409s as above. → `202 { jobId, stage: "video.import" }`. |
| GET | `/api/tools/status` | `ToolsStatus`: `{ ffmpeg: { ok, message, source? }, ytdlp: { ok, message, version?, source?, installedAt? }, internet }`. |
| POST | `/api/tools/ytdlp/install` | User-initiated download of the official yt-dlp standalone binary into `<data>/tools/` (also "update"). `409 offline` when internet is off. → `202 { jobId }` (`tool.install` job; progress shows download MB and "Verifying checksum"). The binary is verified against the release's `SHA2-256SUMS` before it is moved into place; a mismatch installs nothing. |

`VideoSummary` gains `youtubeId`, `channel`, `transcriptSource` (`captions-manual | captions-auto | transcribed | imported`). Segment `engine` for captions is `youtube-captions:<manual|auto>:<lang>`.

## Release 0.6

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/jobs/:id/retry` | Re-runs a **failed or cancelled** job as a new job with the same kind, subject, payload, and dedupe key → `202 JobSummary` (the new job). `409 not_retryable` otherwise. |
| GET | `/api/backups` | `BackupInfo[]` newest first: `{ file, bytes, createdAt, kind: "manual"\|"pre-migration", hasSecretKey }`. |
| POST | `/api/backups` | Writes `<data>/backups/manual-<timestamp>.db` with `VACUUM INTO` (consistent while running) and copies `secret.key` alongside → `201 BackupInfo`. |

Provider calls made by every job now go through a resilience wrapper: 120 s per-try timeout, up to 3 tries with backoff (1 s, 4 s, capped 30 s; `Retry-After` honoured) for HTTP 408/429/5xx and network errors; HTTP 401/403 fail at once with the provider's message. Job errors read e.g. `Anthropic request failed: HTTP 401 …` or `The model did not answer within 120 s …`.

## Release 1.0-rc

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/tools/whisper/download` | Fetches/loads the Local Whisper model chosen in Setup into `<data>/models/` ahead of the first import → `202 { jobId }` (`model.download` job with download-progress stages). `409 not_local` when another engine is selected; `409 offline` when the model is not cached and internet is off. |

`limits.modelTimeoutSeconds` (30–900, default 120) is the per-try timeout applied to every model call.

## Release 1.3

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/predictions/:id/validate-score` | Sports picks only. Chains the code-written settlement plan (if none), a capped trusted-source box-score search, and the settlement verdict → `202 { jobId, stage: "plan"\|"research" }`. `409 not_sports_pick`, `409 game_pending` (game date in the future), plus the usual `no_search_provider` / `offline`. **1.4:** body `{ recheck?: boolean }`; the response is always `202 { jobId, stage: "game" }` — one `sports.resolve_game` job finds the game record (winner, score, date; an unknown date is resolved by the same look-up) and settles every pick on that matchup. |
| POST | `/api/videos/:id/validate-scores` | 1.4. Body `{ recheck?: boolean }`. One `sports.resolve_game` job per distinct matchup among the video's sports picks whose game date is not in the future → `202 { jobs: [{ matchup, jobId }], picks, skipped }`. |
| GET | `/api/games`, `/api/games/:id` | 1.4. Game records: `{ id, sport, league?, matchupKey, teams, eventDate?, eventTime?, status, scores?, overtime, winner?, sourceId?, sourceUrl?, excerpt?, lookupVia?, notes[], retrievedAt? }`. |

Settings gain `sports: { enabled, trackSpreads }`.

## Release 1.8 — consensus, alerts, bulk import, Manifold

| Method | Path | Notes |
|---|---|---|
| POST | `/api/videos/import-youtube-list` | `{ url, limit?≤200, autoExtract? }` → `202 { jobId, url, kind }` (`playlist.import`; result `{ listTitle, found, queued, skipped, videoIds }`). `400 invalid_url`, `409 offline`, `409 tool_missing`. |
| GET | `/api/consensus?includeSettled=1` | `Proposition[]` — grouped by market or by text; sides with endorsements, share, creators; `disagreement`. |
| GET | `/api/alerts?includeDismissed=1` | `{ open, alerts: Alert[] }`. `POST /api/alerts/seen { ids }`, `POST /api/alerts/:id/dismiss`, `POST /api/alerts/dismiss-all`. |
| POST | `/api/markets/watch-run` | Enqueue `market.watch` → `202 { jobId }` (result `{ raised, messages[], open }`). |

`provider` on the market routes accepts `polymarket` or `manifold`; `POST /api/markets/watch` and manual links accept venue URLs. Settings gain `markets.venues[]` and `markets.watch { enabled, movePts, divergencePts, resolveDays }`. `JobSummary.result` carries a completed job's return value. Jobs: `playlist.import { url, limit, autoExtract }`, `market.watch {}`; `video.import`/`audio.extract`/`transcript.generate` accept `autoExtract`.

## Release 1.7 — signals

| Method | Path | Notes |
|---|---|---|
| GET | `/api/signals?includeSettled=1` | `{ gates, creators: CreatorRecord[], signals: MarketSignal[] }` — computed on read; signals cover open predictions' accepted links unless `includeSettled=1`. |
| GET | `/api/signals/creators` | Creator records only. |
| POST | `/api/market-links/:id/backfill` · `/api/markets/backfill` | Enqueue `market.backfill` for one link / every accepted link lacking a history price → `202 { jobId }`. |

`PredictionMarketLink` gains `priceAtMadeAt`, `priceAtMadeSource: "history" | "snapshot"`. Settings gain `markets.signals { priorWeight, minSettledLean, minSettledModerate, minSettledStrong, minLiquidity }`. Job `market.backfill { linkId? }` → `{ backfilled, skipped[] }`. `MarketProvider.priceHistory` is required of adapters.

## Release 1.6 — markets in the ledger

| Method | Path | Notes |
|---|---|---|
| GET | `/api/markets/stored` | Stored markets (watched or linked) with `latest` snapshot. |
| GET | `/api/markets/stored/:id` | One market + `snapshots[]` (newest first, ≤100) + `links[]`. |
| POST | `/api/markets/watch` | `{ provider: "polymarket", idOrSlug }` (id, slug, or polymarket.com URL) → `201 MarketRecord`, watched. |
| POST | `/api/markets/stored/:id/unwatch` · DELETE `/api/markets/stored/:id` | Stop refreshing / remove (links cascade). |
| POST | `/api/markets/snapshot` | `{ marketIds? }` → `202 { jobId }` (`market.snapshot`; all refreshable markets when omitted, deduped). |
| GET | `/api/predictions/:id/market-links` | Links with embedded `market` (and its `latest`). |
| POST | `/api/predictions/:id/market-links/match` | `{ limit? }` → `202 { jobId }` (`market.match`). |
| POST | `/api/predictions/:id/market-links` | Manual link `{ provider, idOrSlug, side? }` → `201` accepted link (`matchedBy: "user"`). |
| POST | `/api/market-links/:id/accept` (`{ side? }`) · `/reject` · DELETE `/api/market-links/:id` | Review a proposal. |

`409 markets_disabled` when Setup → Markets is off; `409 offline` without internet. Settings gain `markets: { enabled, provider, refreshHours, snapshotBudget, autoLinkSports }`. Job kinds: `market.snapshot { marketIds? }` → `{ refreshed, failed[], budget, candidates }`; `market.match { predictionId, limit? }` → `{ candidates, proposed, accepted, notes[], top[] }`.

## Release 1.5 — markets (read-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/markets/search?q=&provider=polymarket&limit=10&all=1` | Free-text search; active markets unless `all=1`. `409 offline` when internet is off; `502 market_api` on venue errors. |
| GET | `/api/markets?tag=nfl&limit=20&offset=0` | Markets under a venue tag (events flattened), by 24 h volume. |
| GET | `/api/markets/:provider/market/:idOrSlug` | One market: `{ provider, id, conditionId, slug, url, question, description, event?, outcomes[{label, tokenId, price, bestBid, bestAsk}], liquidity, volume, volume24h, endDate, active, closed, restricted, retrievedAt }`. |
| GET | `/api/markets/:provider/book/:tokenId` | `{ bids[{price,size}], asks[…], midpoint, retrievedAt }` — best price first. |

## Release 1.4

`Prediction` gains `gameId?`. Assessments made by settlement report `provider: "app"`, `model: "rule"`, `templateVersion: "sports_settlement.v1"`; their run has `evidenceTemplate: "sports_settlement.v1"` and coverage note `Settled from game record <id>`. The JSON export includes `games`.

## Release 1.3.1

`sportsPick` gains `eventHint?` (spoken non-date reference), `eventDateSource?: "transcript" | "lookup" | "user"` and `eventDateSourceUrl?`. A prediction whose date came from a look-up has `deadlineBasis: "lookup"` and a `schedule-lookup` revision.

## Release 1.2

`GET /api/predictions` accepts `kind=general|sports_pick`. `Prediction` gains `kind` and, for picks, `sportsPick: { sport, league?, teams: [a, b], eventDate?, pick: { type: "moneyline"|"spread"|"total", team?, line?, side? } }`. Plans for picks report `provider: "app"`, `templateVersion: "plan.sports.v1"`; their assessments report `templateVersion: "sports_assessment.v1"`. A fifth template name, `sports_assessment`, is available on `/api/templates`.

## Job kinds and payloads

| Kind | Payload | Subject | Result |
|---|---|---|---|
| `prediction.extract` | `{ videoId }` | `video` | `{ windows, candidates, created, matchedExisting, notes[] }` |
| `plan.generate` | `{ predictionId, thenResearch? }` | `prediction` | `{ planId, version, attempts }` — with `thenResearch` it enqueues `research.run` |
| `research.run` | `{ predictionId, planId }` | `prediction` | `{ runId, searches, sources, evidence, rejected, coverage[] }` — enqueues `assessment.run` on completion |
| `sports.resolve_game` | `{ predictionId, recheck? }` | `prediction` (the seed pick; dedupe key is the matchup) | `{ gameId, status, summary, picks, outcomes: { [predictionId]: "hit (assessment v1)" \| "miss …" \| "push …" \| "pending" }, notes[] }`. Progress: "Looking up A vs B (1/2)", "Reading espn.com (1/3)", "Settling pick k of n". Fails with `Could not find a final score for A vs B …` when no snippet or page states one. |
| `assessment.run` | `{ predictionId, runId }` | `prediction` | `{ assessmentId, version, guardNotes[] }` or `{ …, deterministic: true }` for zero-evidence runs |
| `video.import` | `{ videoId, userSupplied: { title?, publishedAt?, language? }, forceAudio? }` | `video` | `{ source: "captions-manual"\|"captions-auto", lang, segments }` or `{ source: "audio", bytes, ext }` — the latter enqueues `audio.extract`. `maxAttempts` 1: failures are explained, not retried blindly. |
| `tool.install` | `{ tool: "yt-dlp" }` | `tool` | `{ path, version, bytes }` |
| `model.download` | `{ model }` | `tool` | `{ modelId, cached }` — progress "Downloading model <file>" |
| `audio.extract` | `{ videoId }` | `video` | `{ audioPath, meanVolumeDb }` — enqueues `transcript.generate`; fails with "audio track is silent" below −60 dB |
| `transcript.generate` | `{ videoId }` | `video` | `{ chunks, newSegments, segmentCount }` — resumable per chunk; progress reads "Transcribing chunk k of n" |

Failure messages users will see: `Stage "extraction" is routed to … which is disabled in Setup`, `… has no API key saved`, `Internet access is disabled in Setup → Privacy …`, `Model returned output that did not match the … schema after a repair attempt.`, plus the provider's own HTTP error text. Media failures: `ffmpeg/ffprobe were not found …`, `The file has no audio track …`, `The audio track is silent …`, `Local Whisper engine is not installed …`, `Whisper model … is not downloaded and internet access is disabled …`. YouTube failures (each ends with the transcript-import fallback): `This video is private …`, `This video is unavailable …`, `… age-restricted …`, `… not available in your region`, `Live streams and premieres are not supported yet …`, `YouTube is rate-limiting or bot-checking this computer …`, `Could not reach YouTube …`, `The installed yt-dlp is too old …`, `This video has no captions, and audio download is turned off …`.

## Error shape

`{ error: "<code>", message?: string, issues?: ZodIssue[] }` with 400 (invalid body), 403 (CSRF/origin), 404, 409 (state conflict), 413 (upload too large), 422 (import failed), 503 (required local tool missing).
