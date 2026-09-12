/**
 * Prediction Ledger — deterministic deadline resolution from time expressions.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Rules (PX-03):
 *  - Relative expressions ("within two years", "in 6 months", "by next year") are resolved
 *    from the date the statement was MADE, never from the import date.
 *  - If no statement date is known, relative expressions stay unresolved (deadline unknown).
 *    We never invent a date.
 *  - Absolute expressions ("by 2027", "by Q3 2026", "before March 2027", "by the end of
 *    2026") resolve without a base date. End-of-period semantics: "by 2027" → 2027-12-31.
 *  - Every resolution records a `basis` so the UI can show how the deadline was derived.
 * The model also proposes a deadline; the app prefers its own rule-based result when one
 * exists, otherwise uses the model's date with basis "model".
 */

export interface DeadlineResolution {
  deadlineDate?: string; // YYYY-MM-DD
  basis: "rule:relative" | "rule:absolute" | "model" | "user" | "unresolved";
  note?: string;
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, few: 3, "half a": 0.5,
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function resolveDeadline(timeExpression: string | undefined, madeOnDate: string | undefined, modelDeadline?: string): DeadlineResolution {
  const expr = (timeExpression ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!expr) return modelDeadline ? { deadlineDate: clampIso(modelDeadline), basis: "model" } : { basis: "unresolved", note: "No time expression." };

  const abs = resolveAbsolute(expr);
  if (abs) return { deadlineDate: abs, basis: "rule:absolute" };

  const rel = parseRelative(expr);
  if (rel) {
    if (!madeOnDate) {
      return { basis: "unresolved", note: `Relative expression "${timeExpression}" needs the statement date, which is unknown.` };
    }
    return { deadlineDate: addPeriod(madeOnDate, rel.amount, rel.unit, rel.endOf), basis: "rule:relative" };
  }

  if (modelDeadline && isIso(modelDeadline)) return { deadlineDate: modelDeadline, basis: "model", note: "Rule-based parser could not resolve the expression; using the model's proposed date." };
  return { basis: "unresolved", note: `Could not resolve "${timeExpression}".` };
}

// ---- relative -----------------------------------------------------------------

type Unit = "day" | "week" | "month" | "year" | "decade";

function parseRelative(expr: string): { amount: number; unit: Unit; endOf?: boolean } | undefined {
  // "by the end of next year" / "end of next month" → last day of that period (not statement date + 1 year)
  const endNext = /\bend of (?:the )?next (year|month)\b/.exec(expr);
  if (endNext) return { amount: 1, unit: endNext[1] as Unit, endOf: true };
  // "within two years", "in 18 months", "over the next 5 years", "in the next couple of years", "a year from now"
  const m = /(?:within|in|over|during|inside|next|coming)?(?: the)?(?: next| coming)? ?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?: of)?|few|half a|\d+(?:\.\d+)?) ?(day|week|month|year|decade)s?/.exec(expr);
  if (m) {
    const raw = m[1].replace(/ of$/, "");
    const amount = WORD_NUMBERS[raw] ?? Number(raw);
    if (Number.isFinite(amount)) return { amount, unit: m[2] as Unit };
  }
  if (/\b(by|within|before|in) (the )?end of (the |this )?year\b/.test(expr)) return { amount: 0, unit: "year" };
  if (/\bnext year\b/.test(expr)) return { amount: 1, unit: "year" };
  if (/\bnext month\b/.test(expr)) return { amount: 1, unit: "month" };
  if (/\bthis year\b/.test(expr)) return { amount: 0, unit: "year" };
  return undefined;
}

/** madeOn + amount units. amount 0 (or endOf) with year/month = end of that period. */
function addPeriod(madeOn: string, amount: number, unit: Unit, endOf = false): string {
  const d = parseIso(madeOn);
  if ((amount === 0 || endOf) && unit === "year") return `${d.y + amount}-12-31`;
  if ((amount === 0 || endOf) && unit === "month") {
    let y = d.y;
    let mo = d.m + amount;
    while (mo > 12) { mo -= 12; y++; }
    return endOfMonth(y, mo);
  }
  const months = unit === "year" ? amount * 12 : unit === "decade" ? amount * 120 : unit === "month" ? amount : 0;
  const days = unit === "week" ? amount * 7 : unit === "day" ? amount : 0;
  let y = d.y;
  let mo = d.m + Math.round(months);
  while (mo > 12) { mo -= 12; y++; }
  while (mo < 1) { mo += 12; y--; }
  const dayInMonth = Math.min(d.d, daysIn(y, mo));
  const base = Date.UTC(y, mo - 1, dayInMonth) + days * 86_400_000;
  return toIso(new Date(base));
}

// ---- absolute -----------------------------------------------------------------

function resolveAbsolute(expr: string): string | undefined {
  // Full ISO date present
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(expr);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "by Q3 2026" / "in the third quarter of 2026"
  const q = /\bq([1-4])\s*(?:of\s*)?(20\d{2})\b/.exec(expr) ?? /\b(first|second|third|fourth) quarter (?:of )?(20\d{2})\b/.exec(expr);
  if (q) {
    const n = /\d/.test(q[1]) ? Number(q[1]) : ["first", "second", "third", "fourth"].indexOf(q[1]) + 1;
    return endOfMonth(Number(q[2]), n * 3);
  }

  // "by March 2027", "before the end of March 2027", "in mid-2027" (mid → June 30), "by early/late 2027"
  const monthYear = new RegExp(`\\b(${MONTHS.join("|")})\\s*,?\\s*(20\\d{2})\\b`).exec(expr);
  if (monthYear) return endOfMonth(Number(monthYear[2]), MONTHS.indexOf(monthYear[1]) + 1);

  const half = /\b(h[12]|first half|second half)\s*(?:of\s*)?(20\d{2})\b/.exec(expr);
  if (half) return half[1] === "h1" || half[1] === "first half" ? `${half[2]}-06-30` : `${half[2]}-12-31`;

  const mid = /\bmid[- ](20\d{2})\b/.exec(expr);
  if (mid) return `${mid[1]}-06-30`;
  const early = /\bearly (20\d{2})\b/.exec(expr);
  if (early) return `${early[1]}-04-30`;
  const late = /\blate (20\d{2})\b/.exec(expr);
  if (late) return `${late[1]}-12-31`;

  // "by 2027", "before 2030", "in 2028", "by the end of 2026", "this decade" → not absolute (needs base)
  const year = /\b(?:by|before|in|until|through|end of|as of|during)\s+(?:the\s+)?(?:end\s+of\s+)?(20\d{2})\b/.exec(expr) ?? /^(20\d{2})$/.exec(expr);
  if (year) return `${year[1]}-12-31`;
  return undefined;
}

// ---- helpers -----------------------------------------------------------------

export function isIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function clampIso(s: string): string | undefined {
  return isIso(s) ? s : undefined;
}
function parseIso(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}
function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function endOfMonth(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(daysIn(y, m)).padStart(2, "0")}`;
}
function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Time status per VD-01, computed at read time (never stored). */
export function timeStatus(deadlineDate: string | undefined, today = toIso(new Date())): "pending" | "reached" | "unknown" {
  if (!deadlineDate || !isIso(deadlineDate)) return "unknown";
  return deadlineDate < today ? "reached" : "pending";
}
