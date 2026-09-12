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

## ADR-016 — Raw-stream upload and a dynamically loaded, optional Whisper engine
**Context.** Release 0.4 needs file upload and on-device transcription. `@fastify/multipart` (busboy) would add a parsing dependency for one route, and `@huggingface/transformers` is large (ONNX Runtime binaries), downloads models, and could not be installed in the build sandbox. Users who only import transcripts or use OpenAI transcription should not pay for either.
**Decision.** (1) The upload route accepts the file as a raw `application/octet-stream` body, with the file name and metadata in request headers; the server streams it to a temp file while hashing and enforcing the size cap, validates it with ffprobe, then stores it under its content hash. No multipart parser. (2) `@huggingface/transformers` is an *optional* dependency imported dynamically inside `LocalWhisperProvider`; when it is absent the engine's readiness check reports exactly what to install, and the OpenAI engine remains available. Models are cached under `<data>/models/` and the first download is gated by the privacy switch. (3) ffmpeg stays a system dependency located via `PL_FFMPEG_PATH` → optional `ffmpeg-static` → PATH; child processes always receive argument arrays.
**Consequences.** Browser uploads are a single `fetch` with a `File` body (no form encoding overhead, streaming, resumable-friendly later). Multi-file or field-mixed uploads would need a different route. A missing `@huggingface/transformers` surfaces at transcription time rather than install time, so Setup exposes a *Check media tools* probe. Spike S-3 (real Whisper throughput on a 30-minute file, default model choice) moves to the first machine with a working `npm install`.

## ADR-017 — YouTube via a consent-installed, checksum-verified yt-dlp; captions before audio; Node as its JS runtime
**Context.** There is no official API that serves captions or audio for arbitrary public YouTube videos. yt-dlp is the practical tool, but it is a scraper that breaks when YouTube changes, it must not be fetched implicitly by npm (RT-05), and since late 2025 it needs an external JavaScript runtime for YouTube's challenges (Deno by default).
**Decision.** (1) yt-dlp is installed only when the user clicks Install in Setup (or the Library card): the official standalone binary for the platform is downloaded from the GitHub release and verified against the release's `SHA2-256SUMS` before it is moved into `<data>/tools/`; `PL_YTDLP_PATH` or a PATH copy are honoured instead. The same button updates it. (2) The import order is creator captions → auto-generated captions (policy and language configurable) → audio download (opt-out) → 0.4's `audio.extract`/`transcript.generate`; transcript import remains the fallback named in every failure message. (3) yt-dlp is pointed at the Node binary running the app (`--js-runtimes node:<execPath>`) so no second runtime is required. (4) yt-dlp only ever receives a canonical URL rebuilt from a validated 11-character id, via argument arrays; its JSON output is validated field by field. (5) `video.import` has `maxAttempts` 1: YouTube failures are classified and explained rather than retried blindly.
**Consequences.** Import quality depends on YouTube's caption availability; auto captions are flagged in the Library and can be replaced via Re-transcribe (audio + own engine). yt-dlp breakage is expected and surfaced as "update yt-dlp". Age-restricted and bot-checked videos stay unavailable (no cookie/PO-token support in MVP). The `--js-runtimes` flag and the whole live path are confirmed on the first machine with network (spike S-4); the fake-yt-dlp tests cover the app's own logic only.

