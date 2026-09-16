# Changelog

All notable changes to Prediction Ledger. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer once 1.0 ships.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## [1.8.0] — 2026-09-16 — Consensus across channels, watch rules, second venue, bulk import
Last step of [docs/PREDICTION_MARKETS.md](docs/PREDICTION_MARKETS.md) as planned: the range of bets across many channels, and a watch that says when the market moves against them. Paper trading is deliberately not included — it is a product decision (see the doc).
### Added
- **Playlist / channel import** (Library → *Import a playlist or channel*; `POST /api/videos/import-youtube-list { url, limit, autoExtract }`, job `playlist.import`): `yt-dlp --flat-playlist` lists a playlist, a channel's videos tab or an `@handle`, each video not already in the ledger is created and queued through the normal import, and `autoExtract` runs prediction extraction as soon as each transcript lands (captions path immediately; audio path after transcription). Videos remember their `source_list`.
- **Consensus** (`GET /api/consensus`, Signals → *Consensus across channels*): the same claim across videos becomes one proposition — grouped by the accepted market (sides may differ) or, when unlinked, by statement overlap (Jaccard ≥ 0.5 over content tokens, same kind, negation → No). Endorsement weight = creator's settled market-linked record (min 1) × recency (half-life 90 days). A split room is shown as a split with each side's share, sources and claims.
- **Watch rules** (job `market.watch`, chained after every snapshot refresh; `POST /api/markets/watch-run`; Setup → Prediction markets → Watch rules): *market moved* ≥ N pts vs the snapshot ~24 h earlier, *divergence* ≥ N pts between a labelled signal's estimate and the market, *resolving soon* within N days for a market with open linked claims. Alerts are local rows (migration 010 `alerts`, one per rule/subject/day), listed on the Signals page with a count badge in the nav; `GET /api/alerts`, `POST /api/alerts/:id/dismiss`, `/api/alerts/dismiss-all`, `/api/alerts/seen`.
- **Manifold Markets** as a second venue behind `MarketProvider` (`providers/markets/manifold.ts`; public API, play-money — liquidity/volume are mana, tagged `token:mana`): search, get by id/slug/URL, list, history from the bet tape; Setup → Venues chooses which venues Find markets searches and snapshots refresh; the Markets page and manual links take a venue. Binary markets only.
- Job results are returned on `JobSummary.result`; `settings.markets` gains `venues` and `watch`.
### Fixed
- Settings deep-merge turned arrays into objects (would have reset settings to defaults once an array field existed).
### Notes
- 77 tests (Manifold adapter, playlist parsing + a fake-yt-dlp listing run, watch rules with dedupe, consensus by market and by text).

