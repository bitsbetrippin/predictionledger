/**
 * Prediction Ledger — Guided start derivation (2.1): every tick comes from a record; nothing is ticked by hand.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDED_START_KEY, deriveGuidedSteps, type GuidedStartInput } from "./guidedSteps";

const settings = (o: Partial<{ anthropic: boolean; anthropicKey: boolean; lmstudio: boolean; search: string; searchKey: boolean; internet: boolean }> = {}): GuidedStartInput["settings"] => ({
  providers: {
    anthropic: { enabled: o.anthropic ?? false, model: "m", hasSecret: o.anthropicKey ?? false },
    openai: { enabled: false, model: "m", hasSecret: false },
    lmstudio: { enabled: o.lmstudio ?? false, model: "m", hasSecret: false, baseUrl: "http://127.0.0.1:1234/v1" },
  } as unknown as NonNullable<GuidedStartInput["settings"]>["providers"],
  search: { provider: (o.search ?? "none") as "none", hasSecret: o.searchKey ?? false } as NonNullable<GuidedStartInput["settings"]>["search"],
  privacy: { allowInternet: o.internet ?? true },
});

test("nothing loaded → six steps, none done, honest 'not loaded' sentences", () => {
  const steps = deriveGuidedSteps({});
  assert.equal(steps.length, 6);
  assert.equal(steps.filter((s) => s.done).length, 0);
  assert.equal(steps[0].derived, "settings not loaded");
  assert.equal(steps[2].derived, "library not loaded");
  assert.equal(steps[5].optional, true);
  assert.equal(GUIDED_START_KEY, "pl.guidedStart");
});

test("a cloud provider counts only with a saved key; LM Studio counts when enabled", () => {
  assert.equal(deriveGuidedSteps({ settings: settings({ anthropic: true }) })[0].done, false);
  assert.match(deriveGuidedSteps({ settings: settings({ anthropic: true }) })[0].derived, /no key saved/);
  assert.equal(deriveGuidedSteps({ settings: settings({ anthropic: true, anthropicKey: true }) })[0].done, true);
  assert.equal(deriveGuidedSteps({ settings: settings({ lmstudio: true, internet: false }) })[0].done, true);
  assert.match(deriveGuidedSteps({ settings: settings({ lmstudio: true, internet: false }) })[0].derived, /internet off/);
});

test("search: none → pending; brave/tavily need a key; native providers do not", () => {
  assert.equal(deriveGuidedSteps({ settings: settings() })[1].done, false);
  assert.equal(deriveGuidedSteps({ settings: settings({ search: "brave" }) })[1].done, false);
  assert.equal(deriveGuidedSteps({ settings: settings({ search: "brave", searchKey: true }) })[1].done, true);
  assert.equal(deriveGuidedSteps({ settings: settings({ search: "anthropic-native" }) })[1].done, true);
  assert.equal(deriveGuidedSteps({ settings: settings({ search: "searxng" }) })[1].done, true);
});

test("import, extract, research and link are derived from records, never from clicks", () => {
  const base: GuidedStartInput = { settings: settings(), videos: [], predictions: [], acceptedLinks: [] };
  let s = deriveGuidedSteps(base);
  assert.deepEqual(s.slice(2).map((x) => x.done), [false, false, false, false]);
  s = deriveGuidedSteps({ ...base, videos: [{ id: "v1", status: "ready" }] });
  assert.equal(s[2].done, true);
  assert.equal(s[2].derived, "1 video in the library");
  s = deriveGuidedSteps({ ...base, videos: [{ id: "v1", status: "ready" }], predictions: [{ id: "p1" }, { id: "p2" }] });
  assert.equal(s[3].done, true);
  assert.equal(s[4].done, false);
  s = deriveGuidedSteps({ ...base, predictions: [{ id: "p1", result: { assessmentId: "a", version: 1, evidenceAssessment: "supported", timeStatus: "reached", explanation: "", confidence: "high", sourceCount: 1, researchedAt: "2026-09-11" } }] });
  assert.equal(s[4].done, true);
  assert.equal(s[4].derived, "1 assessed with a two-part verdict");
  s = deriveGuidedSteps({ ...base, acceptedLinks: [{ id: "l1", status: "accepted" }, { id: "l2", status: "proposed" }] });
  assert.equal(s[5].done, true);
  assert.equal(s[5].derived, "1 accepted market link");
});
