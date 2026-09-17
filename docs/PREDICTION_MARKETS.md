# Prediction markets — integration framework (1.5 → 1.12)

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## Why

Prediction Ledger already has one side of a trade: **what people on video claim will happen, and whether it did.** A prediction market is the other side: **what money says will happen, right now, and how much money is behind it.** Put the two together and a prediction stops being a row in a table and becomes a *position* — a creator says X, the market prices X at 31 %, and the ledger knows how often that creator has been right on things like X.

The mental model is a **ledger with two columns**: our extracted claims (with their eventual truth) on the left, the market's live odds and liquidity on the right, joined by a **link** that says "this claim is a bet on that market's *Yes* side". Everything in this document is about building that join carefully, in small releases, without ever letting the app place a trade until that is a deliberate decision.

## Ground rules (carry through every release)

- **Read-only until a separate decision.** Market data is public and unauthenticated. Trading needs a wallet, an API key, funds, and — for Polymarket international — is geo-restricted (US users are blocked from trading; the `restricted: true` flag you see on markets means exactly that). The app shows odds and liquidity from these venues and never touches their order endpoints. *That separate decision has since been taken for one venue only:* **Polymarket US** (a distinct, CFTC-regulated USD exchange) has its own execution track — ADR-030 in docs/DECISIONS.md — with its own adapter, vault and release gates. 1.10 ships only the account connection and reads; no order can be placed by that build either.
- **Local first, like everything else.** Market snapshots are stored in SQLite; nothing leaves the machine except the GET requests to the venue, and only when Setup → Privacy → internet is on.
- **A market's rules are the claim.** Every market has a resolution text ("resolves Yes if…"). A link between a prediction and a market is only valid if the *prediction's proposition* and the *market's rules* mean the same thing. That match is the hard problem, not the HTTP.
- **Probabilities, not prices.** Internally a market outcome is a probability in 0–1. Odds formats are presentation.
- **Snapshots, never live state.** A stored price carries `retrievedAt`. A creator's claim is compared with the market *as it was when they said it* (or the nearest snapshot we have), not with today's price.

## What Polymarket exposes (verified live 2026-09-15 from this sandbox — no account needed)

| API | Base | Auth | Used for |
|---|---|---|---|
| Gamma | `https://gamma-api.polymarket.com` | none | markets, events, tags, search, outcome prices, liquidity, volume, resolution text |
| CLOB | `https://clob.polymarket.com` | none for reads | order book (`/book?token_id=`), midpoint (`/midpoint`), price history (`/prices-history`) |
| CLOB trading | same | wallet signature + L2 API key | **not used** |

Shapes worth knowing (the adapter normalises them):

- A **market** is one binary question (`question`, `description` = the rules, `endDate`, `conditionId`). `outcomes`, `outcomePrices` and `clobTokenIds` arrive as JSON *strings* inside JSON (`'["Yes","No"]'`). Prices are probabilities as strings. `liquidity`/`volume` are strings, `liquidityNum`/`volumeNum` numbers, `volume24hr` a number.
- An **event** groups markets under one headline ("Lions vs. Bills" = 315 markets: moneyline, spread, totals, props; "Pro Football: 2027 Champion" = 33 team markets). Sports games are events; the moneyline market inside is what a sports pick maps to.
- **Search**: `GET /public-search?q=…&limit_per_type=N&events_status=active` returns events with nested markets. Relevance is loose (“Bills Chiefs” returns the championship event), so matching must be done on our side (1.6).
- **Tag filter** works on `/events?tag_slug=nfl` (and is ignored on `/markets`).
- **Order book**: `bids`/`asks` as `{price, size}` strings; `size` is in shares, so notional depth ≈ Σ size × price.
- Pagination is `limit`/`offset`; `order=volume24hr&ascending=false` sorts. No documented rate limit was hit at probe cadence; the adapter still goes through the app's rate limiter in 1.6.

Try it now, nothing to configure:

```
npm run markets -- search "Bitcoin 100k"
npm run markets -- tag nfl
npm run markets -- market xi-jinping-out-before-2027
npm run markets -- book <clobTokenId from any listing>
```

and from the running app: `GET /api/markets/search?q=…`, `GET /api/markets?tag=nfl`, `GET /api/markets/polymarket/market/<id|slug>`, `GET /api/markets/polymarket/book/<tokenId>`.

## Architecture (what gets added, and where it sits)

```
                 videos → transcripts → predictions ──┐
                                                       │  prediction_market_links   (1.6)
   MarketProvider (Polymarket, …) → markets ───────────┤  match score, side, rationale, status
        │                            market_snapshots  │
        └── snapshot job (1.6) ──────┘  price/liq/vol  │
                                                       ▼
                       assessments (truth)   +   snapshots (odds)   →   signals (1.7)
                                             creator track record, edge, confidence
```

