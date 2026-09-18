# Operations reference — what the Trades page is telling you, in plain English

> **In the app (2.1):** every hold, alert, tile and state on the Trades page has a `?` with this text, and *Learn & Reference* (sidebar) holds the full set. This file is the repository copy those topics cite; `scripts/check-help-anchors.mjs` keeps the anchors below in step with `web/src/help/topics.ts`.

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance. Apache-2.0.

This page explains every state, hold and alert you can see on **Trades** and **Setup → Polymarket US account / Automatic execution**: what it means, what the app already did about it on its own, and what only you can do. The Trades page links to the matching section next to each hold and alert. Technical detail lives in [ARCHITECTURE.md §6](ARCHITECTURE.md) and the ADRs in [DECISIONS.md](DECISIONS.md); this page deliberately avoids code names where a sentence will do.

## The one idea behind all of it

The app keeps three separate books and refuses to guess when they disagree:

1. **What the app tried** — the *intent* (decision → reservation → one send).
2. **What the venue says** — the *order* as Polymarket US reports it (acknowledged, filled, cancelled, rejected) and the *activities* (fills, settlements) on your account.
3. **What you hold** — the *position* on the venue.

When 2 and 3 line up with 1, nothing is shown but the ledger row. When they do not, the app does one of two things: it records an **external** fact (something on your account the app did not cause) or it opens a **hold** (something the app cannot explain by itself). A hold pauses *new* app orders on that account until you resolve it; it never cancels, resends or settles anything on its own. An **alert** is the notification of a hold or of an event worth knowing; alerts are deduplicated per incident, so "×2" means the same thing was seen twice, not two problems.

## The summary tiles

| Tile | Meaning |
|---|---|
| **Mode / account** | `paper`: decisions are simulated against the venue's book and a separate paper bankroll; nothing is sent. `manual_live`: you confirm each order after a preview. `auto_live`: the scheduler places bounded orders while armed. "key …xxxx · connected · lease held · stream open" = the saved key validated, this process is the one allowed to send, and the private order stream is connected. |
| **Buying power (venue)** | What the venue says you can spend, and how old that snapshot is. Orders are refused on a snapshot older than 30 s. |
| **Committed risk (live)** | Worst-case cost of the app's own open positions and unfilled reservations. **Does not include** positions you placed by hand — those are under *External holdings* and count toward the limits separately. |
| **Realized P&L (official settlements)** | Only what official settlement activities on your account produced for app orders. A price of .99 or a research verdict never counts. |
| **Unrealized (marked)** | App positions marked at the last book; "stale" when the mark is older than 15 minutes. |
| **Holds / alerts / breaker** | Open holds, open alerts, circuit-breaker state (`closed` is healthy; `open` means repeated venue errors disarmed automation until the cooldown passes). |
| **US paper book (separate)** | The paper bankroll. Never summed with live money. |

<a name="external-holdings"></a>
## External holdings (positions you placed by hand)

A position on your Polymarket US account on a market where **the app has no order of its own** — placed on the website, or older than the app — is an *external holding*. Since 2.0.0-rc.2 the app:

- lists it under **External holdings** with the venue's net quantity (+ long YES / − short) and cost basis;
- counts it toward your **total, per-market and per-event risk limits** at the venue's cost basis (or, when the venue reports no cost, at $1 per contract — the most a binary contract can lose). This is deliberate: the pilot limits describe the whole account, not just the app's part. If your hand-placed holdings already exceed the total-risk limit, app decisions on *other* contracts will skip with `TOTAL_RISK_CAP_REACHED` until you raise the limit in Setup → Trading limits (which disarms) or the holdings settle;
- **refuses app entry on that same contract** (`EXTERNAL_POSITION_ON_CONTRACT`), so the app never pyramids onto a position you chose by hand;
- does **not** open a hold or an alert for it, and does not pause the account.

Before 2.0.0-rc.2 (releases 1.13–2.0.0-rc.1) any venue position the app could not account for opened a `discrepancy` hold. Those legacy holds — recognisable by `"intents":[]` in their detail — are resolved automatically on the next reconcile with the note "reclassified as an external holding"; their alerts close with them. Nothing else changes: the positions stay yours, on the venue, untouched.

If you *sell* part of an app position on the website, that is different: the app has an order on that contract, the sale shows up as an external order (a `SELL` on the venue) and the expected position is adjusted by it; only a mismatch that the app's orders plus the external orders cannot explain becomes a discrepancy.

<a name="holds"></a>
## Holds

Every hold shows its kind, when it opened, the contract or intent it concerns, and a detail line. Each needs a **resolution note** — one sentence saying what you checked on the venue. Resolving a hold records your note in the audit trail and lifts the pause once no holds remain.

