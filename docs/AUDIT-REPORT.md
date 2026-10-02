# Simplifyed — End-to-End Audit & Remediation Plan

> **Audience:** an LLM coding agent (Sonnet) implementing fixes in this repo.
> **Audit date:** 2026-10-01, at commit `bca9c4d` on `main`.
> **Baseline:** `npm run lint` is clean, and `npm run test:logic` passes 334 tests.
> **Paths:** all paths are relative to the repo root (`/Users/jabez/Personal/GitHub/Simplifyed`). Backend code is in `backend/`. Line numbers are approximate, so locate code by the **function name** given.

---

## 0. How to use this report

1. Work **phase by phase**, in order (Phase 0 → 4). Inside a phase, do the items in ID order unless an item says otherwise.
2. Every item has these fields:
   - **ID**
   - **Severity**
   - **Where** (file and function)
   - **Problem**
   - **Evidence**
   - **Fix** (the exact steps)
   - **Accept** (the acceptance checks)
3. Do one item, or one tightly related group, per commit. Use a commit message like `fix(C2): release concurrency slot when throttle throws`. Do **not** add a `Co-Authored-By` trailer.
4. After each item, run `cd backend && npm run lint && npm run test:logic`. Both must stay green. If an item deletes code that a test covers, delete or update that test in the same commit. Broker suites run only at the gates in §9.2: a baseline before Phase 0, then at the end of each of Phases 0–3.
5. Before you delete any function, route or table, **grep its name across `backend/` (src, tests, public, scripts)** and confirm it has no remaining callers. This report was produced with a transitive dead-code scan, but you must re-verify.
6. Items marked **[OWNER]** depend on a decision in §7. Apply the stated default unless the owner has overridden it.
7. When you finish a phase, tick its checklist in §8.

### Severity legend

| Sev | Meaning |
|---|---|
| **CRIT** | Can lose money, place duplicate or unintended orders, or silently disable risk controls. |
| **HIGH** | Wrong behaviour in a real flow, or a setting that silently does nothing. |
| **MED** | Correctness edge case, inconsistency, or a meaningful performance cost. |
| **LOW** | Cleanup, noise, or docs. |
| **DEAD** | Dead or redundant code or feature. Delete it. |

---

## 1. Non-negotiable rules for the implementing agent

These are domain invariants. Never weaken them while fixing anything.

1. **SEBI limit-only.** Indian exchanges (NSE, BSE, NFO, BFO, MCX, CDS, BCD, NSE_INDEX, BSE_INDEX) accept **LIMIT orders only**. Convert SL-M to SL. Only crypto instances may send MARKET orders, and crypto defaults to MARKET.
2. **Never re-send an order whose outcome is unknown.** On a timeout, network error or 5xx, check the broker order book (`openalgoClient._awaitOrderInBook` already does this correctly). Position-targeted orders (`placesmartorder`) are **not** idempotent.
3. **Broker lot units** are converted only at the client boundary (`utils/broker-units`). Never convert them anywhere else.
4. **Expired contracts** are purged and must never be queried.
5. **Single-source settings.** Each tunable value lives in exactly ONE place: an env var (deployment facts only, such as port, secrets or proxy), a code constant, or a Settings row (`settings/registry`). Never use env plus a Settings row for the same value, and never use `||` fallbacks that duplicate a default.
6. **Secrets.** Never `SELECT *` from `application_settings` unfiltered, because it contains the webhook token. Read secrets via `getSecret`. Never print, log or commit tokens, API keys or `.env`.
7. **Strategy basket and ledger.** A basket is never re-sent. An exit closes only the strategy's own quantity. The ledger is reconciled against the broker.
8. **Schema changes** go through a new numbered migration in `backend/migrations/`. Never edit an applied migration. Never write to `backend/database/simplifyed.db` by hand.
9. **Frontend.** After changing any file under `backend/public/js` or `backend/public/css`, bump its `?v=` query in the HTML that loads it. The service worker caches by URL.
10. **Tests:**
    - `npm run test:logic` is offline. Run it always.
    - `test:integration`, `test:e2e` and `test:live` hit **real brokers** (analyzer mode). Run them **only at the gates in §9.2** (a baseline, then once at the end of Phases 0–3). Run one suite at a time, never concurrently.
    - Live tests must leave **nothing open**.
    - Test instances are Kotak **3**, Fyers **6**, Maha **19**, Ana **20** and Delta **26**.
    - Validation errors return **422**, not 400.
11. The owner runs the server with `node --watch`. Do not add build steps.
12. Prefer **deletion over addition**. Do not add new dependencies, abstractions or config knobs.

---

## 2. Summary of findings

| Phase | Count | Theme |
|---|---|---|
| 0 Critical safety | 5 | Risk monitor not running after restart; client deadlock; account-wide cancel; duplicate webhook orders; wrong session P&L |
| 1 High bugs | 17 | Analyzer flag bypass, rate limits, stale prices, stale strikes, dropped WS events, instruments/FTS, per-tick DB writes, health sprawl, logger drops fields |
| 2 Dead code & features | ~40 | Dead routes, services, tables, wrappers, ANCHOR_OFS, Telegram linking, duplicate helpers |
| 3 Consolidation & perf | ~20 | DB 367 MB → ~70 MB, UPPER() full scans, feed parallelism, retention, chart polling, config single-source |
| 4 Docs & repo hygiene | ~10 | Stale docs, tracked junk, 407 AI-tooling files, vendored libraries committed twice |

**Biggest wins:**
- C1–C5 close real money-loss paths.
- H12 plus P3-1 shrink the DB by about 300 MB.
- H13 removes one SQLite write per WebSocket tick.
- Phase 2 removes roughly 3–4k lines.

---

## 3. PHASE 0 — Critical safety (do first, one commit each)

### C1 · CRIT · Background risk services start only when a browser logs in
- **Where:**
  - `backend/server.js` `startBackgroundServices()` (~L42–84) and `startServer` (~L273).
  - `backend/src/middleware/auth.js` (~L90–117), where `req.app.locals.startServices()` is called.
- **Problem:** The market-data feed, auto-exit (stop-loss/target), polling (session max-loss, cutoff) and exit levels start **lazily on the first authenticated HTTP request**. After a restart (crash, `node --watch` reload, deploy) with no browser open, **no stop-loss or session limit is monitored**, while `/webhook` still places orders.
- **Fix:**
  1. Call `await startBackgroundServices()` inside `startServer` right after `listen` succeeds. It is already race-safe.
  2. Delete the lazy-start calls in `middleware/auth.js` and `app.locals.startServices`.
  3. Add `process.on('unhandledRejection', …)` and `process.on('uncaughtException', …)` handlers in `server.js`. They must log via `log.error`. For `uncaughtException`, log and then exit(1).
  4. Wrap the async `settings:changed` listener body (it calls `reloadRateLimits`) in try/catch.
- **Accept:**
  - Start the server and make no HTTP request. The logs show the feed, auto-exit and polling started.
  - `grep -n startServices backend/src` returns nothing.

