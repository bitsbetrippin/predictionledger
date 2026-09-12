/**
 * Prediction Ledger — job handler: research.run
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Executes the plan's queries through the configured SearchProvider (budgeted, cached),
 * fetches the top distinct pages through the guarded SourceFetcher, asks the assessment-stage
 * model to extract evidence items from EACH PAGE'S TEXT, verifies every excerpt against the
 * stored page text (ADR-007), records dates / action stage / in-window, and finally enqueues
 * assessment.run for the same run. Search or fetch failures are recorded as coverage notes;
 * a run with no working searches fails without producing an assessment (RS-06).
 */

import type { QueryGroup, SearchResult, ValidationPlan } from "@prediction-ledger/shared";
import type { JobContext } from "../queue.js";
import type { AppContext } from "../../context.js";
import { SPORTS_RESEARCH_BUDGET } from "../../analysis/sports.js";
import { render } from "../../analysis/prompts.js";
import { evidenceOutputSchema, EVIDENCE_JSON_SCHEMA, type EvidenceOutput } from "../../analysis/schemas.js";
import { completeStructured, MalformedOutputError } from "../../analysis/structured.js";
import { resolveStageTarget } from "../../analysis/stages.js";
import { isIso } from "../../analysis/dates.js";
import { createSearchProvider, SearchError, type SearchProvider } from "../../research/search.js";
import { canonicalizeUrl, checkUrlSyntax, publisherFromHost } from "../../research/urlSafety.js";
import { verifyExcerpt } from "../../research/htmlExtract.js";
import { SECRET_NAMES } from "../../settings.js";

