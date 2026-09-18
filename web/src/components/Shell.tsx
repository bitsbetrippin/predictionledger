/**
 * Prediction Ledger — application shell (2.1): grouped left sidebar (Research · Markets · Operate · System), header
 * (title · subtitle · Search reference · page "?"), status footer (loopback address · data directory · version · licence),
 * drawer navigation below 880 px, and the Guided-start pill. Alert badges: trading alerts on Trades, watch alerts on Signals.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { HealthResponse } from "@prediction-ledger/shared";
import { SCREEN_TITLES, screenTopics, type ScreenName } from "../help/context";
import { useGuidedStart } from "../hooks/useGuidedStart";
import { Icon, type IconName } from "./Icons";
import { useLearn } from "./LearnPanel";

export interface NavBadges { transcribing: number; predictions: number; tradingAlerts: number; watchAlerts: number; runningJobs: number }

interface NavItem { name: ScreenName; label: string; to: string; icon: IconName; badge?: (b: NavBadges) => { n: number; tone?: "warn" | "info"; label: string } | undefined }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Research", items: [
    { name: "library", label: "Video Library", to: "/library", icon: "video", badge: (b) => (b.transcribing ? { n: b.transcribing, tone: "info", label: `${b.transcribing} transcribing` } : undefined) },
    { name: "predictions", label: "Predictions", to: "/predictions", icon: "listChecks", badge: (b) => (b.predictions ? { n: b.predictions, label: `${b.predictions} predictions` } : undefined) },
  ] },
  { group: "Markets", items: [
    { name: "markets", label: "Markets", to: "/markets", icon: "storefront" },
    { name: "signals", label: "Signals", to: "/signals", icon: "pulse", badge: (b) => (b.watchAlerts ? { n: b.watchAlerts, label: `${b.watchAlerts} open watch alerts` } : undefined) },
    { name: "paper", label: "Paper", to: "/paper", icon: "notebook" },
  ] },
  { group: "Operate", items: [
    { name: "trades", label: "Trades", to: "/trades", icon: "scales", badge: (b) => (b.tradingAlerts ? { n: b.tradingAlerts, tone: "warn", label: `${b.tradingAlerts} open trading alerts` } : undefined) },
    { name: "jobs", label: "Jobs", to: "/jobs", icon: "queue", badge: (b) => (b.runningJobs ? { n: b.runningJobs, tone: "info", label: `${b.runningJobs} running` } : undefined) },
  ] },
  { group: "System", items: [
    { name: "setup", label: "Setup", to: "/setup", icon: "slidersHorizontal" },
    { name: "learn", label: "Learn & Reference", to: "/learn", icon: "bookOpenText" },
  ] },
];

export function Shell({ screen, title, subtitle, health, healthError, badges, children }: { screen: ScreenName; title?: string; subtitle?: string; health: HealthResponse | null; healthError: string | null; badges: NavBadges; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const learn = useLearn();
  const guided = useGuidedStart();
  const heading = SCREEN_TITLES[screen];
  const pageTopic = screenTopics(screen)[0];

  // "/" focuses the reference search (opens the Learn panel) unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      e.preventDefault();
      learn.open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [learn]);
  useEffect(() => { setDrawer(false); }, [screen]);

  const showPill = !guided.dismissed && guided.loaded && guided.done < guided.total;
  return (
    <div className="shell">
      <div className={`drawer-backdrop${drawer ? " open" : ""}`} onClick={() => setDrawer(false)} aria-hidden="true" />
      <aside className={`sidebar${drawer ? " open" : ""}`} aria-label="Primary">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <div className="brand-name">
            <a href="#/library" className="brand-link"><strong>Prediction Ledger</strong></a>
            <span className="meta">{health ? `v${health.version} · local` : healthError ? "server unreachable" : "connecting…"}</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((it) => {
                const b = it.badge?.(badges);
                const active = screen === it.name;
                return (
                  <a key={it.name} href={`#${it.to}`} className={active ? "nav-item active" : "nav-item"} aria-current={active ? "page" : undefined}>
                    <Icon name={it.icon} />
                    <span className="label">{it.label}</span>
                    {b && <span className={`badge${b.tone ? ` ${b.tone}` : ""}`} aria-label={b.label} title={b.label}>{b.n}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        {showPill && (
          <a className="pill-card" href="#/setup?section=guided" aria-label={`Guided start: ${guided.done} of ${guided.total} steps done`}>
            <div className="row"><span>Guided start</span><span className="meta num">{guided.done} / {guided.total}</span></div>
            <div className="progress-line"><i style={{ width: `${Math.round((guided.done / guided.total) * 100)}%` }} /></div>
            <div className="meta">{guided.next ? `Next: ${guided.next.title}` : "All steps complete"}</div>
          </a>
        )}
      </aside>

      <div className="main">
        <header className="header">
          <button type="button" className="icon-btn menu-btn" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}><Icon name="list" /></button>
          <div className="title">
            <h1>{title ?? heading.title}</h1>
            <span className="subtitle">{subtitle ?? heading.subtitle}</span>
          </div>
          <button type="button" className="search-ref" onClick={() => learn.open()} aria-label="Search the reference (press slash)">
            <Icon name="magnifyingGlass" /><span className="search-label">Search reference</span><span className="kbd">/</span>
          </button>
          {pageTopic && <button type="button" className="icon-btn" aria-label={`Help for this page: ${pageTopic.title}`} title={pageTopic.title} onClick={() => learn.open(pageTopic.id)}><Icon name="question" /></button>}
        </header>

        {healthError && (
          <div className="banner error" role="alert" style={{ margin: "12px 20px 0" }}>
            Cannot reach the local server: {healthError}. Make sure <code>npm start</code> is running. <a href="#/learn?topic=troubleshoot.server">What to check</a>
          </div>
        )}

        <main className="content">{children}</main>

        <footer className="footer">
          <span><span className="dot" aria-hidden="true" />{window.location.host || "127.0.0.1:7317"} · loopback only</span>
          {health && <span className="data-dir">Data: <code>{health.dataDir}</code></span>}
          <span className="spacer" />
          <span className="licence">Original concept: Michael D. Carter (BitsBeTrippin) · Built with Claude AI assistance · Apache-2.0</span>
        </footer>
      </div>
    </div>
  );
}
