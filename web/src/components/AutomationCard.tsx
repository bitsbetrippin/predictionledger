/**
 * Prediction Ledger — Setup card for automatic execution (1.14, AUTO-01/02): scheduler budgets, the arming dialog
 * (acknowledgement + the policy hash under review + a qualified category), pause and disarm.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import { AUTO_LIVE_ACKNOWLEDGEMENT, type AutomationSettings, type TradingStatus } from "@prediction-ledger/shared";
import { ApiError, automationApi, tradingApi, type AutomationInfo } from "../api";

const LABEL: Record<keyof AutomationSettings, string> = {
  intervalMs: "Tick interval (ms)", maxEvaluationsPerTick: "Evaluations per tick", maxOrdersPerTick: "Orders per tick", maxPerSourcePerTick: "Evaluations per creator per tick", maxMatchJobsPerTick: "Market-match jobs per tick",
  maxVerificationsPerTick: "Contract verifications per tick", minReevaluateMs: "Re-evaluation window (ms)", revalidateAfterMs: "Revalidate verified contracts after (ms)", breakerThreshold: "Circuit breaker: consecutive failures", breakerCooldownMs: "Circuit breaker: cooldown (ms)", paperAutopilot: "Paper autopilot (paper mode only)",
};

export function AutomationCard() {
  const [info, setInfo] = useState<AutomationInfo | null>(null);
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [paperAutopilot, setPaperAutopilot] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState<{ ack: string; category: string } | null>(null);

  const load = async () => {
    try {
      const [i, st] = await Promise.all([automationApi.info(), tradingApi.status()]);
      setInfo(i); setStatus(st);
      setForm(Object.fromEntries(Object.entries(i.settings).filter(([k]) => k !== "paperAutopilot").map(([k, v]) => [k, String(v)])));
      setPaperAutopilot(i.settings.paperAutopilot);
    } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
  };
  useEffect(() => { void load(); }, []);

  const apiMessage = (e: unknown) => { const b = (e as ApiError).body as { message?: string; gates?: { label: string; detail: string }[] } | undefined; return b?.gates?.length ? `${b.message ?? ""} ${b.gates.map((g) => `${g.label}: ${g.detail}`).join(" · ")}` : b?.message ?? (e as Error).message; };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); await load(); if (ok) setMsg({ kind: "ok", text: ok }); } catch (e) { setMsg({ kind: "error", text: apiMessage(e) }); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const patch: Partial<AutomationSettings> = { paperAutopilot };
    for (const [k, v] of Object.entries(form)) { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${LABEL[k as keyof AutomationSettings]} must be a number`); (patch as Record<string, unknown>)[k] = Math.round(n); }
    await automationApi.setSettings(patch);
  }, "Saved. A changed policy hash disarms any live mode; review the new hash before arming again.");

  const policy = status?.policy;
  const armedAuto = policy?.mode === "auto_live" && !!policy.liveAuthorizedAt;
  return (
    <fieldset className="card">
      <legend>Automatic execution (1.14)</legend>
      <p className="muted small">
        The scheduler polls saved channels, matches new picks on Polymarket US, verifies contracts and — <strong>only while armed here</strong> — places bounded automatic orders through the same preview → send path as a manual order (automatic indicator, one entry per contract, never a top-up).
        Arming needs a validated, fresh, reconciled account, a <strong>production-qualified</strong> strategy for the category (fixtures never count), the paper rehearsal, no holds, and your acknowledgement together with the <strong>policy hash you reviewed</strong>. Any restart, limit or budget change, credential change, discrepancy, unknown submission or circuit-breaker event returns to disarmed.
      </p>
      {msg && <p className={`small ${msg.kind === "ok" ? "ok" : "error"}`}>{msg.text}</p>}
      {info && policy && (
        <div className="grid-3">
          <div className="field"><span>State</span><strong>{armedAuto ? "ARMED — automatic" : policy.mode === "manual_live" ? "Manual live (not automatic)" : policy.mode}</strong><small className="muted">{info.live.ok ? "the scheduler will place orders on its next tick" : `not dispatching: ${info.live.reasons.join("; ")}`}</small></div>
          <div className="field"><span>Policy hash (review before arming)</span><code className="small">{policy.policyHash}</code><small className="muted">{policy.authorizedPolicyHash ? `authorized ${policy.authorizedPolicyHash.slice(0, 12)}… for ${policy.authorizedCategory} / ${policy.authorizedStrategyVersion}` : "no automation authorization"}</small></div>
          <div className="field"><span>Qualified categories ({info.strategyVersion})</span><strong>{info.categories.length ? info.categories.join(", ") : "none"}</strong><small className="muted">a category qualifies only from ≥ 100 settled events with a market baseline (production evaluation)</small></div>
        </div>
      )}
      {info && policy && (
        <div className="row">
          {!armedAuto && <button type="button" className="danger" disabled={busy || !info.categories.length} onClick={() => setArming({ ack: "", category: info.categories[0] ?? "" })}>Arm automatic trading…</button>}
          {armedAuto && <button type="button" className="danger" disabled={busy} onClick={() => run(() => tradingApi.disarm("owner disarm (automation card)"), "Disarmed.")}>Disarm now</button>}
          {policy.pauseReason ? <button type="button" disabled={busy} onClick={() => run(() => automationApi.resume(), "Resumed.")}>Resume new orders</button> : <button type="button" disabled={busy} onClick={() => run(() => automationApi.pause("owner pause (Setup)"), "Paused: no new orders until you resume.")}>Pause new orders</button>}
          <button type="button" disabled={busy} onClick={() => run(() => automationApi.tick(), "One scheduler tick ran; see Trades → Automation runs.")}>Run one tick now</button>
        </div>
      )}
      {arming && info && policy && (
        <div className="banner warn" role="dialog" aria-label="Arm automatic trading">
          <p><strong>Automatic real-money orders.</strong> While armed, the scheduler places orders without asking, bounded by the limits and budgets hashed as <code>{policy.policyHash.slice(0, 16)}…</code>. Review the limits card and the budgets below first; arming records this exact hash and any later change disarms. Type exactly:</p>
          <p><code>{AUTO_LIVE_ACKNOWLEDGEMENT}</code></p>
          <div className="row">
            <label>Category <select value={arming.category} onChange={(e) => setArming({ ...arming, category: e.target.value })}>{info.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <input type="text" value={arming.ack} onChange={(e) => setArming({ ...arming, ack: e.target.value })} placeholder="Type the sentence above" style={{ minWidth: "30rem" }} />
            <button type="button" className="danger" disabled={busy || arming.ack !== AUTO_LIVE_ACKNOWLEDGEMENT || !arming.category} onClick={() => run(() => automationApi.arm({ acknowledge: arming.ack, policyHash: policy.policyHash, category: arming.category, strategyVersion: info.strategyVersion }).then(() => setArming(null)), "Armed for automatic trading under the reviewed policy hash.")}>Arm</button>
            <button type="button" onClick={() => setArming(null)}>Cancel</button>
          </div>
        </div>
      )}
      <h4>Scheduler budgets (part of the policy hash)</h4>
      <div className="grid-3">
        {Object.keys(form).map((k) => (
          <label key={k} className="field"><span>{LABEL[k as keyof AutomationSettings]}</span><input type="text" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
        ))}
        <label className="field"><span>{LABEL.paperAutopilot}</span><input type="checkbox" checked={paperAutopilot} onChange={(e) => setPaperAutopilot(e.target.checked)} /><small className="muted">evaluate and paper-fill on the scheduler in paper mode (the paper soak); never touches the live account</small></label>
      </div>
      <div className="row"><button type="button" disabled={busy} onClick={() => void save()}>Save budgets</button></div>
    </fieldset>
  );
}
