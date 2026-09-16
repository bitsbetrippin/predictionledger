/**
 * Prediction Ledger — Markets page (1.6): watched and linked prediction markets with their latest
 * snapshot, a venue search to add more, and a manual refresh. Read-only; nothing here trades.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { MarketProviderId, MarketRecord } from "@prediction-ledger/shared";
import { fmtMoney, fmtPct, marketsApi, pollJob, type MarketStoredDetail, type MarketSummaryView } from "../api";

export function MarketsPage() {
  const [rows, setRows] = useState<MarketRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<MarketSummaryView[] | null>(null);
  const [selected, setSelected] = useState<MarketStoredDetail | null>(null);
  const [venue, setVenue] = useState<MarketProviderId>("polymarket");

  const load = async () => {
    try { setRows(await marketsApi.stored()); } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await load(); if (selected) setSelected(await marketsApi.storedDetail(selected.id).catch(() => null)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const search = () => run("Searching…", async () => { setResults(await marketsApi.search(q.trim(), 12, venue)); });
  const refreshAll = () => run("Refreshing…", async () => { const { jobId } = await marketsApi.snapshot(); const j = await pollJob(jobId, (x) => setBusy(x.stage ?? "Refreshing…")); if (j.status === "failed") throw new Error(j.error ?? "Refresh failed."); });

  const yes = (m: MarketRecord) => m.latest?.prices[0];

  return (
    <section className="page wide">
      <h1>Markets</h1>
      <p className="muted">Prediction-market questions kept in the ledger — watched by you or linked from a prediction — with the latest price, liquidity and volume snapshot. Data comes from the venue's public API; the app never places trades.</p>
      {error && <div className="banner error" role="alert">{error} <button type="button" className="link" onClick={() => setError(null)}>dismiss</button></div>}

      <div className="row controls">
        <input value={q} placeholder="Search Polymarket (e.g. Bitcoin 100k, Fed rate cut, Lions Bills)" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && q.trim().length >= 2) void search(); }} style={{ minWidth: 340 }} />
        <select value={venue} onChange={(e) => setVenue(e.target.value as MarketProviderId)} aria-label="Venue"><option value="polymarket">Polymarket</option><option value="manifold">Manifold</option></select>
        <button type="button" disabled={!!busy || q.trim().length < 2} onClick={search}>Search</button>
        <button type="button" disabled={!!busy || !rows?.length} onClick={refreshAll}>{busy?.startsWith("Refresh") ? busy : "Refresh all prices"}</button>
      </div>

      {results && (
        <div className="card">
          <div className="row space-between"><strong>Search results</strong><button type="button" className="link" onClick={() => setResults(null)}>close</button></div>
          {results.length === 0 ? <p className="muted">No active markets matched.</p> : (
            <ul className="plain">
              {results.map((m) => (
                <li key={m.id} className="market-result">
                  <a href={m.url} target="_blank" rel="noreferrer noopener"><strong>{m.question}</strong></a>{m.event && m.event.title !== m.question && <span className="muted small"> · {m.event.title}</span>}
                  <div className="small muted">{m.outcomes.map((o) => `${o.label} ${fmtPct(o.price)}`).join(" · ")} · liquidity {fmtMoney(m.liquidity)} · ends {m.endDate?.slice(0, 10) ?? "?"}{m.restricted ? " · restricted" : ""}</div>
                  <button type="button" className="link small" disabled={!!busy} onClick={() => run("Watching…", () => marketsApi.watch(m.id, m.provider))}>watch</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? (
        <div className="empty-state"><p>No markets in the ledger yet.</p><p className="muted">Search above and click <em>watch</em>, or open a prediction → Markets → Find markets.</p></div>
      ) : (
        <div className="split">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Market</th><th>{"Yes / first side"}</th><th>Liquidity</th><th>24h volume</th><th>Ends</th><th>As of</th><th></th></tr></thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className={selected?.id === m.id ? "selected" : undefined} onClick={() => void marketsApi.storedDetail(m.id).then(setSelected).catch((e: Error) => setError(e.message))}>
                    <td><strong>{m.question}</strong>{m.event && m.event.title !== m.question && <div className="muted small">{m.event.title}</div>}<div className="muted small">{m.provider} · {m.watched ? "watched" : "linked"}{m.closed ? " · closed" : ""}{m.restricted ? " · restricted" : ""}</div></td>
                    <td>{yes(m) ? `${yes(m)!.label} ${fmtPct(yes(m)!.price)}` : "—"}</td>
                    <td>{fmtMoney(m.latest?.liquidity)}</td>
                    <td>{fmtMoney(m.latest?.volume24h)}</td>
                    <td>{m.endDate?.slice(0, 10) ?? "—"}</td>
                    <td className="muted small">{m.latest?.retrievedAt.slice(0, 16).replace("T", " ") ?? "—"}</td>
                    <td><a href={m.url} target="_blank" rel="noreferrer noopener" className="small">venue</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <aside className="detail">
              <div className="detail-inner">
                <div className="row space-between"><strong>{selected.question}</strong><button type="button" className="link" onClick={() => setSelected(null)}>close</button></div>
                {selected.description && <details><summary className="small">Resolution rules</summary><p className="small">{selected.description}</p></details>}
                <h3>Latest</h3>
                {selected.latest ? <p className="small">{selected.latest.prices.map((o) => `${o.label} ${fmtPct(o.price)}${o.bestBid !== undefined ? ` (bid ${fmtPct(o.bestBid)} / ask ${fmtPct(o.bestAsk)})` : ""}`).join(" · ")}<br />liquidity {fmtMoney(selected.latest.liquidity)} · volume {fmtMoney(selected.latest.volume)} · 24h {fmtMoney(selected.latest.volume24h)}</p> : <p className="muted small">No snapshot yet.</p>}
                <h3>Price history ({selected.snapshots.length} snapshots)</h3>
                <ul className="plain small">{selected.snapshots.slice(0, 30).map((s) => <li key={s.id}>{s.retrievedAt.slice(0, 16).replace("T", " ")} — {s.prices.map((o) => `${o.label} ${fmtPct(o.price)}`).join(" · ")}</li>)}</ul>
                <h3>Linked predictions ({selected.links.length})</h3>
                {selected.links.length === 0 ? <p className="muted small">None.</p> : <ul className="plain small">{selected.links.map((l) => <li key={l.id}><a href={`#/predictions?id=${l.predictionId}`}>{l.predictionId.slice(0, 8)}…</a> — side {l.side ?? "?"} · {l.status} · match {Math.round(l.score * 100)}%</li>)}</ul>}
                <div className="row controls">
                  <button type="button" disabled={!!busy} onClick={() => run("Refreshing…", async () => { const { jobId } = await marketsApi.snapshot([selected.id]); await pollJob(jobId); })}>Refresh</button>
                  {selected.watched ? <button type="button" disabled={!!busy} onClick={() => run("Unwatching…", () => marketsApi.unwatch(selected.id))}>Stop watching</button> : <button type="button" disabled={!!busy} onClick={() => run("Watching…", () => marketsApi.watch(selected.venueId, selected.provider))}>Watch</button>}
                  <button type="button" disabled={!!busy} onClick={() => run("Removing…", async () => { await marketsApi.remove(selected.id); setSelected(null); })}>Remove from ledger</button>
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
    </section>
  );
}
