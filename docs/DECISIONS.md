# Architecture Decision Log

Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0

One entry per decision that would be expensive to reverse. Newest at the bottom. Format: context → decision → consequences.

## ADR-001 — Single Node.js runtime, browser dashboard on loopback
**Context.** Requirement for Windows/macOS, single user, npm-based install, local transcription, and a dashboard. Python offers stronger ML tooling; a desktop shell offers polish.
**Decision.** Node.js ≥ 22.13 (24 LTS recommended) + TypeScript for everything; React/Vite dashboard served by Fastify on `127.0.0.1`.
**Consequences.** One runtime to install; Whisper runs slower than native. Desktop packaging is deferred and can wrap the same backend later.

## ADR-002 — `node:sqlite` with forward-only SQL migrations; Drizzle adopted at Milestone 1
**Context.** better-sqlite3 needs prebuilt native binaries (Windows friction); `node:sqlite` is built in and RC-stable; Drizzle officially supports it.
**Decision.** Thin wrapper over `node:sqlite` now; Drizzle (`drizzle-orm/node-sqlite`) for typed schema/queries when content tables land; Drizzle-Kit generates SQL files that the existing runner applies. No down-migrations; pre-migration backup instead.
**Consequences.** Zero native compile step. If `node:sqlite` changes, one file (`server/src/db/index.ts`) changes.

## ADR-003 — Durable jobs as SQLite rows with an in-process worker
**Context.** Long operations (transcription, research) must survive restarts and be cancellable; Redis/BullMQ would add a service.
**Decision.** `jobs` table + polling worker; atomic claim; heartbeat; stale-heartbeat recovery; bounded retries; dedupe key.
**Consequences.** Simple and portable; throughput limited to one process (fine for a single user).

