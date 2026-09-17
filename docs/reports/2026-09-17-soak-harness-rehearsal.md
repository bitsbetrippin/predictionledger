# Paper-soak report — SYNTHETIC HARNESS REHEARSAL (compressed clock, fake market data; not the owner's 7-day soak)

Generated 2026-10-08T09:00:00.000Z. Window 2026-10-01T00:00:00Z → 2026-10-08T09:00:00Z (7 day(s) with scheduler activity of 8 calendar day(s)). Verdict: **complete**.

> A soak measures the scheduler's behaviour under real time and faults; it is not strategy evidence and does not replace the separate ≥ 100-settled-event qualification. A synthetic (compressed-clock, fake-venue) run is a harness rehearsal and must be labelled as such.

| Check | Threshold | Result |
|---|---|---|
| Calendar days with activity | ≥ 7 | 7 ✓ |
| Decision evaluations | ≥ 100 | 110 ✓ |
| Distinct events | ≥ 10 | 28 (28 contracts) ✓ |
| Duplicate entries | 0 | 0 ✓ |
| Risk-cap breaches | 0 | order 0, daily 0, open markets max 0/5 ✓ |
| Every intent explained | yes | 0 stuck, 0 unknown open (0 resolved) ✓ |

Ticks: 37 (37 completed, 0 skipped, 0 failed; skip reasons: market_not_open 31, opportunity_consumed 38, cutoff_passed 24). Modes: paper 37, auto-live 0. Lease holders seen: 2.

Candidates: 364 (queued_work:revalidation_queued 161, skipped:market_not_open 31, evaluated:paper_dispatched 10, evaluated:skipped 100, skipped:opportunity_consumed 38, skipped:cutoff_passed 24). Decisions: 110 — eligible 10, skipped 100, needs review 0; abstention rate 0.909; missing-data gates hit 22. Reason codes: FORECAST_INVALID 12, FORECAST_INSUFFICIENT 12, PROB_NOT_ABOVE_HALF 16, EDGE_NEGATIVE 56, EDGE_BELOW_MIN 22, BOOK_MISSING 10.

Intents by state: filled 10. Faults: alerts none; breaker opened 0; restarts 0; disarms 0; emergency stops 0.

Paper: 10 positions, 10 settled (4 wins, 6 losses, 0 voids), fee-adjusted P&L -21.9, fees 2.9.
