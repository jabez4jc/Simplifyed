# Simplifyed Architecture (Comprehensive)

This document describes the full architecture of the Simplifyed Admin application, covering backend services, frontend UI, data model, background jobs, and integrations. It includes deep detail on watchlist trading, instance management, and settings management.

## 1) System Overview

Simplifyed is a Node.js/Express application with a SQLite data store and a static HTML/JS frontend. The backend serves the UI, exposes a REST API, and runs background services for market data, polling, and automation. It integrates with OpenAlgo (broker aggregation API), TradingView webhooks, and Telegram.

High-level flow (simplified):

```
Browser UI
  -> Static HTML/CSS/JS (public/)
  -> API calls to /api/v1/*
     -> Express routes
        -> Services
           -> SQLite DB
           -> OpenAlgo API (HTTP + WS)
           -> Background services (polling, market-data-feed, auto-exit)
           -> Notifications (Telegram)
```

Core subsystems:
- **Backend API**: Express routes under `/api/v1` handle instances, watchlists, orders, symbols, settings, etc.
- **Background services**: Polling, market data feed, auto-exit, order retry, instance health checks, Telegram notifications.
- **Data layer**: SQLite database with migrations and a Promise-based DB wrapper.
- **Frontend**: Static pages (`public/*.html`) and JS modules (`public/js/*`) using a custom API client.

## 2) Repository Layout

Top-level (key paths):
- `backend/server.js`: Express server entry point.
- `backend/src/core/*`: Config, logger, database, and error definitions.
- `backend/src/routes/v1/*`: REST API routes grouped by domain.
- `backend/src/services/*`: Business logic and background services.
- `backend/src/integrations/openalgo/*`: OpenAlgo API client and validators.
- `backend/public/*`: Static UI assets (HTML, CSS, JS).
- `backend/migrations/*`: Database schema migrations.
- `backend/scripts/*`: Instrument import helpers.
- `data/*`: SQLite session DB for Express sessions.

## 3) Runtime Architecture

### 3.1 Server Bootstrap
- **Entry**: `backend/server.js` creates an Express app, applies middleware, and mounts routes.
- **Environment**: Forces timezone to IST for consistent timestamps.
- **Sessions**: Uses `express-session` + `connect-sqlite3` to persist sessions in `data/sessions.db`.
- **Config**: Loads environment + DB settings via `core/config.js`.

### 3.2 Middleware Pipeline
Order of major middleware:
1. Security headers (Helmet).
2. CORS (configured by settings).
3. Compression.
4. JSON/body parsing (with size limits).
5. Correlation ID and request logging.
6. Session handling.
7. Optional auth (session/Supabase/test-mode).
8. Instruments refresh background check.
9. Audit logger for API write operations.
10. API routes.
11. Error handling and 404 fallback.

### 3.3 Background Services Lifecycle
The server starts background services after a successful login/signup or during `optionalAuth` if an authenticated session exists:
- `MarketDataFeedService`: central quote/position/funds cache, multi-quote batching, WS integration.
- `PollingService`: periodic instance polling (P&L, orders, health status).
- `AutoExitService`: monitoring-based auto-exit logic for targets, stops, trailing stops.
- `TelegramService`: order notifications and summaries.
- `InstanceHealthService`: cron-based endpoint capability checks.

## 4) Authentication & Authorization

### 4.1 Auth Methods
All methods issue/verify a Bearer JWT checked in `middleware/auth.js`'s `optionalAuth`; there is no server-side login session for users (see note below on `express-session`).
- **Local email/password**: `POST /api/v1/auth/register` (bootstrap-only - closes once any user exists), `/login`, `/change-password`. Tokens are HS256, signed with `config.auth.jwtSecret` (env `JWT_SECRET`), 7-day expiry.
- **Supabase JWT auth**: optional, gated on `SUPABASE_URL` being configured. Validates ES256 (JWKS, modern Supabase default) and HS256 (legacy/service-role) tokens.
- **Test mode**: `ENABLE_TEST_MODE=true` bypasses auth entirely with a hardcoded admin user - never enable in production.
- `optionalAuth` tries local-token verification first, then falls through to Supabase if that fails and `SUPABASE_URL` is set - both can be active simultaneously, and a user can have a Supabase identity, a local password, or both.
- `express-session` + `connect-sqlite3` (`data/sessions.db`) is configured but **not used for user login** - it exists solely to back cookie auth for the WebSocket gateway.

