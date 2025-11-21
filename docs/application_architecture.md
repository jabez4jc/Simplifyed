# Simplifyed Admin – End-to-End Architecture (2025-11-20)

This document is the single source of truth for how the Simplifyed Admin application is built and how every feature works. It is written to be layman-friendly while remaining complete. Update this file whenever behavior changes.

---

## 1. Product Goals
- One console to manage many OpenAlgo broker instances (live or analyzer/paper).
- Place equity, futures, and options trades with guardrails that avoid unwanted shorts/longs and enforce broker product rules (NRML for derivatives).
- Keep quotes/positions/funds/orders/trades in sync with minimal OpenAlgo traffic via batching, pooling, and caching.
- Provide transparent debugging (what symbol is resolved, which instance was used, rate-limit reasons, etc.).
- Allow pausing all network traffic from the UI to protect against rate-limit/security bans.

---

## 2. High-Level Architecture
```
Frontend (dashboard.html + JS)
  - Views: Dashboard, Watchlists, Positions, Orders, Trades, Instances, Settings
  - JS: dashboard.js (orchestration), quick-order.js (trading UI), api-client.js, settings.js, utils.js

Backend (Node/Express, ESM)
  - Routes under /api/v1: instances, watchlists, quickorders, symbols, option-chain, positions, orders, trades, settings, polling/health
  - Services: market-data-feed, market-data-instance, quick-order, options-resolution, expiry-management, instruments, watchlist, instance, positions, orders, tradebook, pnl, auto-exit, settings, polling, cache
  - Integration: openalgo client (rate-limit & retry aware)
  - Persistence: SQLite via src/core/database.js

OpenAlgo Broker Instances
  - HTTP APIs: quotes, positionbook, funds, orderbook, tradebook, optionchain/search/symbol, placeSmartOrder, cancel, analyzer/ping
```

---

## 3. Frontend

### 3.1 Shell & Navigation
- Tailwind/DaisyUI layout in `backend/public/dashboard.html`.
- Sidebar with view links; header has refresh and pause/play (global polling toggle). App can start paused via `START_PAUSED=true` on backend; when paused, only cached data is shown—no live calls.
- Views are swapped by `dashboard.js` (`switchView/loadView`). Active nav styling driven by `validViews`.

### 3.2 Data Access Layer (`api-client.js`)
- Thin fetch wrapper returning JSON and normalizing errors.
- Modules: instances, watchlists, orders, positions, trades, symbols (search/validate/expiry/option-chain/quotes), quickorders, settings, polling/health.
- Uses shared headers and base URL; supports query params for filters (status, mode, etc.).

### 3.3 Watchlists & Quotes (`dashboard.js`)
- Accordion per watchlist; rows show symbol, exchange, type, expiry/strike, lot size, LTP, change %, volume, assigned instances, actions.
- Polling: `startWatchlistPolling` every ~10s unless paused. Calls `/symbols/quotes` once and maps results to all rows; shows source/timestamp meta. Quote cache TTL ~2s in backend shared feed.
- Expanding a row renders quick-order controls inline.

### 3.4 Trading UI (`quick-order.js`)
- Maintains per-symbol state maps: trade mode, expiry, options leg (ITM3…OTM3/ATM), operating mode (Buyer/Writer), strike policy (FLOAT_OFS/ANCHOR_OFS), step lots, selected product, quantity.
- Modes:
  - **Equity/Direct:** BUY (increase/open long), SELL (reduce longs only), EXIT (net to 0). Product from UI (CNC/MIS).
  - **Futures/Direct derivatives:** 5-button grid: BUY, SELL, SHORT, COVER, EXIT. BUY grows longs or flips shorts to long; SELL only reduces longs; SHORT grows shorts or flips longs to short; COVER only reduces shorts; EXIT forces position_size=0. All derivative orders are forced to `NRML` in payload regardless of UI selection.
  - **Options:** BUY CE/PE, REDUCE CE/PE, CLOSE ALL CE/PE, EXIT ALL; Buyer/Writer toggle changes semantics; strike selection per policy; expiry dropdown populated from cached expiries.
- Logs to console the outgoing payload *and* the backend-resolved symbol when responses return to aid debugging.
- Uses shared quote cache for option previews; falls back to live fetch if stale.

