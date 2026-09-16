/**
 * Prediction Ledger — trading route tests (1.10): the HTTP surface enforces the same gates as the service (A02, A03, A07).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Calls the protected routes directly through Fastify's inject — no browser assumptions. Fake adapter only.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Fastify from "fastify";
import { CSRF_HEADER, CSRF_VALUE } from "@prediction-ledger/shared";
import { FakeTradingAdapter } from "../providers/trading/fake.js";
import { setTradingAdapterForTests } from "../providers/trading/registry.js";
import { registerCsrfGuard } from "../security/csrf.js";
import { registerTradingRoutes } from "./trading.js";
import { registerExecutionRoutes } from "./execution.js";

after(() => { delete process.env.PL_DATA_DIR; setTradingAdapterForTests(undefined); });

const KEY = "cccccccc-1111-2222-3333-444444444444";
const SECRET = crypto.randomBytes(32).toString("base64");
const ORIGIN = "http://127.0.0.1:7317";
const csrf = { [CSRF_HEADER]: CSRF_VALUE, origin: ORIGIN };

test("trading routes: CSRF/origin enforced, strict bodies refuse host overrides, connect/test/disconnect round-trip, live controls answer 501", async () => {
  process.env.PL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pl-trading-routes-"));
  const fake = new FakeTradingAdapter().script(KEY, { secretKey: SECRET });
  setTradingAdapterForTests(fake);
  const { createContext } = await import("../context.js");
  const ctx = createContext();
  const app = Fastify();
  registerCsrfGuard(app, () => [ORIGIN]);
  registerTradingRoutes(app, ctx);
  registerExecutionRoutes(app, ctx);
  try {
    // A07: a mutation without the custom header, or from another origin, is refused before any handler runs.
    const noHeader = await app.inject({ method: "PUT", url: "/api/trading/connection", payload: { keyId: KEY, secretKey: SECRET } });
    assert.equal(noHeader.statusCode, 403);
    assert.equal(noHeader.json().error, "missing_csrf_header");
    const crossOrigin = await app.inject({ method: "PUT", url: "/api/trading/connection", headers: { [CSRF_HEADER]: CSRF_VALUE, origin: "http://evil.example" }, payload: { keyId: KEY, secretKey: SECRET } });
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(crossOrigin.json().error, "forbidden_origin");
    assert.equal(fake.calls.length, 0);

    // A07: a base URL, a mode or a budget smuggled into the connection body is rejected by the strict schema.
    for (const extra of [{ apiBaseUrl: "http://127.0.0.1:9" }, { mode: "auto_live" }, { budget: 1000 }, { host: "evil.example" }]) {
      const r = await app.inject({ method: "PUT", url: "/api/trading/connection", headers: csrf, payload: { keyId: KEY, secretKey: SECRET, ...extra } });
      assert.equal(r.statusCode, 400, JSON.stringify(extra));
      assert.equal(r.json().error, "invalid_request");
    }
    assert.equal(fake.calls.length, 0, "no adapter call for a rejected body");

    // A03 through HTTP: malformed secret → specific code, no network.
    const bad = await app.inject({ method: "POST", url: "/api/trading/connection/test", headers: csrf, payload: { keyId: KEY, secretKey: "nope" } });
    assert.equal(bad.statusCode, 200);
    assert.equal(bad.json().code, "malformed_secret");
    assert.equal(fake.calls.length, 0);
    const wrong = await app.inject({ method: "PUT", url: "/api/trading/connection", headers: csrf, payload: { keyId: KEY, secretKey: crypto.randomBytes(32).toString("base64") } });
    assert.equal(wrong.statusCode, 422);
    assert.equal(wrong.json().error, "connection_failed");
    assert.equal(wrong.json().test.code, "unauthorized");
    assert.ok(!wrong.body.includes(SECRET));

    // A02: test, then save; status shows the account and buying power; nothing is armed.
    const ok = await app.inject({ method: "POST", url: "/api/trading/connection/test", headers: csrf, payload: { keyId: KEY, secretKey: SECRET } });
    assert.equal(ok.json().ok, true);
    assert.equal(ok.json().orderCalls, 0);
    const saved = await app.inject({ method: "PUT", url: "/api/trading/connection", headers: csrf, payload: { keyId: KEY, secretKey: SECRET } });
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.json().binding.state, "connected");
    assert.ok(!saved.body.includes(SECRET));
    const status = await app.inject({ method: "GET", url: "/api/trading/status" });
    assert.equal(status.statusCode, 200);
    const st = status.json();
    assert.equal(st.binding.state, "connected");
    assert.equal(st.armed, false);
    assert.equal(st.submissionAvailable, false);
    assert.equal(st.policy.mode, "paper");
    assert.deepEqual(st.latestSync.balances[0].buyingPower, { value: "100.00", currency: "USD" });
    assert.ok(!status.body.includes(SECRET));
    const sync = await app.inject({ method: "POST", url: "/api/trading/sync", headers: csrf });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().ok, true);

    // ACC-05 / EXE-01: manual_live without the exact acknowledgement is refused with the live_authorization gate; auto_live stays gated in 1.13.
    const live = await app.inject({ method: "PUT", url: "/api/trading/policy", headers: csrf, payload: { mode: "manual_live" } });
    assert.equal(live.statusCode, 409);
    assert.equal(live.json().error, "gate_unmet");
    assert.ok(live.json().gates.some((g: { id: string }) => g.id === "live_authorization"), live.body);
    const auto = await app.inject({ method: "PUT", url: "/api/trading/policy", headers: csrf, payload: { mode: "auto_live", acknowledge: "I understand this places real orders with real money" } });
    assert.equal(auto.statusCode, 409);
    assert.ok(auto.json().gates.some((g: { id: string }) => g.id === "strategy_qualified"));
    const paper = await app.inject({ method: "PUT", url: "/api/trading/policy", headers: csrf, payload: { mode: "disabled" } });
    assert.equal(paper.json().policy.mode, "disabled");
    // 1.13: direct order placement does not exist (preview → confirm only); automation controls still answer 501.
    const direct = await app.inject({ method: "POST", url: "/api/trading/orders", headers: csrf, payload: {} });
    assert.equal(direct.statusCode, 409);
    assert.equal(direct.json().error, "preview_required");
    const previewOff = await app.inject({ method: "POST", url: "/api/trading/decisions/00000000-0000-4000-8000-000000000000/preview", headers: csrf, payload: {} });
    assert.equal(previewOff.statusCode, 404, "unknown decision → 404 (the mode gate is checked on the decision, see execution tests)");
    for (const url of ["/api/trading/arm", "/api/trading/emergency-stop"]) {
      const r = await app.inject({ method: "POST", url, headers: csrf, payload: {} });
      assert.equal(r.statusCode, 501, url);
      assert.equal(r.json().error, "feature_disabled");
    }
    const badMode = await app.inject({ method: "PUT", url: "/api/trading/policy", headers: csrf, payload: { mode: "yolo" } });
    assert.equal(badMode.statusCode, 400);

    // Audit is readable and secret-free; disconnect works and reports that it is not a venue revocation.
    const audit = await app.inject({ method: "GET", url: "/api/trading/audit?limit=20" });
    assert.ok(audit.json().length >= 2);
    assert.ok(!audit.body.includes(SECRET));
    const gone = await app.inject({ method: "DELETE", url: "/api/trading/connection", headers: csrf });
    assert.equal(gone.statusCode, 200);
    assert.equal(gone.json().disconnected, true);
    assert.match(gone.json().note, /not a venue revocation/);
    assert.equal(gone.json().status.binding, undefined);
    const again = await app.inject({ method: "DELETE", url: "/api/trading/connection", headers: csrf });
    assert.equal(again.statusCode, 404);
    assert.equal(fake.orderCalls, 0);
  } finally {
    ctx.db.close();
  }
});
