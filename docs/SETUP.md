# Setup Guide — providers, LM Studio, external tools, and troubleshooting

Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0

This guide covers everything that is *not* just `npm run setup` + `npm start`. The README has the quick start.

---

## 1. Prerequisites

| Requirement | Windows | macOS | Notes |
|---|---|---|---|
| **Node.js 24 LTS** (≥ 22.13 works) | Installer from nodejs.org, or `winget install OpenJS.NodeJS.LTS` | Installer from nodejs.org, or `brew install node@24` | `node --version` must print v22.13+ / v24.x. |
| **Git** (or GitHub Desktop) | GitHub Desktop bundles Git | GitHub Desktop bundles Git | Only needed to clone/update. |
| ffmpeg *(Release 0.4+)* | `winget install Gyan.FFmpeg` then reopen the terminal | `brew install ffmpeg` | Needed for local video import only. `npm run setup` reports whether it is found. |
| yt-dlp *(Release 0.5+)* | downloaded by the app into the data directory after you approve it | same | Nothing to install manually. |
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

### 4.4 Web search providers *(active in Release 0.3)*
- **Brave Search API** — api-dashboard.search.brave.com. Metered ($5 per 1,000 requests with a monthly credit; attribution required for the credit). Paste the key under *Web search*.
- **Tavily** — tavily.com; key-based. Check current free-tier limits on their site.
- **SearXNG** — self-hosted metasearch (Docker or pip). Enter its URL. Fully local; quality depends on which engines you enable.
- **Anthropic / OpenAI native web search** — no extra key; billed by the provider per search (~$10 per 1,000 as of Sept 2026). Results are still stored and fetched by the app.

---

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

**Back up** by copying the whole directory while the app is stopped. **Reset** by deleting it (you lose all imports, predictions, and saved keys).

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
| macOS: "yt-dlp cannot be opened because the developer cannot be verified" *(0.5+)* | System Settings → Privacy & Security → *Allow anyway*, or `xattr -d com.apple.quarantine <path>` for the file under the data directory's `tools/`. |
| `Secret key file … is corrupt` | `secret.key` was altered. Delete it; re-enter API keys in Setup. |
| Dashboard shows old UI after upgrading | Run `npm run build` again; hard-refresh the browser. |
| LM Studio test hangs | Very large model still loading; wait for LM Studio to show *Loaded*, then retry. |
| `ExperimentalWarning: SQLite is an experimental feature` in the console | Harmless on Node 22; gone on Node 24+. |

Logs: the terminal running `npm start`. Set `PL_LOG_LEVEL=debug` for more detail. API keys are redacted from logs.
