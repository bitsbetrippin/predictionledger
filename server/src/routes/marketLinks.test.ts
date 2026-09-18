/**
 * Prediction Ledger — 2.1: GET /api/market-links (read-only list, optional status filter) feeds the Guided start's
 * "linked" step. It changes no record and refuses an unknown status.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import { registerCsrfGuard } from "../security/csrf.js";
import { registerMarketRoutes } from "./markets.js";
import type { AppContext } from "../context.js";

let ctx: AppContext;
let app: ReturnType<typeof Fastify>;

before(async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-links-"));
  const { createContext } = await import("../context.js");
  ctx = createContext();
  app = Fastify();
  registerCsrfGuard(app, () => ["http://127.0.0.1:7317"]);
  registerMarketRoutes(app, ctx);
});
after(() => { ctx?.db.close(); delete process.env.PL_DATA_DIR; });

test("GET /api/market-links lists links by status and validates the filter", async () => {
  const empty = await app.inject({ method: "GET", url: "/api/market-links?status=accepted" });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), []);

  const { video } = ctx.videos.importTranscript({ title: "Calls", content: "1\n00:00:00,000 --> 00:00:05,000\nThe Fed will cut twice next year.\n", format: "srt", publishedAt: "2025-10-14" });
  const p = ctx.predictions.create({ videoId: video.id, kind: "general", quoteExact: "The Fed will cut twice next year.", normalizedStatement: "The Fed cuts at least twice by end of 2026", entities: ["Federal Reserve"], conditions: [], thresholds: [], madeOnDate: "2025-10-14", madeOnBasis: "publication", deadlineDate: "2026-12-31", deadlineBasis: "rule:relative", ambiguities: [], occurrences: [], components: [{ kind: "future_claim", statement: "two cuts" }] });
  const m = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "fed-2026", slug: "fed-two-cuts-2026", url: "https://polymarket.com/event/fed", question: "Two Fed cuts in 2026?", outcomes: [{ label: "Yes", tokenId: "y" }, { label: "No", tokenId: "n" }], active: true, closed: false, retrievedAt: "" });
  const proposed = ctx.markets.propose({ predictionId: p.id, marketId: m.id, side: "Yes", score: 0.8, relation: "exact", matchedBy: "rule:text" });
  const m2 = ctx.markets.upsertFromSummary({ provider: "polymarket", id: "fed-2026-b", slug: "fed-cut-b", url: "https://polymarket.com/event/fed-b", question: "Fed cut by June?", outcomes: [{ label: "Yes", tokenId: "y2" }, { label: "No", tokenId: "n2" }], active: true, closed: false, retrievedAt: "" });
  const accepted = ctx.markets.propose({ predictionId: p.id, marketId: m2.id, side: "Yes", score: 0.9, relation: "exact", matchedBy: "user", status: "accepted" });

  const all = await app.inject({ method: "GET", url: "/api/market-links" });
  assert.equal(all.statusCode, 200);
  assert.deepEqual(all.json().map((l: { id: string }) => l.id).sort(), [proposed.id, accepted.id].sort());

  const acc = await app.inject({ method: "GET", url: "/api/market-links?status=accepted&limit=10" });
  assert.deepEqual(acc.json().map((l: { id: string; status: string }) => [l.id, l.status]), [[accepted.id, "accepted"]]);

  const bad = await app.inject({ method: "GET", url: "/api/market-links?status=weird" });
  assert.equal(bad.statusCode, 400);

  // Read-only: nothing changed.
  assert.equal(ctx.markets.getLink(proposed.id)!.status, "proposed");
  assert.equal(ctx.markets.allLinks().length, 2);
});