- `providers/markets/types.ts` — `MarketProvider` interface (`search`, `get`, `list`, `book`, `priceHistory`). Same pattern as `SearchProvider` / `LanguageModelProvider`: the app talks to the interface; Polymarket was the first adapter, Manifold the second (1.8); Kalshi can be added without touching callers.
- `providers/markets/polymarket.ts` — the adapter (1.5, shipped).
- Tables (1.6): `markets` (venue id, question, rules, outcomes with token ids, end date, event), `market_snapshots` (market id, retrieved at, per-outcome price, best bid/ask, liquidity, volume 24h), `prediction_market_links` (prediction id, market id, side = outcome label, match score, how matched, user status accepted/rejected, notes).
- Jobs (1.6): `market.snapshot` (refresh the linked markets on a schedule and on demand), `market.match` (propose links for a prediction).

## Release plan

### 1.5 — Read-only connector (this patch)
*Goal: prove the wire. See a market, its two sides, and the money behind it, from inside the app.*

- `MarketProvider` interface + Polymarket adapter, stubbed-fetch tests (shapes copied from live responses).
- `npm run markets` probe (search / tag / market / book) — no account, no key.
- `GET /api/markets…` pass-through routes, gated by the internet setting. No storage yet.
- Docs: this file; CHANGELOG; ADR-025 (read-only, provider-interface, no trading).
- Acceptance: probe and routes return live data; offline mode refuses with the standard message; a venue 4xx/5xx surfaces as `502 market_api` with the venue text, never as a verdict.

### 1.6 — Markets in the ledger — **shipped 1.6.0**
*Goal: a prediction can point at a market, and the app remembers what the market said.*
Delivered as written below, with these specifics: matching is deterministic first (`analysis/markets.ts`) and the model only labels relations for general predictions; `priceAtMade` uses the snapshot taken when the link is created (the `/prices-history` backfill moves to 1.7); the refresh timer runs inside the server process while the app is open.