### 3.5 Positions, Orders, Trades Views
- **Positions:** Grouped by Live vs Analyzer instances; collapsed by default; shows summary (open count, P&L) and per-symbol rows with Close and Close All. Uses cached positions from feed; manual refresh triggers invalidation.
- **Orders:** Grouped similarly; shows symbol, exchange, side, product, quantity, status, timestamp; cancel buttons hit `/orders/cancel/{id}`.
- **Trades:** Collapsed by instance; auto-refresh every 5s applies diffs without closing expansions; summary cards (total trades, buy/sell split, notional) in one row.

### 3.6 Instances & Settings UI
- Instance modal: host URL, API key, broker, analyzer/live toggle, market-data-enabled checkbox, session targets/max loss (if enabled), health tests; save allowed even if instance is currently down.
- Settings: categories/tabs for server, polling, rate limits, market data feed TTLs, trading sessions (4 configurable windows), options defaults, etc. Only active/used settings are shown (obsolete keys pruned by migration 024). Helper text sits under each group.

### 3.7 UX Safeguards
- Global pause halts all polling.
- Toasts for success/failure; inline badges for health/rate-limit warnings.
- Highlight animations on LTP updates; stale indicators when cache age > TTL.

---

## 4. Backend Components

### 4.1 Server & Middleware
- `server.js` boots Express, JSON parsing, compression/helmet, session, static assets, then mounts `/api/v1`.
- Respects `START_PAUSED` to start market-data feed in paused mode.
- Graceful error handler returns JSON with `message` and `details`.
- Telegram routes currently disabled to avoid missing-token errors.

### 4.2 Core Routes (all under `/api/v1`)
- **instances**: list/create/update/delete, test connection, set analyzer/live, set market_data_enabled, health/ping, session targets/max loss.
- **watchlists**: CRUD watchlists and symbols, assign instances, toggle tradable flags, set per-symbol targets/SL/TSL and trailing activation, qty policies, lot sizes.
- **symbols**: search (FTS on instruments), validate, quotes (batch, cached), expiry (cached), option-chain (cache-first), resolve option symbol preview.
- **option-chain**: richer chain navigation and row output.
- **quickorders**: place SmartOrder across selected/all instances with resolved symbols and product enforcement; responds per instance with backend_resolved_symbol and any skips.
- **positions**: per-instance and aggregated; close position, close all, summaries (live/analyzer).
- **orders**: list, cancel, summaries.
- **trades**: list (tradebook), summaries; grouped by instance, lazy load by expansion.
- **settings**: get/update settings by category; reset; list categories.
- **polling/health**: status of feed loops; start/stop (pause); app-level health.

### 4.3 Services (key responsibilities)
- **market-data-feed.service**: Central polling loop. Intervals: quotes (~2s configurable), positions (~10s), funds (~15s), orders/trades (with TTL). Uses market data pool to fetch quotes; caches snapshots with timestamps; exposes getters + invalidation. Honors global pause.
- **market-data-instance.service**: Manages the pool of `market_data_enabled` instances; round-robin dispatch; tracks backoff/skip flags for throttled or failing instances; per-instance rate limits (RPS/RPM/orders/sec/concurrency); can bypass limits for critical paths (positionbook for order sizing).
- **watchlist.service**: CRUD watchlists/symbols/assignments; returns tracked symbols for feed inventory.
- **quick-order.service**: Validates actions, fetches live positions (no cache for sizing), resolves symbols (equity/futures/options), applies NRML for derivatives, computes final position_size for BUY/SELL/SHORT/COVER/EXIT, fans out to instances, collects per-instance results, and invalidates caches (positions/funds/orders/trades).
- **order-payload.factory**: Builds OpenAlgo placeSmartOrder payloads with required fields (position_size mandatory) and product logic.
- **options-resolution.service**: Builds/uses option chains; finds ATM/ITM/OTM based on LTP; supports FLOAT_OFS/ANCHOR_OFS; caches chain rows; skips DB writes when option_type is missing.
- **expiry-management.service**: Maintains expiry calendar (weekly/monthly/quarterly) and nearest-expiry lookup per exchange/underlying; refreshable from OpenAlgo when missing.
- **instruments.service**: Imports broker instruments into SQLite, powers FTS search, resolves canonical symbols, and builds option-chain caches.
- **tradebook.service/routes**: Calls OpenAlgo tradebook, caches with TTL, supports analyze/live modes, provides summaries (buy/sell counts, notional).
- **orders.service**: Syncs orderbook, normalizes statuses, provides cancel endpoints.
- **positions.service/pnl.service**: Normalizes lots vs quantity, aggregates P&L per instance and overall; exposes open/closed counts; used by positions view and dashboard cards.
- **instance.service**: CRUD, health checks (ping), session target/max-loss enforcement (when enabled), auto-switch to analyzer after hitting thresholds (future), tracks live/analyzer P&L.
- **settings.service**: DB-backed settings with type parsing, masking for sensitive, batch updates, defaults; obsolete keys pruned by migration 024.
- **polling.service**: Legacy interval manager (health/funds/positions); mainly superseded by market-data-feed but retained for backward compatibility.
- **auto-exit.service**: Monitors targets/SL/TSL per watchlist symbol using cached quotes; tags exits with TARGET_MET/STOPLOSS_HIT/TSL_HIT strategy; respects trailing activation thresholds.

