/**
 * Prediction Ledger — job handler: market.watch (1.8)
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Runs after each snapshot refresh (and on demand). Three local rules, thresholds in Setup → Markets:
 *   market_move    a linked/watched market's first side moved ≥ movePts since the snapshot ~24 h earlier
 *   divergence     a labelled signal's estimate differs from the market by ≥ divergencePts
 *   resolving_soon a market with an open linked prediction ends within resolveDays
 * Each rule dedupes per subject and period, so a condition that persists raises once, not every run.
 */

import type { JobContext } from "../queue.js";
import type { AppContext } from "../../context.js";

const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;

export function makeMarketWatchHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const s = ctx.settings.getPersisted();
    if (!s.markets.watch.enabled) return { skipped: "watch rules are off in Setup → Markets" };
    const w = s.markets.watch;
    const today = new Date().toISOString().slice(0, 10);
    const raised: string[] = [];

    // ---- market_move ----
    job.progress(10, "Checking price moves");
    for (const m of ctx.markets.refreshable()) {
      const snaps = ctx.markets.snapshots(m.id, 200).filter((x) => x.source !== "history");
      if (snaps.length < 2) continue;
      const latest = snaps[0];
      const cutoff = Date.parse(latest.retrievedAt) - 20 * 3_600_000;
      const base = snaps.find((x) => Date.parse(x.retrievedAt) <= cutoff) ?? snaps[snaps.length - 1];
      const a = latest.prices[0]?.price, b = base.prices[0]?.price;
      if (a === undefined || b === undefined) continue;
      const move = a - b;
      if (Math.abs(move) >= w.movePts / 100) {
        const alert = ctx.alerts.raise({ kind: "market_move", marketId: m.id, side: latest.prices[0].label, message: `${m.question}: ${latest.prices[0].label} moved ${pts(move)} (${(b * 100).toFixed(0)}% → ${(a * 100).toFixed(0)}%) since ${base.retrievedAt.slice(0, 16).replace("T", " ")}.`, value: move, threshold: w.movePts / 100, dedupeKey: `market_move:${m.id}:${today}` });
        if (alert) raised.push(alert.message);
      }
    }

    // ---- divergence ----
    job.progress(50, "Checking signal divergence");
    for (const sig of ctx.signals.signals(s.markets.signals)) {
      if (sig.confidence === "none" || sig.edge === undefined || sig.marketPrice === undefined) continue;
      if (Math.abs(sig.edge) >= w.divergencePts / 100) {
        const alert = ctx.alerts.raise({ kind: "divergence", marketId: sig.marketId, side: sig.side, message: `${sig.question} — ${sig.side}: creators' estimate ${((sig.estimate ?? 0) * 100).toFixed(0)}% vs market ${(sig.marketPrice * 100).toFixed(0)}% (${pts(sig.edge)}, ${sig.confidence}).`, value: sig.edge, threshold: w.divergencePts / 100, dedupeKey: `divergence:${sig.marketId}|${sig.side}:${today}` });
        if (alert) raised.push(alert.message);
      }
    }

    // ---- resolving_soon ----
    job.progress(80, "Checking upcoming resolutions");
    const horizon = Date.now() + w.resolveDays * 86_400_000;
    const byMarket = new Map<string, { question: string; endDate: string; sides: string[] }>();
    for (const sig of ctx.signals.signals(s.markets.signals)) {
      if (!sig.endDate) continue;
      const end = Date.parse(sig.endDate);
      if (!Number.isFinite(end) || end > horizon || end < Date.now() - 86_400_000) continue;
      const g = byMarket.get(sig.marketId) ?? { question: sig.question, endDate: sig.endDate, sides: [] };
      g.sides.push(`${sig.contributions.length} on ${sig.side}${sig.marketPrice !== undefined ? ` at ${(sig.marketPrice * 100).toFixed(0)}%` : ""}`);
      byMarket.set(sig.marketId, g);
    }
    for (const [marketId, g] of byMarket) {
      const days = Math.max(0, Math.round((Date.parse(g.endDate) - Date.now()) / 86_400_000));
      const alert = ctx.alerts.raise({ kind: "resolving_soon", marketId, message: `${g.question} resolves in ${days} day(s) (${g.endDate.slice(0, 10)}); open claims: ${g.sides.join(", ")}.`, value: days, threshold: w.resolveDays, dedupeKey: `resolving_soon:${marketId}` });
      if (alert) raised.push(alert.message);
    }

    job.progress(100, `${raised.length} new alert(s)`);
    return { raised: raised.length, messages: raised.slice(0, 20), open: ctx.alerts.openCount() };
  };
}