### 4.2 RBAC
- Roles, permissions, and user-role assignments are stored in DB.
- `middleware/auth.js` attaches user + permissions to the request.
- `requirePermission` checks are used on most routes.

### 4.3 Audit Logging
- Writes to `audit_logs` for mutating requests, including quick orders and instance changes.

## 5) Data Model (SQLite)

Major tables (selected fields):

### Core Entities
- **users**: email, is_admin, password_hash (local auth).
- **instances**: connection details, health status, broker metadata, market data flags, analyzer mode, multiplier.
- **watchlists**: name, description, is_active, type (standard/broadcast), webhook_slug.
- **watchlist_symbols**: exchange/symbol, tradability flags, product/qty defaults, derivative metadata, risk/auto-exit config, tick/limit buffer settings.
- **watchlist_instances**: many-to-many assignment of instances to watchlists.

### Trading State
- **watchlist_orders**: normalized order history from quick orders or manual placements.
- **watchlist_positions**: watchlist-level position tracking (derived from OpenAlgo data).
- **watchlist_options_state**: aggregate options positions by watchlist/symbol/expiry/strike.
- **quick_orders**: storage for quick-order requests and responses.
- **order_monitor_log**: historical monitor events and exit actions.
- **analyzer_trades**: analyzer-only trade records and simulated P&L.

### Market Data & Instruments
- **market_data**: LTP cache and OHLC snapshot for watchlist display.
- **quote_snapshots**: per-instance quote snapshots with dedupe hashes.
- **instruments**: cached instrument master.
- **instruments_refresh_log**: import history.
- **symbol_cache / symbol_search_cache**: symbol lookup optimization.
- **options_cache / expiry_calendar**: option chain and expiry utilities.

### Strategies & GTT
- **strategies**: named multi-leg strategy scoped to a watchlist, optional `webhook_slug` for TradingView-style triggering, `entry_trigger` (MANUAL/webhook).
- **strategy_legs**: per-leg config (option_type, action, strike_policy/offset, qty, product, target/stoploss/trailing points, `exit_mechanism`).
- **strategy_leg_executions**: one row per leg per instance execution - resolved symbol, entry/exit order IDs and status/prices, `opened_at`/`closed_at`.
- **gtt_orders**: GTT-style trigger records placed for leg exits (see 7.x below), linked to `strategy_legs` via `strategy_leg_id`.

### Risk & Monitoring
- **trailing_state**: trailing stop-loss state across instances and symbols.
- **risk_events**: audit trail of risk-control actions (target/stop/trailing hits) with previous/new values.
- **daily_instance_pnl_snapshots**: daily P&L snapshots.
- **order_monitor_log**: order monitor history (for monitoring/analysis).
- **notifications**: system and health notifications.
- **telegram_subscribers**: Telegram link state per user.
- **telegram_message_log**: outgoing message history (where enabled).

### Settings & Access
- **application_settings**: settings by category, data type, description, sensitive flag.
- **roles / permissions / role_permissions / user_roles**: RBAC model.
- **audit_logs**: request audit trail.
- **idempotency_keys**: request replay protection for orders.

## 6) Core Services (Responsibilities)

### 6.1 Config & Settings
- `core/config.js`: loads env and DB settings with caching.
- `services/settings.service.js`: CRUD over `application_settings`, type validation, defaults, change events.

### 6.2 Market Data
- `services/market-data-feed.service.js`:
  - Central cache for quotes, positions, funds, orderbook, tradebook.
  - Dynamic refresh intervals based on open positions.
  - WS-first quotes via `openalgo-ws.service.js`, REST only for stale/missing symbols.
  - MultiQuote batching and REST fallback for gaps.
  - Quote snapshots persisted to DB with dedupe hashes.
  - Depth cache (mode 3, `depth_level=5`) for order-critical pricing only.
  - WS staleness detection (10 min) pauses symbol refresh until the next session.
  - Market calendar gating (OpenAlgo timings/holidays) to avoid calls when closed.