### C2 · CRIT · Concurrency slot leak deadlocks all non-skip broker calls
- **Where:** `backend/src/integrations/openalgo/client.js`, `_waitForConcurrency` (~L790–830) and `_executeWithConcurrency`.
- **Problem:**
  - `this.currentTasks += 1` happens, and then the token-bucket wait can throw a 429 ("Rate bucket throttle" after 100×25 ms). That throw happens **before** the `try/finally` in `_executeWithConcurrency` that decrements, so the slot leaks forever.
  - After `maxConcurrentTasks` (10) leaks, every call that goes through the limiter spins forever in `while (currentTasks >= max)`. Those calls include positionbook, quotes, orderbook and tradebook, so auto-exit and polling freeze.
  - `maxConcurrentTasks` is **global**, so one hung broker (15 s timeouts) starves every other instance.
- **Evidence:** The logs contain 88 "Rate bucket throttle" errors, with up to 7 in a single process lifetime.
- **Fix:**
  1. Increment `currentTasks` only inside the `try` whose `finally` decrements it. Alternatively, wrap the bucket wait in try/catch and decrement before rethrowing.
  2. Make the limit **per instance**: `Map<instanceId, count>`, with the same max.
  3. Add a logic test in which the bucket throws 11 times, followed by a successful call. The final call must resolve and must not hang. Use a short test timeout.
- **Accept:** The new test passes. Code inspection shows the counter cannot be incremented without a matching finally.

### C3 · CRIT · A retry or close-retry cancels EVERY open order on the account
- **Where:**
  - `backend/src/services/order-retry.service.js` `_cancelAllForRetry`
  - `backend/src/services/quick-order.service.js` `_cancelAllOrdersForRetry` (~L800–819), called from `_retryFailedCloseOrders`
  - both go through `order.service.cancelAllOrders` and on to OpenAlgo `cancelallorder`
- **Problem:**
  - OpenAlgo `cancelallorder` is **account-wide**. The `strategy` param is only a label, and the kill switch depends on exactly that behaviour.
  - So retrying a single unfilled marketable LIMIT cancels every resting order on that account, including chart limits and **protective SL stops on other symbols**.
  - `cancelAllOrders` also marks **all** local pending/open rows as cancelled, whatever the broker actually did.
- **Fix:**
  1. Replace both call sites with the existing **symbol-scoped** `_cancelOpenOrdersForSymbol(instance, symbol, exchange, product)`. Two copies exist; Phase 3 item P3-6 merges them into one util. For now, use the one in the same service or import the other.
  2. Delete `_cancelAllForRetry` and `_cancelAllOrdersForRetry`.
  3. In `order.service.cancelAllOrders`, mark local rows cancelled only for orders that the subsequent orderbook shows as cancelled, or leave status sync to the poller. Only the kill switch and the explicit "Cancel all" button may call `cancelAllOrders`.
- **Accept:**
  - `grep -rn "cancelAllOrders" backend/src` shows only kill-switch, the route, and order.service itself.
  - Add a logic test with a stubbed client: retry for symbol A must not call `cancelAllOrder`, and must cancel only A's order ids.

### C4 · CRIT · TradingView broadcast re-sends orders and bypasses every safety layer
- **Where:** `backend/src/services/tradingview-broadcast.service.js`, `_postWithRetries` (~L642–689) and its helpers.
- **Problem:**
  1. The service POSTs `placesmartorder` itself, with `retries=2` and a **3000 ms timeout**. It **re-sends on timeout, network error or 5xx without checking the order book**, which creates duplicate orders on the one unattended path. Brokers routinely stall longer than 3 s.
  2. It bypasses `openalgoClient`, so it gets no circuit breaker, no rate limit, no `ORDER_OUTCOME_UNKNOWN`, **no SL-M→SL conversion** (`assertLimitOnlyCompliance` throws instead), no broker-unit conversion of the response, and **no `watchlist_orders` row**. Broadcast orders therefore never appear in order history or on the chart.
  3. It uses a third pricing algorithm (`_ensureLimitPricing`, LTP ± env buffer pct), which differs from `limit-price.service`.
- **Fix:**
  1. Dispatch each target through `orderPlacementService.placeSmartOrder(instance, payload, { source: 'webhook', … })`. Alternatively use `order.service` with the same source tag the other webhook paths use. Pick whichever records `watchlist_orders`, then follow the pattern of the strategy webhook path.
  2. Delete:
     - `TokenBucket` (local)
     - `_postWithRetries`
     - `_postJson`
     - `_retryDelay`
     - `_ensureLimitPricing`
     - `_marketOrRefuse`
     - `_resolveBufferPct`
     - `_roundToTick`
     - `_countDecimals`
     - `_resolveTickSize`
     - `_scheduleRetryForTarget`
  3. Delete the config keys `config.webhooks.tradingviewBroadcast.{timeoutMs, retries, retryDelayMs, defaultRps, bufferPctDefault, bufferPctByStrategy}` and `parseStrategyBufferConfig` in `backend/src/core/config.js`.
  4. Delete the `TRADINGVIEW_*` keys from `backend/.env.example`. Delete the env-migration lines for them in `update.sh` (~L197–200).
  5. Remove the endpoint and apikey fields from `watchlistService.getBroadcastTargets` if nothing else reads them.
  6. `assertAuthorized` falls back to `process.env.WEBHOOK_TOKEN`. Use only the config/secret source.
  7. **[OWNER]** `watchlists.limit_buffer_pct` existed only for this pricing. Default: drop it via migration and remove it from the UI.
- **Accept:**
  - `grep -rn "fetch(\|_postJson\|TRADINGVIEW_" backend/src backend/.env.example update.sh` finds nothing related to the broadcast.
  - A logic test with a stubbed `orderPlacementService` shows a broadcast alert calls it once per target and never retries.

### C5 · CRIT · Session P&L counts open positions at full notional
- **Where:**
  - `backend/src/services/instance-pnl.service.js` `updatePnLData` (~L128–131)
  - `backend/src/utils/trade-pnl.js` `calculateTradebookPnL` (~L94–146)
- **Problem:**
  - `totalPnl = calculateTradebookPnL(tradebook).net_pnl` computes Σ sell value − Σ buy value − charges over the day.
  - An **open** ₹5 L BUY therefore counts as −₹5 L, which trips `SESSION_MAX_LOSS`. That calls `toggleAnalyzerMode(true)`, which **closes all positions**.
  - An open SHORT counts as a huge profit and trips `SESSION_TARGET`.
  - The bug is latent only because every instance is currently in analyzer mode.
  - The dashboard (`dashboard.service._fetchInstanceFunds`) uses positionbook MTM, which is a second, different definition.
- **Fix:**
  1. Create one function, for example `computeSessionPnl(positionbook, tradebook, brokerage)` in `utils/trade-pnl.js`. It returns `Σ position pnl (realized + unrealized, broker MTM) − today's charges`.
  2. Use it in both `instance-pnl.updatePnLData` and `dashboard.service`.
  3. Read the brokerage default from `settingDefault`. The default `20` is currently hard-coded twice.
  4. Drop the always-0 `realized_pnl`/`unrealized_pnl` writes if no UI reads them (grep first).
