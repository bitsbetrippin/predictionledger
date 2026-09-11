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

## Job kinds and payloads

| Kind | Payload | Subject | Result |
|---|---|---|---|
| `prediction.extract` | `{ videoId }` | `video` | `{ windows, candidates, created, matchedExisting, notes[] }` |
| `plan.generate` | `{ predictionId, thenResearch? }` | `prediction` | `{ planId, version, attempts }` — with `thenResearch` it enqueues `research.run` |
| `research.run` | `{ predictionId, planId }` | `prediction` | `{ runId, searches, sources, evidence, rejected, coverage[] }` — enqueues `assessment.run` on completion |
| `assessment.run` | `{ predictionId, runId }` | `prediction` | `{ assessmentId, version, guardNotes[] }` or `{ …, deterministic: true }` for zero-evidence runs |

Failure messages users will see: `Stage "extraction" is routed to … which is disabled in Setup`, `… has no API key saved`, `Internet access is disabled in Setup → Privacy …`, `Model returned output that did not match the … schema after a repair attempt.`, plus the provider's own HTTP error text.

## Error shape

`{ error: "<code>", message?: string, issues?: ZodIssue[] }` with 400 (invalid body), 403 (CSRF/origin), 404, 409 (state conflict), 422 (import failed).