- `services/market-calendar.service.js`:
  - Calls OpenAlgo `/market/timings` and `/market/holidays`.
  - Caches results and answers `isExchangeOpen` / `getNextSessionOpen`.
  - Used by quotes, LTP, depth, and instance health checks to skip closed sessions.

### 6.3 Instances
- `services/instance.service.js`:
  - CRUD for instances.
  - Connection tests and broker auto-detection.
  - Health status updates and analyzer mode detection.
  - P&L updates (tradebook-based).
  - Cleanup of dependent records on delete.
- `services/market-data-instance.service.js`:
  - Round-robin selection of healthy market data instances.
  - Endpoint-specific pools (quotes/multiquotes/optionchain).

### 6.4 Orders & Trading
- `services/order.service.js`:
  - Manual order placement (placesmartorder).
  - Normalizes payloads, uses limit price resolution.
  - Persists orders and triggers notifications.
- `services/order-placement.service.js`:
  - Centralized OpenAlgo placement, validation, coalescing.
  - Per-instance queue and rate limiting.
  - Order retry on error with recovery via orderbook.
- `services/order-retry.service.js`:
  - Limit order retry pipeline with partial-fill handling.
  - Slippage guard against large LTP deviation.
  - Optional repeat-until-closed behavior with final checks.
  - Reprices using depth-derived bid/ask when available, with WS-first LTP fallback.
  - Cancels open/pending orders for the instance/strategy before placing a fresh retry order.
  - Uses pending quantities to decide whether a retry is necessary (skips if already covered).
- `services/quick-order.service.js`:
  - Core watchlist trading engine (equity/futures/options).
  - Position-aware sizing and strategy handling.
  - Pre-fetching positions, symbol resolution, order logging.
  - Close/exit retries across instances when some fail.
  - Uses `LimitPriceService` and WS-first LTP (via market data feed) for order-critical pricing.

### 6.5 Risk & Automation
- `services/auto-exit.service.js`:
  - Continuous monitoring of positions.
  - Evaluates targets, stop-loss, trailing stop for equity/futures/options.
  - Triggers exit orders via quick-order flow.
- `services/risk-controls.service.js`:
  - Computes target/stop/trailing logic and persists trailing state.

### 6.6 External Integrations
- `integrations/openalgo/client.js`: HTTP2 client, backoff, per-instance health, circuit breaker.
- `services/tradingview-broadcast.service.js`: TradingView webhook payload normalization and broadcast.
- `services/telegram.service.js`: linking and notifications.

### 6.7 Observability
- `core/logger.js`: structured logging and query timing.
- `middleware/request-logger.js`: correlation IDs and request logs.
- `routes/v1/telemetry.js`: telemetry reporting endpoints.

### 6.8 Dashboard, Positions, and P&L
- `services/dashboard.service.js`: aggregates per-instance metrics for the UI (funds, P&L, trade counts).
- `services/positions.service.js`: normalizes positions across brokers and computes totals.
- `services/pnl.service.js`: computes realized/unrealized P&L and symbol-level breakdowns.
- `services/pnl-snapshot.service.js`: daily P&L snapshot persistence and signal counters.

### 6.9 Snapshots and Cache Introspection
- `routes/v1/snapshots.js`: exposes cache-backed snapshots for quotes, positions, orderbook, and tradebook.
- `routes/v1/telemetry.js`: reports rate-limit state, cache status, and WS subscriptions.

### 6.10 Idempotency and Provenance
- `services/idempotency.service.js`: stores idempotency keys, hashes, and cached responses for replays.
- Order rows store `request_id`, `trigger_type`, `correlation_id`, and `source` for traceability.

## 7) Watchlist Trading Architecture (Deep Detail)

