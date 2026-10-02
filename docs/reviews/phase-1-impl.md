# Phase 1 implementation — H9–H17

Date: 2026-10-02. One commit per item, in ID order, after the earlier H1–H8 commits. Offline `npm run lint && npm run test:logic` ran after every item: 368 → 377 tests, 0 failures.

## Per-item summary

### H9 · ANCHOR_OFS removed (default = remove)
- **Changed:** removed the `strikePolicy` parameter and all ANCHOR branches and `_manageAnchoredStrike` from `quick-order.service`; removed the option from the quick-order controls, selectors, expansion, place and core JS, the chart options panel, the strategy builder, the route docs and `strategy.service`. Migration `072` drops `watchlist_symbols.anchored_*` and `strategy_legs.strike_policy`. `?v=` bumped on all 7 files.
- **Skipped / note:** `watchlist_symbols.strike_policy` stays in the schema, unused: it has a column CHECK constraint, so SQLite refuses `DROP COLUMN`, and rebuilding that wide FK-referenced table was not worth one dead column. The report allows this.
- **Tests:** `Test/services/anchor-removal.test.js`. `grep -rn ANCHOR_OFS backend/src backend/public/js` is empty.

### H10 · Stale ATM strike
- **Changed:** deleted `symbolResolutionCache` (and its cleanup and key helpers) from `quick-order.service`, plus the invalidation in `futures-roll.service`.
- **Tests:** `Test/services/option-resolution-fresh.test.js` (an LTP that crosses a strike boundary gives a different strike), and the futures-roll test no longer asserts on the cache.

### H11 · Browser stream dropped events
- **Changed:** removed `instanceFilter` from `ws-gateway.service`, its boot-time resolution in `server.js`, and `instanceService.getWebsocketCapableInstanceIds`. Removed `seq`/`last_seq` on server and client (`dashboard-core.js`); the client's seq-gap resync was spurious for topic-filtered clients anyway.
- **Tests:** `Test/services/ws-gateway.test.js`.

### H12 · Instruments
- **Changed:** one `replaceExchange(exchange, rows)` (one transaction, delete, bulk insert, ISO expiry) used by `fetchFromInstance` and `importFromCSV`; `refreshInstruments` and `_getExpiryFormats` are gone. The FTS index is rebuilt once after a load (`'rebuild'`), and all manual FTS deletes and inserts are gone. `importFromCSV` replaces only the exchanges in the file. A refresh is per segment (INDIAN or CRYPTO) from an instance that serves it, trying healthy ones first. `needsRefresh(segment)` checks that segment's log only. Refresh runs from crons (08:30 IST Indian, 17:31 IST crypto) and a boot catch-up. The middleware's blocking refresh is deleted: `instruments-refresh.middleware.js` now only reports `/ready`, computed live. Migration `073` drops the per-row FTS triggers (their plain DELETE on an external-content table caused the bloat), converts DD-MMM-YY expiry to ISO, rebuilds the FTS index and runs `VACUUM`.
- **Verified on a copy of the real DB:** 367 MB → 103 MB; `instruments_fts_docsize` = `instruments` row count.
- **Behaviour notes:** a partial fetch (some exchange errored) is logged `failed`, so it is retried at the next trigger. An empty download keeps the cached rows. Crypto expiry is now ISO like the Indian segments (all readers already tolerate both). `VACUUM` is inside `up()`; if migrations are later wrapped in a transaction (P3-8), move it out.
- **Tests:** `Test/services/instruments-replace.test.js`. The four search tests now rebuild FTS after seeding. `instruments-gate-bypass.test.js` is deleted with the gate.

### H13 · Write per WS tick
- **Changed:** deleted `quote_snapshots` persistence, hydration, hash and table-missing state; migration `074` drops the table. `GET /snapshots/quotes?exchange=&symbols=` now reads `symbolQuoteCache` and never refreshes. `dashboard-chart-live.js` reads the new shape, and the watchlist resync no longer forces a refresh.
- **Not done (differs from the report):** the per-instance in-memory `quoteCache` is kept. The report said to delete it only if telemetry alone reads it, but `quick-order`, `quick-order-quotes` and `_buildPreferredInstanceMap` read it too.
- **Tests:** `Test/services/quote-snapshots-gone.test.js`.

### H14 · Health systems
- **Changed:** deleted the feed's ping loop and `instanceHealth`, and `market-data-circuit-breaker.service.js` (it duplicated the client tracker; the client now short-circuits calls to a cooling-down instance). The feed asks `openalgoClient.isInstanceHealthy`. `getCacheStatus` uses the tracker's public API (new `getOpenCircuits()`), not breaker internals. The "instance unhealthy while positions are open" notification moved into `instance-health-check`, which is now the only periodic pinger.
- **Tests:** `market-data-feed.telemetry.test.js` rewritten and extended.

### H15 · Logger
- **Changed:** `formatKv` prints every primitive meta key. Keys matching token/api_key/password/secret/authorization are redacted, and an `Error` prints as its message. Reserved keys (`ts`, `msg`, `pid`, …) cannot shadow the prefix.
- **Tests:** `Test/unit/logger-format.test.js`.

### H16 · Polling overlap
- **Changed:** per-instance in-flight guard in `pollInstance`, `analyzerCheckIntervalMs` 15000 → 60000, stale "every 5m" comments fixed.
- **Tests:** `Test/unit/polling-in-flight.test.js`.

### H17 · Chart traffic
- **Changed:** `POST /symbols/quotes` calls `ensureSymbolSubscribed` for every requested symbol. In the chart, pane and future contracts are folded from WS ticks (`applyChartCompanionQuote`), and a contract is polled only if it has had no WS tick for 12 s. `dashboard-core.js` and `dashboard-chart-live.js` `?v=` bumped.
- **Tests:** two new cases in `Test/unit/chart-live.test.js`.
- **Not verified live:** "no multiquotes/quotes broker calls from chart polls" was checked by design and unit test only, not by watching a live chart.

## Gate G2

All three suites ran serially. Live analyzer status was checked first: instances 3, 6 and 26 are in analyzer mode. 19 (Maha) and 20 (Ana) are still down with "Invalid openalgo apikey", the same pre-existing condition as G1, so they could not be checked or used.

| Suite | G0 baseline | G1 | G2 (this phase) |
|---|---|---|---|
| integration | 201 pass, 2 skip, 0 fail | same | **201 pass, 2 skip, 0 fail**. The first run had one failure, `rbac.test.js:290`, a 404. It passed 3/3 in isolation and in a full rerun, so it was a flake. |
| e2e | 83 pass, 3 fail, 1 skip, 9 not run | 86 pass, 2 fail | **93 pass, 3 skip, 0 fail** |
| live | incomplete | 2 env failures | **96 pass, 138 fail, 134 skip** (details below) |

Live failures (the bulk is environmental, but I did not classify all 138 individually):
- **92** are `Invalid openalgo apikey` (Maha/Ana).
- **24** are "no last price" assertions on NFO/MCX/BFO contracts.
- The remaining MCX order failures on Kotak/Fyers show "MIS orders cannot be placed after square-off time (23:30 IST)". The suite ran around 05:15 IST, inside the closed window, as at G1.
- No code was changed to make any of them pass.

Afterwards a direct positionbook and orderbook check on 3, 6 and 26 shows **0 open positions and 0 open orders**. The suite's own cleanup flattened one BTCUSDFUT position (qty 1) on 26 and cancelled one CRUDEOIL PE order on 3 during the run.

**Recommended:** re-run `test:live` in market hours with 19 and 20 back up, to get a real comparison. This run cannot show whether the Phase 1 changes affect Indian-market order flows.