- **Accept:**
  - A unit test with a tradebook of one BUY and no SELL, plus a positionbook with that position's MTM = −50, gives session P&L = −50 − charges, not −notional.
  - A short-only test likewise gives no notional profit.
  - The dashboard and the session check return the same number for the same inputs.

---

## 4. PHASE 1 — High-severity bugs

### H1 · HIGH · Analyzer mode can be flipped without the broker toggle
- **Where:**
  - `backend/src/utils/instance-validation.util.js` (~L139–141) accepts `is_analyzer_mode`.
  - `routes/v1/instances.js` PUT `/:id` (~L144–170, "modeOnly" branch).
  - `instance.service.bulkUpdateInstances`.
  - Instance CSV import.
- **Problem:** The local flag changes without calling the broker `analyzer/toggle` and without the safe-switch that closes positions. CSV import can also write `is_analyzer_mode` and `health_status`.
- **Fix:**
  1. Remove `is_analyzer_mode` (and `health_status`) from the normalizer and from the CSV-import column allowlist.
  2. In PUT `/:id`, if the body contains `is_analyzer_mode`, call `instanceService.toggleAnalyzerMode(id, value)`, or return 422 and point the client at the existing toggle route. Check which one the UI uses and keep that one.
  3. Remove `is_analyzer_mode` support from bulk update.
  4. PUT `/:id` and bulk-update use a local `hasPermission` that ignores `is_admin`. Switch them to the `requirePermission` middleware.
- **Accept:** A logic or service test shows that `normalizeInstanceData({is_analyzer_mode:1})` drops the key.

### H2 · HIGH · Order rate-limit settings are inconsistently applied
- **Where:**
  - `client.js` `_throttle` (~L932–993) and `_bucketKindForEndpoint`
  - `skipRateLimit: true` at `order.service.js:293`, `order-retry.service.js:386`, and `quick-order.service.js:1107,1466,1743,2090,2348`
  - `order-placement.service.js` `TokenBucket(2,2)`
- **Problem:**
  1. Almost every order path passes `skipRateLimit: true`, which skips the throttle, the concurrency limiter **and** the error backoff. The "Orders per second" setting therefore does nothing for those paths.
  2. Where the throttle does run, `ordersOver = instOrders >= limit || globalOrders >= limit` compares the **global** count with the **per-instance** limit. That serializes fan-out across all instances to 2 orders/s in total, which contradicts the setting's help text ("each instance separately").
  3. `order-placement.service` also has a hard-coded `TokenBucket(2,2)` that ignores the setting. It is a third order limiter.
  4. `_bucketKindForEndpoint` matches `orderbook` via `includes('order')`, so the critical-orderbook branch is unreachable and `rest_quotes` is never used. Also, `basketorder` and `modifyorder` are not counted as orders.
- **Fix:**
  1. Order placement always goes through the **per-instance** order throttle. Delete the global comparison. Never send orders through the error backoff (see H3).
  2. Replace `skipRateLimit` with a narrower flag such as `skipBackoff` for order calls, or make order endpoints exempt from the backoff inside the client and delete `skipRateLimit`.
  3. Delete the `TokenBucket` in `order-placement.service`.
  4. Fix the bucket classification with an explicit endpoint→kind map.
  5. Update the logic test "a third placesmartorder call within the same second is actually throttled" so it asserts per-instance behaviour: calls to two different instances are not throttled against each other.
- **Accept:** The updated throttle tests pass. Exactly one order limiter remains, and it reads `rate_limits.smart_orders_per_second` / `orders_per_second`.

### H3 · HIGH · Error backoff blocks critical calls for 5 minutes
- **Where:** `client.js` `ERROR_LIMITS`, `_ensureBackoffWindow` and `_recordError`.
- **Problem:** After 20×404 or 10×401/403 within 30 min, all calls to the instance are blocked for 5 min, including the positionbook, orderbook and tradebook reads that exits depend on. The logs show 376 blocks. `instance-health-tracker` (the circuit breaker) already covers this.
- **Fix:** **Delete** the ERROR_LIMITS backoff entirely (`errorCounters`, `_ensureBackoffWindow`, `_recordError` and the call sites) and rely on the tracker.
- **Accept:** `grep -n "_ensureBackoffWindow\|ERROR_LIMITS" backend/src` is empty, and the tests pass.

### H4 · HIGH · Phantom-success order recovery
- **Where:** `order-placement.service.js` `_recoverOrderFromOrderbook`, which is called on a 5xx in `_performPlacement`.
- **Problem:** The loose matcher has no product check, `isRecent()` returns true when the timestamp is missing, and the window is 2 min. It can report an **earlier, different** order as the result of this placement. The client's `_awaitOrderInBook` already resolves this correctly before throwing.
- **Fix:** Delete `_recoverOrderFromOrderbook` and the `shouldRecover` branch, and let the client error propagate.
- **Accept:** Tests pass, and the function no longer exists.

### H5 · HIGH · Orders fail on flat accounts ("Could not read position")
- **Where:** `order.service.js` `_getLivePosition` and `order-retry.service.js` `_getLivePosition`.
- **Problem:** An empty positionbook (a valid flat state) returns `null`. `placeOrder` without price/position_size (option-pane Buy/Sell via `/orders`) then throws on every flat instance. The function is also called twice per order.
- **Fix:**
  1. Merge the two copies into one helper (see P3-6). An empty array means quantity 0. Return null only when the fetch failed.
  2. Fetch once per order and pass the result down.
- **Accept:** A unit test shows that an empty positionbook gives 0, and a fetch error gives null or throws.

### H6 · HIGH · The "Maximum bid/ask spread" setting never refuses an order
- **Where:** `backend/src/services/limit-price.service.js` `resolveMarketablePricing`.
- **Problem:** When the spread check throws, the function retries with `bypassSpreadCheck:true, forceLtp:true`, so the order goes out anyway. The spread is also checked only on the depth path.
- **Fix:**
  1. For non-exit callers, rethrow spread errors and do not relax. Exits keep passing `bypassSpreadCheck`.
  2. Also check the spread when bid/ask come from a quote rather than depth.
- **Accept:** A unit test shows that with spread > max, entry pricing throws `SPREAD_TOO_WIDE` (or the existing code) and exit pricing still succeeds.

### H7 · HIGH · Auto-exit uses stale prices and silently stops when the calendar fails
- **Where:** `backend/src/services/auto-exit.service.js`, `exit-levels.service.js` `_isOpen`, and `market-calendar.service.js` `isExchangeOpen`.
- **Problems and fixes:**
  1. `currentPrice` comes first from the positionbook LTP (8–30 s stale). Prefer the WS `symbolQuoteCache` while it is fresh (for example within 5 s), then fall back to position LTP.
  2. Evaluation is skipped when `isExchangeOpen()` returns false, and that is also what it returns when **timings fail to load**. A calendar outage therefore disables every Indian stop-loss. Make `isExchangeOpen` return `null` (unknown) on load failure, and have auto-exit and exit-levels **fail open** (evaluate) on unknown. The `_isOpen` catch→true never fires today.
  3. `closePosition` closes the whole symbol (every product, every holder) when one product row hits its level. Close only the matching product, and for strategy legs only the leg's quantity (rule 7).
  4. Entry fallbacks: delete `_resolveCrossInstanceMedianLtp`, which uses other instances' *current* LTP as *entry*, and the tradebook `dummyMap` 'BROKER A/B/C' placeholders. If neither the broker average price nor the tradebook gives an entry, skip and warn once per symbol.
  5. Remove the `config.autoExit` env overrides (`AUTO_EXIT_*`). They become constants or Settings rows (rule 5).