Watchlist trading is the heart of the system. It is implemented through a combination of UI interactions, REST endpoints, and the `QuickOrderService`.

### 7.1 Watchlist Data Model
- **watchlists**: grouping entity with `type` (standard/broadcast).
- **watchlist_symbols**: per-symbol trade configuration:
  - Tradable flags: `tradable_equity`, `tradable_futures`, `tradable_options`.
  - Quantity config: `qty_type`, `qty_value`, `lot_size`.
  - Product defaults: `product_type`, `order_type`.
  - Derivative metadata: `underlying_symbol`, `expiry`, `option_type`.
  - Risk controls: target/stop/trailing fields for equity/futures/options.
  - Price constraints: `limit_buffer_points`, `limit_buffer_pct`, `tick_size`.

### 7.2 Watchlist UI Workflow (Frontend)
- **Dashboard view** renders watchlists and symbols in a table.
- Each symbol row can be expanded by `QuickOrderHandler` to show:
  - Trade mode selection (equity/futures/options).
  - Options leg (ITM/ATM/OTM), expiry selection.
  - Product type (MIS/CNC/NRML).
  - Buyer/Writer mode (options), strike policy (FLOAT_OFS/ANCHOR_OFS).
- UI calls `/api/v1/quickorders` with the selected parameters.

### 7.3 Quick Order API
- `POST /api/v1/quickorders` validates:
  - Action compatibility with trade mode.
  - Quantity and instance IDs.
  - Options leg requirements for options actions.
  - Idempotency key for safe retries.

### 7.4 Quick Order Execution Pipeline
The `QuickOrderService` does the heavy lifting:

1. **Symbol Config Lookup**
   - Loads watchlist symbol + watchlist metadata from DB.
   - Validates tradability flags and symbol type for futures/options.

2. **Instance Resolution**
   - If no instance specified, broadcasts to all assigned, active, order-enabled instances.
   - If a specific instance is specified, validates it is active and allowed to trade.

3. **Pre-resolution (Options)**
   - For multi-instance options trades, resolves the option symbol once using a market data instance
     to keep strike/expiry consistent across instances.

4. **Position Preload**
   - Fetches current positions from `MarketDataFeedService` for accurate sizing.

5. **Strategy Selection**
   - `DIRECT_ORDER`: equity/futures buy/sell/short/cover.
   - `OPTIONS_WITH_RECONCILIATION`: options entry/adjust actions with buyer/writer logic.
   - `CLOSE_POSITIONS`: exit/close actions across positions.

6. **Order Placement**
   - Builds order payload via `order-payload.factory.js`.
   - Resolves limit price via `LimitPriceService` (depth bid/ask preferred, LTP fallback).
   - Dispatches via `OrderPlacementService` (rate limiting and retry support).

7. **Persistence & Notifications**
  - Writes order entries to `watchlist_orders` and `quick_orders`.
  - Updates `watchlist_positions` or options state as needed.
  - Sends Telegram notifications and broadcast summaries.

### 7.9 Order Placement & Retry (Expanded + Visual)

Order placement is a WS-first, position-aware pipeline that always targets a *position_size* and uses LIMIT pricing by default.
Retries are scheduled only for LIMIT orders and reprice using depth (bid/ask) with LTP fallback.

Visual flow (high level):

```
UI Button (Dashboard)
  -> POST /api/v1/quickorders
     -> QuickOrderService
        -> Strategy selection (DIRECT | OPTIONS | CLOSE)
        -> Position preload (entry/adjust) or live fetch (close)
        -> LimitPriceService (depth->quote->LTP)
        -> OrderPlacementService (placesmartorder)
        -> OrderRetryService (LIMIT only)
```

#### 7.9.1 Button Map (Per Mode)

EQUITY / FUTURES buttons:

```
LONG:  BUY   SELL
SHORT: SHORT COVER
EXIT:  EXIT
```

Action behavior (EQUITY/FUTURES):
- **BUY**: increases long position; if short, flips to target long size.
- **SELL**: reduces long position only; no-op if already flat/short.
- **SHORT**: increases short position; if long, flips to target short size.
- **COVER**: reduces short position only; no-op if already flat/long.
- **EXIT**: always targets `position_size = 0` (flatten) and triggers close flow.

