# Contributing to Prediction Ledger

Thanks for helping. This project is maintained by an individual developer, so the rules below exist to keep it maintainable rather than to add ceremony.

## Ground rules (non-negotiable)

1. **Loopback only.** The server binds `127.0.0.1`. Pull requests that expose the service to the network, add tunnels, or add cloud-hosted components are out of scope.
2. **No telemetry.** Nothing phones home. Outbound calls happen only to providers the user configured.
3. **Secrets never leave the backend.** Not in API responses, logs, exports, test fixtures, or screenshots.
4. **Model memory is not evidence.** Any change to research or assessment must keep the rule that only application-retrieved sources can be cited.
5. **Plans are written before research and versioned.** Don't add a path that mutates a plan in place.
6. **Untrusted content stays data.** Transcripts, fetched pages, and generated prompts go into delimited blocks; they never become system instructions and never control budgets or tools.

## Before you open a PR

- Read `docs/ARCHITECTURE.md` (especially §7 Security) and `docs/DECISIONS.md`. If your change reverses an ADR, say so in the PR and add a new ADR.
- New dependency? Add its row to `THIRD_PARTY_NOTICES.md` and `docs/ARCHITECTURE.md §8` first.
- New or changed prompt? Add or update a human-reviewed fixture under `fixtures/` (from Release 0.2) and, from Release 1.0, a Promptfoo case.
- Run `npm run typecheck` and `npm test`.
- Update `docs/SETUP.md` / `README.md` if a command or setting changed. Docs and commands must match.

## Development workflow

```bash
npm run setup        # once
npm run dev          # server (tsx watch) + Vite on 127.0.0.1:5173 with /api proxy
npm test
```

Use a separate data directory while developing so you don't disturb your real ledger:

```bash
PL_DATA_DIR=./data npm run dev           # macOS/Linux
$env:PL_DATA_DIR = ".\data"; npm run dev # Windows PowerShell
```

(`data/` is git-ignored.)

## Code conventions

- TypeScript strict; ESM everywhere; `node:` prefixes for built-ins.
- Every source file starts with the project header comment (concept attribution + license). Copy it from any existing file.
- Child processes are spawned with argument arrays. Never build a shell command string from user input.
- Paths go through `node:path`; never assume a separator or a home directory.
- Validate at the boundary: Zod for request bodies and model outputs; SQL parameters, never string concatenation.
- Commit `package-lock.json` (created by the first `npm install`); do not commit `node_modules`, `dist`, or `data`.
- Migrations are forward-only SQL files `server/src/db/migrations/NNN_name.sql`. Never edit an applied migration; add a new one.

## Commit and PR hygiene

- Small, end-to-end increments that leave the app usable.
- Reference requirement IDs from `docs/BUILD_PLAN.md` (e.g. `PX-05`) in the PR description.
- State what you verified and on which OS. "Tested on Windows 11; macOS not available" is a perfectly good sentence.

## Reporting security issues

Open a GitHub issue titled "Security" without exploit details, or contact the maintainer privately through the BitsBeTrippin site. The local-app threat model is described in `docs/ARCHITECTURE.md §7`.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0, and that the project may credit contributors in `NOTICE`.