- **Accept:**
  - Unit tests: with calendar load failing, evaluation still runs; with a fresh WS quote, it uses the WS price.
  - `grep _resolveCrossInstanceMedianLtp` returns nothing.

### H8 · HIGH · The chart entry and levels differ from what auto-exit uses
- **Where:** `backend/src/services/positions.service.js` `_resolveEntryPrice`.
- **Problem:** It ignores the broker `average_price` and uses a tradebook average of mixed buys and sells, then the last order price, then the fallback cache, then the cross-instance median. Auto-exit uses `extractAveragePrice(pos)`, so the chart draws targets and stops where auto-exit will not act.
- **Fix:**
  1. Use `extractAveragePrice(pos)` first, then a tradebook average of entry-side trades only, then null.
  2. Delete the median-LTP and last-order rungs.
  3. `_buildTradeAvgMap({force:true})` must not force a tradebook fetch per request. Use the feed cache.
- **Accept:** A unit test with a position whose `average_price` = 101.5 returns 101.5.

### H9 · HIGH · [OWNER] ANCHOR_OFS is advertised but not implemented
- **Where:** `quick-order.service.js` (~L1260–1283, `TODO: Implement strike-specific resolution`), plus the UI files in the Fix list.
- **Problem:** Anchors are written to `watchlist_symbols.anchored_ce_strike`, `anchored_pe_strike` and `anchored_expiry` but never read. REDUCE/INCREASE under ANCHOR trade a **fresh ATM strike**, which is the wrong leg once ATM has moved. Strategy legs store `strike_policy`, which is never used.
- **Fix (default = remove):**
  1. Remove the ANCHOR_OFS option from `public/js/quick-order-controls.js` (~149–166), `quick-order-selectors.js` (~170–180), `quick-order-core.js:20`, `dashboard-chart.js` (~1488, 2546, 2574), `strategy-builder.js:318` and `routes/v1/quickorders.js:94`.
  2. Remove the server branches.
  3. Write a migration that drops `anchored_*` and `strike_policy`, or leaves them unused if dropping a column is impractical with SQLite. Prefer the table-rebuild pattern already used in the migrations.
  4. Bump `?v=`.
- **Accept:** `grep -rn "ANCHOR" backend/src backend/public/js` is empty.

### H10 · HIGH · A stale ATM strike can be traded for up to 5 minutes
- **Where:** `quick-order.service.js` `symbolResolutionCache` (5-min TTL), which `strategy.service._resolveLeg` also uses.
- **Fix:** Delete the cache, or set the TTL to 5 s. Resolution is a local instruments-table query plus an LTP lookup.
- **Accept:** Two FLOAT_OFS resolutions made after the LTP crosses a strike boundary return different strikes (unit test with a stubbed LTP).

### H11 · HIGH · The browser stream drops events for most instances
- **Where:** `backend/src/services/ws-gateway.service.js` `instanceFilter`, which is resolved once at boot in `server.js` (~L280–300).
- **Problem:** Only instances with `use_ws_quotes=1` at boot pass the filter. `positions:update`, `funds:update` and `order_update` for any other instance, or for an instance added later, are dropped.
- **Fix:** Remove the filter. Also remove the unused `last_seq`/`seq` replay metadata.
- **Accept:** A unit test shows the gateway forwards a `positions:update` for an instance with `use_ws_quotes=0`.

### H12 · HIGH · Instruments: three importers, mixed expiry formats, FTS bloat, Indian data may never refresh
- **Where:** `backend/src/services/instruments.service.js`: `refreshInstruments`, `fetchFromInstance`, `importFromCSV` and `needsRefresh`.
- **Problems:**
  - There are three import implementations. Each uses different transactions, delete semantics and expiry formats (raw vs ISO). `importFromCSV` deletes **all** exchanges, crypto included.
  - The manual `DELETE FROM instruments_fts` plus a partial reinsert (symbol and name only) on an **external-content** FTS5 table corrupts and bloats the index.
  - **Measured:** `instruments_fts_docsize` has 6,005,544 rows against 135,873 instruments. The FTS takes 237 MB of the 367 MB DB.
  - `refreshInstruments(null)` picks a round-robin instance, which may be crypto-only (Delta).
  - `needsRefresh()` checks the latest log for *any* exchange, so Indian instruments may never auto-refresh.
- **Fix:**
  1. Write one `replaceExchange(exchange, rows)` that, in one transaction, deletes the rows for that exchange, bulk-inserts them, and normalizes expiry to **one** format (pick the one `buildOptionChain` expects; then delete `_getExpiryFormats` multi-format probing).
  2. After a bulk load, run `INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')`. Drop all manual FTS deletes and inserts.
  3. All three entry points call `replaceExchange`. `importFromCSV` replaces only the exchanges present in the CSV.
  4. Refresh **per segment** (Indian or crypto) from an instance that serves that segment. `needsRefresh(segment)` checks only that segment's log.
  5. Trigger the refresh from a cron (for example 08:30 IST for Indian, plus the existing crypto cron) and once at boot if stale. Delete the blocking refresh in `middleware/instruments-refresh` (up to 120 s inside an HTTP request). The middleware may only report.
  6. Write a one-time migration: FTS `rebuild`, then `VACUUM`. VACUUM cannot run inside a transaction, so run it after the migration transaction, or as a startup step guarded by a flag. Expected DB size is about 70 MB.
- **Accept:**
  - After a refresh, `SELECT COUNT(*) FROM instruments_fts_docsize` ≈ `SELECT COUNT(*) FROM instruments`.
  - Search for "NIFTY" still works.
  - The logic tests pass.

### H13 · HIGH · One SQLite write per WebSocket tick
- **Where:** `backend/src/services/market-data-feed.service.js`, `setQuoteSnapshot` → `_persistQuoteSnapshot`, and the hydration code.
- **Problem:**
  - Every tick upserts `quote_snapshots`. The dedupe test (`hash===hash && fetchedAt===fetchedAt`) is never true.
  - The per-instance quoteCache holds only the last tick, so hydration restores one stale symbol.
- **Fix:**
  1. Delete the `quote_snapshots` persistence, the hydration, and the per-instance quote cache, if only telemetry reads it.
  2. Drop the table via a migration.
  3. Rewrite `GET /snapshots/quotes` to read `symbolQuoteCache` for the requested symbols, and **never** call `refreshQuotes({force:true})` from a request.
- **Accept:**
  - `grep -n quote_snapshots backend/src` shows only the drop migration.
  - The chart still shows quotes.

