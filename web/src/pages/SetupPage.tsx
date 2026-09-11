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
import type { AnalysisStage, AppSettings, LlmProviderId, ModelInfo, ProviderTestResult } from "@prediction-ledger/shared";
import { api, content, toPayload, type SecretUpdates } from "../api";
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
            <option value="openai-transcribe">OpenAI transcription (cloud)</option>
            <option value="youtube-captions">YouTube captions when available</option>
            <option value="import">Import transcript file only</option>
          </select>
          <small>Engines become active in Release 0.2; the setting is stored now.</small>
        </label>
        <label className="field">
          <span>Local Whisper model</span>
          <input value={settings.transcription.localModel} onChange={(e) => update((s) => ((s.transcription.localModel = e.target.value), s))} />
        </label>
        <label className="field">
          <span>Language</span>
          <input value={settings.transcription.language} placeholder="auto" onChange={(e) => update((s) => ((s.transcription.language = e.target.value), s))} />
        </label>
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
