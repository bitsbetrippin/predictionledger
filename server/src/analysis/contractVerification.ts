/**
 * Prediction Ledger — execution-specific contract verification (1.11, MAT-02…06). Pure functions.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * A market *link* says "these are probably about the same thing" (a discovery score). A *verification*
 * says "the claim and this venue contract mean exactly the same thing, on this side" — field by field,
 * with each field marked verified / incompatible / missing / not applicable. Only a checklist with nothing
 * missing and nothing incompatible is `verified_equivalent`; only that status can ever reach execution.
 *
 * Rules that are deliberately strict (spec §6):
 *   - unknown never means exact: a missing game date, start time, league, line, period or rule blocks;
 *   - "touches $100 by Dec 31" ≠ "closes above $100 on Dec 31"; ">" ≠ ">=";  -3.5 ≠ -7.5; 1H ≠ full game;
 *   - the side comes from the venue's durable side ids and the team/negation semantics, never from the
 *     outcome array order, a nickname guess or the slug;
 *   - a documented user fact may fill a *missing* field (recorded with its provenance); it can never turn
 *     an *incompatible* field green, and the hard gates (venue, open status, rules hash, side, teams)
 *     accept no facts at all.
 *
 * Conventions recorded on the claim side (not inferred silently): an unqualified spoken pick means the
 * full game including overtime — that is what a sportsbook line means. The venue must still state its
 * own period and overtime handling, or the field stays missing.
 */

import crypto from "node:crypto";
import type { ContractField, ContractFieldStatus, ContractVerificationStatus, Game, MarketContractConstraints, MarketRecord, Prediction, SportsPick } from "@prediction-ledger/shared";
import { sameTeamName, teamNick } from "./sports.js";

export interface DocumentedFact { value: string; source: string }

export interface VerifyInput {
  prediction: Prediction;
  game?: Game;
  market: MarketRecord;
  facts?: Record<string, DocumentedFact>;
}

export interface VerifyResult {
  status: ContractVerificationStatus;
  fields: ContractField[];
  sideId?: string;
  sideLabel?: string;
  sideBasis?: string;
  rulesHash?: string;
  cutoffAt?: string;
  cutoffBasis?: string;
  cutoffUnknown: boolean;
  summary: string;
}

/** Fields that no user fact may touch (MAT-03/M09). */
export const HARD_GATES = new Set(["venue", "market_open", "rules_hash", "side", "teams", "question", "settlement_conditions"]);

export const rulesHash = (text: string | undefined): string | undefined => (text && text.trim() ? crypto.createHash("sha256").update(text.trim()).digest("hex") : undefined);

// ---- period / overtime / rule parsing ------------------------------------------------------------

export type Period = "full_game" | "first_half" | "second_half" | "first_quarter" | "second_quarter" | "third_quarter" | "fourth_quarter" | "first_five" | "first_period" | "second_period" | "third_period" | "regulation";
const PERIOD_PATTERNS: [RegExp, Period][] = [
  [/\b(1st|first)[\s-]?half\b|\b1h\b|\bfirst-half\b/i, "first_half"],
  [/\b(2nd|second)[\s-]?half\b|\b2h\b/i, "second_half"],
  [/\b(1st|first)[\s-]?quarter\b|\b1q\b/i, "first_quarter"],
  [/\b(2nd|second)[\s-]?quarter\b|\b2q\b/i, "second_quarter"],
  [/\b(3rd|third)[\s-]?quarter\b|\b3q\b/i, "third_quarter"],
  [/\b(4th|fourth)[\s-]?quarter\b|\b4q\b/i, "fourth_quarter"],
  [/\bf5\b|\bfirst (five|5) innings\b/i, "first_five"],
  [/\b(1st|first)[\s-]?period\b|\b1p\b/i, "first_period"],
  [/\b(2nd|second)[\s-]?period\b|\b2p\b/i, "second_period"],
  [/\b(3rd|third)[\s-]?period\b|\b3p\b/i, "third_period"],
  [/\bregulation\b(?! time (?:and|plus|including) overtime)/i, "regulation"],
];
const PERIOD_LABEL: Record<Period, string> = { full_game: "full game", first_half: "1st half", second_half: "2nd half", first_quarter: "1st quarter", second_quarter: "2nd quarter", third_quarter: "3rd quarter", fourth_quarter: "4th quarter", first_five: "first 5 innings", first_period: "1st period", second_period: "2nd period", third_period: "3rd period", regulation: "regulation only" };