### H14 · HIGH · Five overlapping health systems
- **Where:**
  1. The client `instance-health-tracker` (circuit breaker).
  2. The client `errorCounters` (being removed by H3).
  3. `market-data-feed` `instanceHealth` plus a 30 s ping loop.
  4. `instance-health-check` `healthCache` plus DB `health_status` (60 s ping via polling).
  5. `market-data-circuit-breaker`.
- **Fix:**
  1. Keep (1) as the single source of truth for whether a call is allowed.
  2. Keep one ping loop (4) that writes `health_status` for the UI and feeds (1).
  3. Delete the feed's own ping loop and `instanceHealth`, and fold (5) into (1), or delete (5) if it only duplicates it.
  4. `getCacheStatus` must not reach into breaker internals.
- **Accept:** Exactly one place pings instances (grep for `ping`/`testConnection` in intervals), and the tests pass.

### H15 · HIGH · The logger silently drops most fields
- **Where:** `backend/src/core/logger.js` `kvFormatter`.
- **Problem:** Only allowlisted meta keys are printed, so `err`, `id`, `host_url`, `session_pnl` and many others vanish.
- **Fix:** Print every primitive meta key (string, number or boolean; `sanitizeMeta` already strips objects), keep the redaction of `token`/`api_key`/`apikey`/`password`, and serialize `err` as `err.message`.
- **Accept:** A unit test shows `log.info('x', {foo: 1, api_key: 's'})` prints `foo=1` and redacts the key.

### H16 · HIGH · Polling cycles overlap, so the session cutoff can double-close
- **Where:** `backend/src/services/polling.service.js` and `config.instanceHealth.analyzerCheckIntervalMs`.
- **Problem:**
  - There is no in-flight guard. A slow broker causes overlapping 15 s cycles, which can run concurrent `toggleAnalyzerMode` calls and so issue `closeAllPositions` twice.
  - `analyzerCheckIntervalMs=15000` defeats the intended 60 s TTL.
- **Fix:**
  1. Add a per-instance in-flight guard: a `Set`, skipping the instance if its last cycle is still running.
  2. Set the analyzer check to 60 s.
  3. Fix the stale comments ("health every 5m").
- **Accept:** A unit test shows that calling `pollInstance(id)` twice concurrently runs the work once.

### H17 · HIGH · Each open chart generates heavy broker traffic
- **Where:** `backend/public/js/chart-live.js` (polling every `CHART_POLL_MS` = 3 s).
- **Problem:** When WS is not streaming the charted symbol, every poll hits `/snapshots/quotes` (a forced global refresh today), `POST /symbols/quotes` for both option panes, and `/symbols/quotes?instanceId` for the future.
- **Fix:**
  1. After H13, `/snapshots/quotes` is cache-only.
  2. Subscribe the pane contracts and the future to WS via the existing `ensureSymbolSubscribed`.
  3. Poll only for symbols that have no WS stream, at 3 s or more.
  4. Bump `?v=`.
- **Accept:** With the chart open and the WS streaming, the server logs show no `multiquotes`/`quotes` broker calls caused by chart polls.

---

## 5. PHASE 2 — Dead code and useless features (delete)

> For each row: grep every listed symbol, delete it, delete or adjust its tests, and run lint and the logic tests. Drop tables with a single new migration (`NNN_drop_dead_tables.js`), following the existing migration style.

### 5.1 Dead routes and API wrappers
| ID | Delete | Notes |
|---|---|---|
| D1 | `POST /api/v1/symbols/utils` with `executeSymbolOperation`, `normalizeExpiryToISO`, `buildOptionSymbol`, `buildFuturesSymbol`, `parseOptionSymbol` and `parseFuturesSymbol` in `routes/v1/symbols.js` (~280 lines) | Also delete the `public/js/api-client.js` wrappers `symbolUtils`, `getDerivativeExchange`, `extractUnderlying`, `formatExpiry`, `normalizeExpiry`, `buildOptionSymbol`, `buildFuturesSymbol`, `parseOptionSymbol`, `parseFuturesSymbol` and `placeOrder`. |
| D2 | `GET /orders/:id` (plus `getOrderById`/`getOrderStatus` if they have no other caller), `GET /instruments/:exchange/:symbol`, `GET /positions/:instanceId` | The UI never calls them. Check the e2e and integration tests first. |
| D3 | `GET /api/v1/settings` and `settingsService.getAllSettings`/`rawValue` | The UI should use `/settings/schema` only (update `settings-*.js`). Move `ensureEssentialSettings` to startup. Delete the stale comment "Nothing is flagged is_sensitive today". |
| D4 | The per-route `logAudit()` helpers in `routes/v1/instances.js`, `orders.js`, `positions.js` and `quickorders.js` | The `auditLogger` middleware already covers them. The kill switch keeps its explicit result log. |
| D5 | `/auth/logout` (no-op) and its 2 frontend callers | Clear the token client-side only. |
| D6 | `/auth/change-password` **[OWNER]** | It has no UI. Default: delete. Fix the null-row TypeError if it is kept. |

