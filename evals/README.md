# Evaluations

Cross-provider checks of the app's real prompts against the labelled fixtures in `../fixtures/`. Unit tests use a fake model; these use real ones, so they cost money/time and are run by hand.

| File | Purpose |
|---|---|
| `promptfooconfig.yaml` | Providers (Anthropic, OpenAI, LM Studio) × fixture windows × assertions. |
| `prompts/extraction.mjs` | Renders the app's built-in extraction prompt for one fixture window using the *built* app code, so evals never drift from what the app sends. |
| `assertions/extraction.mjs` | Scores the reply against `expected.json`: verbatim quotes, modality preserved, no invented deadlines, nothing from `mustNotExtract`. Pass = ≥ 0.8 with no hard failure. |

## Run

```bash
npm run build                       # evals import server/dist
export ANTHROPIC_API_KEY=…          # and/or OPENAI_API_KEY; LM Studio needs a loaded model
npm run eval                        # = npx promptfoo@latest eval -c evals/promptfooconfig.yaml
npx promptfoo@latest view           # browse results
```

`promptfoo` is not a project dependency; `npx` fetches it on demand (installation-time internet). Filter providers with `--filter-providers anthropic`.

## Thresholds (to be recorded in Release 1.0)

The pass threshold is 0.8 per window with no hard failure. Record each provider's score table in `docs/VERIFICATION.md` when the suite is first executed on a machine with network; a provider that fails the modality or invented-deadline hard checks should not be a default for the extraction stage.

## Adding cases

Add a transcript + `expected.json` pair under `fixtures/transcripts/` (see `fixtures/README.md` for the schema), then a `tests:` entry per window. Plan-generation and assessment evals follow the same shape: a prompt function that renders the app template from a stored prediction/plan fixture, and an assertion that checks the structured reply (for assessment: the verdict guard's rules G1–G7 as expectations).
