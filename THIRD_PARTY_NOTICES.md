# Third-Party Notices

Prediction Ledger is original work by Michael D. Carter (BitsBeTrippin) with Claude AI engineering support, licensed under Apache-2.0. It builds on the open-source components below, each used under its own license. Nothing in this project claims authorship of these components.

This file is maintained by hand. **Rule:** a dependency is added to `package.json` only after its row exists here (see `docs/ARCHITECTURE.md §8`). Run `npx license-checker --summary` (Release 1.0 adds this to CI) to cross-check.

## Runtime dependencies (Release 0.1)

| Component | Version range | License | Copyright / origin | Used for |
|---|---|---|---|---|
| Node.js (`node:sqlite`, `node:crypto`, `node:http`, …) | ≥ 22.13 | MIT (Node.js contributors); SQLite itself is public domain | OpenJS Foundation | Runtime, embedded database, encryption |
| fastify | ^5 | MIT | Fastify contributors | HTTP server |
| @fastify/static | ^8 | MIT | Fastify contributors | Serving the built dashboard |
| zod | ^3 | MIT | Colin McDonnell | Runtime validation |
| react, react-dom | ^18 | MIT | Meta Platforms, Inc. and affiliates | Dashboard UI |

## Runtime dependencies (Release 1.10 — Polymarket US)

| Component | Version | License | Copyright / origin | Used for |
|---|---|---|---|---|
| polymarket-us | 0.1.1 (pinned exactly) | MIT | Polymarket Team — github.com/Polymarket/polymarket-us-typescript | Signed transport for the Polymarket US retail API (reads since 1.10; order preview/create/read, activities and the private stream since 1.13); loaded lazily by `providers/trading/polymarketUs.ts` |
| @noble/ed25519 | ^2.2.3 (transitive, via polymarket-us) | MIT | Paul Miller | Ed25519 request signatures inside the SDK |
| ws | ^8.18 (transitive, via polymarket-us) | MIT | Einar Otto Stangvik and contributors | SDK WebSocket support — the private order/position stream (used since 1.13; loaded lazily by the SDK) |

Release 2.0.0-rc.1 (review fixes, upgrade rehearsal, key-file ACL, reports) adds **no** dependency either: the rehearsal uses `node:sqlite` (`VACUUM INTO`) and `node:zlib`, the Windows ACL is applied with the operating system's own `icacls`, and the reports are SQL over existing tables. Release 1.14 (automatic execution, alerts, ledger) adds **no** runtime or build-time dependency: the scheduler is a `setInterval` in the server process, alerts and the ledger are SQL over existing tables, and every order still goes through the pinned SDK above.

## Build-time dependencies

| Component | License | Origin | Used for |
|---|---|---|---|
| typescript | Apache-2.0 | Microsoft | Compilation |
| vite, @vitejs/plugin-react | MIT | Evan You & Vite contributors | Dashboard bundling |
| tsx | MIT | Hiroki Osame | Dev-mode TypeScript execution |
| @types/node, @types/react, @types/react-dom | MIT | DefinitelyTyped contributors | Type definitions |

## Planned dependencies (added in the release that adopts them; rows kept here so the review is done up front)

| Component | License | Origin | Release | Notes |
|---|---|---|---|---|
| drizzle-orm, drizzle-kit | Apache-2.0 | Drizzle Team | 0.2 | Typed SQLite schema/queries |
| ai (Vercel AI SDK) and @ai-sdk/* providers | Apache-2.0 | Vercel, Inc. | 0.2 | Structured model output |
| @huggingface/transformers (**optional dependency**, adopted 0.4) | Apache-2.0 | Hugging Face | 0.4 | Whisper inference in Node (ONNX Runtime, MIT, bundled). Loaded dynamically; installed only when the user wants local transcription. Whisper models (`onnx-community/whisper-*`) are Apache-2.0/MIT, downloaded on first use into the data directory. |
| onnx-community/whisper-* model weights | Apache-2.0 / MIT (per model card) | OpenAI (original Whisper, MIT) converted by the ONNX community | 0.4 | Downloaded at runtime into the data directory, not shipped in this repo |
| ffmpeg / ffprobe | LGPL-2.1+ or GPL-2+ depending on build | FFmpeg developers | 0.4 | Invoked as a separate process; not linked. If `ffmpeg-static` is enabled it downloads GPL-licensed binaries — the GPL applies to those binaries, not to this project's code. |
| ffmpeg-static (optional) | MIT (wrapper) + GPL (binaries) | Eugene Ware et al. | 0.4 | Optional convenience |
| yt-dlp (adopted 0.5) | Unlicense (public domain) | yt-dlp contributors | 0.5 | Downloaded at runtime **only after the user clicks Install** (official GitHub release, SHA-256 verified); invoked as a separate process with argument arrays; never bundled in this repository. The standalone binary embeds Python and its own dependencies under their respective licenses — see the yt-dlp release notes. |
| @mozilla/readability | Apache-2.0 | Mozilla | 0.3 | Article extraction |
| linkedom | ISC | Andrea Giammarchi | 0.3 | DOM for Readability in Node |
| promptfoo | MIT | Promptfoo, Inc. | 1.0 | Dev-time prompt evaluation |

## Services (not code — used only when the user configures them)

Anthropic API, OpenAI API, Brave Search API, Tavily, LM Studio, SearXNG, YouTube. Each is governed by its own terms of service. Brave requires visible attribution when its monthly API credit is used; the dashboard shows "Search results by Brave" on evidence retrieved through it.

## Inlined assets (Release 2.1)

| Component | License | Origin | Since | Use |
|---|---|---|---|---|
| Phosphor Icons (regular weight, 24 glyphs as SVG path data in `web/src/components/Icons.tsx`) | MIT | Phosphor Icons (Tobias Fried, Helena Zhang) | 2.1 | Dashboard navigation and status icons, inlined so nothing is fetched at runtime. License text: `licenses/phosphor-icons.txt`. |

Inter (the typeface named by the 2.1 design) is **not** bundled or fetched: the stylesheet names it and falls back to the system font when it is not installed.

## Design references (no code reused)

- **GPT Researcher** (Apache-2.0, Assaf Elovic) — reference for the search → read → cite loop in `docs/ARCHITECTURE.md`.

## How to add a component

1. Add a row above with license, origin, and purpose.
2. If the license requires shipping its text (e.g. Apache-2.0 NOTICE contents, BSD), add the text under `licenses/<component>.txt`.
3. Add the dependency to the relevant `package.json`.
