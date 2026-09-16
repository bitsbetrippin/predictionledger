/**
 * Prediction Ledger — matching a prediction to a prediction market (1.6).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Two deterministic scorers, one per prediction kind, plus the queries that feed the venue search.
 *   - Sports picks: both team nicknames in the event title/question, the game date against the
 *     market end date, and the pick type against the market's wording → an "exact" match that can be
 *     auto-accepted. The implied side is the picked team (or Yes/No, Over/Under).
 *   - General predictions: content-token overlap between the normalized statement + entities and the
 *     market question + event title, deadline proximity, and shared numbers → a 0–1 score that is
 *     only ever a *proposal*; a model may then label the relation (same / narrower / broader /
 *     different) and the user accepts or rejects.
 * Nothing here decides truth — it only says "this claim looks like a bet on that market's side".
 */

import type { Prediction, SportsPick } from "@prediction-ledger/shared";
import type { MarketSummary } from "../providers/markets/types.js";
import { sameTeamName, teamNick } from "./sports.js";

const STOP = new Set("a an the of to in on at for by with and or but if then than that this these those is are was were be been being will would could should may might can shall must do does did have has had not no yes it its it's they them their there here he she his her we our you your i my me us from as into over under up down out about after before between during within without against across per vs versus v".split(" "));

