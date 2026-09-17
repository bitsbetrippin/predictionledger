# Verification matrix

What has actually been executed, where, and what is still static review. Update this file whenever a release is verified on a new platform; never mark a platform as passed without running it there.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## Legend
**Executed** = the command/test ran and passed on that platform. **Static** = code and docs reviewed for that platform's behaviour, not run. **—** = not yet attempted.

## Release 2.0.0-rc.1 — Review fixes, upgrade rehearsal, key-file ACL, soak/qualification reports, requirement audit (2026-09-17)

**Status: RELEASE CANDIDATE, not 2.0.0.** The pack's exit evidence for 2.0 is "upgrade/restore drill, qualification evidence, Windows verification, scoped owner-run live checks, no unresolved P0/P1". What this build has: the drills and reports as executable code, executed in the sandbox against the fake venue and an authentic 1.9.0 database; all fourteen review findings fixed with regression tests. What it does not have (owner execution required): Windows on real content, the capped live smoke test, the real seven-day soak, a production qualification, the rehearsal on the owner's real data. Those are listed plainly at the end; none is waived.

**Baseline.** 1.14.0 as executed in the sandbox: 170 · 170 passed · 0 failed.

**This release, executed.** Linux cloud sandbox, Node v22.22.2, sources compiled with `tsc` against the repository's `tsconfig.base.json` plus the same type stubs as before (`fastify` in-memory router, `zod` shim; the pinned `polymarket-us@0.1.1` loaded for the SDK test with `fetch` stubbed). Every order in every test goes to the fake venue; **no real credential was used and no production order was placed.**

| Command (sandbox equivalent) | Result |
|---|---|
| `node --test "dist/server/src/**/*.test.js"` (= `npm test`) | **193 tests · 193 passed · 0 failed · 0 skipped · 0 cancelled** (1.14.0 had 170; 23 new, listed below). |
| `node --test dist/server/src/services/review20.test.js` | 14 · 14 passed (≈ 1.5 s) — RV-01, RV-02 (a+b), RV-03, RV-04, RV-05, RV-06, RV-08 (pure + venue), RV-09, RV-10/14, RV-11, RV-12, RV-13, and the production-evaluation record route |
| `node --test dist/server/src/db/upgrade.test.js` | 4 · 4 passed (≈ 0.6 s) — O05 fixture authenticity, interrupted-and-rerun upgrade, RV-07 scrubbed pre-migration backup, drill on the upgraded data |
| `node --test dist/server/src/security/keyFileAcl.test.js` | 3 · 3 passed — icacls parser and judgement on captured output; POSIX branch on this platform |
| `node --test dist/server/src/services/soak.test.js` | 2 · 2 passed (≈ 2.4 s) — compressed seven-day paper-autopilot harness with faults; qualification report says *pending* |
| `node scripts/upgrade-rehearsal.mjs <1.9 db> --interrupt-after 14` (sandbox, dist symlinked) | RESULT: OK — 11 → 16, legacy rows and columns intact, live disarmed, pre-migration backup scrubbed, 24 tables 680 → 680 rows |
| `tsc -p tsconfig.json --noEmit` server/shared and web (= `npm run typecheck`) | **0 errors** (stub filters as before). |
| `npm run build` (Vite bundle) | **not executed** in the sandbox (no registry). Pending owner run. |

**Owner machine (Windows 11, Node 26.7.0):** `npm install`, `npm run typecheck`, `npm run build`, `npm test`, `npm run doctor` (key-file ACL line), `npm run upgrade:rehearse -- <real 1.9 db>` — **pending owner execution**; record here.

### Code review of the execution path (1.13 + 1.14) — findings and fixes

