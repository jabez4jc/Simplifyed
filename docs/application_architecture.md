# Simplifyed Admin – Comprehensive Application Guide

This document is the canonical reference for the Simplifyed Admin application. It explains what the product does, how it is built, every major workflow, and the constraints you must keep in mind when enhancing or operating the platform. Update this file whenever a feature changes so it remains the single source of truth.

---

## 1. Product Overview

**Goal:** Provide professional traders with a unified control panel for managing OpenAlgo instances (brokers), maintaining multiple watchlists, and placing equity, futures, and options trades—including sophisticated FLOAT_OFS and Buyer/Writer strategies—without breaching OpenAlgo rate limits.

**Key capabilities**

- Instance inventory and health monitoring (API keys, analyzer/live modes, broker-specific configuration).
- Watchlist management with per-symbol trade settings (tradable flags, lot sizing, quantity policies, underlying references).
- Collapsible left navigation and responsive dashboard with cards, watchlists, and position/order tabs.
- Quick-order trading controls for equity, futures, and options modes with Buyer/Writer toggles, strike policies, float offsets, and automatic reconciliation.
- Cached market data feed (quotes, positions, funds) shared across all admins to minimize OpenAlgo traffic.
- Options chain resolution, expiry management, and instrument cache selection driven by an internal SQLite DB.
- Integrated help affordances (info buttons, tooltips) to educate users inline.

---

## 2. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                            Frontend                            │
│  • dashboard.html + Tailwind/Daisy UI layout                    │
│  • dashboard.js orchestrates views (watchlists, positions, …)  │
│  • quick-order.js renders trading controls + BUYER/WRITER UI   │
│  • api-client.js talks to /api/v1 endpoints                    │
│                                                                │
│  ↕ fetches JSON                                            Web │
└────────────────────────────────────────────────────────────────┘
               │                                ▲
               ▼  REST/Socket (future)          │
