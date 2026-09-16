/**
 * Prediction Ledger — application shell, hash router, and navigation.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Routes (hash-based so the static build needs no server rewrites):
 *   #/library · #/videos/:id · #/predictions[?videoId=…] · #/jobs · #/setup
 */
import { useEffect, useState } from "react";
import type { HealthResponse } from "@prediction-ledger/shared";
import { alertsApi, api } from "./api";
import { SetupPage } from "./pages/SetupPage";
import { LibraryPage } from "./pages/LibraryPage";
import { VideoPage } from "./pages/VideoPage";
import { PredictionsPage } from "./pages/PredictionsPage";
import { JobsPage } from "./pages/JobsPage";
import { MarketsPage } from "./pages/MarketsPage";
import { SignalsPage } from "./pages/SignalsPage";

export interface Route {
  name: "library" | "video" | "predictions" | "markets" | "signals" | "jobs" | "setup";
  id?: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const query = new URLSearchParams(queryPart ?? "");
  const parts = pathPart.split("/").filter(Boolean);
  if (parts[0] === "videos" && parts[1]) return { name: "video", id: parts[1], query };
  if (parts[0] === "predictions") return { name: "predictions", query };
  if (parts[0] === "markets") return { name: "markets", query };
  if (parts[0] === "signals") return { name: "signals", query };
  if (parts[0] === "jobs") return { name: "jobs", query };
  if (parts[0] === "setup") return { name: "setup", query };
  return { name: "library", query };
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith("#") ? to : `#${to}`;
}

const TABS: { name: Route["name"]; label: string; to: string }[] = [
  { name: "library", label: "Video Library", to: "/library" },
  { name: "predictions", label: "Predictions", to: "/predictions" },
  { name: "markets", label: "Markets", to: "/markets" },
  { name: "signals", label: "Signals", to: "/signals" },
  { name: "jobs", label: "Jobs", to: "/jobs" },
  { name: "setup", label: "Setup", to: "/setup" },
];

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [openAlerts, setOpenAlerts] = useState(0);

  useEffect(() => {
    const refreshAlerts = () => alertsApi.list().then((r) => setOpenAlerts(r.open)).catch(() => undefined);
    const onHash = () => { setRoute(parseHash(window.location.hash)); void refreshAlerts(); };
    void refreshAlerts();
    const timer = setInterval(refreshAlerts, 120_000);
    window.addEventListener("hashchange", onHash);
    api
      .health()
      .then((h) => {
        setHealth(h);
        // First run: land on Setup if nothing is configured yet; otherwise Library.
        if (!window.location.hash) navigate("/library");
      })
      .catch((e: Error) => setHealthError(e.message));
    return () => { window.removeEventListener("hashchange", onHash); clearInterval(timer); };
  }, []);

  const active = route.name === "video" ? "library" : route.name;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">▣</span>
          <a href="#/library" className="brand-link">Prediction Ledger</a>
          {health && <span className="version">v{health.version}</span>}
        </div>
        <nav aria-label="Primary">
          {TABS.map((t) => (
            <a key={t.name} href={`#${t.to}`} className={active === t.name ? "tab active" : "tab"} aria-current={active === t.name ? "page" : undefined}>
              {t.label}{t.name === "signals" && openAlerts > 0 && <span className="badge" aria-label={`${openAlerts} open alerts`}>{openAlerts}</span>}
            </a>
          ))}
        </nav>
      </header>

      {healthError && (
        <div className="banner error" role="alert">
          Cannot reach the local server: {healthError}. Make sure <code>npm start</code> is running.
        </div>
      )}

      <main className="content">
        {route.name === "library" && <LibraryPage />}
        {route.name === "video" && route.id && <VideoPage id={route.id} />}
        {route.name === "predictions" && <PredictionsPage initialVideoId={route.query.get("videoId") ?? undefined} initialPredictionId={route.query.get("id") ?? undefined} />}
        {route.name === "markets" && <MarketsPage />}
        {route.name === "signals" && <SignalsPage />}
        {route.name === "jobs" && <JobsPage />}
        {route.name === "setup" && <SetupPage />}
      </main>

      <footer className="footer">
        Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0
        {health ? <span> · Data: <code>{health.dataDir}</code></span> : null}
      </footer>
    </div>
  );
}