/** Period of a market from its slug/title/question, or of a claim from its quote. Unqualified = full game. */
export function parsePeriod(...texts: (string | undefined)[]): { period: Period; basis: "stated" | "unqualified" } {
  for (const t of texts) {
    if (!t) continue;
    // Slug tokens: "-1h-", "-2h-", "-1q-", "-f5-"
    const slugTok = /(?:^|-)(1h|2h|1q|2q|3q|4q|f5|1p|2p|3p)(?:-|$)/i.exec(t);
    if (slugTok) {
      const m: Record<string, Period> = { "1h": "first_half", "2h": "second_half", "1q": "first_quarter", "2q": "second_quarter", "3q": "third_quarter", "4q": "fourth_quarter", f5: "first_five", "1p": "first_period", "2p": "second_period", "3p": "third_period" };
      return { period: m[slugTok[1].toLowerCase()], basis: "stated" };
    }
    for (const [re, p] of PERIOD_PATTERNS) if (re.test(t)) return { period: p, basis: "stated" };
  }
  return { period: "full_game", basis: "unqualified" };
}

export type OvertimeRule = "includes_overtime" | "regulation_only" | "unstated";
export function parseOvertimeRule(rules: string | undefined): OvertimeRule {
  if (!rules) return "unstated";
  if (/\b(regulation( time)? only|excluding overtime|not including overtime|does not include overtime|overtime (is|will be) (not|excluded))\b/i.test(rules)) return "regulation_only";
  if (/\b(including overtime|includes overtime|inclusive of overtime|overtime (counts|included|is included)|final score,? including (any )?overtime|end of the game,? including overtime)\b/i.test(rules)) return "includes_overtime";
  if (/\bovertime\b/i.test(rules)) return "includes_overtime";
  return "unstated";
}

/** Sentences of the rules text that govern postponement, cancellation, ties and voids. */
export function parseTieVoidRule(rules: string | undefined): string | undefined {
  if (!rules) return undefined;
  const sentences = rules.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const hits = sentences.filter((s) => /\b(postpone|cancel|void|refund|50-50|50\/50|tie|draw|abandon|suspended|no action)/i.test(s));
  return hits.length ? hits.join(" ") : undefined;
}

// ---- general-market semantics ------------------------------------------------------------------

export type PropositionSemantics = "touch" | "close" | "cumulative" | "unknown";
export type Comparator = ">" | ">=" | "<" | "<=" | "=" | "unknown";

export function parseSemantics(text: string | undefined): PropositionSemantics {
  if (!text) return "unknown";
  if (/\b(touch(es|ed)?|reach(es|ed)?|hit(s)?|cross(es|ed)?|at any point|ever|any time before|intraday|surpass)\b/i.test(text)) return "touch";
  if (/\b(clos(e|es|ing) (above|below|at|over|under)|at (the )?close|closes on|end(s)? (the )?(day|week|month|year|quarter) (above|below)|as of|on (the )?(closing|final) (day|date)|settlement price|be above .* on \w+ \d|be (above|below|over|under) .* on (january|february|march|april|may|june|july|august|september|october|november|december)\b)/i.test(text)) return "close";
  if (/\b(total|cumulative|in aggregate|combined)\b/i.test(text)) return "cumulative";
  return "unknown";
}

export function parseComparator(text: string | undefined): Comparator {
  if (!text) return "unknown";
  if (/\b(at least|or (more|higher|above)|no less than|>=|≥|minimum of)\b/i.test(text)) return ">=";
  if (/\b(at most|or (less|lower|below|fewer)|no more than|<=|≤|maximum of)\b/i.test(text)) return "<=";
  if (/\b(above|over|more than|exceed(s|ed)?|greater than|higher than|surpass(es)?|>)\b/i.test(text) || />/.test(text)) return ">";
  if (/\b(below|under|less than|fewer than|lower than|<)\b/i.test(text) || /</.test(text)) return "<";
  if (/\b(exactly|equal(s)? to|=)\b/i.test(text)) return "=";
  return "unknown";
}

