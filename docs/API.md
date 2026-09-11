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

## Job kinds and payloads

| Kind | Payload | Subject | Result |
|---|---|---|---|
| `prediction.extract` | `{ videoId }` | `video` | `{ windows, candidates, created, matchedExisting, notes[] }` |
| `plan.generate` | `{ predictionId }` | `prediction` | `{ planId, version, attempts }` |

Failure messages users will see: `Stage "extraction" is routed to … which is disabled in Setup`, `… has no API key saved`, `Internet access is disabled in Setup → Privacy …`, `Model returned output that did not match the … schema after a repair attempt.`, plus the provider's own HTTP error text.

## Error shape

`{ error: "<code>", message?: string, issues?: ZodIssue[] }` with 400 (invalid body), 403 (CSRF/origin), 404, 409 (state conflict), 422 (import failed).