### 5.2 Dead services, methods and wrappers
| ID | Delete | Where |
|---|---|---|
| D7 | `resolution-cache.service.js` (whole file) | Also the client wrappers `cacheResolvedSymbol`, `getCachedResolvedSymbol`, `cacheLotSize`, `getCachedLotSize` and `preloadLotSizes`. |
| D8 | `symbol-resolution.service.js` (whole file) | `/symbols/search` calls it and then `symbolValidationService.searchSymbols`. Keep the latter only. |
| D9 | Client `instanceHealthConfig` getter; `requiresManualRefresh`, `instanceRequiresManualRefresh`, `dnsRetryCount` and `maxDnsRetries`; the stub doc comments without methods (holdings, modify, option-chain fallback, multi greeks, account summary); `getRateBudgets.ordersPerSecondPlain` | `client.js` |
| D10 | The client position-snapshot dedupe: `OPENALGO_FAST_SNAPSHOT_MODE`, `initialPosition`, `_getPositionForOrder`, `_hasPositionChanged` (~L476–505, 660–735) | `_awaitOrderInBook` decides. This also removes an extra positionbook call per resting order. |
| D11 | `OPENALGO_INSTANCE_TIMEOUT_MS_MAP`, `_loadInstanceTimeoutOverrides` and `_getInstanceTimeoutMs` | Violates the single-source rule. |
| D12 | `instance-health.service`: `updateTestConfig`, `validateTestConfig`, `persistTestConfig`, `getTestConfig`, the `instance_health_tests` setting, and `testOptionChain` (its probe list is always empty) | Remove the setting via migration or registry. |
| D13 | `instance.service`: `_computeSessionState` and the dynamic-import wrappers (`updateHealthStatus`, `resetHealthCheckState`, `updatePnLData`, `refreshAnalyzerStatus`, `toggleAnalyzerMode`, `testConnection`, `testApiKey`) | Callers import the real service directly. |
| D14 | `quick-order-history`: `getQuickOrderById` and `getQuickOrderStats` (~170 lines) | No route uses them. |
| D15 | `watchlist.service.cloneWatchlist` | No route. |
| D16 | `expiry-management`: `getExpiries`, `_cacheExpiries`, `_processExpiries` and `_is*Expiry`, plus the **`expiry_calendar` table** | The table is write-only. |
| D17 | The **`symbol_cache` table** (38,664 rows) and its code | It duplicates `instruments` and can serve expired contracts. |
| D18 | The **`watchlist_options_state` table**, `_syncOptionsState`, `_getAggregatedTypePosition` and the `useTypeScope` branch | Write-only, and the branch is unreachable after an early return. |
| D19 | `quick-order.service`: the dead EXIT branch in `_executeDirectOrder`, `verifyPosition`/`verifyFinalOptionsPosition` (fire-and-forget positionbook calls), `_captureFallbackEntryPrice` (an extra quote call per order), the duplicate `if (!expiry)` in `_closePositions`, CLOSE_ALL_*/EXIT_ALL in `isReduceOrClose` (they never reach that path), and the 3 copies of the options action lists (keep 1) | |
| D20 | About 45 one-line delegating wrappers in `quick-order.service` (`_getUnderlyingLTP*`, `_recordQuickOrder`, `_parse*`, `_normalize*`, the quote helpers, `getQuickOrders`, `sync`, `byId`, `stats`, and so on) | Call the util or service directly. The file is 3,719 lines; aim for under 2,500. |
| D21 | `risk-events.list()` if it has no caller | |
| D22 | `market-data-feed`: `applyConfig(configOverride)`/`_restartIntervals` if dead, `pauseNonCriticalPolling` (only affects funds), the duplicate `getCachedQuotesForSymbols` vs `getCachedQuoteEntriesForSymbols` (keep 1, without the legacy numeric-ttl signature), and `_isDummyEntryPrice` (it treats a real price of 100, 1 or 0.01 as dummy) | |
| D23 | `quick-order-quotes.getUnderlyingLTPWithFallback` → `fetchLtpForSymbol` | It picks a pool only for logging, and throws when the pool is empty. |
| D24 | `instance-session.util` fallback sessions | Use `settingDefault('trading_sessions')`. Also delete the `max_loss_hits`/`LIMIT_REACHED` machinery, which is unreachable. Fix the auto-revert `startsWith('SESSION_MAX_LOSS')` condition to match its comment. |
| D25 | `dashboard.service` fallbacks that read nonexistent columns (`total_trade_value`, `total_buy_trades`, `total_sell_trades`) | |
| D26 | Errors: `BadRequestError`, `ConflictError` and `RateLimitError` if unused; `log.openalgo` if unused | grep first. |

### 5.3 Features to remove
| ID | Feature | Default | Delete |
|---|---|---|---|
| F1 | ANCHOR_OFS | remove | See H9. |
| F2 | Telegram per-user linking **[OWNER]** | remove; keep only `TELEGRAM_DEFAULT_CHAT_ID` sends | The `telegram_subscribers` table (migration), `handleWebhook`, the `/api/v1/telegram/webhook` route, `ensureSchema()`, the `TELEGRAM_BOT_USERNAME` and `TELEGRAM_WEBHOOK_SECRET` env keys, and `backend/link-telegram-manual.md`, which documents a nonexistent route. Make `send` a **silent no-op** when the token or chat is unset; this ends the 1,503 `telegram_notify_failed` WARN lines. |
| F3 | `LOG_NOTIFICATIONS` (mirrors every warn into notifications via a second SQLite connection) | remove | Replace it with one explicit `notify(type, message, meta)` used for meaningful events: futures roll or blocked roll, kill switch, exit level fired, session cutoff, max-loss cap, unhealthy instance with open positions. Delete `pushNotification` and its second connection in `logger.js`. |
| F4 | `is_broadcast` column on watchlists | remove | `type='broadcast'` is the single source. Migrate any readers. |
| F5 | Settings UI dead code | remove | The `'streaming.enabled'` branch and `applyStreamingPreference`, the unused `togglePasswordVisibility`, `settings-core.authFetch` (use `api.request`, which has 401 handling), and the commented-out `console.log`s. |
| F6 | Startup banner in `server.js` (~L312–340) | remove | It is stale ("Health Checks: Every 5m"). Keep one `log.info('listening', {port})`. |

### 5.4 Noise
- Delete the 13 `// debug: removed noisy log` comments (`grep -rn "removed noisy log" backend/src backend/public`).
- Delete the `console.debug` at `public/js/dashboard-watchlists-positions.js:18`.
- `/health` hard-codes version `'2.0.0'`. Read it from `package.json` or drop the field.

---

## 6. PHASE 3 — Consolidation, correctness (MED) and performance

### P3-1 · DB size and retention
1. Use the H12 FTS rebuild plus VACUUM.
2. Add retention to the existing 6-hourly prune job:

   | Table | Rows today | Retention |
   |---|---|---|
   | `candles` | 181,704 | 30 days, or by owner setting |
   | `risk_events` | 2,141 | 30 days |
   | `notifications` | 171 | 30 days, read only |
   | `quick_orders` | 2,123 | 90 days |
   | `watchlist_orders` | 4,533 | 90 days |

   `audit_logs` (7 days) and idempotency are already pruned.
3. Every trailing ratchet inserts a `risk_events` row. Insert only on a level change of at least one tick, or only on first arm and on fire.
4. **Accept:** The prune test deletes old rows, and the DB is under 100 MB after migration and VACUUM.

### P3-2 · Remove `UPPER()` on indexed instrument columns (full scans)
- Columns are stored upper-case at import. `UPPER(exchange)`, `UPPER(symbol)` and `UPPER(underlying_key)` force a full scan of 135,873 rows (measured: 0.66 s vs 0.01 s).
- Remove them in:
  - `market-data-feed._frameIsForItsLabel`
  - `exit-levels` `_classify` and projections
  - `quick-order._validateOptionContract`
  - the history routes (`/symbols` JOIN, `/option-legs` ×3, `/future`, `/exposure`)
  - `futures-roll` `listFutures`
- Upper-case the **parameter** in JS instead.
- Find them with `grep -rn "UPPER(" backend/src`.

### P3-3 · Market-data feed throughput
- `refreshPositions`/`refreshFunds` run sequentially with a 2–4 s random sleep per instance, so the "8 s active" interval is unattainable. Run them in parallel (`Promise.allSettled`); the client already rate-limits.
- Add in-flight guards to `refreshQuotes`, `refreshPositions` and `refreshFunds`.
- The `refreshQuotes` fallback queries non-multiquote instances with 3 attempts. Restrict it to the multiquote pool.
- Use a single source for intervals. `DEFAULT_*` constants, config and `||` fallbacks disagree: the dynamic position refresh uses 8 s/30 s while config says 8 s/20 s. Keep one.
- WS service:
  - Reconcile connections on instance create, update (API key), deactivate and delete. Today they are fixed at start.
  - Unsubscribe depth subscriptions that are no longer needed.
  - Add `instanceId` to the order-update dedupe key.
- Throttle the quotes broadcast to the browser, for example coalescing per symbol every 250 ms.

