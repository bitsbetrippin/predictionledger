/**
 * Prediction Ledger — Setup tab (providers, stage routing, transcription, search, limits, privacy). 2.1: a left section
 * nav with state hints (#/setup?section=…), the Guided start as the first section, and a link to the worked example.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Secrets typed here are sent once on Save and never read back; the server returns
 * only a masked hint. Leaving a key field blank keeps the stored key; the "Clear" button
 * sends an empty string, which deletes it.
 */
import { useEffect, useState } from "react";
import type { AnalysisStage, AppSettings, HealthResponse, JobSummary, LlmProviderId, MediaStatus, ModelInfo, ProviderTestResult, ToolsStatus, TradingStatus } from "@prediction-ledger/shared";
import { api, backups, content, media, pollJob, toPayload, tradingApi, youtube, type BackupInfo, type SecretUpdates } from "../api";
import { HelpButton } from "../components/HelpButton";
import { Icon } from "../components/Icons";
import { Skeleton } from "../components/ui";
import { useGuidedStart } from "../hooks/useGuidedStart";
import { PolymarketUsCard } from "../components/PolymarketUsCard";
import { TradingLimitsCard } from "../components/TradingLimitsCard";
import { AutomationCard } from "../components/AutomationCard";
import type { PromptTemplateInfo } from "@prediction-ledger/shared";

const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  lmstudio: "LM Studio (local)",
};

const VENUE_LABELS = { polymarket: "Polymarket (international)", manifold: "Manifold", polymarket_us: "Polymarket US" } as const;
const VENUE_NOTES = {
  polymarket: " — USDC markets on the international site; trading there is geo-restricted, data is public.",
  manifold: " — play-money markets (mana); liquidity and volume are not dollars, so treat its signal gates accordingly.",
  polymarket_us: " — the CFTC-regulated US exchange (USD). Public market data needs no account; the account connection below is separate and never required for discovery.",
} as const;

const STAGE_LABELS: Record<AnalysisStage, string> = {
  extraction: "Prediction extraction",
  validationPlan: "Validation-plan generation",
  assessment: "Evidence assessment",
};

const SECTIONS: { id: string; label: string }[] = [
  { id: "guided", label: "Guided start" }, { id: "privacy", label: "Privacy" }, { id: "providers", label: "Providers" }, { id: "stages", label: "Which model does what" },
  { id: "transcription", label: "Transcription" }, { id: "sports", label: "Sports Mode" }, { id: "markets", label: "Prediction markets" }, { id: "youtube", label: "YouTube" },
  { id: "backups", label: "Backups" }, { id: "account", label: "Polymarket US account" }, { id: "limits", label: "Trading limits" }, { id: "automation", label: "Automatic execution" },
  { id: "search", label: "Web search" }, { id: "research", label: "Research" }, { id: "budgets", label: "Limits and budgets" }, { id: "templates", label: "Prompt templates" },
];

