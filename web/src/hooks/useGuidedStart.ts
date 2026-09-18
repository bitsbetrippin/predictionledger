/**
 * Prediction Ledger — Guided start (2.1): six steps derived from existing records only. Nothing is ticked by hand and
 * no server state exists for it; the only client-side state is localStorage['pl.guidedStart'] = { dismissedAt?, restartedAt? }.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useCallback, useEffect, useState } from "react";
import { api, content, marketsApi } from "../api";
import { GUIDED_START_KEY, deriveGuidedSteps, type GuidedStartInput, type GuidedStartState } from "./guidedSteps";

export { GUIDED_START_KEY, deriveGuidedSteps, type GuidedStartInput, type GuidedStartState, type GuidedStep } from "./guidedSteps";

export function readGuidedState(): GuidedStartState {
  try {
    const raw = window.localStorage.getItem(GUIDED_START_KEY);
    return raw ? (JSON.parse(raw) as GuidedStartState) : {};
  } catch { return {}; }
}
function writeGuidedState(s: GuidedStartState) {
  try { window.localStorage.setItem(GUIDED_START_KEY, JSON.stringify(s)); } catch { /* storage unavailable: the pill just stays */ }
}

// A tiny shared store so the sidebar pill, Setup and the Library empty state share one fetch.
interface Store { input: GuidedStartInput; loadedAt: number; loading: boolean; error?: string; state: GuidedStartState }
const store: Store = { input: {}, loadedAt: 0, loading: false, state: {} };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const TTL_MS = 20_000;

async function refreshStore(force = false): Promise<void> {
  if (store.loading) return;
  if (!force && Date.now() - store.loadedAt < TTL_MS) return;
  store.loading = true; store.error = undefined; notify();
  try {
    const [settings, videos, predictions, acceptedLinks] = await Promise.all([
      api.getSettings().catch(() => null),
      content.listVideos().catch(() => null),
      content.listPredictions({}).catch(() => null),
      marketsApi.listLinks("accepted").catch(() => null),
    ]);
    store.input = { settings, videos, predictions, acceptedLinks };
    store.loadedAt = Date.now();
  } catch (e) {
    store.error = (e as Error).message;
  } finally {
    store.loading = false; notify();
  }
}

export function useGuidedStart(opts: { load?: boolean } = {}) {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    store.state = readGuidedState();
    if (opts.load !== false) void refreshStore();
    return () => { listeners.delete(l); };
  }, [opts.load]);

  const steps = deriveGuidedSteps(store.input);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  const skip = useCallback(() => { store.state = { ...store.state, dismissedAt: new Date().toISOString() }; writeGuidedState(store.state); notify(); }, []);
  const restart = useCallback(() => { store.state = { restartedAt: new Date().toISOString() }; writeGuidedState(store.state); void refreshStore(true); notify(); }, []);
  const refresh = useCallback(() => refreshStore(true), []);
  return { steps, done, total: steps.length, next, dismissed: !!store.state.dismissedAt, state: store.state, loading: store.loading && store.loadedAt === 0, loaded: store.loadedAt > 0, error: store.error, skip, restart, refresh };
}
