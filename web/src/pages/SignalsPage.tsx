/**
 * Prediction Ledger — Signals page (1.7): creator record vs market, per market side. 2.1: the sub-views (market sides,
 * consensus, watch alerts, creator records) are routes — #/signals?view=sides|consensus|alerts|creators — with "?" help
 * beside Realized edge and Label.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every number is derived on read from rows you can open: the linked predictions, their verdicts,
 * the market snapshots. The label is a gate (record size, edge size, liquidity, deadlines), not a score.
 */
import { useEffect, useState } from "react";
import type { Alert, MarketSignal, Proposition } from "@prediction-ledger/shared";
import { alertsApi, consensusApi, fmtEdge, fmtMoney, fmtPct, paperApi, pollJob, signalsApi, type SignalsResponse } from "../api";
import { navigate } from "../App";
import { HelpButton } from "../components/HelpButton";
import { EmptyState, Skeleton, Tabs } from "../components/ui";

type SignalsView = "sides" | "consensus" | "alerts" | "creators";
const VIEWS: SignalsView[] = ["sides", "consensus", "alerts", "creators"];

const ALERT_LABEL: Record<Alert["kind"], string> = { market_move: "Market moved", divergence: "Divergence", resolving_soon: "Resolving soon" };

const CONF_LABEL: Record<MarketSignal["confidence"], string> = { strong: "Strong", moderate: "Moderate", lean: "Lean", none: "No signal" };

