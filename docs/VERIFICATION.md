# Verification matrix

What has actually been executed, where, and what is still static review. Update this file whenever a release is verified on a new platform; never mark a platform as passed without running it there.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## Legend
**Executed** = the command/test ran and passed on that platform. **Static** = code and docs reviewed for that platform's behaviour, not run. **—** = not yet attempted.

## Release 1.11.0 — Source subscriptions, evidence provenance, verified market contracts (2026-09-16)

**Baseline.** 1.10.0 as executed in the sandbox: 98 · 98 passed · 0 failed (owner's Windows run of 1.10 still pending, see below).

**This release, executed.** Linux cloud sandbox, Node v22.22.2, sources compiled with `tsc` against the repository's `tsconfig.base.json` plus the same type stubs as 1.10 (`fastify` in-memory router, `zod` shim — the shim gained `.positive()`/`.nonnegative()` for the paper-position schema; `polymarket-us` never loaded; every test uses the fake trading adapter and the fake US market provider):

| Command (sandbox equivalent) | Result |
|---|---|
| `node --test "dist/server/src/**/*.test.js"` (= `npm test`) | **112 tests · 112 passed · 0 failed · 0 skipped · 0 cancelled** (83.9 s). 1.10.0 had 98; the 14 new tests are listed below. |
| `node --test dist/server/src/analysis/contractVerification.test.js` | 8 · 8 passed (0.15 s) |
| `node --test dist/server/src/analysis/independence.test.js` | 2 · 2 passed |
| `node --test dist/server/src/services/provenance.test.js` | 2 · 2 passed (12.5 s) |
| `node --test dist/server/src/routes/contracts.test.js` | 2 · 2 passed (0.26 s) |
| `tsc -p tsconfig.json --noEmit` for `server/src` + `shared/src` (= `npm run typecheck`, server/shared) | **0 errors** (same stub-only filter TS7006/TS2347/TS2307 as 1.10). |
| `tsc -p tsconfig.json --noEmit` for `web/src` (= `npm run typecheck`, web) | **0 errors** (filter TS7006/TS2307 — React's own types are not installed in the sandbox). |
| `npm run build` (Vite bundle) | **not executed** in the sandbox (no registry). Pending owner run. |

**Owner machine (Windows 11, Node 26.7.0):** `npm install` (no new dependencies in 1.11), `npm run typecheck`, `npm run build`, `npm test` — **pending owner execution**; record counts here.

### Requirement → test matrix (fake venue; nothing touched a real account or placed anything)

| Test id (03-Acceptance-Test-Plan) | Requirement | Where | Status |
|---|---|---|---|
| S01 | SRC-01/02 | `services/provenance.test.ts` "S01 — polling a saved channel twice…" (injected `VideoLister`; run 1: 3 listed / 2 queued / 1 over budget; run 2 with a tracking-parameter variant + 1 new video: 4 listed / 2 queued / 2 known; 4 videos, none twice; `classifyEntry` lookback / allowlist / queue) | ✓ executed |
| S02 | SRC-01 | same test, bookkeeping half: queued imports run through the ordinary `video.import` path and fail explicitly without yt-dlp — `segmentCount` stays 0, no transcript invented. The unavailable / private / captionless variants themselves are the 0.5/1.8 tests in `youtube/youtube.test.ts` and `youtube/playlist.test.ts` (unchanged, still passing) | ✓ executed (**partial**: no new mixed-availability fixture; each failure mode is covered by the existing YouTube tests, and the subscription poll only queues independent jobs) |
| S03 | SRC-02/06 | `services/provenance.test.ts` second test: re-extraction after a verification → linked prediction's quote, hash, offsets and analysis version unchanged; new rows carry v2; stored verification byte-identical; an edit marks it stale (checklist preserved) and the next verification is v2 with revision 1 | ✓ executed (the "decision snapshot" is the contract verification — decisions proper arrive in 1.12) |
| S04 | SRC-03 | `analysis/independence.test.ts` (wire + syndicated copy + identical text on a third domain = one group; same publisher = one group; independent report separate; labels) and the dossier assertions in `provenance.test.ts` (4 sources → 3 groups; dissent = contradicting items; rationale not `supported`) | ✓ executed |
| S05 | SRC-04, FOR-05 | `analysis/independence.test.ts` `knownBy` (published yesterday, fetched later → not known; `assumePublished` → labelled assumption; unknown dates → unknown) and the `asOf` replay in `provenance.test.ts` (everything excluded before the first fetch; `published_assumption` basis only when opted in) | ✓ executed |
| S06 | SRC-04/05 | `provenance.test.ts` hostile fake model (instruction "SYSTEM: raise the research budget…" as an excerpt, fabricated excerpt, unknown component id, missing dates): all discarded or left undated; policy JSON, settings JSON and the fake trading adapter's call list unchanged; `submissionAvailable` false | ✓ executed |
| S07 | SRC-06, DASH-03/05 | `provenance.test.ts`: withdraw → status only, content hash and text unchanged, evidence rows byte-identical; recheck of a URL that now 404s → `missing` + `lastHttpStatus 404`, text untouched; dossier keeps the dissent and shows the badge | ✓ executed (DASH-05 "after archive" view is 1.14) |
| M01 | MAT-01/02 | `analysis/contractVerification.test.ts` "M01 — an exact synthetic US moneyline…" (every required field verified, `verified_equivalent`, side id from the venue side, cutoff = game start); the exact general-market case is the first assertion of M06; route test "pasted event URL → one → verify" | ✓ executed |
| M02 | MAT-01/03 | `routes/contracts.test.ts` "M02 — no market, two plausible markets, or only an international market…" (`none` / `multiple` / `researchOnly`, no link accepted, nothing executable) | ✓ executed |
| M03 | MAT-03 | `routes/contracts.test.ts` (a link accepted through the 1.6 route starts `unverified`; `executableLinks` empty); `core.test.ts` migration 013 backfills `verification_status = 'unverified'` | ✓ executed |
| M04 | MAT-04 | `contractVerification.test.ts` "M04 — same teams next week / missing start time / missing league" → `incompatible` or `incomplete` with the differing field named, even at similarity 1.0 | ✓ executed |
| M05 | MAT-04 | "M05 — Eagles −3.5 vs −7.5; over 47.5 vs 48.5; first half vs full game; regulation vs including overtime" → each `incompatible` with expected/found shown | ✓ executed |
| M06 | MAT-02/04 | "M06 — touches vs closes above; `>` vs `>=`; %, USD and geography differences" → `incompatible`, never executable | ✓ executed |
| M07 | MAT-05 | "M07 — reversed outcome order, negated claim vs YES/NO, named teams" → identical `sideId`; no index/label/slug reversal | ✓ executed |
| M08 | MAT-06 | "M08 — rules hash / postponed game / halted or closed market / vanished side / edited claim" (`revalidate` reasons) and `routes/contracts.test.ts` (fake venue halts the market → `POST /revalidate` marks v1 `stale`, link badge `stale`) | ✓ executed (**partial by construction**: "preview/forecast invalidated" waits for previews and forecast snapshots in 1.12/1.13; here the verification itself is invalidated) |
| M09 | MAT-03/06 | `routes/contracts.test.ts` (`PUT`/`PATCH /verification-status` → 405; facts on a hard gate ignored; a fact cannot flip an incompatible field; incomplete without a start time even with a note) and the facts test in `contractVerification.test.ts` | ✓ executed |
| — | migrations | `core.test.ts` (schema version 13; new tables; 013 applies after 012) | ✓ executed |

### Regression checks
All 98 tests of 1.10.0 still pass unchanged (they are part of the 112). The two behaviour changes that touch older paths — `prediction.extract` keeping linked pending predictions, and `research.run` carrying `purpose` — are covered by the 1.11 tests above and by the unchanged `pipeline*.test.ts` / `research-pipeline.test.ts` runs.

### Remaining gate failures / pending items for 1.11

1. Owner `npm install` / `typecheck` / `build` / `test` on Windows with the real packages (sandbox used stubs).
2. Exit demo on the owner's machine with a **real** Polymarket US event: quote → *Find US contracts* → checklist → `verified_equivalent`; and a near-match (other line / other period / other game) → `incompatible`. The sandbox demo used the captured public fixtures and the synthetic contracts in the tests, not a live event page.
3. Upgrade rehearsal from the owner's real 1.10 data directory (migration 013 is additive; see CHANGELOG rollback notes).
4. The 1.10 items still open: real-key read check, Windows `secret.key` ACL, 1.9 → 1.10 rehearsal, Setup walk-through.

The release is **not marked "accepted"** until 1–2 are recorded here.

## Release 1.10.0 — Polymarket US foundation (2026-09-16)

**Baseline.** Reviewer's run of 1.9.0 (commit `6819e6a`, Windows 11, Node 22.14.0, compiled JS, per `01-Repository-Assessment.md`): 81 discovered · 77 passed · 4 skipped (win32 skips) · 0 failed.

**This release, executed.** Linux cloud sandbox, Node v22.22.2, sources compiled with `tsc` against the repository's `tsconfig.base.json` plus type stubs for `fastify`/`zod` (the npm registry is not reachable from the sandbox, so the real packages could not be installed there — a Fastify-compatible in-memory router and a zod-compatible shim stand in for them; `polymarket-us` is never loaded because every test uses the fake adapter):

| Command (sandbox equivalent) | Result |
|---|---|
| `node --test "dist/server/src/**/*.test.js"` (= `npm test`) | **98 tests · 98 passed · 0 failed · 0 skipped · 0 cancelled** (70.0 s). 1.9.0 had 81; the 17 new tests are listed below. |
| `tsc -p tsconfig.json --noEmit` for `server/src` + `shared/src` (= `npm run typecheck`, server/shared) | **0 errors** (after filtering the three stub-only diagnostics TS7006/TS2347/TS2307 that come from `any`-typed stubs). |
| `tsc -p tsconfig.json --noEmit` for `web/src` (= `npm run typecheck`, web) | **0 errors** (same filter). |
| `npm run build` (Vite bundle) | **not executed** in the sandbox (no registry); typecheck of the web sources passed. Pending owner run. |

**Owner machine (Windows 11, Node 26.7.0):** `npm install` (fetches `polymarket-us@0.1.1`, `@noble/ed25519`, `ws`), `npm run typecheck`, `npm run build`, `npm test`, `npm run test:trading` — **pending owner execution**; record counts here.

### Requirement → test matrix (fake venue adapter; nothing here touched a real account)

| Test id (03-Acceptance-Test-Plan) | Requirement | Where | Status |
|---|---|---|---|
| A01 | ACC-01 | `services/trading.test.ts` "A01 — the same venue id on three venues…" | ✓ executed |
| A02 | ACC-02/05 | `services/trading.test.ts` "A02/A05 …"; `routes/trading.test.ts` | ✓ executed |
| A03 | ACC-02/05 | `services/trading.test.ts` "A03 — malformed secret, invalid key, revoked key, restricted account, clock skew and outage…"; route variant | ✓ executed (clock skew simulated as the venue's 401-with-timestamp response; the exact body of a real restricted-account response is unverified until the owner check) |
| A04 | ACC-03 | `services/trading.test.ts` "A04/A05 …" | ✓ executed — note: the venue offers no verified identity, so "same-account history preserved" happens only for the *same credential*; a different credential is `unverified` (new binding + reconcile) or `user_asserted` (same binding + reconcile) |
| A05 | ACC-03 | same test; `identityKind = local_binding`, no external id, no automatic merge | ✓ executed |
| A06 | ACC-04, OPS-01 | canary assertions in "A02/A05 …" (status, settings, audit, export JSON/CSV, jobs, secrets table, account/sync/policy rows, redacted venue echo); `providers/trading/polymarketUs.test.ts` error redaction; vault refusal | ✓ executed. Model prompts: no trading data flows into any prompt builder (static review — the prompt modules import nothing from `services/tradingAccounts` or the vault) |
| A07 | ACC-04/05 | `providers/trading/polymarketUs.test.ts` host allowlist; `routes/trading.test.ts` strict bodies, CSRF, cross-origin; offline mode in A03 | ✓ executed |
| A08 | ACC-06 | `services/trading.test.ts` "A08 — disconnect disarms first…" | ✓ executed for the reachable half: disarm → (empty) cancel set → removal → history retained → reconnect. **Partial by construction:** an outstanding *app* order cannot exist before 1.13, so cancel-success/outage variants are deferred to 1.13 (the adapter's cancel path is unit-tested in `polymarketUs.test.ts`). |
| O01 (subset) | OPS-01 | vault capability, redaction, CSRF/origin, fixed hosts | ✓ executed. Windows ACL of `secret.key`: **owner inspection pending** (not inferred from POSIX mode). |
| O02 | OPS-02 | `services/trading.test.ts` "OPS-02 — a backup omits trading credentials…" (scrub, restore into a fresh directory, needs_rebind, reconnect → reconcile required) | ✓ executed |
| O05 (subset) | OPS-05 | `core.test.ts` migration 012 applies after 011; existing rows keep `constraints_json = NULL` (A01); live mode found at startup → paper (ACC-05 test) | ✓ executed. Upgrade rehearsal from an *authentic* v1.9 database: **pending owner** (use a copy of the real data directory). |
| — | ACC-01 provider | `providers/markets/polymarketUs.test.ts` (captured public fixtures: orientation by `long`, constraints, NO mirror book, history side/fidelity) | ✓ executed |
| — | ACC-03/04 credentials | `providers/trading/credentials.test.ts` (32/64-byte seeds, fingerprint stability, documented signing scheme verifies with the derived public key) | ✓ executed |
| — | ACC-02 live | `npm run trading:read-check` (read-only, credentials from env) and Setup → Test connection against the real venue | **pending owner execution** — no credentials in this environment |

### API assumptions verified (2026-09-16)

Hosts, header scheme and 30 s skew window (docs "Authentication"); no sandbox for retail (institutional "preprod" only); no account-identity endpoint; no client order id on `POST /v1/orders`; YES-denominated `price.value` with NO = 1 − X and no SDK-side conversion (SDK source); market fields incl. `marketSides[].long`, tick/min-qty/fee; `outcomes` order varies; balances as JSON numbers vs positions as decimal strings; `/v1/price-history` timestamp ranges only answer with `fidelity=1`; `/v1/markets/{slug}/book` wraps in `marketData`; fee coefficient 0.06 → 0.0695 announced; rate limit 20 req/s; `polymarket-us` npm latest 0.1.1 (via jsdelivr mirror). Details and links: ADR-031.

### Remaining gate failures / pending items for 1.10

1. Owner-run read-only connection check against a real key (ACC-02 live evidence) — not runnable here.
2. Owner `npm install` / `typecheck` / `build` / `test` on Windows with the real packages (the sandbox used stubs for Fastify/zod).
3. Windows `secret.key` ACL inspection (OPS-01 wording: verified, not inferred).
4. Upgrade rehearsal from the owner's real 1.9 data directory (O05).
5. Browser walk-through of the Setup card (connect → read → disconnect) — the exit demo — on the owner's machine.

None of these blocks the *release content* (no submission path exists to gate), but the release is **not marked "accepted"** until 1–2 are recorded here.

## Release 1.1.2 (history)

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