<a name="hold-discrepancy"></a>
### discrepancy

**Meaning.** On a contract where the app *has* orders, the venue reports a different position than the app's fills (plus any external orders it knows about) add up to. Example detail: `{"venueNet":"13","localNet":"19","intents":["…"]}`.

**Typical causes.** You sold or bought more on the website while an app position was open; a fill arrived on the venue that the app has not received yet (reconcile again first); a settlement or correction the app has not read yet.

**What the app did.** Paused new orders; keeps reconciling every 30 s while live intents are open; raises one `discrepancy` alert per contract.

**What you do.** Press *Reconcile with venue* once. If the difference persists, open the contract on the venue, compare Positions and Activity with the ledger row, write what you found in the note and press *Resolve*. The app never adjusts its own records to match the venue silently — your note is the reconciliation.

**Not this hold:** a position on a contract the app never traded (see *External holdings* above).

<a name="hold-submission_unknown"></a>
### submission_unknown

**Meaning.** The app sent exactly one order request and did not learn the outcome: the request timed out, the connection dropped, the venue answered with a 5xx or a 429, the answer came back without an order id, or the process crashed right after the "submitting" marker was written.

**What the app did.** Kept the reservation (capacity stays held), kept the contract's single entry opportunity consumed, paused new orders on the account, and — while reconciling — lists *candidate* venue orders that look like this submission (same contract, side, quantity, price, created around the same time). It **never resends** and **never links a candidate by itself**; a same-looking order is not proof of identity. In automatic mode it also disarms.

**What you do.** Open the venue's order history for that contract. If you find the order, pick it in the candidate list and press *This order is mine* (only an order on the same contract and side with a matching quantity is accepted). If there is no such order, press *Venue shows no order* — the reservation is released and the contract can be traded again. Absence from one API query is not enough to declare that: check the venue's own pages.

<a name="hold-failed_cancel"></a>
### failed_cancel

