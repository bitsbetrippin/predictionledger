# Prediction markets — integration framework (1.5 → 1.8)

Original concept: Michael D. Carter (BitsBeTrippin). Built with Claude AI assistance.

## Why

Prediction Ledger already has one side of a trade: **what people on video claim will happen, and whether it did.** A prediction market is the other side: **what money says will happen, right now, and how much money is behind it.** Put the two together and a prediction stops being a row in a table and becomes a *position* — a creator says X, the market prices X at 31 %, and the ledger knows how often that creator has been right on things like X.

The mental model is a **ledger with two columns**: our extracted claims (with their eventual truth) on the left, the market's live odds and liquidity on the right, joined by a **link** that says "this claim is a bet on that market's *Yes* side". Everything in this document is about building that join carefully, in small releases, without ever letting the app place a trade until that is a deliberate decision.

## Ground rules (carry through every release)

- **Read-only until a separate decision.** Market data is public and unauthenticated. Trading needs a wallet, an API key, funds, and — for Polymarket — is geo-restricted (US users are blocked from trading; the `restricted: true` flag you see on markets means exactly that). The app will show odds and liquidity; it will not touch an order endpoint. If trading is ever added it is its own release with its own ADR, its own consent screen, and its own key store.
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

- `providers/markets/types.ts` — `MarketProvider` interface (`search`, `get`, `list`, `book`). Same pattern as `SearchProvider` / `LanguageModelProvider`: the app talks to the interface; Polymarket is the first adapter; Kalshi or Manifold can be added without touching callers.
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

### 1.8 — Multi-channel weighting and market watch
*Goal: the range of bets across many channels, and a watchlist that tells you when the market moves against the consensus.*

- Bulk ingestion: playlists/channels (YouTube) and transcript batches, tagged by source; dedupe the *same claim* across videos into one proposition with many endorsements.
- Consensus per market side: weighted by creator record and recency; disagreement shown explicitly (a split room is information).
- Watch rules (local, no notifications outside the machine unless you add one): "market moved > X points since last snapshot", "consensus and market diverge by > Y", "market resolves within Z days and our side is pending".
- Second venue (Kalshi or Manifold) behind the same interface, to check that the abstraction holds and to compare prices across venues.
- Deferred, needs its own decision: any order placement; paper-trading ledger (record hypothetical positions and their P&L against snapshots) is the safe intermediate and is probably the right next step before real money is ever discussed.

## Open questions for the product owner

1. **Which markets to watch first** — sports moneylines (deterministic matching, fast feedback) or macro/crypto questions (where the channel content is richer but matching is fuzzy)? Recommendation: sports first for 1.6, macro in 1.7.
2. **Snapshot cadence and retention** — 6-hourly for linked markets is cheap; per-minute for a watchlist is a different design (WebSocket feed). Start with polling.
3. **Whose track record** — per speaker (needs speaker attribution, which is often "unknown"), or per channel/video source? Recommendation: per channel now, per speaker when diarisation lands.
4. **Paper trading** — do you want 1.8 to keep a hypothetical position ledger? It changes the schema (positions, marks) and is the natural place to test whether the signals mean anything before anyone risks a dollar.
5. **Account** — none is needed for anything in 1.5–1.8. An account/wallet only matters if trading is ever in scope.
