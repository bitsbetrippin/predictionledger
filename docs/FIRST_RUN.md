# First real run — the checklist that turns 1.0.0-rc.1 into 1.0.0

Everything in this repository has been unit- and integration-tested against fake providers, a real ffmpeg, and a fake yt-dlp, but **no machine has yet run `npm run setup` / `npm start` on the real dependencies**. This checklist is the shortest path to that run, and to reporting back exactly what is needed to close the gap. Expect a few small compile-time surprises on step 3; that is normal for a first build and they are usually one-line fixes.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## 0. Before you start (once)
- Copy the `.github/` folder from the release zip into the repo if it is missing (some sync tools skip dot-folders).
- Delete the stale `web/src/pages/PlaceholderPage.tsx` if it still exists.
- Windows: `winget install Gyan.FFmpeg`, then **open a new terminal**. macOS: `brew install ffmpeg`.

## 1. Environment report
```
npm run doctor
```
Paste the block it prints (no keys in it). It tells us Node/npm versions, whether ffmpeg is visible, where the data directory is, and whether port 7317 is free.

## 2. Install and build
```
npm run setup
```
Report: the full output if it stops. Typical first-build issues and what to paste:
- **TypeScript errors** in `server/` or `web/`: paste the `error TS…` lines (file:line and message).
- **npm ERR! ERESOLVE / peer dependency**: paste the `npm ERR!` block.
- **`node:sqlite` missing**: your Node is older than 22.13 — install Node 24 LTS.
- **Vite build error**: paste from `vite v…` to the end.

Then commit the generated `package-lock.json` (GitHub Desktop will show it as a new file).

## 3. Tests
```
npm test
```
Report: the final summary (`# pass N / # fail N`) and, for any failure, the `not ok` block. Expected on Windows: the fake-yt-dlp end-to-end test is skipped (needs a POSIX shell); everything else should pass. The ffmpeg integration tests run only if ffmpeg is on PATH.

## 4. Start, stop, port walk
```
npm start
```
Expect a `PREDICTION_LEDGER_READY http://127.0.0.1:7317` line and the dashboard opening. Press Ctrl+C: it should exit cleanly. Start it again while a first copy runs: expect `port 7317 was busy; using 7318`. Report anything else verbatim.

## 5. Setup tab
Enter one provider key (Anthropic or OpenAI) or point LM Studio at a loaded model; click **Test**. Choose a search provider if you have a key. Report any test result that is not a green check, with its message.

## 6. Transcript → predictions → research (fake-free)
Library → Import a transcript → `fixtures/transcripts/data-center-approvals.srt`, published **2025-11-03** → Extract predictions → open the "within two years…" row → Research. Report: how many predictions were extracted (expected 2), the verdict fields, and any job error from the Jobs tab.

## 7. Local video (spike S-3)
Optionally `npm install @huggingface/transformers -w server`, keep *Allow internet access* on, Setup → Transcription → **Download model now**. Then drop any short MP4 into the Library. Report: model download time, transcription wall-clock vs. video length (e.g. "5-minute clip took 2m10s"), and the machine's CPU/RAM. That number decides the default model.

## 8. YouTube (spike S-4)
Setup → YouTube → **Install yt-dlp**. Import one public video that has captions and one that does not. Report: whether the install completed, and each import's outcome or error text verbatim (especially anything mentioning `--js-runtimes`, `Sign in to confirm`, or `n challenge`).

## 9. Evals (optional, costs a few cents)
```
npm run build && npm run eval --filter-providers anthropic
```
Report the score table `promptfoo` prints; it goes into `docs/VERIFICATION.md`.

## 10. Backup and restart recovery
Setup → Backups → **Back up now** (report the file name). Start a long transcription, kill the terminal, `npm start` again: the video should resume from the next chunk. Report what the Library shows after restart.

When these are in, the release is verified on your platform; the remaining platform column in `docs/VERIFICATION.md` is filled the same way.
