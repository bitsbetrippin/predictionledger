/**
 * Prediction Ledger — Vite configuration for the dashboard.
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Dev mode: Vite serves the app on 127.0.0.1:5173 and proxies /api to the Node server.
 * Normal mode: `vite build` emits static files to web/dist, served by the Node server itself.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PL_PORT ?? 7317}`, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
