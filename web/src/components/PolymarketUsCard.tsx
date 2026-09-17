/**
 * Prediction Ledger — Setup → Polymarket US account card (1.10, ACC-02).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Credentials typed here go to the server once (test or save) and are never read back; only masked
 * hints and a credential fingerprint return. Nothing on this card can place an order: this build has no
 * submission path, and connecting never changes the trading mode.
 */
import { useEffect, useState } from "react";
import { LIVE_ACKNOWLEDGEMENT, type TradingConnectionTest, type TradingMode, type TradingStatus } from "@prediction-ledger/shared";
import { ApiError, fmtAmount, tradingApi } from "../api";

const MODE_LABELS: Record<TradingMode, string> = { disabled: "Disabled", paper: "Paper (no real orders)", manual_live: "Manual live (preview → confirm, real money)", auto_live: "Automatic live (arm it in the Automatic execution card)" };

export function PolymarketUsCard({ allowInternet }: { allowInternet: boolean }) {
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [keyId, setKeyId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [assertSame, setAssertSame] = useState(false);
  const [test, setTest] = useState<TradingConnectionTest | "testing" | null>(null);
  const [busy, setBusy] = useState<"save" | "sync" | "disconnect" | "mode" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState<{ id: string; at: string; kind: string; details: Record<string, unknown> }[]>([]);

  const reload = () => tradingApi.status().then(setStatus).catch((e) => setMsg({ kind: "error", text: (e as Error).message }));
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (showAudit) tradingApi.audit(50).then(setAudit).catch(() => setAudit([])); }, [showAudit, status?.binding?.state]);

  const runTest = async () => {
    setTest("testing");
    setMsg(null);
    try {
      setTest(await tradingApi.test({ keyId: keyId || undefined, secretKey: secretKey || undefined }));
    } catch (e) {
      setTest({ ok: false, code: "request_failed", message: (e as Error).message, orderCalls: 0 });
    }
  };
  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      const r = await tradingApi.connect({ keyId, secretKey, assertSameAccount: assertSame || undefined });
      setStatus(r.status);
      setKeyId("");
      setSecretKey("");
      setAssertSame(false);
      setTest(null);
      setMsg({ kind: "ok", text: `Connected (binding ${r.binding.id.slice(0, 8)}, continuity: ${r.binding.continuity}). ${r.sync?.ok ? "Account read." : "Account read failed — see status."}` });
    } catch (e) {
      const body = (e as ApiError).body as { test?: TradingConnectionTest; message?: string } | undefined;
      setMsg({ kind: "error", text: body?.test?.message ?? (e as Error).message });
      if (body?.test) setTest(body.test);
    } finally {
      setBusy(null);
    }
  };
  const sync = async () => {
    setBusy("sync");
    setMsg(null);
    try {
      await tradingApi.sync();
      await reload();
      setMsg({ kind: "ok", text: "Account state refreshed." });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
      await reload();
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (!window.confirm("Disconnect Polymarket US?\n\nThis removes the API key from this computer only — it does not revoke the key at the venue (do that at polymarket.us/developer). History and audit events are kept.")) return;
    setBusy("disconnect");
    setMsg(null);
    try {
      const r = await tradingApi.disconnect();
      setStatus(r.status);
      setMsg({ kind: "ok", text: r.note });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const [ack, setAck] = useState<string | null>(null);
  const setMode = async (mode: TradingMode, acknowledge?: string) => {
    if (mode === "manual_live" && acknowledge === undefined) { setAck(""); return; }
    if (mode === "auto_live") { setMsg({ kind: "error", text: "Automatic trading is armed only from the Automatic execution card below, with the acknowledgement and the reviewed policy hash." }); return; }
    setBusy("mode");
    setMsg(null);
    try {
      await tradingApi.setMode(mode, acknowledge);
      setAck(null);
      await reload();
    } catch (e) {
      const body = (e as ApiError).body as { gates?: { label: string; detail: string }[]; message?: string } | undefined;
      setMsg({ kind: "error", text: body?.message ?? (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const disarm = async () => {
    setBusy("mode");
    setMsg(null);
    try {
      const r = await tradingApi.disarm("owner disarm from Setup");
      setStatus(r.status);
      setMsg({ kind: "ok", text: "Disarmed: mode is paper and the live authorization is cleared. Open orders at the venue are untouched (cancel them from Trades if needed)." });
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const b = status?.binding;
  const sync0 = status?.latestSync;
  const okSync = sync0?.ok ? sync0 : undefined;
  const validated = !!b?.lastValidatedAt && !b.lastValidationError;

  return (
    <fieldset className="card">
      <p className="muted small">
        Connecting an account lets the app <strong>read</strong> your Polymarket US balances, positions and open orders. Connecting never arms anything: the trading mode stays <strong>paper</strong>
        until you choose <em>Manual live</em> here and type the acknowledgement. Even then, every order needs a preview and an explicit confirmation on the Trades page. Automatic orders exist only while the <em>Automatic execution</em> card below is armed against the policy hash you reviewed and a production-qualified strategy.
        Requests go only to <code>{status?.hosts.api ?? "api.polymarket.us"}</code>, signed with your key (Ed25519); the secret is encrypted on this computer and never shown again.
      </p>
      <details>
        <summary>How to get API keys (developer portal)</summary>
        <ol className="small">
          <li>Install the Polymarket US app, create an account and complete identity verification (the venue requires it before any API access).</li>
          <li>Open <a href="https://polymarket.us/developer" target="_blank" rel="noreferrer">polymarket.us/developer</a> and sign in <em>with the same method</em> you used in the app (Apple, Google or email).</li>
          <li>Create an API key. Copy the <strong>Key ID</strong> and the <strong>Secret Key</strong> — the secret is shown only once.</li>
          <li>Paste both below, click <strong>Test connection</strong>, then <strong>Save</strong>. To rotate a key later, paste the new pair and save again; to stop, click <strong>Disconnect</strong> and revoke the key in the portal.</li>
        </ol>
      </details>

      {status && (
        <div className="grid-3">
          <div className="field">
            <span>Status</span>
            <strong>{b ? (b.state === "connected" ? (validated ? "Connected" : "Connected — validation failed") : b.state) : status.previousBindings[0]?.state === "needs_rebind" ? "Needs reconnect (restored backup)" : "Not connected"}</strong>
            {b && <small className="muted">key {b.keyIdHint ?? "—"} · secret {b.secretHint ?? "—"} · fingerprint <code>{b.credentialFingerprint}</code></small>}
            {b?.lastValidationError && <small className="error">{b.lastValidationError}</small>}
          </div>
          <div className="field">
            <span>Last validation / sync</span>
            <strong>{b?.lastValidatedAt ? b.lastValidatedAt.slice(0, 19).replace("T", " ") : "—"}</strong>
            <small className="muted">{status.syncAgeSeconds === undefined ? "never synced" : `synced ${status.syncAgeSeconds} s ago${status.stale ? " (stale — refresh before relying on it)" : ""}`}</small>
          </div>
          <div className="field">
            <span>Mode</span>
            <select value={status.policy.mode} disabled={busy !== null} onChange={(e) => void setMode(e.target.value as TradingMode)}>
              {(Object.keys(MODE_LABELS) as TradingMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
            </select>
            <small className="muted">{status.armed ? `Armed (manual live) since ${status.policy.liveAuthorizedAt?.slice(0, 19).replace("T", " ")}. Restarts, limit edits, backups/restores and credential changes disarm.` : "Manual live needs a fresh, validated account, no open holds and the typed acknowledgement; automatic live is armed on the Automatic execution card, never here."}</small>
            {status.armed && <button type="button" className="danger" disabled={busy !== null} onClick={() => void disarm()}>Disarm now</button>}
          </div>
        </div>
      )}
      {status && (status.dispatchBlockers.length > 0 || status.armed) && (
        <p className={`small ${status.submissionAvailable ? "ok" : "warn"}`}>
          {status.submissionAvailable ? "Orders can be previewed and confirmed on the Trades page." : `New orders are blocked: ${status.dispatchBlockers.join("; ")}.`}
        </p>
      )}
      {ack !== null && (
        <div className="banner warn" role="dialog" aria-label="Manual live acknowledgement">
          <p><strong>Manual live places real orders with real money.</strong> Each order still needs a preview and your confirmation, is bounded by the pilot limits, and is sent once — an ambiguous outcome pauses trading until you resolve it. To continue, type exactly:</p>
          <p><code>{LIVE_ACKNOWLEDGEMENT}</code></p>
          <div className="row">
            <input type="text" value={ack} onChange={(e) => setAck(e.target.value)} placeholder="Type the sentence above" style={{ minWidth: "28rem" }} />
            <button type="button" className="danger" disabled={busy !== null || ack !== LIVE_ACKNOWLEDGEMENT} onClick={() => void setMode("manual_live", ack)}>Enter manual live</button>
            <button type="button" onClick={() => setAck(null)}>Cancel</button>
          </div>
        </div>
      )}

      {okSync && (
        <div className="grid-3">
          {okSync.balances.map((bal) => (
            <div key={bal.currency} className="field">
              <span>Buying power ({bal.currency})</span>
              <strong>{fmtAmount(bal.buyingPower)}</strong>
              <small className="muted">balance {fmtAmount(bal.currentBalance)} · in open orders {fmtAmount(bal.openOrdersNotional)}{bal.precisionSource === "number" ? " · venue sent numbers, rendered as decimals" : ""}</small>
            </div>
          ))}
          <div className="field"><span>Positions</span><strong>{okSync.positions.length}</strong><small className="muted">{okSync.complete ? "complete snapshot" : "partial snapshot"}</small></div>
          <div className="field"><span>Open orders (any source)</span><strong>{okSync.openOrders.length}</strong><small className="muted">none of these were placed by this app</small></div>
        </div>
      )}
      {okSync && okSync.positions.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Market</th><th>Outcome</th><th>Net contracts</th><th>Cost</th><th>Value</th></tr></thead>
            <tbody>
              {okSync.positions.slice(0, 20).map((p) => (
                <tr key={p.marketSlug}><td>{p.title ?? p.marketSlug}</td><td>{p.outcome ?? "—"}</td><td>{p.netQuantity}</td><td>{fmtAmount(p.cost)}</td><td>{fmtAmount(p.cashValue)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid-3">
        <label className="field">
          <span>Key ID</span>
          <input type="text" autoComplete="off" value={keyId} placeholder={b ? "leave blank to keep the saved key" : "from the developer portal"} onChange={(e) => setKeyId(e.target.value)} />
        </label>
        <label className="field">
          <span>Secret key</span>
          <input type="password" autoComplete="new-password" value={secretKey} placeholder={b ? "leave blank to keep the saved secret" : "shown once in the portal"} onChange={(e) => setSecretKey(e.target.value)} />
        </label>
        {b && (
          <label className="row">
            <input type="checkbox" checked={assertSame} onChange={(e) => setAssertSame(e.target.checked)} />
            <span className="small">This new key belongs to the <em>same</em> account (keeps the binding; marked as your assertion, not venue-verified).</span>
          </label>
        )}
      </div>
      <div className="row">
        <button type="button" onClick={runTest} disabled={test === "testing" || !allowInternet}>{test === "testing" ? "Testing…" : "Test connection"}</button>
        <button type="button" onClick={save} disabled={busy !== null || !keyId || !secretKey || !allowInternet}>{busy === "save" ? "Saving…" : b ? "Replace credentials" : "Save & connect"}</button>
        {b && <button type="button" onClick={sync} disabled={busy !== null || !allowInternet}>{busy === "sync" ? "Refreshing…" : "Refresh account"}</button>}
        {b && <button type="button" className="danger" onClick={disconnect} disabled={busy !== null}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>}
        {!allowInternet && <small className="muted">Internet access is off in Privacy; nothing can be validated.</small>}
      </div>
      {test && test !== "testing" && (
        <div className={`banner ${test.ok ? "" : "error"}`} role="status">
          {test.ok ? "✓ " : "✗ "}{test.message}{test.ok && test.balances?.[0] ? ` Buying power ${fmtAmount(test.balances[0].buyingPower)}.` : ""} <small className="muted">(order calls made: {test.orderCalls})</small>
        </div>
      )}
      {msg && <div className={`banner ${msg.kind === "error" ? "error" : ""}`} role="status">{msg.text}</div>}
      {status && <p className="muted small">{status.identityNote}</p>}
      {status && (
        <details>
          <summary>Release gates for live trading ({status.gates.filter((g) => g.satisfied).length}/{status.gates.length} met)</summary>
          <ul className="small">
            {status.gates.map((g) => <li key={g.id}>{g.satisfied ? "✓" : "✗"} <strong>{g.label}</strong> — {g.detail}</li>)}
          </ul>
        </details>
      )}
      {status && status.previousBindings.length > 0 && (
        <details>
          <summary>Earlier bindings ({status.previousBindings.length})</summary>
          <ul className="small">
            {status.previousBindings.map((p) => <li key={p.id}><code>{p.id.slice(0, 8)}</code> {p.state} · {p.continuity} · fingerprint <code>{p.credentialFingerprint ?? "—"}</code> · {p.disconnectedAt ?? p.createdAt}</li>)}
          </ul>
        </details>
      )}
      <details open={showAudit} onToggle={(e) => setShowAudit((e.target as HTMLDetailsElement).open)}>
        <summary>Audit trail</summary>
        <ul className="small">
          {audit.map((a) => <li key={a.id}><code>{a.at.slice(0, 19).replace("T", " ")}</code> {a.kind} {Object.keys(a.details).length ? <span className="muted">{JSON.stringify(a.details)}</span> : null}</li>)}
          {audit.length === 0 && <li className="muted">No events yet.</li>}
        </ul>
      </details>
    </fieldset>
  );
}