**Meaning.** The app asked the venue to cancel one of its orders (a targeted cancel, or the emergency stop's sweep) and the venue refused or the request failed.

**What you do.** Look the order up on the venue: if it is still open, cancel it there; if it filled meanwhile, the fill is real and will appear in the ledger. Resolve with what you saw.

<a name="hold-stale_sync"></a>
### stale_sync

**Meaning.** The account snapshot (balances, positions, open orders) could not be refreshed for too long; nothing is decided on stale account state.

**What you do.** Check the network and the key (Setup → Polymarket US account → *Test connection*), press *Reconcile with venue*, resolve.

<a name="hold-stream_gap"></a>
### stream_gap

**Meaning.** The private order stream dropped and the REST reconciliation that follows could not account for everything.

**What you do.** Press *Reconcile with venue*; compare the venue's Activity page with the ledger if fills are still missing; resolve.

<a name="hold-settlement"></a>
### settlement:… (contested settlement)

**Meaning.** A market you held settled, and the venue's reported *realized amount* has the opposite sign from what the app computed from the resolution side. The venue does not document whether `positionResolution.side` names the winning side or your side; a contradiction is the first real signal either way.

**What you do.** Open the market's settlement on the venue and compare with the ledger row; resolve with what the venue shows, and report the case (SETUP §4.16 item 8) — it fixes the reading for everyone.

<a name="alerts"></a>
## Alerts

| Alert | Meaning | What you do |
|---|---|---|
| <a name="alert-discrepancy"></a>**discrepancy** | A reconcile saw a position mismatch on a contract with app orders. | Resolve the matching hold; the alert closes with it. |
| <a name="alert-unknown_submission"></a>**unknown_submission** | An order's outcome is unknown; the account is paused. | Resolve through the hold. |
| <a name="alert-disconnection"></a>**disconnection** | The private order stream closed. The app reconnects with backoff and reconciles by REST meanwhile. | Nothing unless it repeats; then check the network and key. |
| <a name="alert-failed_cancel"></a>**failed_cancel** | A cancel failed. | Cancel on the venue if still open; resolve the hold. |
| <a name="alert-risk_limit"></a>**risk_limit** | A limit blocked an evaluation today (`ORDER_BUDGET_ZERO`, `DAILY_CAP_REACHED`, `TOTAL_RISK_CAP_REACHED`, `MARKET_CAP_REACHED`, `EVENT_CAP_REACHED`, `DAILY_LOSS_STOP`). | Nothing unless the limit is wrong for you: change it in Setup → Trading limits (disarms; re-arm after reviewing the new hash). |
| <a name="alert-stale_sync"></a>**stale_sync** | The account could not be synced before a tick. | Check the connection; reconcile. |
| <a name="alert-resolution"></a>**resolution** | A market you hold settled officially (info). | Nothing. |
| <a name="alert-circuit_breaker"></a>**circuit_breaker** | Repeated venue errors (not 400/404) reached the threshold: automation is disarmed; reads and cancels keep working; the breaker closes after the first success past the cooldown. | Wait; check the venue status; re-arm deliberately. |
| <a name="alert-disarmed"></a>**disarmed** | Live trading returned to disarmed. The message names the reason: restart, limits or budgets changed (new policy hash), credential change, backup restore, unknown submission, discrepancy, breaker, or your own disarm. | Read the reason; re-arm in Setup only after reviewing the current policy hash. |
| <a name="alert-emergency_stop"></a>**emergency_stop** | You pressed Emergency stop: disarmed and paused in one step, then every open order the app placed was targeted for cancellation (orders you placed elsewhere were not touched). | Resolve anything left, reconcile, *Resume new orders*, re-arm when ready. |

Acknowledging an alert hides it from the banner; it does not resolve the underlying hold.

## Intent, order and position states

**Intent (what the app tried):** `prepared` → `reserved` (capacity held, the contract's one entry opportunity consumed) → `submitting` (marker written, the single POST in flight) → `acknowledged` (the venue returned an id — not a fill) → `filled` / `partially_filled` / `canceled` / `rejected`. Side exits: `rejected_local` (never sent, or refused outright — nothing created, reservation released), `skipped`, `expired` (recovered after a restart before it was ever sent), `submission_unknown` (see the hold).

**Order (what the venue says):** `pending` → `open` → `partial` → `filled`, or `canceled` / `expired` / `rejected`; `cancel_pending` while a cancel is in flight. A cancelled order can still have fills; the fills are kept. Orders you placed on the website appear as **external** orders with no rationale.

**Position (what you hold):** `none`, `open`, `settled` (official settlement seen), `unknown` (an unknown submission may or may not have created it), and — for contracts the app never traded — **external holding**.

## Pause, disarm, emergency stop, breaker

- **Pause new orders** — nothing new is sent; existing orders and positions are untouched; *Resume* lifts it. Holds pause automatically; you pause by hand.
- **Disarm** — live mode ends; every disarm is one database statement and raises one `disarmed` alert. Anything that changes the policy or the account (limits, budgets, credentials, restart, restore) disarms; so do an unknown submission, a discrepancy and the breaker. Re-arming always requires reviewing the current policy hash (Setup → Automatic execution) or the acknowledgement (manual live).
- **Emergency stop** — disarm + pause in one statement, then cancel every open order the app placed. Orders you placed elsewhere are never touched by it; *Cancel every open order on this account* is a separate button with its own sentence.
- **Circuit breaker** — counts consecutive venue errors; at the threshold it opens (automation disarmed, one alert), goes half-open on the first success after the cooldown, and closes on the next.

## Decision reason codes you will see in the ledger

`FORECAST_INSUFFICIENT` (no usable creator history), `FORECAST_STALE`, `BOOK_MISSING` / `BOOK_STALE` (no fresh order book), `SYNC_STALE` / `SYNC_MISSING`, `PROB_NOT_ABOVE_HALF` (the chosen side is not above 50 %), `EDGE_NEGATIVE` / `EDGE_BELOW_MIN` (not enough edge after fees at the worst permitted price), `CUTOFF_PASSED` / `CUTOFF_UNKNOWN`, `OPPORTUNITY_CONSUMED` (the contract's single entry was already used), `OPPOSING_EXPOSURE`, `OPEN_ORDER_ON_CONTRACT`, `EXTERNAL_POSITION_ON_CONTRACT` (you already hold it by hand), `STRATEGY_NOT_QUALIFIED`, `AUTHORIZATION_SCOPE` (outside the armed strategy/category), and the cap codes listed under *risk_limit*. Every skipped decision is kept with its codes; "no order" is always explained.

## The scenario from 2026-09-17 (six holds, two alerts)

Six positions placed by hand on the venue (e.g. 203 contracts on `tec-nfl-champ-2027-02-14-w-kanchi`, a short of −44.25 on `aec-atp-sasgue-ugobla-2026-09-16`) were found by the first reconcile on 2026-09-16 20:43. The app had no order on any of them (`"intents":[]`), so the 1.13 rule opened a `discrepancy` hold for each and paused the account. On 2026-09-17 two of the six markets were still open on the venue, so the 1.14 reconcile raised two `discrepancy` alerts (×2 = seen by two reconciles). With 2.0.0-rc.2 the next reconcile lists all six as *External holdings*, resolves the six holds with the reclassification note, closes the two alerts, and — since the app has no orders — shows *Committed risk (live) $0.00* while counting the holdings' cost basis toward the total-risk limit.
