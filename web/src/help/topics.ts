/**
 * Prediction Ledger — reference content: one structure feeds the inline "?" help, the Learn panel and the Learn & Reference page.
 *
 * Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.
 * Licensed under the Apache License 2.0 — see LICENSE and NOTICE in the repository root.
 *
 * Content ported from the 2.1 UI-refresh handoff (pl-content.js), reconciled against docs/ by scripts/check-help-anchors.mjs.
 */

export type HelpGroup = "guide" | "concept" | "trades" | "signals" | "troubleshoot" | "example";

export interface HelpTopic {
  /** Stable, namespaced id: concept.* · guide.* · trades.* · trades.hold.<kind> · signals.* · troubleshoot.* · example.* */
  id: string;
  group: HelpGroup;
  title: string;
  /** What this means. */
  what: string;
  /** What the app is doing (on its own). */
  doing: string;
  /** What you can do next. */
  next: string;
  /** Longer paragraphs for the article view. */
  body: string[];
  /** Repository doc + anchor the topic is derived from (checked by scripts/check-help-anchors.mjs). */
  source: string;
  related: string[];
}

export const GROUPS: { id: HelpGroup; label: string }[] = [
  { id: "guide", label: "Task guides" },
  { id: "concept", label: "Terminology" },
  { id: "trades", label: "Trades & operations" },
  { id: "signals", label: "Markets, signals, paper" },
  { id: "troubleshoot", label: "Troubleshooting" },
  { id: "example", label: "Worked example" },
];

/** The repository copy of the reference; the in-app text is the primary source, this is the secondary link. */
export const REFERENCE_URL = "https://github.com/bitsbetrippin/predictionledger/blob/main/docs/OPERATIONS_REFERENCE.md";
export const REPO_DOCS_URL = "https://github.com/bitsbetrippin/predictionledger/blob/main/";

