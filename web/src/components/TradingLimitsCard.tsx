/**
 * Prediction Ledger — Setup card for the pilot risk limits and the US paper bankroll (1.12, RSK-02/03/07).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { RiskLimits } from "@prediction-ledger/shared";
import { decisionsApi, fmtUsd, paperUsApi, type LimitsResponse } from "../api";

const MONEY: (keyof RiskLimits)[] = ["orderBudget", "perMarket", "perEvent", "dailyCommitmentCap", "totalOpenRisk", "dailyLossStop"];
const LABEL: Record<keyof RiskLimits, string> = {
  currency: "Currency", orderBudget: "Order budget (all-in, incl. fees)", dailyCommitmentCap: "Daily new-commitment cap", totalOpenRisk: "Total open / pending risk", perMarket: "Per market", perEvent: "Per event", maxOpenMarkets: "Max open / pending markets",
  dailyLossStop: "Daily realized-loss stop", probabilityThreshold: "Probability threshold (exclusive)", minNetEdge: "Minimum net edge (inclusive)", bookMaxAgeMs: "Book max age (ms)", syncMaxAgeMs: "Account sync max age (ms)", forecastMaxAgeMs: "Forecast max age (ms)", preEventBufferMs: "Pre-event buffer (ms)",
};

export function TradingLimitsCard() {
  const [data, setData] = useState<LimitsResponse | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [tz, setTz] = useState("UTC");
  const [bankroll, setBankroll] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [l, b] = await Promise.all([decisionsApi.limits(), paperUsApi.get()]);
      setData(l); setTz(l.budgetTimezone); setBankroll(b.bankrollStart);
      setForm(Object.fromEntries(Object.entries(l.limits).map(([k, v]) => [k, String(v)])));
    } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const patch: Record<string, unknown> = { budgetTimezone: tz };
      for (const k of Object.keys(form)) {
        if (k === "currency") continue;
        const v = form[k];
        patch[k] = k.endsWith("Ms") || k === "maxOpenMarkets" ? Number(v) : v;
      }
      const r = await decisionsApi.setLimits(patch as Partial<RiskLimits> & { budgetTimezone?: string });
      await paperUsApi.setBankroll(bankroll);
      setData(r);
      setMsg({ kind: "ok", text: `Saved. Policy hash ${r.policyHash.slice(0, 12)}… · any change disarms live modes (none exist yet) and never resets consumed daily allowances.` });
    } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (!data) return <div className="card"><strong>Trading limits (paper)</strong><p className="muted">Loading…</p></div>;
  return (
    <div className="card">
      <strong>Trading limits and US paper bankroll (1.12)</strong>
      <p className="muted">Proposed pilot limits — configurable, not endorsed bankroll sizing. They apply to paper decisions now and to any live mode later; the policy version is <code>{data.policyVersion}</code>, hash <code>{data.policyHash.slice(0, 12)}…</code>. Amounts in USD.</p>
      <div className="grid-3">
        {MONEY.map((k) => <label key={k} className="field"><span>{LABEL[k]}</span><input value={form[k] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></label>)}
        <label className="field"><span>{LABEL.maxOpenMarkets}</span><input type="number" min={1} value={form.maxOpenMarkets ?? ""} onChange={(e) => setForm((f) => ({ ...f, maxOpenMarkets: e.target.value }))} /></label>
        <label className="field"><span>{LABEL.probabilityThreshold}</span><input value={form.probabilityThreshold ?? ""} onChange={(e) => setForm((f) => ({ ...f, probabilityThreshold: e.target.value }))} /></label>
        <label className="field"><span>{LABEL.minNetEdge}</span><input value={form.minNetEdge ?? ""} onChange={(e) => setForm((f) => ({ ...f, minNetEdge: e.target.value }))} /></label>
        <label className="field"><span>{LABEL.bookMaxAgeMs}</span><input type="number" value={form.bookMaxAgeMs ?? ""} onChange={(e) => setForm((f) => ({ ...f, bookMaxAgeMs: e.target.value }))} /></label>
        <label className="field"><span>{LABEL.syncMaxAgeMs}</span><input type="number" value={form.syncMaxAgeMs ?? ""} onChange={(e) => setForm((f) => ({ ...f, syncMaxAgeMs: e.target.value }))} /></label>
        <label className="field"><span>{LABEL.forecastMaxAgeMs}</span><input type="number" value={form.forecastMaxAgeMs ?? ""} onChange={(e) => setForm((f) => ({ ...f, forecastMaxAgeMs: e.target.value }))} /></label>
        <label className="field"><span>{LABEL.preEventBufferMs}</span><input type="number" value={form.preEventBufferMs ?? ""} onChange={(e) => setForm((f) => ({ ...f, preEventBufferMs: e.target.value }))} /></label>
        <label className="field"><span>Budget timezone (daily buckets)</span><input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="UTC" /><small>Changing it never moves already consumed allowances.</small></label>
        <label className="field"><span>US paper bankroll start (USD)</span><input value={bankroll} onChange={(e) => setBankroll(e.target.value)} /><small>A separate bankroll for the execution-aware paper engine; current: {fmtUsd(bankroll)}.</small></label>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="row"><button type="button" className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save limits"}</button></div>
    </div>
  );
}
