# Setup Guide — providers, LM Studio, external tools, and troubleshooting

Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0

This guide covers everything that is *not* just `npm run setup` + `npm start`. The README has the quick start.

---

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

**Back up** with Setup → Backups → *Back up now* or `npm run backup` (works while the app runs; writes `backups/manual-<timestamp>.db` plus a copy of `secret.key`). Copying the whole directory while the app is stopped also works and includes media. **Restore**: stop the app, copy the backup `.db` over `prediction-ledger.db` and the `.secret.key` over `secret.key`, start again — the app migrates an older backup forward automatically (and takes a pre-migration backup first). **Reset** by deleting the directory (you lose all imports, predictions, and saved keys).

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
| Browser opens but shows "Cannot reach the local server" | The server exited — check the terminal for the error. |
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
