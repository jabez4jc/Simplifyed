# Phase 2 (§5.1–5.2, D1–D26) — implementation review

Date: 2026-10-02. Scope of this session: D1–D26 only. **Not done here:** F1–F6 (§5.3) and §5.4 noise, which are also in the Phase 2 checklist box, so the box is **not ticked** (see the end).

One commit per item, in ID order. Two exceptions: D14+D15 share one commit, and D13 has a follow-up fix commit.

## Per item

| ID | Result |
|---|---|
| D1 | Deleted `POST /symbols/utils`, `executeSymbolOperation` and the six helpers (~320 lines), plus the `api-client.js` wrappers `symbolUtils`, `getDerivativeExchange`, `extractUnderlying`, `formatExpiry`, `normalizeExpiry`, `buildOptionSymbol`, `buildFuturesSymbol`, `parseOptionSymbol`, `parseFuturesSymbol` and `placeOrder`. None had callers. `?v=` bumped. |
| D2 | Deleted `GET /orders/:id`, `GET /instruments/:exchange/:symbol` and `GET /positions/:instanceId`, and `order.service.getOrderById`/`getOrderStatus` (no other callers). Removed the `/orders/1` probe from `orders.test.js`. |
| D3 | Deleted `GET /settings` and `getAllSettings`. The UI now loads `/settings/schema` only; `fetchAllSettings` is gone. `ensureEssentialSettings` now runs at startup in `server.js`, because `getAllSettings` was its only caller. The stale "nothing is flagged is_sensitive" comment is gone with it. The `rawValue` property is **kept**: `limit-price`, `futures-roll` and `broker-capabilities` still read it. `settings.test.js` now reads `/schema`. |
| D4 | **Not done — blocked.** The permission classifier refused the edit that removes the per-route `logAudit` helpers (reason "Logging/Audit Tampering"). Per its rules I did not retry it another way. Verified so far: `auditLogger` covers every POST/PUT/PATCH/DELETE under `/api/v1` and sanitises bodies, whereas `instances.update`'s `logAudit` logs the raw `req.body`. Files untouched: `routes/v1/{orders,instances,positions,quickorders}.js`. **Owner decision needed.** |
| D5 | Deleted `/auth/logout` from `server.js`. `api.logout()` now only clears the token (and is sync); `access-pending.html` no longer fetches it. |
| D6 | Deleted `/auth/change-password` (owner default). Five auth tests used it as their "authenticated probe", so they now probe a stub `requireAuth` route (`/whoami`). Three change-password tests were deleted. **Docs still mention it:** `QUICKSTART.md`, `INSTALL.md`, `BEGINNER_GUIDE.md`, `ARCHITECTURE.md` (Phase 4 item 5). |
| D7 | Deleted `resolution-cache.service.js` and the five client wrappers. |
| D8 | Deleted `symbol-resolution.service.js`. `/symbols/search` now calls `symbolValidationService.searchSymbols(query, instanceId, {exchange, instrumenttype})`, which gained a `filters` argument so the exchange and type filters still apply in SQL. `instrument-search.test.js` follows. |
| D9 | Removed the client `instanceHealthConfig` getter, `instanceRequiresManualRefresh`, and `requiresManualRefresh`/`dnsRetryCount`/`maxDnsRetries` (the field was never set to true). Removed six stub doc comments. `ordersPerSecondPlain` was already gone (H2). |
| D10 | Deleted the position-snapshot retry dedupe: `OPENALGO_FAST_SNAPSHOT_MODE`, `initialPosition`, `_getPositionForOrder`, `_hasPositionChanged`. `_awaitOrderInBook` decides, as before. |
| D11 | Deleted `OPENALGO_INSTANCE_TIMEOUT_MS_MAP`, `_loadInstanceTimeoutOverrides` and `_getInstanceTimeoutMs`. |
| D12 | Deleted the test-config machinery, `testOptionChain` and the `instance_health_tests` setting (the row is deleted in migration 075). The probes are now constants. The option-chain probe went away with its always-empty list. The `input-boundaries` test for it was deleted. |
| D13 | Deleted `_computeSessionState` and the dynamic-import wrappers. Callers (`polling.service`, `routes/instances`, two tests) use the real services. **Slip, fixed in a follow-up commit:** `instance.service` called its own removed wrappers (`this.testConnection`, `this.updateHealthStatus`), so `POST /instances` returned 500. Lint and the logic tests do not catch that; the integration run did. I then scanned all classes for dangling `this.x()` calls. |
| D14 | Deleted `getQuickOrderById`/`getQuickOrderStats` (and their wrappers in `quick-order.service`). |
| D15 | Deleted `cloneWatchlist`. `Test/live/live-watchlist-strategy.test.js` used it, so its helper now builds the copy inline (`getWatchlistById` + `createWatchlist` + `addSymbol`). That live test is not verified at G3 (see below). |
| D16 | Deleted `getExpiries`, `fetchExpiries`, `_cacheExpiries`, `_processExpiries`, `_is*Expiry` and `_formatDate`, and the `expiry_calendar` table (migration 075). The `/symbols/expiry` broker fallback now filters with `upcomingExpiries` and converts to ISO. |
| D17 | Dropped `symbol_cache` (migration 075) and `_cacheSymbol`/`_getCachedSymbol`/`_isCacheValid`. |
| D18 | Dropped `watchlist_options_state` (migration 075), `_syncOptionsState`, `_getAggregatedTypePosition`, the unreachable `useTypeScope` branch, and the delete in `deleteInstance`. |
| D19 | Removed the dead EXIT branch in `_executeDirectOrder`, `verifyPosition`/`verifyFinalOptionsPosition` (and the always-null `final_position`), `_captureFallbackEntryPrice` (3 call sites), the duplicate `if (!expiry)`, and `CLOSE_ALL_*`/`EXIT_ALL` from `isReduceOrClose`. The three options-action lists became one `OPTIONS_ACTIONS` constant plus `DIRECT_ACTIONS`. |
| D20 | Deleted 30 one-line wrappers; callers use the util or service directly (`getQuickOrders` and `syncQuickOrdersForInstance` are called on `quickOrderHistoryService` in the route). `_isRepeatExitAction` is kept (it has logic). **File size:** 3,719 → 3,227 lines; the "under 2,500" aim is **not met** — the rest is not wrapper code. |
| D21 | Deleted `risk-events.list()`. |
| D22 | Deleted `_restartIntervals`, `pauseNonCriticalPolling` (+ its funds-only guard), `_isDummyEntryPrice` and `getCachedQuotesForSymbols`. All callers use `getCachedQuoteEntriesForSymbols` (no legacy numeric-ttl form). **Behaviour change:** `start()` set `isRunning` and then called `applyConfig`, which called `_restartIntervals`, and `start()` then pushed the same intervals again, so quote and funds refresh ran on **two timers** each. That is now one. `applyConfig` is kept (it is called once, from `start`) but no longer takes an override. A real entry price of 100, 1 or 0.01 is no longer treated as a dummy. |
| D23 | Deleted `getUnderlyingLTPWithFallback`; the caller uses `getUnderlyingLTP`, which calls `fetchLtpForSymbol`. |
| D24 | Fallback sessions now come from `settingDefault('trading_sessions')`. Deleted the `max_loss_hits`/`LIMIT_REACHED` machinery, which was unreachable: switching to live resets the counter and any breach switches to analyzer. Auto-revert now requires `SESSION_MAX_LOSS_BREACHED` exactly and detects a new session via `session_baseline_at`, since `session_max_loss_hits_date` is gone. Two tests deleted (third breach, counter reset). **The columns `session_max_loss_hits(_date)` still exist, unused** — dropping them is a schema decision I did not take. There is no unit test for the auto-revert condition itself. |
| D25 | Removed the fallbacks that read nonexistent instance columns. |
| D26 | Deleted `BadRequestError`, `RateLimitError` (and their handler branches) and `log.openalgo`. **`ConflictError` is kept:** `rbac`, `watchlist`, `watchlist-symbol` and `instance` services use it. |

