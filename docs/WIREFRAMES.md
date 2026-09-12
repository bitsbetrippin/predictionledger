# Dashboard Wireframes (text mockups)

Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0

These are the agreed screen shapes. The Setup tab (§5) is implemented in Release 0.1; the others land per `BUILD_PLAN.md`. Design rules: system fonts, light/dark aware, no technical configuration inside the review flow, every long operation shows a stage label, every empty state says what to do next.

## 1. Shell

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ▣ Prediction Ledger v0.x      [Video Library] [Predictions] [Jobs] [Setup]        │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   (page content, max-width 1100px, centered)                                     │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Original concept: Michael D. Carter (BitsBeTrippin) · Claude AI · Apache-2.0     │
│ Data: C:\Users\…\AppData\Local\PredictionLedger                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Video Library (Release 0.2 / 0.4 / 0.5)

```
┌─ Video Library ───────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────┐ ┌───────────────────────────────────────────┐ │
│ │  ⬇  Drop MP4/MPEG here       │ │ YouTube URL  [https://youtube.com/…  ] [Import] │
│ │     or  [Choose file…]       │ │ Transcript   [Import SRT/VTT/TXT/JSON…]  │ │
│ └──────────────────────────────┘ └───────────────────────────────────────────┘ │
│                                                                               │
│ Title                         Source    Duration  Published   Predictions  Status│
│ ─────────────────────────────────────────────────────────────────────────────── │
│ Q3 Mining Outlook             YouTube   42:10     2025-11-03   7 (2 pending) Ready│
│ interview_raw.mp4             Local     28:55     —            —            ▮▮▮▯▯ Transcribing chunk 7/12│
│ energy-panel.srt              Transcript 55:00    2026-01-15   12          Ready │
│                                                                               │
│ muted-talk.mp4                Local     03:00     —            —            ✖ Failed: audio track is silent  [Retry]│
│                                                                               │
│ (empty)  "No videos yet. Drop a file, paste a YouTube link, or import a        │
│          transcript to get started."                                          │
└───────────────────────────────────────────────────────────────────────────────┘
```

