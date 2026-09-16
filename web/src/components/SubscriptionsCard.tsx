/**
 * Prediction Ledger — source subscriptions (1.11, SRC-01): bounded, polled channel/playlist follows.
 * Every poll lists newest-first, skips what the ledger already has, applies lookback / keyword / budget
 * limits, and queues ordinary YouTube imports. Nothing is downloaded until an import job runs.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";
import type { SourceSubscription, ToolsStatus } from "@prediction-ledger/shared";
import { ApiError, pollJob, subscriptionsApi } from "../api";

export function SubscriptionsCard({ tools, onImported }: { tools: ToolsStatus | null; onImported: () => void }) {
  const [subs, setSubs] = useState<SourceSubscription[] | null>(null);
  const [url, setUrl] = useState("");
  const [every, setEvery] = useState(24);
  const [lookback, setLookback] = useState(30);
  const [perRun, setPerRun] = useState(3);
  const [keywords, setKeywords] = useState("");
  const [autoExtract, setAutoExtract] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const offline = tools ? !tools.internet : false;
  const needsTool = tools ? !tools.ytdlp.ok : false;

  const load = async () => { try { setSubs(await subscriptionsApi.list()); } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); } };
  useEffect(() => { void load(); }, []);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setMsg(null);
    try { await fn(); await load(); } catch (e) { setMsg({ kind: "error", text: e instanceof ApiError ? e.message : (e as Error).message }); } finally { setBusy(null); }
  };
  const add = () => act("Saving…", async () => {
    await subscriptionsApi.create({ url: url.trim(), pollIntervalHours: every, lookbackDays: lookback, maxVideosPerRun: perRun, autoExtract, categoryAllowlist: keywords.split(",").map((k) => k.trim()).filter(Boolean) });
    setUrl(""); setKeywords("");
    setMsg({ kind: "ok", text: "Subscription saved. It is polled in the background; use “Run now” to poll immediately." });
  });
  const runNow = (s: SourceSubscription) => act("Polling…", async () => {
    const { jobId } = await subscriptionsApi.runNow(s.id);
    const done = await pollJob(jobId, (j) => setBusy(j.stage ?? "Polling…"));
    if (done.status === "failed") setMsg({ kind: "error", text: done.error ?? "Poll failed." });
    else {
      const r = (done.result ?? {}) as { listed?: number; queued?: number; alreadyKnown?: number; skippedLookback?: number; skippedAllowlist?: number; skippedBudget?: number };
      setMsg({ kind: "ok", text: `${r.listed ?? 0} listed · ${r.queued ?? 0} queued · ${r.alreadyKnown ?? 0} already in the ledger · ${r.skippedLookback ?? 0} outside lookback · ${r.skippedAllowlist ?? 0} without a keyword · ${r.skippedBudget ?? 0} over this run's budget.` });
    }
    onImported();
  });

  const summary = (s: SourceSubscription) => {
    const r = s.lastResult;
    if (!r) return "never polled";
    return `${r.at.slice(0, 16).replace("T", " ")}: ${r.listed} listed, ${r.queued} queued, ${r.alreadyKnown} known${r.error ? ` — ${r.error}` : ""}`;
  };

  return (
    <div className="card">
      <strong>Follow a channel or playlist</strong>
      <p className="muted">A bounded subscription: every poll lists the newest videos, skips anything already in the ledger (including tracking-parameter variants of the same link), and queues at most the per-run budget through the normal YouTube import. Disable or delete it at any time.</p>
      <div className="grid-3">
        <label className="field"><span>Channel or playlist link</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/@channel or …/playlist?list=…" disabled={offline} /></label>
        <label className="field"><span>Poll every (hours)</span><input type="number" min={1} max={720} value={every} onChange={(e) => setEvery(Math.min(720, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label className="field"><span>Lookback (days, 0 = none)</span><input type="number" min={0} max={3650} value={lookback} onChange={(e) => setLookback(Math.max(0, Number(e.target.value) || 0))} /></label>
        <label className="field"><span>Max videos per poll</span><input type="number" min={1} max={50} value={perRun} onChange={(e) => setPerRun(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label className="field"><span>Title keywords (comma-separated, optional)</span><input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="picks, forecast, prediction" /><small>When set, a video must contain one of them to be queued.</small></label>
        <label className="row"><input type="checkbox" checked={autoExtract} onChange={(e) => setAutoExtract(e.target.checked)} /> <span>Extract predictions automatically</span></label>
      </div>
      {msg && <div className={`banner ${msg.kind}`} role="status">{msg.text}</div>}
      <div className="row">
        <button type="button" className="primary" onClick={add} disabled={!!busy || offline || needsTool || !url.trim()}>{busy === "Saving…" ? busy : "Save subscription"}</button>
        {offline && <span className="muted small">Internet access is off in Setup → Privacy; subscriptions cannot be polled.</span>}
      </div>
      {subs === null ? null : subs.length === 0 ? <p className="muted small">No subscriptions yet.</p> : (
        <ul className="plain subscriptions">
          {subs.map((s) => (
            <li key={s.id} className={s.enabled ? "" : "muted"}>
              <div className="row space-between">
                <span><strong>{s.title ?? s.url}</strong> <span className="muted small">· {s.kind} · every {s.pollIntervalHours}h · ≤{s.maxVideosPerRun}/poll{s.lookbackDays ? ` · last ${s.lookbackDays} days` : ""}{s.categoryAllowlist.length ? ` · keywords: ${s.categoryAllowlist.join(", ")}` : ""}{s.autoExtract ? "" : " · no auto-extract"}</span></span>
                <span className="row small">
                  <button type="button" className="link" disabled={!!busy || offline} onClick={() => runNow(s)}>run now</button>
                  <button type="button" className="link" disabled={!!busy} onClick={() => act("Updating…", () => subscriptionsApi.update(s.id, { enabled: !s.enabled }))}>{s.enabled ? "disable" : "enable"}</button>
                  <button type="button" className="link" disabled={!!busy} onClick={() => act("Deleting…", () => subscriptionsApi.remove(s.id))}>delete</button>
                </span>
              </div>
              <div className="muted small">Last poll {summary(s)}{s.nextRunAt && s.enabled ? ` · next ${s.nextRunAt.slice(0, 16).replace("T", " ")}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