OPTIONS buttons (Buyer/Writer modes):

Buyer mode:
```
CALL: BUY CE | REDUCE CE | CLOSE CE
PUT:  BUY PE | REDUCE PE | CLOSE PE
EXIT: EXIT ALL
```

Writer mode:
```
CALL: SELL CE | INCREASE CE | CLOSE CE
PUT:  SELL PE | INCREASE PE | CLOSE PE
EXIT: EXIT ALL
```

Action behavior (OPTIONS):
- **BUY CE / BUY PE**: add long option positions for the selected strike/expiry.
- **SELL CE / SELL PE**: add short option positions (writer mode).
- **REDUCE CE/PE**: reduce long positions (buyer mode).
- **INCREASE CE/PE**: cover/reduce short positions (writer mode).
- **CLOSE CE / CLOSE PE**: close *all* CE or PE positions for the selected expiry.
- **EXIT ALL**: close *all* CE + PE positions for the selected expiry.

Notes:
- OPTIONS requires: expiry + operating mode + strike policy + quantity.
- Strike policy:
  - **FLOAT_OFS**: dynamic strike selection based on current LTP.
  - **ANCHOR_OFS**: first resolved strike is anchored for subsequent adds.
- `step_lots` applies to REDUCE/INCREASE sizing in OPTIONS.

#### 7.9.2 Order Placement (DIRECT: Equity/Futures)

Direct order logic (BUY/SELL/SHORT/COVER):
1. Resolve tradable symbol (spot or futures), product, tick size.
2. Preload positions (live) for accurate sizing.
3. Compute `targetPosition` based on action:
   - BUY: `current >= 0 ? current + tradeLots : tradeLots`
   - SELL: `max(current - tradeLots, 0)` (no-op if `current <= 0`)
   - SHORT: `current <= 0 ? current - tradeLots : -tradeLots`
   - COVER: `min(current + tradeLots, 0)` (no-op if `current >= 0`)
4. Compute `orderQuantity = abs(targetPosition - currentPosition)`.
   - `tradeLots = inputLots * instanceMultiplier`, `currentLots = currentPosition / lotSize`.
5. Build LIMIT order with `position_size = targetPosition`.
6. Price via `LimitPriceService` (depth->quote->LTP, buffer points/pct, tick rounding).
7. Place via `OrderPlacementService` (placesmartorder).
8. Schedule retry (LIMIT only).

#### 7.9.3 Order Placement (OPTIONS)

Options order logic (buyer/writer):
1. Resolve expiry + strike (pre-resolve once for broadcast; per-instance for FLOAT_OFS reduce).
2. Determine scope:
   - **Type scope** (aggregate across strikes) for FLOAT_OFS reduce/close.
   - **Leg scope** (single strike) for add actions and ANCHOR_OFS.
3. Compute `Qstep = step_lots * lot_size * instance_multiplier`.
4. Compute `targetPosition` using the options implementation guide:
   - Buyer mode: BUY adds; REDUCE subtracts.
   - Writer mode: SELL adds shorts; INCREASE reduces shorts.
5. Build LIMIT order with `position_size = targetPosition`.
6. Price via `LimitPriceService` (depth->quote->LTP, buffer points/pct, tick rounding).
7. Place via `OrderPlacementService`.
8. Update `watchlist_options_state` and schedule retry (LIMIT only).

FLOAT_OFS reduce/close special path:
- Enumerates all open strikes for underlying+expiry+type.
- Calculates per-strike target; places one or multiple orders accordingly.

#### 7.9.4 Close/Exit (Positions + Pending Orders)

Close flow (EXIT, EXIT_ALL, CLOSE_ALL_CE/PE):
1. Determine which positions to close:
   - EQUITY/FUTURES: target symbol (futures resolved by underlying+expiry).
   - OPTIONS: CE/PE type or all types for given expiry.
