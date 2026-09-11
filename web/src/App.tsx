/**
 * Prediction Ledger — application shell and navigation.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Release 0.1 ships the shell with the Setup tab live and the other tabs as
 * placeholders that describe what arrives in which release (docs/BUILD_PLAN.md).
 */
import { useEffect, useState } from "react";
import type { HealthResponse } from "@prediction-ledger/shared";
import { api } from "./api";
import { SetupPage } from "./pages/SetupPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";

type Tab = "library" | "predictions" | "jobs" | "setup";

const TABS: { id: Tab; label: string }[] = [
  { id: "library", label: "Video Library" },
  { id: "predictions", label: "Predictions" },
  { id: "jobs", label: "Jobs" },
  { id: "setup", label: "Setup" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("setup");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((e: Error) => setHealthError(e.message));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ▣
          </span>
          <span>Prediction Ledger</span>
          {health && <span className="version">v{health.version}</span>}
        </div>
        <nav aria-label="Primary">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {healthError && (
        <div className="banner error" role="alert">
          Cannot reach the local server: {healthError}. Make sure <code>npm start</code> is running.
        </div>
      )}

      <main className="content">
        {tab === "setup" && <SetupPage />}
        {tab === "library" && (
          <PlaceholderPage
            title="Video Library"
            release="0.2 / 0.3"
            body="Import a local MP4/MPEG file, paste a YouTube URL, or import an existing transcript. Each video gets a detail page with metadata and a timestamped transcript."
          />
        )}
        {tab === "predictions" && (
          <PlaceholderPage
            title="Predictions"
            release="0.4 – 0.7"
            body="Predictions grouped by video: Prediction | Deadline | Result | Time status | Brief explanation | Sources | Last checked — with a detail panel showing the quotation, normalized claim, generated validation prompt, evidence, and assessment history."
          />
        )}
        {tab === "jobs" && (
          <PlaceholderPage
            title="Background Jobs"
            release="0.2"
            body="Progress for transcription, extraction, and research runs. The queue itself is already live and durable (see Setup → Diagnostics); the UI lands with the first long-running job kind."
          />
        )}
      </main>

      <footer className="footer">
        Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0 ·{" "}
        {health ? (
          <span>
            Data: <code>{health.dataDir}</code>
          </span>
        ) : null}
      </footer>
    </div>
  );
}
