/**
 * Prediction Ledger — provider adapter request-shape tests with a stubbed global fetch (no network).
 * Covers the first-run finding that current Claude models reject `temperature` and that OpenAI
 * reasoning models reject `temperature` / want `max_completion_tokens`.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { ProviderHttpError } from "./types.js";

type Call = { url: string; body: Record<string, unknown> };

function stubFetch(responder: (call: Call, n: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} };
    calls.push(call);
    const r = responder(call, calls.length);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("Anthropic adapter: never sends temperature; forced tool use returns the tool input as JSON text", async () => {
  const stub = stubFetch(() => ({ status: 200, body: { model: "claude-x", content: [{ type: "tool_use", input: { predictions: [] } }], usage: { input_tokens: 10, output_tokens: 5 } } }));
  try {
    const p = new AnthropicProvider();
    const out = await p.complete({ apiKey: "sk-test" }, { model: "claude-x", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], temperature: 0.1, jsonSchema: { name: "x", schema: { type: "object" } } });
    assert.equal(stub.calls.length, 1);
    assert.ok(!("temperature" in stub.calls[0].body), "temperature must not be sent to the Messages API");
    assert.equal(stub.calls[0].body.system, "sys");
    assert.deepEqual((stub.calls[0].body.tool_choice as { name: string }).name, "x");
    assert.equal(out.text, JSON.stringify({ predictions: [] }));
    assert.equal(out.usage?.inputTokens, 10);
  } finally {
    stub.restore();
  }
});

test("OpenAI-compatible adapter: adapts to reasoning-model 400s (drop temperature, rename max_tokens), then succeeds", async () => {
  const stub = stubFetch((call, n) => {
    if ("temperature" in call.body) return { status: 400, body: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } };
    if ("max_tokens" in call.body) return { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } };
    return { status: 200, body: { model: "gpt-x", choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
  });
  try {
    const p = new OpenAiCompatibleProvider({ id: "openai", displayName: "OpenAI", isLocal: false, defaultBaseUrl: "https://example.invalid/v1", requiresApiKey: true });
    const out = await p.complete({ apiKey: "k" }, { model: "gpt-x", messages: [{ role: "user", content: "hi" }], temperature: 0.1, maxTokens: 100 });
    assert.equal(stub.calls.length, 3, "two adaptations, then success");
    assert.ok(!("temperature" in stub.calls[2].body));
    assert.equal(stub.calls[2].body.max_completion_tokens, 100);
    assert.ok(!("max_tokens" in stub.calls[2].body));
    assert.equal(out.text, "{\"ok\":true}");
  } finally {
    stub.restore();
  }
});

test("OpenAI-compatible adapter: classic models keep temperature; unrelated 400s surface as ProviderHttpError", async () => {
  const stub = stubFetch(() => ({ status: 200, body: { choices: [{ message: { content: "x" } }] } }));
  try {
    const p = new OpenAiCompatibleProvider({ id: "lmstudio", displayName: "LM Studio (local)", isLocal: true, defaultBaseUrl: "http://127.0.0.1:1234/v1", requiresApiKey: false });
    await p.complete({}, { model: "local", messages: [{ role: "user", content: "hi" }], temperature: 0.1 });
    assert.equal(stub.calls[0].body.temperature, 0.1, "local models get the requested temperature");
  } finally {
    stub.restore();
  }
  const stub2 = stubFetch(() => ({ status: 400, body: { error: { message: "context length exceeded" } } }));
  try {
    const p = new OpenAiCompatibleProvider({ id: "openai", displayName: "OpenAI", isLocal: false, defaultBaseUrl: "https://example.invalid/v1", requiresApiKey: true });
    await assert.rejects(p.complete({ apiKey: "k" }, { model: "gpt-x", messages: [{ role: "user", content: "hi" }], temperature: 0.1 }), (e: Error) => e instanceof ProviderHttpError && e.status === 400 && /context length/.test(e.message));
    assert.equal(stub2.calls.length, 1, "no blind retries on unrelated 400s");
  } finally {
    stub2.restore();
  }
});