export function makeResearchHandler(ctx: AppContext) {
  return async (job: JobContext): Promise<Record<string, unknown>> => {
    const predictionId = String(job.payload.predictionId ?? "");
    const planId = job.payload.planId ? String(job.payload.planId) : undefined;
    const p = ctx.predictions.get(predictionId);
    if (!p) throw new Error(`Prediction ${predictionId} no longer exists.`);
    const plan = planId ? ctx.plans.get(planId) : ctx.plans.latest(predictionId);
    if (!plan) throw new Error("No validation plan exists for this prediction. Generate a plan first.");

    const settings = ctx.settings.getPersisted();
    if (settings.search.provider === "none") throw new Error("No web search provider is configured (Setup → Web search). Research stays pending until one is chosen.");
    const search = buildSearchProvider(ctx);
    if (!search) throw new Error(`Search provider "${settings.search.provider}" is not available.`);
    if (!settings.privacy.allowInternet && !search.isLocal) {
      throw new Error("Internet access is disabled in Setup → Privacy; online research stays pending. Enable internet or configure a local SearXNG instance.");
    }
    if (!settings.privacy.allowInternet) throw new Error("Internet access is disabled in Setup → Privacy; fetching web sources is not possible. Research stays pending.");

    const target = resolveStageTarget("assessment", ctx.settings, ctx.secrets);
    const template = ctx.templates.effective("evidence");
    const cutoff = new Date().toISOString().slice(0, 10);
    const run = ctx.research.createRun({ predictionId, planId: plan.id, searchProvider: settings.search.provider, cutoffDate: cutoff, jobId: job.id });

    try {
      // ---- 1. search (budgeted, cached, round-robin across groups so each group gets coverage) ----
      const queries: ResearchRun_Query[] = [];
      const coverage: string[] = [];
      const candidates = new Map<string, { result: SearchResult; group: QueryGroup; query: string; rank: number; runResultId: string }>();
      const groups: QueryGroup[] = ["neutral", "supporting", "disconfirming"];
      const perGroup = plan.plan.queries;
      // Sports picks (1.2): a score look-up needs a couple of searches, not the research budget.
      const sports = p.kind === "sports_pick";
      const budget = sports ? Math.min(settings.limits.maxSearchesPerRun, SPORTS_RESEARCH_BUDGET.searches) : settings.limits.maxSearchesPerRun;
      const order: { group: QueryGroup; query: string }[] = [];
      for (let i = 0; i < 10; i++) for (const g of groups) if (perGroup[g][i]) order.push({ group: g, query: perGroup[g][i] });
      let used = 0;
      let failures = 0;
      for (const q of order.slice(0, budget)) {
        if (job.signal.aborted) throw new Error("Cancelled");
        job.progress(Math.round((used / Math.max(1, Math.min(order.length, budget))) * 30), `Searching (${used + 1}/${Math.min(order.length, budget)}): ${q.query.slice(0, 60)}`);
        let results: SearchResult[] | undefined = ctx.research.cachedSearch(settings.search.provider, q.query);
        const cached = !!results;
        if (!results) {
          try {
            results = await search.search(q.query, { limit: 8, signal: job.signal });
            ctx.research.cacheSearch(settings.search.provider, q.query, results);
          } catch (err) {
            failures++;
            const msg = err instanceof SearchError ? err.message : (err as Error).message;
            queries.push({ group: q.group, query: q.query, resultCount: 0, error: msg });
            coverage.push(`Search failed (${q.group}): "${q.query}" — ${msg}`);
            used++;
            continue;
          }
        }
        used++;
        queries.push({ group: q.group, query: q.query, resultCount: results.length, cached });
        results.forEach((r, rank) => {
          const syn = checkUrlSyntax(r.url);
          if (!syn.ok) return;
          const key = canonicalizeUrl(r.url);
          const id = ctx.research.addRunResult(run.id, q.group, q.query, rank, r);
          if (!candidates.has(key)) candidates.set(key, { result: r, group: q.group, query: q.query, rank, runResultId: id });
        });
      }
      if (used > 0 && failures === used) {
        ctx.research.updateRun(run.id, { status: "failed", queries, coverageNotes: coverage, searchesUsed: used, error: "Every search failed; no evidence could be gathered.", finished: true });
        throw new Error(`Every search failed (${coverage[0] ?? "no detail"}). No verdict was produced — retry when the search provider is available.`);
      }
      if (order.length > budget) coverage.push(`Search budget: ${budget} of ${order.length} planned queries were run (Setup → Limits).`);

      // ---- 2. fetch top distinct sources (interleave groups for balance) ----
      const ordered = [...candidates.values()].sort((a, b) => a.rank - b.rank || groups.indexOf(a.group) - groups.indexOf(b.group));
      const toFetch = ordered.slice(0, sports ? Math.min(settings.limits.maxSourcesPerRun, SPORTS_RESEARCH_BUDGET.sources) : settings.limits.maxSourcesPerRun);
      if (ordered.length > toFetch.length) coverage.push(`Source budget: fetched ${toFetch.length} of ${ordered.length} distinct results (Setup → Limits).`);
      const fetched: { sourceId: string; text: string; title?: string; publishedAt?: string; url: string }[] = [];
      let failedFetches = 0;
      for (let i = 0; i < toFetch.length; i++) {
        if (job.signal.aborted) throw new Error("Cancelled");
        const c = toFetch[i];
        job.progress(30 + Math.round((i / toFetch.length) * 35), `Fetching source ${i + 1} of ${toFetch.length}`);
        const canonical = canonicalizeUrl(c.result.url);
        let source = ctx.research.freshSource(canonical);
        let text = source ? ctx.research.sourceText(source) : undefined;
        if (!source || text === undefined) {
          const out = await ctx.fetcher.fetch(c.result.url, job.signal);
          const host = new URL(out.finalUrl).hostname;
          source = ctx.research.upsertSource({
            url: out.finalUrl,
            canonicalUrl: canonicalizeUrl(out.page?.canonicalUrl && checkUrlSyntax(out.page.canonicalUrl).ok ? out.page.canonicalUrl : out.finalUrl),
            title: out.page?.title ?? c.result.title,
            publisher: out.page?.publisher ?? publisherFromHost(host),
            publishedAt: out.page?.publishedAt ?? (c.result.pageAge && isIso(c.result.pageAge.slice(0, 10)) ? c.result.pageAge.slice(0, 10) : undefined),
            fetchStatus: out.status,
            httpStatus: out.httpStatus,
            contentType: out.contentType,
            text: out.status === "ok" ? out.rawText : undefined,
            accessNotes: out.note,
          });
          text = out.status === "ok" ? out.rawText : undefined;
          if (out.status !== "ok") {
            failedFetches++;
            coverage.push(`Could not read ${c.result.url}: ${out.status}${out.note ? ` (${out.note})` : ""}`);
          }
        }
        ctx.research.linkRunResult(c.runResultId, source.id, text !== undefined);
        if (text !== undefined && text.trim().length > 0) fetched.push({ sourceId: source.id, text, title: source.title, publishedAt: source.publishedAt, url: source.url });
      }
      ctx.research.updateRun(run.id, { queries, coverageNotes: coverage, searchesUsed: used, sourcesFetched: fetched.length, sourcesFailed: failedFetches });

      // ---- 3. per-page evidence extraction, excerpts verified against the stored text ----
      let items = 0;
      let rejected = 0;
      const componentsText = p.components.map((c) => `- ${c.id} [${c.kind}] ${c.statement}`).join("\n");
      for (let i = 0; i < fetched.length; i++) {
        if (job.signal.aborted) throw new Error("Cancelled");
        const f = fetched[i];
        job.progress(65 + Math.round((i / Math.max(1, fetched.length)) * 30), `Reading source ${i + 1} of ${fetched.length}`);
        const source = ctx.research.getSource(f.sourceId)!;
        let out: EvidenceOutput;
        try {
          out = (
            await completeStructured<EvidenceOutput>({
              stage: "assessment",
              target,
              allowInternet: settings.privacy.allowInternet,
              rateLimiter: ctx.rateLimiter,
          timeoutMs: settings.limits.modelTimeoutSeconds * 1000,
              signal: job.signal,
              schemaName: "evidence_output",
              zodSchema: evidenceOutputSchema,
              jsonSchema: EVIDENCE_JSON_SCHEMA,
              maxTokens: 4096,
              messages: [
                { role: "system", content: template.system },
                {
                  role: "user",
                  content: render(template.user, {
                    proposition: plan.plan.proposition,
                    deadline: p.deadlineDate ?? "unknown",
                    components: componentsText,
                    sourceUrl: f.url,
                    publishedAt: f.publishedAt ?? "unknown",
                    retrievedAt: source.retrievedAt.slice(0, 10),
                    pageText: f.text.slice(0, settings.research.maxSourceChars),
                  }),
                },
              ],
            })
          ).data;
        } catch (err) {
          if (err instanceof MalformedOutputError) {
            coverage.push(`Evidence extraction produced unusable output for ${f.url}; page skipped.`);
            continue;
          }
          throw err;
        }
        for (const it of out.items) {
          const verbatim = verifyExcerpt(it.excerpt, f.text);
          if (!verbatim) {
            rejected++;
            continue;
          }
          // An item the model did not tie to a component still belongs to the only future claim when there is
          // exactly one (always true for sports picks) — otherwise guard G2 would ignore it.
          const soleClaim = p.components.filter((c) => c.kind === "future_claim").length === 1 ? p.components.find((c) => c.kind === "future_claim") : undefined;
          const component = p.components.find((c) => c.id === it.component_id) ?? soleClaim;
          const eventDate = it.event_date && isIso(it.event_date) ? it.event_date : undefined;
          const inWindow = eventDate && p.deadlineDate ? eventDate <= p.deadlineDate : eventDate && !p.deadlineDate ? true : undefined;
          ctx.research.addEvidence({
            runId: run.id,
            sourceId: f.sourceId,
            componentId: component?.id,
            stance: it.stance,
            excerpt: verbatim,
            fact: it.fact ?? undefined,
            eventDate,
            actionStage: it.action_stage ?? undefined,
            inWindow,
            qualityNotes: it.quality_notes ?? undefined,
            independent: !source.syndicatedOf,
          });
          items++;
        }
      }
      if (rejected > 0) coverage.push(`${rejected} evidence item(s) were discarded because their excerpts could not be found in the retrieved page text.`);
      if (fetched.length === 0) coverage.push("No source pages could be read; the assessment will be 'insufficient evidence' by rule.");

      ctx.research.updateRun(run.id, {
        status: "completed",
        coverageNotes: coverage,
        evidenceProvider: target.providerId,
        evidenceModel: target.model,
        evidenceTemplate: template.effectiveVersion,
        finished: true,
      });

      // ---- 4. hand off to assessment ----
      ctx.jobs.enqueue({ kind: "assessment.run", subjectType: "prediction", subjectId: predictionId, payload: { predictionId, runId: run.id }, dedupeKey: `assessment.run:${run.id}`, maxAttempts: 2 });
      job.progress(100, `${items} evidence item(s) from ${fetched.length} source(s); assessing…`);
      return { runId: run.id, searches: used, sources: fetched.length, evidence: items, rejected, coverage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = ctx.research.getRun(run.id);
      if (current?.status === "running") {
        ctx.research.updateRun(run.id, { status: job.signal.aborted ? "cancelled" : "failed", error: message, finished: true });
      }
      throw err;
    }
  };
}

type ResearchRun_Query = { group: QueryGroup; query: string; resultCount: number; error?: string; cached?: boolean };

function buildSearchProvider(ctx: AppContext): SearchProvider | undefined {
  const s = ctx.settings.getPersisted();
  const id = s.search.provider;
  const llm = id === "anthropic-native" ? "anthropic" : id === "openai-native" ? "openai" : undefined;
  return createSearchProvider(id, {
    apiKey: ctx.secrets.get(SECRET_NAMES.search),
    baseUrl: s.search.baseUrl,
    llmApiKey: llm ? ctx.secrets.get(SECRET_NAMES.llm(llm)) : undefined,
    llmModel: llm ? s.providers[llm].model : undefined,
  });
}

export type { ValidationPlan };