A structured review (priorities: wrong venue/side, unauthorized send, duplicate orders, ambiguous timeout recovery, overspending, leakage, lost rationale, fill/settlement accounting, migration/restore) read the implementation and the test assertions. Verified correct without change: NO→YES price conversion exactly once (`wirePriceFor` → `toVenueCreateBody`, confirmed against the venue's Orders overview: "`price.value` always represents the long side's price"), side mapping by the venue's `long` flag, the single `createOrder` call site behind T1/T2, opportunity PK + in-transaction recheck, unknown-submission handling, caps/sizing, execution dedupe, official-only settlement, secret confinement, rationale immutability, additive 016 + startup disarm. Findings:

| ID | Sev. | Finding | Fix | Regression test |
|---|---|---|---|---|
| RV-01 | P1 | Authorized (strategy, category) stored but never enforced; a production qualification for another category made forecasts "qualified" for the scheduler | `authorized_scope` gate in `decide()` (auto-live), fed by the decision service and by preview/submit re-decision | `review20` RV-01; `tradeDecision.test` gates |
| RV-02 | P1 | Second process's `recoverAfterCrash` marked an in-flight submission unknown; T3 then flipped it to acknowledged leaving an unresolvable hold; T2 never checked its UPDATE moved a row | Recovery only while holding the lease (deferred otherwise); T2 aborts unless `changes === 1`; T3 guarded and resolves a meanwhile-opened hold; `finishUnsent` conditional | `review20` RV-02 (a: in-flight + second process; b: expired between T1 and T2 → no POST) |
| RV-03 | P2 (blocks real use) | `now` captured before the book/sync fetch → negative ages → every real decision `BOOK_STALE` | Instant taken after inputs (evaluate, redecide, preview, submit; scheduler passes no pinned clock); 2 s skew tolerance | `review20` RV-03 (stepping clock; evaluate → preview → submit → fill); `tradeDecision.test` skew bounds |
| RV-04 | P2 | `positionResolution.side` semantics undocumented (winning side vs account side) | Cross-check against the venue's realized amount; contradiction → `discrepancy` hold `settlement:<activity>` + alert (pause) | `review20` RV-04 (consistent → no hold; contradicted → hold, paused, alert) |
| RV-05 | P2 | Activities newest-first → original/correction labels swapped | Sort ascending before applying | `review20` RV-05 |
| RV-06 | P2 | Daily loss stop compared a UTC date with a budget-timezone bucket | Per-row bucket in the budget timezone | `review20` RV-06 |
| RV-07 | P2 | Pre-migration backups were raw copies (credentials + armed grant) | `scrubTradingFromCopy` on the copy in `runMigrations` | `db/upgrade.test` (armed 15-schema copy → 016; backup has no `trading.%` secret, mode paper) |
| RV-08 | P2 | External SELL orders signed as buys in position reconciliation | `signedFilledQuantity(intent, side, filled)` (action × side); fake venue supports sells | `review20` RV-08 (pure + venue: 19 held, 6 sold on the website → 13, no hold) |
| RV-09 | P2 | Manual indicator followed the decision's mode, not the sender | `preview(id, { origin })`; owner → MANUAL, scheduler → AUTOMATIC | `review20` RV-09 |
| RV-10 | P2 | `resolveUnknown` linked any order id | Same contract, same side, matching quantity required | `review20` RV-10/14 |
| RV-11 | P2 | Qualification could never be revoked | Newest production record decides (`qualificationFor`, `productionQualification`, `qualifiedCategories`) | `review20` RV-11 |
| RV-12 | P2 | 429 classified "not created" → opportunity freed → possible second entry | 429 is ambiguous (unknown submission, held) | `review20` RV-12; `polymarketUs.sdk.test` classification |
| RV-13 | P2 | Emergency stop did not wait for the in-flight POST | Bounded wait (25 s) for in-flight dispatches before the sweep | `review20` RV-13 (resting order, 250 ms response delay, cancelled by the stop's own sweep) |
| RV-14 | P2 | A linked order without a side settled its reservation as released | Refuse to link an order whose side is unknown (`order_side_unknown`) | `review20` RV-10/14 |
| (harness) | — | FOR-06 threshold counted settled *decisions*, not distinct events | `evaluateForecasts` uses distinct groups; unscorable forecasts never scored | `forecast.test` F08 (100 decisions on 25 events → not qualified); `soak.test` |

No P0 was found. No P1 or P2 finding remains open.

### Requirement audit — every requirement in 02-Development-Requirements against executable tests and owner evidence

Executed = passing automated test in the sandbox (fake venue). Owner = evidence only the owner can produce (real account, real content, Windows, real time). The 2.0 exit needs both columns green; the right column is what keeps this build an RC.

| Req. | Executable evidence (test ids · file) | Owner evidence |
|---|---|---|
| ACC-01 | A01 `trading.test` (distinct records per venue; only US enters execution); `core.test` migrations | — |
| ACC-02 | A02/A03 `trading.test`, `routes/trading.test` (test/save/status/errors, zero order calls) | **pending**: real-key read check `npm run trading:read-check` (SETUP §1, Polymarket US account) |
| ACC-03 | A04/A05 `trading.test` (rotation continuity, no invented identity) | **pending**: rotation on the real portal |
| ACC-04 | A06/A07 canary tests; O01 `keyFileAcl.test`; redaction in `trading.test`, `automation.test` D03 | **pending**: `npm run doctor` ACL line on Windows |
| ACC-05 | A02, E01 mode gates, U01 arming gates; `review20` RV-01 | — |
| ACC-06 | A08 `trading.test` (disconnect disarms, targeted cancel, history kept) | — |
| SRC-01…06 | S01–S07 `provenance.test`, `independence.test`; subscriptions in `automation.test` U02 / `autopilot.e2e.test` | **pending**: real channel poll on the owner's machine |
| MAT-01…06 | M01–M09 `contractVerification.test`, `provenance.test`; `autopilot.e2e.test` (match → verify); revalidation in `automation.test` | **pending**: exit demo on a real US event (1.11 exit demo, still open) |
| FOR-01…05 | F01–F07 `forecast.test`, `decisions.test` (leakage, replay hash, invalid values) | — |
| FOR-06 | F08 (`forecast.test`, incl. distinct-event count), `review20` RV-11, `soak.test` qualification pending | **unmet gate**: no production qualification exists |
| FOR-07 | F09 `forecast.test`; `reports.qualification` (`soak.test`) | **pending**: the owner's qualification report on real data |
| FOR-08 | F10/F11 `decisions.test`, `paperUs`; `soak.test` paper autopilot | **pending**: real seven-day soak |
| RSK-01…07 | R01–R10 `tradeDecision.test`, `decisions.test`, live R07 `execution.test`; `review20` RV-03 (freshness on a real clock), RV-06 (loss bucket) | — |
| EXE-01 | E01/E03 `execution.test`; `polymarketUs.sdk.test` (pinned SDK body, classification) | **pending**: capped smoke test (§4.14) |
| EXE-02 | E01/E02 `execution.test`; `review20` RV-09 (indicator) | **pending**: §4.14 |
| EXE-03 | E04 `execution.test`, U03 `automation.test`; `review20` RV-02 (b), RV-12 | — |
| EXE-04 | E05/E06 `execution.test`; `review20` RV-02 (a), RV-12; `db/upgrade.test` drill (recovered by the next start) | — |
| EXE-05 | E07 `execution.test`; `review20` RV-10/14 | — |
| EXE-06 | E08/E09/E10 `execution.test`; `orderState.test`; `review20` RV-08 | — |
| EXE-07 | E10/E11 `execution.test`; `review20` RV-05 | — |
| EXE-08 | E12 `execution.test`; `review20` RV-04 (contested settlement) | **pending**: first real settlement (resolves the RV-04 gap) |
| AUTO-01 | U01 `automation.test`; `routes/trading.test`; `review20` RV-01, RV-11 | **unmet gate**: qualification |
| AUTO-02 | U02/U03 `automation.test`, `autopilot.e2e.test`; `soak.test` (bounded, per-source, one entry) | **pending**: real soak |
| AUTO-03 | U04 `automation.test`; `review20` RV-13 | **pending**: §4.15 walk-through |
| AUTO-04 | U05 `automation.test`; `db/upgrade.test` drill (restart disarms, no catch-up) | — |
| AUTO-05 | U06 `automation.test`; `review20` RV-12; `soak.test` (faults, alerts) | — |
| DASH-01…05 | D01–D04 `automation.test`, `execution.test`; D02 `current` block | **pending**: browser walk-through (§4.15) |
| OPS-01 | A06/A07; O01 `keyFileAcl.test` (parser, POSIX branch); CSRF/SSRF tests in `core.test`, `research.test`, `routes/trading.test` | **pending**: Windows ACL verified by `npm run doctor` on the owner's machine |
| OPS-02 | O02 `execution.test`, U05, `db/upgrade.test` (RV-07 scrubbed pre-migration backup; restore → needs rebind) | **pending**: restore drill on the owner's machine (§4.16) |
| OPS-03 | O03 `execution.test`, `automation.test`; `review20` RV-02 | — |
| OPS-04 | O04 `automation.test` (10,010 decisions: 73.6 ms / 3.1 ms / 5.3 ms, sandbox); `/api/trading/metrics` | **pending**: timing on the owner's machine |
| OPS-05 | O05 `db/upgrade.test` (authentic 1.9.0 fixture, interrupted + rerun, byte-level inventory, isolation, disarmed); `npm run upgrade:rehearse` | **pending**: rehearsal on the owner's real 1.9 data |

### O01–O07 status

| Test | Status |
|---|---|
| O01 | ✓ executed (parser/judgement, POSIX branch, redaction canaries, loopback/CSRF/outbound tests of earlier releases) · **Windows ACL pending owner** (`npm run doctor`) |
| O02 | ✓ executed (1.13 O02, U05, `db/upgrade.test`: pre-migration backup scrubbed, restore → needs rebind, unknown intent still unknown) |
| O03 | ✓ executed (1.13/1.14 O03; RV-02 adds the recovery guard and marker check) |
| O04 | ✓ executed on the sandbox machine · **owner machine timing pending** |
| O05 | ✓ executed on an **authentic 1.9.0 database produced by the 1.9.0 code** (fixture) · **owner's real data pending** (`npm run upgrade:rehearse`) |
| O06 | ✓ sandbox suite/typecheck (193/193) · **Windows suite/build and real transcript/video checks pending owner** |
| O07 | harness ✓ executed (compressed seven days, faults, report checks, injected duplicate caught) · **the real seven-day soak pending owner** (SETUP §4.16) |

### Remaining mandatory checks (why 2.0.0-rc.1 is not 2.0.0)

1. Owner `npm install` / `typecheck` / `build` / `test` on Windows with the real packages; `npm run doctor` showing the key-file ACL as OK.
2. `npm run upgrade:rehearse -- <the owner's real 1.9 prediction-ledger.db>` → RESULT: OK, pasted here.
3. The 1.13 capped smoke test (§4.14) and the 1.14 acceptance walk-through (§4.15), fake venue first.
4. The **real** seven-day paper soak in paper autopilot on real venue data (§4.16) and its report attached under `docs/reports/`.
5. A **production qualification** for at least one (strategy version, category) pair from ≥ 100 distinct settled real events with a market baseline — the qualification report must say *qualified* and the owner must record it deliberately; until then `/api/trading/arm` answers `409 strategy_qualified` and automation is unavailable. Insufficient data is reported as an unmet gate, not waived.
6. The first real settlement observed with `positionResolution.side` and the realized amount (RV-04's documented gap).

## Release 1.14.0 — Automatic execution behind arming, pause / emergency stop, alerts, the Trades ledger (2026-09-17)

**Baseline.** 1.13.0 as executed in the sandbox: 161 · 161 passed · 0 failed (owner's Windows runs of 1.10–1.13 still pending, see below).

**This release, executed.** Linux cloud sandbox, Node v22.22.2, sources compiled with `tsc` against the repository's `tsconfig.base.json` plus the same type stubs as before (`fastify` in-memory router, `zod` shim; the pinned `polymarket-us@0.1.1` loaded for the SDK test with `fetch` stubbed). Every order in every test goes to the fake venue. **No real credential was used and no production order was placed.** The production qualification record that AUTO-01 requires was inserted **by SQL as a labelled test shortcut** (`automation.test.ts` / `autopilot.e2e.test.ts`); the application itself writes production records only from a passing evaluation over ≥ 100 settled events (F08).

| Command (sandbox equivalent) | Result |
|---|---|
| `node --test "dist/server/src/**/*.test.js"` (= `npm test`) | **170 tests · 170 passed · 0 failed · 0 skipped · 0 cancelled**. 1.13.0 had 161; the 9 new tests are listed below. |
| `node --test dist/server/src/services/automation.test.js` | 8 · 8 passed (≈ 4.6 s) — U01, U02 (pipeline half + slow-job isolation), U03, U04, U05, U06, D01/D03, O03+O04 |
| `node --test dist/server/src/services/autopilot.e2e.test.js` | 1 · 1 passed (≈ 4.7 s; fake yt-dlp + fake model + fake venues; skips on Windows / without ffmpeg) |
| `tsc -p tsconfig.json --noEmit` for `server/src` + `shared/src` (= `npm run typecheck`, server/shared) | **0 errors** (stub-only filter TS7006/TS2347/TS2307). |
| `tsc -p tsconfig.json --noEmit` for `web/src` (= `npm run typecheck`, web) | **0 errors** (filter TS7006/TS2307 — React's own types are not installed in the sandbox). |
| `npm run build` (Vite bundle) | **not executed** in the sandbox (no registry). Pending owner run. |
| O04 timing (inside `automation.test.ts`, sandbox machine) | ledger of 500 rows over **10,010** decisions: **73.6 ms** · summary **3.1 ms** · filtered query **5.3 ms** (target p95 < 1 s). |

**Owner machine (Windows 11, Node 26.7.0):** `npm install` (no new direct dependencies), `npm run typecheck`, `npm run build`, `npm test` — **pending owner execution**; record counts here. `autopilot.e2e.test.ts` skips itself on Windows (POSIX shell wrapper for the fake yt-dlp) — the same chain is covered by `automation.test.ts` U02 from the extracted pick onward.

### Requirement → test matrix (fake venue for every order; nothing touched a real account)

| Test id (03-Acceptance-Test-Plan) | Requirement | Where | Status |
|---|---|---|---|
| U01 | AUTO-01, ACC-05 | `services/automation.test.ts` "U01 — arming automation needs every gate…" → no qualification / no rehearsal → `strategy_qualified` + `paper_rehearsal`; a **fixture** qualification never counts; wrong category → `strategy_qualified`; wrong text → `live_authorization`; stale hash → `policy_reviewed`; `PUT /policy {auto_live}` → 409 and mode unchanged; `POST /arm` → `auto_live`, `authorizedPolicyHash` = the exact current hash, audit `policy.mode_changed` carries it; a budget edit disarms, clears the authorization, raises a `disarmed` alert, scheduler refuses | ✓ executed |
| U02 | AUTO-02 | `services/autopilot.e2e.test.ts` (end to end): saved channel polled → `video.import` through a **fake yt-dlp** (manual captions) → `prediction.extract` by a **fake model** (one sports pick; exactly one model call) → tick 1 queues `market.match` → the match finds the contract on the **fake US venue** and auto-accepts the exact matchup → tick 2 runs the computed checklist (`verified_equivalent`), builds a **qualified** forecast, an eligible `auto_live` decision and **one** venue create call with the automatic indicator; the audit graph links video → prediction → link → verification → forecast → decision → preview → intent → order → executions → audit events; tick 3 skips `opportunity_consumed`. `automation.test.ts` "U02 — from an extracted pick…": the same chain from the pick, plus a blocked job on the queue (concurrency 1) while a tick and a cancel complete in < 2 s | ✓ executed (**partial on Windows**: the e2e file skips there; the pipeline half runs) |
| U03 | AUTO-02, EXE-03 | "U03 — a consumed contract opportunity survives…" → re-run of the video, same-creator video, another creator, policy edit + re-arm, IOC-canceled entry (0 filled) and a second process on the same directory: `opportunity_consumed` every time, **one** create call in the whole test | ✓ executed |
| U04 | AUTO-03 | "U04 — an emergency stop racing a tick…" → three candidates, first POST held 300 ms in flight; stop lands mid-tick: exactly the in-flight create call, mode `paper` + `pauseReason`, the in-flight order's id persisted and cancelled (targeted), an external open order **never** targeted by the stop, positions retained, `emergency_stop` alert; afterwards ticks skip; `cancel-all` refuses without its own acknowledgement and cancels the external order with it | ✓ executed |
| U05 | AUTO-04 | "U05 — restart, a sleep past the cutoff, a restored older database, a credential rotation and a strategy change…" → clock past the cutoff: candidates `cutoff_passed`, never evaluated; a backup taken while armed with an in-flight intent restores as `paper`, no authorization, needs rebind, the intent becomes `submission_unknown` and is never re-sent; a different key → `trading.disarmed (credential change)`; a budget change disarms; **zero** create calls across all transitions | ✓ executed |
| U06 | AUTO-05 | "U06 — repeated adapter failures open the circuit breaker once…" → 5 consecutive 503s open it (state `open`, disarmed, blocker listed, tick skipped), **one** `circuit_breaker` alert without the secret; 429 and 401 count, 400 does not; a success inside the cooldown → `half_open`, after the cooldown → `closed` (audited); mode stays `paper` — no automatic re-arm | ✓ executed |
| D01 | DASH-01/02/04 | "D01/D03 — the ledger lists pending, partial, filled, unknown, rejected, external and settled rows…" → partial: intent `partially_filled`, order `canceled`, position `open`, fees .10, mark flagged stale; rejected with reason; unknown with position `unknown`; external rows with no rationale/quote/reason; skipped decisions listed; filters by status, mode, creator, reason, date, category; summary: buying power from the venue, unknown count, open positions, stale mark, holds/alerts, realized 0 without official settlement | ✓ executed (D01's "settled" rows are covered by 1.13 E12 through the same ledger join) |
| D02 | DASH-03 | 1.13 "D02 — editing the prediction after a live decision…" (immutable record); 1.14: `GET /api/trading/decisions/:id/evidence` returns `current` (latest revision, verification, forecast, dossier) beside the record; the Trades detail shows it under its own heading | ✓ executed (record immutability) · **static** (the `current` block is typechecked and rendered; no automated assertion on its contents yet) |
| D03 | DASH-02/05 | same test: `/api/trading/ledger?status=unknown`, `.csv` (one line per row, header, external line, no secret), `.json` (rows match the service), `/api/trading/metrics` counts match the tables | ✓ executed |
| D04 | DASH-05 | 1.13 "D04 — a video, prediction or market linked to a live order cannot be deleted…"; live history has no reset/delete route | ✓ executed (1.13) |
| O03 | OPS-03 | "O03 (scheduler) — a second process on the same database never dispatches without the lease…" → its tick is `skipped` with the lease reason and zero create calls; 1.13 O03 covers the marker transaction | ✓ executed |
| O04 | OPS-04 | same test: 10,000 synthetic decisions inserted; ledger / summary / filtered query timings above; `/api/trading/metrics` counters | ✓ executed (**sandbox machine only**; the owner's Windows timing is pending) |
| — | migrations | `core.test.ts` (schema version 16; three new tables; 016 applies after 015) | ✓ executed |

### Regression checks
All 161 tests of 1.13.0 still pass; two assertions were updated for the 1.14 contract: `services/trading.test.ts` (`features.automation` is `true`; the gate list gains `automation_feature`, `not_paused`, `breaker_closed`), `routes/trading.test.ts` (`/api/trading/arm` answers `409 gate_unmet` instead of `501`; `/api/trading/emergency-stop` and `/resume` are real).

### Remaining gate failures / pending items for 1.14

1. Owner `npm install` / `typecheck` / `build` / `test` on Windows with the real packages.
2. **Automation cannot be armed on a real data directory**: no production strategy qualification exists (≥ 100 settled events with a market baseline, FOR-06/07). The arming, scheduling and stop paths are verified with the labelled SQL shortcut only. Reported as an unmet gate, not waived.
3. The 1.13 capped owner-run smoke test (SETUP §4.14) is still pending; automation must not be armed before it has been done.
4. Paper soak (O07) — `automation.paperAutopilot` exists for it; not run.
5. The 1.10–1.13 items still open: real-key read check, Windows `secret.key` ACL, Setup walk-through, exit demos on a real US event, upgrade rehearsal from real data (016 is additive).

The release is **not marked "accepted"** until 1 and 3 are recorded here; automation stays unavailable until 2 is met.

## Release 1.13.0 — Manual-live execution: preview → confirm, venue orders, reconciliation, settlement (2026-09-16)

**Baseline.** 1.12.0 as executed in the sandbox: 138 · 138 passed · 0 failed (owner's Windows runs of 1.10–1.12 still pending, see below).

**This release, executed.** Linux cloud sandbox, Node v22.22.2, sources compiled with `tsc` against the repository's `tsconfig.base.json` plus the same type stubs as 1.10–1.12 (`fastify` in-memory router, `zod` shim). New in this run: the **pinned `polymarket-us@0.1.1` package itself** (its published `dist` plus its `@noble/ed25519` dependency) was loaded for `polymarketUs.sdk.test.ts` with the global `fetch` replaced by a capturing stub — so the request bodies, URLs and signed headers below are what the real SDK produced, with no network. Every other trading test uses the fake venue adapter. **No real credential was used and no production order was placed.**

| Command (sandbox equivalent) | Result |
|---|---|
| `node --test "dist/server/src/**/*.test.js"` (= `npm test`) | **161 tests · 161 passed · 0 failed · 0 skipped · 0 cancelled** (86.8 s). 1.12.0 had 138; the 23 new tests are listed below. |
| `node --test dist/server/src/services/execution.test.js` | 19 · 19 passed (≈ 1 s) — E01–E12, D01/D03, D02, D04, R07 (live), O02, O03, O01 |
| `node --test dist/server/src/analysis/orderState.test.js` | 3 · 3 passed |
| `node --test dist/server/src/providers/trading/polymarketUs.sdk.test.js` | 1 · 1 passed (**not skipped**: the pinned SDK was loaded) |
| `node --test dist/server/src/providers/trading/polymarketUs.test.js` | 4 · 4 passed (fake SDK module; assertion list updated for the 1.13 surface) |
| `tsc -p tsconfig.json --noEmit` for `server/src` + `shared/src` (= `npm run typecheck`, server/shared) | **0 errors** (stub-only filter TS7006/TS2347/TS2307). |
| `tsc -p tsconfig.json --noEmit` for `web/src` (= `npm run typecheck`, web) | **0 errors** (filter TS7006/TS2307 — React's own types are not installed in the sandbox). |
| `npm run build` (Vite bundle) | **not executed** in the sandbox (no registry). Pending owner run. |

**Owner machine (Windows 11, Node 26.7.0):** `npm install` (no new direct dependencies; `polymarket-us` already pinned), `npm run typecheck`, `npm run build`, `npm test` — **pending owner execution**; record counts here. On the owner's machine `polymarketUs.sdk.test.ts` runs against the installed package (it is not skipped there either).

### Requirement → test matrix (fake venue for every order; the pinned SDK with stubbed fetch for the wire shape; nothing touched a real account)

| Test id (03-Acceptance-Test-Plan) | Requirement | Where | Status |
|---|---|---|---|
| E01 | EXE-01/02 | `services/execution.test.ts` "E01 — preview shows the full rationale and cost…" → preview display = decision sizing (YES .50, 19 contracts, worst cost, fee bound, policy hash, evidence link), wire body `BUY_LONG` / `0.5` / `19` / IOC / manual, 60 s TTL, **zero** create calls until confirm; wrong hash `409 hash_mismatch` (service and route); strict body refuses `quantity`; right hash → one create call, `filled` 19, reservation consumed 9.5; a paper-mode decision cannot be previewed (`decision_not_live`) | ✓ executed |
| E02 | EXE-02, RSK-01 | "E02 — a changed price, a changed account, a policy edit or an expired preview…" → book .50→.55 `preview_stale` (preview consumed, no intent); consumed preview refused; buying power $1 `preview_stale`; limits edit disarms (`mode_not_live`), re-armed → `preview_stale` (policy hash); 61 s → `preview_expired`; zero sends | ✓ executed |
| E03 | EXE-01/06, MAT-05 | `analysis/orderState.test.ts` "E03 (pure)…" (NO .40 → YES .60 `BUY_SHORT`, YES .50 `BUY_LONG`, chosen cost 1 − YES, consumed-by-fills, guard rails); `polymarketUs.sdk.test.ts` (the **real SDK** posts `{"request":{…"intent":"ORDER_INTENT_BUY_SHORT","price":{"value":"0.6"…},"quantity":23…}}` to `/v1/order/preview` and the create body verbatim to `/v1/orders`, signed headers present, secret absent, no idempotency field); `execution.test.ts` "E03 — NO with a chosen-side limit of .40…" (book .60/.61 → cost .40, wire .60, 23 contracts = $10/(.40+.0244), fee bound .57, adapter called with `yesPrice 0.6`, fills recorded at chosen cost .40, position −23) | ✓ executed |
| E04 | EXE-03 | "E04 — a double-click, concurrent API calls and a repeated submit…" → one intent, one reservation, one create call; losers get the same intent or `preview_consumed`; a re-delivered preview skips (`OPPORTUNITY_CONSUMED`); a repeated confirm returns the same id | ✓ executed (same process; cross-process is O03) |
| E05 | EXE-04/05 | "E05 — a dropped POST response and a timeout before acceptance…" → both `submission_unknown`, marker committed, reservation `reserved`, one create call each, dispatch paused (`submissionAvailable false`, blockers listed), hold opened; repeat confirm returns the same intent; another decision's preview `dispatch_blocked`; reconcile lists **1 candidate** (external until proven) / **0 candidates**, never links, never resends; recovery adds nothing; owner links → `filled` 19, reservation consumed 9.88 (= 19 × .52); owner declares not submitted → `rejected_local`, reservation released, opportunity returned; pause lifted | ✓ executed |
| E06 | EXE-03/04, OPS-03 | "E06 — crashes before reserve, after reserve, after the marker and after the POST…" (fault injector in the production path) → before reserve: nothing persisted, preview reusable; after reserve: `reserved` without marker → recovery `expired`, capacity and opportunity released, no POST; after marker: `submitting` → recovery `submission_unknown`, no POST, reconcile 0 candidates, owner clears; after POST: one create call, recovery `submission_unknown`, reconcile 1 candidate, owner links → `filled`, **no double order** | ✓ executed |
| E07 | EXE-05 | "E07 — an unknown submission that resembles an external manual order…" → 2 same-looking candidates (the manual one from 11:59 and ours), no guessed association, no premature release, paused, hold note "not proof of identity"; both orders known through the stream so no discrepancy is invented; owner picks ours; the manual order stays `external` with no rationale | ✓ executed |
| E08 | EXE-06 | "E08 — the venue returns an id and then a rejected event…" → intent `rejected`, order `rejected` with `ORD_REJECT_REASON_INSUFFICIENT_FUNDS`, 0 fills, no position, exposure 0, reservation released; the opportunity stays consumed (no IOC retry) | ✓ executed |
| E09 | EXE-06 | `analysis/orderState.test.ts` "E09 (pure)…" and `execution.test.ts` "E09 — ten fills then an IOC cancel of the remainder, delivered twice with a stale open snapshot last…" → 10 fills once each (dedupe by execution/trade id), order `canceled` with 10 filled, fees .20, reservation consumed **5.2** exactly once, stale `open`/3 ignored, intent `partially_filled`, position 10 open, exposure 5.2; full redelivery changes nothing | ✓ executed |
| E10 | EXE-06/07 | "E10 — a cancel requested while the final fill arrives…" → `cancel_pending` → fill of 4 counted → `canceled`, intent `partially_filled` 4, cancel `requested` with `cancelRequestedAt`, reservation 2.08; paged activities (page size 1) with a reset on page 2: every page read, the failed page fetched again **with the same cursor**, no new executions, no discrepancy | ✓ executed |
| E11 | EXE-07 | "E11 — dropped stream events are recovered from REST…" → with the stream dropping everything, `GET /v1/order` + activities rebuild 10 filled (5 @ .50 + 5 @ .49, avg .495, fees .20), reservation 5.15, buying power 994.80 from the venue; replaying the dropped events adds only `new`/`canceled`, no fill twice; an external exit of 6 → venue 4 vs local 10 → `discrepancy` hold, paused; our fills are not rewritten; resolved → resumed | ✓ executed |
| E12 | EXE-08 | "E12 — only official account activity settles a live position…" → a .99 snapshot and the paper path's market-status settlement leave the live position open (no live lineage on that event); resolution activity → 2 events (market + intent) `resolved yes` amount **+9.5**, position `win`, decision hash unchanged; loss −9.5; void 0; a correction is a **new** `correction` event beside the original (original amount intact); today's realized loss is the net of official amounts; re-reconcile adds nothing | ✓ executed |
| D01 | DASH-01/02/04 | "D01/D03 — intents, orders (external labelled…)…" → intents in `filled`, `partially_filled`, `rejected`, `rejected_local`, `expired`; external orders without `intentId`; order detail with executions; settled vs open positions; lease held / stream open | ✓ executed (the remaining DASH filters/summaries are 1.14) |
| D02 | DASH-03 | "D02 — editing the prediction after a live decision…" → decision `rationaleHash`/sizing, the preview display and the intent's hashes unchanged | ✓ executed (the dossier immutability itself is 1.11 S03/S07) |
| D03 | DASH-02/05 | same test as D01: `/api/trading/export` and the JSON bundle counts match the tables; external order has no rationale; the canary secret appears nowhere; every audit stage present | ✓ executed |
| D04 | DASH-05 | "D04 — a video, prediction or market linked to a live order cannot be deleted…" → `409 live_lineage` on all three routes; paper reset leaves live rows unchanged; an unlinked video still deletes | ✓ executed |
| O01 | OPS-01, ACC-04 | "O01 — the canary secret never appears…" (status, intents, orders, holds, previews, audit, executions, exports, errors); `POST /api/trading/disarm` immediate and audited; no manual-live decision while disarmed; `polymarketUs.sdk.test.ts`: secret absent from URL/headers/body of every real-SDK request | ✓ executed (**partial**: Windows `secret.key` ACL, loopback and outbound-host checks are the 1.10 items, still owner-run) |
| O02 | OPS-02 | "O02 — a backup taken while armed with live lineage…" → no secret, mode `paper` / no authorization in the copy, every live intent/execution kept, binding `needs_rebind`; the live database untouched | ✓ executed |
| O03 | OPS-03 | "O03 — two processes on one database…" → the second process (`createContext` on the same directory, which disarms at start per OPS-02 — re-armed deliberately) cannot acquire a held lease; its submit is refused **before any POST** (`dispatch_blocked`, `rejected_local`, reservation released, opportunity returned); lease expiry hands over; the previous holder's marker transaction then refuses; the holder dispatches and the per-contract opportunity uniqueness holds across processes | ✓ executed |
| R07 (live) | RSK-05 | "R07 (live) — two confirmations racing on different contracts with capacity for one…" → the exposure is re-read and the pure decision re-run **inside the reserving transaction**; exactly one create call, the loser gets `preview_stale` with no reservation and no intent, open risk never exceeds the cap | ✓ executed (same process; cross-process is O03) |
| — | migrations | `core.test.ts` (schema version 15; six new tables; 015 applies after 014) | ✓ executed |

### API assumptions verified (2026-09-16, docs.polymarket.us + `polymarket-us@0.1.1` source)
`POST /v1/orders` body `{marketSlug, intent, type, price{value,currency}, quantity(number), tif, manualOrderIndicator}` → `{id, executions?}`; `price.value` is the **YES** price for `BUY_SHORT` too; `POST /v1/order/preview {request}` → `{order}`; `GET /v1/order/{id}` → `{order}` with `state ORDER_STATE_*`, `cumQuantity`, `avgPx`, `commissionNotionalTotalCollected`; `GET /v1/orders/open`; `GET /v1/portfolio/activities` `{activities[], nextCursor, eof}` where a **trade carries no order id and no side**; `positionResolution` `{beforePosition, afterPosition, side LONG|SHORT|NEUTRAL, updateTime}`; private stream `wss://api.polymarket.us/v1/ws/private` via `client.ws.private()` (`subscribeOrders/Positions/AccountBalance`, events `orderSnapshot`, `orderUpdate`, `positionUpdate`, `accountBalanceUpdate`, `heartbeat`, `close`); the SDK uses the global `fetch`, signs `timestamp+method+path` with Ed25519, maps AbortError → `APIError(408)`, other fetch failures → `APIError(0)`; **no client order id, idempotency key, sandbox or account-identity endpoint exists** — none is invented. Invalid prices (outside 0.01–0.99) still receive an id and are rejected later, so they are refused client-side.

### Regression checks
All 138 tests of 1.12.0 still pass; five assertions were updated for the 1.13 contract: `polymarketUs.test.ts` (the adapter now has `previewOrder/createOrder/getOrder/activities/openPrivateStream/classifySubmitFailure`; reads still never touch them), `routes/trading.test.ts` and `services/decisions.test.ts` (`POST /api/trading/orders` → `409 preview_required` instead of `501`; manual-live without the acknowledgement → `live_authorization` gate; auto-live → `strategy_qualified`), `services/trading.test.ts` (`features.submission` is `true`; `submission_feature` and `no_holds` gates satisfied on a fresh account).

### Remaining gate failures / pending items for 1.13

1. Owner `npm install` / `typecheck` / `build` / `test` on Windows with the real packages (sandbox used stubs for fastify/zod).
2. **Capped owner-run smoke test** ([docs/SETUP.md §4.14](SETUP.md)): one verified contract, quantity 1, a few cents, manual-live, preview → confirm → reconcile → (optionally) settlement. **Not performed during development; no live fill has been verified.** A successful HTTP response in any test is not a verified fill.
3. Exit demo on the owner's machine with the fake venue (`npm test -- execution`), then the smoke test above.
4. Upgrade rehearsal from the owner's real 1.12 data directory (015 rebuilds `trade_intents`; verify the row count before/after).
5. The 1.10–1.12 items still open: real-key read check, Windows `secret.key` ACL, Setup walk-through, 1.11/1.12 exit demos on a real US event, strategy qualification (auto-live stays gated).

The release is **not marked "accepted"** until 1–2 are recorded here.

## Release 1.12.0 — Immutable forecasts, decisions, risk reservations, US paper execution (2026-09-16)

**Baseline.** 1.11.0 as executed in the sandbox: 112 · 112 passed · 0 failed (owner's Windows runs of 1.10/1.11 still pending, see below).

**This release, executed.** Linux cloud sandbox, Node v22.22.2, sources compiled with `tsc` against the repository's `tsconfig.base.json` plus the same type stubs as 1.10/1.11 (`fastify` in-memory router, `zod` shim; `polymarket-us` never loaded; the fake trading adapter is installed in every decision test and asserts **zero** calls):

| Command (sandbox equivalent) | Result |
|---|---|
| `node --test "dist/server/src/**/*.test.js"` (= `npm test`) | **138 tests · 138 passed · 0 failed · 0 skipped · 0 cancelled** (84.5 s). 1.11.0 had 112; the 26 new tests are listed below. |
| `node --test dist/server/src/analysis/forecast.test.js` | 8 · 8 passed |
| `node --test dist/server/src/analysis/tradeDecision.test.js` | 11 · 11 passed |
| `node --test dist/server/src/services/decisions.test.js` | 7 · 7 passed (0.5 s) |
| `tsc -p tsconfig.json --noEmit` for `server/src` + `shared/src` (= `npm run typecheck`, server/shared) | **0 errors** (stub-only filter TS7006/TS2347/TS2307). |
| `tsc -p tsconfig.json --noEmit` for `web/src` (= `npm run typecheck`, web) | **0 errors** (filter TS7006/TS2307 — React's own types are not installed in the sandbox). |
| `npm run build` (Vite bundle) | **not executed** in the sandbox (no registry). Pending owner run. |

**Owner machine (Windows 11, Node 26.7.0):** `npm install` (no new dependencies in 1.12), `npm run typecheck`, `npm run build`, `npm test` — **pending owner execution**; record counts here.

### Requirement → test matrix (fake venue, fake adapter; no order endpoint exists to call)

| Test id (03-Acceptance-Test-Plan) | Requirement | Where | Status |
|---|---|---|---|
| F01 | FOR-01/04 | `analysis/forecast.test.ts` "F01 — one source, n=20, mean edge .12…" → d .08, adjustment .04, pYes `0.540000` / pNo `0.460000`, formula text | ✓ executed |
| F02 | FOR-03/04 | "F02 — ten videos from the same creator and ten reuploads…" → 20 inputs, 2 contributions; one creator = one video; representative = most recent claim; `clustered_duplicate ×9` | ✓ executed (the service clusters by creator key and by quote hash; `decisions.test.ts` F06 shows a second creator on the same contract as a separate cluster) |
| F03 | FOR-01/03 | "F03 — two independent sources… one YES one NO" → adjustments cancel, pYes `0.500000`, both stances on record; R01 shows .50 abstains | ✓ executed |
| F04 | FOR-02 | `services/decisions.test.ts` "F04/F05 — the trading cohort…" → 4 observations from 9 claims; `void ×1`, `outcome_pending ×2`, `no_price_at_or_before_claim ×1`, `link_not_verified_equivalent ×1`, `duplicate_creator_contract ×1`; assessments are structurally never read (the cohort consults `markets.resolved` only) | ✓ executed (**partial**: no `supported`/`partially_supported` assessment row is inserted; exclusion is by construction, not by a fixture row) |
| F05 | FOR-05 | same test: midday-only price on a date-only claim excluded; a resolution observed after T excluded at T and included at a later instant; `analysis/forecast.test.ts` rejects a claim made after `asOf` | ✓ executed |
| F06 | FOR-05 | "F06 — a forecast replayed at T is byte-identical…" → same hash after a later resolution, later wins and an edit; a later instant changes it; `forecast_snapshots` refuses UPDATE | ✓ executed |
| F07 | FOR-01/06 | `analysis/forecast.test.ts` "F07 — NaN, Infinity, 1.2, inconsistent sums and expiry…"; `analysis/tradeDecision.test.ts` gate matrix (FORECAST_INVALID / INSUFFICIENT / EXPIRED / MISSING; auto-live needs `qualified`) | ✓ executed |
| F08 | FOR-06/07 | "F08 — qualification gates apply exactly…" (99 vs 100, Brier vs baseline, 20 per creator, 2 clusters); `decisions.test.ts` F11: a fixture-sourced evaluation passes the numbers yet never qualifies; no production row exists; trading gate stays unmet | ✓ executed |
| F09 | FOR-07 | "F09 — Brier over [.8,.3]…" = .065; baseline .25 on the same events; skipped reasons and bin counts retained | ✓ executed |
| F10 | FOR-08 | `analysis/tradeDecision.test.ts` fill maths and `services/decisions.test.ts` "F10 — paper mode, F0 book with only 10 contracts…" → 10 fills, $5.00 + $0.20 fees, 9 canceled (IOC), reservation `consumed` 5.20 of 9.88, exposure 5.20, bankroll 94.80, zero adapter calls, second entry refused (`OPPORTUNITY_CONSUMED`) | ✓ executed |
| F11 | FOR-08, DASH-01 | "F11 — legacy paper (USDC + mana), the US paper book and live account balances…" → legacy `byCurrency` {USDC, MANA}, no USD there; US book USD only; routes: strict decision body (400 on `budget`), `/orders` 501 | ✓ executed (live account balances are the 1.10 sync rows; the Trades page shows them as a separate, never-summed figure) |
| R01 | RSK-01/03 | `analysis/tradeDecision.test.ts` "R01 — exactly .50 skips; .5001 passes…; every other gate still required" | ✓ executed |
| R02 | RSK-01/03 | "R02 — pChosen .60: all-in .75 → negative; .58 → .02 skips; .57 → .03 passes" | ✓ executed |
| R03 | RSK-02/04 | "R03 — candidate 20 → 19 / $9.88; hint only lowers"; route test refuses a client `budget` | ✓ executed |
| R04 | RSK-04/07 | "R04 — .435 → YES .43 / NO .57 (risk .43); half-cent tick; fee bounds incl. announced later schedule; unknown fee fails closed; fractional increments; no valid quantity" | ✓ executed |
| R05 | RSK-03 | "R05 — book 10 s vs 10.001 s; sync 30 s vs 30.001 s; forecast 30 m vs 30 m + 1 ms" (exact boundaries; a stale input blocks until re-evaluated with fresh inputs) | ✓ executed |
| R06 | RSK-03, MAT-06 | "R06 — 12:54:59.999 pre-cutoff; 12:55:00 and .001 block with the market open; same instant in Eastern time; unknown cutoff blocks"; `dailyBucket` timezone | ✓ executed |
| R07 | RSK-05 | `services/decisions.test.ts` "R07 — two concurrent workers with $15 unused capacity…" → one reservation/dispatch, the other `NO_VALID_QUANTITY`, bankroll never negative | ✓ executed (same-process concurrency: the reservation is inserted in the decision's SQLite transaction; cross-process locking is OPS-03, 1.13) |
| R08 | RSK-02/05 | pure sizing test + "R08 — daily remainder sizes down (9 / $4.68); event cap; open-market count; loss stop (net −3.48 trips $3, not $4); winning settlement leaves the day's committed amount unchanged" | ✓ executed |
| R09 | RSK-06 | `analysis/tradeDecision.test.ts` "R09 (checks) — opposing exposure / open order blocks; unreflected reservation subtracted once" | ✓ executed at the pure level (**partial**: no live account exists in paper mode, so the service path with a real sync is exercised only through the 1.10 sync rows; acknowledgement of reservations by the venue arrives with 1.13) |
| R10 | RSK-05/07 | "R10 — reservation keeps its bucket across midnight; limit/timezone edits hashed and audited, no reset of consumption; unknown timezone refused; consumed opportunity survives a bigger budget" | ✓ executed (**partial by construction**: "while armed" cannot occur — live modes are refused; the disarm branch of `setLimits` is exercised by static review only) |
| — | migrations | `core.test.ts` (schema version 14; new tables; 014 applies after 013) | ✓ executed |

### Regression checks
All 112 tests of 1.11.0 still pass unchanged except one deliberate contract change: `routes/trading.test.ts` no longer expects `POST /api/trading/decisions` to answer 501 (it is the paper decision route now); `/arm`, `/emergency-stop` and `/orders` still do.

### Remaining gate failures / pending items for 1.12

1. Owner `npm install` / `typecheck` / `build` / `test` on Windows with the real packages (sandbox used stubs).
2. Exit demo on the owner's machine: the same verified contract with the book at .50 → *Evaluate paper decision* eligible (19 × .52 ≤ $10); with a .75 offer → skipped `EDGE_NEGATIVE`; `$10` cap under two concurrent evaluations. The sandbox demo used the synthetic F0 book and contracts.
3. **Strategy qualification is unmet** (FOR-06/07): no production qualification record can exist until ≥ 100 settled paper decisions with a market baseline accumulate; auto-live stays gated. Reported as incomplete scope, not waived.
4. Upgrade rehearsal from the owner's real 1.11 data directory (migration 014 is additive).
5. The 1.10/1.11 items still open: real-key read check, Windows `secret.key` ACL, Setup walk-through, 1.11 exit demo on a real US event.

The release is **not marked "accepted"** until 1–2 are recorded here.

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
