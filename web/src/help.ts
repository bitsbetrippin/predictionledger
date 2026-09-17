/**
 * Prediction Ledger — plain-English help for the operational states shown on the Trades page (2.0.0-rc.2).
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * One sentence per state: what it means, and what you do. The full reference (causes, what the app does on its own,
 * what only you can do) is docs/OPERATIONS_REFERENCE.md; every entry links to its anchor there.
 */

export const REFERENCE_URL = "https://github.com/bitsbetrippin/predictionledger/blob/main/docs/OPERATIONS_REFERENCE.md";

export const HOLD_HELP: Record<string, { what: string; you: string; anchor: string }> = {
  discrepancy: { what: "The venue reports a different position on this contract than the app's own orders account for.", you: "Compare with the venue's Positions page; if the difference is an order you placed by hand on the same contract as an app order, note that and resolve. Holds on contracts where the app has no order are reclassified as external holdings automatically on the next reconcile.", anchor: "hold-discrepancy" },
  submission_unknown: { what: "The app sent an order but never learned whether the venue created it (timeout, lost response, 429, or a crash right after sending).", you: "Check the venue's order history: if you find the order, choose it as a candidate ('This order is mine'); if there is none, choose 'Venue shows no order'. The app never re-sends on its own.", anchor: "hold-submission_unknown" },
  failed_cancel: { what: "A cancel request for an app order failed or was refused by the venue.", you: "Check the order on the venue; cancel it there if it is still open, then resolve with what you did.", anchor: "hold-failed_cancel" },
  stale_sync: { what: "The account snapshot could not be refreshed for too long.", you: "Check the connection and the key in Setup, press Reconcile with venue, then resolve.", anchor: "hold-stale_sync" },
  stream_gap: { what: "The private order stream dropped and reconciliation could not fill the gap.", you: "Press Reconcile with venue; if fills are still missing compare with the venue's activity page, then resolve.", anchor: "hold-stream_gap" },
  "settlement:": { what: "A market settled, but the venue's realized amount contradicts the app's reading of which side won (contested settlement).", you: "Compare the venue's statement for this market with the ledger row; resolve with what the venue shows. Report the case — it decides how positionResolution.side should be read.", anchor: "hold-settlement" },
};

export const ALERT_HELP: Record<string, { what: string; you: string; anchor: string }> = {
  discrepancy: { what: "A reconcile saw a position mismatch on a contract where the app has its own orders (see the hold with the same contract).", you: "Resolve the matching hold; the alert closes with it.", anchor: "alert-discrepancy" },
  unknown_submission: { what: "An order's outcome is unknown; new orders are paused.", you: "Resolve it through its hold (link the venue order, or declare that none exists).", anchor: "alert-unknown_submission" },
  disconnection: { what: "The private order stream closed; the app falls back to periodic reconciliation and reconnects with backoff.", you: "Nothing, unless it repeats — then check the network and the key.", anchor: "alert-disconnection" },
  failed_cancel: { what: "A cancel failed.", you: "Cancel on the venue if the order is still open; resolve the hold.", anchor: "alert-failed_cancel" },
  risk_limit: { what: "A risk limit blocked an evaluation today (order budget, daily cap, total risk, per-market/event cap, loss stop).", you: "Nothing, unless the limit is wrong for you — change it in Setup → Trading limits (this disarms).", anchor: "alert-risk_limit" },
  stale_sync: { what: "The account could not be synced; no order is placed on stale state.", you: "Check the connection; press Reconcile with venue.", anchor: "alert-stale_sync" },
  resolution: { what: "A market you hold settled officially (informational).", you: "Nothing; check the ledger row's P&L if you like.", anchor: "alert-resolution" },
  circuit_breaker: { what: "Repeated venue errors opened the circuit breaker; automation is disarmed until it closes after the cooldown.", you: "Wait for the cooldown; check the venue status; re-arm deliberately.", anchor: "alert-circuit_breaker" },
  disarmed: { what: "Live trading returned to disarmed (restart, limit/budget/credential change, unknown submission, discrepancy, breaker or your own action).", you: "Read the reason; re-arm in Setup only after you have reviewed the current policy hash.", anchor: "alert-disarmed" },
  emergency_stop: { what: "You pressed Emergency stop: disarmed, paused, app-owned open orders cancelled.", you: "Resolve anything left, reconcile, then Resume and re-arm when ready.", anchor: "alert-emergency_stop" },
};

export const INTENT_HELP: Record<string, string> = {
  prepared: "Decision made, nothing reserved yet.",
  reserved: "Capacity reserved and the contract's single entry opportunity consumed; not sent yet.",
  submitting: "The dispatch marker is written; the one and only POST is in flight.",
  acknowledged: "The venue returned an order id (not a fill).",
  filled: "Every contract filled.",
  partially_filled: "Some contracts filled; the remainder was cancelled (IOC).",
  canceled: "Cancelled before any fill.",
  rejected: "The venue created the order and then rejected it.",
  rejected_local: "Never reached the venue, or the venue refused it outright (nothing created); the reservation was released.",
  skipped: "Not eligible when evaluated.",
  expired: "Recovered after a restart before it was ever sent.",
  submission_unknown: "Sent, outcome unknown — held for you; never re-sent.",
};

export function holdHelp(kind: string, subject?: string) {
  if (subject?.startsWith("settlement:")) return HOLD_HELP["settlement:"];
  return HOLD_HELP[kind];
}
