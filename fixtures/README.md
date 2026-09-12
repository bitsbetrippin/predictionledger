# Fixtures

Human-reviewed inputs and expected outputs used by tests and (from Release 1.0) Promptfoo evaluations.

| File | Purpose |
|---|---|
| `transcripts/data-center-approvals.srt` | Synthetic 53-second transcript containing the worked-example prediction, one hedged prediction ("might"), and four non-predictions (history, question, wish, past premise). |
| `transcripts/data-center-approvals.expected.json` | What extraction must and must not produce for that transcript. |
| `transcripts/no-predictions.srt` / `.expected.json` | Synthetic 35-second recap with **no** predictions (past events, a refusal to guess, background, an audience request) — the "no predictions found" acceptance case (B2). |
| `model-outputs/` | Canned model replies used by `server/src/pipeline.test.ts` so the whole pipeline runs without a real provider. |

All content here is synthetic and clearly labelled. Nothing in `fixtures/` is a real citation or a verified finding.
