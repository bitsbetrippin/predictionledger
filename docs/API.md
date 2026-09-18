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

## Release 2.1 — one read-only addition (UI refresh & integrated help)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/market-links?status=proposed|accepted|rejected&limit=` | Every prediction↔market link (the same `PredictionMarketLink` rows as `/api/predictions/:id/market-links`), optionally filtered by status; `400` on an unknown status. Read-only; feeds the Guided start's "linked" step. No other route, body, gate or response changed in 2.1. |

The dashboard routes `#/learn[?topic=<id>]`, `#/signals?view=sides|consensus|alerts|creators`, `#/predictions?pred=<id>&tab=evidence` and `#/library?import=youtube|list|file|transcript|follow` are client-side only.

Behaviour change on existing routes (2.1.1): `POST /api/trading/intents/:id/resolve-unknown` and `POST /api/trading/holds/:id/resolve` now also close the trading alert the hold raised (incident keys `unknown_submission:<intent>`, `discrepancy:<binding>:<market>`, `settlement:<activity>`, `failed_cancel:<order>`, `stale_sync:<binding>`, `disconnection:<binding>`). Responses are unchanged; `POST /api/trading/alerts/:id/ack` still only hides a row.

## Release 2.0 — reports, health, review fixes

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trading/reports/soak?from=&to=&format=md` | O07 paper-soak report (JSON, or markdown with `format=md`): thresholds (7 days, ≥ 100 evaluations, ≥ 10 events, 0 duplicate entries, 0 cap breaches, every intent explained), faults, abstention, paper P&L; `verdict` complete / incomplete with `shortfalls`. Read-only. |
| GET | `/api/trading/reports/qualification?category=sports&strategyVersion=&asOf=&format=md` | FOR-06/07 report: distinct settled events, chronology and held-out rule, Brier vs market baseline, calibration bins with counts, coverage, fee-adjusted paper return, drawdown, per-creator observations, gate reasons, production record; `status` qualified / pending / failed and `eventsNeeded`. Never writes a record. |
| POST | `/api/forecasts/evaluation/record` | `{ category, strategyVersion?, acknowledge: "I am recording a production evaluation over real settled events" }` (`.strict()`): the deliberate owner action that writes a **production** evaluation record with the gate's verdict (a failed record revokes an earlier pass, RV-11); audited (`qualification.recorded`); answers `201` with the evaluation and the qualification report. Arms nothing. |
| GET | `/api/health` | gains `keyFileProtection { method: icacls | posix_mode | unavailable, ok, detail, fix? }` — the secret key file's protection as verified at startup (OPS-01). |

Behaviour changes on existing routes (from the 2.0 review; see docs/VERIFICATION.md):
- `POST /api/trading/decisions` in auto-live mode and every preview/submit re-decision apply the `authorized_scope` gate (`AUTHORIZATION_SCOPE`): the forecast's strategy version and category must equal the armed pair.
- `POST /api/trading/decisions/:id/preview` accepts nothing new; the preview's `display.origin` is `owner` (manual indicator). The scheduler previews with `origin: scheduler` (automatic indicator).
- `POST /api/trading/decisions/:id/submit`: a venue `429` now ends in `submission_unknown` (held, never resent) instead of `rejected_local`; a marker that no longer moves the row answers `409 dispatch_blocked` ("no longer reserved").
- `POST /api/trading/intents/:id/resolve-unknown { venueOrderId }` refuses `409 order_mismatch` (other contract / side / quantity) and `409 order_side_unknown` (read the order back first).
- `POST /api/trading/emergency-stop` waits up to 25 s for a POST already in flight before its cancel sweep.
- Reconciliation may open a `discrepancy` hold with subject `settlement:<activityId>` when the venue's realized amount contradicts the app's reading of a resolution (contested settlement).
- (rc.2) `GET /api/trading/positions` rows gain `external: true` + `venueCost` for positions on markets where the app has no order (hand-placed); such markets never carry `discrepancy`. `POST /api/trading/reconcile` answers with `externalHoldings` (count) and `reclassifiedHolds` (legacy discrepancy holds resolved this run). Decisions gain the gate `no_external_position` (`EXTERNAL_POSITION_ON_CONTRACT`); `RiskExposure` gains `externalHoldings[]` and `externalRiskTotal`.
- Decision / preview / submit take their instant after fetching the book and account state; a book stamped up to 2 s after that instant is fresh.

CLI (read-only): `npm run report:soak [-- --from … --to … --json --out file]`, `npm run report:qualification [-- --category … --strategy … --as-of … --json --out file]`, `npm run upgrade:rehearse -- <db> [--interrupt-after n] [--keep]`.

## Release 1.14 — automatic execution behind arming, pause / emergency stop, alerts, the Trades ledger

All mutations: CSRF header + same origin; bodies `.strict()`. **Mode gates apply here exactly as in the UI.**

### Arming, pause, stop (AUTO-01/03)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/trading/arm` | `{ acknowledge, policyHash, category, strategyVersion? }` → `{ policy, gates, status, scheduler }`. Every gate (validated + fresh account, reconciled, verified contract, **production** qualification for `strategyVersion` (default: the build's estimator) and `category`, paper rehearsal, submission + automation features, no holds, not paused, breaker closed) must hold; `acknowledge` must equal `AUTO_LIVE_ACKNOWLEDGEMENT` (`I authorize automatic real-money orders under the policy hash I reviewed`); `policyHash` must equal the current `policy.policyHash` (else `409 gate_unmet` with gate `policy_reviewed`). Records `authorizedPolicyHash/StrategyVersion/Category` and the authorization hash. `PUT /api/trading/policy { mode: "auto_live" }` always answers `409`. |
| POST | `/api/trading/pause` | `{ reason }` → owner pause (a dispatch blocker; the scheduler and manual submit refuse). |
| POST | `/api/trading/resume` | clears the pause. Does not re-arm. |
| POST | `/api/trading/emergency-stop` | `{ reason? }` → `EmergencyStopResult { stoppedAt, previousMode, cancellations[{ intentId, venueOrderId, outcome, message? }], positionsRetained, note }` + `status`. One statement disarms + pauses, then targeted cancels of **app-owned** open orders only. Idempotent. |
| POST | `/api/trading/cancel-all` | `{ acknowledge }` = `CANCEL_ALL_ACKNOWLEDGEMENT` → cancels every open order on the account, including orders placed elsewhere. `409 acknowledgement_required` otherwise. Separately labelled; never part of the stop. |
| GET | `/api/trading/status` | now carries `breaker` (`{ state closed|open|half_open, consecutiveFailures, openedAt?, lastFailureCode? }`) and the gates `paper_rehearsal`, `automation_feature`, `not_paused`, `breaker_closed`; `policy` carries `authorizedPolicyHash`, `pauseReason`, `automation`. |

### Scheduler (AUTO-02/05)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trading/automation` | `{ settings: AutomationSettings, live: { ok, reasons[] }, runs[], strategyVersion, categories[] }` — `categories` are the production-qualified ones for this estimator version. |
| PUT | `/api/trading/automation` | any `AutomationSettings` field (`intervalMs ≥ 5000`, per-tick budgets, `minReevaluateMs`, `revalidateAfterMs`, `breakerThreshold`, `breakerCooldownMs`, `paperAutopilot`). Part of the policy hash: a change disarms and is audited. |
| POST | `/api/trading/automation/tick` | run one tick now → `AutomationRun { id, startedAt, finishedAt, holder, mode, policyHash, outcome completed|skipped|failed, reason?, candidates, evaluated, ordered, skipped{reason: n}, notes[] }`. Sends only under an arming. |
| GET | `/api/trading/automation/runs[?limit]`, `/api/trading/automation/runs/:id` | runs; one run with `candidates[]` (`predictionId, linkId?, marketId?, sourceKey, outcome ordered|evaluated|skipped|queued_work, reason, decisionId?, intentId?, at`). |

### Ledger, summary, metrics, alerts (DASH-01…05, OPS-04)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trading/summary` | `TradingSummary` — mode, `armedKind`, `paused`, account, buying power / balance / sync age (venue), `committed` (live reservations + positions), `realizedPnl` (official settlements), `fees`, `unrealizedPnl` + `markAt` + `markStale`, open/unknown intents, holds, alerts, breaker, lease, stream, last reconcile / tick. Paper books are separate resources (`/api/paper`, `/api/paper/us`). |
| GET | `/api/trading/ledger?from&to&category&creator&status&mode&reason&external&limit` | `(TradeLedgerRow \| ExternalLedgerRow)[]`. `status ∈ pending, partial, filled, unknown, rejected, canceled, open, settled, skipped, needs_review, eligible, external`. A decision row carries contract/venue link, side, `pChosen`, `limitCost` / `wirePrice`, requested quantity/budget, filled quantity/cost/avg, fees, `intentState`, `orderState` (+ `rejectReason`), `positionState none|open|settled|unknown`, `settlement`, `mark { price, at, stale, unrealizedPnl }`, `cutoffAt`, creator, quote + timestamped link, `reasonCodes`. An external row has `external: true` and no rationale. |
| GET | `/api/trading/ledger.csv`, `/api/trading/ledger.json` | the same rows with the same filters; CSV header `kind,decision_id,clock_at,…`; secret-free. |
| GET | `/api/trading/metrics` | `TradingMetrics` counters: decisions, noTrades, intents, liveIntents, readRetries, unknownSubmissions, fills, droppedDuplicateEvents, reconciliationLagSeconds, automationRuns, alertsOpen, breaker. |
| GET | `/api/trading/alerts?open=true` | `TradingAlert[]` (`kind, severity, incidentKey, subject?, message, details, firstAt, lastAt, count, acknowledgedAt?`). |
| POST | `/api/trading/alerts/:id/ack` | acknowledge. |
| GET | `/api/trading/decisions/:id/evidence` | gains `intent` and `current { asOf, predictionRevision, predictionMissing, normalizedStatement, verification?, verificationChanged, forecast?, forecastChanged, dossier? }` — the current analysis beside, never inside, the immutable record. |

Audit kinds added: `automation.tick`, `automation.link_stale`, `trading.paused`, `trading.resumed`, `trading.emergency_stop`, `orders.cancel_all`, `breaker.opened`, `breaker.closed`; `policy.mode_changed` to `auto_live` carries `authorizedPolicyHash`, `strategyVersion`, `category`.

## Release 1.13 — manual-live execution (preview → confirm), orders, holds, reconciliation

All mutations: CSRF header + same origin; bodies `.strict()`. Amounts are decimal strings in USD; prices are YES-denominated on the wire and chosen-side in the app's cost fields. **Mode gates apply here exactly as in the UI**: preview and submit answer `409` unless the policy is a live mode with a live authorization, an account is connected, this process holds the dispatch lease and no hold is open. (In 1.13 `POST /api/trading/arm` and `/emergency-stop` answered `501`; see Release 1.14 above.)

### Arming (EXE-01)

| Method | Path | Notes |
|---|---|---|
| PUT | `/api/trading/policy` | `{ mode, acknowledge? }`. `manual_live` needs validated credentials, a sync ≤ 30 s old, a reconciled binding, no open holds and `acknowledge` equal to `LIVE_ACKNOWLEDGEMENT` (`I understand this places real orders with real money`) — otherwise `409 gate_unmet` with the unmet gates (`live_authorization` for a missing/different text). `auto_live` → `409` (strategy qualification, 1.14). `paper` / `disabled` clear the authorization. Returns `{ policy, gates, status }`. |
| POST | `/api/trading/disarm` | `{ reason? }` → `{ policy, gates, status }`. One statement: live modes → `paper`, authorization cleared, audited. The dispatch marker transaction re-reads the policy, so nothing can start after a disarm. Open venue orders are untouched (cancel them per intent). |
| GET | `/api/trading/status` | now carries `armed`, `submissionAvailable`, `dispatchBlockers[]` (human-readable reasons) and the `no_holds` gate. |
| GET | `/api/trading/lease` | `DispatchLease { holder?, acquiredAt?, expiresAt?, heldByThisProcess }` + `stream` (`closed | connecting | open | reconnecting`). |

### Preview → confirm (EXE-02/03/04)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/trading/decisions/:id/preview` | `201 OrderPreviewRecord { id, decisionId, decisionHash, request (the exact wire body), venue (the venue's preview answer), display { side, sideLabel, pChosen, netEdge, quantity, chosenCost, yesWirePrice, worstCost, feeBound, estimatedEv, deadlineAt, policyHash, question, marketUrl, evidenceUrl }, expiresAt (+60 s), consumedAt?, consumedBy? }`. The decision must be a manual-live decision (`409 decision_not_live` for a paper one), not skipped, on a Polymarket US contract; the server re-decides with a fresh book/account first (`409 decision_not_eligible` / `decision_changed`). `409 mode_not_live`, `not_authorized`, `not_connected`, `dispatch_blocked`. Makes no create call. |
| POST | `/api/trading/decisions/:id/submit` | `{ previewId, decisionHash }` — nothing else is accepted (no price, side, quantity, budget). `201 TradeIntent` on acceptance (states below); `409 rejected_local` intent when the marker could not be committed (disarmed, lease lost, blocked); `409 hash_mismatch`, `preview_consumed`, `preview_expired`, `preview_stale` (price/evidence/policy/account moved: evaluate and preview again). Repeating the same confirmation returns the same intent — even while the account is paused for it. Exactly one venue POST per intent, ever. |
| GET | `/api/trading/previews/:id` | one preview. |

### Intents, orders, executions (EXE-05/06)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trading/intents?state=&mode=&limit=` | `TradeIntent[]` newest first. `state ∈ prepared, reserved, submitting, acknowledged, filled, partially_filled, canceled, rejected, rejected_local, skipped, expired, submission_unknown`. Live intents carry `bindingId, venueOrderId?, previewId, decisionHash, dispatchMarkerAt?, submittedAt?, acknowledgedAt?, unknownReason?, lastError?, order?, executions?`. |
| GET | `/api/trading/intents/:id` | one intent with its venue order and executions. |
| POST | `/api/trading/intents/:id/cancel` | targeted cancel of that intent's venue order → `{ outcome: requested | not_found | failed | not_open, message? }`; `cancel_pending` locally until the venue confirms; a `failed_cancel` hold on failure. `409 no_order` for an unknown submission (resolve it instead). |
| POST | `/api/trading/intents/:id/resolve-unknown` | `{ venueOrderId, note }` (link this venue order — it becomes ours, its fills settle the reservation once) **or** `{ outcome: "not_submitted", note }` (the venue never created it — reservation released, opportunity returned). Exactly one of the two; the note is mandatory and audited. `409 not_unknown`, `order_taken`. |
| GET | `/api/trading/orders?external=&limit=` | `VenueOrderRecord[]` — ours and external (`external: true`, no `intentId`, no rationale). |
| GET | `/api/trading/orders/:id` | the order with `executions[]` (`id, orderId, intentId?, tradeId?, type, quantity?, yesPrice?, chosenCost?, fee?, at?, source ∈ create_response, stream, rest, activity`). |
| POST | `/api/trading/orders` | `409 preview_required` — there is no direct order route. |

### Reconciliation, holds, positions, settlement (EXE-04/05/07/08)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/trading/reconcile` | `ReconcileReport { bindingId, syncedAt, ordersChecked, executionsAdded, activitiesRead, settlements, unknownIntents[{intentId, candidates[]}], discrepancies[{marketSlug, venueNet, localNet}], holdsOpen, paused }`. Never sends or resends anything. |
| GET | `/api/trading/holds?open=true` | `ReconciliationHold[] { id, bindingId, kind ∈ submission_unknown, discrepancy, failed_cancel, stale_sync, stream_gap; subject, detail, openedAt, resolvedAt?, resolution? }`. Any open hold pauses dispatch. |
| POST | `/api/trading/holds/:id/resolve` | `{ resolution }` for every kind except `submission_unknown` (use `resolve-unknown`). |
| GET | `/api/trading/positions` | `LivePosition[] { marketSlug, venueNet?, venueAt?, localNet (signed, YES-denominated), intentIds, discrepancy?, settled? { outcome ∈ win, loss, void, correction, external_exit; at } }`. |
| GET | `/api/trading/settlements` | `SettlementEventRecord[]` — `source: account_activity` rows carry `bindingId`, `intentId?`, `amount?`, `activityId?`; corrections are separate rows. |
| GET | `/api/trading/export` | `{ exportedAt, intents, orders, executions, settlements, holds, audit }` — the complete manual order audit trail, secret-free. |

Deletion guard (DASH-05): `DELETE /api/videos/:id`, `/api/predictions/:id`, `/api/markets/stored/:id` → `409 live_lineage { intentIds }` when a live intent descends from the record.

Audit kinds added: `order.previewed`, `order.submitting`, `order.acknowledged`, `order.refused`, `order.submission_unknown`, `order.cancel_requested`, `execution.recovered`, `reconcile.completed`, `settlement.recorded`, `hold.opened`, `hold.resolved`, `dispatch.paused`, `dispatch.resumed`, `stream.failed`, `stream.closed`, `stream.error`, `stream.apply_failed`, `trading.disarmed`, `policy.mode_changed` (with `liveAuthorizationHash`).

## Release 1.12 — forecasts, paper decisions, risk limits (no order path)

All mutations: CSRF header + same origin; bodies `.strict()`. Amounts are decimal strings in USD. (In 1.12 `POST /api/trading/orders`, `/arm`, `/disarm`, `/emergency-stop` answered `501`; see Release 1.13 above for the current contract.)

### Forecasts (FOR-01…07)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/forecasts` | `{ predictionId, linkId? }` → `201 ForecastSnapshot` built over the trading cohort with a fresh YES midpoint from the venue book (`linkId` defaults to the prediction's verified link). `409 no_link` without a verified Polymarket US link. |
| GET | `/api/forecasts/evaluation?strategy=&category=` | `ForecastEvaluation` over every stored decision of the strategy/category: events, groups, Brier, baseline Brier, calibration bins, fee-adjusted paper return, coverage/abstention, drawdown, skipped reasons, qualification gate. Never writes a production qualification record. |
| GET | `/api/forecasts/:id`, `/api/predictions/:id/forecasts` | Immutable snapshots: `pYes`, `pNo`, `prior {p0, source, bookAt, bid, ask}`, `status`, `inputs` (versions as of the instant), `formula`, `exclusions[]`, `contributions[]` (`sourceKey, clusterKey, stance, n, meanEdge, shrunkEdge, weight, ageDays, selected, reason, history[]`), `hash`, `expiresAt`. |

### Decisions and risk (RSK-01…07, FOR-08)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/trading/decisions` | `{ predictionId, linkId?, candidateQuantity?, dryRun? }` → `201 TradeDecision`. Never accepts a price, side or budget. Evaluates every gate, persists the decision (skipped ones too), and in paper mode reserves capacity, consumes the contract's entry opportunity and simulates an IOC fill. `409 no_link`, `404`. |
| GET | `/api/trading/decisions?mode=&outcome=&from=&to=&predictionId=&limit=` | Newest first. Each carries `outcome`, `sizing?` (`side, sideId, sideLabel, pChosen, quantity, limitCost, wirePrice, feeBound, worstCost, netEdge, estimatedEv, boundBy`), `gates[]` (`id, label, satisfied, code?, detail`), `reasonCodes[]`, `inputs` (immutable snapshot), `rationaleHash`, `policyVersion/policyHash`, `dailyBucket`, `intent?`, `paperPosition?`. |
| GET | `/api/trading/decisions/:id` | one decision. |
| GET | `/api/trading/decisions/:id/evidence` | `{ decision, forecast?, verification?, dossier (as of the decision clock), reservation? }` — the "why this decision" record. |
| GET | `/api/trading/exposure` | `RiskExposure` for the paper account today plus the limits in force. |
| GET | `/api/trading/limits` | `{ policyVersion, limits: RiskLimits, budgetTimezone, policyHash }`. |
| PUT | `/api/trading/limits` | any `RiskLimits` field (money as decimal strings; ages in ms) and/or `budgetTimezone` (IANA). A change is hashed, audited (`policy.changed`), disarms a live mode, and never resets consumed allowances. `400 invalid_limits` for an unknown timezone. |

### US paper book (FOR-08)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/paper/us` | `PaperUsBook { method: "us-ioc-v1", currency: "USD", bankrollStart, bankroll, committed, realizedPnl, fees, open, settled, wins, losses, voids, positions[] }` with fills per position. Separate from `/api/paper` (legacy, `method: "legacy-snapshot-v1"`, now with `byCurrency` subtotals). |
| PUT | `/api/paper/us/bankroll` | `{ bankrollStart }`. |
| POST | `/api/paper/us/reset` | deletes US paper positions and fills; decisions, intents and reservations stay as history. |
| POST | `/api/markets/stored/:id/settle-paper` | settles open US paper positions from the market's stored venue resolution (also runs after every snapshot refresh). |

Reason codes (stable): `MODE_DISABLED, OFFLINE, WRONG_VENUE, CONTRACT_NOT_VERIFIED, CONTRACT_STALE, RULES_CHANGED, MARKET_NOT_OPEN, CONSTRAINTS_UNSUPPORTED, CUTOFF_UNKNOWN, AT_OR_PAST_CUTOFF, FORECAST_MISSING, FORECAST_INVALID, FORECAST_INSUFFICIENT, FORECAST_EXPIRED, FORECAST_STALE, STRATEGY_NOT_QUALIFIED, BOOK_MISSING, BOOK_STALE, SYNC_MISSING, SYNC_STALE, SYNC_INCOMPLETE, FEE_UNKNOWN, OPPORTUNITY_CONSUMED, DAILY_LOSS_STOP, MAX_OPEN_MARKETS, PROB_NOT_ABOVE_HALF, OPPOSING_EXPOSURE, OPEN_ORDER_ON_CONTRACT, NO_LIQUIDITY, ORDER_BUDGET_ZERO, MARKET_CAP_REACHED, TOTAL_RISK_CAP_REACHED, DAILY_CAP_REACHED, EVENT_CAP_REACHED, BUYING_POWER, BUYING_POWER_UNKNOWN, NO_VALID_QUANTITY, WORST_COST_EXCEEDS_CAP, EDGE_NEGATIVE, EDGE_BELOW_MIN`.

`TradingPolicy` gains `policyVersion`, `limits`, `budgetTimezone`, `policyHash`; `MarketRecord` gains `resolvedAt`; the JSON export gains `forecasts`, `tradeDecisions`, `paperUsPositions`.

## Release 1.11 — source subscriptions, evidence dossier, contract verification (no execution)

All mutations: CSRF header + same origin; bodies `.strict()`. Nothing in this release previews, creates or prepares an order.

### Source subscriptions (SRC-01)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/source-subscriptions` | `SourceSubscription[]` (`kind`, canonical `url`, `enabled`, `pollIntervalHours`, `lookbackDays`, `maxVideosPerRun`, `autoExtract`, `categoryAllowlist[]`, `researchBudget?`, `lastRunAt?`, `lastResult?`, `nextRunAt?`). |
| POST | `/api/source-subscriptions` | `{ url, title?, enabled?, pollIntervalHours? (1–720), lookbackDays? (0–3650), maxVideosPerRun? (1–50), autoExtract?, categoryAllowlist?[], researchBudget? {maxSearches?, maxSources?} }` → `201`. The URL is canonicalised (channel `@handle`/`/channel/…`/`/c/…` → `…/videos`; playlist → `?list=`); the same channel returns the existing row. `400 invalid_url`. |
| GET | `/api/source-subscriptions/:id` | the subscription plus `runs[]` (`SubscriptionRunSummary`: `listed, queued, alreadyKnown, skippedLookback, skippedAllowlist, skippedBudget, error?, queuedVideoIds[]`). |
| PATCH | `/api/source-subscriptions/:id` | any create field except `url`; `researchBudget: null` clears it. |
| DELETE | `/api/source-subscriptions/:id` | `{ ok: true }`; imported videos stay (their `subscriptionId` is kept for provenance). |
| POST | `/api/source-subscriptions/:id/run` | `202 { jobId }` — queues `subscription.poll` with `force: true` (runs even when disabled). `409 offline` when internet is off. |

### Evidence dossier and sources (SRC-02…06)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/predictions/:id/dossier?asOf=<ISO>&assumePublished=1` | `EvidenceDossier`: `quote {text, hash, startS, endS, videoId, videoUrl?, timestampUrl?}`, `versions {prediction, analysis?, plan?, latestRun?, latestAssessment?}`, `supporting[]` / `contradicting[]` / `context[]` (`DossierItem` with the source's `url, title, publisher, publishedAt, retrievedAt, firstSeenAt, contentHash, status, independenceGroup, syndicatedOf`), `dissent[]`, `independenceGroups[]`, `coverageLimitations[]`, `rationale?`. With `asOf`, items not known to the app by that instant are dropped (`excludedAsOf`), basis `first_seen`; `assumePublished=1` also counts items by publication date, labelled `published_assumption`. |
| POST | `/api/sources/:id/withdraw` | `{ note?, restore? }` → the source with `status` `withdrawn` (or `available` when restoring). Status only: text, hash, excerpts and evidence rows never change. |
| POST | `/api/sources/:id/recheck` | Re-fetches the URL; `404`/`410` → `status: "missing"`; records `lastCheckedAt` / `lastHttpStatus`. Returns `{ …source, checked: { status, httpStatus, outcome } }`. `409 offline`. |
| POST | `/api/predictions/:id/research` | now accepts `purpose: "verdict" \| "forecast"` (default `verdict`). A forecast run requires an existing plan (`409 plan_required`), stores evidence with `purpose = forecast` and never chains `assessment.run`. |

`VideoSummary` gains `channelId?, publishedPrecision?, firstSeenAt?, transcriptHash?, subscriptionId?`; `Prediction` gains `quoteHash?, transcriptHash?, analysisVersion?`; `SourceRecord` gains `contentHash?, firstSeenAt?, status, statusChangedAt?, statusNote?, independenceGroup?, lastCheckedAt?, lastHttpStatus?`; `ResearchRun` gains `purpose, cutoffAt?`.

### Contract verification (MAT-01…06)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/predictions/:id/us-candidates` | `{ url?, limit? (1–20) }` → `UsCandidateSearch { outcome: "none" \| "one" \| "multiple", candidates[{market, score, rationale, relation?, side?, linkId?}], researchOnly[{linkId, provider, question}], queries[], notes[] }`. Searches Polymarket US only (or the event behind a pasted `polymarket.us/event/<slug>` URL) and proposes links; never accepts one. `409 markets_disabled|offline`, `404`. |
| POST | `/api/market-links/:id/verify-contract` | `{ facts?: { [fieldId]: { value, source } }, notes? }` → `201 ContractVerification` (new version). Facts fill **missing, non-gate** fields only; hard gates (`venue`, `market_open`, `rules_hash`, `side`, `teams`, `question`, `settlement_conditions`) and `incompatible` fields are never overridden. A link on any venue other than Polymarket US verifies to status `research_only`. `400 invalid_facts` when a fact lacks its source. |
| GET | `/api/market-links/:id/verifications` | `{ link, verifications[] }` newest first — every version is kept. |
| POST | `/api/market-links/:id/revalidate` | Refreshes the market from the venue when online, compares with the latest verification → `{ verification?, reasons[], refreshed }`; any material change marks it `stale` (link `verificationStatus: "stale"`). |
| PUT / PATCH | `/api/market-links/:id/verification-status` | **`405 status_is_computed`** — status is never asserted. |

`PredictionMarketLink` gains `verificationStatus` (`unverified` \| `incomplete` \| `incompatible` \| `research_only` \| `verified_equivalent` \| `stale`) and `verificationId?`. `ContractVerification`: `fields[{id, label, status: verified\|incompatible\|missing\|not_applicable, expected?, found?, note?, fact?, required}]`, `sideId?`, `sideLabel?`, `sideBasis?`, `rulesHash?`, `cutoffAt?`, `cutoffBasis?`, `cutoffUnknown`, `quoteHash?`, `predictionRevision`, `facts`, `reviewer`, `notes?`, `staleAt?`, `staleReasons?`.

## Release 1.10 — Polymarket US account connection (reads only)

Application routes, distinct from venue routes. All mutations require the CSRF header and same origin; bodies are `.strict()` — an unknown key (a base URL, a mode, a budget) is a `400`. No route in this release creates, previews or modifies an order; the live-control paths exist only to answer `501 feature_disabled`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/trading/status` | `TradingStatus`: `policy {mode, liveAuthorizedAt?}`, `features {submission:false, automation:false}`, `armed:false`, `submissionAvailable:false`, `binding?` (local id, state, `identityKind:"local_binding"`, fingerprint, masked hints, continuity, `reconcileRequired`), `previousBindings[]`, `latestSync?` (balances / positions / open orders as decimal strings with currency), `syncAgeSeconds`, `stale` (> 30 s), `gates[]`, `identityNote`, `hosts`, `sdk`. |
| GET | `/api/trading/audit?limit=100` | Append-only, secret-free events: `connection.tested`, `connection.saved`, `credential.replaced`, `trading.disarmed`, `orders.cancel_requested`, `connection.disconnected`, `connection.validation_failed`, `sync.failed`, `policy.mode_changed`, `connection.needs_rebind`, `backup.scrubbed`. |
| POST | `/api/trading/connection/test` | `{ keyId?, secretKey? }` (blank = use the saved credential). Returns `TradingConnectionTest { ok, code, message, credentialFingerprint?, balances?, orderCalls: 0 }`. Codes: `ok`, `malformed_secret`, `invalid_key_id` (no network call), `offline_mode`, `unauthorized`, `forbidden`, `clock_skew`, `rate_limited`, `venue_unavailable`, `network`, `timeout`, `sdk_missing`. Never a trade. |
| PUT | `/api/trading/connection` | `{ keyId, secretKey, assertSameAccount? }` → `201 { binding, test, sync?, status }`. Requires a passing live test (`422 connection_failed` with the test otherwise). Same fingerprint continues the binding; a different one starts a new binding (`continuity: "unverified"`, old row `superseded`) unless `assertSameAccount` (`"user_asserted"`); both set `reconcileRequired`. Never changes the mode. |
| DELETE | `/api/trading/connection` | Disarms (live → paper, authorization cleared, prepared intents invalidated — none can exist yet), requests cancellation of app-owned open orders (empty in 1.10), removes the credential, keeps history. `{ disconnected, cancellations[], note, status }`; `404 not_connected`. |
| POST | `/api/trading/sync` | Reads balances, every page of positions and open orders; stores a sync row. Errors: `401 trading_unauthorized|trading_forbidden`, `429`, `502 trading_<code>`. |
| GET / PUT | `/api/trading/policy` | `{ mode }`. 1.10 accepts `disabled` and `paper`; `manual_live` / `auto_live` → `409 gate_unmet { gates[] }`. Generic `PUT /api/settings` cannot change it. |
| POST | `/api/trading/arm`, `/disarm`, `/emergency-stop`, `/decisions`, `/orders` | `501 feature_disabled` in this build. |

`MarketProviderId` gains `"polymarket_us"`; `MarketRecord`/`MarketSummary` gain `constraints?: MarketContractConstraints` (US only: `status`, `tickSize`, `minQuantity`, `feeCoefficient`, `sides[{id,label,long,tradable}]`, `category`, `sportsMarketType`, `line`, `gameStartTime`, `eventStartTime`, `bestBid`, `bestAsk` — decimal strings, USD). US outcome token ids are `<slug>:YES` / `<slug>:NO`. The JSON export gains `tradingBindings` and `tradingAudit` (secret-free).

## Release 1.9 — paper trading

| Method | Path | Notes |
|---|---|---|
| GET | `/api/paper` | `{ book: PaperBook, positions: PaperPosition[], sizing }` — marks open positions first. |
| POST | `/api/paper/positions` | `{ marketId, side, stake?, notes?, predictionIds? }` → `201 PaperPosition` at the latest snapshot price; stake from Setup sizing (and the matching signal's estimate) when omitted. `409 paper_disabled / no_price / already_open / max_open / no_stake`. |
| POST | `/api/paper/positions/:id/close` | `{ price? }` (default: current mark) → closed position with `realizedPnl`. |
| DELETE | `/api/paper/positions/:id` · POST `/api/paper/mark` · POST `/api/paper/reset` | Remove one / mark all now / delete every position. |

Settings gain `markets.paper { enabled, bankroll, sizing, fixedStake, kellyFraction, maxStakeFraction, autoOpen, maxOpenPositions }`. `market.snapshot` marks open positions after refreshing; `market.watch` returns `paperOpened[]` when auto-open fires.

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
| `research.run` | `{ predictionId, planId, purpose? }` | `prediction` | `{ runId, purpose, searches, sources, evidence, rejected, coverage[] }` — enqueues `assessment.run` on completion **unless** `purpose = "forecast"` (1.11) |
| `subscription.poll` | `{ subscriptionId, force? }` | `subscription` | `SubscriptionRunSummary` — lists the channel/playlist, queues `video.import` for new videos within the lookback / allowlist / budget (1.11) |
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