export function SetupPage({ section }: { section?: string }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [trading, setTrading] = useState<TradingStatus | null>(null);
  const [active, setActive] = useState<string>(section ?? "guided");
  const guided = useGuidedStart();
  useEffect(() => { tradingApi.status().then(setTrading).catch(() => setTrading(null)); }, []);
  // Jump to the requested section once the settings have rendered; then follow the scroll position.
  useEffect(() => {
    if (!settings) return;
    if (section) { setActive(section); document.getElementById(`setup-${section}`)?.scrollIntoView({ block: "start" }); }
    const els = SECTIONS.map((x) => document.getElementById(`setup-${x.id}`)).filter((e): e is HTMLElement => !!e);
    if (!("IntersectionObserver" in window) || els.length === 0) return;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id.replace(/^setup-/, ""));
    }, { root: document.querySelector(".content"), rootMargin: "0px 0px -70% 0px", threshold: 0 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [settings, section]);
  const [secrets, setSecrets] = useState<SecretUpdates>({});
  const [tests, setTests] = useState<Partial<Record<LlmProviderId, ProviderTestResult | "testing">>>({});
  const [models, setModels] = useState<Partial<Record<LlmProviderId, ModelInfo[]>>>({});
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaStatus, setMediaStatus] = useState<MediaStatus | null | "checking">(null);
  const checkMedia = () => { setMediaStatus("checking"); media.status().then(setMediaStatus).catch(() => setMediaStatus(null)); };
  const [modelJob, setModelJob] = useState<JobSummary | null>(null);
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const downloadModel = async () => {
    setModelMsg(null);
    try {
      const { jobId } = await media.downloadModel();
      const done = await pollJob(jobId, setModelJob);
      setModelJob(null);
      setModelMsg(done.status === "failed" ? `Download failed: ${done.error}` : done.stage ?? "Model ready.");
      checkMedia();
    } catch (e) {
      setModelJob(null);
      setModelMsg((e as Error).message);
    }
  };
  const [backupList, setBackupList] = useState<BackupInfo[] | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const loadBackups = () => backups.list().then(setBackupList).catch(() => setBackupList(null));
  const [keyFile, setKeyFile] = useState<HealthResponse["keyFileProtection"] | null>(null);
  useEffect(() => { void loadBackups(); api.health().then((h) => setKeyFile(h.keyFileProtection ?? null)).catch(() => undefined); }, []);
  const backupNow = async () => {
    setBackupMsg(null);
    try {
      const b = await backups.create();
      setBackupMsg(`Backup written: ${b.file} (${(b.bytes / 1024).toFixed(0)} KB${b.hasSecretKey ? ", secret key copied alongside" : ""}). Polymarket US credentials and any live authorization are not included; a restore needs a reconnect.`);
      await loadBackups();
    } catch (e) {
      setBackupMsg((e as Error).message);
    }
  };
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [installing, setInstalling] = useState<JobSummary | null>(null);
  const [toolMsg, setToolMsg] = useState<string | null>(null);
  const loadTools = () => youtube.toolsStatus().then(setTools).catch(() => setTools(null));
  useEffect(() => { void loadTools(); }, []);
  const installYtDlp = async () => {
    setToolMsg(null);
    if (!window.confirm("Download yt-dlp (about 30 MB) from its official GitHub release into your data folder? It is checksum-verified before use. Run this again later to update it.")) return;
    try {
      const { jobId } = await youtube.installYtDlp();
      const done = await pollJob(jobId, setInstalling);
      setInstalling(null);
      setToolMsg(done.status === "failed" ? `Install failed: ${done.error}` : "yt-dlp installed.");
      await loadTools();
    } catch (e) {
      setInstalling(null);
      setToolMsg((e as Error).message);
    }
  };

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e: Error) => setStatus({ kind: "error", text: e.message }));
  }, []);

  if (!settings) return <section className="page"><Skeleton rows={6} /></section>;

  const usable = (Object.entries(settings.providers) as [LlmProviderId, AppSettings["providers"]["anthropic"]][]).filter(([id, p]) => p.enabled && (id === "lmstudio" || p.hasSecret)).length;
  const gatesUnmet = trading ? trading.gates.filter((g) => !g.satisfied && g.id !== "live_authorization").length : undefined;
  const hints: Record<string, { text: string; tone?: "ok" | "warn" }> = {
    guided: { text: `${guided.done}/${guided.total}` },
    privacy: { text: `internet ${settings.privacy.allowInternet ? "on" : "off"}`, tone: settings.privacy.allowInternet ? "ok" : undefined },
    providers: { text: usable ? `${usable} connected` : "none", tone: usable ? "ok" : "warn" },
    stages: { text: "configured" },
    transcription: { text: settings.transcription.engine.replace("local-whisper", "local Whisper").replace("openai-transcribe", "OpenAI").replace("youtube-captions", "captions") },
    sports: { text: settings.sports.enabled ? "on" : "off" },
    markets: { text: settings.markets.enabled ? "enabled" : "off" },
    youtube: { text: tools ? (tools.ytdlp.ok ? "yt-dlp ready" : "needs yt-dlp") : "" , tone: tools?.ytdlp.ok ? "ok" : undefined },
    backups: { text: backupList ? `${backupList.length}` : "" },
    account: { text: trading ? (trading.binding ? "connected" : "not connected") : "", tone: trading?.binding ? "ok" : undefined },
    limits: { text: trading ? trading.policy.policyVersion : "" },
    automation: { text: trading ? (trading.policy.mode === "auto_live" ? "armed" : gatesUnmet ? "cannot arm" : "ready to arm") : "", tone: trading?.policy.mode === "auto_live" ? "warn" : undefined },
    search: { text: settings.search.provider === "none" ? "none" : settings.search.provider.replace("-native", " built-in"), tone: settings.search.provider === "none" ? "warn" : "ok" },
    research: { text: "" }, budgets: { text: "" }, templates: { text: "" },
  };

  const update = (patch: (s: AppSettings) => AppSettings) => setSettings((s) => (s ? patch(structuredClone(s)) : s));

  const setProvider = (id: LlmProviderId, field: "enabled" | "model" | "baseUrl", value: string | boolean) =>
    update((s) => {
      (s.providers[id] as unknown as Record<string, unknown>)[field] = value;
      return s;
    });

  const runTest = async (id: LlmProviderId) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    try {
      const result = await api.testProvider({
        provider: id,
        apiKey: secrets[id] || undefined,
        baseUrl: settings.providers[id].baseUrl,
      });
      setTests((t) => ({ ...t, [id]: result }));
      if (result.models?.length) setModels((m) => ({ ...m, [id]: result.models }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, provider: id, message: (e as Error).message, code: "unknown" } }));
    }
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const next = await api.saveSettings(toPayload(settings), secrets);
      setSettings(next);
      setSecrets({});
      setStatus({ kind: "ok", text: "Settings saved." });
    } catch (e) {
      setStatus({ kind: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page wide">
    <div className="setup-layout">
      <nav className="setup-nav" aria-label="Setup sections">
        {SECTIONS.map((x) => <a key={x.id} href={`#/setup?section=${x.id}`} className={active === x.id ? "active" : undefined} onClick={(e) => { e.preventDefault(); setActive(x.id); document.getElementById(`setup-${x.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); window.history.replaceState(null, "", `#/setup?section=${x.id}`); }}><span>{x.label}</span>{hints[x.id]?.text && <span className={`hint${hints[x.id].tone ? ` ${hints[x.id].tone}` : ""}`}>{hints[x.id].text}</span>}</a>)}
      </nav>
      <div>
      <p className="muted">
        Everything is stored on this computer in <code>{settings.dataDir}</code>. Cloud providers and online research send selected
        text (transcript excerpts, predictions, search queries) to those services — local options keep it on this machine. <HelpButton topic="troubleshoot.privacy-pending">What leaves the machine</HelpButton>
      </p>

      {status && (
        <div className={`banner ${status.kind}`} role="status">
          {status.text}
        </div>
      )}

      <h2 id="setup-guided" className="setup-section">Guided start</h2>
      <GuidedStartSection />

      <h2 id="setup-privacy" className="setup-section">Privacy</h2>
      <label className="row">
        <input
          type="checkbox"
          checked={settings.privacy.allowInternet}
          onChange={(e) => update((s) => ((s.privacy.allowInternet = e.target.checked), s))}
        />
        <span>
          Allow internet access (cloud AI providers, YouTube acquisition, web research). When off, only local endpoints such as LM Studio are
          contacted and outcome research stays <em>pending</em>.
        </span>
      </label>

      <h2 id="setup-providers" className="setup-section">Language-model providers</h2>
      {(Object.keys(PROVIDER_LABELS) as LlmProviderId[]).map((id) => {
        const p = settings.providers[id];
        const test = tests[id];
        const discovered = models[id] ?? [];
        return (
          <fieldset key={id} className="card">
            <legend>
              <label className="row">
                <input type="checkbox" checked={p.enabled} onChange={(e) => setProvider(id, "enabled", e.target.checked)} />
                <strong>{PROVIDER_LABELS[id]}</strong>
                {id !== "lmstudio" && <span className="chip cloud">cloud</span>}
                {id === "lmstudio" && <span className="chip local">local</span>}
              </label>
            </legend>

            {id === "lmstudio" && (
              <label className="field">
                <span>Server URL</span>
                <input type="url" value={p.baseUrl ?? ""} placeholder="http://127.0.0.1:1234/v1" onChange={(e) => setProvider(id, "baseUrl", e.target.value)} />
                <small>
                  In LM Studio open <em>Developer</em> → start the server, load a model, then Test. See <code>docs/SETUP.md</code>.
                </small>
              </label>
            )}

            <label className="field">
              <span>{id === "lmstudio" ? "API key (only if you enabled auth in LM Studio)" : "API key"}</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={p.hasSecret ? `Saved: ${p.secretHint} — type to replace` : "Not saved"}
                value={secrets[id] ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, [id]: e.target.value }))}
              />
              {p.hasSecret && (
                <button type="button" className="link" onClick={() => setSecrets((s) => ({ ...s, [id]: "" }))}>
                  Clear saved key on next save
                </button>
              )}
            </label>

            <label className="field">
              <span>Model</span>
              <input list={`models-${id}`} value={p.model} placeholder="Type a model id or Test to discover" onChange={(e) => setProvider(id, "model", e.target.value)} />
              <datalist id={`models-${id}`}>
                {discovered.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ?? m.id}
                  </option>
                ))}
              </datalist>
            </label>

            <div className="row">
              <button type="button" onClick={() => runTest(id)} disabled={test === "testing"}>
                {test === "testing" ? "Testing…" : "Test connection"}
              </button>
              {test && test !== "testing" && (
                <span className={test.ok ? "result ok" : "result error"} role="status">
                  {test.ok ? "✓" : "✕"} {test.message}
                  {test.latencyMs !== undefined ? ` (${test.latencyMs} ms)` : ""}
                </span>
              )}
            </div>
          </fieldset>
        );
      })}

      <h2 id="setup-stages" className="setup-section">Which model does what</h2>
      <p className="muted">Each analysis stage can use a different provider and model — for example a local model for extraction and a stronger cloud model for assessment.</p>
      <div className="grid-3">
        {(Object.keys(STAGE_LABELS) as AnalysisStage[]).map((stage) => (
          <fieldset key={stage} className="card">
            <legend>{STAGE_LABELS[stage]}</legend>
            <label className="field">
              <span>Provider</span>
              <select value={settings.stages[stage].provider} onChange={(e) => update((s) => ((s.stages[stage].provider = e.target.value as LlmProviderId), s))}>
                {(Object.keys(PROVIDER_LABELS) as LlmProviderId[]).map((id) => (
                  <option key={id} value={id} disabled={!settings.providers[id].enabled}>
                    {PROVIDER_LABELS[id]}
                    {!settings.providers[id].enabled ? " (disabled)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Model override (optional)</span>
              <input value={settings.stages[stage].model ?? ""} placeholder="Provider default" onChange={(e) => update((s) => ((s.stages[stage].model = e.target.value || undefined), s))} />
            </label>
          </fieldset>
        ))}
      </div>

      <h2 id="setup-transcription" className="setup-section">Transcription</h2>
      <fieldset className="card">
        <label className="field">
          <span>Engine</span>
          <select value={settings.transcription.engine} onChange={(e) => update((s) => ((s.transcription.engine = e.target.value as AppSettings["transcription"]["engine"]), s))}>
            <option value="local-whisper">Local Whisper (runs on this computer, model downloaded once)</option>
            <option value="openai-transcribe">OpenAI transcription (cloud — audio leaves this computer)</option>
            <option value="youtube-captions">YouTube captions when available (Release 0.5)</option>
            <option value="import">Import transcript file only</option>
          </select>
          <small>Video import always needs ffmpeg on this computer. Local Whisper also needs the optional <code>@huggingface/transformers</code> package and a one-time model download (see SETUP.md).</small>
        </label>
        <div className="grid-3">
          <label className="field">
            <span>Local Whisper model</span>
            <input value={settings.transcription.localModel} onChange={(e) => update((s) => ((s.transcription.localModel = e.target.value), s))} />
            <small>e.g. onnx-community/whisper-base (fast) · whisper-small (better) · whisper-large-v3-turbo (best, slow on CPU)</small>
          </label>
          <label className="field">
            <span>OpenAI transcription model</span>
            <input value={settings.transcription.openaiModel} onChange={(e) => update((s) => ((s.transcription.openaiModel = e.target.value), s))} />
            <small>whisper-1 returns segment timestamps; other models yield one segment per chunk.</small>
          </label>
          <label className="field">
            <span>Language</span>
            <input value={settings.transcription.language} placeholder="auto" onChange={(e) => update((s) => ((s.transcription.language = e.target.value), s))} />
            <small>Blank = auto-detect.</small>
          </label>
        </div>
        <div className="grid-3">
          <label className="field">
            <span>Chunk length (seconds)</span>
            <input type="number" min={60} max={1800} value={settings.transcription.chunkSeconds} onChange={(e) => update((s) => ((s.transcription.chunkSeconds = Number(e.target.value)), s))} />
            <small>Long recordings are transcribed in resumable chunks. 300 s is a good default.</small>
          </label>
          <label className="field">
            <span>Chunk overlap (seconds)</span>
            <input type="number" min={0} max={30} value={settings.transcription.overlapSeconds} onChange={(e) => update((s) => ((s.transcription.overlapSeconds = Number(e.target.value)), s))} />
            <small>Overlap keeps words at chunk edges intact; duplicates are dropped when stitching.</small>
          </label>
        </div>
        <div className="row">
          <button type="button" onClick={checkMedia} disabled={mediaStatus === "checking"}>{mediaStatus === "checking" ? "Checking…" : "Check media tools"}</button>
          {settings.transcription.engine === "local-whisper" && (
            <button type="button" onClick={downloadModel} disabled={!!modelJob}>{modelJob ? `Downloading… ${modelJob.progress}%` : "Download model now"}</button>
          )}
          {modelJob?.stage && <small className="muted">{modelJob.stage}</small>}
          {mediaStatus && mediaStatus !== "checking" && (
            <span className="small">
              <span className={mediaStatus.ffmpeg.ok ? "result ok" : "result error"}>ffmpeg: {mediaStatus.ffmpeg.message}</span>
              {" · "}
              <span className={mediaStatus.engine.ok ? "result ok" : "result error"}>{mediaStatus.engine.id}: {mediaStatus.engine.message}</span>
            </span>
          )}
        </div>
        {modelMsg && <div className="banner" role="status">{modelMsg}</div>}
        <small className="muted">Checks the saved settings — click Save first if you changed the engine. "Download model now" fetches the Whisper model into the data directory ahead of your first import (needs internet once).</small>
      </fieldset>

      <h2 id="setup-sports" className="setup-section">Sports Mode</h2>
      <fieldset className="card">
        <label className="row">
          <input type="checkbox" checked={settings.sports.enabled} onChange={(e) => update((s) => ((s.sports.enabled = e.target.checked), s))} />
          <span><strong>Sports Mode</strong> — treat videos as game-pick content. Extraction returns each pick as <em>team vs team</em> with the game as the deadline (win, spread, or total). Picks are settled with <strong>Validate scores</strong> (a trusted box-score look-up) instead of the full research loop.</span>
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.sports.trackSpreads} onChange={(e) => update((s) => ((s.sports.trackSpreads = e.target.checked), s))} />
          <span>Track point spreads (cover / no cover). When off, a spread pick is recorded as a plain win/loss pick on the named team.</span>
        </label>
        <small className="muted">Game picks are detected even with Sports Mode off; the switch tells the extractor to look for them and ignore analysis chatter. Trusted score sources: league sites, ESPN, AP, CBS/Fox/NBC/Yahoo Sports, BBC/Sky, the Reference sites.</small>
      </fieldset>

      <h2 id="setup-markets" className="setup-section">Prediction markets</h2>
      <fieldset className="card">
        <label className="row">
          <input type="checkbox" checked={settings.markets.enabled} onChange={(e) => update((s) => ((s.markets.enabled = e.target.checked), s))} />
          <span><strong>Enable prediction-market data (Polymarket)</strong> — read-only. Searches and price snapshots go to the venue's public API; no account, no wallet, no trading. Turned off, the Markets page and the Markets tab stay quiet.</span>
        </label>
        <div className="grid-3">
          <label className="field">
            <span>Auto-refresh every (hours)</span>
            <input type="number" min={0} max={168} step={1} value={settings.markets.refreshHours} onChange={(e) => update((s) => ((s.markets.refreshHours = Math.max(0, Number(e.target.value) || 0)), s))} />
            <small>0 = manual only. Refreshes watched and linked markets while the app is running.</small>
          </label>
          <label className="field">
            <span>Markets per refresh</span>
            <input type="number" min={1} max={500} step={1} value={settings.markets.snapshotBudget} onChange={(e) => update((s) => ((s.markets.snapshotBudget = Math.max(1, Number(e.target.value) || 1)), s))} />
            <small>Budget per snapshot run; requests also respect the requests-per-minute limit.</small>
          </label>
          <label className="row">
            <input type="checkbox" checked={settings.markets.autoLinkSports} onChange={(e) => update((s) => ((s.markets.autoLinkSports = e.target.checked), s))} />
            <span>Auto-accept exact game matchups (both teams, game date, same pick type). General predictions are always proposals you accept by hand.</span>
          </label>
        </div>
        <h3>Venues</h3>
        <div className="grid-3">
          {(["polymarket", "manifold", "polymarket_us"] as const).map((v) => (
            <label key={v} className="row">
              <input type="checkbox" checked={settings.markets.venues.includes(v)} onChange={(e) => update((s) => { const set = new Set(s.markets.venues); if (e.target.checked) set.add(v); else set.delete(v); if (set.size === 0) set.add("polymarket"); s.markets.venues = [...set]; return s; })} />
              <span><strong>{VENUE_LABELS[v]}</strong>{VENUE_NOTES[v]}</span>
            </label>
          ))}
          <label className="field"><span>Default venue</span><select value={settings.markets.provider} onChange={(e) => update((s) => ((s.markets.provider = e.target.value as typeof s.markets.provider), s))}><option value="polymarket">Polymarket (international)</option><option value="manifold">Manifold</option><option value="polymarket_us">Polymarket US</option></select></label>
        </div>
        <h3>Watch rules</h3>
        <p className="muted small">Checked after every snapshot refresh (and on demand from the Signals page); each rule raises one local alert per subject per day.</p>
        <div className="grid-3">
          <label className="row"><input type="checkbox" checked={settings.markets.watch.enabled} onChange={(e) => update((s) => ((s.markets.watch.enabled = e.target.checked), s))} /> <span>Enable watch rules</span></label>
          <label className="field"><span>Price move (pts, ~24 h)</span><input type="number" min={1} max={100} value={settings.markets.watch.movePts} onChange={(e) => update((s) => ((s.markets.watch.movePts = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Divergence (pts)</span><input type="number" min={1} max={100} value={settings.markets.watch.divergencePts} onChange={(e) => update((s) => ((s.markets.watch.divergencePts = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Resolving within (days)</span><input type="number" min={1} max={365} value={settings.markets.watch.resolveDays} onChange={(e) => update((s) => ((s.markets.watch.resolveDays = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
        </div>
        <h3>Paper trading</h3>
        <p className="muted small">Hypothetical positions only; the app never places an order. Positions are marked at every snapshot and close on venue resolution. Auto-open records a position whenever a signal reaches the chosen label.</p>
        <div className="grid-3">
          <label className="row"><input type="checkbox" checked={settings.markets.paper.enabled} onChange={(e) => update((s) => ((s.markets.paper.enabled = e.target.checked), s))} /> <span>Enable paper trading</span></label>
          <label className="field"><span>Starting bankroll ($)</span><input type="number" min={1} step={100} value={settings.markets.paper.bankroll} onChange={(e) => update((s) => ((s.markets.paper.bankroll = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Sizing</span><select value={settings.markets.paper.sizing} onChange={(e) => update((s) => ((s.markets.paper.sizing = e.target.value as "fixed" | "kelly"), s))}><option value="fixed">Fixed stake</option><option value="kelly">Fractional Kelly on the signal's edge</option></select></label>
          <label className="field"><span>Fixed stake ($)</span><input type="number" min={1} value={settings.markets.paper.fixedStake} onChange={(e) => update((s) => ((s.markets.paper.fixedStake = Math.max(0.01, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Kelly fraction</span><input type="number" min={0.01} max={1} step={0.05} value={settings.markets.paper.kellyFraction} onChange={(e) => update((s) => ((s.markets.paper.kellyFraction = Math.min(1, Math.max(0.01, Number(e.target.value) || 0.25))), s))} /><small>0.25 = quarter Kelly (recommended; full Kelly assumes the edge is exact).</small></label>
          <label className="field"><span>Max stake (fraction of bankroll)</span><input type="number" min={0.001} max={1} step={0.01} value={settings.markets.paper.maxStakeFraction} onChange={(e) => update((s) => ((s.markets.paper.maxStakeFraction = Math.min(1, Math.max(0.001, Number(e.target.value) || 0.1))), s))} /></label>
          <label className="field"><span>Auto-open on signals</span><select value={settings.markets.paper.autoOpen} onChange={(e) => update((s) => ((s.markets.paper.autoOpen = e.target.value as "off" | "lean" | "moderate" | "strong"), s))}><option value="off">Off — open by hand only</option><option value="lean">Lean or stronger</option><option value="moderate">Moderate or stronger</option><option value="strong">Strong only</option></select></label>
          <label className="field"><span>Max open positions</span><input type="number" min={1} max={1000} value={settings.markets.paper.maxOpenPositions} onChange={(e) => update((s) => ((s.markets.paper.maxOpenPositions = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
        </div>
        <h3>Signal gates</h3>
        <p className="muted small">A signal label appears only when a contributor's record, the edge, the market's liquidity and the deadlines all clear these thresholds. Realized edge is shrunk by n/(n+k) toward zero; k is the prior weight.</p>
        <div className="grid-3">
          <label className="field"><span>Prior weight (k)</span><input type="number" min={0} max={1000} value={settings.markets.signals.priorWeight} onChange={(e) => update((s) => ((s.markets.signals.priorWeight = Math.max(0, Number(e.target.value) || 0)), s))} /></label>
          <label className="field"><span>Min settled — lean</span><input type="number" min={1} value={settings.markets.signals.minSettledLean} onChange={(e) => update((s) => ((s.markets.signals.minSettledLean = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Min settled — moderate</span><input type="number" min={1} value={settings.markets.signals.minSettledModerate} onChange={(e) => update((s) => ((s.markets.signals.minSettledModerate = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Min settled — strong</span><input type="number" min={1} value={settings.markets.signals.minSettledStrong} onChange={(e) => update((s) => ((s.markets.signals.minSettledStrong = Math.max(1, Number(e.target.value) || 1)), s))} /></label>
          <label className="field"><span>Min liquidity ($)</span><input type="number" min={0} step={1000} value={settings.markets.signals.minLiquidity} onChange={(e) => update((s) => ((s.markets.signals.minLiquidity = Math.max(0, Number(e.target.value) || 0)), s))} /></label>
        </div>
      </fieldset>

      <h2 id="setup-youtube" className="setup-section">YouTube</h2>
      <fieldset className="card">
        <p className="muted">Pasting a link sends the video id to YouTube (via yt-dlp) to read its title, date, captions, and — when needed — the audio. Nothing else leaves this computer. yt-dlp scrapes YouTube, so it can break when YouTube changes; updating it usually fixes that.</p>
        <div className="grid-3">
          <label className="field">
            <span>Captions to accept</span>
            <select value={settings.youtube.captions} onChange={(e) => update((s) => ((s.youtube.captions = e.target.value as AppSettings["youtube"]["captions"]), s))}>
              <option value="manual-then-auto">Creator captions, then auto-generated</option>
              <option value="manual-only">Creator captions only</option>
              <option value="never">Never — always transcribe the audio</option>
            </select>
            <small>Auto-generated captions are fast but can garble names and numbers; quotes are only as exact as the captions.</small>
          </label>
          <label className="field">
            <span>Caption language</span>
            <input value={settings.youtube.captionLanguage} placeholder="auto" onChange={(e) => update((s) => ((s.youtube.captionLanguage = e.target.value), s))} />
            <small>auto = transcription language → the video's language → en.</small>
          </label>
          <div className="field">
            <span>Audio fallback</span>
            <label className="row"><input type="checkbox" checked={settings.youtube.allowAudioDownload} onChange={(e) => update((s) => ((s.youtube.allowAudioDownload = e.target.checked), s))} /><span>Download the audio and transcribe it when no acceptable captions exist</span></label>
          </div>
        </div>
        <div className="row">
          <button type="button" onClick={installYtDlp} disabled={!!installing || (tools ? !tools.internet : false)}>
            {installing ? `Installing… ${installing.progress}%` : tools?.ytdlp.ok ? "Update yt-dlp" : "Install yt-dlp"}
          </button>
          <button type="button" onClick={() => void loadTools()}>Re-check</button>
          {tools && (
            <span className="small">
              <span className={tools.ytdlp.ok ? "result ok" : "result error"}>{tools.ytdlp.message}</span>
              {tools.ytdlp.installedAt && <span className="muted"> · installed {tools.ytdlp.installedAt.slice(0, 10)}</span>}
              {!tools.internet && <span className="muted"> · internet is off (Privacy) — installs and imports disabled</span>}
            </span>
          )}
          {installing?.stage && <small className="muted">{installing.stage}</small>}
        </div>
        {toolMsg && <div className="banner" role="status">{toolMsg}</div>}
        <small className="muted">The binary is downloaded from github.com/yt-dlp/yt-dlp (official release), verified against its SHA-256 list, and stored in your data directory's <code>tools/</code> folder. Set <code>PL_YTDLP_PATH</code> to use your own copy instead.</small>
      </fieldset>

      <h2 id="setup-backups" className="setup-section">Backups</h2>
      <fieldset className="card">
        <p className="muted">Writes a consistent copy of the database (videos, transcripts, predictions, plans, evidence, verdicts, settings) and the secret key into the data directory's <code>backups/</code> folder while the app runs. Media files are not included — they can be re-imported. To restore: stop Prediction Ledger, copy the <code>.db</code> over <code>prediction-ledger.db</code> (and the <code>.secret.key</code> over <code>secret.key</code>), start again.</p>
        <div className="row">
          <button type="button" onClick={backupNow}>Back up now</button>
          <small className="muted">Also: <code>npm run backup</code> from a terminal. Backups are also taken automatically before every database migration (2.0: those copies are scrubbed of trading credentials and live authorization, like manual backups). Rehearse an upgrade on a copy first: <code>npm run upgrade:rehearse -- &lt;path-to-prediction-ledger.db&gt;</code>.</small>
        </div>
        {keyFile && (
          <p className={`small ${keyFile.ok ? "muted" : "error"}`}>
            Secret key file protection ({keyFile.method === "icacls" ? "Windows ACL" : keyFile.method === "posix_mode" ? "file mode" : "not verified"}): {keyFile.ok ? "restricted to your account" : "NOT restricted"} — {keyFile.detail}{keyFile.fix ? <> · fix: <code>{keyFile.fix}</code></> : null}
          </p>
        )}
        {backupMsg && <div className="banner" role="status">{backupMsg}</div>}
        {backupList && backupList.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>File</th><th>Kind</th><th>Size</th><th>Created</th><th>Key</th></tr></thead>
              <tbody>
                {backupList.slice(0, 10).map((b) => (
                  <tr key={b.file}><td><code>{b.file}</code></td><td>{b.kind}</td><td>{(b.bytes / 1024).toFixed(0)} KB</td><td>{b.createdAt.slice(0, 19).replace("T", " ")}</td><td>{b.hasSecretKey ? "✓" : "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>

      <h2 id="setup-account" className="setup-section">Polymarket US account</h2>
      <PolymarketUsCard allowInternet={settings.privacy.allowInternet} />
      <div id="setup-limits" className="setup-section" />
      <TradingLimitsCard />
      <div id="setup-automation" className="setup-section" />
      <AutomationCard />

      <h2 id="setup-search" className="setup-section">Web search (for outcome research)</h2>
      <fieldset className="card">
        <label className="field">
          <span>Provider</span>
          <select value={settings.search.provider} onChange={(e) => update((s) => ((s.search.provider = e.target.value as AppSettings["search"]["provider"]), s))}>
            <option value="none">None (research stays pending)</option>
            <option value="brave">Brave Search API</option>
            <option value="tavily">Tavily</option>
            <option value="searxng">SearXNG (self-hosted URL)</option>
            <option value="anthropic-native">Anthropic built-in web search</option>
            <option value="openai-native">OpenAI built-in web search</option>
          </select>
          <small>Search providers become active in Release 0.6; the setting and key are stored now.</small>
        </label>
        {settings.search.provider === "searxng" && (
          <label className="field">
            <span>SearXNG URL</span>
            <input type="url" value={settings.search.baseUrl ?? ""} placeholder="http://127.0.0.1:8080" onChange={(e) => update((s) => ((s.search.baseUrl = e.target.value || undefined), s))} />
          </label>
        )}
        {(settings.search.provider === "brave" || settings.search.provider === "tavily") && (
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings.search.hasSecret ? `Saved: ${settings.search.secretHint} — type to replace` : "Not saved"}
              value={secrets.search ?? ""}
              onChange={(e) => setSecrets((s) => ({ ...s, search: e.target.value }))}
            />
          </label>
        )}
      </fieldset>

      <h2 id="setup-research" className="setup-section">Research</h2>
      <fieldset className="card">
        <label className="row">
          <input type="checkbox" checked={settings.research.reviewPlanBeforeResearch} onChange={(e) => update((s) => ((s.research.reviewPlanBeforeResearch = e.target.checked), s))} />
          <span>Review the validation plan before research (when off, “Research” generates a plan and continues automatically).</span>
        </label>
        <div className="grid-3">
          <NumberField label="Suggest recheck after (days)" value={settings.research.recheckAfterDays} min={1} max={365} onChange={(v) => update((s) => ((s.research.recheckAfterDays = v), s))} />
          <NumberField label="Max characters per source sent to the model" value={settings.research.maxSourceChars} min={1000} max={60000} onChange={(v) => update((s) => ((s.research.maxSourceChars = v), s))} />
        </div>
      </fieldset>

      <h2 id="setup-budgets" className="setup-section">Limits and budgets</h2>
      <fieldset className="card grid-4">
        <NumberField label="Concurrent jobs" value={settings.limits.concurrency} min={1} max={8} onChange={(v) => update((s) => ((s.limits.concurrency = v), s))} />
        <NumberField label="Searches per research run" value={settings.limits.maxSearchesPerRun} min={1} max={50} onChange={(v) => update((s) => ((s.limits.maxSearchesPerRun = v), s))} />
        <NumberField label="Sources fetched per run" value={settings.limits.maxSourcesPerRun} min={1} max={100} onChange={(v) => update((s) => ((s.limits.maxSourcesPerRun = v), s))} />
        <NumberField label="Model requests / minute" value={settings.limits.requestsPerMinute} min={1} max={600} onChange={(v) => update((s) => ((s.limits.requestsPerMinute = v), s))} />
        <NumberField label="Model timeout (seconds per request)" value={settings.limits.modelTimeoutSeconds} min={30} max={900} onChange={(v) => update((s) => ((s.limits.modelTimeoutSeconds = v), s))} />
      </fieldset>

      <div className="actions">
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>

      <h2 id="setup-templates" className="setup-section">Prompt templates</h2>
      <p className="muted">
        The built-in instructions for extraction and validation-plan generation. You can override the system instructions; the part that carries the
        transcript, prediction, and fixed dates is not overridable so content boundaries stay intact. Overrides are saved immediately and recorded with each result.
      </p>
      <TemplateEditor />
      </div>
    </div>
    </section>
  );
}

/** Six steps derived from records; Skip / Restart touch only localStorage. */
function GuidedStartSection() {
  const g = useGuidedStart();
  const nextId = g.next?.id;
  return (
    <div className="card">
      <div className="row space-between">
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>Optional and resumable. Each step is ticked from your actual records, so nothing here can get out of step with the app. Skip it, come back to it, or restart it — experienced use is never interrupted.</p>
        <span className="row tight">
          <button type="button" onClick={() => g.restart()}>Restart</button>
          {!g.dismissed && <button type="button" onClick={() => g.skip()}>Skip for now</button>}
        </span>
      </div>
      <div className="row" style={{ margin: "10px 0 4px" }}>
        <div className="progress-line" style={{ flex: 1, margin: 0 }}><i style={{ width: `${Math.round((g.done / g.total) * 100)}%` }} /></div>
        <span className="meta num">{g.done} of {g.total}{g.dismissed ? " · hidden from the sidebar" : ""}</span>
      </div>
      <div className="steps">
        {g.steps.map((s) => (
          <div key={s.id} className={`step${s.done ? " done" : ""}${s.id === nextId ? " next" : ""}`}>
            <Icon name={s.done ? "checkCircle" : "circle"} />
            <div className="body">
              <div><span className="n">Step {s.n}</span><strong>{s.title}</strong></div>
              <p><strong style={{ fontWeight: 500 }}>Why it matters:</strong> {s.why}</p>
              <p className="meta">Derived from state: {s.derived}</p>
            </div>
            <a className="btn" href={s.href} style={{ alignSelf: "center" }}>{s.done ? "Review" : s.action}</a>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6, flexWrap: "nowrap", alignItems: "flex-start" }}><Icon name="flask" size={14} className="muted" style={{ flex: "none", marginTop: 2 }} /><span className="muted small">Want to see the whole journey without importing anything? The <a href="#/learn?topic=example.worked">interactive worked example</a> uses labelled synthetic data and never touches your records.</span></div>
    </div>
  );
}

function TemplateEditor() {
  const [templates, setTemplates] = useState<PromptTemplateInfo[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  const load = () =>
    content.templates().then((t) => {
      setTemplates(t);
      setDrafts(Object.fromEntries(t.map((x) => [x.name, x.override?.body ?? x.builtInBody])));
    });
  useEffect(() => void load(), []);
  if (!templates) return null;

  return (
    <div>
      {templates.map((t) => (
        <details key={t.name} className="card">
          <summary>
            <strong>{t.name}</strong> — built-in {t.builtInVersion}
            {t.override ? <span className="chip cloud">override active (from {t.override.baseVersion})</span> : <span className="chip local">built-in</span>}
          </summary>
          <textarea rows={14} value={drafts[t.name] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [t.name]: e.target.value }))} />
          <div className="row">
            <button type="button" className="primary" onClick={async () => { await content.setTemplate(t.name, drafts[t.name]); setStatus(`${t.name} override saved.`); await load(); }}>Save override</button>
            <button type="button" onClick={async () => { await content.setTemplate(t.name, null); setStatus(`${t.name} reset to built-in.`); await load(); }} disabled={!t.override}>Reset to built-in</button>
          </div>
        </details>
      ))}
      {status && <div className="banner ok" role="status">{status}</div>}
    </div>
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => props.onChange(Math.max(props.min, Math.min(props.max, Number(e.target.value) || props.min)))}
      />
    </label>
  );
}