## ADR-004 — Secrets encrypted with AES-256-GCM under a local key file
**Context.** Keys must not appear in the browser, logs, exports, or git. OS keychains require native modules or platform tools.
**Decision.** Random 32-byte key at `<dataDir>/secret.key` (owner-only), per-secret IV, masked hints only in the API.
**Consequences.** Protects copied/exported databases; does not protect against same-user malware (same boundary as an unsigned app's keychain access). Keychain backing deferred.

## ADR-005 — Four provider interfaces, never one "AI" abstraction
**Context.** A text model cannot transcribe or browse; a local model must still be able to assess retrieved evidence.
**Decision.** `LanguageModelProvider`, `TranscriptionProvider`, `SearchProvider`, `SourceFetcher` are separate; stage routing picks an LLM per stage.
**Consequences.** Slightly more wiring; no accidental assumption that "the model will search."

## ADR-006 — Validation plan is a versioned artifact generated before research
**Context.** Criteria written after seeing evidence drift to fit it.
**Decision.** Plan generation is its own job; plans are immutable versions; every research run references one plan version; edits create a new version.
**Consequences.** Full auditability; some duplication of plan text across versions (acceptable).

## ADR-007 — Model memory is never evidence
**Context.** LLMs fabricate URLs and facts.
**Decision.** Only sources retrieved by `SearchProvider` + `SourceFetcher` can be cited; assessment output citations are validated against stored source ids. Search failure → *insufficient evidence*, never a verdict.
**Consequences.** Some predictions remain unresolved when the web is silent — by design.

## ADR-008 — Local Whisper via Transformers.js (ONNX) for MVP; whisper.cpp later
**Context.** Product owner chose pure-Node over a compiled binary to minimise install failures.
**Decision.** `@huggingface/transformers` with `onnx-community/whisper-*` models downloaded into the data directory; chunked with overlap. whisper.cpp remains a candidate engine behind the same interface.
**Consequences.** Slower on long videos; users can choose captions or OpenAI transcription instead.

## ADR-009 — Fetch adapters in 0.1; Vercel AI SDK for structured output from Milestone 1
**Context.** 0.1 only needs connection tests and model listing (which the SDK does not provide). Extraction/assessment need reliable JSON across three providers.
**Decision.** Keep `fetch` adapters for tests/listing; adopt the AI SDK behind `LanguageModelProvider.complete` after spike S-2 confirms behaviour with LM Studio.
**Consequences.** Two code paths inside one adapter; the app never depends on SDK types outside the adapter.

## ADR-010 — Apache License 2.0
**Context.** Open-source release with third-party components and possible contributions.
**Decision.** Apache-2.0 for original code; `NOTICE` carries concept attribution; `THIRD_PARTY_NOTICES.md` lists every non-original component with its license.
**Consequences.** Explicit patent grant and attribution mechanism; compatible with MIT/BSD dependencies; GPL binaries (ffmpeg) are invoked as separate processes, not linked.

## ADR-011 — Milestone order: transcript import first, media last
**Context.** Implementation context specifies analysis-first milestones; media processing carries the most platform risk.
**Decision.** 0.2 analysis core on imported transcripts → 0.3 research/verdicts → 0.4 local video → 0.5 YouTube → 1.0 evals/hardening.
**Consequences.** Value is demonstrable after 0.2 without ffmpeg or Whisper; transcript import is also the permanent fallback for YouTube failures.

## ADR-012 — Release 0.2 stays dependency-free; Drizzle and the AI SDK wait for a verified build
**Context.** Neither the build sandbox nor the linked machine could reach the npm registry during the 0.2 session, so spikes S-1 (Drizzle) and S-2 (AI SDK structured output) could not be executed. The 0.2 scope (transcript import → extraction → plans) needed a repository layer and structured model output now.
**Decision.** Implement 0.2 on the existing `node:sqlite` wrapper (with SAVEPOINT-based nested transactions) and the existing `fetch` adapters, using hand-written JSON Schemas for provider-side hints and Zod for app-side validation with a one-shot repair loop. Zero new runtime dependencies. Spikes S-1/S-2 move to the start of 0.3 and remain optional: adopt only if they reduce code.
**Consequences.** Two schema representations to keep in sync (Zod + JSON Schema, both in `analysis/schemas.ts`). Provider-side JSON enforcement differs by vendor (Anthropic forced tool-use, OpenAI/LM Studio `response_format`), so the app-side validator is the contract that matters.

## ADR-013 — Re-extraction preserves user-touched predictions
**Context.** Users will re-run extraction (better model, corrected transcript). Blindly replacing rows would destroy edits, plans, and review decisions.
**Decision.** A new extraction run deletes only *pending* predictions with no revisions and no plans, then skips candidates that closely match any surviving prediction (quote or normalized-statement similarity ≥ 0.8). Accepted, dismissed, edited, merged, or planned predictions are never touched by automation.
**Consequences.** A genuinely different re-phrasing may be treated as "already present"; the user can still split/merge by hand.

## ADR-014 — Built-in HTML extractor and fetch adapters for 0.3; Readability deferred
**Context.** Registry access was still unavailable, and 0.3 needs page text for evidence. Mozilla Readability + linkedom remain the intended upgrade.
**Decision.** Ship a dependency-free regex extractor (`research/htmlExtract.ts`: article/main preference, block-tag paragraphing, metadata for title/canonical/date/publisher) behind the `SourceFetcher` interface, with excerpt verification against the stored text. Search adapters (Brave, Tavily, SearXNG, Anthropic/OpenAI native) are plain `fetch`. Adopt Readability in 1.0 hardening if it measurably improves extraction on the fixture set.
**Consequences.** JS-rendered and paywalled pages yield thin text (recorded as coverage limitations). PDFs are recorded as unsupported sources in 0.3.

## ADR-015 — The verdict guard is code, not prompt
**Context.** Verdict rules (no results ≠ false, pending ≠ failed, announced ≠ implemented, anecdotes ≠ trend, one source ≠ corroboration) must hold regardless of model behaviour or user prompt overrides.
**Decision.** `research/verdictGuard.ts` applies rules G1–G7 deterministically after the model answers; it can only make a verdict more cautious, and every adjustment is stored in `guard_notes` and shown in the UI. Zero-evidence runs are assessed by rule without a model call. Excerpts must be found in the retrieved page text or they are discarded before assessment.
**Consequences.** A model that over-claims is visibly corrected rather than trusted; a model that under-claims is left alone. Users can override prompts without weakening the rules.