## ADR-018 — Resilience policy for model calls, and retry as a new job
**Context.** Provider outages, rate limits, and slow local models were handled only by the job queue's blunt `maxAttempts`, which re-ran whole jobs (re-extracting every window) and retried invalid credentials pointlessly.
**Decision.** Every model call goes through `withResilience`: a per-try timeout (120 s, ref'd timer so a bare process cannot exit mid-call), up to three tries with quadratic backoff capped at 30 s for HTTP 408/429/5xx and network errors, `Retry-After` honoured, and an immediate failure carrying the provider's own message for 401/403. Job-level retry is explicit: `POST /api/jobs/:id/retry` creates a *new* job with the same payload rather than reviving the old row, so history stays intact and dedupe keys still apply.
**Consequences.** A flaky provider costs at most three short waits per window instead of a whole job re-run; an invalid key fails in seconds with an actionable message. Timeouts are not yet user-configurable (a Setup field is queued for 1.0 if real runs show the need).

## ADR-019 — Labelled synthetic fixtures + Promptfoo, rendering the app's built prompts
**Context.** Cross-provider quality checks must exercise exactly what the app sends, and must be re-runnable as prompts evolve.
**Decision.** Evals render prompts by importing the built `server/dist` templates and windowing code (no copied prompt text), score against the same `expected.json` files the unit tests use, and treat modality drift and invented deadlines as hard failures. Fixtures stay synthetic and clearly labelled; a 30-minute fixture (B1) is generated with planted, human-reviewed statements so window boundaries and repeats are exercised deterministically.
**Consequences.** `npm run build` is a prerequisite for `npm run eval`; Promptfoo is fetched with `npx` rather than added as a dependency. Threshold values are recorded only once the suite has run on real providers (1.0).

## ADR-020 — 1.0.0 is gated on a verified run, so the feature-complete build ships as 1.0.0-rc.1
**Context.** All MVP requirements have implementations and tests, but the build environments available so far could not install the real dependencies (npm registry blocked in the sandbox; the linked machine's workspace could not mount folders). Calling that "1.0.0" would assert a verification that has not happened.
**Decision.** Tag the feature-complete build `1.0.0-rc.1`. `1.0.0` is cut only after `docs/FIRST_RUN.md` has been completed on at least one Windows and one macOS machine, spikes S-3/S-4 are answered, and eval scores are recorded in `docs/VERIFICATION.md`. Fixes found during that run are rc.2, rc.3… — no new features.
**Consequences.** The version string tells users exactly what they are getting. `npm run doctor` and the runbook exist so the verification loop is cheap for whoever runs it.

## ADR-021 — Sports picks are settled, not researched
**Context.** Product-owner rule (2026-09-12): for game-related videos (NFL, NBA, NHL, MLB, soccer, …) the prediction scope is the win, the spread if stated, and whether it was met after the game date; deep research is wasted on them. Sports results are linear (win/loss, occasionally a tie/push).
**Decision.** A prediction extracted with a `sports_pick` becomes `kind = sports_pick`. Its deadline is the game date, its single component is the pick, its validation plan is generated by code (settlement rules + score look-up queries, version `plan.sports.v1`) with no model call, its research budget is capped at three searches and three sources, and its assessment uses a settlement template whose labels map hit → supported, miss → contradicted, push/draw → partially supported, no final score → insufficient. The general path is untouched; a season-long or futures claim in the same video remains a general prediction.
**Consequences.** Picks cost one evidence-extraction call per fetched page plus one settlement call; criteria cannot drift because they are code. Game dates are never guessed: a pick without a stated date has an unknown deadline until edited. Player props and parlays are out of scope (they would need their own settlement rules).

## ADR-022 — Validate scores is a chained one-click action with a trusted-source filter
**Context.** Owner request (1.3): no plan review or evidence work for sports picks beyond the final score; a dedicated button; a Sports Mode switch; spreads optional.
**Decision.** `POST /api/predictions/:id/validate-score` reuses the existing job chain (plan.generate → research.run → assessment.run) rather than a new pipeline, because the sports plan is already code-generated and the assessment template already settles; the route only adds the pre-checks (sports pick, game date reached, search available) and skips the review stop. Research for picks ranks trusted score hosts first and fetches only those when any exist, recording which case applied in coverage notes. Sports Mode is a prompt steer plus the spread toggle; picks are still detected with it off.
**Consequences.** One button, one job chain, same history/versioning/guard rules. The trusted-host list is a constant to edit (`analysis/sports.ts`); an untrusted-only result set is still settled but flagged for verification.