## Migration

`migrations/075_drop_dead_tables.js` drops `expiry_calendar`, `symbol_cache`, `watchlist_options_state`, and deletes the `instance_health_tests` row. Applied to a **copy** of `database/live.db` (it was at 070, so 071–075 all ran): all three tables gone, version 075, the copy went 124 MB → 103 MB (this includes the 073 FTS rebuild + VACUUM). `database/simplifyed.db` was never written.

## Greps

- The `ANCHOR_OFS|quote_snapshots|symbol_cache|expiry_calendar|watchlist_options_state` grep over `backend/src backend/public/js` returns nothing.
- A grep for every deleted symbol (`resolution-cache`, `symbolUtils`, `change-password`, `fetchExpiries`, …) over src, public/js, Test, e2e and scripts returns nothing.
- Logic tests: 377 at the start, 373 now (4 tests deleted with their features); lint clean after every item.

## Gate G3

Analyzer mode was confirmed **at the broker** on 3, 6, 19, 20 and 26 before starting. Suites ran serially.

| Suite | G0 baseline | G2 | G3 (this phase) |
|---|---|---|---|
| integration | 201 pass, 2 skip, 0 fail | 201 pass, 2 skip | **199 pass, 1 fail** of 200 (see below) |
| e2e | 83 pass, 3 fail, 1 skip, 9 not run | 93 pass, 3 skip | **83 pass, 2 fail, 11 not run** |
| live | incomplete | 96 pass, 138 fail, 134 skip | **133 pass, 28 fail, 206 skip** |