- Migration 008: `markets`, `market_snapshots`, `prediction_market_links`.
- `market.snapshot` job: stores a snapshot for every linked (or watched) market; runs on demand and on an interval set in Setup → Markets (default 6 h, budgeted through the rate limiter). History endpoint `/prices-history` backfills the price at the prediction's `madeOnDate` when a link is created late.
- **Matching, proposal-only.** `market.match` builds queries from the prediction (entities, normalized statement, deadline; for sports picks: teams + game date → the event's moneyline/spread/total market), runs `search`, and scores candidates by: entity overlap, deadline proximity (market `endDate` vs prediction deadline), rule/proposition similarity (one small model call that returns *same / narrower / broader / different* plus a one-line rationale), and sport-specific exact matching (team names + game date is deterministic). It writes proposals with a score; the **user accepts or rejects** in the detail panel. Nothing is auto-linked except sports picks with an exact game match.
- UI: "Markets" tab in the prediction detail — proposed and accepted links, current price of the linked side, liquidity, spread, a link to the venue; a Markets page listing watched markets and their latest snapshots.
- Settings: Setup → Markets (provider on/off, refresh interval, snapshot budget, tag watchlist).
- Acceptance: link a sports pick to its game's moneyline automatically; link a general prediction by accepting a proposal; snapshots accumulate; export includes links and snapshots; offline leaves everything pending.

### 1.7 — Signals: creator vs. market — **shipped 1.7.0**
Delivered: `/prices-history` backfill (`market.backfill`), creator records per channel with realized edge / Brier, shrunk-edge estimate with settled-count weighting (one contribution per video), gated labels with reasons, Signals page. Deviations: the Brier numbers are reported but the *label* is driven by realized edge; calibration by topic/horizon is not yet modelled (1.8+).
*Goal: turn "creator said X" + "market says p" + "creator's history" into a number you can argue with.*

- **Implied side.** A prediction's normalized statement maps to a market side (Yes/No or a team). The link stores it.
- **Creator record.** Per speaker/channel, over settled predictions: hit rate, and — where a market snapshot existed at `madeOnDate` — the *Brier score* of taking the creator's side at the market's price versus the market alone. This is the honest measure: a creator who only calls 95 % favourites is not a source of edge.
- **Edge estimate.** For an open prediction with a linked market: `edge = p_creator − p_market`, where `p_creator` is a calibrated probability from the creator's record on similar predictions (topic, horizon), shrunk toward the market price when the record is thin (Bayesian shrinkage with an explicit prior weight shown in the UI). Multiple creators on the same market aggregate by weighting each by track record and independence (same source video ≠ two opinions).
- **Confidence label** on the linked side: *lean / moderate / strong* only when (a) the record has ≥ N settled predictions of that kind, (b) the market has enough liquidity that the price means something (threshold in Setup), and (c) the deadline is consistent. Otherwise *no signal* — the app must not manufacture confidence from one video.
- Dashboard: a Signals view — market, side, market price, our estimate, edge, confidence, contributing predictions, liquidity; sortable; every number clicks through to the evidence.
- Acceptance: fixtures with synthetic settled histories produce the expected Brier/edge numbers; a creator with two predictions gets *no signal*; a sports moneyline with a settled game shows the realised outcome next to the pre-game price.

### 1.8 — Multi-channel weighting and market watch — **shipped 1.8.0 (except paper trading)**
Delivered: playlist/channel bulk import with auto-extract, consensus propositions (by market / by text, split shown), watch rules with local deduped alerts, Manifold as the second venue. Not delivered, by design: order placement (never). The paper-trading ledger shipped in **1.9.0** (migration 011, Paper page, fixed / fractional-Kelly sizing, auto-open on labelled signals, estimate-vs-market Brier on resolved positions).
*Goal: the range of bets across many channels, and a watchlist that tells you when the market moves against the consensus.*

- Bulk ingestion: playlists/channels (YouTube) and transcript batches, tagged by source; dedupe the *same claim* across videos into one proposition with many endorsements.
- Consensus per market side: weighted by creator record and recency; disagreement shown explicitly (a split room is information).
- Watch rules (local, no notifications outside the machine unless you add one): "market moved > X points since last snapshot", "consensus and market diverge by > Y", "market resolves within Z days and our side is pending".
- Second venue (Kalshi or Manifold) behind the same interface, to check that the abstraction holds and to compare prices across venues.
- Deferred, needs its own decision: any order placement; paper-trading ledger (record hypothetical positions and their P&L against snapshots) is the safe intermediate and is probably the right next step before real money is ever discussed.

## Polymarket US (1.10, read-only foundation)

A third venue behind the same `MarketProvider` interface, and the only one with an execution track. Verified live 2026-09-16 from this sandbox (public data, no account):

| API | Base | Auth | Used for |
|---|---|---|---|
| Gateway | `https://gateway.polymarket.us` | none | `/v1/search`, `/v1/markets`, `/v1/market/slug/{slug}`, `/v1/market/id/{id}`, `/v2/leagues/{league}/events`, `/v1/markets/{slug}/book`, `/v1/markets/{slug}/bbo`, `/v1/price-history` |
| Retail API | `https://api.polymarket.us` | key ID + Ed25519 signature | **1.10: reads only** — `/v1/account/balances`, `/v1/portfolio/positions`, `/v1/orders/open`; targeted cancel wired but unused |

Shapes worth knowing: one instrument per market (YES); NO is synthetic and `price.value` is always the YES price (buy NO at $0.40 = `ORDER_INTENT_BUY_SHORT` at `0.60`). `marketSides[]` carry durable ids and a `long` flag — the deprecated `outcomes` array's order varies, so it is never used for orientation. Markets publish `orderPriceMinTickSize`, `minimumTradeQty` (contracts; `0.01` = partial contracts), `feeCoefficient` (Θ in `Θ·C·p·(1−p)`; 0.06 on 2026-09-16 with a published change to 0.0695), `status`, `sportsMarketTypeV2`, `line`, `gameStartTime`. Books come wrapped as `{ marketData: { bids, offers, state } }`; price history takes a slug and needs `fidelity=1` for timestamp ranges. Balances arrive as JSON numbers, positions as decimal strings. No stable account identifier, no idempotency key, no retail sandbox — ADR-031 records the evidence and the resulting design.

Try it: tick **Polymarket US** under Setup → Venues and search from the Markets page; `GET /api/markets/search?q=bitcoin&provider=polymarket_us`; with an account, Setup → Polymarket US account → Test connection.

## Verified contracts (1.11)

Similarity got a link *proposed* and a human got it *accepted*; neither says the contract settles on the claim's terms. 1.11 adds a **contract verification** per link: a computed checklist over the venue's rules text and constraints against the stored claim (and the stored game record for sports picks). Sports: league, both teams, game date and start, market type, line and sign, period, overtime and tie/void rules, side. General: subject, proposition semantics (touches vs closes above vs cumulative), comparator, threshold, units, observation window, geography, measurement source, side. Always: venue, market open, rules hash, question, settlement conditions, trading close and the earliest pre-event cutoff. The status is derived — `verified_equivalent` only when every required field verified — and no route can set it; a documented fact with its source may fill a missing non-gate field, never an incompatible one. Revalidation marks a version stale when the rules hash, schedule, market status, side ids or the claim itself change; editing the prediction does the same immediately. Only Polymarket US links can verify at all; Polymarket international and Manifold links are `research_only` by construction. `POST /api/predictions/:id/us-candidates` finds US contracts (or reads a pasted event URL) and answers none / one / multiple; `POST /api/market-links/:id/verify-contract` runs the checklist; ADR-032 records the rules, including the "unqualified pick = full game" convention.

Provenance landed in the same release: subscriptions (Library → *Follow a channel or playlist*) with per-poll budgets, first-seen times and content hashes on videos and sources, independence groups after every research run, an evidence dossier with dissent and an as-of replay, and forecast-purpose research that never becomes a verdict. Nothing in 1.11 places, previews or prepares an order.

## Forecasts and paper decisions (1.12)

The forecast is the §7 baseline estimator over the **trading cohort** — verified, pre-claim-priced, officially resolved observations only — added to one fresh YES midpoint; it is frozen with its inputs and hash. The decision is a pure function with every gate reported (freshness of book, sync and forecast; cutoff minus buffer; verified, unchanged contract; opposing exposure; caps; probability strictly above .50; net edge at least .03 after fee-aware, increment-aligned sizing). Capacity is reserved in the decision's own transaction, one entry per contract, and paper fills walk the venue's depth at the limit with fees and IOC cancellation in a separate USD bankroll. The Trades page shows all of it, skipped decisions included. ADR-033 has the rules.

## Manual-live execution (1.13)

A manual-live decision (`needs_review`) can be **previewed** (re-decided with a fresh book and account, the venue's own preview, everything shown, bound to the decision's hash, 60 s) and **confirmed** once by the owner. The app reserves, commits a dispatch marker (policy still armed, lease held, no holds) and sends **one** bounded limit immediate-or-cancel; NO orders go to the wire as the YES price converted exactly once. A lost answer is an *unknown* submission — held, paused, listed with candidates for the owner, never resent; a rejection releases; fills arrive by stream and by reconciliation and are unique by execution and trade id; a cancel keeps the fills; orders from the website stay *external* with no rationale; only the venue's position-resolution activity settles, corrections included. Arming needs the typed acknowledgement in Setup; restarts, limit edits, backups and credential changes disarm. Automation arrived in 1.14 (below). The owner smoke test (SETUP §4.14) is the only live check and is pending. ADR-034 has the rules.

## Automatic execution (1.14)

The scheduler is a small timer inside the server (not a job): every tick it polls the saved channels' new picks into `market.match`, verifies accepted links as reviewer "app", re-validates stale verifications, and lists candidates that are verified, unchanged, open, before cutoff minus the buffer, not yet consumed and outside the re-evaluation window — bounded per tick and per creator. Each candidate is decided by the same pure function as 1.12; an eligible one, **only while armed**, goes through the 1.13 preview → send path with the *automatic* indicator, one entry per contract, never a top-up, never a catch-up after cutoff. Arming is a separate route that needs the exact acknowledgement, the policy hash you reviewed (limits + budgets + timezone), a category with a **production** qualification for the current strategy version, and 20 settled paper positions; fixtures never qualify, so in a fresh install the Arm button explains why it is unavailable. Any change — limits, budgets, credentials, restart, restore, an unknown submission, a discrepancy, the circuit breaker — returns to disarmed in one statement and raises one alert. **Emergency stop** disarms and pauses in one statement, then cancels every unfilled order the app placed (nothing you placed on the website); the account-wide cancel is a separate button with its own sentence. The Trades page carries the summary tiles, the ledger (intent / order / position / mark, stale marks flagged, external rows labelled, every skipped decision with its reason), filters, CSV/JSON export without secrets, alerts and the automation runs. ADR-035 has the rules; SETUP §4.15 is the owner acceptance list.

## Open questions for the product owner

1. **Which markets to watch first** — sports moneylines (deterministic matching, fast feedback) or macro/crypto questions (where the channel content is richer but matching is fuzzy)? Recommendation: sports first for 1.6, macro in 1.7.
2. **Snapshot cadence and retention** — 6-hourly for linked markets is cheap; per-minute for a watchlist is a different design (WebSocket feed). Start with polling.
3. **Whose track record** — per speaker (needs speaker attribution, which is often "unknown"), or per channel/video source? Recommendation: per channel now, per speaker when diarisation lands.
4. **Paper trading** — do you want 1.8 to keep a hypothetical position ledger? It changes the schema (positions, marks) and is the natural place to test whether the signals mean anything before anyone risks a dollar.
5. **Account** — none is needed for anything in 1.5–1.8. An account/wallet only matters if trading is ever in scope.