### 4.4 Integration Layer
- **openalgo/client.js**: Central HTTP client with:
  - Per-instance rate-limit counters (RPS, RPM, orders/sec, concurrency).
  - Retry/backoff for critical vs non-critical endpoints.
  - Optional `skipRateLimit` flag (used for quotes when UX-critical).
  - Error normalization with endpoint/status/context logging.
  - Proxy configuration optional.

### 4.5 Persistence (SQLite)
- Tables (not exhaustive):
  - `instances` (broker metadata, analyzer/live, market_data_enabled, session limits)
  - `watchlists`, `watchlist_symbols`, `watchlist_instances`
  - `instruments` (FTS searchable), `options_cache`, `expiry_calendar`
  - `market_data` (snapshots), `quick_orders`, `order_monitor`
  - `application_settings` (pruned to allowed keys by migration 024)
  - `positions_cache`, `funds_cache`, `orders_cache`, `trades_cache` (where applicable)
- Migrations live in `backend/migrations`, run via `npm run migrate`.

---

## 5. Key Workflows (Data Flows)

### 5.1 Global Pause
1) User hits pause (or backend starts with `START_PAUSED=true`).
2) Frontend stops all scheduled fetches; backend feed remains idle.
3) UI shows last-known data from cache/DB; resume re-enables polling.

### 5.2 Quote Refresh (Watchlists & Quick-Order)
1) Watchlist polling asks `/symbols/quotes` with symbol list.
2) Backend checks 2s quote cache; misses are batched (3–5 symbols) and round-robin across `market_data_enabled` instances; throttled instances are skipped.
3) Responses update cache and are fanned back to caller; UI renders LTP/change and highlights deltas.

### 5.3 Expiry & Option Chain
1) UI calls `/symbols/expiry` (cache-first from `expiry_calendar`; fallback to OpenAlgo refresh if missing).
2) Option chain: `/symbols/option-chain` uses DB `options_cache`; if option_type missing, skips DB write; resolves strikes for ITM/ATM/OTM.

### 5.4 Trading (BUY/SELL/SHORT/COVER/EXIT)
1) User action -> `quick-order.js` builds payload (symbolId, tradeMode, action, quantity, expiry, operating mode).
2) Backend `quick-order.service` fetches **live** positions per instance (no cache) to compute final position_size:
   - BUY: if net short, flips to long target; if long, increases.
   - SELL: only reduces longs; no new shorts.
   - SHORT: if net long, flips to short target; if short, increases magnitude.
   - COVER: only reduces shorts; no new longs.
   - EXIT: set net to 0 always.
3) Derivative product forced to `NRML`. Equity retains user-selected product (CNC/MIS).
4) placeSmartOrder dispatched to selected/all instances; responses include backend_resolved_symbol and any “no open positions” skips.
5) Positions/funds/orders/trades caches invalidated for those instances to refresh immediately.

### 5.5 Close All / Close Position
1) Positions view calls `/positions/:instanceId/close` (all) or `/positions/:instanceId/close/position` (symbol).
2) Backend resolves symbol (including futures expiry) and sends placeSmartOrder with position_size=0 (or adjusted).