Integration:
- The first full run hung on the last file (`webhook.test.js`, passed everything then did not exit) and I killed it after ~40 min.
- The second run had **9 failures, all caused by my D13 slip** (`POST /instances` → 500). Fixed, committed, rerun.
- The third run has 1 failure, `webhook.test.js` "a retried alert with the same request id does not trade twice" (replay header missing). It passed 3/3 in isolation and in the first full run, so I classify it as a flake. The hang is also unexplained; the file exited normally in all four isolated runs.
- 203 → 200 tests because D3/D6 deleted tests that tested deleted routes.

e2e:
- `chart-orders-markets.spec.js:407` also failed at G0.
- `workflow-watchlist.spec.js` "MCX futures …" is a new failure name but **passed in isolation** (10 s) — broker timing.
- 11 did not run (single worker, later specs skipped after a failure).

Live, 28 failures:
- 24 Maha/Ana "no last price for NFO/BFO/MCX:…" — the same 24 as at G2 (environmental).
- 3 Fyers auto-exit tests (`POINTS`, `PERCENT`, `TRAILING`) fail with "CRUDEOIL19OCT26FUT position never appeared after BUY/SHORT". **I could not classify these** (no placement log lines found for them; MCX was open). They did not run at G2 in a comparable state. I did not rerun them, because of the stop condition below.
- 1 "every order and position this suite opened is closed" — see below.

**Stop condition hit.** After the run, positions are 0 on all five instances, but **instance 3 (Jz Kotak) has one open order: NIFTY06OCT2622400CE, order id 26100258736054**, left by `live-webhooks.test.js` (NFO was closed). I did not try to cancel it (a previous phase's cancel was blocked by the sandbox and by OpenAlgo's analyzer bookkeeping). Per §9.2 I stopped: no more suites, nothing further touched.

**Needs you:** cancel that order; decide D4; tell me whether the 3 Fyers live failures should be rerun in isolation (they need the market open and a clean Kotak first).

## Checklist (§9.3)

Phase 2 is left **unticked**, with a note on the line: D4 is blocked, F1–F6 and §5.4 are outside this session's scope, and G3 ended with an open order and 3 unclassified live failures.
