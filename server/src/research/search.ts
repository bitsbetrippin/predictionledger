/**
 * Prediction Ledger — SearchProvider interface and adapters.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Adapters (all plain fetch; endpoints verified 2026-09-11 against vendor docs where public):
 *  - brave            GET https://api.search.brave.com/res/v1/web/search?q=…  header X-Subscription-Token
 *  - tavily           POST https://api.tavily.com/search  { api_key, query, max_results }
 *  - searxng          GET {baseUrl}/search?q=…&format=json   (self-hosted; local endpoint allowed)
 *  - anthropic-native Messages API with the web_search tool; results read from web_search_tool_result blocks
 *  - openai-native    Responses API with the web_search tool; results read from url_citation annotations
 * Every adapter returns plain SearchResult[] — URLs the app will fetch itself. Nothing an
 * adapter returns is treated as evidence until the page has been retrieved and stored.
 */

import type { SearchProviderId, SearchResult } from "@prediction-ledger/shared";

export interface SearchProvider {
  readonly id: SearchProviderId;
  readonly isLocal: boolean;
  search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export interface SearchCredentials {
  apiKey?: string;
  baseUrl?: string;
  /** For provider-native search: the LLM API key and model to drive the tool. */
  llmApiKey?: string;
  llmModel?: string;
}

export class SearchError extends Error {
  constructor(
    message: string,
    public readonly provider: SearchProviderId,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

const TIMEOUT_MS = 20_000;

type Factory = (id: SearchProviderId, creds: SearchCredentials) => SearchProvider | undefined;
let factory: Factory = defaultFactory;

export function createSearchProvider(id: SearchProviderId, creds: SearchCredentials): SearchProvider | undefined {
  return factory(id, creds);
}

/** Test seam: replace the factory (pipeline tests inject a fake search engine). */
export function setSearchProviderFactoryForTests(f: Factory | undefined): void {
  factory = f ?? defaultFactory;
}

function defaultFactory(id: SearchProviderId, creds: SearchCredentials): SearchProvider | undefined {
  switch (id) {
    case "brave":
      return new BraveSearch(creds);
    case "tavily":
      return new TavilySearch(creds);
    case "searxng":
      return new SearxngSearch(creds);
    case "anthropic-native":
      return new AnthropicNativeSearch(creds);
    case "openai-native":
      return new OpenAiNativeSearch(creds);
    default:
      return undefined;
  }
}

async function httpJson(url: string, init: RequestInit, provider: SearchProviderId, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 401 || res.status === 403) throw new SearchError("Search provider rejected the API key.", provider);
    if (res.status === 429) throw new SearchError("Search provider rate limit reached.", provider, true);
    if (!res.ok) throw new SearchError(`Search provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, provider, res.status >= 500);
    return await res.json();
  } catch (err) {
    if (err instanceof SearchError) throw err;
    throw new SearchError(`Could not reach search provider: ${(err as Error).message}`, provider, true);
  } finally {
    clearTimeout(t);
  }
}

class BraveSearch implements SearchProvider {
  readonly id = "brave" as const;
  readonly isLocal = false;
  constructor(private readonly creds: SearchCredentials) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    if (!this.creds.apiKey) throw new SearchError("Brave Search needs an API key (Setup → Web search).", this.id);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, opts.limit)}&text_decorations=false&result_filter=web`;
    const json = (await httpJson(url, { headers: { accept: "application/json", "x-subscription-token": this.creds.apiKey } }, this.id, opts.signal)) as {
      web?: { results?: { url: string; title?: string; description?: string; age?: string; page_age?: string }[] };
    };
    return (json.web?.results ?? []).slice(0, opts.limit).map((r) => ({ url: r.url, title: r.title, snippet: r.description, pageAge: r.page_age ?? r.age }));
  }
}

class TavilySearch implements SearchProvider {
  readonly id = "tavily" as const;
  readonly isLocal = false;
  constructor(private readonly creds: SearchCredentials) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    if (!this.creds.apiKey) throw new SearchError("Tavily needs an API key (Setup → Web search).", this.id);
    const json = (await httpJson(
      "https://api.tavily.com/search",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: this.creds.apiKey, query, max_results: Math.min(20, opts.limit), search_depth: "basic" }) },
      this.id,
      opts.signal,
    )) as { results?: { url: string; title?: string; content?: string; published_date?: string }[] };
    return (json.results ?? []).slice(0, opts.limit).map((r) => ({ url: r.url, title: r.title, snippet: r.content?.slice(0, 400), pageAge: r.published_date }));
  }
}

class SearxngSearch implements SearchProvider {
  readonly id = "searxng" as const;
  readonly isLocal = true;
  constructor(private readonly creds: SearchCredentials) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    const base = (this.creds.baseUrl ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new SearchError("SearXNG needs a base URL such as http://127.0.0.1:8080 (Setup → Web search).", this.id);
    const json = (await httpJson(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=en`, { headers: { accept: "application/json" } }, this.id, opts.signal)) as {
      results?: { url: string; title?: string; content?: string; publishedDate?: string }[];
    };
    return (json.results ?? []).slice(0, opts.limit).map((r) => ({ url: r.url, title: r.title, snippet: r.content, pageAge: r.publishedDate ?? undefined }));
  }
}

/** Anthropic web_search tool used purely as a search engine: we read the tool result blocks, not the model's prose. */
class AnthropicNativeSearch implements SearchProvider {
  readonly id = "anthropic-native" as const;
  readonly isLocal = false;
  constructor(private readonly creds: SearchCredentials) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    if (!this.creds.llmApiKey) throw new SearchError("Anthropic native search needs the Anthropic API key (Setup → Anthropic).", this.id);
    const json = (await httpJson(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.creds.llmApiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.creds.llmModel ?? "claude-sonnet-5",
          max_tokens: 1024,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
          messages: [{ role: "user", content: `Use the web_search tool exactly once with this query and then reply with the single word "done": ${query}` }],
        }),
      },
      this.id,
      opts.signal,
    )) as { content?: { type: string; content?: { type: string; url?: string; title?: string; page_age?: string }[] }[] };
    const results: SearchResult[] = [];
    for (const block of json.content ?? []) {
      if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
      for (const r of block.content) if (r.type === "web_search_result" && r.url) results.push({ url: r.url, title: r.title, pageAge: r.page_age });
    }
    return results.slice(0, opts.limit);
  }
}

/** OpenAI web_search tool via the Responses API: results come back as url_citation annotations. */
class OpenAiNativeSearch implements SearchProvider {
  readonly id = "openai-native" as const;
  readonly isLocal = false;
  constructor(private readonly creds: SearchCredentials) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    if (!this.creds.llmApiKey) throw new SearchError("OpenAI native search needs the OpenAI API key (Setup → OpenAI).", this.id);
    const json = (await httpJson(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.creds.llmApiKey}` },
        body: JSON.stringify({
          model: this.creds.llmModel ?? "gpt-5.6-terra",
          tools: [{ type: "web_search" }],
          tool_choice: "required",
          input: `Search the web for: ${query}\nList the most relevant results with their URLs.`,
        }),
      },
      this.id,
      opts.signal,
    )) as { output?: { type: string; content?: { type: string; annotations?: { type: string; url?: string; title?: string }[] }[] }[] };
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const item of json.output ?? []) {
      if (item.type !== "message") continue;
      for (const c of item.content ?? []) {
        for (const a of c.annotations ?? []) {
          if (a.type === "url_citation" && a.url && !seen.has(a.url)) {
            seen.add(a.url);
            results.push({ url: a.url, title: a.title });
          }
        }
      }
    }
    return results.slice(0, opts.limit);
  }
}