### P3-4 · Configuration single-source cleanup
- Remove env overrides for:
  - `AUTO_EXIT_*` (4)
  - `TRADINGVIEW_BROADCAST_*` (4, see C4)
  - `OPENALGO_FAST_SNAPSHOT_MODE`
  - `OPENALGO_INSTANCE_TIMEOUT_MS_MAP`
- Keep `PROXY_TLS_REJECT_UNAUTHORIZED`, which is a deployment fact.
- `/public-config` `marketData` fallbacks (`|| 30000` and similar) duplicate config. Remove them, or remove `marketData` if the frontend doesn't use it.
- Registry help text for `openalgo.request_timeout_ms` says "a retry cannot double it". That is **false**: orders with an unknown outcome are never re-sent. Rewrite it.
- Settings validation:
  - Sessions need `start < end` and no overlap.
  - The broker-map and broker-flags JSON editors need shape validation: numeric values ≥ 0 and known broker keys.
- `isTestMode()` reads env twice. Use one read.

### P3-5 · Unify expiry helpers
About 10 expiry parsers and formatters exist, in `derivative-resolution`, `option-chain`, `options-resolution`, `instruments`, `routes/v1/symbols`, `client.toBrokerExpiry`, `utils/underlying.util` and `utils/symbol-parsing`. Create **one** `utils/expiry.js` (parse, toISO, toBroker, display) and switch every caller to it. Do this after H12 fixes the stored format.

### P3-6 · Unify order and pricing helpers
- Create one `utils/order-helpers.js` containing:
  - `normalizeStatus` (×4 today)
  - `getLivePosition`/`extractPositionQty` (×2, with the H5 semantics)
  - `cancelOpenOrdersForSymbol` (×2)
  - tick rounding (`_roundToTick`, `_applyBufferAndTick` and `roundToNearestTick`, ×4)
  - `countDecimals` (×2)
  - the `_normalizeSymbol`/`_Exchange`/`_Product` wrappers (×3)
- LTP extractors: there are 4 (`client._extractLtp`, `feed._extractLtpFromQuote`, `utils/price-extraction.extractLtp` and quick-order-quotes). Keep **one**, `extractLtp(quote, {forOrder})`. With `forOrder`, use only `ltp`, `bid` and `ask`, and never `close`/`prev_close`/`open`/`high`/`low`, because a fill-now LIMIT must not be priced off yesterday's close. `fetchLtpForSymbol` must not return `close` as LTP on the order path.
- `extractChangePercentFromQuote` falls back to an absolute `change` value and treats it as a percent. Drop that fallback.
- There are four option-chain builders. Keep the instruments-backed one.
- `getUnderlyingForClosing` exists in two places. Keep one.

### P3-7 · Order and strategy correctness (MED)
- `_resolveOrderTypeForInstance` ignores the exchange. Pass it in, so that an Indian exchange always resolves to LIMIT.
- `_closePositions` uses the watchlist row's `tick_size` for option and future legs. Resolve the tick size per contract.
- `_validateOrderParams` must require `Number.isInteger(quantity) && quantity > 0`.
- Coalescing in `order-placement` replaces a queued payload with a different caller's payload for the same symbol. Coalesce only payloads from the same source, and document this.
- `order.service.cancelOrder` should reject early when `order_id` is null.
- `strategy.reconcileOrderUpdate` closes ledger rows on **any** opposite fill for that symbol. Match by order id or strategy tag.
- `deleteStrategy` leaves the auto-seeded anchor row and the leg exit-config `watchlist_symbols` rows behind. Delete them, or confirm they are removed by FK CASCADE.
- `MARGIN_BASED` legs size against the strategy underlying, an untradable index. Use the resolved leg contract and its lot size.
- `exit-levels.fire()`: a failed exit still marks the level `TRIGGERED`, and a crash leaves it `TRIGGERING` forever. On failure, revert to `ARMED` and increment an attempt count (max 3, then `FAILED` plus notify). On boot, reset any row stuck in `TRIGGERING`.
- After sending LIMIT exits, the kill switch reads `stillOpen` immediately. Poll for up to about 10 s before reporting "left LIVE".
- `broker-units`: convert `placegttorder` and margin payloads too. Fail loudly if the units table is missing rather than tolerating it.
- `positions` close route: for an exact-symbol close, ignore the client's `tradeMode`. The UI derives it with `includes('CE')`, so a symbol such as `RELIANCE` would be misread. Also fix `dashboard-watchlists-positions.getTradeModeFromSymbol`.
- `deleteInstance` uses a raw `BEGIN TRANSACTION`, which bypasses the `db.transaction` queue. Use `db.transaction`. Also delete `trailing_state` rows, because they are not FK-cascaded. Refuse when the instance has open positions, unless forced. Clear the feed caches for that instance.

### P3-8 · Database and middleware
- `core/database.js`: plain `db.run` calls made during an open `transaction()` execute inside it and are rolled back if it fails. Document this at minimum. Preferably route all writes through the queue, or keep the long imports (H12) short per exchange.
- Migrations: wrap each migration in a transaction. On startup, fail if there are pending migrations.
- `optionalAuth` makes 3 DB queries per request. Cache user, role and permissions for 30 s, keyed by user id, and invalidate the cache on any RBAC change.
- Idempotency: a `pending` row left by a crashed request blocks that `request_id` for 7 days. Expire pending rows after 5 minutes.
- `incrementSignalCounts` and `_upsertDailyPnlSnapshot` do a select and then an insert. Use `INSERT … ON CONFLICT DO UPDATE`.
- `/register` has a race: two concurrent registrations can both create an admin. Use `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM users)`.
- RBAC:
  - `requireAdmin` checks `users.is_admin`, so users with the Admin role cannot use CSV import/export. Use `requirePermission('settings.manage')`.
  - Add `DELETE /rbac/users/:id`, which must refuse to delete the last admin.
  - Reuse one password validator (byte-length ≤ 72) in `rbac` and `auth`.
- Watchlist and instance CSV import duplicate about 200 lines of a generic table copier and run without a transaction. Write one helper, run it inside `db.transaction`, and use an explicit column allowlist.
- `watchlist.updateSymbol`/`removeSymbol` load the whole watchlist only to read its `type`. Use a light query instead.
- `/:id/refresh` on instances is gated by the view permission but triggers broker calls. Require the manage permission.

### P3-9 · Frontend
- A partial settings save shows "Successfully updated X of Y" as a success toast, while the rejected keys only go to `console.error`. Show the rejected keys and their reasons as an error toast.
- `handleSearch` double-renders. Fix it.
- `markAllNotificationsRead` sends one POST per row. Add `POST /notifications/read-all` and remove the header comment about the removed Audit view.
- **[OWNER]** Service worker: the asset cache, keyed by `?v=`, grows forever, and `/vendor` stays pinned until someone manually bumps `CACHE_NAME`. This keeps causing stale-UI bugs. Default: use network-first for `/js`, `/css` and `/vendor`, and delete old caches on `activate`.

### P3-10 · [OWNER, optional] Merge the two order tables
`watchlist_orders` and `quick_orders` overlap. `quick_orders` syncs only on "Sync", while chart lines read `watchlist_orders`. Default: **defer**. If approved, `watchlist_orders` becomes the single table, with `quick_orders` replaced by a view or migrated.