### 5.6 Orders & Trades
1) Orders: `/orders` pulls orderbook with TTL; cancel hits `/orders/cancel/{id}`.
2) Trades: `/trades` pulls tradebook with TTL; UI diffs rows to avoid flicker; collapsed by default.

### 5.7 Auto-Exit (Target/SL/TSL)
1) Auto-exit service runs on interval; uses freshest quote (prefers cache; can force refresh).
2) Compares against target/stoploss/trailing config per watchlist symbol; trailing activation points gate TSL start.
3) Executes exit via quick-order service; tags strategy as TARGET_MET/STOPLOSS_HIT/TSL_HIT for transparency.

### 5.8 Market-Data Pool & Batching
1) Instances flagged `market_data_enabled` form the pool.
2) Requests >5 symbols/sec are split into batches of 3–5; dispatched round-robin.
3) If an instance exceeds RPS/RPM/concurrency, it is temporarily skipped with backoff; others take the load.

### 5.9 Session Targets/Max Loss (roadmap/partial)
1) Instances can store session target profit and max loss per user-configurable session slots (4 per day via Settings).
2) When enabled, crossing thresholds should cancel open orders, close positions, then flip to analyzer mode (future enforcement hook in instance service).
3) Once flipped to analyzer by threshold, it stays there until user explicitly switches back.

---

## 6. Rate Limits, Backoff, and Efficiency
- Per-instance limits: RPS=5, RPM=300, orders/sec=10, concurrency=5–10. Quotes can set `skipRateLimit` when UX-critical.
- Global RPM cap removed; batching + pooling handles distribution.
- Quote cache TTL 2s; positions/funds caches with longer TTLs; forced invalidation after trades.
- Option expiries cached aggressively (rarely change intra-day).
- DB-first: instruments/expiry/option-chain/quotes use local caches before hitting OpenAlgo.
- Paused mode prevents any network calls on startup to avoid tripping security thresholds.

---

## 7. Error Handling & Observability
- Logging via `src/core/logger.js` (Winston) with context: endpoint, instance, underlying, expiry, retry attempt, rate-limit decisions.
- UI: toasts for errors; badges for stale/paused; console logs include payloads and backend-resolved symbols.
- Resize-safe diff rendering on Trades to avoid DOM thrash; expansions persist across refresh.
- Telegram routes disabled (return 503) until credentials are provided to avoid startup crashes.

---

## 8. Data Model (Essentials)
- `instances`: id, name, host_url, api_key, broker, analyzer/live, market_data_enabled, health, session targets/max loss (optional), last_health_check.
- `watchlists`: id, name, is_active; `watchlist_symbols`: exchange, symbol, token, lot_size, qty rules, product/order types, tradable flags per asset class, targets/SL/TSL/trailing activation, underlying_symbol.
- `watchlist_instances`: mapping of instances to watchlists.
- `instruments`: canonical symbols with exchange, token, lot_size, tick_size, expiry, strike, option_type, brsymbol/brexchange (source), name.
- `options_cache`, `expiry_calendar`: cached chains/expiries.
- `application_settings`: only allowed keys (migration 024 prunes others) including polling, rate limits, feed TTLs, trading_sessions, logging, oauth, cors, session, etc.
- `quick_orders`, `order_monitor`, `positions_cache`, `funds_cache`, `orders_cache`, `trades_cache`: runtime/state caches.

---

## 9. Configuration & Settings
- Stored in DB; defaults in `settings.service` and migrations. Editable via Settings UI.
- Key groups:
  - **Server**: port, env, CORS, session.
  - **Polling/Feed**: instance interval, market data interval, quote/position/fund TTLs.
  - **Rate limits**: rps_per_instance, rpm_per_instance, orders_per_second, max_concurrent_tasks.
  - **Trading sessions**: 4 user-configurable windows for auto cutoffs (future enforcement).
  - **Options defaults**: operating mode, strike policy, step lots.
  - **Logging/test mode**: levels, test user.
- Obsolete keys removed by migration 024 to keep UI clean.

---