/** First numeric threshold with its unit: "$100k" → 100000 USD; "5%" → 5 %; "2 million" → 2000000. */
export function parseThreshold(text: string | undefined): { value: number; unit: string; raw: string } | undefined {
  if (!text) return undefined;
  const re = /(\$|€|£)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|thousand|m|mm|million|b|bn|billion|t|trillion|%|percent|bps|basis points|usd|dollars|eur|gbp)?(?![A-Za-z0-9])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // Skip bare years and plain dates ("2026", "December 31").
    const num = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    const suffix = (m[3] ?? "").toLowerCase();
    const cur = m[1] ?? "";
    if (!cur && !suffix && num >= 1900 && num <= 2100 && Number.isInteger(num)) continue;
    if (!cur && !suffix && num <= 31 && /(january|february|march|april|may|june|july|august|september|october|november|december)\s*$/i.test(text.slice(0, m.index))) continue;
    if (!cur && !suffix) continue; // a bare number with no unit is too ambiguous to treat as a threshold
    let mult = 1;
    if (/^(k|thousand)$/.test(suffix)) mult = 1e3;
    else if (/^(m|mm|million)$/.test(suffix)) mult = 1e6;
    else if (/^(b|bn|billion)$/.test(suffix)) mult = 1e9;
    else if (/^(t|trillion)$/.test(suffix)) mult = 1e12;
    const unit = cur === "$" || suffix === "usd" || suffix === "dollars" ? "USD" : cur === "€" || suffix === "eur" ? "EUR" : cur === "£" || suffix === "gbp" ? "GBP" : suffix === "%" || suffix === "percent" ? "%" : suffix === "bps" || suffix === "basis points" ? "bps" : "count";
    return { value: num * mult, unit, raw: m[0].trim() };
  }
  return undefined;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "November 1, 2026", "Dec 31 2026", "12/31/2026", "2026-12-31" → ISO date; the first found. */
export function parseDateMention(text: string | undefined, fallbackYear?: number): string | undefined {
  if (!text) return undefined;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return iso[0];
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const named = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\b/i.exec(text);
  if (named) {
    const mi = MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase().slice(0, 3)));
    const year = named[3] ? Number(named[3]) : fallbackYear;
    if (mi >= 0 && year) return `${year}-${String(mi + 1).padStart(2, "0")}-${named[2].padStart(2, "0")}`;
  }
  return undefined;
}