## [1.7.0] — 2026-09-16 — Signals: creator record vs market
Step three of [docs/PREDICTION_MARKETS.md](docs/PREDICTION_MARKETS.md): turn "creator said X" + "market says p" + "creator's history" into a number you can argue with. Computed on read, nothing stored, nothing traded.
### Added
- **Venue price history.** `MarketProvider.priceHistory(tokenId, {from, to, fidelityMinutes})` over CLOB `/prices-history` (verified live). Job `market.backfill` reads the price of the linked side nearest noon UTC on the prediction's made-on date (window −3/+2 days, hourly) and records it as `priceAtMade` with `priceAtMadeAt` and `priceAtMadeSource: "history"` (migration 009), plus a `history` snapshot for binary markets. Runs automatically when a link is accepted or auto-linked; also `POST /api/market-links/:id/backfill`, `POST /api/markets/backfill`, and a "read venue history" button on the link.
- **Creator records** (`GET /api/signals/creators`): per channel (or per video when the channel is unknown) — predictions, settled (latest verdict supported / contradicted / partially), hits, misses, hit rate, and over settled predictions with an accepted link and a made-on price: **realized edge** = mean(outcome − market price at made) — what following the creator earned per $1 at the market's price — plus market Brier and creator Brier, and the edge shrunk by n/(n+k).
- **Signals** (`GET /api/signals`): one row per (market, side) with an accepted link from an open prediction — current market price and snapshot time, contributors' shrunk edges combined by settled-count weight with one contribution per video, estimate = price + edge (clamped), and a **label** — strong / moderate / lean / no signal — that is a gate, not a score: minimum settled linked record (20 / 8 / 3 by default), minimum absolute edge (10 / 5 / 3 pts), liquidity ≥ $10k, and prediction deadlines consistent with the market end (±45 days); every failed gate is listed in `reasons`. Thresholds and prior weight live in Setup → Prediction markets → Signal gates.
- **Signals page** (nav): market sides with price, estimate, edge, label, contributors (expand a row for the why and each contributing claim with the price at the time and the creator's record), and the creator-record table.
### Notes
- Realized edge, not hit rate, is the measure: a creator who only calls 95 % favourites has a high hit rate and ≈ 0 edge.
- The creator is the video's channel; per-speaker records wait for diarisation. Multiple links on one settled prediction each count as an observation.
- 71 tests (signal math fixtures, service over a small ledger, backfill job, price-history adapter).

## [1.6.0] — 2026-09-16 — Markets in the ledger
Step two of [docs/PREDICTION_MARKETS.md](docs/PREDICTION_MARKETS.md): a prediction can point at a market, and the app remembers what the market said. Still read-only.
### Added
- Migration 008: `markets` (venue id, question, resolution rules, outcomes with token ids, event, end date, flags, watched), `market_snapshots` (per-outcome price / bid / ask, liquidity, volume, 24 h volume, spread, retrieved at), `prediction_market_links` (side, 0–1 score, relation, rationale, status proposed / accepted / rejected, matched by, price at made-on date). Export includes markets and links.
- Job `market.match` (per prediction): venue search from the prediction's entities/statement (sports: the two nicknames), deterministic scoring — sports picks: both teams in the event/question, game date vs market end, pick type vs market wording (moneyline / spread / total) → **exact**; general predictions: content-token overlap, entity hits, shared numbers (years ignored), deadline proximity, negation → implied Yes/No — then, for general predictions only, one assessment-stage model call labels the top three candidates *same / narrower / broader / different* with a one-line rationale and adjusts the score. Proposals are written; an exact sports matchup is auto-accepted when Setup allows (default on); everything else waits for you. The implied side's price from the snapshot taken at link time is stored as `priceAtMade` (history backfill is 1.7).
- Job `market.snapshot`: refreshes every watched or linked open market (budgeted, rate-limited) and appends a snapshot. Automatic on the Setup → Markets interval (default 6 h, 0 = manual) while the app runs; also on demand.
- Routes: `GET /api/markets/stored[/:id]`, `POST /api/markets/watch`, `POST /api/markets/stored/:id/unwatch`, `DELETE /api/markets/stored/:id`, `POST /api/markets/snapshot`, `GET /api/predictions/:id/market-links`, `POST /api/predictions/:id/market-links/match`, `POST /api/predictions/:id/market-links` (manual link by slug/id/URL + side), `POST /api/market-links/:id/accept|reject`, `DELETE /api/market-links/:id`.
- UI: **Markets** tab in the prediction detail (Find markets, proposed / linked / rejected with side, current price, price when the claim was made, liquidity, match score and rationale; accept / reject / remove; link by hand), a **Markets** page (venue search → watch, table of stored markets with latest snapshot, detail with rules, price history and linked predictions, refresh), and Setup → Prediction markets (enable, refresh hours, budget, auto-link sports).
- Provider registry with a test seam; 66 tests (scorers, match job for general + sports, snapshot job, watch/unwatch/delete cascade).
### Notes
- Matching is a proposal, not a judgement: the rationale always says which terms, entities, numbers and dates lined up. A market's resolution rules are shown next to every link so you can check the two mean the same thing before accepting.

## [1.5.0] — 2026-09-15 — Prediction markets: read-only Polymarket connector
First step of the market integration described in [docs/PREDICTION_MARKETS.md](docs/PREDICTION_MARKETS.md) (releases 1.5 → 1.8: connector → markets in the ledger → creator-vs-market signals → multi-channel consensus and watchlists). Nothing is stored yet and nothing can trade.
### Added
- `MarketProvider` interface (`server/src/providers/markets/types.ts`): `search`, `get`, `list`, `book` — read-only, probabilities 0–1, snapshots stamped with `retrievedAt`.
- Polymarket adapter over the public Gamma and CLOB APIs (no account, no key; verified live 2026-09-15): normalises Gamma's JSON-string fields (`outcomes`, `outcomePrices`, `clobTokenIds`), flattens events → markets for search and tag listings, reads order books and midpoints. Trading endpoints are deliberately not wrapped. Stubbed-fetch tests.
- `npm run markets -- search|tag|market|book …` probe script.
- `GET /api/markets/search?q=`, `GET /api/markets?tag=`, `GET /api/markets/:provider/market/:id`, `GET /api/markets/:provider/book/:tokenId` — pass-through, gated by Setup → Privacy → internet; venue errors surface as `502 market_api`.
- ADR-025.

## [1.4.0] — 2026-09-14 — Game records: winner, score, date — one look-up per matchup
Owner rule: in Sports Mode, validation is just "who won, what was the score, on what day". Four picks on "Bills vs Chiefs" should reconcile against one fact — *Bills and Chiefs played on X, final Y–Z* — and each pick is then matched to it. Nobody publishes a false final score, so no deep research.
### Added
- **Game records** (`games` table, migration 007; `GET /api/games`, `/api/games/:id`; included in the JSON export): one row per real game — teams, date/time, status (`final` / `scheduled` / `postponed` / `unknown`), final scores, overtime, winner, the source page, the verbatim score line it was read from, and how it was found. Predictions carry `gameId`.
- Job `sports.resolve_game` replaces the 1.3.1 date job and the plan → research → assessment chain for picks. It reuses a stored final for the matchup when one exists; otherwise two budgeted searches ("A vs B final score …", "A B box score …"), then a deterministic score reader over result snippets and up to three fetched pages (trusted hosts first): a line naming both teams and free of betting/preview words yields a score from "Team 27, Team 20" or "27-20" beside a win verb; "final" adds weight; ties are ambiguous; records like "(2-0)" are ignored; postponed wording is reported. The date comes from the same text (1.3.1 parser) or one page read. Only when the parser finds nothing does the assessment-stage model read the same pages, and its excerpt must appear verbatim in the page text. No score anywhere → the game is stored as scheduled/unknown and the picks stay pending; nothing is invented.
- **Settlement by rule** (`settlePick`): moneyline → winner; spread → margin + line; total → sum vs line; equal → push; tie game → push for moneyline. Every pick on the matchup — the four from one video, or the same game across videos — gets a verdict from the same record: provider `app`, template `sports_settlement.v1`, one evidence item (the score line, tied to the pick's component), confidence high from a trusted host, medium otherwise. Picks whose date was unknown pick up the game date (`deadlineBasis: lookup`).
- **Validate all scores** button on the Predictions page when a video is selected (`POST /api/videos/:id/validate-scores`): one job per distinct matchup, all picks reconciled.
- Detail panel shows the game record: score, winner, date, source link, the quoted score line, and how it was found.
### Changed
- `POST /api/predictions/:id/validate-score` returns `202 { stage: "game" }` and accepts `{ recheck: true }` (Re-validate forces a fresh look-up instead of reusing the stored record). Still `409 game_pending` before a known game date.
- The 1.3.1 `sports.resolve_date` job and `sports_assessment` model settlement are superseded for picks (the research path still exists for general predictions and remains callable). 59 tests.

## [1.3.1] — 2026-09-12 — Validate scores finds the game date itself
Owner report: a Week-1 picks video (published 2026-09-09) produced 16 picks with *deadline unknown* because the transcript never says a date ("Week 1", "Sunday Night Football"), so Validate scores refused with `game_date_unknown`. The button now resolves the date from the published schedule.
### Added
- Job `sports.resolve_date`: searches for the schedule (two budgeted queries built from the teams, league, the spoken hint and the video's season), parses the game date/time out of result snippets first and then out of fetched schedule pages (trusted hosts first) with a deterministic parser — a date counts only when both team names sit on its line or in the rows under it, inside a 14-days-before / 45-days-after window around the video date, and a tie between two plausible dates is treated as *not found* rather than guessed. Only when the parser finds nothing does the assessment-stage model read the same page text, under an instruction to report a stated date or null. No date anywhere → the job fails with the old edit-the-deadline message; nothing is invented.
- The resolved date is written back with deadline basis **`lookup`**, the pick records `eventDateSource: "lookup"` and the page URL, the component and normalized statement pick up the date, the "Game date not stated" ambiguity is replaced by a note naming the source, and a revision (`schedule-lookup`) preserves the previous state. When the game is already played the settlement chain (plan → box score → verdict) continues automatically; a future date leaves the pick as *Deadline pending*.
- Extraction captures `event_hint` ("Week 1", "Thursday night opener") verbatim for picks with no stated date; it drives the schedule query and shows in the detail panel. Never converted into a date by the model.
- `POST /api/predictions/:id/validate-score` on a dateless pick now answers `202 { stage: "schedule" }` instead of `409 game_date_unknown`; the dashboard follows the extra hop.
### Changed
- The settlement plan for a pick whose deadline was set by hand uses that date in its score queries.
- 57 tests (5 new: parser windows/years/ties/formats, snippet path, page path, model fallback, honest failure).

## [1.3.0] — 2026-09-12 — Sports Mode and Validate scores
Owner request: a Setup switch that treats videos as game-pick content, a one-click **Validate scores** action that settles a pick from a trusted box score, and a toggle for whether point spreads are tracked.
### Added
- Setup → **Sports Mode** (`sports.enabled`): extraction is told the video is game-pick content — every game prediction comes back as *team vs team* with the pick type and the game as the deadline; analysis chatter is ignored. Game time (`eventTime`) is captured when spoken.
- Setup → **Track point spreads** (`sports.trackSpreads`, default on). Off = a spread pick is recorded as a win/loss pick on the named team (noted in the prediction's ambiguities).
- **Validate scores** button on sports picks (replaces Research for that kind): `POST /api/predictions/:id/validate-score` chains code-written plan → capped search → settlement verdict in one click; refused before the game date (`409 game_pending`) or when the game date is unknown.
- Trusted score sources: results from league sites, ESPN, AP, CBS/Fox/NBC/Yahoo Sports, BBC/Sky, the *-Reference sites, Flashscore/Sofascore are ranked first and, when present, are the only ones fetched; the run's coverage notes say which case applied.
- Predictions table reads picks as bets settle: **Hit ✓ / Miss ✗ / Push / No final score yet**.
### Changed
- `normalizeSportsPick` accepts `trackSpreads`; tests extended (spread toggle, trusted-host filter, Sports Mode prompt steer). 52 tests.

## [1.2.0] — 2026-09-12 — Sports picks
Product rule (owner): a prediction about a single game reduces to who wins, the spread, or the total, and validation is "did it happen after the game date" — no deep research.
### Added
- Extraction: rule 8 in the extraction prompt plus a `sports_pick` field (sport, teams, game date if stated, pick type moneyline/spread/total, team, line, side). Season-long claims stay ordinary predictions.
- Predictions gain `kind` (`general` | `sports_pick`) and `sportsPick`; migration 006. Deadline for a pick is the game date (`rule:event`) and the single component is the settleable pick.
- Validation plan for picks is built by code (`plan.sports.v1`, provider `app`): settlement rules (win / cover / over-under, push handling), score look-up queries, "no previews or odds" research prompt. No model call.
- Research budget for picks capped at 3 searches / 3 sources regardless of Setup limits.
- Assessment for picks uses the `sports_assessment` template (settlement, not judgement): supported = hit, contradicted = miss, partially supported = push/draw, insufficient = no final score yet. Same output schema, so the verdict guard, history, and dashboard apply unchanged.
- Dashboard: sports chip on the row (e.g. `NFL · Kansas City Chiefs -3.5`), Kind filter, pick card in the detail panel; `GET /api/predictions?kind=`.
- Fixture `fixtures/transcripts/nfl-picks.*` (spread, moneyline, total, plus a season-long claim) and tests for normalisation, the deterministic plan, and the full pipeline (52 tests).
### Changed
- Evidence the model did not tie to a component is attributed to the prediction's only future claim when there is exactly one (guard G2 previously ignored it).

## [1.1.2] — 2026-09-12 — First live model call
### Fixed
- Anthropic adapter: current Claude models reject `temperature` (HTTP 400 "`temperature` is deprecated for this model"); it is no longer sent. Forced tool use already yields structured output.
- OpenAI-compatible adapter: reasoning models reject `temperature` and require `max_completion_tokens`; on a 400 naming the parameter the request is adapted and retried once per parameter. LM Studio and classic models still receive the requested temperature. Unrelated 400s surface unchanged.
- Tests: adapter request shapes against a stubbed `fetch` (49 tests).
### Verified on the real machine (Windows 11, Node 26.7)
- `npm start` → dashboard; **YouTube import end to end** (yt-dlp installed from Setup, `--js-runtimes node` accepted, auto captions fetched) — spike S-4 answered; Anthropic key saved and a live request reached the API.

## [1.1.1] — 2026-09-12 — Server type fix from the first clean rebuild
### Fixed
- Server: `completeStructured` declared its schema as `z.ZodType<T>`, which requires the schema's *input* type to equal its *output* type; every schema with `.default()` fields (extraction, plan, evidence, assessment) violates that, so a real `tsc` failed with four TS2322 errors. Now `z.ZodType<T, z.ZodTypeDef, unknown>`. Not caught earlier because the sandbox typechecks against a stand-in Zod typing, and because `tsc` still emits JavaScript on type errors — the rc.1 folder's `server/dist` existed despite the errors, which misled the earlier "server compiled cleanly" note.
### Verified on the real machine (Windows 11, Node 26.7, fresh extract)
- `npm install` (210 packages) and the `shared` build. Server and web builds re-run pending.

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
