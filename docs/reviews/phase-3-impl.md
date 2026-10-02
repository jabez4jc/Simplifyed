# Phase 3 implementation notes: P3-1 to P3-5

One commit per item, in ID order. Lint and `test:logic` were green after each (now **400 tests**; 379 at the start of the session, so 21 added). `database/simplifyed.db` was never written. No migration was needed.

| Item | Commit | What changed | Tests added |
|---|---|---|---|
| P3-1 | c029854 | New `services/retention.service.js` `pruneOldRows()`, called on boot and every 6 h from `server.js` (replaces the inline audit-log prune). Windows: `audit_logs` 7 d, `candles` 30 d (by `fetched_at`, which the upsert refreshes), `risk_events` 30 d, `notifications` 30 d **read only**, `quick_orders` 90 d, `watchlist_orders` 90 d (`placed_at`). Trailing ratchet: `STOP_RATCHET` rows are no longer written; only the first arm (`TRAIL_ACTIVATED`) and the fire (`TRAIL_HIT`, auto-exit) are recorded. The FTS rebuild + VACUUM part was already done by migration 073 (H12). | `retention.test.js` (3 tables' windows, unread notifications kept, 90 d tables). `risk-controls.test.js` updated: one event on arm, stop still ratchets. |
| P3-2 | cfd3564 | Removed every `UPPER()` on `instruments.exchange/symbol/underlying_key/instrumenttype` in `underlying.util`, `history` routes (`/symbols` JOIN, `/option-legs` x3, `/future`, `/exposure`), `instruments.service`, `exit-levels`, `quick-order._validateOptionContract`, `market-data-feed._frameIsForItsLabel`, `futures-roll.listFutures`. Parameters are upper-cased in JS (`resolveOptionLotSize` now upper-cases its key). | `instrument-lookups-indexed.test.js`: query plans use the indexes, mixed-case callers still work, no `UPPER(<instrument column>)` anywhere in `src`. |
| P3-3 | 94b1808 | **Feed:** `refreshPositions`/`refreshFunds` run all instances with `Promise.allSettled` (the 2-4 s random sleeps are gone); `refreshQuotes/Positions/Funds` are single-flight (a caller arriving mid-run gets the running promise); the quote fallback asks only the multiquote pool (no non-multiquote instances, no inter-instance sleep). **Intervals:** the `DEFAULT_*` constants, `\|\|` fallbacks and `start({quoteInterval})` are gone; `config.js` is the only source (position refresh is now 8 s / 20 s as config says, not 8 s / 30 s). **WS:** `openalgoWsService.reconcile()` is run on every quote tick, so instances created, re-keyed, deactivated or deleted after boot get/lose their connection; Depth subscriptions idle for 2 min are unsubscribed (`depthSubscriptionFrames` now also emits `unsubscribe`); the order-update dedupe key includes `instanceId`. **Gateway:** `quotes:update` is coalesced to the latest quote per symbol every 250 ms. | `feed-throughput.test.js` (parallel, single-flight, multiquote-only fallback, config-only intervals), `ws-reconcile.test.js` (reconcile, depth unsubscribe, per-instance dedupe, quote coalescing). |
| P3-4 | 028350a | The env overrides named in the report (`AUTO_EXIT_*`, `TRADINGVIEW_*`, `OPENALGO_FAST_SNAPSHOT_MODE`, `OPENALGO_INSTANCE_TIMEOUT_MS_MAP`) were **already removed** in Phases 0-2; grep is empty over src, `.env.example`, `update.sh`, `install.sh`. `/public-config` no longer has `\|\|` fallbacks (the frontend does use `marketData`, so it stays). `openalgo.request_timeout_ms` help text rewritten (an unknown-outcome order is never re-sent). `validateValue`: sessions need `start < end` and no overlap (touching is fine); `brokerage.by_broker` must be a map of lowercase-slug key -> number >= 0; `brokerage.market_order_support` must be a map of crypto broker -> boolean. `isTestMode()` reads `config` only (the live `process.env` read is gone). | `settings-registry.test.js` (2 tests); `runtime-mode.test.js` updated. |
| P3-5 | ef99d90 | New `utils/expiry.js`: `parseExpiry` (DD-MMM-YY, DDMMMYY, YYYY-MM-DD, rollover-safe), `toISO`, `toDisplay` (DD-MMM-YY), `toBroker` (DDMMMYY), `sameExpiry`. Deleted: `underlying.util.parseExpiry`, `client.toBrokerExpiry`, `derivative-resolution.{convertExpiryToOpenAlgoFormat, expandExpiryFormats, _resolveExpiryVariants}`, `option-chain._expandExpiryFormats`, `options-resolution.{_convertToOpenAlgoExpiryFormat, _normalizeExpiryToISO}`, `instruments.{_normalizeExpiryDate, _formatExpiryForDisplay}` and its month maps, `futures-roll.toRowExpiry`, the inline month arrays in `black76-pricing`, `symbol-parsing` (`parseFuturesSymbol`, `parseOptionSymbol`, `normalizeExpiryInput`, `expiryMatchesSymbol`). The multi-format DB probes (`expiry IN (variants)`, the 3-format loop in `options-resolution`) became one `expiry = ISO` lookup, since H12 stores ISO. | `Test/unit/expiry.test.js` (formats, rollover rejection, pass-through, and the converted callers). |

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

## Gate G4: not run

G4 is "after Phase 3 is complete, before merge". Phase 3 is not complete: P3-6 to P3-10 are outside this session. The earlier gates are also unresolved (Phase 2's G3 never passed: Kotak instance 3 still has the open order from the last run, and Phase 2's D4 is blocked). Running the suites now would stack these changes on an unverified baseline, and 9.2 step 3 says to stop when something is left open. **No suites were run, so there are no new numbers to compare with G0.**

P3-3 (feed/WS) and P3-5 (expiry in order resolution) touch live order paths and are the ones I would watch at the next gate: Fyers and Delta quotes arriving by WS after an instance is added, and option resolution for an expiry given as `YYYY-MM-DD`, `DD-MMM-YY` and `DDMMMYY`.

**Needs you:** (1) cancel the open Kotak order NIFTY06OCT2622400CE (id 26100258736054); (2) the D4 decision from Phase 2; (3) then G3, and G4 after P3-6 to P3-10.

## Checklist (§9.3)

Phase 3 stays **unticked**: P3-6 to P3-10 are not done and G4 has not passed. P3-1 to P3-5 are done; the DB-size, no-`UPPER(`, and retention-test conditions are met.
