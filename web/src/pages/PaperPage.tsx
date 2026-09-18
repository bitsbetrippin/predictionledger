/**
 * Prediction Ledger — Paper trading page (1.9): hypothetical positions marked against snapshots.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Nothing here is an order. The book answers "had I followed the signals, what would the scoreboard
 * say" — and, on resolved positions, whether the creators' estimate was closer than the market's price.
 */
import { useEffect, useState } from "react";
import type { PaperPosition } from "@prediction-ledger/shared";
import { fmtEdge, fmtMoney, fmtPct, fmtPnl, paperApi, type PaperResponse } from "../api";
import { HelpButton } from "../components/HelpButton";
import { EmptyState, Skeleton } from "../components/ui";

function Curve({ points, start }: { points: { at: string; equity: number }[]; start: number }) {
  if (points.length < 2) return <p className="muted small">The equity curve appears once positions have been marked more than once.</p>;
  const w = 600, h = 120, pad = 6;
  const min = Math.min(start, ...points.map((p) => p.equity)), max = Math.max(start, ...points.map((p) => p.equity));
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v: number) => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - 2 * pad));
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Paper equity over time" style={{ maxWidth: 720 }}>
      <line x1={pad} x2={w - pad} y1={y(start)} y2={y(start)} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="4 4" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x={pad} y={y(start) - 3} fontSize="10" fill="currentColor" opacity="0.6">start {fmtMoney(start)}</text>
      <text x={w - pad} y={y(points[points.length - 1].equity) - 3} fontSize="10" textAnchor="end" fill="currentColor">{fmtMoney(points[points.length - 1].equity)}</text>
    </svg>
  );
}

export function PaperPage() {
  const [data, setData] = useState<PaperResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => paperApi.get().then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const row = (p: PaperPosition) => (
    <tr key={p.id}>
      <td>{p.market?.url ? <a href={p.market.url} target="_blank" rel="noreferrer noopener"><strong>{p.market.question}</strong></a> : <strong>{p.marketId}</strong>}<div className="muted small">{p.market?.provider} · side <strong>{p.side}</strong> · {p.source}{p.confidenceAtOpen ? ` (${p.confidenceAtOpen})` : ""}{p.notes ? ` · ${p.notes}` : ""}</div></td>
      <td>{p.openedAt.slice(0, 10)}<div className="muted small">@ {fmtPct(p.openedPrice)}{p.estimateAtOpen !== undefined ? ` · est. ${fmtPct(p.estimateAtOpen)} (${fmtEdge(p.edgeAtOpen)})` : ""}</div></td>
      <td>{fmtMoney(p.stake)}<div className="muted small">{p.shares.toFixed(1)} shares</div></td>
      <td>{p.status === "open" ? fmtPct(p.currentPrice) : `${p.closeReason === "resolved" ? "resolved" : "closed"} @ ${fmtPct(p.closedPrice)}`}<div className="muted small">{p.status === "open" ? (p.lastMarkedAt ? `marked ${p.lastMarkedAt.slice(0, 16).replace("T", " ")}` : "not marked yet") : p.closedAt?.slice(0, 10)}</div></td>
      <td className={(p.status === "open" ? p.unrealizedPnl ?? 0 : p.realizedPnl ?? 0) >= 0 ? "pos" : "neg"}>{fmtPnl(p.status === "open" ? p.unrealizedPnl : p.realizedPnl)}</td>
      <td className="row small">
        {p.status === "open" && <button type="button" className="link" disabled={!!busy} onClick={() => run("Closing…", () => paperApi.close(p.id))}>close at mark</button>}
        <button type="button" className="link" disabled={!!busy} onClick={() => run("Removing…", () => paperApi.remove(p.id))}>remove</button>
      </td>
    </tr>
  );

  return (
    <section className="page wide">
      <p className="muted">Hypothetical positions only — the app never places an order. A position is “I would have bought this side at this price for this stake”; it is marked at every snapshot and closes at 1 or 0 when the venue resolves the market. Open one from a Signals row, or let watch rules open them on labelled signals (Setup → Prediction markets → Paper trading). <HelpButton topic="signals.paper-book">How the book is scored</HelpButton></p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}
      {data === null ? <Skeleton rows={4} /> : (
        <>
          {!data.book.enabled && <div className="banner warn">Paper trading is turned off in Setup → Prediction markets.</div>}
          <div className="stats">
            <div className="stat"><span className="label">Equity</span><strong>{fmtMoney(data.book.equity)}</strong><span className="muted small">start {fmtMoney(data.book.bankrollStart)}</span></div>
            <div className="stat"><span className="label">Realized</span><strong className={data.book.realizedPnl >= 0 ? "pos" : "neg"}>{fmtPnl(data.book.realizedPnl)}</strong><span className="muted small">{data.book.wins}W / {data.book.losses}L{data.book.returnOnStake !== undefined ? ` · ${(data.book.returnOnStake * 100).toFixed(1)}% on stake` : ""}</span></div>
            <div className="stat"><span className="label">Unrealized</span><strong className={data.book.unrealizedPnl >= 0 ? "pos" : "neg"}>{fmtPnl(data.book.unrealizedPnl)}</strong><span className="muted small">{data.book.openCount} open</span></div>
            <div className="stat"><span className="label">Estimate vs market (Brier, lower is better) <HelpButton topic="signals.paper-book" /></span><strong>{data.book.brierEstimate !== undefined ? `${data.book.brierEstimate.toFixed(3)} vs ${data.book.brierMarket?.toFixed(3)}` : "—"}</strong><span className="muted small">over resolved positions with a signal at open</span></div>
          </div>
          <Curve points={data.book.curve} start={data.book.bankrollStart} />
          <div className="row controls">
            <button type="button" disabled={!!busy} onClick={() => run("Marking…", () => paperApi.mark())}>{busy ?? "Mark now"}</button>
            <button type="button" disabled={!!busy || data.positions.length === 0} onClick={() => { if (window.confirm("Delete every paper position and start the book over?")) void run("Resetting…", () => paperApi.reset()); }}>Reset book</button>
            <span className="muted small">sizing: {data.sizing.sizing === "fixed" ? `fixed ${fmtMoney(data.sizing.fixedStake)}` : `Kelly × ${data.sizing.kellyFraction}`} · cap {(data.sizing.maxStakeFraction * 100).toFixed(0)}% of bankroll · auto-open: {data.sizing.autoOpen}</span>
          </div>
          {data.positions.length === 0 ? (
            <EmptyState title="No paper positions yet.">Open one from a Signals row (“Paper buy”), or turn on auto-open in Setup.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Market · side</th><th>Opened</th><th>Stake</th><th>Now</th><th>P&amp;L</th><th></th></tr></thead>
                <tbody>{data.positions.map(row)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
