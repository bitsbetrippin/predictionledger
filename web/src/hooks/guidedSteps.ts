/**
 * Prediction Ledger — Guided start derivation (2.1): six steps computed from existing records only. Pure and
 * unit-tested; the React hook in useGuidedStart.ts fetches the inputs and adds the localStorage skip/restart state.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import type { AppSettings, PredictionMarketLink, VideoSummary } from "@prediction-ledger/shared";
import type { PredictionRow } from "../api";

export const GUIDED_START_KEY = "pl.guidedStart";

export interface GuidedStartInput {
  settings?: Pick<AppSettings, "providers" | "search" | "privacy"> | null;
  videos?: Pick<VideoSummary, "id" | "status">[] | null;
  predictions?: Pick<PredictionRow, "id" | "result">[] | null;
  acceptedLinks?: Pick<PredictionMarketLink, "id" | "status">[] | null;
}

export interface GuidedStep {
  n: number;
  id: "provider" | "search" | "import" | "extract" | "research" | "link";
  title: string;
  why: string;
  /** Derived from state — the plain sentence shown under the step. */
  derived: string;
  done: boolean;
  optional?: boolean;
  /** Where the step is done. */
  href: string;
  action: string;
}

export interface GuidedStartState { dismissedAt?: string; restartedAt?: string }

/** Pure derivation (unit-tested): every tick comes from a record, never from a click. */
export function deriveGuidedSteps(input: GuidedStartInput): GuidedStep[] {
  const s = input.settings ?? undefined;
  const providers = s ? (Object.entries(s.providers) as [string, { enabled: boolean; hasSecret?: boolean }][]) : [];
  const enabled = providers.filter(([, p]) => p.enabled);
  const usable = enabled.filter(([id, p]) => id === "lmstudio" || p.hasSecret);
  const providerDone = usable.length > 0;
  const providerDerived = !s ? "settings not loaded" : usable.length ? `${usable.map(([id]) => PROVIDER_NAME[id] ?? id).join(", ")} connected · privacy: internet ${s.privacy.allowInternet ? "on" : "off"}` : enabled.length ? `${enabled.map(([id]) => PROVIDER_NAME[id] ?? id).join(", ")} enabled but no key saved · privacy: internet ${s.privacy.allowInternet ? "on" : "off"}` : `no provider enabled · privacy: internet ${s.privacy.allowInternet ? "on" : "off"}`;

  const searchProvider = s?.search.provider ?? "none";
  const needsKey = searchProvider === "brave" || searchProvider === "tavily";
  const searchDone = searchProvider !== "none" && (!needsKey || !!s?.search.hasSecret);
  const searchDerived = !s ? "settings not loaded" : searchProvider === "none" ? "no search provider (research stays pending)" : searchDone ? `${SEARCH_NAME[searchProvider] ?? searchProvider} configured` : `${SEARCH_NAME[searchProvider] ?? searchProvider} selected — key not saved`;

  const videos = input.videos ?? [];
  const preds = input.predictions ?? [];
  const assessed = preds.filter((p) => !!p.result).length;
  const links = (input.acceptedLinks ?? []).filter((l) => l.status === "accepted").length;

  return [
    { n: 1, id: "provider", title: "Choose privacy and a model provider", why: "Nothing runs without a provider; the privacy switch decides what may leave your machine.", derived: providerDerived, done: providerDone, href: "#/setup?section=providers", action: "Setup" },
    { n: 2, id: "search", title: "Pick a web search provider", why: "Only app-executed searches count as evidence.", derived: searchDerived, done: searchDone, href: "#/setup?section=search", action: "Setup" },
    { n: 3, id: "import", title: "Import your first video or transcript", why: "Everything downstream hangs off a timestamped transcript.", derived: input.videos === undefined || input.videos === null ? "library not loaded" : videos.length ? `${videos.length} video${videos.length === 1 ? "" : "s"} in the library` : "no videos yet", done: videos.length > 0, href: "#/library", action: "Library" },
    { n: 4, id: "extract", title: "Extract predictions", why: "Exact quotes with timestamps — the immutable record.", derived: input.predictions === undefined || input.predictions === null ? "predictions not loaded" : preds.length ? `${preds.length} prediction${preds.length === 1 ? "" : "s"} extracted` : "no predictions yet", done: preds.length > 0, href: "#/predictions", action: "Predictions" },
    { n: 5, id: "research", title: "Research one prediction", why: "Plan first, then evidence, then a two-part verdict.", derived: assessed ? `${assessed} assessed with a two-part verdict` : "none researched yet", done: assessed > 0, href: "#/predictions", action: "Predictions" },
    { n: 6, id: "link", title: "Link a claim to a market (optional)", why: "Signals and paper trading start from an accepted link.", derived: links ? `${links} accepted market link${links === 1 ? "" : "s"}` : "Optional — Signals and Paper stay empty without a link", done: links > 0, optional: true, href: "#/markets", action: "Markets" },
  ];
}

const PROVIDER_NAME: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", lmstudio: "LM Studio" };
const SEARCH_NAME: Record<string, string> = { brave: "Brave", tavily: "Tavily", searxng: "SearXNG", "anthropic-native": "Anthropic built-in search", "openai-native": "OpenAI built-in search" };

