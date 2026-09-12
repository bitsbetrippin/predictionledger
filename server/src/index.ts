/**
 * Prediction Ledger — server entry point.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Responsibilities:
 *  - Bind a Fastify server to 127.0.0.1 on PL_PORT (default 7317), walking forward a few
 *    ports if the default is occupied — never killing whatever holds it.
 *  - Serve the built dashboard (web/dist) and the /api routes from the same origin.
 *  - Start the durable job worker, and shut everything down cleanly on SIGINT/SIGTERM.
 *  - Print a single, unmistakable "ready" line with the URL (scripts/start.mjs watches for it).
 */

import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { BIND_HOST, PORT_SEARCH_RANGE, APP_VERSION, isDevMode, resolvePort } from "./config.js";
import { createContext } from "./context.js";
import { registerCsrfGuard } from "./security/csrf.js";
import { registerRoutes } from "./routes/index.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerYouTubeRoutes } from "./routes/youtube.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "..", "..", "web", "dist");

async function main(): Promise<void> {
  const ctx = createContext();

  const app = Fastify({
    logger: { level: process.env.PL_LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers['x-api-key']"] },
    bodyLimit: 25 * 1024 * 1024, // 25 MiB: transcript imports arrive as JSON text. The media upload route sets its own (8 GiB) limit.
  });

  // Hardening headers for the dashboard.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    // CSP is set here (not in index.html) so the Vite dev server's inline HMR preamble still works in dev mode.
    reply.header(
      "content-security-policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  let boundPort = resolvePort();
  registerCsrfGuard(app, () => [
    `http://${BIND_HOST}:${boundPort}`,
    `http://localhost:${boundPort}`,
    ...(isDevMode() ? ["http://localhost:5173", "http://127.0.0.1:5173"] : []),
  ]);
  registerRoutes(app, ctx);
  registerContentRoutes(app, ctx);
  registerResearchRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerYouTubeRoutes(app, ctx);

  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
    // SPA fallback: anything that is not /api and not a real file gets index.html.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () =>
      isDevMode()
        ? "Dev mode: open the Vite dev server URL printed by `npm run dev` instead."
        : "Dashboard build not found. Run `npm run build` (or `npm run setup`) first.",
    );
  }

  boundPort = await listenOnFreePort(app, boundPort);
  const origin = `http://${BIND_HOST}:${boundPort}`;

  ctx.jobs.start();

  // This exact line is what scripts/start.mjs waits for before opening the browser.
  console.log(`PREDICTION_LEDGER_READY ${origin}`);
  console.log(`Prediction Ledger v${APP_VERSION} — data directory: ${ctx.paths.root}`);

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await ctx.jobs.stop();
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Probe ports with a throwaway net.Server, then call Fastify's listen exactly once.
 * (Re-calling listen on a Fastify instance after a bind failure is not a supported path.)
 * Reports clearly; never touches other processes.
 */
async function listenOnFreePort(app: ReturnType<typeof Fastify>, start: number): Promise<number> {
  for (let port = start; port < start + PORT_SEARCH_RANGE; port++) {
    if (await isPortFree(port)) {
      await app.listen({ host: BIND_HOST, port });
      if (port !== start) console.warn(`[server] port ${start} was busy; using ${port} instead`);
      return port;
    }
  }
  throw new Error(
    `Ports ${start}-${start + PORT_SEARCH_RANGE - 1} are all in use. ` +
      `Set PL_PORT to a free port (e.g. PL_PORT=8080 npm start).`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: BIND_HOST, port }, () => probe.close(() => resolve(true)));
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
