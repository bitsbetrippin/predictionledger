/**
 * Prediction Ledger — Signals page (1.7): creator record vs market, per market side.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every number is derived on read from rows you can open: the linked predictions, their verdicts,
 * the market snapshots. The label is a gate (record size, edge size, liquidity, deadlines), not a score.
 */
import { useEffect, useState } from "react";
import type { MarketSignal } from "@prediction-ledger/shared";
import { fmtEdge, fmtMoney, fmtPct, signalsApi, type SignalsResponse } from "../api";

const CONF_LABEL: Record<MarketSignal["confidence"], string> = { strong: "Strong", moderate: "Moderate", lean: "Lean", none: "No signal" };

export function SignalsPage() {
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeSettled, setIncludeSettled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    signalsApi.get(includeSettled).then(setData).catch((e: Error) => setError(e.message));
  }, [includeSettled]);

  return (
    <section className="page wide">
      <h1>Signals</h1>
      <p className="muted">
        Where the people in your ledger disagree with the market. For each market side with an accepted link from an open prediction: the market's current price, the contributors' <em>realized edge</em> (what following them would have earned per $1 at the market's price on their settled, linked calls, shrunk toward zero when the record is thin), the resulting estimate, and a label that only appears when the record, the liquidity and the deadlines all clear the gates in Setup → Prediction markets. Nothing here is advice and nothing trades.
      </p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <div className="row controls">
        <label className="row"><input type="checkbox" checked={includeSettled} onChange={(e) => setIncludeSettled(e.target.checked)} /> <span>include settled predictions</span></label>
        {data && <span className="muted small">gates: lean ≥ {data.gates.minSettledLean} settled · moderate ≥ {data.gates.minSettledModerate} · strong ≥ {data.gates.minSettledStrong} · liquidity ≥ {fmtMoney(data.gates.minLiquidity)} · prior weight {data.gates.priorWeight}</span>}
      </div>

      {data === null ? <p className="muted">Loading…</p> : (
        <>
          <h2>Market sides</h2>
          {data.signals.length === 0 ? (
            <div className="empty-state"><p>No signals yet.</p><p className="muted">Accept a market link on a prediction (Predictions → detail → Markets) and settle a few predictions from the same channel so it has a record.</p></div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Market · side</th><th>Market</th><th>Estimate</th><th>Edge</th><th>Label</th><th>Contributors</th><th>Liquidity</th><th>Deadlines</th></tr></thead>
                <tbody>
                  {data.signals.map((s) => {
                    const key = `${s.marketId}|${s.side}`;
                    return [
                      <tr key={key} className={open === key ? "selected" : undefined} onClick={() => setOpen(open === key ? null : key)}>
                        <td><a href={s.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}><strong>{s.question}</strong></a>{s.eventTitle && s.eventTitle !== s.question && <div className="muted small">{s.eventTitle}</div>}<div className="small">side <strong>{s.side}</strong>{s.endDate ? ` · ends ${s.endDate.slice(0, 10)}` : ""}</div></td>
                        <td>{fmtPct(s.marketPrice)}<div className="muted small">{s.asOf ? `as of ${s.asOf.slice(0, 16).replace("T", " ")}` : "no snapshot"}</div></td>
                        <td>{fmtPct(s.estimate)}</td>
                        <td className={s.edge !== undefined ? (s.edge >= 0 ? "pos" : "neg") : undefined}>{fmtEdge(s.edge)}</td>
                        <td><span className={`chip conf-${s.confidence}`}>{CONF_LABEL[s.confidence]}</span></td>
                        <td>{s.contributions.length} claim(s) · {s.creators} source(s)</td>
                        <td>{fmtMoney(s.liquidity)}<div className="muted small">24h {fmtMoney(s.volume24h)}</div></td>
                        <td>{s.deadlineCheck}</td>
                      </tr>,
                      open === key && (
                        <tr key={`${key}-detail`} className="detail-row">
                          <td colSpan={8}>
                            <div className="small"><strong>Why:</strong> {s.reasons.join(" · ")}</div>
                            <ul className="plain small">
                              {s.contributions.map((c) => (
                                <li key={c.linkId}>
                                  <a href={`#/predictions?id=${c.predictionId}`}>“{c.quote.slice(0, 120)}{c.quote.length > 120 ? "…" : ""}”</a> — {c.creatorLabel}{c.madeOnDate ? `, ${c.madeOnDate}` : ""}
                                  {c.priceAtMade !== undefined && <> · market was {fmtPct(c.priceAtMade)} then</>}
                                  {" "}· record {c.settled} settled linked{c.realizedEdge !== undefined ? `, realized ${fmtEdge(c.realizedEdge)} → shrunk ${fmtEdge(c.shrunkEdge)}` : ", no market record yet"}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h2>Creator records</h2>
          {data.creators.length === 0 ? <p className="muted">No predictions yet.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Creator</th><th>Predictions</th><th>Settled</th><th>Hit rate</th><th>Linked settled</th><th>Realized edge</th><th>Shrunk</th><th>Market Brier</th><th>Open</th></tr></thead>
                <tbody>
                  {data.creators.map((c) => (
                    <tr key={c.key}>
                      <td><strong>{c.label}</strong></td>
                      <td>{c.predictions}</td>
                      <td>{c.settled} <span className="muted small">({c.hits}✓ {c.misses}✗{c.partial ? ` ${c.partial}½` : ""})</span></td>
                      <td>{c.hitRate !== undefined ? fmtPct(c.hitRate) : "—"}</td>
                      <td>{c.linkedSettled}</td>
                      <td className={c.realizedEdge !== undefined ? (c.realizedEdge >= 0 ? "pos" : "neg") : undefined}>{fmtEdge(c.realizedEdge)}</td>
                      <td>{fmtEdge(c.shrunkEdge)}</td>
                      <td>{c.marketBrier !== undefined ? c.marketBrier.toFixed(3) : "—"}</td>
                      <td>{c.open}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Hit rate counts every settled prediction. Realized edge and Brier use only settled predictions with an accepted market link and a price from when the claim was made — a creator who only calls heavy favourites has a high hit rate and no edge. Creator = the video's channel when known, otherwise the video.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