2. For each open position, submit a LIMIT order with:
   - `position_size = 0`
   - `forceLtp = true` and `bypassSpreadCheck = true` (closing favors certainty).
3. For non-options EXIT, cancel pending orders for the symbol after the close attempt:
   - `orderService.cancelPendingOrdersForSymbol(...)`

Close/exit retry (broadcast):
- If some instances fail close/exit, the system retries with exponential backoff.
- Each retry cancels open orders for the instance/strategy before re-closing.

#### 7.9.5 Retry Logic (LIMIT Orders)

OrderRetryService is scheduled after a LIMIT order placement:

```
Initial LIMIT order -> scheduleRetry (5s)
  -> read orderbook
  -> if open/pending:
       compute remaining vs target
       cancel open/pending orders for instance/strategy
       reprice using depth bid/ask (LTP fallback)
       place fresh LIMIT order
       schedule final check (5s)
```

Key behaviors:
- **Depth-first repricing**: uses WS-first depth (bid/ask) when available.
- **Slippage guard**: cancels retry if LTP deviates too far from initial price.
- **Partial fills**: retries remaining quantity only (if allowed).
- **Repeat-until-closed**: optional loop until target position is reached.
- **Pending-aware gating**: if pending orders already cover the remaining target, the retry is skipped and open orders for the symbol are canceled.

#### 7.9.6 Limit Pricing (Depth -> Quote -> LTP)

Limit price resolution uses the freshest available market data and always applies buffers + tick rounding:

```
Depth (WS mode=3, depth_level=5)
  -> Quote (WS/REST)
     -> LTP (if present) or bid/ask (if LTP missing)
```

Rules:
- **Primary**: bid/ask from depth (BUY uses ask, SELL uses bid).
- **Fallback**: use LTP when present; otherwise use bid/ask with spread checks.
- **Spread guard**: rejects prices when spread exceeds `max_order_spread_pct` (configurable).
- **Buffers**: `limit_buffer_points` (or pct) is applied on top of the base price.
- **Tick rounding**: final price is rounded to the symbol tick size.
- **Close/exit**: uses `forceLtp = true` and `bypassSpreadCheck = true` to prioritize fills.

### 7.5 Options-Specific Logic
Key options features implemented in `QuickOrderService`:
- **Buyer/Writer modes**: determines target position sizing.
- **Strike selection**: uses `OptionsResolutionService` with ITM/ATM/OTM offsets.
- **Strike policy**:
  - `FLOAT_OFS`: dynamic strike targeting based on current LTP.
  - `ANCHOR_OFS`: anchors the first resolved strike for consistent scaling.
- **Reduce/Increase actions**: can operate at type scope (aggregate strikes) or leg scope.
- **Option chain data**: fetched from broker API if supported or derived from cached instruments.

### 7.6 Futures-Specific Logic
- `DerivativeResolutionService` resolves futures contracts based on underlying, exchange, expiry.
- Supports multiple expiry formats and exchange mappings (NFO/BFO/MCX/CDS).

### 7.7 Auto-Exit Integration
- `AutoExitService` evaluates watchlist symbol risk configurations.
- Uses `RiskControlsService` to decide target/stop/trailing triggers.
- Places exit orders through the same quick-order pipeline.

### 7.8 TradingView Broadcast
- TradingView webhook payloads are validated and normalized.
- Broadcast targets are resolved from watchlist assignments.
- Orders are placed per target instance with rate-limiting buckets.

### 7.10 Multi-Leg Strategies & GTT (`strategy.service.js`)

A **strategy** is a named group of legs (e.g. sell ATM CE + sell ATM PE) scoped to a watchlist, manageable via `/api/v1/strategies` and executable via webhook (`findByWebhookSlug`) or the UI.

