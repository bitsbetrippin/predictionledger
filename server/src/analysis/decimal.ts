/**
 * Prediction Ledger — fixed-point decimal arithmetic for ledgers (1.12, RSK-04/07).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Every price, quantity, fee and USD amount that reaches a decision, a reservation or a paper fill goes through
 * this module — never a binary float. Values are BigInt scaled by 10^8; the rounding mode of every division and
 * every tick/increment alignment is declared at the call site. Strings in, strings out.
 */

const SCALE_DIGITS = 8;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export type RoundingMode = "floor" | "ceil" | "half_up";

export class Dec {
  private constructor(readonly v: bigint) {}

  static readonly ZERO = new Dec(0n);
  static readonly ONE = new Dec(SCALE);

  /** Parse a decimal string (or a finite number, which is stringified first). Throws on anything else. */
  static of(x: string | number | Dec): Dec {
    if (x instanceof Dec) return x;
    const s = typeof x === "number" ? (Number.isFinite(x) ? x.toString() : "NaN") : x.trim();
    const m = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error(`Not a decimal: "${s}"`);
    const sign = m[1] === "-" ? -1n : 1n;
    let intPart = m[2];
    let frac = m[3] ?? "";
    const exp = m[4] ? Number(m[4]) : 0;
    if (exp !== 0) {
      // Shift the decimal point (JS numbers like 1e-7 stringify this way).
      const digits = intPart + frac;
      let point = intPart.length + exp;
      if (point < 0) { frac = "0".repeat(-point) + digits; intPart = "0"; }
      else if (point > digits.length) { intPart = digits + "0".repeat(point - digits.length); frac = ""; }
      else { intPart = digits.slice(0, point) || "0"; frac = digits.slice(point); }
    }
    if (frac.length > SCALE_DIGITS) {
      // More precision than the ledger keeps: refuse silently-lossy input.
      if (/[1-9]/.test(frac.slice(SCALE_DIGITS))) throw new Error(`Decimal "${s}" exceeds ${SCALE_DIGITS} places`);
      frac = frac.slice(0, SCALE_DIGITS);
    }
    const scaled = BigInt(intPart) * SCALE + BigInt((frac + "0".repeat(SCALE_DIGITS)).slice(0, SCALE_DIGITS));
    return new Dec(sign * scaled);
  }

  static fromScaled(v: bigint): Dec { return new Dec(v); }

  add(o: Dec | string | number): Dec { return new Dec(this.v + Dec.of(o).v); }
  sub(o: Dec | string | number): Dec { return new Dec(this.v - Dec.of(o).v); }
  neg(): Dec { return new Dec(-this.v); }
  abs(): Dec { return this.v < 0n ? this.neg() : this; }

  /** Product, rounded to the ledger scale with the given mode (default half-up). */
  mul(o: Dec | string | number, mode: RoundingMode = "half_up"): Dec {
    return new Dec(divRound(this.v * Dec.of(o).v, SCALE, mode));
  }

  /** Quotient at the ledger scale; the rounding mode is mandatory because it is a financial choice. */
  div(o: Dec | string | number, mode: RoundingMode): Dec {
    const d = Dec.of(o).v;
    if (d === 0n) throw new Error("Division by zero");
    return new Dec(divRound(this.v * SCALE, d, mode));
  }

  cmp(o: Dec | string | number): -1 | 0 | 1 { const d = Dec.of(o).v; return this.v < d ? -1 : this.v > d ? 1 : 0; }
  eq(o: Dec | string | number): boolean { return this.cmp(o) === 0; }
  lt(o: Dec | string | number): boolean { return this.cmp(o) < 0; }
  lte(o: Dec | string | number): boolean { return this.cmp(o) <= 0; }
  gt(o: Dec | string | number): boolean { return this.cmp(o) > 0; }
  gte(o: Dec | string | number): boolean { return this.cmp(o) >= 0; }
  isZero(): boolean { return this.v === 0n; }
  isNeg(): boolean { return this.v < 0n; }
  isPos(): boolean { return this.v > 0n; }

  /** Align to a multiple of `increment` (a tick or a quantity step) with the given rounding. */
  alignTo(increment: Dec | string | number, mode: RoundingMode): Dec {
    const inc = Dec.of(increment).v;
    if (inc <= 0n) throw new Error("Increment must be positive");
    return new Dec(divRound(this.v, inc, mode) * inc);
  }

  /** Whether this value is an exact multiple of `increment`. */
  isMultipleOf(increment: Dec | string | number): boolean {
    const inc = Dec.of(increment).v;
    return inc > 0n && this.v % inc === 0n;
  }

  /** Round to `places` decimal places. */
  round(places: number, mode: RoundingMode = "half_up"): Dec {
    if (places < 0 || places > SCALE_DIGITS) throw new Error("places out of range");
    return this.alignTo(Dec.fromScaled(10n ** BigInt(SCALE_DIGITS - places)), mode);
  }

  /** Canonical string: no exponent, trailing zeros trimmed, at least one digit after the point when fractional. */
  toString(): string {
    const neg = this.v < 0n;
    const a = neg ? -this.v : this.v;
    const i = a / SCALE;
    let f = (a % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${i}${f ? `.${f}` : ""}`;
  }

  /** Fixed number of places (for display and for stored money with two places). */
  toFixed(places: number, mode: RoundingMode = "half_up"): string {
    const r = this.round(places, mode);
    const neg = r.v < 0n;
    const a = neg ? -r.v : r.v;
    const i = a / SCALE;
    const f = (a % SCALE).toString().padStart(SCALE_DIGITS, "0").slice(0, places);
    return `${neg ? "-" : ""}${i}${places > 0 ? `.${f}` : ""}`;
  }

  /** Lossy conversion for display arithmetic only — never for a stored amount. */
  toNumber(): number { return Number(this.toString()); }

  toJSON(): string { return this.toString(); }
}

function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den < 0n) { num = -num; den = -den; }
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  const negative = num < 0n;
  switch (mode) {
    case "floor": return negative ? q - 1n : q;
    case "ceil": return negative ? q : q + 1n;
    case "half_up": {
      const twice = (negative ? -r : r) * 2n;
      if (twice >= den) return negative ? q - 1n : q + 1n;
      return q;
    }
  }
}

export const D = (x: string | number | Dec): Dec => Dec.of(x);
export const dmin = (a: Dec, ...rest: Dec[]): Dec => rest.reduce((m, x) => (x.lt(m) ? x : m), a);
export const dmax = (a: Dec, ...rest: Dec[]): Dec => rest.reduce((m, x) => (x.gt(m) ? x : m), a);
export const dsum = (xs: Iterable<Dec | string | number>): Dec => { let s = Dec.ZERO; for (const x of xs) s = s.add(x); return s; };