## 10. Deployment & Ops
- Run migrations: `npm run migrate`.
- Dev server: `npm run dev` (node --watch); prod: `npm start` (ensure CSS built via `npm run build:css`).
- DB: `backend/database/simplifyed.db`. Backup before major imports.
- Environment overrides: `.env` and `START_PAUSED` to prevent startup traffic.

---

## 11. Troubleshooting Cheat Sheet
- **Paused but no data**: Resume polling; cached data still renders.
- **Quotes stale**: Check market_data_enabled pool; verify backoff logs; ensure symbols present in watchlists; force refresh via UI.
- **Wrong product on derivatives**: quick-order enforces NRML; if MIS seen, verify instance/broker accepts NRML and inspect order-payload.factory overrides.
- **No open positions to close**: Confirm symbol resolution (futures require correct expiry); positions fetched live per instance before sizing—check backend_resolved_symbol in console logs.
- **Option chain 404/HTML in response**: OpenAlgo returned non-JSON; chain fetch skips cache write when option_type missing; retry with valid underlying/expiry.
- **Rate-limit warnings**: Pool will skip throttled instances; reduce manual refresh spam or increase pool size.
- **Trades view flicker**: By design only diffs render; if flicker occurs, ensure expansions remain open and DOM diffing is intact.

---

## 12. Future Hooks / Known Gaps
- Enforce session target/max-loss auto-cutoff end-to-end (cancel orders, close positions, flip to analyzer).
- WebSocket market data (deferred); current design keeps HTTP + batching.
- Richer audit for symbol resolution (UI badge for resolved symbol already logged to console; UI surface planned).

---

**Last reviewed:** 2025-11-20

---

## 13. Service Algorithms & Code Snippets (for debugging)

> These snippets are representative, not verbatim. They outline the real logic paths to help spot bugs quickly.

### 13.1 Quick Order (Position Sizing & Product Enforcement)
```js
// quick-order.service.js (core flow)
async placeAcrossInstances(payload) {
  const { action, tradeMode, symbolId, quantity, expiry } = payload;
  const insts = await this._getTargetInstances(payload.instances);
  const symbol = await this.symbols.getById(symbolId); // has lot_size, exchange, type
  const resolved = await this.resolveSymbol({ symbol, tradeMode, expiry }); // futures/options -> concrete tsymbol

  // Fetch LIVE positions per instance (no cache) to size orders correctly
  const positions = await this.positionsClient.fetchLive(insts, resolved);

  return Promise.all(insts.map(async inst => {
    const pos = positions[inst.id] || { net_qty: 0 };
    const lotSize = symbol.lot_size || 1;
    const delta = quantity * lotSize;
    const target = computeFinalPosition(action, pos.net_qty, delta); // BUY/SELL/SHORT/COVER/EXIT rules
    if (target === pos.net_qty && action !== 'EXIT') {
      return skip('no-op');
    }
    const product = isDerivative(symbol) ? 'NRML' : payload.product || 'CNC';
    const orderPayload = buildSmartOrder({ ...payload, action: 'EXIT', position_size: target, product, tsymbol: resolved.tsymbol });
    return this.openalgo.placeSmartOrder(inst, orderPayload)
      .then(r => ({ ...r, backend_resolved_symbol: resolved.tsymbol, final_position: target }))
      .catch(e => ({ success:false, error:e.message }));
  }));
}
```
`computeFinalPosition` rules:
- BUY: `target = net + delta` (if net<0, flips toward long).
- SELL: only reduces longs: `target = Math.max(0, net - delta)`; no new shorts.
- SHORT: `target = net - delta` (if net>0, flips toward short).
- COVER: only reduces shorts: `target = Math.min(0, net + delta)`; no new longs.
- EXIT: `target = 0`.

### 13.2 Symbol Resolution (Futures/Options)
```js
// options-resolution.service.js (simplified)
resolve({ underlying, exchange, expiry, leg, strikePolicy, ofs }) {
  const chain = cache.get(underlying, expiry) || buildChainFromDB(underlying, expiry);
  const atm = findATM(chain); // uses LTP
  const strike = pickStrike(atm, leg, strikePolicy, ofs); // ITM/OTM ladder or anchored
  return { tsymbol: `${underlying}${expiryCode}${strike}${legSuffix}` };
}

// futures resolution
resolveFut({ underlying, expiry }) => `${underlying}${expiryCode}FUT`;
```