/** Lower-case content tokens (words ≥ 3 chars, numbers kept), de-duplicated, light stemming. */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9$%.\s-]/g, " ").split(/\s+/)) {
    let t = raw.replace(/^[.$-]+|[.$-]+$/g, "");
    if (!t || STOP.has(t)) continue;
    if (/^[a-z]+$/.test(t)) {
      if (t.length < 3) continue;
      t = t.replace(/(ies)$/, "y").replace(/(sses|xes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
    }
    seen.add(t);
  }
  return [...seen];
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string): number | undefined => {
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / DAY : undefined;
};

export interface MatchScore {
  score: number;
  side?: string;
  relation?: "exact" | "same" | "narrower" | "broader" | "different";
  rationale: string;
  matchedBy: "rule:sports" | "rule:text";
}

/** Venue search queries for a prediction. */
export function buildMarketQueries(p: Prediction): string[] {
  if (p.kind === "sports_pick" && p.sportsPick) {
    const [a, b] = p.sportsPick.teams;
    return [`${teamNick(a)} ${teamNick(b)}`, `${a} vs ${b}`];
  }
  const entities = p.entities.slice(0, 4).join(" ");
  const content = tokenize(p.normalizedStatement).filter((t) => !/^\d/.test(t)).slice(0, 6).join(" ");
  const q1 = `${entities} ${content}`.trim();
  const q2 = p.normalizedStatement.slice(0, 120);
  return [...new Set([q1, q2].filter((q) => q.length >= 3))];
}

const SPREAD_RE = /(\bspread\b|\bhandicap\b|(?:^|\s)[-+]\d+(?:\.5)?\b)/i;
const TOTAL_RE = /\b(total|o\/u|over\/under|over \d|under \d)\b/i;

function pickTypeOfMarket(m: MarketSummary): "moneyline" | "spread" | "total" | "other" {
  // The question is decisive ("Bills -3.5", "Over 47.5"); the event title only when the question is bare.
  if (TOTAL_RE.test(m.question)) return "total";
  if (SPREAD_RE.test(m.question)) return "spread";
  if (TOTAL_RE.test(m.event?.title ?? "") && !/\bvs\.?\b/i.test(m.question)) return "total";
  const labels = m.outcomes.map((o) => o.label.toLowerCase());
  if (labels.some((l) => l === "yes") || m.outcomes.length === 2) return "moneyline";
  return "other";
}

/** Sports pick vs a market: exact when teams, date and pick type all line up. */
export function scoreSportsMarket(pick: SportsPick, m: MarketSummary, gameDate?: string): MatchScore {
  const haystack = `${m.event?.title ?? ""} ${m.question}`;
  const [a, b] = pick.teams;
  const teamsIn = [a, b].filter((t) => new RegExp(`\\b${teamNick(t)}\\b`, "i").test(haystack) || haystack.toLowerCase().includes(t.toLowerCase()));
  const reasons: string[] = [];
  let score = 0;
  if (teamsIn.length === 2) { score += 0.5; reasons.push("both teams named"); }
  else if (teamsIn.length === 1) { score += 0.15; reasons.push(`only ${teamsIn[0]} named`); }
  else return { score: 0, rationale: "neither team named", matchedBy: "rule:sports" };
  const date = gameDate ?? pick.eventDate;
  if (date && m.endDate) {
    const d = daysBetween(date, m.endDate);
    if (d !== undefined && d <= 2) { score += 0.3; reasons.push("game date matches market end"); }
    else if (d !== undefined && d > 14) { score -= 0.3; reasons.push(`market ends ${Math.round(d)} days from the game`); }
  }
  const type = pickTypeOfMarket(m);
  if (type === pick.pick.type) { score += 0.2; reasons.push(`${type} market`); }
  else if (type !== "other") { score -= 0.2; reasons.push(`${type} market, pick is ${pick.pick.type}`); }
  // Implied side.
  let side: string | undefined;
  if (pick.pick.type === "total") side = m.outcomes.find((o) => o.label.toLowerCase().startsWith(pick.pick.side ?? "—"))?.label;
  else if (pick.pick.team) {
    side = m.outcomes.find((o) => sameTeamName(o.label, pick.pick.team!))?.label;
    if (!side && m.outcomes.some((o) => o.label.toLowerCase() === "yes")) {
      // "Will the Eagles win?" style: Yes if the question names the picked team.
      side = new RegExp(`\\b${teamNick(pick.pick.team)}\\b`, "i").test(m.question) ? "Yes" : "No";
    }
  }
  const exact = teamsIn.length === 2 && type === pick.pick.type && !!side && (!date || !m.endDate || (daysBetween(date, m.endDate) ?? 99) <= 2);
  return { score: Math.max(0, Math.min(1, +score.toFixed(3))), side, relation: exact ? "exact" : undefined, rationale: reasons.join("; "), matchedBy: "rule:sports" };
}

/** General prediction vs a market: overlap, deadline, numbers. Never exact. */
export function scoreTextMarket(p: Prediction, m: MarketSummary): MatchScore {
  const claimTokens = tokenize(`${p.normalizedStatement} ${p.entities.join(" ")}`);
  const marketTokens = tokenize(`${m.question} ${m.event?.title ?? ""}`);
  const marketSet = new Set(marketTokens);
  const shared = claimTokens.filter((t) => marketSet.has(t) && !/^(19|20)\d\d$/.test(t));
  const entityTokens = tokenize(p.entities.join(" "));
  const entityHits = entityTokens.filter((t) => marketSet.has(t));
  const reasons: string[] = [];
  if (claimTokens.length === 0) return { score: 0, rationale: "no content tokens", matchedBy: "rule:text" };
  let score = 0.6 * (shared.length / Math.max(4, Math.min(claimTokens.length, marketTokens.length)));
  if (entityTokens.length > 0) {
    score += 0.25 * (entityHits.length / entityTokens.length);
    reasons.push(`${entityHits.length}/${entityTokens.length} entities in market`);
  }
  if (entityTokens.length > 0 && entityHits.length === 0) { score -= 0.2; }
  const isYear = (t: string) => /^(19|20)\d\d$/.test(t);
  const numsClaim = claimTokens.filter((t) => /\d/.test(t) && !isYear(t));
  const numsShared = numsClaim.filter((t) => marketSet.has(t));
  if (numsClaim.length > 0) {
    if (numsShared.length > 0) { score += 0.15; reasons.push(`shares number ${numsShared.join(", ")}`); }
    else { score -= 0.1; reasons.push("claim's numbers absent from market"); }
  }
  if (p.deadlineDate && m.endDate) {
    const d = daysBetween(p.deadlineDate, m.endDate);
    if (d !== undefined && d <= 45) { score += 0.15; reasons.push("deadlines within 45 days"); }
    else if (d !== undefined && d > 200) { score -= 0.15; reasons.push(`deadlines ${Math.round(d)} days apart`); }
  }
  reasons.unshift(`${shared.length} shared term(s): ${shared.slice(0, 6).join(", ") || "none"}`);
  const negated = /\b(won't|will not|never|no longer|fail to|not going to)\b/i.test(p.normalizedStatement);
  const yes = m.outcomes.find((o) => o.label.toLowerCase() === "yes");
  const side = yes ? (negated ? "No" : "Yes") : undefined;
  return { score: Math.max(0, Math.min(1, +score.toFixed(3))), side, rationale: reasons.join("; "), matchedBy: "rule:text" };
}