As built in 0.4: a banner above the import cards appears only when `GET /api/media/status` reports a missing ffmpeg or an engine that is not ready (with a link to Setup); the upload button is disabled without ffmpeg. Rows in *importing*/*transcribing* refresh every 1.5 s and show chunk progress; *failed* rows show the stored reason with **Retry** (resume); *ready* rows imported from media get **Re-transcribe** (start over, confirmed). Extract and Delete are disabled while media processing runs.

## 3. Video detail (Release 0.2 / 0.4)

```
┌─ Q3 Mining Outlook ───────────────────────────────────────────────────────────┐
│ YouTube · 42:10 · published 2025-11-03 · en · imported 2026-09-12              │
│ [Extract predictions]  [Re-transcribe ▾]  [Export ▾]  [Delete]                 │
├─────────────────────────────────────┬─────────────────────────────────────────┤
│ Transcript                          │ Predictions in this video (7)           │
│ 00:00:12  Welcome back everyone…    │ ● 00:14:02  Within two years, data      │
│ 00:00:31  Today we're looking at…   │            center approvals will…       │
│ …                                   │   Deadline 2027-11-03 · Not researched  │
│ 00:14:02 ▌Within two years, data    │ ● 00:21:40  Hashprice might recover…    │
│          center approvals will be   │   Deadline unknown · Pending            │
│          narrowed down to…          │ …                                       │
│   [✎ correct this segment]          │                                         │
│                                     │                                         │
│ (original text is kept; corrections │                                         │
│  are shown with a marker)           │                                         │
└─────────────────────────────────────┴─────────────────────────────────────────┘
```

## 4. Predictions table + detail panel (Release 0.2 → 0.3)

```
┌─ Predictions ─────────────────────────────────────────────────────────────────┐
│ Filter: Video [All ▾]  Topic [All ▾]  Result [All ▾]  Deadline [Any ▾]  🔍     │
├───────────────────────────────────────────────────────────────────────────────┤
│ ▸ Q3 Mining Outlook (7)                                                       │
│  Prediction               Deadline    Result          Time status   Brief explanation          Sources  Last checked│
│  Within two years, data   2027-11-03  Insufficient    Deadline      Local cancellations are     3       2026-09-12 │
│  center approvals will…               evidence        pending       documented; no evidence of…                  │
│  Hashprice might recover  unknown     — not researched Deadline     —                           —       —          │
│  …                                                     unknown                                                   │
│ ▸ energy-panel.srt (12)                                                       │
├───────────────────────────────────────────────────────────────────────────────┤
│ Detail — "Within two years, data center approvals will be narrowed down…"    │
│ ┌ Quotation ───────────────────────────────────────────────────────────────┐ │
│ │ 00:14:02–00:14:19 · speaker: unknown                                     │ │
│ │ "…and honestly, within two years, data center approvals will be narrowed │ │
│ │  down to government lands because local markets keep cancelling the      │ │
│ │  permits. That's just where this is heading…"                            │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ Normalized: Within ~2 years of 2025-11-03, new data-center approvals will be  │
│ restricted to government-owned land (geography unspecified).                  │
│ Components:  [future claim] approvals restricted to government land            │
│              [premise]      local jurisdictions are cancelling permits         │
│              [causal link]  cancellations cause the restriction                │
│ Ambiguities: geography unstated · "narrowed down" threshold undefined          │
│ Tabs: [Validation plan v2 ▾] [Evidence (3)] [Assessment history (1)]          │
│ Controls: [Edit] [Split] [Merge…] [Dismiss]  [Generate plan] [Research] [Recheck]│
└───────────────────────────────────────────────────────────────────────────────┘
```

## 5. Setup (Release 0.1 — implemented)

```
┌─ Setup ───────────────────────────────────────────────────────────────────────┐
│ Everything is stored on this computer in <dataDir>. Cloud providers and online│
│ research send selected text outside this machine — local options do not.      │
│                                                                               │
│ Privacy      [x] Allow internet access …                                      │
│                                                                               │
│ Language-model providers                                                      │
│ ┌ [x] Anthropic Claude  (cloud) ───────────────────────────────────────────┐  │
│ │ API key  [••••••••• Saved: sk-ant-…4f2a — type to replace]              │  │
│ │ Model    [claude-sonnet-5            ▾]  (discovered list + free text)   │  │
│ │ [Test connection]  ✓ Connected — 12 model(s) available (412 ms)          │  │
│ └──────────────────────────────────────────────────────────────────────────┘  │
│ ┌ [ ] OpenAI (cloud) ─────────────────────────────────────────────────────┐   │
│ ┌ [x] LM Studio (local) ──────────────────────────────────────────────────┐   │
│ │ Server URL [http://127.0.0.1:1234/v1]   API key [optional]              │   │
│ │ Model [qwen2.5-7b-instruct ▾]  [Test connection] ✕ Nothing is listening…│   │
│ └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│ Which model does what                                                         │
│  Extraction [LM Studio ▾] [model override]   Validation plan [Anthropic ▾]    │
│  Assessment [Anthropic ▾]                                                     │
│                                                                               │
│ Transcription  Engine [Local Whisper ▾]  Model [onnx-community/whisper-base]  │
│ Web search     Provider [Brave ▾]  API key [•••••]                            │
│ Limits         Concurrent jobs [2]  Searches/run [8]  Sources/run [12]  RPM [30]│
│                                                                               │
│                                                        [ Save settings ]      │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 6. Jobs (Release 0.4)

```
┌─ Background Jobs ─────────────────────────────────────────────────────────────┐
│ Kind                 Subject               Progress                 Status     │
│ transcript.generate  interview_raw.mp4     ▮▮▮▮▮▮▯▯▯▯ 58% chunk 7/12 running  [Cancel]│
│ research.run         "Within two years…"   ▮▮▮▯▯▯▯▯▯▯ 30% fetching 3/12 running  [Cancel]│
│ prediction.extract   energy-panel.srt      ▮▮▮▮▮▮▮▮▮▮ 100%          completed         │
│ plan.generate        "Hashprice might…"    ▯▯▯▯▯▯▯▯▯▯ 0%  Provider returned HTTP 401  failed  [Retry]│
└───────────────────────────────────────────────────────────────────────────────┘
```

## 7. State vocabulary shown to users

| Internal | Shown as |
|---|---|
| `evidence_assessment = insufficient` | *Insufficient evidence* (never "false") |
| `time_status = pending` | *Deadline pending* (never "failed") |
| `processing = not_researched` | *— not researched* with a Research button |
| job `failed` | the provider's or app's message, verbatim, + Retry |
| job `queued` after restart | *Recovered after restart — waiting* |