---

## 7. Owner decisions (apply the default unless overridden)

| # | Decision | Default |
|---|---|---|
| O1 | ANCHOR_OFS: remove or implement | **Remove** (H9) |
| O2 | Telegram per-user linking | **Remove**; keep the default-chat sends (F2) |
| O3 | `watchlists.limit_buffer_pct` | **Drop** with the C4 rewrite |
| O4 | `/auth/change-password` (no UI) | **Delete** (D6) |
| O5 | Service worker caching | **Network-first** for assets (P3-9) |
| O6 | 407 tracked AI-tooling files (`.agent/`, `.codex/`, `.shared/`, `.claude/skills/{banner-design,brand,design,design-system,slides}`), plus the `.githooks/pre-commit` and `scripts/sync-architecture.sh` that copy ARCHITECTURE.md | **Untrack and gitignore**, and remove the hook and script (`git config --unset core.hooksPath`) |
| O7 | `backend/public/vendor` (337 files, 6.1 MB) is committed **and** regenerated by `postinstall` | **Gitignore it** and rely on postinstall |
| O8 | Merge the order tables | **Defer** (P3-10) |
| O9 | Candle retention period | **30 days** |

---

## 8. PHASE 4 — Docs and repo hygiene

1. Untrack junk:
   - `data/sessions.db` (old express-session store)
   - `backend/database/live.db.instruments` (0 bytes)
   - `backend/link-telegram-manual.md` (F2)
2. Apply O6 and O7.
3. Fix stale docs:
   - `README.md:12` says "Lightweight Charts"; the app uses openalgo-charts.
   - `README.md:202` and `backend/.env.example:75` refer to "Settings → Advanced", which has been removed.
   - Remove the `TRADINGVIEW_*` and Telegram-linking keys from `.env.example`.
4. Rewrite `ARCHITECTURE.md`, currently about 1,017 lines of history narrative, **after** Phases 0–3. Target about 300 lines covering the current modules, data flow, order-safety invariants (§1), settings sources and the test layers. Remove the references to the nonexistent `services/pnl.service.js` and `integrations/openalgo/endpoints.js`, the "33 scripts" count, and "Simple + Advanced".
5. Check `QUICKSTART.md`, `INSTALL.md` and `BEGINNER_GUIDE.md` for removed features (Telegram linking, ANCHOR_OFS, Advanced settings, env knobs). Update or cut them.
6. `update.sh`: remove the env migrations for deleted keys (C4, P3-4).

---

## 9. Verification checklist

### 9.1 After every item (offline)
```bash
cd backend && npm run lint && npm run test:logic
```

### 9.2 Broker test gates (required)

The three broker suites place orders on real accounts in analyzer mode. They are **required** at the points below and must not be run at any other time.

**When they are required:**

| Gate | When | Suites | Why |
|---|---|---|---|
| G0 Baseline | Before the first Phase 0 commit | all three | Records failures that already exist, so later failures can be attributed to the fixes. |
| G1 | After Phase 0 is complete | all three | C1–C5 change cancels, retries, broadcast and session P&L. |
| G2 | After Phase 1 is complete | all three | Rate limits, pricing, auto-exit and positions change. |
| G3 | After Phase 2 is complete | all three | Routes and tables are deleted. |
| G4 | After Phase 3 is complete, before merge | all three | Final full check. |

Phase 4 is docs only and needs no broker gate.

**Procedure (every gate):**
1. Before anything else, confirm that instances 3, 6, 19, 20 and 26 are all in **analyzer mode**. If any is live, **stop and ask the owner**. Never switch an instance's mode yourself.
2. Run the suites **serially**. Start the next suite only after the previous one has exited, and never run two at once:
   ```bash
   cd backend && npm run test:integration
   cd backend && npm run test:e2e
   cd backend && npm run test:live
   ```
3. Afterwards, verify that **no positions or open orders remain** on any of the five instances. If something is left open, report it and stop. Do not continue to the next phase.
4. Record the results in the phase summary: pass/fail counts per suite, and how they compare with G0.
5. **Failures:**
   - If the test also failed at G0, or the failure is environmental (broker down, auth expired, market closed, rate limit, network), report it with the output. Do **not** change code to make it pass.
   - If it is a new failure caused by this phase's changes, fix it, rerun only the failing suite, and report what you changed.
   - If you can't tell which kind of failure it is, stop and ask the owner.

### 9.3 Phase checklist (tick when done)
- [x] **G0:** baseline recorded.
- [x] **Phase 0:** C1–C5 merged. New tests exist for C2, C3, C4 and C5. On a cold start with no browser, the logs show auto-exit running. **G1 passed.**
- [x] **Phase 1:** H1–H17 merged. `?v=` bumped for every changed public file. **G2 passed.**
- [ ] **Phase 2:** every D/F item is deleted, the drop-tables migration is applied on a **copy** of the DB, and `grep` confirms no references remain. **G3 passed.** _(In progress — see docs/reviews/phase-2-impl.md: D1–D26 done except D4 (blocked); F1–F6 and §5.4 done; migrations 075–077 applied on a copy; G3 not passed: the open Kotak order from the last run must be cancelled first.)_
- [ ] **Phase 3:** the DB is under 100 MB after migration and VACUUM, there are no `UPPER(` calls on instrument columns, and the retention job is tested. **G4 passed.** _(In progress — P3-1 to P3-5 done, see docs/reviews/phase-3-impl.md; P3-6 to P3-10 not done; G4 not run.)_
- [ ] **Phase 4:** docs are updated, and junk and AI tooling are untracked (per O6/O7).

Final sanity greps (each should return nothing):
```bash
grep -rn "startServices\|_cancelAllForRetry\|_cancelAllOrdersForRetry\|_postWithRetries\|_recoverOrderFromOrderbook" backend/src
grep -rn "ANCHOR_OFS\|quote_snapshots\|symbol_cache\|expiry_calendar\|watchlist_options_state" backend/src backend/public/js
grep -rn "TRADINGVIEW_\|AUTO_EXIT_\|OPENALGO_FAST_SNAPSHOT_MODE\|OPENALGO_INSTANCE_TIMEOUT_MS_MAP" backend/src backend/.env.example update.sh
grep -rn "removed noisy log" backend/src backend/public
```

---

## 10. Scope notes and limitations of this audit

- The backend was reviewed fully: routes, services, utils, middleware, migrations, settings registry, logger, client, scripts, install and update scripts.
- The frontend was reviewed for:
  - timers and polling
  - settings UI
  - notifications
  - charts
  - ANCHOR UI
  - escaping (272 `Utils.escapeHTML` uses; toasts use `textContent`, so no XSS was found)
  - service worker

  Purely visual CSS was not audited.
- Integration, e2e and live suites were **not** run, because they need real brokers. Every live-order finding (C3, C4, C5) was established by code reading, by log evidence and by the documented OpenAlgo semantics. Confirm them on analyzer instances before a live deploy.
- The DB measurements were taken read-only on `backend/database/simplifyed.db`:
  - 367 MB in total
  - FTS 237 MB
  - 89,796 pages, 2,990 of them free
