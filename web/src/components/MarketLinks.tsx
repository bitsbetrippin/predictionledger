/**
 * Prediction Ledger — "Markets" tab of the prediction detail (1.6): proposed and accepted links to
 * prediction-market questions, the implied side and its current price, and accept / reject / link-by-hand.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { PredictionMarketLink } from "@prediction-ledger/shared";
import { fmtMoney, fmtPct, marketsApi, pollJob } from "../api";

const RELATION_LABEL: Record<string, string> = { exact: "exact matchup", same: "same claim", narrower: "claim is narrower", broader: "market is broader", different: "different" };

export function MarketLinks(props: { predictionId: string; kind: "general" | "sports_pick" }) {
  const [links, setLinks] = useState<PredictionMarketLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [manualSide, setManualSide] = useState("");
  const [manualVenue, setManualVenue] = useState<"polymarket" | "manifold" | "polymarket_us">("polymarket");

  const load = async () => {
    try { setLinks(await marketsApi.links(props.predictionId)); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [props.predictionId]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const findMarkets = () => run("Finding markets…", async () => {
    const { jobId } = await marketsApi.match(props.predictionId);
    const j = await pollJob(jobId, (x) => setBusy(x.stage ?? "Finding markets…"));
    if (j.status === "failed") throw new Error(j.error ?? "Market search failed.");
  });
  const refresh = () => run("Refreshing prices…", async () => {
    const ids = (links ?? []).filter((l) => l.status !== "rejected").map((l) => l.marketId);
    if (ids.length === 0) return;
    const { jobId } = await marketsApi.snapshot(ids);
    await pollJob(jobId);
  });

  const accepted = (links ?? []).filter((l) => l.status === "accepted");
  const proposed = (links ?? []).filter((l) => l.status === "proposed");
  const rejected = (links ?? []).filter((l) => l.status === "rejected");

  const sidePrice = (l: PredictionMarketLink) => l.market?.latest?.prices.find((x) => x.label === l.side)?.price;

  const row = (l: PredictionMarketLink) => {
    const m = l.market;
    const price = sidePrice(l);
    return (
      <li key={l.id} className={`market-link ${l.status}`}>
        <div>
          <a href={m?.url} target="_blank" rel="noreferrer noopener"><strong>{m?.question ?? "(market removed)"}</strong></a>{m && <span className="muted small"> · {m.provider}</span>}
          {m?.event && m.event.title !== m.question && <span className="muted small"> · {m.event.title}</span>}
          {m?.restricted && <span className="chip small" title="The venue restricts trading in some regions; prices are still public">restricted</span>}
        </div>
        <div className="small">
          {l.side ? <>Implied side <strong>{l.side}</strong> at <strong>{fmtPct(price)}</strong></> : <span className="muted">no side implied</span>}
          {l.priceAtMade !== undefined && l.side && <span className="muted"> · was {fmtPct(l.priceAtMade)} when the claim was made{l.priceAtMadeSource === "history" ? ` (venue history, ${l.priceAtMadeAt?.slice(0, 10) ?? ""})` : " (snapshot at link time)"}</span>}
          {l.status === "accepted" && l.priceAtMadeSource !== "history" && <button type="button" className="link" disabled={!!busy} onClick={() => run("Reading history…", async () => { const { jobId } = await marketsApi.backfill(l.id); await pollJob(jobId); })}>read venue history</button>}
          {m?.latest && <span className="muted"> · liquidity {fmtMoney(m.latest.liquidity)} · 24h volume {fmtMoney(m.latest.volume24h)} · as of {m.latest.retrievedAt.slice(0, 16).replace("T", " ")}</span>}
          {m?.endDate && <span className="muted"> · market ends {m.endDate.slice(0, 10)}</span>}
        </div>
        <div className="muted small">
          match {Math.round(l.score * 100)}%{l.relation ? ` · ${RELATION_LABEL[l.relation] ?? l.relation}` : ""} · {l.matchedBy}{l.rationale ? ` — ${l.rationale}` : ""}
        </div>
        <div className="row small">
          {l.status !== "accepted" && <button type="button" className="link" disabled={!!busy} onClick={() => run("Accepting…", () => marketsApi.accept(l.id))}>accept</button>}
          {l.status !== "rejected" && <button type="button" className="link" disabled={!!busy} onClick={() => run("Rejecting…", () => marketsApi.reject(l.id))}>reject</button>}
          <button type="button" className="link" disabled={!!busy} onClick={() => run("Removing…", () => marketsApi.unlink(l.id))}>remove</button>
        </div>
      </li>
    );
  };

  return (
    <div className="market-links">
      <p className="muted small">
        Read-only view of what a prediction market says about this claim. A link means “this claim is a bet on that market's side”; the app proposes links and you decide.
        {props.kind === "sports_pick" ? " Exact game matchups (both teams, the game date, the same pick type) are accepted automatically." : " Nothing is linked without your acceptance."}
      </p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}
      <div className="row controls">
        <button type="button" className="primary" disabled={!!busy} onClick={findMarkets}>{busy && busy !== "Refreshing prices…" ? busy : links?.length ? "Find markets again" : "Find markets"}</button>
        {accepted.length + proposed.length > 0 && <button type="button" disabled={!!busy} onClick={refresh}>Refresh prices</button>}
      </div>
      {links === null ? <p className="muted">Loading…</p> : links.length === 0 ? <p className="muted">No market links yet.</p> : (
        <>
          {accepted.length > 0 && <><h4>Linked</h4><ul className="plain">{accepted.map(row)}</ul></>}
          {proposed.length > 0 && <><h4>Proposed</h4><ul className="plain">{proposed.map(row)}</ul></>}
          {rejected.length > 0 && <details><summary className="muted small">{rejected.length} rejected</summary><ul className="plain">{rejected.map(row)}</ul></details>}
        </>
      )}
      <details>
        <summary className="small">Link a market by hand</summary>
        <div className="row small">
          <select value={manualVenue} onChange={(e) => setManualVenue(e.target.value as "polymarket" | "manifold" | "polymarket_us")} aria-label="Venue"><option value="polymarket">Polymarket</option><option value="manifold">Manifold</option><option value="polymarket_us">Polymarket US</option></select>
          <input value={manual} placeholder="slug, id, or market URL" onChange={(e) => setManual(e.target.value)} style={{ minWidth: 280 }} />
          <input value={manualSide} placeholder="side (Yes / team)" onChange={(e) => setManualSide(e.target.value)} style={{ width: 130 }} />
          <button type="button" disabled={!!busy || !manual.trim()} onClick={() => run("Linking…", async () => { await marketsApi.linkManual(props.predictionId, manual.trim(), manualSide.trim() || undefined, manualVenue); setManual(""); setManualSide(""); })}>Link</button>
        </div>
      </details>
    </div>
  );
}
