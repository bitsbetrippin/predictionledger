/**
 * Prediction Ledger — Setup tab (providers, stage routing, transcription, search, limits, privacy).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Secrets typed here are sent once on Save and never read back; the server returns
 * only a masked hint. Leaving a key field blank keeps the stored key; the "Clear" button
 * sends an empty string, which deletes it.
 */
import { useEffect, useState } from "react";
import type { AnalysisStage, AppSettings, JobSummary, LlmProviderId, MediaStatus, ModelInfo, ProviderTestResult, ToolsStatus } from "@prediction-ledger/shared";
import { api, backups, content, media, pollJob, toPayload, youtube, type BackupInfo, type SecretUpdates } from "../api";
import type { PromptTemplateInfo } from "@prediction-ledger/shared";

const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  lmstudio: "LM Studio (local)",
};

const STAGE_LABELS: Record<AnalysisStage, string> = {
  extraction: "Prediction extraction",
  validationPlan: "Validation-plan generation",
  assessment: "Evidence assessment",
};

export function SetupPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [secrets, setSecrets] = useState<SecretUpdates>({});
  const [tests, setTests] = useState<Partial<Record<LlmProviderId, ProviderTestResult | "testing">>>({});
  const [models, setModels] = useState<Partial<Record<LlmProviderId, ModelInfo[]>>>({});
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaStatus, setMediaStatus] = useState<MediaStatus | null | "checking">(null);
  const checkMedia = () => { setMediaStatus("checking"); media.status().then(setMediaStatus).catch(() => setMediaStatus(null)); };
  const [backupList, setBackupList] = useState<BackupInfo[] | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const loadBackups = () => backups.list().then(setBackupList).catch(() => setBackupList(null));
  useEffect(() => { void loadBackups(); }, []);
  const backupNow = async () => {
    setBackupMsg(null);
    try {
      const b = await backups.create();
      setBackupMsg(`Backup written: ${b.file} (${(b.bytes / 1024).toFixed(0)} KB${b.hasSecretKey ? ", secret key copied alongside" : ""}).`);
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

  if (!settings) return <section className="page">Loading settings…</section>;

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
    <section className="page">
      <h1>Setup</h1>
      <p className="muted">
        Everything is stored on this computer in <code>{settings.dataDir}</code>. Cloud providers and online research send selected
        text (transcript excerpts, predictions, search queries) to those services — local options keep it on this machine.
      </p>

      {status && (
        <div className={`banner ${status.kind}`} role="status">
          {status.text}
        </div>
      )}

      <h2>Privacy</h2>
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

      <h2>Language-model providers</h2>
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

      <h2>Which model does what</h2>
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

      <h2>Transcription</h2>
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
          {mediaStatus && mediaStatus !== "checking" && (
            <span className="small">
              <span className={mediaStatus.ffmpeg.ok ? "result ok" : "result error"}>ffmpeg: {mediaStatus.ffmpeg.message}</span>
              {" · "}
              <span className={mediaStatus.engine.ok ? "result ok" : "result error"}>{mediaStatus.engine.id}: {mediaStatus.engine.message}</span>
            </span>
          )}
        </div>
        <small className="muted">Checks the saved settings — click Save first if you changed the engine.</small>
      </fieldset>

      <h2>YouTube</h2>
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

      <h2>Backups</h2>
      <fieldset className="card">
        <p className="muted">Writes a consistent copy of the database (videos, transcripts, predictions, plans, evidence, verdicts, settings) and the secret key into the data directory's <code>backups/</code> folder while the app runs. Media files are not included — they can be re-imported. To restore: stop Prediction Ledger, copy the <code>.db</code> over <code>prediction-ledger.db</code> (and the <code>.secret.key</code> over <code>secret.key</code>), start again.</p>
        <div className="row">
          <button type="button" onClick={backupNow}>Back up now</button>
          <small className="muted">Also: <code>npm run backup</code> from a terminal. Backups are also taken automatically before every database migration.</small>
        </div>
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

      <h2>Web search (for outcome research)</h2>
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

      <h2>Research</h2>
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

      <h2>Limits and budgets</h2>
      <fieldset className="card grid-4">
        <NumberField label="Concurrent jobs" value={settings.limits.concurrency} min={1} max={8} onChange={(v) => update((s) => ((s.limits.concurrency = v), s))} />
        <NumberField label="Searches per research run" value={settings.limits.maxSearchesPerRun} min={1} max={50} onChange={(v) => update((s) => ((s.limits.maxSearchesPerRun = v), s))} />
        <NumberField label="Sources fetched per run" value={settings.limits.maxSourcesPerRun} min={1} max={100} onChange={(v) => update((s) => ((s.limits.maxSourcesPerRun = v), s))} />
        <NumberField label="Model requests / minute" value={settings.limits.requestsPerMinute} min={1} max={600} onChange={(v) => update((s) => ((s.limits.requestsPerMinute = v), s))} />
      </fieldset>

      <div className="actions">
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>

      <h2>Prompt templates</h2>
      <p className="muted">
        The built-in instructions for extraction and validation-plan generation. You can override the system instructions; the part that carries the
        transcript, prediction, and fixed dates is not overridable so content boundaries stay intact. Overrides are saved immediately and recorded with each result.
      </p>
      <TemplateEditor />
    </section>
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
