# Setup Guide — providers, LM Studio, external tools, and troubleshooting

Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0

This guide covers everything that is *not* just `npm run setup` + `npm start`. The README has the quick start.

---

## Prediction markets (1.6)

Setup → **Prediction markets** turns on read-only Polymarket data (default on; needs internet). Open a prediction → **Markets** → **Find markets** to get scored proposals; accept the one whose resolution rules really match the claim. Sports picks link automatically when the two teams, the game date and the pick type all match a game market (switch that off in Setup if you prefer to review). The **Markets** page lists everything stored, lets you search the venue and *watch* a market, and refreshes prices on the interval you set (0 = manual). Nothing is ever traded; no account is needed.

**Signals (1.7).** The Signals page shows, per market side, the market's price against the linked creators' *realized edge* — what following them would have earned per $1 at the market's price on their settled, linked calls — shrunk toward zero when the record is thin, and a label (strong / moderate / lean / no signal) that only appears when the record size, the edge, the market's liquidity and the deadlines all clear the gates under Setup → Prediction markets → Signal gates. Accepting a link triggers a read of the venue's price history for the day the claim was made. Every row expands to the claims and numbers behind it.

**Consensus, alerts and bulk import (1.8).** Library → *Import a playlist or channel* queues a whole channel (newest first, up to the limit you set) and can extract predictions as each transcript lands. Signals → *Consensus across channels* groups the same claim across videos and shows a split room as a split. Watch rules (Setup → Prediction markets → Watch rules) raise local alerts — a market moved, creators and the market diverge, a market resolves soon — listed on the Signals page with a count in the nav; nothing is sent anywhere. Setup → Venues adds Manifold (play-money) beside Polymarket; searches, links and snapshots then cover both.