export const TOPICS: HelpTopic[] = [
  // ── Task guides ──
  {
    id: "guide.first-workflow", group: "guide", title: "Your first useful workflow",
    what: "Import → Transcript → Predictions → Validation plan → Research → Assessment. Each step produces a stored, inspectable artifact.",
    doing: "Guided start derives each step's completion from your actual records (videos, predictions, plans, assessments) — nothing is ticked by hand.",
    next: "Open Setup → Guided start, or follow the next-step hint on any empty state.",
    body: [
      "The ledger is a courtroom, not a pundit: extraction is the clerk, the validation plan is the judge's instructions written before testimony, research is discovery, assessment is the verdict.",
      "Two principles run through it. The test is written before the answer (the plan is versioned and each research run is bound to the exact version it used). The model's memory is not evidence — only pages the app actually retrieved can be cited; a silent web yields Insufficient evidence, never a verdict.",
    ],
    source: "README.md#how-it-works", related: ["guide.import","guide.extract","guide.research"],
  },
  {
    id: "guide.import", group: "guide", title: "Import a video or transcript",
    what: "Four ways in: a YouTube link, a playlist/channel (bulk), a local MP4/MPEG/audio file, or an existing SRT/VTT/TXT/JSON transcript.",
    doing: "YouTube: creator captions first, then auto-captions, then audio download + transcription. Local files are copied into your data folder and transcribed with the engine chosen in Setup. Transcript imports send nothing anywhere.",
    next: "Set the published/recorded date when you know it — deadlines are computed from it and are never guessed.",
    body: [
      "Private, members-only and removed videos cannot be fetched; import a transcript for those.",
      "A followed channel is a bounded subscription: every poll lists newest first, skips what the ledger already has, and queues at most the per-poll budget.",
    ],
    source: "README.md#what-you-can-do-with-it", related: ["guide.extract","troubleshoot.youtube"],
  },
  {
    id: "guide.extract", group: "guide", title: "Extract predictions",
    what: "The model reads the transcript in windows and returns forward-looking claims with an exact quote, timestamps, a normalized statement, deadline and components.",
    doing: "The app locates each quote verbatim in the transcript, resolves dates relative to when the claim was made, splits compound claims into components, and deduplicates repeats. Sports Mode turns picks into team-vs-team with the game as the deadline.",
    next: "Review each extraction: accept, dismiss, edit, merge or split. The original quotation and timestamps are immutable; every edit is a revision.",
    body: [
      "Not predictions: history (\"we crossed 200,000 subscribers in March\"), questions, wishes and past premises. Hedged claims are kept with their modality (\"might\") intact.",
    ],
    source: "docs/WORKED_EXAMPLE.md#2-extraction", related: ["concept.components","concept.deadline-basis"],
  },
  {
    id: "guide.research", group: "guide", title: "Research a prediction",
    what: "Research generates a validation plan first (if none exists), runs its queries, fetches pages, stores evidence and assesses from stored evidence only.",
    doing: "Budgeted searches → guarded page fetches (private/loopback addresses refused) → evidence items whose excerpts must appear verbatim in the page → a verdict with app-enforced rules. Rechecks create a new assessment version; earlier versions stay readable in History.",
    next: "Press Research on a prediction. Optionally review or edit the plan first — edits create a new plan version.",
    body: [
      "Sports picks take a shorter road: one look-up per matchup for winner, score and date; every pick on that game then settles by rule (Hit / Miss / Push).",
    ],
    source: "README.md#what-you-can-do-with-it", related: ["concept.validation-plan","concept.evidence-assessment","concept.time-status"],
  },
  {
    id: "guide.markets", group: "guide", title: "Link a prediction to a market",
    what: "A link between a claim and a prediction-market question is a proposal until you accept it. Only an exact sports matchup auto-links.",
    doing: "Deterministic matching (teams, date, pick type; or term overlap, entities, numbers, deadlines) with model relation labels. Snapshots run on a schedule; the venue's price on the day the claim was made comes from price history.",
    next: "Prediction → Markets tab → Find markets, then accept or reject each proposal.",
    body: [],
    source: "docs/PREDICTION_MARKETS.md", related: ["signals.realized-edge","signals.paper-book"],
  },
  // ── Terminology ──
  {
    id: "concept.evidence-assessment", group: "concept", title: "Evidence assessment",
    what: "What the stored evidence supports: Supported · Partially supported · Contradicted · Insufficient evidence · Not assessable. This is one half of the verdict.",
    doing: "The assessment model proposes; the app's verdict guard enforces rules (G1–G7): invented citations are dropped, announced ≠ implemented, an overall Supported requires every future-claim component supported by in-window evidence, no results ≠ false.",
    next: "Open the Evidence tab to see each item with its stance, date and source; expand 'Rules applied by the app' to see any cap or downgrade.",
    body: [
      "Evidence assessment answers 'what does the record show?'. It is deliberately separate from time status, which answers 'has the clock run out?'.",
    ],
    source: "docs/WORKED_EXAMPLE.md#5-assessment", related: ["concept.time-status","concept.components"],
  },
  {
    id: "concept.time-status", group: "concept", title: "Time status",
    what: "Where the claim sits against its deadline: Deadline pending · Deadline reached · Deadline unknown. The other half of the verdict, computed by the app, never by the model.",
    doing: "Rule G7 derives it from the deadline date. A pending deadline with weak evidence is not a failure — it is pending.",
    next: "If the deadline is unknown, edit the prediction's deadline or the video's published date; the app never guesses one.",
    body: [],
    source: "docs/WORKED_EXAMPLE.md#5-assessment", related: ["concept.evidence-assessment","concept.deadline-basis"],
  },
  {
    id: "concept.validation-plan", group: "concept", title: "Validation plan",
    what: "The test, written before the answer: proposition, working definitions, what would support / contradict / partially fulfil, and neutral, supporting and disconfirming queries.",
    doing: "Generated with the instruction 'do not determine the outcome yet'. The app overwrites the dates block with its own values so the model cannot drift them. Every research run is bound to the exact plan version it used.",
    next: "Edit the plan to add a definition or a query — the edit becomes v2 and the old version remains.",
    body: [],
    source: "docs/WORKED_EXAMPLE.md#3-validation-plan", related: ["guide.research"],
  },
  {
    id: "concept.components", group: "concept", title: "Components: future claim, premise, causal link",
    what: "A compound statement is split into parts of different kinds so evidence attaches to the right one.",
    doing: "Support must attach to the future-claim component, in the window, and be more than proposed or announced. Evidence for a premise ('permits keep being cancelled') never proves the future claim.",
    next: "Split out a component into its own prediction when it deserves separate tracking.",
    body: [],
    source: "docs/WORKED_EXAMPLE.md#5-assessment", related: ["concept.evidence-assessment"],
  },
  {
    id: "concept.independence", group: "concept", title: "Independent vs syndicated sources",
    what: "Sources with the same content hash (or the same publisher) are one voice, not corroboration.",
    doing: "The dossier clusters sources into independence groups; a syndicated copy is kept but marked and does not add independence.",
    next: "Look for a second independent group before treating a component as well supported.",
    body: [],
    source: "README.md#what-you-can-do-with-it", related: ["concept.evidence-assessment"],
  },
  {
    id: "concept.deadline-basis", group: "concept", title: "Deadline and its basis",
    what: "The date by which the claim should be judged, plus how it was derived: rule:relative (statement date + expression), explicit, or unknown.",
    doing: "The date resolver computes it from the time expression and the made-on date. No published date → deadline unknown, never guessed.",
    next: "Set the video's recorded date if the talk was recorded earlier than it was posted.",
    body: [],
    source: "docs/WORKED_EXAMPLE.md#2-extraction", related: ["concept.time-status"],
  },
  {
    id: "concept.provenance", group: "concept", title: "Provenance and hashes",
    what: "Quote hash, transcript hash, source-text hash, first-seen times and analysis versions record what the app knew and when.",
    doing: "A publication date is only a labelled assumption; 'replay as of' counts a source from its first fetch.",
    next: "Use the Dossier tab to replay the evidence set as of an earlier date.",
    body: [],
    source: "README.md#how-it-is-engineered", related: ["concept.independence"],
  },
  // ── Trades & operations ──
  {
    id: "trades.mode", group: "trades", title: "Mode / account",
    what: "paper: decisions are simulated against the venue's book and a separate paper bankroll; nothing is sent. manual_live: you confirm each order after a preview. auto_live: the scheduler places bounded orders while armed.",
    doing: "Shows the saved key's hint, whether this process holds the dispatch lease (one sender per data directory) and whether the private order stream is open.",
    next: "Live modes are enabled only in Setup → Polymarket US account, with a typed acknowledgement.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#the-summary-tiles", related: ["trades.arm-unavailable","trades.pause-disarm"],
  },
  {
    id: "trades.buying-power", group: "trades", title: "Buying power (venue)",
    what: "What the venue says you can spend, and how old that snapshot is.",
    doing: "Orders are refused on a snapshot older than 30 s. A stale snapshot is shown, never acted on.",
    next: "Press Reconcile with venue to refresh; check the key in Setup if it keeps going stale.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#the-summary-tiles", related: ["trades.hold.stale_sync"],
  },
  {
    id: "trades.committed-risk", group: "trades", title: "Committed risk (live)",
    what: "Worst-case cost of the app's own open positions and unfilled reservations.",
    doing: "Does not include positions you placed by hand — those are listed under External holdings and count toward the limits separately.",
    next: "Nothing; the number is derived. Change the caps in Setup → Trading limits (which disarms).",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#the-summary-tiles", related: ["trades.external-holdings"],
  },
  {
    id: "trades.realized-pnl", group: "trades", title: "Realized P&L (official settlements)",
    what: "Only what official settlement activities on your account produced for app orders.",
    doing: "A price of .99 or a research verdict never counts as realized. Only the venue's position-resolution activity settles.",
    next: "Nothing — informational.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#the-summary-tiles", related: ["trades.unrealized"],
  },
  {
    id: "trades.unrealized", group: "trades", title: "Unrealized (marked)",
    what: "App positions marked at the last order book.",
    doing: "Flags STALE when the mark is older than 15 minutes; a stale mark is shown but never used for a decision.",
    next: "Nothing — a refresh re-marks. Stale marks are informational.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#the-summary-tiles", related: ["trades.realized-pnl"],
  },
  {
    id: "trades.holds-alerts-breaker", group: "trades", title: "Holds / alerts / breaker",
    what: "Open holds, open alerts and the circuit-breaker state. closed is healthy; open means repeated venue errors disarmed automation until the cooldown passes.",
    doing: "A hold pauses new app orders on the account until you resolve it; it never cancels, resends or settles anything on its own. Alerts are deduplicated per incident — ×2 means the same thing was seen twice.",
    next: "Resolve each hold with a one-sentence note of what you checked on the venue. Acknowledging an alert hides it; it does not resolve the hold.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#holds", related: ["trades.hold.discrepancy","trades.hold.submission_unknown","trades.alerts"],
  },
  {
    id: "trades.paper-book", group: "trades", title: "US paper book (separate)",
    what: "The paper bankroll for execution-aware paper decisions (depth, fees, partial fills, IOC).",
    doing: "Never summed with live money. Paper decisions reserve capacity and simulate a fill in a separate USD bankroll.",
    next: "Reset the paper book from Trades; decisions and reservations stay as history.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#the-summary-tiles", related: ["trades.mode"],
  },
  {
    id: "trades.external-holdings", group: "trades", title: "External holdings",
    what: "A position on your venue account on a market where the app has no order of its own — placed on the website, or older than the app. Informational, not a problem.",
    doing: "Lists it with the venue's net quantity and cost basis; counts it toward total, per-market and per-event risk limits at cost (or $1 per contract when the venue reports no cost); refuses app entry on that contract (EXTERNAL_POSITION_ON_CONTRACT). Opens no hold, no alert, no pause.",
    next: "Nothing. If hand-placed holdings already exceed the total-risk limit, other contracts skip with TOTAL_RISK_CAP_REACHED until you raise the limit in Setup (which disarms) or they settle.",
    body: [
      "Before 2.0.0-rc.2 these opened discrepancy holds that paused the account. Legacy holds (detail shows intents: []) are resolved automatically on the next reconcile with the note 'reclassified as an external holding'; their alerts close with them.",
    ],
    source: "docs/OPERATIONS_REFERENCE.md#external-holdings", related: ["trades.hold.discrepancy","trades.committed-risk"],
  },
  {
    id: "trades.hold.discrepancy", group: "trades", title: "Hold: discrepancy",
    what: "On a contract where the app has orders, the venue reports a different position than the app's fills (plus known external orders) add up to. Action required.",
    doing: "Paused new orders; keeps reconciling every 30 s while live intents are open; raised one discrepancy alert for the contract. Never adjusts its own records to match the venue silently.",
    next: "Press Reconcile with venue once. If the difference persists, open the contract on the venue, compare Positions and Activity with the ledger row, write what you found in the note and press Resolve.",
    body: [
      "Not this hold: a position on a contract the app never traded — that is an external holding.",
    ],
    source: "docs/OPERATIONS_REFERENCE.md#hold-discrepancy", related: ["trades.external-holdings","trades.holds-alerts-breaker"],
  },
  {
    id: "trades.hold.submission_unknown", group: "trades", title: "Hold: submission unknown",
    what: "The app sent exactly one order request and did not learn the outcome — timeout, dropped connection, 5xx/429, no order id, or a crash right after the 'submitting' marker. Action required.",
    doing: "Kept the reservation (capacity stays held), kept the contract's single entry consumed, paused new orders, and lists candidate venue orders that look like this submission. It never resends and never links a candidate by itself. In automatic mode it also disarmed.",
    next: "Open the venue's order history for that contract. If the order is there, pick it and press 'This order is mine'. If there is none, press 'Venue shows no order' — the reservation is released. One API query is not enough: check the venue's own pages.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#hold-submission_unknown", related: ["trades.intent-states","trades.holds-alerts-breaker"],
  },
  {
    id: "trades.hold.failed_cancel", group: "trades", title: "Hold: failed cancel",
    what: "The app asked the venue to cancel one of its orders and the venue refused or the request failed.",
    doing: "Recorded the failure and paused new orders.",
    next: "Look the order up on the venue: cancel it there if still open; if it filled meanwhile the fill is real and will appear in the ledger. Resolve with what you saw.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#hold-failed_cancel", related: ["trades.holds-alerts-breaker"],
  },
  {
    id: "trades.hold.stale_sync", group: "trades", title: "Hold: stale sync",
    what: "The account snapshot (balances, positions, open orders) could not be refreshed for too long.",
    doing: "Nothing is decided on stale account state.",
    next: "Check the network and the key (Setup → Polymarket US account → Test connection), press Reconcile with venue, resolve.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#hold-stale_sync", related: ["trades.buying-power"],
  },
  {
    id: "trades.hold.stream_gap", group: "trades", title: "Hold: stream gap",
    what: "The private order stream dropped and the REST reconciliation that followed could not account for everything.",
    doing: "Paused new orders until you confirm the record is complete.",
    next: "Press Reconcile with venue; compare the venue's Activity page with the ledger if fills are still missing; resolve.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#hold-stream_gap", related: ["trades.holds-alerts-breaker"],
  },
  {
    id: "trades.hold.settlement", group: "trades", title: "Hold: contested settlement",
    what: "A market you held settled, and the venue's realized amount has the opposite sign from what the app computed from the resolution side.",
    doing: "Held the settlement rather than guess which reading is right.",
    next: "Open the market's settlement on the venue and compare with the ledger row; resolve with what the venue shows, and report the case (SETUP §4.16 item 8).",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#hold-settlement", related: ["trades.realized-pnl"],
  },
  {
    id: "trades.alerts", group: "trades", title: "Alerts: which need action",
    what: "Action required: discrepancy, unknown_submission, failed_cancel, stale_sync (resolve the matching hold). Informational: disconnection, risk_limit, resolution, circuit_breaker, disarmed, emergency_stop.",
    doing: "One alert per incident; a repeat increments ×n instead of opening a new alert. The banner hides acknowledged alerts; the hold, if any, stays open.",
    next: "Resolve holds first; acknowledge informational alerts when read. Re-arm only after reviewing the current policy hash in Setup.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#alerts", related: ["trades.holds-alerts-breaker","trades.pause-disarm"],
  },
  {
    id: "trades.arm-unavailable", group: "trades", title: "Why Arm is unavailable",
    what: "Automatic execution can be armed only against a production-qualified strategy — at least 100 distinct settled events with a market baseline, evaluated on real data (fixtures never count) — plus a connected account and 20 settled paper positions.",
    doing: "The Arm control lists each unmet condition by its actual reason. A qualification report says 'pending' with the number of events still needed; it never rounds up.",
    next: "Run the paper autopilot budget long enough to accumulate settled events; connect the account; then review the policy hash and type the acknowledgement.",
    body: [],
    source: "README.md#roadmap", related: ["trades.mode","trades.pause-disarm"],
  },
  {
    id: "trades.pause-disarm", group: "trades", title: "Pause, disarm, emergency stop, breaker",
    what: "Pause: nothing new is sent, existing orders untouched. Disarm: live mode ends in one statement with one alert naming the reason. Emergency stop: disarm + pause, then cancel every open order the app placed. Breaker: consecutive venue errors open it and disarm.",
    doing: "Anything that changes the policy or the account (limits, budgets, credentials, restart, restore) disarms. Orders you placed elsewhere are never touched by emergency stop — the account-wide cancel is a separate button with its own sentence.",
    next: "Re-arming always requires reviewing the current policy hash (automatic) or the acknowledgement (manual live).",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#pause-disarm-emergency-stop-breaker", related: ["trades.alerts"],
  },
  {
    id: "trades.intent-states", group: "trades", title: "Intent, order and position",
    what: "Three separate books: intent = what the app tried; order = what the venue says; position = what you hold. When they agree only the ledger row shows.",
    doing: "Intent: prepared → reserved → submitting → acknowledged → filled / partially_filled / canceled / rejected; side exits rejected_local, skipped, expired, submission_unknown. Order: pending → open → partial → filled, or canceled / expired / rejected. Position: none, open, settled, unknown, external holding.",
    next: "Open a ledger row for every gate, the forecast's contributions and the fills.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#intent-order-and-position-states", related: ["trades.reason-codes"],
  },
  {
    id: "trades.reason-codes", group: "trades", title: "Decision reason codes",
    what: "Every skipped decision is kept with a code: FORECAST_INSUFFICIENT, FORECAST_STALE, BOOK_MISSING/BOOK_STALE, SYNC_STALE, PROB_NOT_ABOVE_HALF, EDGE_NEGATIVE/EDGE_BELOW_MIN, AT_OR_PAST_CUTOFF/CUTOFF_UNKNOWN, OPPORTUNITY_CONSUMED, OPPOSING_EXPOSURE, OPEN_ORDER_ON_CONTRACT, EXTERNAL_POSITION_ON_CONTRACT, STRATEGY_NOT_QUALIFIED, AUTHORIZATION_SCOPE, and the cap codes.",
    doing: "'No order' is always explained. A decision is pure: fresh book, fresh sync, verified contract, caps, p > .50, fee-aware net edge ≥ .03 after sizing to the venue's increments.",
    next: "Filter the ledger by reason code to see what a limit is blocking.",
    body: [],
    source: "docs/OPERATIONS_REFERENCE.md#decision-reason-codes-you-will-see-in-the-ledger", related: ["trades.intent-states"],
  },
  // ── Markets, signals, paper ──
  {
    id: "signals.realized-edge", group: "signals", title: "Realized edge",
    what: "A creator is measured by what following them would have earned at the market's price, not by hit rate: mean(outcome − market price at made) over settled linked claims.",
    doing: "Shrunk by n/(n+k) toward zero for thin records; combined per market side with one contribution per video.",
    next: "Expand a Signals row for the why.",
    body: [],
    source: "README.md#what-you-can-do-with-it", related: ["signals.gated-label","guide.markets"],
  },
  {
    id: "signals.gated-label", group: "signals", title: "Gated signal labels",
    what: "A label appears only when record, edge, liquidity and deadline all clear their gates. No label is a statement, not an omission.",
    doing: "Consensus groups the same claim across channels weighted by record × recency; splits are shown as splits.",
    next: "Watch rules raise local alerts when a market moves against a signal.",
    body: [],
    source: "README.md#what-you-can-do-with-it", related: ["signals.realized-edge"],
  },
  {
    id: "signals.paper-book", group: "signals", title: "Paper trading (venue-agnostic book)",
    what: "Hypothetical positions at the snapshot price, fixed or fractional-Kelly stakes, marked at every refresh, closed at 1/0 on venue resolution.",
    doing: "Scores the estimate against the market: estimate Brier vs market Brier (lower is better). Never touches a venue account.",
    next: "Open one from a Signals row (Paper buy) or turn on auto-open in Setup.",
    body: [],
    source: "README.md#what-you-can-do-with-it", related: ["trades.paper-book"],
  },
  // ── Troubleshooting ──
  {
    id: "troubleshoot.server", group: "troubleshoot", title: "Cannot reach the local server",
    what: "The dashboard is static files served by the same Node process on 127.0.0.1:7317; if the process stopped, every request fails.",
    doing: "The shell shows one banner and stops polling until the health check succeeds.",
    next: "Run npm start. If the port is busy the server walks to the next one — the terminal prints the URL.",
    body: [],
    source: "docs/SETUP.md", related: [],
  },
  {
    id: "troubleshoot.youtube", group: "troubleshoot", title: "A YouTube video cannot be fetched",
    what: "Private, members-only, age-restricted, geo-blocked and removed videos are refused up front with a distinct message.",
    doing: "yt-dlp is consent-installed and checksum-verified; captions → audio → transcript-import fallback.",
    next: "Import a transcript file for that video instead.",
    body: [],
    source: "docs/SETUP.md", related: ["guide.import"],
  },
  {
    id: "troubleshoot.privacy-pending", group: "troubleshoot", title: "Research stays 'pending'",
    what: "With Privacy → Allow internet access off, the app is restricted to configured local endpoints; outcome research waits.",
    doing: "Nothing leaves the machine; the job stays queued rather than failing.",
    next: "Turn internet access back on in Setup, or stay local and use transcript import + LM Studio.",
    body: [],
    source: "README.md#privacy-and-what-leaves-your-machine", related: ["guide.research"],
  },
  // ── Worked example ──
  {
    id: "example.worked", group: "example", title: "Worked example: a claim becomes a verdict",
    what: "A synthetic, fully labelled walk-through from docs/WORKED_EXAMPLE.md: one statement → extraction → validation plan → research run → assessment → ledger row.",
    doing: "Everything in it is fixture data (fixtures/). No real citation, no real-world outcome. It is kept apart from your records and can never be mixed into them.",
    next: "Open the interactive demonstration in Learn & Reference and step through it.",
    body: [],
    source: "docs/WORKED_EXAMPLE.md", related: ["concept.validation-plan","concept.components","concept.evidence-assessment"],
  },
];