### 13.3 Market-Data Pooling & Batching
```js
// market-data-instance.service.js
getBatchPlan(symbols) {
  const batches = chunk(symbols, 3); // 3–5 configurable
  const pool = instances.filter(i => i.market_data_enabled && !i.backingOff);
  return batches.map((batch, idx) => ({ inst: pool[idx % pool.length], symbols: batch }));
}
```
```js
// market-data-feed.service.js (quotes refresh)
async refreshQuotes({ symbols }) {
  const { hits, misses } = cache.hitMiss(symbols, ttl=2000);
  const plan = pooling.getBatchPlan(misses);
  const results = await Promise.all(plan.map(p => client.getQuotes(p.inst, p.symbols, { skipRateLimit:true })));
  cache.upsert(flatten(results));
  return cache.read(symbols); // merged hits+new
}
```

### 13.4 Rate Limits & Backoff (OpenAlgo Client)
```js
// openalgo/client.js
function guard(inst, endpoint, opts) {
  if (!opts.skipRateLimit) {
    if (rps(inst) > limit || rpm(inst) > limit || concurrent(inst) > limit) throw new RateLimitSkip();
  }
  return fetchWithRetry(endpoint, opts);
}
```

### 13.5 Auto-Exit (Target/SL/TSL)
```js
// auto-exit.service.js
tick() {
  const symbols = watchlists.getWithTargets();
  const quotes = feed.getQuotes(symbols); // cache; force refresh if stale
  symbols.forEach(sym => {
    const cfg = sym.tsl || sym.target || sym.sl;
    const ltp = quotes[sym.key]?.ltp;
    if (!ltp) return;
    const hit = evaluate(cfg, ltp);
    if (hit) quickOrder.exit(sym, hit.reasonTag); // sets strategy TARGET_MET/STOPLOSS_HIT/TSL_HIT
  });
}
```
Trailing activation: TSL only starts after `activation_points` reached; then trails peak with `trail_points`.

### 13.6 Positions Fetch (Live, No Cache)
```js
// positions.service.js
async fetchLive(instances, tsymbol) {
  return map(instances, async inst => {
    const pb = await client.getPositionBook(inst, { skipRateLimit:false });
    const row = pb.find(p => p.symbol === tsymbol);
    return { net_qty: normalize(row?.net_qty || 0, row?.lot_size) };
  });
}
```

### 13.7 Trades View Diff Rendering
```js
// dashboard.js (trades)
function renderTrades(instanceId, list) {
  const prev = tradesStore.get(instanceId) || [];
  const { added, removed, same } = diff(prev, list, k='orderid');
  applyDomChanges(instanceId, { added, removed, same }); // expansions stay open
  tradesStore.set(instanceId, list);
}
```

### 13.8 Settings Pruning (Migration 024)
```js
// migration 024
DELETE FROM application_settings WHERE key NOT IN (ALLOWED_KEYS...);
```

### 13.9 Exit / Close-All
```js
// positions.service close all
async closeAll(inst, symbols) {
  const pb = await fetchLive([inst], null); // all positions
  return Promise.all(pb.map(p => {
    const payload = { action:'EXIT', position_size:0, tsymbol:p.symbol, product:isDerivative(p)?'NRML':p.product };
    return client.placeSmartOrder(inst, payload);
  }));
}
```

---

## 14. Minor Modules & Utilities (brief)
- `utils.js` (frontend): debounce, throttle, formatting (currency, percent), DOM helpers, toast wrapper.
- `api-client.js`: centralized error normalization; adds `X-Requested-With`; handles 422/500 with message propagation.
- `dashboard.js` helpers: `renderWatchlistHeaderMeta`, `attachQuickOrderHandlers`, `renderPositionsAccordion`, `renderOrdersAccordion`, polling start/stop respecting pause.
- `settings.js`: tab rendering, type-aware inputs (boolean/number/json), trading session editor, batch save with disabled state while saving.
- `polling.service.js` (legacy): health/funds/positions intervals; superseded by market-data-feed but still callable.
- `order-payload.factory.js`: ensures `position_size` is always set; maps action to broker verb; injects product NRML for derivatives.
- `options-resolution.service.js`: skip options_cache writes if `option_type` null to avoid DB constraints.