export function SignalsPage({ view }: { view?: string }) {
  const current: SignalsView = VIEWS.includes(view as SignalsView) ? (view as SignalsView) : "sides";
  const setView = (v: SignalsView) => navigate(v === "sides" ? "/signals" : `/signals?view=${v}`);
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeSettled, setIncludeSettled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [props, setProps] = useState<Proposition[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadAlerts = () => alertsApi.list().then((r) => { setAlerts(r.alerts); const unseen = r.alerts.filter((a) => !a.seenAt).map((a) => a.id); if (unseen.length) void alertsApi.seen(unseen); }).catch((e: Error) => setError(e.message));
  useEffect(() => {
    setData(null);
    signalsApi.get(includeSettled).then(setData).catch((e: Error) => setError(e.message));
    consensusApi.get(includeSettled).then(setProps).catch((e: Error) => setError(e.message));
    void loadAlerts();
  }, [includeSettled]);
  const runWatch = async () => {
    setBusy("Checking rules…");
    try { const { jobId } = await alertsApi.runNow(); await pollJob(jobId); await loadAlerts(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <section className="page wide">
      <p className="muted">
        Where the people in your ledger disagree with the market. For each market side with an accepted link from an open prediction: the market's current price, the contributors' <em>realized edge</em> (what following them would have earned per $1 at the market's price on their settled, linked calls, shrunk toward zero when the record is thin), the resulting estimate, and a label that only appears when the record, the liquidity and the deadlines all clear the gates in Setup → Prediction markets. Nothing here is advice and nothing trades. <HelpButton topic="signals.gated-label">How labels are gated</HelpButton>
      </p>
      {error && <div className="banner error" role="alert">{error}</div>}
      <Tabs value={current} onChange={setView} ariaLabel="Signals views" items={[{ id: "sides", label: "Market sides" }, { id: "consensus", label: "Consensus across channels" }, { id: "alerts", label: <>Watch alerts{alerts && alerts.length > 0 ? <span className="badge" style={{ marginLeft: 6 }}>{alerts.length}</span> : null}</> }, { id: "creators", label: "Creator records" }]} />
      <div className="row controls">
        <label className="row"><input type="checkbox" checked={includeSettled} onChange={(e) => setIncludeSettled(e.target.checked)} /> <span>include settled predictions</span></label>
        {data && <span className="muted small">gates: lean ≥ {data.gates.minSettledLean} settled · moderate ≥ {data.gates.minSettledModerate} · strong ≥ {data.gates.minSettledStrong} · liquidity ≥ {fmtMoney(data.gates.minLiquidity)} · prior weight {data.gates.priorWeight}</span>}
      </div>

      {current === "alerts" && <>
      <h2>Watch alerts {alerts && alerts.length > 0 && <span className="chip">{alerts.length}</span>}</h2>
      <div className="row controls">
        <button type="button" disabled={!!busy} onClick={runWatch}>{busy ?? "Check rules now"}</button>
        {alerts && alerts.length > 0 && <button type="button" onClick={() => alertsApi.dismissAll().then(loadAlerts)}>Dismiss all</button>}
        <span className="muted small">Rules: price move, creators-vs-market divergence, market resolving soon — thresholds in Setup → Prediction markets → Watch rules. Local only; nothing is sent anywhere.</span>
      </div>
      {alerts === null ? <Skeleton rows={3} /> : alerts.length === 0 ? <EmptyState title="No open watch alerts.">Watch rules raise a local alert when a market moves, diverges from the creators, or resolves soon.</EmptyState> : (
        <ul className="plain alerts">
          {alerts.map((a) => (
            <li key={a.id} className={`alert ${a.kind}${a.seenAt ? "" : " unseen"}`}>
              <span className="chip small">{ALERT_LABEL[a.kind]}</span> {a.market?.url ? <a href={a.market.url} target="_blank" rel="noreferrer noopener">{a.message}</a> : a.message}
              <span className="muted small"> · {a.createdAt.slice(0, 16).replace("T", " ")}</span>
              <button type="button" className="link small" onClick={() => alertsApi.dismiss(a.id).then(loadAlerts)}>dismiss</button>
            </li>
          ))}
        </ul>
      )}
      </>}

      {data === null ? <Skeleton rows={5} /> : (
        <>
          {current === "sides" && <>
          <h2>Market sides</h2>
          {data.signals.length === 0 ? (
            <EmptyState title="No signals yet.">Accept a market link on a prediction (Predictions → detail → Markets) and settle a few predictions from the same channel so it has a record.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Market · side</th><th>Market</th><th>Estimate</th><th>Edge <HelpButton topic="signals.realized-edge" /></th><th>Label <HelpButton topic="signals.gated-label" /></th><th>Contributors</th><th>Liquidity</th><th>Deadlines</th></tr></thead>
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
                            <div className="row small">
                              <button type="button" disabled={!!busy || s.marketPrice === undefined} onClick={async () => { setBusy("Opening paper position…"); try { await paperApi.open({ marketId: s.marketId, side: s.side }); setError(null); window.location.hash = "#/paper"; } catch (e) { setError((e as Error).message); } finally { setBusy(null); } }} title="Record a hypothetical position at the current market price — no order is placed">Paper buy {s.side} @ {fmtPct(s.marketPrice)}</button>
                            </div>
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
          </>}

          {current === "consensus" && <>
          <h2>Consensus across channels</h2>
          <p className="muted small">The same claim across videos, grouped by the market it is linked to or — when unlinked — by how closely the statements overlap. Weight = creator's settled market-linked record (min 1) × recency (half-life 90 days). A split room is shown as a split, not averaged away.</p>
          {props === null ? <Skeleton rows={3} /> : props.length === 0 ? <EmptyState title="No proposition has more than one voice yet.">Import more videos (Library → Playlist or channel) and link or extract their claims.</EmptyState> : (
            <ul className="plain">
              {props.map((pr) => (
                <li key={pr.key} className={`proposition${pr.disagreement ? " split" : ""}`}>
                  <div>
                    {pr.marketUrl ? <a href={pr.marketUrl} target="_blank" rel="noreferrer noopener"><strong>{pr.label}</strong></a> : <strong>{pr.label}</strong>}
                    <span className="muted small"> · {pr.groupedBy === "market" ? "linked market" : "similar statements"} · {pr.videos} video(s), {pr.creators} source(s){pr.disagreement ? " · split" : ""}</span>
                    {pr.marketPrice && <span className="muted small"> · market: {Object.entries(pr.marketPrice).map(([k, v]) => `${k} ${fmtPct(v)}`).join(" / ")}</span>}
                  </div>
                  <div className="sides">
                    {pr.sides.map((sd) => (
                      <div key={sd.side} className="side">
                        <div className="small"><strong>{sd.side}</strong> — {fmtPct(sd.share)} of weight · {sd.creators} source(s)</div>
                        <ul className="plain small">
                          {sd.endorsements.map((e) => (
                            <li key={e.predictionId}><a href={`#/predictions?id=${e.predictionId}`}>“{e.quote.slice(0, 100)}{e.quote.length > 100 ? "…" : ""}”</a> — {e.creatorLabel}{e.madeOnDate ? `, ${e.madeOnDate}` : ""} · weight {e.weight}{e.settled ? ` (record ${e.settled})` : ""}{e.verdict ? ` · ${e.verdict}` : ""}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          </>}

          {current === "creators" && <>
          <h2>Creator records</h2>
          {data.creators.length === 0 ? <EmptyState title="No predictions yet.">Creator records appear once a channel's predictions settle.</EmptyState> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Creator</th><th className="num">Predictions</th><th className="num">Settled</th><th className="num">Hit rate</th><th className="num">Linked settled</th><th className="num">Realized edge <HelpButton topic="signals.realized-edge" /></th><th className="num">Shrunk</th><th className="num">Market Brier <HelpButton topic="signals.paper-book" /></th><th className="num">Open</th></tr></thead>
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
              <p className="muted small" style={{ padding: "6px 10px" }}>Hit rate counts every settled prediction. Realized edge and Brier use only settled predictions with an accepted market link and a price from when the claim was made — a creator who only calls heavy favourites has a high hit rate and no edge. Creator = the video's channel when known, otherwise the video.</p>
            </div>
          )}
          </>}
        </>
      )}
    </section>
  );
}