**Polymarket US account (1.10).** This is a *separate* venue from the international Polymarket site: a CFTC-regulated USD exchange with its own public data host (`gateway.polymarket.us`, no account needed — tick **Polymarket US** under Venues to search it) and its own key-based private API. Setup → **Polymarket US account** connects an account for **reads only** — balances, positions, open orders — through the pinned official SDK, signed with your key. Connecting never changes the trading mode (it stays *paper*); since 1.13 an owner can arm **manual live** here with a typed acknowledgement, and even then every order needs a preview and a confirmation on the Trades page (automatic execution, 1.14, is a separate control with its own gates — see below). Steps: install the Polymarket US app and complete identity verification; sign in to [polymarket.us/developer](https://polymarket.us/developer) *with the same method*; create an API key; paste the **Key ID** and **Secret Key** (shown once); *Test connection*; *Save*. The secret is encrypted in a protected part of the secret store that model and search code cannot read; only a masked hint and a fingerprint of the key's public part are ever shown. The venue exposes no account identifier, so the binding is local: rotating to a new key is recorded as *unverified* continuity (or *user-asserted* if you tick the box) and marks the binding as needing reconciliation. *Disconnect* removes the key from this computer only — revoke it in the portal when you want it dead. Positions you placed by hand on the website show up on Trades as **External holdings** (counted toward the limits, blocking app entry on that contract, never a hold); everything else the Trades page can show you is explained in plain English in [docs/OPERATIONS_REFERENCE.md](OPERATIONS_REFERENCE.md). Owner-run read-only check from a terminal: `POLYMARKET_US_KEY_ID=… POLYMARKET_US_SECRET_KEY=… npm run trading:read-check`. This is *not* wallet binding, OAuth, or the institutional/partner API.

**Subscriptions, dossier and contract verification (1.11).** Three additions, none of which trades.
- *Library → Follow a channel or playlist* saves a **subscription**: poll interval, lookback in days, title keywords (optional allowlist), a per-poll video budget and auto-extract. The server checks due subscriptions every ten minutes; each poll lists the newest videos, skips what the ledger already has, and queues the rest through the ordinary YouTube import (so the same yt-dlp / captions / audio rules and failures apply). *Run now* polls immediately, even when the subscription is disabled. Needs internet and yt-dlp.
- *Prediction detail → Dossier* shows every excerpt with its source's URL, publisher, publication date, when the app **first fetched** it, its text hash, its independence group (syndicated copies and same-publisher pages count as one voice) and status; contradicting items are listed under *Dissent* whatever the verdict. *Replay as of* a date shows only what the app had actually fetched by then; *assume published = known* is the labelled opt-in that counts a source from its publication date instead. *Withdraw source* and *recheck URL* change a source's status only — nothing stored is rewritten. *Forecast research* (once a plan exists) gathers current evidence about a future event as a separate forecast run that never produces a verdict.
- *Prediction detail → Markets → Polymarket US contract verification*: **Find US contracts** searches the US venue (or reads a pasted `polymarket.us/event/…` link) and says plainly *none*, *one* or *multiple*; then **Run checklist** compares every rule of the contract with the claim — league, teams, game date and start, market type, line and sign, period, overtime and tie rules, or for general claims the subject, touch-vs-close semantics, `>` vs `>=`, threshold, units, window, geography and measurement source — plus venue, market status, rules text, question, settlement and cutoff. The badge is computed from the checklist (*verified equivalent* only when every required rule matches; *incomplete*, *incompatible*, *research only* or *stale* otherwise) and cannot be set by hand. A missing, non-gate field can be filled with a **documented fact** and its source; an incompatible field cannot. **Revalidate** re-reads the contract from the venue and marks the verification stale if the rules, the game, the market status or the claim changed. Links on Polymarket (international) or Manifold are *research only* here by design.

**Forecasts, paper decisions and limits (1.12).** Still nothing trades. Once a prediction's Polymarket US link is *verified equivalent* (Markets tab), **Evaluate paper decision** builds a forecast from the creators' verified track record (spec §7 estimator: shrunk realized edge per independent source, recency-weighted, added to the fresh YES midpoint), runs every risk gate against the pilot limits, and — when eligible — reserves capacity in the separate **US paper bankroll** and simulates an immediate-or-cancel fill against the venue's book (partial fills and fees included; the remainder is canceled, never topped up). Skipped decisions are saved with their reason codes too. The **Trades** page lists every decision with its gates, the forecast's contributions and exclusions, the reservation, the fills and the evidence as it stood at decision time. Setup → **Trading limits and US paper bankroll** holds the pilot limits (order $10 all-in, daily $50, total $100, per market $10, per event $20, five markets, $20 loss stop, .50 threshold, .03 edge, freshness windows, five-minute pre-event buffer, budget timezone); any change is hashed and audited and never resets what a day already used. A strategy becomes *qualified* only from ≥ 100 settled paper decisions with a market baseline — fixtures cannot do it — and automatic execution (1.14) cannot be armed until then.

**Manual-live execution (1.13) — real money, opt-in, one order at a time.** With an account connected and synced, Setup → *Polymarket US account* → *Mode* → **Manual live** opens an acknowledgement box; the app arms only when you type the sentence exactly (`I understand this places real orders with real money`) and the account gates hold (validated key, sync ≤ 30 s old, binding reconciled, no open holds). Arming is audited with a hash; **Disarm now**, a limits edit, a restart, a backup/restore or a credential change disarm again. Being armed does nothing by itself. On the **Trades** page a manual-live decision that *needs review* shows **Preview order…**: the server re-decides with a fresh book and account, asks the venue for its preview, and shows the contract, side, quantity, chosen-side cost and the YES wire price, the worst case (quantity × cost + fee bound), the model EV, the decision and policy hashes, the evidence link and the exact wire request — valid for 60 s. **Confirm — place real order** sends it **once** as a limit immediate-or-cancel. If the price, the evidence, the policy or the account moved in between, the preview is refused and nothing is sent. If the venue's answer is lost (timeout, reset, 5xx, a crash right after the send), the intent shows **Unknown — reconciling**: capacity stays reserved, new orders are paused, nothing is re-sent, and *Reconcile with venue* lists candidate orders for you to link explicitly ("this order is mine") or to declare "venue shows no order" after checking the venue's order history. Fills arrive on the private stream and by reconciliation (at startup, after reconnects, every 30 s while an order is open, or on demand); partial fills are kept when the remainder is canceled; only the venue's official *position resolution* activity settles a position (a market quote at .99 or a research verdict never does). Every step is in the audit log and in *Export live lineage* (secret-free). The app never guesses that an order it did not place belongs to it: orders from the website or another client are listed separately with no rationale.

**Automatic execution (1.14) — off until you arm it, and unavailable until a strategy qualifies.** The scheduler (Setup → *Automatic execution*) polls your saved channels, matches new picks on Polymarket US, runs the contract checklist and — only while **armed** — places bounded automatic orders through the same one-send path as a manual order. Arming needs everything manual live needs plus a **production-qualified** strategy for the category (≥ 100 settled events with a market baseline; fixtures never count), the paper rehearsal (≥ 20 settled US paper positions), no holds, not paused, a closed circuit breaker, the acknowledgement `I authorize automatic real-money orders under the policy hash I reviewed`, and the **policy hash** shown on the card — if the hash changed since you looked, arming is refused. While armed: one entry per contract, ever (no top-ups, no re-entry after an IOC cancel, no catch-up bets after the cutoff), at most the configured orders per tick, fair share per creator, every candidate's outcome recorded under *Automation runs*. **Pause new orders** stops new entries without disarming; **Emergency stop** (Trades page) disarms and pauses in one statement and asks the venue to cancel every open order *this app* placed — positions and history stay, orders you placed on the website are untouched (the separately labelled *cancel every open order* action exists for that, with its own acknowledgement). Restarts, backups/restores, credential changes, limit or budget edits, an unknown submission, a reconciliation discrepancy or a circuit-breaker opening (repeated adapter failures) all return to **disarmed**; nothing ever re-arms by itself. Alerts (Trades page) are local, one per incident, and never spam on quiet polls. *Paper autopilot* runs the same loop in paper mode for a paper soak without touching the account.

### 4.14 Owner-run smoke test for 1.13 (capped; the only live check — do it once, deliberately)

Development placed **no** production order. Before relying on manual live, run this yourself, with a **cap of one contract and a few cents**, and record the results in `docs/VERIFICATION.md`:

1. Fresh start: `npm start`, Setup → *Polymarket US account*: **Test connection**, **Save**, **Refresh** — buying power matches the venue's app. Setup → *Trading limits*: set **order budget `1.00`**, **daily `1.00`**, **total `1.00`**, **per market `1.00`** (this also disarms, as designed).
2. Pick one *verified equivalent* contract (Markets tab) whose cheaper side trades at a few cents so that one contract fits the $1 budget; *Evaluate paper decision* first — it must say *eligible* in paper mode. Then set **Mode → Manual live**, type the acknowledgement, confirm the card says *Armed*.
3. Re-evaluate the decision (now *needs review*, manual-live). Trades → **Preview order…**: check side, quantity (should be small), chosen cost, YES wire price, worst case ≤ $1.00, and the wire request's `intent` (`BUY_LONG` for YES, `BUY_SHORT` for NO — NO orders carry the YES price). Let the preview expire once (60 s) and confirm the app refuses; request a new preview.
4. **Confirm — place real order.** Expected within seconds: intent *Accepted* → *Filled* or *Partially filled* or *Canceled (no fill)* (an IOC at a stale price may not fill — that is a correct outcome), one venue order id, fills with price and fee, the reservation consumed or released, the venue's app showing the same order. If the intent shows **Unknown — reconciling**, do **not** retry: open the venue's order history, then resolve the hold on the Trades page with what you found.
5. **Reconcile with venue** → 0 discrepancies; positions table matches the venue; *Export live lineage* → the JSON contains the intent, order, executions and audit rows and no secret.
6. Optional: place one manual order on the venue's website on the same market, reconcile again — it must appear under *not placed by this app* with no rationale, and the position row must still reconcile.
7. When the market resolves: reconcile → a settlement event with the amount; the position row shows *win* / *loss* / *void*.
8. **Disarm now**, restore your limits, and write the counts (orders, fills, amounts, any hold) into VERIFICATION.md. Anything unexpected → stay disarmed and report it; never resend by hand "to see what happens".


**Paper trading (1.9).** The Paper page keeps hypothetical positions — never orders. Open one from an expanded Signals row (*Paper buy*), or set Setup → Prediction markets → Paper trading → *Auto-open* so watch runs open positions on labelled signals. Sizing is a fixed stake or fractional Kelly on the signal's edge, capped at a fraction of the bankroll. Positions are marked at every snapshot and close at 1 or 0 when the venue resolves the market; the book shows equity, realized and unrealized P&L, and the creators' estimate Brier beside the market's — lower is better, and the gap is whether the signals helped. *Reset book* wipes it.

## 1. Prerequisites

| Requirement | Windows | macOS | Notes |
|---|---|---|---|
| **Node.js 24 LTS** (≥ 22.13 works) | Installer from nodejs.org, or `winget install OpenJS.NodeJS.LTS` | Installer from nodejs.org, or `brew install node@24` | `node --version` must print v22.13+ / v24.x. |
| **Git** (or GitHub Desktop) | GitHub Desktop bundles Git | GitHub Desktop bundles Git | Only needed to clone/update. |
| **ffmpeg + ffprobe** *(for local video/audio import)* | `winget install Gyan.FFmpeg` then reopen the terminal | `brew install ffmpeg` | Needed for local video import only. Setup → Transcription → *Check media tools* reports whether it is found. Alternative: `npm install ffmpeg-static -w server` bundles a binary; or set `PL_FFMPEG_PATH` to a folder containing both binaries. |
| Local Whisper engine *(optional)* | `npm install @huggingface/transformers -w server` | same | Only for on-device transcription. The first transcription downloads the model (~75 MB for whisper-base) into the data directory's `models/`. Requires internet for that one download. |
| **yt-dlp** *(for YouTube links)* | Setup → YouTube → **Install yt-dlp** (downloads the official `yt-dlp.exe` into the data directory after you approve it) | same (`yt-dlp_macos`; first run may need Gatekeeper approval — see Troubleshooting) | Nothing to install by hand. Alternatives: a `yt-dlp` already on PATH, or `PL_YTDLP_PATH`. Needs internet, obviously. |
| LM Studio *(optional)* | lmstudio.ai | lmstudio.ai | Only if you want a fully local model. |

No administrator rights, Docker, or Python are required.

---

## 2. Install and run

**Windows (PowerShell or Command Prompt)**

```powershell
cd "$env:USERPROFILE\Documents\GitHub\prediction-ledger"
npm run setup      # checks Node, installs dependencies, builds server + dashboard
npm start          # starts the local server and opens http://127.0.0.1:7317
```

**macOS (Terminal)**

```bash
cd ~/Documents/GitHub/prediction-ledger
npm run setup
npm start
```

Stop with **Ctrl+C** in the same terminal. Running jobs are paused and resume on the next start.

**Upgrading:** pull the latest commit (GitHub Desktop → *Fetch origin* / *Pull*), then `npm run setup` again. Database migrations run automatically on the next `npm start`; your data directory is never touched by git.

### 2.6 Which version is running (2.1)

The sidebar shows `v<version>` from `GET /api/health`, which the server reads from `server/package.json` **when it starts**. After applying a patch or pulling, run `npm run build` (the dashboard is compiled into `web/dist`; the server into `server/dist`) and **restart** `npm start` — a dashboard that still shows the previous version means the old process is still running or the build was skipped. `npm run doctor` prints the same version.

### 2.7 Finding your way around (2.1)

- Every term on every page has a `?`: *What this means · What the app is doing · What you can do next · Read more*. Enter/Space opens it, Esc closes it.
- Press `/` anywhere (or click *Search reference*) to search the built-in reference; **Learn & Reference** in the sidebar has the full text and an interactive, labelled-synthetic worked example that never touches your records.
- **Guided start** (Setup → first section, the sidebar pill, the Library empty state) is six steps derived from your own records — settings, videos, predictions, accepted market links. *Skip for now* and *Restart* only write `localStorage['pl.guidedStart']`.
- The reference text ships inside the app; the GitHub copy (`docs/OPERATIONS_REFERENCE.md`, `docs/WORKED_EXAMPLE.md`, README) is the secondary link on each topic. `npm test` runs `scripts/check-help-anchors.mjs`, so the two cannot drift silently.
- Fonts and icons are local: Inter is used when it is installed on your computer (system font otherwise); the icons are inlined SVG. The dashboard fetches nothing from the internet on its own.
- Keyboard (2.1.1): on Predictions, Tab into the table, then ↑/↓ move between predictions, Enter opens the detail, Esc closes it and returns you to the row. One Escape order everywhere: a `?` popover closes first, then the phone drawer, then the Learn panel, then the detail. Press `/` for the reference from any page.
- The Guided-start strip appears at the top of the page where the next step happens (Library, Predictions or Markets — never Setup); ✕ hides it and *Restart* in Setup → Guided start brings it back.

---

## 3. First-run checklist (Setup tab)

1. Open **Setup**. Note the data directory shown at the top — that is where everything is stored.
2. **Privacy.** Leave *Allow internet access* on if you will use cloud providers or web research. Turn it off for a fully local workflow (LM Studio + local Whisper + transcript import); research will then stay *pending*.
3. Enable at least one **language-model provider** (section 4 below), test it, and pick a model.
4. Under **Which model does what**, choose a provider for extraction, validation-plan generation, and assessment. They can differ.
5. Set **Transcription** and **Web search** now if you know them; they become active in Releases 0.4 and 0.3 respectively.
6. **Save settings.**

What leaves your computer, and when:

| Setting | Data sent | To |
|---|---|---|
| Anthropic / OpenAI provider | transcript windows, predictions, stored evidence excerpts, prompts | that provider's API |
| OpenAI transcription | audio of the video | OpenAI |
| Brave / Tavily search | search queries derived from the validation plan | that search provider |
| Anthropic / OpenAI native search | queries + the assessment prompt | that provider |
| Source fetching | the URLs being fetched (your IP is visible to those sites) | each website |
| YouTube import | the video URL | YouTube |
| LM Studio, SearXNG, local Whisper | nothing | — |

---

## 4. Provider configuration

### 4.1 Anthropic Claude
1. Create a key in the Anthropic Console (console.anthropic.com → API keys).
2. Setup → Anthropic → paste the key → **Test connection**. A successful test lists your available models.
3. Pick a model (default `claude-sonnet-5`; `claude-haiku-4-5` is cheaper for extraction).

Errors: *Authentication failed* → key mistyped or revoked. *Could not resolve api.anthropic.com* → no internet or a proxy in the way. *Rate limited* → wait, or lower *Model requests / minute*.

### 4.2 OpenAI
1. Create a key at platform.openai.com → API keys.
2. Setup → OpenAI → paste → **Test connection**.
3. Pick a model (default `gpt-5.6-terra`; the `luna` tier is cheaper for extraction). Transcription models (`gpt-4o-mini-transcribe`) are configured under *Transcription* when that release lands.

### 4.3 LM Studio (local model) — manual steps required

LM Studio exposes an OpenAI-compatible server; Prediction Ledger talks to it over `http://127.0.0.1:1234/v1`.

1. Install LM Studio and download a chat model (for this workload an instruction-tuned model of 7B+ parameters with **JSON/structured output support** works best; smaller models will struggle with extraction quality).
2. Open the **Developer** tab (left sidebar, `>_` icon) and switch **Status** to *Running*. Note the port (default **1234**).
3. **Load the model** into the server (the *Select a model to load* dropdown at the top of the Developer tab, or from a terminal: `lms load <model-name>`).
4. If you enabled *Require API key* / auth in LM Studio's server settings, paste that key into Prediction Ledger's LM Studio *API key* field. Otherwise leave it blank.
5. In Prediction Ledger Setup → LM Studio: confirm the URL, click **Test connection**. Expected: *Connected — 1 model(s) available* and the model id appears in the Model dropdown.
6. Choose it for one or more stages under *Which model does what*, then Save.

Errors: *Nothing is listening at http://127.0.0.1:1234/v1/models* → the server is not running (step 2). *Server reachable but no models are loaded* → step 3. If you changed the port in LM Studio, change it here too. Keep *Serve on local network* **off** in LM Studio unless you specifically need it — Prediction Ledger only ever talks to it on loopback.

Tip: LM Studio's *Just-in-time model loading* setting lets the server load a model on first request; the connection test still needs at least one model listed.

### 4.4 Web search providers
- **Brave Search API** — api-dashboard.search.brave.com. Metered ($5 per 1,000 requests with a monthly credit; attribution required for the credit). Paste the key under *Web search*.
- **Tavily** — tavily.com; key-based. Check current free-tier limits on their site.
- **SearXNG** — self-hosted metasearch (Docker or pip). Enter its URL. Fully local; quality depends on which engines you enable.
- **Anthropic / OpenAI native web search** — no extra key; billed by the provider per search (~$10 per 1,000 as of Sept 2026). Results are still stored and fetched by the app.

---

## 4.5 Using Release 0.2

1. **Library → Import a transcript.** Drop an `.srt`, `.vtt`, `.txt`, or `.json` file (or paste text). Set **Published / recorded on** if you know it — relative deadlines like "within two years" are resolved from that date and are left *unknown* otherwise. Try `fixtures/transcripts/data-center-approvals.srt` with `2025-11-03`.
2. **Extract predictions.** Uses the provider chosen for *extraction* in Setup. Progress shows per transcript window. Re-running keeps anything you have edited, accepted, dismissed, or planned.
3. **Predictions tab.** Review each row: accept, dismiss, edit (creates a revision), split a component into its own prediction, or tick several and merge. The original quotation and timestamps never change.
4. **Generate validation plan.** Writes the evaluation criteria and search queries *before* any research. Edit it to create a new version; every version is kept. Research itself arrives in 0.3.
5. **Setup → Prompt templates** lets you override the system instructions for extraction, planning, evidence extraction, and assessment; the content blocks, fixed dates, and verdict rules are not overridable.

## 4.6 Research and verdicts (Release 0.3)

1. Choose a **Web search** provider in Setup and save. With *none*, the Research button explains what is missing and nothing runs.
2. In Predictions, open a row and click **Research**. If no plan exists the app generates one first (unless *Review the validation plan before research* is on in Setup → Research, in which case generate and read the plan first). Progress runs through: searching → fetching sources → reading sources → assessing.
3. The **verdict card** shows the evidence assessment (Supported / Partially supported / Contradicted / Insufficient evidence / Not assessable), the time status (Deadline pending / reached / unknown), confidence, explanation, remaining uncertainty, later developments, and — under *Rules applied by the app* — any adjustments the app made to the model's verdict (for example capping "supported" when the only support is an announcement).
4. The **Evidence** tab lists every stored item grouped by component, with stance, action stage, event date, syndication marker, the verbatim excerpt, and a link to the source. Only excerpts found in the retrieved page are kept; items the model invented are discarded and counted in *Coverage limitations*.
5. **Recheck** runs research again against the latest plan version and creates a new assessment version; older versions stay in History.
6. **Export** (Library, top right): JSON bundle or CSV. Neither contains settings or API keys.

Costs: each research run uses up to *Searches per research run* searches and *Sources fetched per run* page fetches (Setup → Limits), plus one model call per readable source and one for the assessment. Brave and provider-native search are metered; SearXNG is free but self-hosted.

## 4.7 Local video and audio import (Release 0.4)

1. Install **ffmpeg** (table above). In Setup → Transcription click **Check media tools**; it must say ffmpeg is found.
2. Choose the **engine**:
   - **Local Whisper** — audio never leaves your computer. Run `npm install @huggingface/transformers -w server` once (it is an optional dependency; the app works without it, but this engine reports *not installed*). The model named in *Local Whisper model* is downloaded into `<data directory>/models/` either on first use or ahead of time with Setup → Transcription → **Download model now** (progress shown) — this needs internet once, and *Allow internet access* must be on for that download. Default `onnx-community/whisper-base` is fast on CPU; `onnx-community/whisper-small` is noticeably more accurate; `whisper-large-v3-turbo` is the best and the slowest. Expect roughly 0.3–1× real time on a modern CPU for *base* (a 30-minute talk ≈ 10–30 minutes); this is the S-3 measurement still to be taken on real hardware.
   - **OpenAI transcription** — the audio chunks are uploaded to OpenAI (an OpenAI key must be saved in Setup → Providers). `whisper-1` returns segment timestamps; other models yield one segment per chunk.
3. In the Library, drop an MP4/MPEG/MOV/MKV/WebM (or M4A/MP3/WAV…) file onto the **Import a local video or audio file** card, optionally set the recorded date (used for deadlines — never guessed), and click **Upload and transcribe**. The file is copied into `<data directory>/media/` under its content hash; uploading the same file twice is recognised.
4. Progress shows as *Extracting audio…* then *Transcribing k/n chunks*. Long recordings are cut into 300-second chunks with 5 seconds of overlap (Setup → Transcription); each finished chunk is saved immediately, so you can close the browser or even stop the server and the job resumes at the next chunk.
5. A video that fails shows the reason and a **Retry** button (resumes) — for example *silent audio* or *engine not installed*. **Re-transcribe** on a ready video starts from scratch (it replaces the transcript and any corrections).

## 4.7b Sports Mode (Release 1.3)

Setup → **Sports Mode** tells the extractor that a video is game-pick content: each prediction about a specific game comes back as *team vs team* with the pick (win, spread, or total) and the game as its deadline; analysis, injuries and stats are not extracted. **Track point spreads** decides whether a spread pick is settled as a cover (default) or simplified to win/loss on the named team.

Sports picks are settled with the **Validate scores** button (Predictions → detail panel), which looks up the final score from trusted sources — league sites, ESPN, AP, CBS/Fox/NBC/Yahoo Sports, BBC/Sky, the Reference sites — and records Hit / Miss / Push, or *No final score yet* if the game has not been played or reported. It is refused before the game date. Since 1.4 the button confirms exactly three things — **winner, score, date** — by looking the game up once and storing a *game record*; every pick on that matchup (all four "Bills vs Chiefs" picks from a video, or the same game in another video) is then settled against that one record by rule. The detail panel shows the record with the quoted score line and its source. **Validate all scores** (Predictions page, with a video selected) does this for every game in the video in one go. A pick whose transcript never said the date picks the date up from the same look-up (deadline basis `lookup`). If no page states a final score, the picks stay *No final score yet*; the app never guesses a result. No validation plan review or deep research is involved.

## 4.8 YouTube links (Release 0.5)

1. Setup → YouTube → **Install yt-dlp** and confirm the download (~30 MB from the official GitHub release; SHA-256 verified). When YouTube changes and imports start failing, come back and click **Update yt-dlp** — that is the normal fix.
2. Choose which captions to accept: *creator captions, then auto-generated* (default), *creator only*, or *never* (always transcribe the audio with your engine). Auto-generated captions are quick but can mangle names and figures, and the quotes in your ledger are only as exact as the captions.
3. Leave **audio fallback** on if you want videos without captions transcribed (the audio is downloaded into `media/` and goes through the same chunked transcription as a local file). Turn it off to keep imports captions-only.
4. In the Library, paste a link (`youtube.com/watch?v=…`, `youtu.be/…`, Shorts, or a live replay), optionally set the recorded date (defaults to the upload date), and click **Import from YouTube**. Progress: *Reading video information* → *Fetching captions* (or *Downloading audio n%* → *Extracting audio* → *Transcribing chunk k of n*).
5. What can't be fetched: private, members-only, age-restricted, geo-blocked videos, live streams in progress, and anything YouTube bot-checks. Each shows a distinct message and the same fallback: download the captions or transcript yourself and use **Import a transcript**.

What leaves your computer: the video id goes to YouTube (via yt-dlp) and the yt-dlp installer contacts github.com. Nothing else. With *Allow internet access* off, the YouTube card is disabled and the API refuses the import up front.

## 5. Data directory

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\PredictionLedger` (e.g. `C:\Users\<you>\AppData\Local\PredictionLedger`) |
| macOS | `~/Library/Application Support/PredictionLedger` |
| Linux | `~/.local/share/prediction-ledger` |

Override with `PL_DATA_DIR`:

```powershell
# Windows (one session)
$env:PL_DATA_DIR = "D:\PredictionLedgerData"; npm start
```
```bash
# macOS / Linux
PL_DATA_DIR=/Volumes/Data/PredictionLedger npm start
```

**Back up** with Setup → Backups → *Back up now* or `npm run backup` (works while the app runs; writes `backups/manual-<timestamp>.db` plus a copy of `secret.key`). Since 1.10 the manual backup is *portable*: Polymarket US credentials and any live-trading authorization are removed from the copy and the account binding is marked *needs rebind* (an audit event records it). LLM/search keys remain in the copy, so treat the backup + key pair as sensitive, as before. Copying the whole directory while the app is stopped also works and includes media — that raw copy *does* contain the encrypted trading credentials. Since 2.0 the pre-migration backup taken before every migration is scrubbed the same way (no trading credentials, not armed). Rehearse an upgrade on a copy before upgrading real data: `npm run upgrade:rehearse -- <path-to-prediction-ledger.db>` (never touches the original; prints a before/after table and RESULT: OK or FINDINGS). **Restore**: stop the app, copy the backup `.db` over `prediction-ledger.db` and the `.secret.key` over `secret.key`, start again — the app migrates an older backup forward automatically (and takes a pre-migration backup first). A restored database always comes up with trading in paper mode; reconnect the Polymarket US key (same key → same binding, flagged for reconciliation) before anything downstream could ever activate. **Reset** by deleting the directory (you lose all imports, predictions, and saved keys).

Other environment variables: `PL_PORT` (default 7317), `PL_NO_OPEN=1` (don't open a browser), `PL_LOG_LEVEL` (`debug` for troubleshooting).

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm run setup` says Node is too old | Install Node 24 LTS; on Windows reopen the terminal so PATH refreshes. |
| `npm install` fails with `EACCES`/`EPERM` | Don't run as admin; make sure the repo folder is writable (OneDrive-synced folders can lock files — pause sync or move the repo). |
| `Prediction Ledger is not built yet` | Run `npm run build` (or `npm run setup`). |
| `port 7317 was busy; using 7318` | Normal. Another app holds 7317. Set `PL_PORT` if you want a fixed port. |
| `Ports 7317-7326 are all in use` | Set `PL_PORT=<free port>`. |
| Browser opens but shows "Cannot reach the local server" | The server exited — check the terminal for the error. The banner links to *Learn & Reference → Cannot reach the local server*. |
| Sidebar shows an older version than CHANGELOG.md | The server process was not restarted after the patch, or `npm run build` was skipped (§2.6). |
| Windows Firewall prompt on first start | Should not appear (loopback only). If it does, deny it; the app does not need network permissions. |
| macOS: "yt-dlp cannot be opened because the developer cannot be verified" | System Settings → Privacy & Security → *Allow anyway*, or `xattr -d com.apple.quarantine "<data directory>/tools/yt-dlp"`, then Retry the import. |
| YouTube import fails with `Sign in to confirm you're not a bot` or `HTTP Error 429` | YouTube is challenging this network. Wait, then Retry; **Update yt-dlp** (Setup → YouTube) fixes most cases. Import a transcript if it persists. |
| `The installed yt-dlp is too old for this app` | A yt-dlp on PATH predates the `--js-runtimes` option. Update it, or install the app-managed copy (Setup → YouTube) which takes precedence over PATH. |
| YouTube import worked yesterday, fails today with an odd error | YouTube changed something. **Update yt-dlp** first; check github.com/yt-dlp/yt-dlp/issues if it still fails. |
| Imported YouTube transcript has garbled names or numbers | It came from auto-generated captions (source chip *auto captions*). Click **Re-transcribe** to download the audio and use your own engine, or set *Captions to accept* to *creator only*. |
| A job fails with `The model did not answer within 120 s` | The provider or local model is overloaded or the window is too long for it. Raise *Model timeout* in Setup → Limits (slow local models may need 300+ s), then Retry from the Jobs tab. |
| A job fails with `HTTP 429` after several tries | The provider's rate limit. Lower *Requests per minute* in Setup → Limits and retry; the app already waits for `Retry-After`. |
| `yt-dlp` install fails with `Checksum mismatch` | The download was corrupted or tampered with; nothing was installed. Retry; if it repeats, download `yt-dlp` manually from the official release and set `PL_YTDLP_PATH`. |
| `Secret key file … is corrupt` | `secret.key` was altered. Delete it; re-enter API keys in Setup. |
| Dashboard shows old UI after upgrading | Run `npm run build` again; hard-refresh the browser. |
| LM Studio test hangs | Very large model still loading; wait for LM Studio to show *Loaded*, then retry. |
| `ExperimentalWarning: SQLite is an experimental feature` in the console | Harmless on Node 22; gone on Node 24+. |
| Extraction fails with `Stage "extraction" is routed to … disabled` | Enable that provider in Setup or route the stage elsewhere under *Which model does what*. |
| Extraction fails with `did not match the extraction_output schema` | The model returned unusable JSON twice. Try a stronger model, or for LM Studio a model that supports JSON output; the raw problem is in the Jobs tab. |
| Plan/extraction fails with `Internet access is disabled` | Privacy switch is off but the stage is routed to a cloud provider. Route it to LM Studio or enable internet. |
| Imported transcript has "synthetic" timestamps | Plain text without time stamps. Predictions still work; add `[hh:mm:ss]` prefixes for real positions. |
| Research fails with `Every search failed` | The search provider rejected the key or is unreachable — check Setup → Web search and the provider's dashboard; nothing was concluded about the prediction. |
| Verdict is "Insufficient evidence" with few sources | Coverage was thin (see the Evidence tab → Coverage limitations). Raise the search/source budgets, add a better provider, or recheck later. |
| A source shows "blocked … non-public address" | The URL resolved to a private/local address; the app refuses to fetch it by design. |
| Upload fails with `ffmpeg/ffprobe were not found` | Install ffmpeg (Prerequisites) and reopen the terminal so PATH refreshes; or set `PL_FFMPEG_PATH`. Setup → *Check media tools* confirms. |
| `The file has no audio track` / `Could not read the media file` | The file is video-only, corrupt, or an unsupported container. Re-export it, or import a transcript instead. |
| Video fails with `The audio track is silent` | ffmpeg measured below −60 dB for the whole track — usually a muted export. Check the file locally; nothing to transcribe. |
| `Local Whisper engine is not installed` | `npm install @huggingface/transformers -w server`, then Retry. |
| `Whisper model … is not downloaded and internet access is disabled` | Turn *Allow internet access* on for the first run (one-time model download), then Retry; turn it off again afterwards if you like. |
| First local transcription is very slow or memory-heavy | The model is being downloaded/compiled the first time; later runs are faster. Use `whisper-base` for speed, or reduce *Chunk length*. |
| Transcription produced no text | The audio may be music, noise, or in a language the model did not detect — set *Language* explicitly and Re-transcribe. |

Logs: the terminal running `npm start`. Set `PL_LOG_LEVEL=debug` for more detail. API keys are redacted from logs.

### 4.15 Owner acceptance for 1.14 (automation) — do not arm on a real account until these hold

1. Run the fake exit demo: `npm test -- automation` (and `autopilot.e2e` on macOS/Linux) — 9 tests; read the *Automation runs* they leave behind if you point `PL_DATA_DIR` at a scratch folder.
2. Complete §4.14 first (one manual order, cents). Automation must not be armed before a manual order has been verified end to end.
3. Let the paper soak run: Setup → *Automatic execution* → *Paper autopilot* on, in paper mode, for at least seven days and ≥ 100 evaluations across ≥ 10 events (O07); watch *Automation runs*, the alerts and the paper book. Then Setup → Trades → *Forecast evaluation* — a category qualifies only when the production evaluation passes (Brier ≤ market baseline over ≥ 100 settled events, ≥ 20 observations per weighted creator, ≥ 2 independent clusters). Until then the *Arm* button stays disabled ("qualified categories: none").
4. When a category qualifies: review the limits and budgets, note the policy hash on the card, arm with the acknowledgement, and keep the order budget at the pilot default ($10) or lower. Keep the app open in view for the first ticks; press **Emergency stop** at anything unexpected and record it in VERIFICATION.md.

### 4.16 Owner acceptance for 2.0 (release candidate → 2.0.0) — the evidence only you can produce

None of these is done by the automated suite; each is recorded in `docs/VERIFICATION.md` when you have run it. Until all are recorded the build stays `2.0.0-rc.1`.

1. **Windows run with real content (O06).** `npm install`, `npm run typecheck`, `npm run build`, `npm test` (record the exact counts), then import one current public video and one fixture and check the quote/timestamp, the plan, the research and the verdict as in §3.
2. **Key-file protection (O01).** `npm run doctor` must print `secret.key protection  OK — icacls: …` naming only your account (plus SYSTEM/Administrators). If it prints OPEN, run the fix it shows, then re-run doctor. The app applies this on first start and reports it on Setup → Backups and in `GET /api/health`.
3. **Upgrade rehearsal on your real 1.9 data (O05).** Stop the app (or use a backup copy). `npm run upgrade:rehearse -- "<path>\prediction-ledger.db"` — expect `RESULT: OK`, every table `n → n`, "Live trading after upgrade: disarmed". Try `--interrupt-after 13` once to see the interrupted-and-rerun path. Paste the table into VERIFICATION.md. Only then start the new build on the real directory (it takes its own scrubbed pre-migration backup first).
4. **Restore drill (O02).** Setup → Backups → *Back up now*; copy the `.db` into an empty folder, start the app with `PL_DATA_DIR` pointing there: trading must be *paper*, the account *needs rebind*, and any unknown submission still unknown. Then delete that folder.
5. **The capped smoke test (§4.14) and the automation walk-through (§4.15)** — unchanged, still pending.
6. **The real seven-day paper soak (O07).** Paper mode, Setup → *Automatic execution* → *Paper autopilot* on, the app running for seven calendar days on real venue data (sleep the machine at least once; pull the network cable once). Then `npm run report:soak --out docs/reports/<date>-soak.md` (or Setup → Automatic execution → *paper-soak report*). The verdict must be **complete** with zero duplicate entries and zero cap breaches; attach the file. The synthetic `docs/reports/2026-09-17-soak-harness-rehearsal.md` is a harness rehearsal, not this.
7. **Qualification (FOR-06/07).** `npm run report:qualification -- --category sports` (or the Setup link). It will say **pending — N of 100 distinct settled events** until enough real events have settled. When it says *qualified*, record the production evaluation deliberately (Setup → Automatic execution → *Record production evaluation*, or `POST /api/forecasts/evaluation/record` with its acknowledgement — a separate owner action that also revokes an earlier pass if the newest evaluation fails) and attach the report. Fixtures, the harness run and hand-inserted rows never count; arming stays refused until this exists.
8. **First real settlement (RV-04).** After your first settled live position, open Trades → Positions: if a `settlement:<activity>` discrepancy hold appeared, the venue's `positionResolution.side` means the account's side rather than the winner — report it so the reading can be fixed; if no hold appeared and the P&L matches the venue's statement, note that in VERIFICATION.md.
