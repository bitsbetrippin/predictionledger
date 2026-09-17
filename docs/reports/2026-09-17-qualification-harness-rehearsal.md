# Qualification report — SYNTHETIC HARNESS REHEARSAL (fake cohort; never strategy evidence)

Generated 2026-10-08T09:00:00.000Z · strategy `baseline-edge-v1` · category `sports` · as of 2026-10-08T09:00:00Z.

**baseline-edge-v1 / sports: qualification PENDING — 26 of 100 settled held-out events (74 more needed). Insufficient data is an unmet auto-live gate, not a failure and not a pass; keep collecting paper evidence.**

| Quantity | Value |
|---|---|
| Cohort | 110 decisions; 26 distinct settled events (98 settled decisions); 0 pending/void excluded |
| Chronology | decisions 2026-10-01T10:00:00.000Z → 2026-10-07T20:00:00.000Z; outcomes 2026-10-01T23:30:00Z → 2026-10-07T23:30:00Z |
| Held-out rule | chronological: every forecast is frozen at its decision instant with as-of inputs (FOR-05); outcomes are read only when official and known by asOf, so no decision sees its own or a later outcome |
| Brier (forecast) | 0.2462 |
| Brier (market baseline, same events/times) | 0.2512 |
| Calibration bins | 0–0.1: n=0; 0.1–0.2: n=0; 0.2–0.3: n=0; 0.3–0.4: n=0; 0.4–0.5: n=22 f=0.49 hit=0.91; 0.5–0.6: n=76 f=0.53 hit=0.58; 0.6–0.7: n=0; 0.7–0.8: n=0; 0.8–0.9: n=0; 0.9–1: n=0 |
| Coverage | 10 traded of 110 decisions (100 skipped; abstention 0.909) |
| Fee-adjusted paper return | -21.9 over 10 settled paper positions (fees 2.9; max drawdown 40.32) |
| Exclusions | unsettled_or_void 0, no_usable_probability 12, FORECAST_INSUFFICIENT 12, EDGE_NEGATIVE 56, EDGE_BELOW_MIN 22, BOOK_MISSING 10 |
| Creators (usable observations) | channel:UC-A: 16, channel:UC-B: 6, channel:UC-C: 6; below 20: channel:UC-A (16), channel:UC-B (6), channel:UC-C (6); independent clusters (median) 1 |
| Gate | does not pass — 26 distinct settled events (98 settled decisions) < 100 required; creators below 20 usable observations: channel:UC-A (16), channel:UC-B (6), channel:UC-C (6); fewer than 2 independent current source clusters on at least one decision |
| Production record | none written |

Status: **pending** (74 more settled events needed). A synthetic or fixture-driven cohort is never written as a production record and never unlocks arming.