export function parseMeasurementSource(rules: string | undefined): string | undefined {
  if (!rules) return undefined;
  const m = /\b(?:sourced from|based on|according to|per|using|as reported by|as published by|from)\s+(?:the\s+)?([A-Z][A-Za-z0-9'&.\- ]{2,60}(?:Index|Benchmarks?|Bureau|Department|Reserve|Exchange|Office|Agency|Commission|API|feed|data|report|website|Reuters|Bloomberg|Associated Press|AP)\b)/.exec(rules);
  return m ? m[1].trim() : undefined;
}

export function isNegated(statement: string): boolean {
  return /\b(will not|won't|not going to|never|fail(s|ed)? to|no longer|isn't going to|is not going to|unlikely to|will fall short|below|under)\b/i.test(statement) && !/\b(not (below|under))\b/i.test(statement);
}

// ---- helpers ------------------------------------------------------------------------------------

const etDate = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  try {
    return new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  } catch {
    return iso.slice(0, 10);
  }
};

function field(id: string, label: string, status: ContractFieldStatus, required: boolean, extra: Partial<ContractField> = {}): ContractField {
  return { id, label, status, required, ...extra };
}

function teamMatches(claim: string, side: MarketContractConstraints["sides"][number]): boolean {
  const names = [side.label, side.team?.name, side.team?.alias, side.team?.abbreviation].filter((x): x is string => !!x);
  const cn = teamNick(claim);
  return names.some((n) => sameTeamName(claim, n) || teamNick(n) === cn || n.toLowerCase() === claim.toLowerCase());
}

function marketTypeOf(c: MarketContractConstraints | undefined, question: string): "moneyline" | "spread" | "total" | "future" | "prop" | "unknown" {
  const t = (c?.sportsMarketType ?? "").toUpperCase();
  if (t.includes("MONEYLINE")) return "moneyline";
  if (t.includes("SPREAD")) return "spread";
  if (t.includes("TOTAL")) return "total";
  if (t.includes("FUTURE")) return "future";
  if (t.includes("PROP")) return "prop";
  if (/\b(over|under)\s*\d/i.test(question)) return "total";
  if (/[-+]\d+(\.5)?\b/.test(question)) return "spread";
  return "unknown";
}

/** Spread line as it applies to the named side: sign from the question/title ("DET -5.5"), else from the slug ("pos"/"neg"). */
function marketSpreadForSide(market: MarketRecord, side: MarketContractConstraints["sides"][number] | undefined, line: number | undefined): number | undefined {
  if (line === undefined || !side) return undefined;
  const abbr = side.team?.abbreviation?.toUpperCase();
  const q = market.question;
  const signed = new RegExp(`\\b(${[abbr, side.team?.alias, side.label].filter(Boolean).map((x) => x!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*([-+])\\s*(\\d+(?:\\.5)?)`, "i").exec(q);
  if (signed) return Number(`${signed[2]}${signed[3]}`);
  const anySigned = /([-+])\s*(\d+(?:\.5)?)\b/.exec(q);
  if (anySigned && side.long) return Number(`${anySigned[1]}${anySigned[2]}`);
  if (anySigned && !side.long) return -Number(`${anySigned[1]}${anySigned[2]}`);
  const slugTok = /-(pos|neg)-(\d+)(?:pt(\d))?/i.exec(market.slug);
  if (slugTok) {
    const v = Number(`${slugTok[2]}${slugTok[3] ? `.${slugTok[3]}` : ""}`);
    const forLong = slugTok[1].toLowerCase() === "pos" ? v : -v;
    return side.long ? forLong : -forLong;
  }
  return undefined;
}

// ---- verification -------------------------------------------------------------------------------

export function verifyContract(input: VerifyInput): VerifyResult {
  const { prediction: p, market, game } = input;
  const facts = input.facts ?? {};
  const c = market.constraints;
  const fields: ContractField[] = [];
  const rh = rulesHash(market.description);
  let sideId: string | undefined, sideLabel: string | undefined, sideBasis: string | undefined;

  // Hard gates first.
  fields.push(field("venue", "Venue is Polymarket US", market.provider === "polymarket_us" ? "verified" : "incompatible", true, { found: market.provider, note: market.provider === "polymarket_us" ? undefined : "other venues are research-only; they can never be executable" }));
  const open = c?.status ? /OPEN/i.test(c.status) : undefined;
  fields.push(field("market_open", "Market open for trading", open === true && market.active && !market.closed ? "verified" : open === undefined && !c ? "missing" : "incompatible", true, { found: c?.status ?? (market.closed ? "closed" : market.active ? "active" : "inactive"), note: open === false ? "halted/closed/resolved markets cannot be traded" : undefined }));
  fields.push(field("question", "Venue question captured", market.question ? "verified" : "missing", true, { found: market.question }));
  fields.push(field("rules_hash", "Settlement rules captured and hashed", rh ? "verified" : "missing", true, { found: rh ? `${rh.slice(0, 16)}… (${market.description!.length} chars)` : undefined, note: rh ? undefined : "the venue published no rules text" }));
  fields.push(field("settlement_conditions", "Settlement conditions stated", market.description && market.description.trim().length > 20 ? "verified" : "missing", true, { found: market.description?.slice(0, 200) }));

  if (p.kind === "sports_pick" && p.sportsPick) {
    verifySports(p, p.sportsPick, game, market, c, facts, fields, (id, label, basis) => { sideId = id; sideLabel = label; sideBasis = basis; });
  } else {
    verifyGeneral(p, market, c, facts, fields, (id, label, basis) => { sideId = id; sideLabel = label; sideBasis = basis; });
  }

  // Trading close / cutoff (MAT-06): the earliest applicable instant.
  const candidates: { at: string; basis: string }[] = [];
  if (c?.gameStartTime) candidates.push({ at: c.gameStartTime, basis: "game start" });
  if (c?.eventStartTime) candidates.push({ at: c.eventStartTime, basis: "event start" });
  if (market.endDate) candidates.push({ at: market.endDate, basis: "trading close" });
  const obsEnd = p.kind !== "sports_pick" ? parseDateMention(market.description) : undefined;
  if (obsEnd) candidates.push({ at: `${obsEnd}T00:00:00Z`, basis: "observation cutoff (rules text, date only)" });
  const valid = candidates.filter((x) => Number.isFinite(Date.parse(x.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const cutoff = valid[0];
  fields.push(field("trading_close", "Trading close / pre-event cutoff known", cutoff ? "verified" : "missing", true, { found: cutoff ? `${cutoff.at} (${cutoff.basis})` : undefined, note: cutoff ? undefined : "no event start, observation cutoff or trading close published — automation cannot compute a safe deadline" }));

  // Documented facts may fill MISSING fields outside the hard gates (MAT-03). They never flip an incompatible field.
  for (const f of fields) {
    const fact = facts[f.id];
    if (!fact) continue;
    if (HARD_GATES.has(f.id)) { f.note = `${f.note ? `${f.note}; ` : ""}user fact ignored: this field accepts no override`; continue; }
    if (f.status === "incompatible") { f.note = `${f.note ? `${f.note}; ` : ""}user fact ignored: field is incompatible`; continue; }
    if (f.status === "missing") {
      const ok = factSatisfies(f, fact.value);
      f.status = ok ? "verified" : "incompatible";
      f.fact = fact;
      f.found = `${fact.value} (documented: ${fact.source})`;
      if (!ok) f.note = `documented value "${fact.value}" does not match the claim (${f.expected ?? "?"})`;
    }
  }

  const required = fields.filter((f) => f.required);
  let status: ContractVerificationStatus;
  if (market.provider !== "polymarket_us") status = "research_only";
  else if (required.some((f) => f.status === "incompatible")) status = "incompatible";
  else if (required.some((f) => f.status === "missing")) status = "incomplete";
  else status = "verified_equivalent";
  if (status !== "verified_equivalent") { sideId = undefined; sideLabel = undefined; }
  const bad = required.filter((f) => f.status !== "verified" && f.status !== "not_applicable");
  const summary = status === "verified_equivalent" ? `Every required field verified; side ${sideLabel} (${sideId}).` : status === "research_only" ? "Research-only venue." : `${status}: ${bad.map((f) => `${f.label} — ${f.status}${f.expected || f.found ? ` (claim: ${f.expected ?? "?"}; venue: ${f.found ?? "?"})` : ""}`).join("; ")}`;
  return { status, fields, sideId, sideLabel, sideBasis, rulesHash: rh, cutoffAt: cutoff?.at, cutoffBasis: cutoff?.basis, cutoffUnknown: !cutoff, summary };
}

/**
 * A documented fact fills whichever side of a missing field was unstated: when the claim was silent it must agree
 * with what the venue states (`found`); when the venue was silent it must agree with the claim (`expected`); when
 * both were silent it is simply recorded. It is never accepted against a value that disagrees.
 */
function factSatisfies(f: ContractField, value: string): boolean {
  const other = f.expected ?? f.found;
  if (!other) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.+-]/g, "");
  if (f.id === "line") return Number(value) === Number(other);
  if (f.id === "game_date") return value.slice(0, 10) === other.slice(0, 10);
  if (f.id === "game_start") return true;
  const a = norm(value), b = norm(other.replace(/\s*\(.*\)$/, ""));
  return a === b || a.includes(b) || b.includes(a);
}

type SetSide = (id: string, label: string, basis: string) => void;

function verifySports(p: Prediction, pick: SportsPick, game: Game | undefined, market: MarketRecord, c: MarketContractConstraints | undefined, facts: Record<string, DocumentedFact>, fields: ContractField[], setSide: SetSide): void {
  const sides = c?.sides ?? [];
  // League
  const claimLeague = (pick.league ?? leagueOfSport(pick.sport))?.toLowerCase();
  const marketLeague = (sides.find((s) => s.team?.league)?.team?.league ?? /^(?:[a-z]{3}-)?([a-z]+)-/i.exec(market.slug)?.[1])?.toLowerCase();
  const leagueKnownMarket = marketLeague && /^(nfl|nba|nhl|mlb|ncaaf|ncaab|cfb|cbb|mls|epl|ufc|wnba|nascar|f1|pga|atp|wta)$/.test(marketLeague) ? marketLeague : undefined;
  fields.push(field("league", "League", !claimLeague ? "missing" : !leagueKnownMarket ? "missing" : sameLeague(claimLeague, leagueKnownMarket) ? "verified" : "incompatible", true, { expected: claimLeague, found: leagueKnownMarket ?? marketLeague }));
  // Teams — both claim teams must match distinct market sides; totals (Over/Under sides) identify the game through the event title.
  const sidesCarryTeams = sides.some((s) => s.team);
  const matched = pick.teams.map((t) => sides.find((s) => teamMatches(t, s)));
  let teamsStatus: ContractFieldStatus;
  let teamsFound: string | undefined;
  if (sides.length === 0) { teamsStatus = "missing"; }
  else if (sidesCarryTeams || matched[0] || matched[1]) {
    teamsStatus = matched[0] && matched[1] && matched[0].id !== matched[1].id ? "verified" : "incompatible";
    teamsFound = sides.map((s) => s.team?.name ?? s.label).join(" vs ");
  } else {
    const text = `${market.event?.title ?? ""} ${market.question} ${market.slug}`.toLowerCase();
    const both = pick.teams.every((t) => text.includes(teamNick(t)) || text.includes(t.toLowerCase()));
    teamsStatus = market.event?.title ? (both ? "verified" : "incompatible") : "missing";
    teamsFound = market.event?.title;
  }
  fields.push(field("teams", "Both teams identified on the contract", teamsStatus, true, { expected: pick.teams.join(" vs "), found: teamsFound || undefined }));
  // Game date / start
  const claimDate = pick.eventDate ?? game?.eventDate;
  const startIso = c?.gameStartTime ?? c?.eventStartTime;
  const marketDate = etDate(startIso);
  fields.push(field("game_date", "Same game (date, ET)", !claimDate ? "missing" : !marketDate ? "missing" : claimDate === marketDate ? "verified" : "incompatible", true, { expected: claimDate, found: marketDate, note: !claimDate ? "the claim's game date is unknown — unknown never means exact" : undefined }));
  fields.push(field("game_start", "Game start time published", startIso ? "verified" : "missing", true, { found: startIso, note: startIso ? undefined : "no start time on the contract; the pre-event cutoff cannot be enforced" }));
  // Market type
  const mtype = marketTypeOf(c, market.question);
  fields.push(field("market_type", "Market type", mtype === "unknown" ? "missing" : mtype === pick.pick.type ? "verified" : "incompatible", true, { expected: pick.pick.type, found: mtype }));
  // Line
  const claimTeamSide = pick.pick.team ? sides.find((s) => teamMatches(pick.pick.team!, s)) : undefined;
  if (pick.pick.type === "spread") {
    const mline = marketSpreadForSide(market, claimTeamSide, c?.line !== undefined ? Number(c.line) : undefined);
    fields.push(field("line", "Spread line and sign for the picked team", pick.pick.line === undefined ? "missing" : mline === undefined ? "missing" : mline === pick.pick.line ? "verified" : "incompatible", true, { expected: pick.pick.line !== undefined ? fmtLine(pick.pick.line) : undefined, found: mline !== undefined ? fmtLine(mline) : c?.line !== undefined ? `${c.line} (sign unresolved)` : undefined }));
  } else if (pick.pick.type === "total") {
    const mline = c?.line !== undefined ? Number(c.line) : undefined;
    fields.push(field("line", "Total line", pick.pick.line === undefined ? "missing" : mline === undefined ? "missing" : mline === pick.pick.line ? "verified" : "incompatible", true, { expected: pick.pick.line !== undefined ? String(pick.pick.line) : undefined, found: mline !== undefined ? String(mline) : undefined }));
  } else {
    fields.push(field("line", "Line", "not_applicable", false, { note: "moneyline" }));
  }
  // Period
  const claimPeriod = parsePeriod(p.quoteExact, p.normalizedStatement);
  const marketPeriod = parsePeriod(market.slug, market.question);
  fields.push(field("period", "Period (full game / half / quarter)", claimPeriod.period === marketPeriod.period ? "verified" : "incompatible", true, { expected: `${PERIOD_LABEL[claimPeriod.period]}${claimPeriod.basis === "unqualified" ? " (unqualified pick = full game)" : ""}`, found: `${PERIOD_LABEL[marketPeriod.period]}${marketPeriod.basis === "unqualified" ? " (no qualifier on the contract)" : ""}` }));
  // Overtime
  const ot = parseOvertimeRule(market.description);
  const claimOt = claimPeriod.period === "regulation" ? "regulation_only" : "includes_overtime";
  const otStatus: ContractFieldStatus = ot === "unstated" ? (mtype === "moneyline" && claimOt === "includes_overtime" ? "verified" : "missing") : ot === claimOt ? "verified" : "incompatible";
  fields.push(field("overtime_rule", "Overtime handling", otStatus, true, { expected: `${claimOt} (sportsbook convention for an unqualified pick)`, found: ot, note: ot === "unstated" && otStatus === "verified" ? "rules silent; a moneyline 'wins' means the final result" : undefined }));
  // Tie / void / postponement
  const tie = parseTieVoidRule(market.description);
  fields.push(field("tie_void_rule", "Tie / postponement / cancellation rule", tie ? "verified" : "missing", true, { found: tie }));
  // Side (MAT-05): the picked team's durable side id; totals map to Over/Under labels.
  if (pick.pick.type === "total") {
    const s = sides.find((x) => x.label.toLowerCase() === pick.pick.side);
    fields.push(field("side", "Selected outcome maps to a durable side id", s ? "verified" : "incompatible", true, { expected: pick.pick.side, found: s ? `${s.label} (side ${s.id})` : sides.map((x) => x.label).join("/") }));
    if (s) setSide(s.id, s.label, "total side label");
  } else {
    const s = claimTeamSide;
    fields.push(field("side", "Picked team maps to a durable side id", !pick.pick.team ? "missing" : s ? "verified" : "incompatible", true, { expected: pick.pick.team, found: s ? `${s.team?.name ?? s.label} (side ${s.id}, ${s.long ? "YES/long" : "NO/short"})` : undefined }));
    if (s) setSide(s.id, s.team?.name ?? s.label, `team identity → side ${s.long ? "long" : "short"}`);
  }
}

function verifyGeneral(p: Prediction, market: MarketRecord, c: MarketContractConstraints | undefined, facts: Record<string, DocumentedFact>, fields: ContractField[], setSide: SetSide): void {
  const claimText = `${p.normalizedStatement} ${p.thresholds.join(" ")}`;
  const rules = `${market.question} ${market.description ?? ""}`;
  // Subject
  const subject = p.entities[0];
  const subjectOk = subject ? new RegExp(`\\b${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(rules) : false;
  fields.push(field("subject", "Subject / entity named on the contract", !subject ? "missing" : subjectOk ? "verified" : "incompatible", true, { expected: subject, found: subjectOk ? "present in question/rules" : "not found in question/rules" }));
  // Semantics: touch vs close vs cumulative
  const cs = parseSemantics(claimText), ms = parseSemantics(market.description ?? market.question);
  fields.push(field("proposition_semantics", "Proposition semantics (touch / close / cumulative)", cs === "unknown" || ms === "unknown" ? "missing" : cs === ms ? "verified" : "incompatible", true, { expected: cs, found: ms, note: cs !== ms && cs !== "unknown" && ms !== "unknown" ? "\"touches by\" is not \"closes above on\"" : undefined }));
  // Comparator
  const cc = parseComparator(claimText), mc = parseComparator(rules);
  fields.push(field("comparator", "Comparator", cc === "unknown" || mc === "unknown" ? "missing" : cc === mc ? "verified" : "incompatible", true, { expected: cc, found: mc }));
  // Threshold + units
  const ct = parseThreshold(claimText), mt = parseThreshold(rules);
  fields.push(field("threshold", "Threshold value", !ct || !mt ? "missing" : ct.value === mt.value ? "verified" : "incompatible", true, { expected: ct ? `${ct.value} ${ct.unit}` : undefined, found: mt ? `${mt.value} ${mt.unit}` : undefined }));
  fields.push(field("units", "Units / currency", !ct || !mt ? "missing" : ct.unit === mt.unit ? "verified" : "incompatible", true, { expected: ct?.unit, found: mt?.unit }));
  // Observation window: claim deadline vs the market's stated end (rules date, else trading close date).
  const marketEnd = parseDateMention(market.description) ?? (market.endDate ? market.endDate.slice(0, 10) : undefined);
  fields.push(field("observation_window", "Observation window ends on the same date", !p.deadlineDate ? "missing" : !marketEnd ? "missing" : p.deadlineDate === marketEnd ? "verified" : "incompatible", true, { expected: p.deadlineDate, found: marketEnd, note: !p.deadlineDate ? "the claim has no resolved deadline — unknown never means exact" : undefined }));
  // Geography
  const geo = p.geography?.trim();
  if (!geo) fields.push(field("geography", "Geography", "not_applicable", false, { note: "the claim states no geography" }));
  else {
    const mentioned = new RegExp(`\\b${geo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(rules);
    const otherPlace = /\b(United States|U\.S\.|USA|Europe|EU|China|UK|United Kingdom|Canada|global|worldwide|India|Japan)\b/i.exec(rules);
    fields.push(field("geography", "Geography", mentioned ? "verified" : otherPlace ? "incompatible" : "missing", true, { expected: geo, found: mentioned ? geo : otherPlace?.[0] }));
  }
  // Measurement source
  const src = parseMeasurementSource(market.description);
  fields.push(field("measurement_source", "Measurement source stated by the venue", src ? "verified" : "missing", true, { found: src, note: src ? "the claim names no source; the venue's is accepted" : "rules name no data source" }));
  // Side (MAT-05): negation → NO; durable ids from constraints.
  const sides = c?.sides ?? [];
  const wantLong = !isNegated(p.normalizedStatement);
  const s = sides.find((x) => x.long === wantLong);
  fields.push(field("side", "Claim orientation maps to a durable side id", sides.length < 2 ? "missing" : s ? "verified" : "incompatible", true, { expected: wantLong ? "YES (claim affirms)" : "NO (claim negates)", found: s ? `${s.label} (side ${s.id})` : undefined }));
  if (s) setSide(s.id, s.label, wantLong ? "affirmative claim → long side" : "negated claim → short side");
}

function leagueOfSport(sport: string): string | undefined {
  const s = sport.toLowerCase();
  if (/^(nfl|nba|nhl|mlb|mls|wnba|ncaaf|ncaab)$/.test(s)) return s;
  if (/college football|cfb|ncaa football/.test(s)) return "ncaaf";
  if (/college basketball|cbb|ncaa basketball/.test(s)) return "ncaab";
  return undefined; // "football", "soccer", "basketball" alone do not name a league
}
function sameLeague(a: string, b: string): boolean {
  const alias: Record<string, string> = { cfb: "ncaaf", cbb: "ncaab" };
  return (alias[a] ?? a) === (alias[b] ?? b);
}
const fmtLine = (n: number) => (n > 0 ? `+${n}` : String(n));

// ---- revalidation (MAT-06) -------------------------------------------------------------------------

export interface RevalidateInput {
  previous: { rulesHash?: string; cutoffAt?: string; sideId?: string; quoteHash?: string; status: ContractVerificationStatus };
  market: MarketRecord;
  prediction: Prediction;
  currentQuoteHash?: string;
}

/** Reasons a verification no longer holds; empty = still valid. */
export function revalidate(input: RevalidateInput): string[] {
  const reasons: string[] = [];
  const { previous, market } = input;
  const c = market.constraints;
  const rh = rulesHash(market.description);
  if (previous.rulesHash && rh !== previous.rulesHash) reasons.push("rules text changed (hash differs)");
  if (!c?.status || !/OPEN/i.test(c.status) || market.closed || !market.active) reasons.push(`market not open (${c?.status ?? (market.closed ? "closed" : "inactive")})`);
  const start = c?.gameStartTime ?? c?.eventStartTime ?? market.endDate;
  if (previous.cutoffAt && start && Date.parse(start) !== Date.parse(previous.cutoffAt) && (c?.gameStartTime || c?.eventStartTime)) reasons.push(`schedule changed (${previous.cutoffAt} → ${start})`);
  if (previous.sideId && !(c?.sides ?? []).some((s) => s.id === previous.sideId)) reasons.push("verified side id no longer on the contract");
  if (previous.quoteHash && input.currentQuoteHash && previous.quoteHash !== input.currentQuoteHash) reasons.push("prediction changed since verification");
  return reasons;
}
