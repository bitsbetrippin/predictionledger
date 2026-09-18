/**
 * Prediction Ledger — application root: hash router, shell state (health, navigation badges) and page switch.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Routes (hash-based so the static build needs no server rewrites):
 *   #/library · #/videos/:id · #/predictions[?videoId=…&id=…] · #/markets · #/signals[?view=sides|consensus|alerts|creators]
 *   #/paper · #/trades · #/jobs · #/setup[?section=…] · #/learn[?topic=<id>]
 */
import { useEffect, useState } from "react";
import type { HealthResponse } from "@prediction-ledger/shared";
import { alertsApi, api, automationApi, content } from "./api";
import { SetupPage } from "./pages/SetupPage";
import { LibraryPage } from "./pages/LibraryPage";
import { VideoPage } from "./pages/VideoPage";
import { PredictionsPage } from "./pages/PredictionsPage";
import { JobsPage } from "./pages/JobsPage";
import { MarketsPage } from "./pages/MarketsPage";
import { SignalsPage } from "./pages/SignalsPage";
import { PaperPage } from "./pages/PaperPage";
import { TradesPage } from "./pages/TradesPage";
import { LearnPage } from "./pages/LearnPage";
import { Shell, type NavBadges } from "./components/Shell";
import { LearnProvider } from "./components/LearnPanel";
import type { ScreenName } from "./help/context";

export interface Route {
  name: ScreenName;
  id?: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const query = new URLSearchParams(queryPart ?? "");
  const parts = pathPart.split("/").filter(Boolean);
  if (parts[0] === "videos" && parts[1]) return { name: "video", id: parts[1], query };
  const names: ScreenName[] = ["predictions", "markets", "signals", "paper", "trades", "jobs", "setup", "learn"];
  const hit = names.find((n) => n === parts[0]);
  if (hit) return { name: hit, query };
  return { name: "library", query };
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith("#") ? to : `#${to}`;
}

const EMPTY_BADGES: NavBadges = { transcribing: 0, predictions: 0, tradingAlerts: 0, watchAlerts: 0, runningJobs: 0 };

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [badges, setBadges] = useState<NavBadges>(EMPTY_BADGES);

  useEffect(() => {
    let alive = true;
    // Navigation badges: watch alerts (Signals), trading alerts (Trades), transcribing videos (Library), predictions, running jobs.
    const refreshBadges = async () => {
      const [watch, trading, videos, preds, jobs] = await Promise.all([
        alertsApi.list().catch(() => null),
        automationApi.alerts(true).catch(() => null),
        content.listVideos().catch(() => null),
        content.listPredictions({}).catch(() => null),
        api.listJobs().catch(() => null),
      ]);
      if (!alive) return;
      setBadges({
        watchAlerts: watch?.open ?? 0,
        tradingAlerts: trading?.filter((a) => !a.acknowledgedAt).length ?? 0,
        transcribing: videos?.filter((v) => v.status === "importing" || v.status === "transcribing").length ?? 0,
        predictions: preds?.length ?? 0,
        runningJobs: jobs?.filter((j) => j.status === "running" || j.status === "queued").length ?? 0,
      });
    };
    const onHash = () => { setRoute(parseHash(window.location.hash)); void refreshBadges(); };
    void refreshBadges();
    const timer = setInterval(() => void refreshBadges(), 60_000);
    window.addEventListener("hashchange", onHash);
    api
      .health()
      .then((h) => {
        if (!alive) return;
        setHealth(h);
        setHealthError(null);
        if (!window.location.hash) navigate("/library");
      })
      .catch((e: Error) => { if (alive) setHealthError(e.message); });
    return () => { alive = false; window.removeEventListener("hashchange", onHash); clearInterval(timer); };
  }, []);

  const screen: ScreenName = route.name;
  return (
    <LearnProvider screen={screen}>
      <Shell screen={screen} health={health} healthError={healthError} badges={badges}>
        {route.name === "library" && <LibraryPage />}
        {route.name === "video" && route.id && <VideoPage id={route.id} />}
        {route.name === "predictions" && <PredictionsPage initialVideoId={route.query.get("videoId") ?? undefined} initialPredictionId={route.query.get("id") ?? undefined} />}
        {route.name === "markets" && <MarketsPage />}
        {route.name === "signals" && <SignalsPage view={route.query.get("view") ?? undefined} />}
        {route.name === "paper" && <PaperPage />}
        {route.name === "trades" && <TradesPage />}
        {route.name === "jobs" && <JobsPage />}
        {route.name === "setup" && <SetupPage section={route.query.get("section") ?? undefined} />}
        {route.name === "learn" && <LearnPage topicId={route.query.get("topic") ?? undefined} />}
      </Shell>
    </LearnProvider>
  );
}