- **Execution** (`executeStrategy`) resolves each leg's symbol/strike (once per broadcast for consistency, or per-instance for FLOAT_OFS reduce) and reuses `quickOrderService.placeQuickOrder` for the actual order - no separate order-placement path.
- **Exit tracking**: rather than a bespoke exit engine, each leg's resolved trading symbol gets a `watchlist_symbols` row carrying that leg's own target/stoploss/trailing config, so exits ride the existing `AutoExitService`/`RiskControlsService` polling loop used for regular watchlist symbols. `_placeLegExitGtt` additionally records the exit as a `gtt_orders` row for visibility/cancellation via `/api/v1/gtt`.
- **Status**: `GET /:id/status` (`getExecutionStatus`) aggregates `strategy_leg_executions` across instances for a strategy.
- **Risk events**: target/stop/trailing hits during strategy or watchlist-symbol monitoring are recorded to `risk_events`, readable via `/api/v1/risk-events` (audit-only, no write endpoint).

## 8) Instance Management Architecture (Deep Detail)

### 8.1 Instance Creation
- UI form captures host URL + API key.
- Backend tests connection via OpenAlgo `ping`.
- Broker is auto-detected and saved.
- Optional flags captured:
  - `market_data_enabled` (pool eligibility).
  - `supports_multiquotes` and `supports_option_chain`.
  - `use_ws_quotes` and `websocket_url`.
  - `order_placement_enabled`.
  - `multiplier` for quantity scaling.

### 8.2 Health & Availability
- **Polling service** runs `instanceService.updateHealthStatus` regularly.
- **InstanceHealthService** (cron) tests quotes/multiquotes/optionchain endpoints.
- OpenAlgo client maintains per-instance health and circuit breaker state.

### 8.3 Market Data Pooling
- `MarketDataInstanceService` selects healthy instances for:
  - Quotes/multi-quotes.
  - Option chain lookups.
- Uses round-robin across the pool to balance requests.
- Supports endpoint-level disable flags (`disable_quotes`, `disable_multiquotes`, `disable_optionchain`).

### 8.4 P&L and Positions
- Instance P&L is computed from tradebook and positions.
- `pnl-snapshot.service.js` records periodic snapshots and signal counts.

### 8.5 Instance Deletion
- Removes instance record and cleans up:
  - watchlist assignments
  - orders, positions, options state
  - monitoring/trailing state

## 9) Settings Management Architecture (Deep Detail)

### 9.1 Storage Model
- All settings live in `application_settings` with:
  - `key`, `value`, `category`, `data_type`, `description`, `is_sensitive`.
- `SettingsService` ensures essential keys exist at runtime.

### 9.2 Config Loading
- `core/config.js` caches settings for a short duration to limit DB reads.
- If DB is unavailable, falls back to environment variables.

### 9.3 Settings API
- `GET /api/v1/settings`: all settings grouped by category.
- `PUT /api/v1/settings`: batch updates.
- `PUT /api/v1/settings/:key`: single updates.
- `POST /api/v1/settings/:key/reset`: reset to defaults.
- `GET/PUT /api/v1/settings/instance-health-tests/config`: JSON config for health checks.

### 9.4 Settings UI (Frontend)
- `SettingsHandler` shows a curated subset of settings for admin control.
- Categories include polling, market data feed, instance health, market hours, trading sessions, and brokerage.
- Sensitive settings are masked and have visibility toggles.

### 9.5 Redundant Settings Cleanup
The settings UI intentionally hides internal-only or redundant configuration to reduce confusion:
- **Removed from UI**:
  - `settings.cache_duration_ms` (internal config cache).
  - `polling.market_data_interval_ms` (internal quote refresh tick; actual refresh is governed by market data feed TTLs).

## 10) Market Data Pipeline (Deep Detail)

### 10.1 MarketDataFeedService
- Maintains caches for quotes, positions, funds, orderbook, tradebook.
- Refresh cycle uses dynamic intervals based on open positions.
- Quotes are retrieved via WS-first fallback:
  1. WebSocket feed when connected.
  2. REST MultiQuotes for stale/missing symbols only.
  3. Single-quote REST fallback only when MultiQuotes cannot fill gaps.
- Market calendar gating prevents quote/LTP/depth calls when exchanges are closed or on holidays.
- WS staleness detection pauses symbol refresh after 10 minutes of unchanged data until the next session open.

