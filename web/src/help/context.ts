/**
 * Prediction Ledger — which reference topics belong to which screen ("On this screen" in the Learn panel, and the
 * page-level "?" in the header).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { findTopic, type HelpTopic } from "./topics";

export type ScreenName = "library" | "video" | "predictions" | "markets" | "signals" | "paper" | "trades" | "jobs" | "setup" | "learn";

/** Route name → topic ids, most relevant first. Every id must exist in TOPICS (checked by help.test.ts). */
export const SCREEN_TOPICS: Record<ScreenName, string[]> = {
  library: ["guide.import", "guide.first-workflow", "troubleshoot.youtube", "troubleshoot.privacy-pending", "concept.deadline-basis"],
  video: ["guide.extract", "concept.deadline-basis", "concept.provenance", "guide.research"],
  predictions: ["concept.evidence-assessment", "concept.time-status", "concept.components", "concept.validation-plan", "concept.independence", "concept.deadline-basis", "concept.provenance", "guide.research", "guide.markets"],
  markets: ["guide.markets", "signals.realized-edge", "signals.paper-book"],
  signals: ["signals.gated-label", "signals.realized-edge", "signals.paper-book", "guide.markets"],
  paper: ["signals.paper-book", "signals.realized-edge", "trades.paper-book"],
  trades: ["trades.mode", "trades.holds-alerts-breaker", "trades.alerts", "trades.external-holdings", "trades.arm-unavailable", "trades.pause-disarm", "trades.intent-states", "trades.reason-codes", "trades.buying-power", "trades.committed-risk", "trades.realized-pnl", "trades.unrealized", "trades.paper-book"],
  jobs: ["troubleshoot.server", "troubleshoot.privacy-pending", "guide.research", "guide.import"],
  setup: ["guide.first-workflow", "troubleshoot.privacy-pending", "trades.arm-unavailable", "trades.pause-disarm", "troubleshoot.server"],
  learn: ["example.worked", "guide.first-workflow"],
};

/** The page-level "?" opens the first topic of the screen. */
export function screenTopics(screen: ScreenName): HelpTopic[] {
  return (SCREEN_TOPICS[screen] ?? []).map((id) => findTopic(id)).filter((t): t is HelpTopic => !!t);
}

export const SCREEN_TITLES: Record<ScreenName, { title: string; subtitle: string }> = {
  library: { title: "Video Library", subtitle: "Import → transcript → predictions" },
  video: { title: "Video", subtitle: "Metadata, timestamped transcript, predictions in this video" },
  predictions: { title: "Predictions", subtitle: "Two-part verdicts with evidence and history" },
  markets: { title: "Markets", subtitle: "Watched and linked prediction-market questions (read-only)" },
  signals: { title: "Signals", subtitle: "Creator record vs market — gated labels, consensus, watch alerts" },
  paper: { title: "Paper", subtitle: "Hypothetical positions marked against snapshots — never an order" },
  trades: { title: "Trades", subtitle: "Decisions, orders, positions, holds and reconciliation" },
  jobs: { title: "Jobs", subtitle: "Durable background queue — survives restarts" },
  setup: { title: "Setup", subtitle: "Providers, privacy, sports, markets, account, limits" },
  learn: { title: "Learn & Reference", subtitle: "Guides, terminology, operations, worked example — all local" },
};
