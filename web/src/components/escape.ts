/**
 * Prediction Ledger — one Escape key, one order (2.1.1): popover → drawer → Learn panel → detail. Every closable
 * surface registers a handler with its priority; a single document listener closes the highest one that is open.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 */
import { useEffect, useState } from "react";

export const ESC_PRIORITY = { popover: 4, drawer: 3, learn: 2, detail: 1 } as const;
type Entry = { priority: number; close: () => void };
const stack: Entry[] = [];
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  const top = [...stack].sort((a, b) => b.priority - a.priority)[0];
  e.stopPropagation();
  top.close();
}

/** Register `close` for Esc while `active`; the highest-priority active surface closes first. */
export function useEscape(priority: number, active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { priority, close };
    stack.push(entry);
    if (!listening) { document.addEventListener("keydown", onKey); listening = true; }
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && listening) { document.removeEventListener("keydown", onKey); listening = false; }
    };
  }, [priority, active, close]);
}

/** Viewport breakpoints (the handoff's three): ≥ 1200 column · 880–1199 overlay · < 880 phone. */
export function useMediaQuery(query: string): boolean {
  const [state, setState] = useState(() => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!("matchMedia" in window)) return;
    const mq = window.matchMedia(query);
    const on = () => setState(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return state;
}