### 14.1 Detailed module references
- `backend/src/services/quick-order.service.js`: Orchestrates position sizing and order fan-out. Resolves concrete symbols (futures expiry, options strike/leg), fetches live positionbook per instance (no cache), computes final position_size for BUY/SELL/SHORT/COVER/EXIT, enforces NRML for derivatives, builds SmartOrder payloads, and invalidates positions/funds/orders/trades caches. Returns per-instance results with `backend_resolved_symbol` and `final_position`.
- `backend/src/services/options-resolution.service.js`: Builds option symbols from underlying/expiry/leg/strike policy. Finds ATM via quotes or mid, applies FLOAT_OFS/ANCHOR_OFS offsets to pick strike, composes CE/PE trading symbol, and skips writing to options_cache when `option_type` is null to avoid DB constraint failures.
- `backend/src/services/market-data-feed.service.js`: Central polling/cache for quotes (2s TTL), positions (~10s), funds (~15s), orders/trades. Uses market-data-instance pool for batched quotes, respects global pause, exposes getters/invalidation hooks, and seeds UI/API responses.
- `backend/src/services/market-data-instance.service.js`: Manages the pool of `market_data_enabled` instances, plans quote batches (3–5 symbols) round-robin, tracks backoff when rate limits/concurrency are exceeded, and skips stalled instances until backoff clears.
- `backend/src/integrations/openalgo/client.js`: HTTP client wrapper with per-instance RPS/RPM/orders/sec/concurrency guards, critical/non-critical retry logic, optional `skipRateLimit`, proxy support, and structured error logging.
- `backend/src/services/auto-exit.service.js`: Periodic monitor for target/stoploss/trailing rules. Pulls quotes (prefers cache), applies activation/trailing logic, triggers EXIT via quick-order with strategy tags (TARGET_MET/STOPLOSS_HIT/TSL_HIT), and invalidates caches on action.
- `backend/public/js/dashboard.js`: View orchestrator. Switches views, renders watchlists/positions/orders/trades/instances/settings, manages polling respecting pause, preserves collapses, and wires quick-order handlers.
- `backend/public/js/quick-order.js`: UI state holder for trade mode, expiry, leg, operating mode, strike policy, product, qty. Builds payloads, logs outgoing and resolved symbols, enforces 5-button futures/direct semantics and options Buyer/Writer toggles with strike ladders.
- `backend/public/js/api-client.js`: Fetch wrapper adding `X-Requested-With`, normalizing JSON errors, surfacing 4xx/5xx messages, used by all frontend modules.
- `backend/public/js/settings.js`: Renders settings tabs and fields (boolean/number/json), trading session editor (4 slots), batch save with disabled state, reset to defaults.

---

If you need deeper line-level references, open the noted files:
- `backend/src/services/quick-order.service.js` (position sizing, symbol resolution, fan-out)
- `backend/src/services/options-resolution.service.js`
- `backend/src/services/market-data-feed.service.js`
- `backend/src/services/market-data-instance.service.js`
- `backend/src/integrations/openalgo/client.js`
- `backend/src/services/auto-exit.service.js`
- `backend/public/js/dashboard.js`, `quick-order.js`, `api-client.js`, `settings.js`

---

## 15. Database Architecture (SQLite)
> All tables managed by migrations in `backend/migrations`. Key columns only; see schema for full details.