### 10.2 Quote Snapshots
- Quotes are persisted to `quote_snapshots` to warm cache on restart.
- Hash-based dedupe prevents noisy writes.

### 10.3 Multi-Quote Cooldown
- Throttles batch requests to protect broker rate limits.

### 10.4 Limit Price Resolution
- `LimitPriceService` enforces `max_order_spread_pct` to avoid wide spreads.
- Uses WS-first depth (mode 3, `depth_level=5`) for bid/ask and falls back to quotes/LTP.
- Depth subscription is on-demand for order-critical actions only (not watchlists or P&L).

## 11) Frontend Architecture

### 11.1 Pages
- `public/login.html`: login screen.
- `public/dashboard.html`: main app shell.
- `public/settings.html` (rendered via JS in dashboard): settings tabs.

### 11.2 Frontend JS Modules
- `public/js/dashboard.js`: main app state, view switching, watchlists, instances, orders.
- `public/js/quick-order.js`: watchlist row expansion and trade controls.
- `public/js/settings.js`: settings UI, RBAC admin, import/export.
- `public/js/api-client.js`: API wrapper for all endpoints.
- `public/js/utils.js`: helper utilities for formatting and UI.

### 11.3 Data Refresh Patterns
- Watchlist view uses market data cache and background polling.
- Quick-order expansions trigger derivatives/expiry prefetching.

## 12) External Integrations

### 12.1 OpenAlgo
- HTTP client with retry/backoff, HTTP/2 multiplexing.
- Circuit breaker to protect against repeated errors.
- WebSocket for streaming quotes (optional).

### 12.2 TradingView Webhook
- `/webhook/tradingview/*` endpoints accept TradingView payloads.
- Payloads are normalized and broadcast to watchlist instances.

### 12.3 Telegram
- Bot integration for order alerts and summaries.
- User linking via `/start` command with one-time codes.

## 13) API Surface Overview

Route groups under `/api/v1` (by module):
- **auth**: `register` (bootstrap-only), `login`, `change-password` - local email/password auth (see §4.1).
- **instances**: instance CRUD, health, P&L commits, CSV import/export.
- **watchlists**: watchlist CRUD, symbol management, instance assignments, CSV import/export.
- **strategies**: multi-leg strategy CRUD, leg management, execute/exit, status (see §7.10).
- **gtt**: list/cancel GTT-tracked exit triggers (see §7.10).
- **risk-events**: read-only risk-control event log.
- **quickorders**: watchlist trading actions (equity/futures/options) with idempotency support.
- **orders**: manual order placement and order history.
- **positions**: per-instance positions and aggregated P&L.
- **symbols**: symbol lookup and consolidated quote subscriptions.
- **instruments**: instrument cache and refresh controls.
- **polling**: start/stop polling and status.
- **dashboard**: dashboard metrics aggregation.
- **monitor**: order monitor status and logs.
- **settings**: application settings CRUD and instance health tests.
- **option-chain**: option chain and expiry helpers.
- **trades**: tradebook access and reconciliations.
- **rbac**: roles, permissions, and user role management.
- **notifications**: health and system notifications.
- **audit**: audit log access.
- **health-check / ready / health**: runtime and readiness probes.
- **telemetry**: rate-limit and cache visibility.
- **snapshots / pnl-snapshots**: cache snapshots and daily P&L export.
- **public-config**: unauthenticated Supabase URL/anon-key + feed-timing config for the frontend bootstrap.

Webhook routes (public token auth):
- **/webhook/tradingview**: TradingView broadcast endpoints.

## 14) Operational Notes

- **Migrations** are applied via `backend/migrations/migrate.js`.
- **Instrument imports** are handled by scripts in `backend/scripts/` and top-level `import-instruments*.sh` scripts.
- **Session DB** is separate from the main app DB and stored under `data/sessions.db`.

## 15) Key Architectural Guarantees

- Centralized market data feed avoids duplicated broker calls.
- Quick orders are position-aware and idempotent where possible.
- RBAC and audit logs provide traceability for admin actions.
- Health checks prevent unhealthy instances from being used for trading or market data.
