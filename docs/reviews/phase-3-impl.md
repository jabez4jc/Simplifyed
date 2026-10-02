# Phase 3 implementation notes: P3-1 to P3-9 (P3-10 deferred)

One commit per item, in ID order. Lint and `test:logic` were green after each (now **400 tests**; 379 at the start of the session, so 21 added). `database/simplifyed.db` was never written. No migration was needed.

| Item | Commit | What changed | Tests added |
|---|---|---|---|
| P3-1 | c029854 | New `services/retention.service.js` `pruneOldRows()`, called on boot and every 6 h from `server.js` (replaces the inline audit-log prune). Windows: `audit_logs` 7 d, `candles` 30 d (by `fetched_at`, which the upsert refreshes), `risk_events` 30 d, `notifications` 30 d **read only**, `quick_orders` 90 d, `watchlist_orders` 90 d (`placed_at`). Trailing ratchet: `STOP_RATCHET` rows are no longer written; only the first arm (`TRAIL_ACTIVATED`) and the fire (`TRAIL_HIT`, auto-exit) are recorded. The FTS rebuild + VACUUM part was already done by migration 073 (H12). | `retention.test.js` (3 tables' windows, unread notifications kept, 90 d tables). `risk-controls.test.js` updated: one event on arm, stop still ratchets. |
| P3-2 | cfd3564 | Removed every `UPPER()` on `instruments.exchange/symbol/underlying_key/instrumenttype` in `underlying.util`, `history` routes (`/symbols` JOIN, `/option-legs` x3, `/future`, `/exposure`), `instruments.service`, `exit-levels`, `quick-order._validateOptionContract`, `market-data-feed._frameIsForItsLabel`, `futures-roll.listFutures`. Parameters are upper-cased in JS (`resolveOptionLotSize` now upper-cases its key). | `instrument-lookups-indexed.test.js`: query plans use the indexes, mixed-case callers still work, no `UPPER(<instrument column>)` anywhere in `src`. |
| P3-3 | 94b1808 | **Feed:** `refreshPositions`/`refreshFunds` run all instances with `Promise.allSettled` (the 2-4 s random sleeps are gone); `refreshQuotes/Positions/Funds` are single-flight (a caller arriving mid-run gets the running promise); the quote fallback asks only the multiquote pool (no non-multiquote instances, no inter-instance sleep). **Intervals:** the `DEFAULT_*` constants, `\|\|` fallbacks and `start({quoteInterval})` are gone; `config.js` is the only source (position refresh is now 8 s / 20 s as config says, not 8 s / 30 s). **WS:** `openalgoWsService.reconcile()` is run on every quote tick, so instances created, re-keyed, deactivated or deleted after boot get/lose their connection; Depth subscriptions idle for 2 min are unsubscribed (`depthSubscriptionFrames` now also emits `unsubscribe`); the order-update dedupe key includes `instanceId`. **Gateway:** `quotes:update` is coalesced to the latest quote per symbol every 250 ms. | `feed-throughput.test.js` (parallel, single-flight, multiquote-only fallback, config-only intervals), `ws-reconcile.test.js` (reconcile, depth unsubscribe, per-instance dedupe, quote coalescing). |
| P3-4 | 028350a | The env overrides named in the report (`AUTO_EXIT_*`, `TRADINGVIEW_*`, `OPENALGO_FAST_SNAPSHOT_MODE`, `OPENALGO_INSTANCE_TIMEOUT_MS_MAP`) were **already removed** in Phases 0-2; grep is empty over src, `.env.example`, `update.sh`, `install.sh`. `/public-config` no longer has `\|\|` fallbacks (the frontend does use `marketData`, so it stays). `openalgo.request_timeout_ms` help text rewritten (an unknown-outcome order is never re-sent). `validateValue`: sessions need `start < end` and no overlap (touching is fine); `brokerage.by_broker` must be a map of lowercase-slug key -> number >= 0; `brokerage.market_order_support` must be a map of crypto broker -> boolean. `isTestMode()` reads `config` only (the live `process.env` read is gone). | `settings-registry.test.js` (2 tests); `runtime-mode.test.js` updated. |
| P3-5 | ef99d90 | New `utils/expiry.js`: `parseExpiry` (DD-MMM-YY, DDMMMYY, YYYY-MM-DD, rollover-safe), `toISO`, `toDisplay` (DD-MMM-YY), `toBroker` (DDMMMYY), `sameExpiry`. Deleted: `underlying.util.parseExpiry`, `client.toBrokerExpiry`, `derivative-resolution.{convertExpiryToOpenAlgoFormat, expandExpiryFormats, _resolveExpiryVariants}`, `option-chain._expandExpiryFormats`, `options-resolution.{_convertToOpenAlgoExpiryFormat, _normalizeExpiryToISO}`, `instruments.{_normalizeExpiryDate, _formatExpiryForDisplay}` and its month maps, `futures-roll.toRowExpiry`, the inline month arrays in `black76-pricing`, `symbol-parsing` (`parseFuturesSymbol`, `parseOptionSymbol`, `normalizeExpiryInput`, `expiryMatchesSymbol`). The multi-format DB probes (`expiry IN (variants)`, the 3-format loop in `options-resolution`) became one `expiry = ISO` lookup, since H12 stores ISO. | `Test/unit/expiry.test.js` (formats, rollover rejection, pass-through, and the converted callers). |
| P3-6 | ad45eb9, aebee2d | `utils/order-helpers.js` now holds `normalizeOrderStatus` (was 4 copies), `roundToTick`/`roundToNearestTick`/`applyBufferAndTick`/`countDecimals`, and `cancelOpenOrdersForSymbol` (was 3 copies: placement, retry, quick-order; the quick-order one is now `_cancelOwnOrdersBeforeRetry`, so the C3 leftover name is gone). The `_normalizeSymbol/_Exchange/_Product` wrappers are deleted (callers use `symbol-parsing.util`). One `extractLtp(quote, {forOrder})` in `price-extraction.js` replaces `client._extractLtp`, `feed._extractLtpFromQuote` and `quick-order-quotes.extractLtpFromQuote`; with `forOrder` it uses only ltp/bid/ask. `fetchLtpForSymbol`/`getLtpWithRetry` take `forOrder`, and order-placement, order-retry and limit-price pass it, so a fill-now LIMIT is never priced off `close`. `extractChangePercentFromQuote` no longer reads an absolute `change` as a percent. `getUnderlyingForClosing` has one copy. | `order-helpers.test.js` (5) |
| P3-7 | da0f820, aebee2d | Exchange-aware `_resolveOrderTypeForInstance(instance, exchange)` (Indian = LIMIT). Close tick resolved per contract from `instruments`. Quantity must be an integer > 0. Queue coalescing only within one origin (source + request type + strategy tag). `cancelOrder` refuses a row with no broker id. `reconcileOrderUpdate` closes a leg only on its own exit order id or the strategy's broker tag. `deleteStrategy` removes the seeded anchor and leg-exit rows (strategy watchlists only, only if no other strategy uses them). MARGIN_BASED sizes on the leg contract and its lot. Exit levels: a failed fire re-arms (ACTIVE), counts `attempts`, third failure is `FAILED` + notify; boot recovery of `TRIGGERING` rows (**migration 078**). `closeAllPositions` waits up to 10 s for LIMIT exits before reporting `stillOpen`. broker-units converts `placegttorder` and `margin` payloads and throws if `broker_lot_sizes` is missing. Exact-symbol close ignores `tradeMode`; `getTradeModeFromSymbol` fixed (RELIANCE is EQUITY). `deleteInstance` uses `db.transaction`, clears `trailing_state` and feed caches, and refuses while positions are open or unreadable unless `?force=true`. | `order-correctness.test.js` (11), 3 added to `exit-levels.test.js` |
| P3-8 | db62972, aebee2d | `database.js` transaction caveat documented. Each migration runs in one transaction with its `schema_migrations` row (062 and 073 are exempt: PRAGMA / VACUUM). The server refuses to start with pending migrations. `optionalAuth` caches the user 30 s, invalidated by `rbac.service` (assign role, set permissions, delete user). Pending idempotency rows older than 5 min are expired. `incrementSignalCounts` and `_upsertDailyPnlSnapshot` are single `ON CONFLICT` statements. `/register` is one `INSERT ... WHERE NOT EXISTS`. One password validator (8 chars, 72 bytes). `DELETE /rbac/users/:id` (never the last admin). CSV import/export on `settings.manage` instead of `is_admin`. One `utils/csv-import.js` (explicit allowlists, upsert helper), imports run in `db.transaction`. `_getWatchlistForSymbol` is a light query. `/instances/:id/refresh` needs `instances.edit`. | `db-middleware.test.js` (12) |
| P3-9 | abf502a | A partial settings save is a 12 s error toast naming each rejected key and reason. `handleSearch` renders once. `POST /notifications/read-all` replaces one request per row; stale "Audit" header removed. Service worker v7: `/js`, `/css`, `/vendor` network-first, one cached copy per path, old caches deleted on activate (it already did). `?v=` bumped on `settings-general.js`, `api-client.js`, `dashboard-notifications.js`, `dashboard-watchlists-positions.js`. | `frontend-p3-9.test.js` (6) |
| P3-10 | - | Deferred, as instructed (O8 default). | - |

## Behaviour changes worth knowing

- **Position refresh idle interval 30 s -> 20 s** (config was the stated value; the feed's own constant disagreed).
- **`STOP_RATCHET` risk events are no longer recorded.** The stop itself is still persisted in `trailing_state`. The report allowed either "one tick" or "arm and fire only"; there is no tick size in the risk-controls context, so I took arm and fire.
- **Quote fallback no longer tries non-multiquote instances.** If no instance in the pool supports multiquotes, a WS miss is not retried over REST by the feed (the order path's `fetchLtpForSymbol` is unchanged).
- `parseOptionSymbol` with an unknown month used to return January; it now returns `expiry: null`. `parseExpiry` now also accepts `DDMMMYY`.
- Chart `quotes:update` events arrive at most every 250 ms per symbol. The chart's live bar sees the latest tick per window, not every tick.

## Decisions I made where the report was open

- "Known broker keys" (P3-4): there is no list of OpenAlgo brokers in the repo, and the UI lets you add one that is not listed, so `brokerage.by_broker` checks the key shape (lowercase slug), not membership. `market_order_support` accepts crypto brokers only, which is what the UI lists.
- Candle retention uses `fetched_at` (the upsert refreshes it) rather than the candle's own `ts`, so a re-fetched old range is not deleted straight away.

## DB size (P3-1 accept)

On a **copy** of `simplifyed.db` (367.8 MB): migrations 071-077 -> 77.7 MB; then `pruneOldRows()` + `VACUUM` -> **67.3 MB** (candles 181,704 -> 36,598 rows). `instruments_fts_docsize` 130,590 = `instruments` 130,590. The copy was deleted.

## Greps

Empty: `UPPER(` on instrument columns (the 4 hits left are `watchlist_symbols`/`strategy_leg_executions` columns, not instruments), `TRADINGVIEW_|AUTO_EXIT_|OPENALGO_FAST_SNAPSHOT_MODE|OPENALGO_INSTANCE_TIMEOUT_MS_MAP`, `ANCHOR_OFS|quote_snapshots|symbol_cache|expiry_calendar|watchlist_options_state`, `removed noisy log`, `startServices|_cancelAllForRetry|_postWithRetries|_recoverOrderFromOrderbook`. Still there, as noted in the Phase 2 file: `_cancelAllOrdersForRetry` in `quick-order.service.js:722,778` (symbol-scoped, only the name is wrong; Phase 0 C3 leftover, not touched).

## Not done

- **P3-6, "four option-chain builders, keep the instruments-backed one":** not done. The four (`option-chain.service` for the chart route, `options-resolution` broker-then-DB, `quick-order-quotes.getOptionChainQuotesMap`, `instruments.buildOptionChain`) differ in what they return: only the broker ones carry live quotes and greeks, which the chart's option chain and the quick-order preview use. "Keep the instruments-backed one" does not say where those quotes would come from, so it needs your decision.
- **P3-10:** deferred.

## Behaviour changes to know (P3-6 to P3-9)

- **The server will not start until `npm run migrate` has been run** (migration 078 is pending on `database/simplifyed.db`, which is at 077). Your `node --watch` will exit on its next reload until you do.
- Instance delete (UI too) now fails with 422 if the broker book cannot be read or shows a position; `?force=true` overrides.
- Settings and CSV import/export routes need `settings.manage`, not `is_admin`. Instance refresh needs `instances.edit` (a Monitor can no longer trigger broker calls).
- A level whose exit failed stays ACTIVE and is retried (max 3). A partial (PERCENT/LOTS) level that already sent an exit is not retried; one stuck TRIGGERING at boot is set to FAILED rather than risk exiting twice (FULL ones are re-armed).
- Strategy ledger rows close only on the leg's own exit order or an order carrying the strategy's broker tag. A close made elsewhere (Positions page, broker SL) no longer closes the row via the stream; the read-time position cross-check still catches it.
- Close All / kill switch can take up to 10 s longer before reporting.
- Kill switch, orders and position reads now fail loudly if `broker_lot_sizes` is missing.

## Gate G4

Instances 3, 6, 19, 20, 26 all in analyzer mode (checked in the DB; the suites confirm at the broker). Suites ran serially. G0 baseline is in `phase-0-impl.md`; G3 in `phase-2-impl.md`.

| Suite | G0 | G3 | G4 (this phase) |
|---|---|---|---|
| integration | 201 pass, 2 skip | 199 pass, 1 fail of 200 | **200 of 200 after fixes** (first run 133 pass / 67 fail, see below) |
| e2e | 83 pass, 3 fail, 1 skip, 9 not run | 83 pass, 2 fail, 11 not run | **81 pass, 4 fail, 11 not run**; 3 of the 4 pass on rerun, 1 is pre-existing |
| live | incomplete | 133 pass, 28 fail, 206 skip | **133 pass, 28 fail, 206 skip** (identical) |

**Failures caused by this phase, found by the gate and fixed:**
1. Integration 67 failures: my 30 s user cache served stale roles because the test helpers write users/roles with raw SQL (ids are reused after truncate). Production writes go through `rbac.service`, which invalidates. Fixed in `Test/helpers` (they now invalidate). Integration was then rerun in full: 3 left.
2. Two kill-switch tests: `closeAllPositions` skipped its final book read when nothing was open. Restored (it always reads back).
3. `deleting removes the row`: new delete guard (P3-7); the test now asserts the refusal and uses `force=true`.
4. **A real bug in P3-6:** I deleted `extractLtpFromQuote` but `quick-order.service` still called it in three places, so `GET /quickorders/futures/preview` returned 500. `test:logic` did not cover it; e2e `futures-roll` caught it. Fixed, with a guard test. This one was mine and would have shipped.

**e2e remaining:** `chart-orders-markets.spec.js:407` MCX (the buy limit "rests" but is already `complete`): failed identically at G0 and G3, pre-existing. `chart-option-expiry.spec.js:947` (drag) passed on rerun; `workflow-watchlist.spec.js:342` (MCX fan-out, Fyers position 0) failed twice in a line-filtered rerun and then **passed** in a clean run (10 s), with the Fyers order accepted (`status=success`) each time. I classify it as the same Fyers MCX position-visibility timing seen at G3, not a code failure, but I could not prove it. `futures-roll.spec.js:189` cannot be run by line (it depends on earlier tests in the file); the whole file passes (5/5).

**Live (28 fail, same as G3):** 24 Maha/Ana "no last price for NFO/BFO/MCX" (environmental), 3 Fyers CRUDEOIL auto-exit tests "position never appeared after BUY/SHORT" (**still unclassified**, same as G3; with the Fyers e2e above they point at Fyers MCX positions not showing in analyzer, which I could not confirm), and "left open at the broker: Kotak order 26100258736054" (the known OpenAlgo analyzer margin bug, ignored per your note).

## Stop condition hit: things left open

After the suites, a direct positionbook/orderbook read shows, besides the known Kotak NIFTY order:
- **Jz Kotak: position CRUDEOILM19OCT26FUT qty 20**
- **Jz Fyers: open order 26100229060892 CRUDEOILM19OCT26FUT**

Both are from the e2e MCX workflow runs (qty 10 and 50 orders on CRUDEOILM that the failing runs did not clean up). Per §9.2 step 3 I stopped and did not touch them (earlier cancel attempts were blocked by the sandbox and by OpenAlgo's analyzer bookkeeping). Instances 19, 20, 26 are flat.

**Needs you:** (1) close that Kotak CRUDEOILM position and cancel that Fyers order; (2) run `npm run migrate` before restarting the server; (3) decide the option-chain builder question; (4) the 3 Fyers live failures remain unclassified (rerun in isolation with MCX open).

## Checklist (§9.3)

Phase 3 stays **unticked**. Done: P3-1 to P3-9, DB under 100 MB, no `UPPER(` on instrument columns, retention tested. Not satisfied: G4 did not end clean (open Kotak position and Fyers order, unclassified Fyers live failures, one pre-existing e2e failure), one P3-6 bullet is open, and P3-10 is deferred by default.

## G3 / G4 rerun (2026-10-02, ~16:10-16:45 IST, Indian market holiday)

The code state is the final tree, so one serial run of the three suites counts as both G3 and G4. Pre-check: instances 3, 6, 19, 20, 26 all in analyzer mode at the broker. The leftover Kotak CRUDEOILM position (20) was flattened first, in analyzer mode. Per the owner (2026-10-02), open orders and order-related errors are ignored: they cannot be closed because of an OpenAlgo analyzer margin bug.

| Suite | G0 | G3 (earlier) | G4 (earlier) | This rerun |
|---|---|---|---|---|
| integration | 201 pass, 2 skip | 199 pass, 1 fail | 200 of 200 | **196 pass, 3 fail, 1 skip** |
| e2e | 83 pass, 3 fail, 1 skip, 9 not run | 83 pass, 2 fail, 11 not run | 81 pass, 4 fail, 11 not run | **83 pass, 2 fail, 11 not run** |
| live | incomplete | 133 pass, 28 fail, 206 skip | 133 pass, 28 fail, 206 skip | **127 pass, 29 fail, 212 skip** |

All failures are classified as environmental (market holiday: NSE/NFO closed all day, MCX closed until its evening session). No code was changed.

- **Integration (3):** `options-orders` CE, PE and CNC-on-option: an NFO option BUY never fills ("the broker holds the option", 0 !== 1). NFO is closed.
- **e2e (2):** `chart-orders-markets` MCX limit order, and `workflow-watchlist` MCX fan-out (Fyers expected 500, got 0). These are the same two MCX tests as before, and MCX was not trading.
- **Live (29):** 24 Maha/Ana "no last price" (as at G3/G4); the 3 Fyers CRUDEOIL auto-exit tests ("position never appeared") now track the same MCX-closed cause, so they are no longer unclassified; "every order and position ... is closed" fails on open orders only (ignored); "the contract quotes with a usable price" timed out at 60 s with no quotes, which is new versus G3/G4 and is also a closed-market symptom. The pass/skip shift (-6/+6) is the same cause.
- **Afterwards:** no positions on any of the five instances. Open orders remain on Kotak (NIFTY06OCT2622400CE, ids 26100258736054 and a new 26100238311600) and Fyers (CRUDEOILM19OCT26FUT 26100229060892); ignored per the owner.

**Caveat:** because the market was closed, this rerun exercised the order paths less than G0 to G2 did. The Fyers MCX auto-exit tests and the NFO option fills should be rerun on a trading day for a clean G4. §9.3 boxes for Phases 2 and 3 stay unticked: D4 is still blocked and the P3-6 option-chain-builder bullet still needs an owner decision.