- **instances**: `id`, `name`, `host_url`, `api_key`, `broker`, `market_data_enabled`, `analyzer` (bool), `health_status`, `last_health_check`, `session_target_profit`, `session_max_loss`, `created_at`, `updated_at`.
- **watchlists**: `id`, `name`, `is_active`, `created_at`, `updated_at`.
- **watchlist_symbols**: `id`, `watchlist_id`, `exchange`, `symbol`, `token`, `lot_size`, `qty_type/qty_value`, `product_type`, `order_type`, `max_position_size`, tradable flags (`tradable_equity/futures/options`), `underlying_symbol`, targets/stoploss/trailing (`target_points_*`, `stoploss_points_*`, `trailing_stoploss_points_*`, `trailing_activation_points_*`) per asset class, `symbol_type`, `expiry`, `strike`, `option_type`, `instrumenttype`, `name`, `tick_size`, `brsymbol`, `brexchange`, `is_enabled`.
- **watchlist_instances**: `watchlist_id`, `instance_id` (mapping).
- **instruments**: canonical symbols imported from broker: `symbol`, `exchange`, `token`, `lot_size`, `tick_size`, `expiry`, `strike`, `option_type`, `instrumenttype`, `name`, `brsymbol`, `brexchange`.
- **options_cache**: `underlying`, `expiry`, `strike`, `option_type`, `exchange`, `symbol`, `trading_symbol`, `lot_size`, `tick_size`, `instrument_type`, `token`, `updated_at`.
- **expiry_calendar**: `underlying`, `exchange`, `expiry`, `kind` (weekly/monthly/quarterly), `is_current`, `updated_at`.
- **market_data (snapshots/caches)**: impl-specific tables for quotes/positions/funds/orders/trades caches with `instance_id`, `payload`, `fetched_at`.
- **quick_orders**: audit of placed quick orders with payload/result.
- **order_monitor**: tracking of outstanding orders for auto-exit/monitor loops.
- **application_settings**: `key`, `value`, `description`, `category`, `data_type`, `is_sensitive`, `created_at`, `updated_at` (pruned by migration 024 to allowed keys only).
- **telegram_subscriptions** (disabled currently): chat/user mapping.

---

## 16. Data Flow Diagrams (Text)

### 16.1 Quotes (watchlist/preview)
```
UI (dashboard.js/watchlist polling)
   -> GET /api/v1/symbols/quotes?symbols=...
       -> market-data-feed.service
           -> cache hit? serve
           -> cache miss -> batch plan (3–5 symbols) via market-data-instance.service
               -> openalgo client getQuotes (pool, skipRateLimit)
           -> update quote cache
       <- merged quotes (source, fetchedAt)
<- render rows, highlight deltas
```

### 16.2 Futures/Direct Order (BUY/SELL/SHORT/COVER/EXIT)
```
UI (quick-order.js)
   -> payload with action, symbolId, qty, tradeMode, expiry
   -> POST /api/v1/quickorders
       -> quick-order.service
           -> resolve symbol (futures expiry) or options chain
           -> fetchLive positions per instance (positionbook; no cache)
           -> compute final position_size (see §13.1)
           -> product = NRML for derivatives, else UI choice
           -> placeSmartOrder per instance (openalgo client)
           -> invalidate positions/funds/orders/trades caches
       <- per-instance results (backend_resolved_symbol, final_position)
<- toast + console logs
```

### 16.3 Options Order (Buyer/Writer)
```
UI selects leg/expiry/operatingMode/strikePolicy
   -> POST quickorders (action BUY_CE/REDUCE_CE/etc.)
       -> options-resolution.service (ATM/ITM/OTM strike pick)
       -> same position sizing rules (derivatives => NRML)
       -> placeSmartOrder fan-out
```

### 16.4 Positions / Close All
```
UI (positions view)
   -> GET /api/v1/positions/all (cache from feed; aggregates)
   -> Close All button:
       -> POST /api/v1/positions/:instanceId/close
           -> fetchLive positionbook
           -> for each symbol -> placeSmartOrder EXIT position_size=0 (NRML if derivative)
           -> invalidate caches
```

### 16.5 Trades View
```
UI loads trades collapsed
   -> GET /api/v1/trades (per instance, cached with TTL)
       -> tradebook.service (OpenAlgo tradebook)
   -> UI stores prev list per instance; diffs on 5s refresh; keeps expansions open
```

### 16.6 Auto-Exit (Target/SL/TSL)
```
timer (5s)
   -> load configured targets/SL/TSL from watchlist_symbols
   -> get quotes (cache, force refresh if stale)
   -> evaluate thresholds; trailing requires activation_points hit
   -> quickOrder EXIT with strategy tag
   -> invalidate caches
```

### 16.7 Market-Data Pool & Backoff
```
symbols requested -> chunk(3–5) -> assign round-robin to enabled instances
   -> if instance over RPS/RPM/concurrency => mark backingOff, skip
   -> others take more load; retry after backoff
```
