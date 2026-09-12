# Fixtures

Human-reviewed inputs and expected outputs used by tests and (from Release 1.0) Promptfoo evaluations.

| File | Purpose |
|---|---|
| `transcripts/data-center-approvals.srt` | Synthetic 53-second transcript containing the worked-example prediction, one hedged prediction ("might"), and four non-predictions (history, question, wish, past premise). |
| `transcripts/data-center-approvals.expected.json` | What extraction must and must not produce for that transcript. |
| `transcripts/no-predictions.srt` / `.expected.json` | Synthetic 35-second recap with **no** predictions (past events, a refusal to guess, background, an audience request) — the "no predictions found" acceptance case (B2). |
| `transcripts/energy-outlook-30min.srt` / `.expected.json` | Synthetic, labelled **30-minute** transcript (B1): 155 cues, three analysis windows, six planted predictions — a repeat (1 row, 2 occurrences), a hedge ("might"), one spanning the 720 s window boundary, a compound claim, a no-deadline claim, an unresolvable "before the next halving" — plus a quotation of someone else's forecast that must not be extracted. Statement date 2026-03-10. |
| `transcripts/nfl-picks.srt` / `.expected.json` | Synthetic 66-second picks segment (Release 1.2 sports rule): a spread pick, a moneyline pick, a total, and one season-long claim that must stay a general prediction; rationale lines must not become predictions. |
| `model-outputs/` | Canned model replies used by `server/src/pipeline.test.ts` and `pipeline-30min.test.ts` so the whole pipeline runs without a real provider (`extraction.energy-outlook-30min.w1..w3.json` are per-window; w1 deliberately returns a truncated quote at the window edge). |

The same `expected.json` files drive the Promptfoo suite in `../evals/` against real models. All content here is synthetic and clearly labelled. Nothing in `fixtures/` is a real citation or a verified finding.