┌────────────────────────────────────────────────────────────────┐
│                             Backend                             │
│  Express server (server.js) + routes/v1/*                       │
│    • Authentication/session middleware                          │
│    • REST endpoints for instances, watchlists, orders,         │
│      symbols, option chain, quick orders, positions, settings  │
│                                                                │
│  Services layer (src/services/*)                               │
│    • market-data-feed.service polls OpenAlgo once and caches   │
│      quotes/positions/funds                                    │
│    • watchlist.service, quick-order.service, options-resolution│
│      .service, expiry-management.service, instruments.service  │
│    • order/pnl/dashboard/polling utilities                     │
│                                                                │
│  Integrations (src/integrations/openalgo/client.js)            │
│    • Single OpenAlgo client with rate-limit awareness          │
│                                                                │
│  Persistence: SQLite (src/core/database.js)                    │
│    • Tables: instances, watchlists, watchlist_symbols,         │
│      options_cache, expiry_calendar, instruments,              │
│      quick_orders, market_data, …                              │
└────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────────────┐
│                          OpenAlgo APIs                          │
│  Quote, position, funds, order, instrument, option-chain,       │
│  expiry endpoints for broker-specific instances.                │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Frontend Design

### 3.1 Layout & Navigation

- `dashboard.html` hosts a Tailwind/DaisyUI-based shell with a collapsible sidebar. The collapse toggle sits on the left of the header; profile/logout controls live at the bottom.
- Views (`dashboard`, `watchlists`, `instances`, `settings`, etc.) are driven by `dashboard.js`. Each nav item sets `data-view` and triggers `switchView`.
- The watchlists page displays cards stacked vertically (one watchlist at a time) and includes tabs for aggregated positions and orders.

### 3.2 API Client (`backend/public/js/api-client.js`)

- Thin wrapper over `fetch` with JSON handling and error normalization.
- Provides modules for instances, watchlists, orders, positions, symbols (search/expiry/option-chain), quick orders, and polling.
- Symbol expiry/option-chain endpoints now accept optional `instanceId` but default to using the instruments DB caches.

### 3.3 Watchlists & Quotes (`dashboard.js`)

- Watchlist cards render via `renderWatchlistsAccordion`. Expansions call `renderWatchlistSymbols` and attach row toggle listeners.
- `startWatchlistPolling` schedules quote refreshes every 10 s. `updateWatchlistQuotes` requests quotes once from the selected market-data instance; metadata (“Last update”, “Source”, “Symbols updated”) is shown above each table to indicate feed status.
- Rows display symbol info, LTP, % change, volume, assigned instances, and a chevron that triggers quick-order expansion.
- Quote caching logic prevents unnecessary DOM updates and adds highlight animations for changing values.

### 3.4 Quick Order UI (`quick-order.js`)

- Maintains per-symbol maps for selected trade mode, options leg, expiry, operating mode (Buyer/Writer), strike policy, and step lots.
- Renders three trade modes:
  - **Equity:** BUY/SELL/EXIT buttons with quantity and product selectors.
  - **Futures/Direct:** Buttons behave as “BUY increases longs / SELL increases shorts / EXIT closes all”.
  - **Options:** Buttons include BUY/SELL CE/PE, INCREASE/REDUCE, CLOSE ALL, and EXIT ALL with Buyer/Writer toggles. Options leg dropdown supports ITM3–OTM3.
- Expiry dropdown uses `fetchAvailableExpiries`, which now hits the instruments cache first and only contacts a broker instance when needed.
- Option previews show the CE/PE symbol, strike, LTP, and change percent for the selected leg/expiry. Quotes are pulled from the shared feed when possible.

### 3.5 Help & Tooling

- Inline info buttons (class `field-help`) provide tooltips for complex controls.
- Toast notifications (`Utils.showToast`) surface success/error states.

---

## 4. Backend Components

### 4.1 Server & Middleware

- `backend/server.js` boots Express, attaches middleware (helmet, compression, session), mounts `routes/v1/index.js`, and starts the market data feed service.
- Authentication is managed via session middleware (details omitted here but enforced before sensitive routes).

### 4.2 Routes

- **Instances (`routes/v1/instances.js`)**: CRUD, analyzer toggles, API key tests, ping, etc.
- **Watchlists (`routes/v1/watchlists.js`)**: Manage watchlists, symbols, and instance assignments.
- **Quick Orders (`routes/v1/quickorders.js`)**: Accepts watchlist symbol actions; ensures Buyer/Writer semantics.
- **Symbols (`routes/v1/symbols.js`)**:
  - `/search`: Uses instruments FTS cache; falls back to OpenAlgo search.
  - `/validate`: Instruments cache → symbol cache → OpenAlgo /symbol.
  - `/quotes`: Served from market-data feed cache (fallback to live call).
  - `/expiry`: Served from instruments cache (fallback to OpenAlgo on demand).
  - `/option-chain`: Fully powered by `option-chain.service` built on DB instruments; no broker calls.
- **Option Chain (`routes/v1/option-chain.js`)**: Higher-level endpoints for UI exploration (underlyings, expiries, rows).
- **Positions (`routes/v1/positions.js`)**: Aggregated positions and per-instance PnL, backed by feed cache.
- **Orders, dashboard, settings, polling**: Additional endpoints for UI configuration and automation hooks.

### 4.3 Services

- **Market Data Feed (`market-data-feed.service.js`)**
  - Polls market-data instances (quotes) and all active instances (positions, funds) on configurable intervals.
  - Builds the global symbol list from active watchlists and assigned instances.
  - Exposes snapshot getters/invalidation hooks and emits events for future WebSocket integration.

- **Watchlist Service (`watchlist.service.js`)**
  - CRUD for watchlists, symbols, assignments.
  - Provides `getTrackedSymbols()` so the feed knows which symbols to poll.

- **Quick Order Service (`quick-order.service.js`)**
  - Validates actions, determines strategies, fetches/caches positions and quotes, resolves options strikes, runs Buyer/Writer calculus, updates caches after trades, and records quick order history.
  - Uses market data feed snapshots whenever possible to avoid duplicate OpenAlgo calls.

- **Options Resolution Service (`options-resolution.service.js`)**
  - Builds option chains from instruments cache; falls back to OpenAlgo or search if necessary.
  - Calculates strike steps, finds ATM/ITM/OTM strikes, caches chain data.

- **Expiry Management Service (`expiry-management.service.js`)**
  - Maintains `expiry_calendar`, auto-refresh schedules (Wednesday/Friday 8 AM IST), classification (weekly/monthly/quarterly), and nearest-expiry lookup.

- **Instruments Service (`instruments.service.js`)**
  - Handles bulk import from OpenAlgo, FTS search, option chain construction, and normalized expiry sorting.

- **Dashboard/Positions/PnL services**
  - Use feed snapshots for funds/positions and compute aggregated metrics for UI cards.

- **Polling Service (`polling.service.js`)**
  - Legacy client-specific polling logic; largely superseded by the centralized feed but retained for backward compatibility.

### 4.4 Integration Layer

- `src/integrations/openalgo/client.js` encapsulates HTTP calls, handles JSON parsing quirks, logs errors, and ensures rate-limited fetches.
- Proxy configuration optional (see config).

### 4.5 Database Schema (SQLite)

Key tables:

- `instances`: Broker endpoints, health status, analyzer flags, API keys.
- `watchlists`, `watchlist_symbols`, `watchlist_instances`: User-defined symbol collections and their settings.
- `instruments`: Imported master list of symbols (supports FTS search).
- `options_cache`, `expiry_calendar`: Cache derived from instruments/OpenAlgo.
- `market_data`: Optional persisted quotes for reference.
- `quick_orders`, `order_monitor`, `telegram_subscriptions`, etc., for audit and automation.

Migrations live in `backend/migrations`.

---

## 5. Core Workflows

### 5.1 Instance Lifecycle

1. **Add instance** (modal in UI → `/instances` POST). Store name, host URL, API key, broker, analyzer role, market-data role.
2. **Test connection** triggers `/instances/test/connection` to auto-detect broker and health.
3. **Assign to watchlists** via watchlist modal. Only active instances participate in quick orders and market-data feed.
4. **Monitor**: Dashboard cards show available funds, realized/unrealized PnL, analyzer/live grouping.

### 5.2 Watchlist + Quote Refresh

1. Watchlists are stacked vertically. Expanding a card renders symbol rows.
2. For each expanded watchlist, `startWatchlistPolling` requests watchlist symbols, builds a quote payload, and calls `/symbols/quotes`.
3. `/symbols/quotes` returns feed snapshots (source, cachedAt). UI updates display values and meta status.
4. Quick-order chevrons embed trading controls within the table.

### 5.3 Quick Orders

1. User selects a trade mode (Equity/Futures/Options). Trade mode availability is determined by watchlist symbol flags (`tradable_equity`, `tradable_futures`, `tradable_options`).
2. For Futures/Equity, BUY increases longs, SELL increases shorts, EXIT zeroes net position across assigned instances.
3. For Options:
   - Buyer mode: `REDUCE_CE/PE` closes open longs; `INCREASE` adds positions.
   - Writer mode: toggling flips the semantics (cover shorts vs open new shorts).
   - Strike policy (FLOAT_OFS vs ANCHOR_OFS) determines whether strikes float around ATM or stay fixed per user selection.
   - Expiry dropdown uses cache-first lookup; option preview shows CE/PE quotes for the selected leg.
4. Quick-order placement iterates through assigned instances (or ALL), resolves option symbols if needed, places orders via OpenAlgo, and records successes/errors per instance.
5. After placement, caches are invalidated so positions/funds refresh promptly.

### 5.4 Options & Expiry Resolution

- Options Mode Implementation follows `Requirements/Options_Mode_Implementation_Guide_v1.4.md`.
- Instruments DB acts as the canonical source. `option-chain.service` builds rows with CE/PE per strike; `options-resolution.service` narrows to target strikes given LTP.
- Expiry selection uses `expiry-management.service`, which can refresh from OpenAlgo when a symbol lacks cached data.
- WATCHLIST symbols store `underlying_symbol` so options can be mapped correctly even when the watchlist symbol is an index or equity.

### 5.5 Market Data Feed

- On server start, `market-data-feed.service`:
  1. Builds the global symbol list using `watchlistService.getTrackedSymbols()`.
  2. Polls designated market-data instances for quotes (default every 2 s) and caches `instanceId -> { data, fetchedAt }`.
  3. Polls all active instances for positions (10 s) and funds (15 s).
  4. Exposes `getQuoteSnapshot`, `getPositionSnapshot`, `getFundsSnapshot`, and invalidation helpers.
- Frontend consumes feed data indirectly via `/symbols/quotes`, `/positions/:id`, `/dashboard/metrics`, etc.

### 5.6 Positions & Orders

- The Watchlist “Positions” section now polls `/api/v1/positions/all?onlyOpen=true` every 10 s through `app.requestWatchlistRefresh`, but throttles repeated manual refreshes while still relying on the centralized market-data feed cache for accuracy.
- A collapsible per-instance card layout groups live/analyzer exposures and exposes individual “Close” buttons per symbol plus a global “Close All” action; the backend offers `/positions/:instanceId/close/position` for single-symbol closes and `/positions/:instanceId/close` for full-instance exits.
- The Orders tab still pulls from `/orders` (client-side limit) and shares the same cached feeds, with the quick-order service invalidating relevant snapshots after each trade so the UI stays in sync.
- The Orders view now mirrors the positions layout: it groups live/analyzer instances, lists every active order returned by the OpenAlgo `/orders` endpoint (instance name, symbol, side, quantity, product, status, placed at, etc.), surfaces per-row “Cancel” buttons that call `/orders/cancel/{order_id}`, and provides filter controls so you can show only `pending`, `open`, `complete`, `cancelled`, or `rejected` orders for the selected instances.

---

## 6. Rate-Limit & Performance Strategy

- **Single feed**: All admins share one polling loop, so quotes/positions/funds are fetched once per interval regardless of viewers.
- **DB-first lookups**: Symbol search, validation, expiries, and option chains query the instruments cache first, only contacting OpenAlgo when data is missing.
- **Cache invalidation**: Quick order placements trigger `marketDataFeedService.invalidatePositions`/`invalidateFunds` to refresh affected instances immediately.
- **Fallback logic**: If feed snapshots are stale or unavailable, routes fall back to live OpenAlgo calls and seed the cache with the fresh data.

### 6.1 Market Data Feed Settings

- TTLs for quotes, positions, and funds are now configurable via `market_data_feed.quote_ttl_ms`, `.position_ttl_ms`, and `.funds_ttl_ms`, so you can adjust how long cached snapshots stay alive without redeploying.
- The watchlist polling logic respects those TTLs and forces a refresh through `marketDataFeedService.refreshQuotes({ force: true })` when a symbol isn’t yet cached, ensuring watchlists never show stale or missing LTPs.

---

## 7. Error Handling & Observability

- All services log via `src/core/logger.js` (Winston). Errors include context (underlying, expiry, instance).
- Known UI errors show toast notifications. Expansions log to console for debugging (e.g., `[Watchlist] quickOrder handler not ready`).
- Market data feed reports failures but continues polling other instances.

---

## 8. Testing Strategy

- **Unit tests (`npm run test:unit`)** cover services (quick-order, options-resolution, expiry-management, instruments).
- **E2E/Playwright** specs live under `backend/e2e/` and `test-watchlist-expansion.html` for manual UI verification.
- **Manual regression scripts** listed in top-level docs (`WATCHLIST_EXPANSION_FIX.md`, `FLOAT_OFS_*` reports).
- When adding features, prefer unit tests around services and integration tests for routing behavior. Remember to keep this document updated with any new flows or modules introduced by those tests.

---

## 9. Configuration & Deployment Notes

- Environment variables managed via `.env` (see `src/core/config.js`). Key settings:
  - `PORT`, `SESSION_SECRET`, `OPENALGO_PROXY`, `DATABASE_PATH`.
  - Polling cadence overrides (e.g., `MARKET_DATA_QUOTE_INTERVAL_MS`).
- SQLite DB lives under `backend/database/`. Use migration scripts in `backend/migrations`.
- Tailwind build via `npm run build:css`; DaisyUI customization in `backend/tailwind.config.js`.
- Production deployment typically runs `npm run build:css && npm start`.

---

## 10. Future Enhancements & Document Maintenance

Whenever you extend the application:

1. Update the relevant sections in this document (architecture changes, new workflows, APIs, or services).
2. Add or adjust unit/E2E tests to cover the new behavior.
3. Ensure the market data feed inventory includes any new symbol sources (e.g., derivatives watchers, baskets).
4. Review OpenAlgo call inventory (`docs/openalgo_call_inventory.md`) and amend the rate-limit plan accordingly.

Keeping this document synchronized with the codebase ensures new contributors can ramp quickly and auditors understand the system without digging through multiple files.

---

**Last reviewed:** _<add date when updating>_
