/**
 * Prediction Ledger — browser request protections for a loopback service.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * "localhost" is not a security boundary: any web page open in the user's browser can
 * fire requests at http://127.0.0.1:7317. Two cheap defences make that harmless:
 *
 *  1. Every mutating request (POST/PUT/PATCH/DELETE) must carry the custom header
 *     `x-prediction-ledger: 1`. Cross-origin pages cannot add custom headers without
 *     a CORS preflight, and this server never answers preflights with permission.
 *  2. If an Origin header is present it must match our own origin exactly.
 *
 * CORS is intentionally NOT enabled. The dashboard is served from the same origin.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CSRF_HEADER, CSRF_VALUE } from "@prediction-ledger/shared";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * `allowedOrigins` is a function because the final port is only known after listen()
 * (the server walks forward if the default port is busy) and Fastify hooks must be
 * registered before that.
 */
export function registerCsrfGuard(app: FastifyInstance, allowedOrigins: () => string[]): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;

    const origin = req.headers.origin;
    if (origin && !allowedOrigins().includes(origin)) {
      reply.code(403).send({ error: "forbidden_origin", message: "Cross-origin requests are not allowed." });
      return reply;
    }

    if (MUTATING.has(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      reply.code(403).send({
        error: "missing_csrf_header",
        message: `Mutating requests must include the ${CSRF_HEADER} header.`,
      });
      return reply;
    }
    return;
  });
}