const BY_ID = new Map(TOPICS.map((t) => [t.id, t]));

export function findTopic(id: string): HelpTopic | undefined {
  return BY_ID.get(id);
}

export function topicsByGroup(group: HelpGroup): HelpTopic[] {
  return TOPICS.filter((t) => t.group === group);
}

export function searchTopics(query: string): HelpTopic[] {
  const s = query.trim().toLowerCase();
  if (!s) return TOPICS;
  const words = s.split(/\s+/).filter(Boolean);
  return TOPICS.filter((t) => {
    const hay = [t.title, t.what, t.doing, t.next, t.id, ...t.body].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Where a topic's source text lives in the repository (secondary link; the text above ships in the bundle). */
export function sourceUrl(topic: HelpTopic): string {
  return REPO_DOCS_URL + topic.source;
}

// ---------------------------------------------------------------------------
// Lookups used by the Trades page (one source for the inline help and the Learn panel)
// ---------------------------------------------------------------------------

/** Hold kind (+ subject) → topic. A "settlement:<activity>" subject is the contested-settlement hold. */
export function holdTopic(kind: string, subject?: string): HelpTopic | undefined {
  if (subject?.startsWith("settlement:")) return findTopic("trades.hold.settlement");
  return findTopic(`trades.hold.${kind}`);
}

/** Alert kinds that need the owner (a matching hold to resolve) vs. informational ones. */
export const ACTION_REQUIRED_ALERTS = new Set(["discrepancy", "unknown_submission", "failed_cancel", "stale_sync"]);

export function alertNeedsAction(kind: string): boolean {
  return ACTION_REQUIRED_ALERTS.has(kind);
}

/** Alert kind → the topic that explains it (its hold's topic when one exists, otherwise the general alerts / pause topics). */
export function alertTopic(kind: string): HelpTopic | undefined {
  const byKind: Record<string, string> = {
    discrepancy: "trades.hold.discrepancy",
    unknown_submission: "trades.hold.submission_unknown",
    failed_cancel: "trades.hold.failed_cancel",
    stale_sync: "trades.hold.stale_sync",
    disconnection: "trades.hold.stream_gap",
    risk_limit: "trades.reason-codes",
    resolution: "trades.realized-pnl",
    circuit_breaker: "trades.pause-disarm",
    disarmed: "trades.pause-disarm",
    emergency_stop: "trades.pause-disarm",
  };
  return findTopic(byKind[kind] ?? "trades.alerts");
}

/** One sentence per intent state (kept from 2.0.0-rc.2 help.ts; the long form is trades.intent-states). */
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

export function intentTopic(): HelpTopic | undefined {
  return findTopic("trades.intent-states");
}
