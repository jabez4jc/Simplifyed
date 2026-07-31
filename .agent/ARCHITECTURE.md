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
7. Optional auth (local Bearer JWT / test-mode).
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
- **Local email/password** (the only user-facing method): `POST /api/v1/auth/register` (bootstrap-only - closes once any user exists), `/login`, `/change-password`. Tokens are HS256, signed with `config.auth.jwtSecret` (env `JWT_SECRET`), 7-day expiry. Passwords are bcrypt hashes (cost 10); `attachRoleAndPermissions` deliberately never selects `password_hash`, since its return value becomes `req.user` and is serialized into API responses.
- **Test mode**: `ENABLE_TEST_MODE=true` bypasses auth entirely with a hardcoded admin user - never enable in production.
- Accounts after the first are created by an admin (Settings → Access Control, `rbac.service.js`), not by self-service signup. `scripts/set-user-password.js` is the CLI escape hatch for a lost password; it has no HTTP route.
- `express-session` + `connect-sqlite3` (`data/sessions.db`) is configured but **not used for user login** - it exists solely to back cookie auth for the WebSocket gateway (`validateWsSessionFromRequest` in `server.js`).

### 4.2 RBAC
- Roles, permissions, and user-role assignments are stored in DB.
- `middleware/auth.js` attaches user + permissions to the request.
- `requirePermission` checks are used on most routes.

### 4.3 Audit Logging
- Writes to `audit_logs` for mutating requests, including quick orders and instance changes.

## 5) Data Model (SQLite)

### 5.0 Connection Semantics
`core/database.js` is a singleton wrapping **one** sqlite3 connection (WAL journal, foreign keys on). Two consequences worth knowing before writing data code:

- A SQLite transaction is a property of the connection, not the caller. `db.transaction()` therefore serializes its callers through an internal promise queue - without it, an overlapping `BEGIN` throws `cannot start a transaction within a transaction`, and whichever `COMMIT`/`ROLLBACK` lands first applies or discards the *other* caller's partial writes. Real overlap exists today: the instruments refresh (cron- and middleware-triggered) against watchlist writes arriving over HTTP.
- Because everything shares one connection, transaction throughput is bounded. The upgrade path is a connection pool, not finer-grained locking.

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
- **`config/settings-registry.js`: the single source of truth for what may be changed at runtime.**

**A setting is editable only if it appears in the registry.** `updateSetting()` rejects everything else, and `GET /api/v1/settings/schema` serves the registry (grouped, labelled, with current values) to the Settings screen. Adding a setting to the registry is the only step needed to surface it — there is no second list to keep in sync.

This is enforced server-side on purpose. The allowlist used to live only in `settings-core.js`, so it filtered *display* while the API still accepted a `PUT` to any key in the table. That included `test_mode.enabled`, which switches `optionalAuth` to a hardcoded admin identity for the whole process — an authentication kill switch one request away from anyone holding `settings.manage`.

Three classes of key are deliberately excluded, and migration 059 deleted their rows:

| Class | Why | Examples |
| ----- | --- | -------- |
| Boot-only | Read once at module load or startup; editing does nothing until a restart | `server.port`, `cors.*`, `logging.*`, `database.path` |
| Secrets | Must come from the environment, where `getEnv(..., required)` can enforce them | `session.secret` |
| Debug kill-switches | Disable protection against flooding a live broker; still settable directly in the DB | `rate_limits.disabled`, `rate_limits.circuit_breaker_disabled` |

`session.secret` deserves specific mention: the shipped row held the literal `CHANGE_THIS_IN_PRODUCTION` and was loaded *over* the required `SESSION_SECRET` env var — but only after `configureSession()` had already signed cookies with the env value at module load. `validateWsSessionFromRequest` then verified against the database value, so **every WebSocket connection was rejected and the terminal silently ran on REST polling**. `config.js` no longer reads any secret from the database.

Settings are grouped by task (Market Data, Trading Hours, Broker Connection, Orders & Costs) rather than by the `category` column, because a category such as `market_data_feed` mixes quote freshness, position cadence and order-pricing guardrails — three unrelated decisions. Every field carries a label, one sentence of help, and where relevant a unit, bounds enforced server-side, and a `pairLabel` so idle/active pairs are self-describing.

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
  - **Market blackout windows are enforced here and only here.** The windows (`market_hours.*` settings, quote vs. general) pause broker calls during Indian off-hours. This is the correct and only layer for the check because it is the one that knows the target instance's broker, and therefore the only one that can exempt 24/7 crypto brokers via `utils/broker-type.util.js`'s `isCryptoBroker`. Do not reintroduce an app-level blackout middleware: it cannot see the broker, so it would black out crypto trading overnight.
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
- **The INSERT is the lock.** Concurrent requests carrying the same `request_id` all miss the initial `SELECT`, so `UNIQUE(request_id, source)` is the only thing separating them: `getOrCreate` uses `INSERT OR IGNORE` and treats `changes === 0` as a duplicate. Exactly one caller receives `hit: false` and may place the order. Never "recover" from a failed insert by re-reading and returning `hit: false` - that lets a retried TradingView alert execute twice.
- `expires_at` is written as SQLite's UTC `YYYY-MM-DD HH:MM:SS`, because `cleanupExpired` string-compares it against `CURRENT_TIMESTAMP`. An ISO-8601 value does not compare correctly against that format.

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
- `GET /api/v1/settings/schema`: **what the Settings UI renders from** — the registry (groups → sections → fields, with labels, help, units and bounds) hydrated with current values. Only runtime-editable settings appear.
- `GET /api/v1/settings`: all settings grouped by category (raw; includes non-editable rows).
- `PUT /api/v1/settings`: batch updates. Runs inside `db.transaction()`; a rejected key is collected into `errors` rather than rolling back the valid keys in the same save.
- `PUT /api/v1/settings/:key`: single update. Rejects any key absent from the registry, and any value outside its declared bounds, with 400.
- `POST /api/v1/settings/:key/reset`: reset to defaults.
- `GET/PUT /api/v1/settings/instance-health-tests/config`: JSON config for health checks.

Writes are validated twice over: the registry checks the key is editable and the value is in range, then `settings.service` coerces it to the column's `data_type`. A client cannot widen this by talking to the API directly — which was the whole problem with the previous frontend-only allowlist.

### 9.4 Runtime Modes: what NODE_ENV does *not* control

`NODE_ENV` is a **label** for logs and the startup banner. Nothing branches on it.

It defaults to `'development'` when unset ([config.js](backend/src/core/config.js)), so anything gated on it fails *open* — a deployment that simply lost its environment file would silently select the permissive path. For a trading system that is the wrong direction, so the three behaviours that used to hang off it now read the input they actually depend on:

| Behaviour | Now derived from | Why |
| --- | --- | --- |
| Session cookie `Secure` | `BASE_URL` scheme (`isSecureBaseUrl()`) | TLS is what makes a Secure cookie correct. `NODE_ENV` only correlates — a TLS deploy missing it sent cookies in the clear, and a `production`-labelled local run set a cookie the browser would never send back. |
| Instruments readiness bypass | `ENABLE_TEST_MODE` only | The bypass set `appReady = true`, so `/api/v1/ready` returned 200 without the instruments cache ever being verified. A readiness probe that cannot fail is not a readiness probe. |
| Stack traces in error bodies | Removed entirely | Stacks belong in logs, which already capture them. Serialising one into an API response only exposes internal paths. |

**`isTestMode()` in `core/config.js` is the single definition of "authentication is disabled."** It reads `ENABLE_TEST_MODE` and nothing else. There were previously two independent environment variables (`ENABLE_TEST_MODE` and `TEST_MODE`) feeding three separate checks in `optionalAuth` — three ways to switch off auth and no single place to audit it. `TEST_MODE` and `config.testMode` are gone.

Test mode still skips the instruments check, because it already means this is not a real deployment. It no longer lies about it: `getAppReadyStatus()` reports `bypassed: true` and leaves `ready` false.

Nothing is lost by removing the development bypass. `needsRefresh()` is two local SQLite queries, so with a warm cache the middleware is already a no-op; the bypass only ever mattered on the one request per day where the cache is genuinely stale — exactly when trading must not proceed.

### 9.5 Adding a Setting
1. Add the row to `application_settings` (via a migration).
2. Add a field to the appropriate group/section in `config/settings-registry.js`, with `label`, `help`, and bounds.

It then appears in the UI, is accepted by the API, and is covered by `Test/unit/settings-registry.test.js` — which asserts every field has help text, ranges are not inverted, and the auth/safety/secret keys stay non-editable.

### 9.6 Settings UI (Frontend)
- `SettingsHandler` shows a curated subset of settings for admin control.
- Categories include polling, market data feed, instance health, market hours, trading sessions, and brokerage.
- Sensitive settings are masked and have visibility toggles.

### 9.7 Redundant Settings Cleanup
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

## 10.5) Charting (Historical Candles)

Read-only in this phase: the chart displays data and places no orders.

**Why the topology differs from the rest of the app.** Orders fan out to every associated instance; candles come from exactly **one**. OHLC for a symbol is the same market fact whichever broker reports it, so fanning out would multiply rate-limit cost for identical data. `candle.service.js` picks a single instance from the existing market-data pool, filtered by broker class — a `CRYPTO` symbol asked of an Indian broker is a guaranteed failure, so there is deliberately no fallback to a mismatched broker.

**Symbols come from `watchlist_symbols`, not free text.** A charted symbol must also be a *tradeable* symbol: the watchlist row carries the quantity defaults, product, tick buffers and risk/auto-exit config that every order path depends on. Sourcing the picker anywhere else would produce a chart whose trade buttons could not later be wired up without bypassing those guardrails.

**The `candles` cache (migration 060) is not an optimisation, it is load-bearing.**
- `history` shares the per-instance rate limiter with the live trading feed. Uncached, a user scrubbing timeframes competes with position and quote polling for the same budget.
- `history` is **not** a quote endpoint (`client.js` matches only quotes/optionchain/depth), so it falls under the *general* blackout window. Without a cache the chart simply fails overnight; with one it serves last-known candles and sets `stale: true`, which the UI states in words.
- A `MIN_FETCH_INTERVAL_MS` cooldown means repeated requests for the same symbol/timeframe cannot translate into broker traffic.
- Rows are upserted, not ignored on conflict: the newest candle of a live session is still forming, and `ON CONFLICT DO NOTHING` would freeze the current bar at its first value.

**Time axis.** Stored `ts` is a true UTC epoch in seconds exactly as the broker returns it (verified: BSE's first candle of the day is 03:45Z = 09:15 IST). Lightweight Charts renders its axis in UTC and has no timezone option, so `dashboard-chart.js` adds the IST offset **to the value handed to the chart only**. Never store or compare the shifted value.

**Library.** TradingView Lightweight Charts, Apache-2.0, vendored at `public/vendor/` and loaded via a plain script tag — no bundler, no framework, same idiom as every other view. The licence requires the visible attribution link rendered under the chart; do not remove it.

**Not adopted:** the reference implementation (`marketcalls/openalgo`) drives a `TradingTerminal` from `{ apiKey, wsUrl }` pointing at a single OpenAlgo server, and is React + Vite. Both assumptions are wrong here — this app is a multi-instance control plane, and has no build step.

### Position overlay and chart trading

**The overlay states what the line means.** Under fan-out a single "entry price" is ambiguous — two instances can hold the same symbol at different averages. `GET /api/v1/positions/symbol` returns the quantity-weighted aggregate *and* the per-instance legs; the chart draws the aggregate, labels it `avg entry · net <qty>`, and lists the legs beneath it. It reads positions with `refresh: false`, so the chart never triggers broker traffic of its own.

**One click fans out to N live orders.** This is the single most important difference from the reference implementation, which is a one-click-one-order single-instance terminal. The confirmation dialog is therefore not a formality — it is the only place the operator learns the blast radius. Before anything is sent it states the exact instance list with **live and analyzer separated in words** ("1 LIVE — real money" / "1 analyzer — simulated"), the resolved quantity, and that partial success is a normal outcome.

`GET /api/v1/quickorders/targets` answers "where would this actually go?" without placing anything. It deliberately calls `quickOrderService._getTargetInstances` — the *same* resolver the execution path uses — rather than re-implementing the query. **A preview that can drift from the real target set is worse than no preview**, because it would state a blast radius confidently and be wrong.

Placement posts to the existing `POST /api/v1/quickorders` with `instanceId: 'ALL'` and a `request_id`, so sizing, product, risk and auto-exit all come from the watchlist symbol row, and a double-submit cannot double the position. Nothing about order construction is reimplemented in the chart.

Options symbols show no trade buttons: they need strike and expiry selection that the chart has no surface for, so it points at Watchlists rather than guessing a contract.

### Order sizing: lots vs quantity

The size field means different things by instrument class, matching how each is traded:

| class (`_determineMode`) | field | meaning |
| --- | --- | --- |
| `direct` (equity) | **Qty** | units |
| `futures`, `options` | **Lots** | each worth `lot_size` units |

**The two order paths disagree about their own units, and callers must convert at the boundary:**

- `POST /quickorders` — `quantity` is **LOTS** (`quick-order.service`: `baseLots = quantity`, then `tradeQuantity = tradeLots * lotSize`)
- `POST /orders` — `quantity` is **UNITS** (`order.service` applies only the instance multiplier; it never multiplies by lot size)

Sending the same figure to both differs by a factor of `lot_size`. On NATGASMINI (250) with an instance on multiplier 5, "1" was 1,250 units as a market order and 5 units as a limit. `dashboard-chart.js` now converts explicitly in `typedLots()` / `typedUnits()` — nothing should send a raw figure to either endpoint again.

**`instances.multiplier` is the existing "lots per instance" mechanism** and is applied by *both* paths. It is invisible from the order screen unless surfaced, so the chart shows the resolved size per instance before confirming: `1 lot × 250 × 5 (multiplier) = 1,250 units`.

**`_determineMode` checks `symbol_type` first.** It previously ran substring tests on the symbol name ahead of the explicit type, and `symbol.includes('CE')` matches RELIAN**CE** — so RELIANCE, CESC, CEATLTD, PEL, ACE, PERSISTENT and PETRONET were all classified `options`, and auto-exit read `*_points_options` for them while silently ignoring anything configured on the Direct tab. Name heuristics remain only as a fallback for rows with no `symbol_type`, and are anchored (`/\d(CE|PE)$/`, `/FUT$/`). Covered by `Test/unit/instrument-mode.test.js`.

### Background refresh policy

The dashboard shell runs a 15-second tick. It used to call `loadView(currentView)` — a **full re-render of whatever view was open**, which is why the app looked like it was reloading every few seconds. That behaviour predates every view growing its own updating mechanism, so by the time it was removed it was redundant everywhere and destructive in places: the chart tore down its candles, option panes and indicator sub-charts mid-interaction (leaving "Trade options" ticked with nothing beneath it), the API playground lost typed input, and settings lost unsaved edits.

The tick now consults `AUTO_REFRESH_VIEWS` in `dashboard-core.js` and touches only:

| view | how |
| --- | --- |
| instances | re-render (health status, no local state to lose) |
| notifications | re-render |
| orders | `loadOrders(..., { ensureView: false })` — data only, keeps the filter, scroll and expanded rows |

Every other view keeps itself current by other means: watchlists has an adaptive poller, positions is driven by WebSocket pushes plus a 60s snapshot resync, dashboard and trades have their own intervals, the chart refreshes its own candles, and strategies/audit/daily-P&L are static until acted on. Settings and the API playground are deliberately never auto-refreshed — they hold unsaved input.

**Anything added to that map must update data in place.** A full re-render on a timer is a page refresh in everything but name.

**Resuming** (unpausing, or returning to the tab after the visibility handler paused things) goes through `resumeBackgroundData()`, not `refreshCurrentView(true)`. The old path rebuilt whatever was open, so stepping away from the chart and back destroyed the candles, the option panes and every indicator sub-chart while leaving "Trade options" ticked with nothing beneath it. Resume now refreshes in place where it can (`RESUME_IN_PLACE`, which adds `chart: loadChartData` to the map above) and only falls back to a re-render for `watchlists`, `positions`, `trades` and `dashboard` — the views whose pollers are started by their own render, where skipping the rebuild would leave them silently frozen.

The tick itself is also now started at init. It previously only began after a tab switch, which is why the symptom appeared partway through a session rather than immediately.

### Option scalping layout & indicators

While "Trade options on this underlying" is on, the chart splits into three panes: the underlying, plus the resolved CE and PE. `GET /api/v1/history/option-legs` resolves those contracts from the instruments master against the live price. That is a **display** resolution — the strike each instance finally trades is resolved independently at execution and may differ if the underlying moves, which the confirmation states.

Indicators are computed in `public/js/chart-indicators.js` (pure functions, unit-tested) because Lightweight Charts ships none. Overlays (2× SMA, 3× EMA, VWAP) share the price scale; RSI and MACD cannot — their range is unrelated to price — so each renders in its own stacked sub-chart. Every period is editable (Settings on the indicator bar) and persisted to `localStorage` under `chart-indicator-config`, merged over the defaults so a release that adds an indicator does not invalidate a saved workspace. Bounds are enforced: an out-of-range period yields an empty series, which reads as "the indicator never switched on" rather than as a rejected value. MACD additionally refuses `fast >= slow`, which would otherwise draw a plausible line that means nothing.

**Zoom survives a reload.** `loadChartData` used to end in `fitContent()`, so every refetch threw away whatever the user had zoomed into — returning to the browser tab, coming back to the chart view, even toggling an indicator. The view is now captured before the data is replaced and restored after, as **bar spacing plus scroll position** rather than a visible range: those are independent of bar index, so appending live bars or refetching a slightly different window does not shift the view, and scroll position measured from the right edge keeps a live chart following the latest bar at the chosen zoom.

Two details that took a second pass. The view is filed under `exchange|symbol|timeframe` **as it was when the geometry was made** (`_activeViewKey`), not the current key — on a timeframe switch the state already names the new timeframe, so the old zoom would be saved under it. And a chart with no data yet is never captured, because rebuilding the chart would otherwise overwrite the saved zoom with the empty chart's defaults a moment before restoring from it. A symbol or timeframe seen for the first time still frames itself with `fitContent`.

**Live price** (`public/js/dashboard-chart-live.js`). Candles arrive from the history API in bulk; ticks arrive on the quote stream. `applyChartQuote` joins them — each tick folds into the bar it belongs to and a tick past the bar's end opens a new one, via `series.update()` rather than a refetch, so the price moves without flicker and without losing your zoom.

Three rules that are silent when wrong, and so are pinned by tests:

- **Buckets are computed in IST**, matching the history API's own day boundaries. A UTC-bucketed daily bar rolls over at 05:30 IST — mid-session for crypto.
- **A tick older than the last drawn bar is dropped.** A late or replayed message would otherwise rewrite a closed bar with a stale price.
- **A non-positive LTP is dropped.** Zero is what a broker returns for a contract it has no quote for; charting it draws a wick to zero and rescales the pane.

The stream is preferred; a 3-second REST poll of `/snapshots/quotes` is the fallback, checked per tick rather than at start-up because the socket can drop at any time and a chart that silently stops moving is the worst failure here. Only the underlying updates live — the stream carries the symbols the watchlists subscribe to, and the resolved CE/PE contracts are not among them, so the option panes hold their fetched history rather than showing an invented tick.

**Indicators advance with the price.** `refreshLiveIndicators()` recomputes each enabled indicator in full on every tick and pushes only the **last point**, via `series.update()`. The arithmetic is a few thousand operations and does not register; what makes a chart stutter is `setData` across a dozen series — and only the final bar can have changed anyway. The oscillator sub-charts expose a `recompute` hook for the same reason, and the shading primitives read their line data from a shared holder rather than closing over the arrays, so the fills reshade instead of freezing at load time.

**Index segments (`NSE_INDEX`, `BSE_INDEX`) were never subscribed on any WebSocket, ever.** Two compounding bugs in `market-calendar.service.js` and `openalgo-ws.service.js`, both found while chasing the NIFTY symptom above:

- `isExchangeOpen` matched a symbol's exchange **exactly** against the market-timings table, which answers for `NSE`, `BSE`, `NFO`, `BFO`, `MCX`, `BCD`, `CDS`, `NCO`, `CRYPTO` — never for an index segment. `NSE_INDEX`/`BSE_INDEX` therefore never found an entry and `isExchangeOpen` returned `false` **unconditionally**, at any time of day. `filterOpenSymbols` used that to build the WebSocket subscription list, so NIFTY and BANKNIFTY were silently excluded from every subscription, permanently — which is exactly why the cached quote could only ever get older. `CALENDAR_EXCHANGE_ALIASES` now maps each index segment onto the real exchange whose session governs it; the symbol itself keeps its real segment label everywhere else, only the *open-check* is aliased.
- Once that was fixed, a second bug surfaced: the WebSocket's round-robin symbol assignment had no concept of which **broker** a connection belonged to. With one crypto instance and one Indian-broker instance as the only two live connections, an Indian index had a coin-flip chance of being round-robined onto the crypto connection — which has no NSE session to subscribe to, so no quote for it ever arrives there. It still looked "subscribed" (`desired.add` succeeds regardless), so the failure was invisible until the cached snapshot's age was checked directly. `syncAll` now filters candidate connections by `isCryptoBroker`/`isCryptoExchange` compatibility (from the existing `broker-type.util.js`, already used for candle-fetch instance selection) before round-robining, per symbol-class bucket.

**A stale or malformed quote is never charted.** Two guards, because the failure was real and visible: NIFTY jumped from 23,955 to 25,665 in a single candle and then flat-lined.

- **Staleness.** Every instance's quote snapshot carries a `stale` flag from `/snapshots/quotes`, and the chart poll now honours it. It had not, so a broker snapshot cached in **January** was still being charted in **July** — 190 days old — and since every later poll returned that same frozen value, the line went flat after the gap. The WebSocket push path carries no such flag, so `applyChartQuote` independently rejects any quote whose own `timestamp`/`ltt` is more than six hours old. Deliberately not `ltpTs`, which is stamped on arrival and makes a six-month-old snapshot look new. The status line says so rather than freezing silently at a wrong price.
- **INT32 sentinels.** Broker feeds relayed through OpenAlgo send `2^31` for fields they have no value for, and prices are scaled by 100, so an unset price arrives as `21474836.48`. The NIFTY packet carried exactly that in open/high/low and `2^31` as volume. `sanitiseQuote` in the feed service strips them at ingestion — dropped rather than zeroed, since a missing high is honest and a high of 0 is a price that never traded — and discards the quote entirely when no usable last price remains. The chart refuses them again on its own side.

The generous six-hour window is intentional: an illiquid contract's last trade can legitimately be hours old while its price is still the right one to show. It exists to catch snapshots that are months stale, not to police normal quiet markets.

**Volume is a delta, not the counter.** Broker quotes report volume cumulatively for the session. Assigning it straight to the bar would give the live candle the whole day's volume and drag VWAP toward it, so the bar's volume is the increase since it opened. A counter that goes backwards (session rollover, feed reset) rebaselines rather than emitting a negative volume. Without a volume field the bar stays at zero and VWAP simply holds — correct for a volume-weighted average with nothing to weight by.

**Volume** follows the "Simple Volume" Pine indicator, as its own pane. Each bar is classified once and coloured: **blue** pocket pivot, **orange** dry, **green/red** above-average up/down, grey otherwise, with the average plotted as a yellow line. The pocket pivot is the point of the study - an up-volume bar that exceeds the **largest down-bar volume** in the lookback window, not merely the average, so above-average alone does not qualify. Lookback, average length and the dry divisor are all editable.

Two parts of the Pine original are deliberately not replicated: `request.footprint` order-flow delta needs a paid TradingView data feed with no equivalent here, and approximating it from close-vs-open would look identical while meaning something else; the rupee-turnover stats table depends on that same feed's turnover series.

**Shaded regions** (`public/js/chart-fills.js`). Lightweight Charts has no band or between-series fill, so both are series primitives (`attachPrimitive`, v5) drawn at `bottom` z-order so the lines stay legible over their own shading:

- `ZoneFill` — the RSI's overbought and oversold regions. Levels are configurable (default 70/30) and read at draw time, so editing one reshades without rebuilding the pane. The shading runs to the pane edges rather than stopping at the highest plotted value: the point is to mark the whole region.
- `BandFill` — the signed area between two lines, green where the first is above the second and red where it is below. Used for RSI vs its MA and MACD vs its signal. Points are paired **by timestamp**, not by index: the two lines have different warm-up lengths, so index-aligning them shears the fill sideways by however many bars they differ. Runs are flushed as one polygon per crossover rather than a quad per bar.

`os < ob` is enforced for the same reason `fast < slow` is on MACD — inverted bands shade the wrong regions and read as a permanently overbought instrument.

**Candlestick patterns** (`public/js/chart-patterns.js`). 44 classical patterns as pure functions over candles, rendered as markers via `createSeriesMarkers`. Each is independently toggleable with its own marker colour and placement (`chart-patterns` in localStorage), defaulting to green-below for bullish and red-above for bearish.

**Markers carry a short code, not the name.** "Bearish Engulfing" is wider than a dozen candles, so at any real bar density the labels overrun each other and the chart becomes unreadable. Every pattern has a 3-4 character code (`HMR`, `SHS`, `MBW`, `ENG+`/`ENG-`), with the trailing `+`/`-` used only where a bullish and bearish twin would otherwise collide - colour alone is not enough to tell them apart on a dense chart. The codes are asserted unique and short by test, and the pattern picker shows each code beside its full name so the list doubles as the key.

This is the most silent code on the chart — a mislabelled Hammer still draws a tidy marker and reads as a signal — so every rule is pinned by a test against a hand-built candle, including the near-misses that must *not* fire. Two design notes:

- **Everything is measured relative to recent bars**, never absolutely. 20 points is a large NIFTY candle and noise on BTC, so "long body" and "short body" are judged against the mean range of the preceding 10 bars.
- **Trend context is required** where the classical definition demands it. Hammer and Hanging Man are the *same shape*; only the preceding move separates them, and without that check a Hammer gets flagged at the top of a rally. Trend is approximated by the slope of the preceding 5 closes — a heuristic, not market structure, but enough for the failure that matters.

One rule was corrected during implementation: the "little or no opposite shadow" condition has to be measured against the bar's **range**, not its body. Against the body it is unsatisfiable for exactly the small-bodied hammers that matter most — a 0.2 body would demand an upper shadow under 0.1.

### The WebSocket gateway was permanently unauthenticated

The navbar's feed pill read "Disconnected" essentially always, not intermittently. `ws-gateway.service.js`'s connection-upgrade auth checked an **express-session cookie** (`connect.sid`) — but `configureSession()` sets `saveUninitialized: false`, and a full search of `src/routes/` and `src/middleware/` turns up **zero** places that ever write to `req.session`. The app is JWT-only (`Authorization: Bearer`, verified in `optionalAuth`); nothing anywhere ever caused that cookie to be issued. Every WS connection was rejected at the handshake, every time — the client's exponential-backoff retry loop just kept failing identically.

Fixed by authenticating the WS upgrade with the **same JWT** every REST request already uses (`verifyLocalToken` in `middleware/auth.js`, reusing `config.auth.jwtSecret`). Since a browser `WebSocket` cannot set a custom `Authorization` header on the upgrade request, the token travels as a `?token=` query parameter instead — the gateway's `tokenValidator` signature already accepted a token argument for exactly this, it had simply been wired to ignore it in favour of the (nonexistent) cookie. The now-dead cookie-lookup code (`getWsSessionStore`, `parseCookies`, `validateWsSessionFromRequest`, the `connect-sqlite3`/`cookie-signature` imports) was removed rather than left alongside the working path.

Verified live: the socket reaches `readyState: 1` and stays there, and 74 `quotes:update` messages plus `positions:update`/`funds:update` were observed flowing over it in 15 seconds — confirming the gateway now genuinely streams, not just connects.

One narrower gap noted but left alone (out of scope for the reported symptom): the feed pill's label advances from "Connecting" to "Live" via `markDataReceived`, which only fires when a streamed quote's symbol matches a row in the currently loaded watchlist — so the pill can under-report freshness on a view that isn't watching any of the symbols actively streaming, even though the connection and the data are both fine.

### OpenAlgo contract-correctness fixes

An audit against the real OpenAlgo REST/WS contract (cross-checked against the skill's reference docs and the user's own captured request/response shapes) found four issues, all fixed:

- **REST depth silently returned null bid/ask.** `_extractBestBidAskFromDepth` (market-data-feed.service.js) only recognised the WebSocket depth shape (`data.depth.buy[]`/`sell[]`). The REST `/depth` endpoint returns a *different* shape (`data.bids[]`/`data.asks[]`) - a documented OpenAlgo gotcha. Every REST-depth fallback (WS depth unavailable or too slow) computed `bid=null, ask=null` even though the broker returned real numbers, silently degrading `limit-price.service.js`'s marketable-LIMIT synthesis to a worse, plain-quote-derived price. Both shapes are now recognised.

- **Every order used the wrong rate-limit bucket.** Every order this app places - quick-orders, chart orders, retries - routes through `placesmartorder`, never plain `placeorder`. OpenAlgo caps `placesmartorder` at 2 req/sec, a fifth of `placeorder`'s 10/sec, but `client.js` applied one shared limit (10) to both. `_throttle` now picks the applicable limit by endpoint name; the stricter figure is its own setting (`rate_limits.smart_orders_per_second`, migration 061) so it can be tuned independently of the (currently unused) plain-order limit.

- **No WebSocket heartbeat handling.** `_onMessage` recognised exactly three message types and silently ignored everything else. OpenAlgo's docs state the server pings every 30s and expects a pong. Native protocol-level pings are answered automatically by the `ws` library; this only closes the gap if OpenAlgo instead sends an application-level JSON ping (common for WS services proxied through a subdomain, which is exactly how every instance here is deployed) - answered via `pingReplyFor()`, extracted as a pure function so it's unit-testable without opening a real socket.

- **Stale rate-limit reference data.** `endpoints.js`'s `RATE_LIMITS.placesmartorder` documented `10`, matching the bug above rather than OpenAlgo's actual cap. Corrected to `2`; the file is unread by the enforcement code, but a wrong number in a file titled "rate limits" is its own kind of bug.

### Buyer/Writer mode on the chart

CE/PE tickets used to be a flat BUY_CE/SELL_CE/BUY_PE/SELL_PE row, and both BUY and SELL always resolved a **fresh ATM strike** at click time. That is the exact bug reported: clicking BUY PE and later SELL PE on the same leg opened two different strikes, because the underlying had ticked between the two clicks and ATM drifted with it — there was no notion of "act on what's already open."

The chart now carries the same **Buyer/Writer** model as the watchlist (`quick-order-controls.js`), reusing its action set and CSS classes verbatim (`.btn-buy-ce`, `.btn-reduce-ce`, `.btn-close-all-ce`, `trading-controls.css`) rather than inventing parallel ones:

| mode | CE column | PE column |
| --- | --- | --- |
| Buyer (default) | BUY_CE → REDUCE_CE → CLOSE_ALL_CE | BUY_PE → REDUCE_PE → CLOSE_ALL_PE |
| Writer | SELL_CE → INCREASE_CE → CLOSE_ALL_CE | SELL_PE → INCREASE_PE → CLOSE_ALL_PE |

Only `BUY_*`/`SELL_*` open a position at a freshly resolved strike. `REDUCE_*`/`INCREASE_*`/`CLOSE_ALL_*` are the same actions the watchlist already sends to `quick-order.service.js`, which — in `FLOAT_OFS` mode — resolves them **per-instance against the actual open position** rather than a new ATM strike (`shouldSkipPreResolution` in `_placeOptionOrder`). That is what actually fixes the mismatch: closing or reducing a leg now targets the strike that is really open, not wherever ATM happens to be at the moment of the click.

A **Flow** toggle (Buyer/Writer) and a **Policy** select (Float / Anchor) sit in the Options popover next to the strike-leg and expiry controls, mirroring the watchlist's controls. `operatingMode` and `strikePolicy` travel with every options order to `/quickorders`, same as the watchlist sends them.

### Chart toolbar

The chart header was six stacked rows - toolbar, options, instance picker, mode hint, legend, indicators - roughly 300px of chrome before the first candle. It is now **one 41px row**, with the chart starting 53px below the top of the view.

What moved where, and why:

| was a row | now |
| --- | --- |
| Legend (OHLC/LTP) | overlays the canvas top-left, as on every charting terminal |
| Instance picker + mode hint | **Send to** popover; the button carries the instance count and a **LIVE** badge |
| Options toggle + strike/expiry | **Options** popover; the button reads `Options ON` and highlights when engaged |
| Indicator bar, settings, pattern picker, sync bar | **Indicators** popover; the button carries the count of enabled indicators |

The rule applied: anything that is not a per-trade decision goes behind a popover, but **nothing that was on screen may simply disappear**. The counts and the LIVE badge exist so the information those rows carried is still visible without opening anything. One popover is open at a time; a click inside does not close it (the panels are interactive), a click outside or Escape does.

The sizing hint shows the **outcome** inline (`→ 1,250 units`) with the full arithmetic (`1 lot = 250 units · Jz Fyers ×5 → 1,250`) in the tooltip and the Send-to panel. Truncating the full string with an ellipsis would leave a half-read quantity on screen, which is worse than a short complete one.

### Drawing tools

Lightweight Charts ships none — the toolbar people recognise belongs to TradingView's **Advanced Charts**, a separate licensed product that cannot be imported here. The engine is [`lightweight-charts-drawing`](https://github.com/deepentropy/lightweight-charts-drawing) (MIT, vendored as a self-contained UMD build, peers on lightweight-charts ^5): **67 tools** across lines, shapes, Fibonacci, channels, pitchforks, Gann, forecasting, measurement and annotation. It owns rendering, hit testing, anchor dragging and serialisation.

**The palette is restricted to 18 tools**, not the engine's 67 (`DRAW_ALLOWED` in the adapter): trend line, ray, horizontal/vertical/cross line, parallel channel, Fib retracement and extension, long and short position, price range, rectangle, date range, date-and-price range, text annotation, callout, note and comment. A wall of pitchforks and Gann squares buries the handful that matter, and every tool on the rail is one that has been verified end to end — armed through the rail and flyout, drawn with real pointer input, then checked for valid geometry, finite anchors, a pane view, a clean return to Select, and survival of a full chart rebuild. Categories with nothing left in them drop off the rail entirely.

A drawing saved earlier under a tool that is no longer listed still **restores**; it simply cannot be created again. Silently deleting someone's marked-up chart because the palette shrank would be worse than showing a shape they can no longer draw.

The UI is a **vertical icon rail** to the left of the canvas, as on every charting terminal: one button per category (plus Select at the top and Lock / Hide / Clear below a divider), each opening a flyout listing that category's tools with their anchor counts. Icons are inline SVG on a 24x24 grid using `currentColor` — the app serves no external assets, and an active state then needs no second asset. The rail is a flex sibling of the chart rather than an overlay, so it never covers a candle; the floating BUY/SELL tickets are offset past it.

`public/js/dashboard-chart-draw.js` is the adapter, and it carries one thing the engine does not: **creation**. At 0.1.1 `DrawingManager.handleClick` only ever *selects* — with a tool active it does nothing, and the README constructs drawings by hand. So anchor capture is implemented here, supporting both gestures people expect: press-drag-release for a quick two-point shape, and click-click-click for tools needing three or more anchors where dragging is impossible. A half-placed shape tracks the pointer via `updateAnchor`, so it reads as a shape rather than a dot.

Drawings are stored per instrument (`chart-draw:{exchange}:{symbol}` in localStorage) via the engine's own `exportDrawings`/`importDrawings`, saved on every change event rather than at guessed moments. A shape whose tool is unknown to the current build is skipped on restore rather than aborting the whole set — losing one shape beats losing the lot.

**Trading in options mode.** The CE/PE tickets fan out at market with a strike resolved per instance. Everything else on screen remains tradeable alongside them:

- **The underlying**, by right-clicking the main chart. Options mode used to block this outright, which was wrong: a futures contract used as an option underlying is exactly the thing people hedge on. It is blocked only when the underlying genuinely cannot be traded (an index), which `chartTradeBlocked` already covers.
- **A specific leg**, by right-clicking its own CE/PE pane - LIMIT and SL-M only, on that exact contract, on every selected instance. Market on options belongs to the tickets, which resolve a strike per instance; picking a price on a leg's chart means the opposite, so it goes to `/orders` with the symbol named outright. `symbolId` is omitted (the contract is not a watchlist row) and `watchlistId` comes from the underlying, since `watchlist_orders.watchlist_id` is NOT NULL.

Sizing takes a `forOptions` flag throughout (`sizingUnit`, `lotSize`, `typedLots`, `typedUnits`, `sizingBreakdown`) plus an explicit lot-size override for a named contract. Without it, a futures order placed while options mode was on would have been sized with the **option's** lot size.

**A horizontal line doubles as an order ticket.** It is the only shape naming a single unambiguous price, so right-clicking one opens the chart's ordinary limit/stop menu at that price, routed through `contextMenuItemsFor` + `confirmChartOrder`. That is deliberate reuse rather than a parallel path: a line-placed order gets the same validity rules (a buy limit must sit below the last price), the same lot sizing and the same blast-radius confirmation as any other order on this screen. Right-clicking anywhere else falls through to the chart's own menu. Nothing in the drawing layer places an order by itself, and while "Trade options on this underlying" is on the menu refuses outright, since options fan out at market there and a resting price would be meaningless.

The engine is young (0.1.1), so it is treated strictly as presentation: `attach` and `restore` are guarded, and a failure logs and leaves the chart and the order path untouched.

### Chart fits the viewport

The container height used to be the literal **sum** of every pane's preferred height (price pane + each oscillator + separators), which overflowed the screen the moment two or three indicators were on — RSI and MACD ended up below the fold, reachable only by scrolling the whole page.

Since panes are allocated by **stretch factor** (a ratio, not a pixel count — see below), the container's actual pixel height can be anything; the proportions between panes, and a user's own dragged sizes, are preserved regardless. `chartBudgetHeight()` measures `window.innerHeight - container.getBoundingClientRect().top`, so the container is capped to whatever the viewport actually has room for. A 48px bottom margin accounts for the Apache-2.0 attribution line required below the chart plus the flex gap in front of it — found by measuring the actual overflow (`scrollHeight - innerHeight`) rather than guessed, and closed to zero exactly.

A debounced `window resize` listener (bound once, survives every chart rebuild) reapplies the budget so a resized or restored browser window keeps the fit.

**Oscillators are panes of the price chart** (Lightweight Charts **v5.2.0**), not separate charts beneath it.

They were separate charts kept in step by copying bar spacing and scroll position. That never held. Every price-scale relayout made a pane re-fit to its own data and discard the copied geometry, so RSI and MACD drifted out of line with the candles on every zoom — measured at 235–334px at trading zoom. Worse, the equaliser meant to fix it (resetting and re-applying `minimumWidth` each sync) was itself the trigger: with it, bar spacing was 26.12 on the price chart against 32.05 on both oscillators; with it applied once, 26.12 everywhere.

Panes share **one time scale**, so alignment is structural — there is nothing left to drift. Pane 0 is price; enabled oscillators take 1..n via `chart.addSeries(type, options, paneIndex)`.

**Pane heights use stretch factors, not pixels.** `setHeight` redistributes whatever is left between the other panes, so with more than one oscillator no ordering of calls lands them all on the requested number — the pane assigned last wins and the rest are squeezed (an RSI pane at 35px next to a 363px price pane, in one measured run). `IPaneApi.setStretchFactor` is the API meant for this and gives an exact, stable split: requesting 520/150/150 yields exactly `[520, 150, 150]`. It was added after v5.0.0, which is why the library was upgraded; a `try/catch` falls back to pixel heights on an older build.

Pane separators are draggable natively, so the hand-rolled resize grips were removed. Heights are read back off the separators on teardown only — capturing them mid-rebuild saved transient squeezed values and fed them back as the next saved heights, which made the panes shrink run over run.

**Sync in layout** (`public/js/dashboard-chart-sync.js`). Lightweight Charts has no linked-layout concept — each `createChart()` is an island — so every pane is wired by hand and re-wired whenever the live chart set changes. Handles are tracked and detached on rebuild; subscriptions left attached to a removed chart throw inside the library's own event loop and surface as a chart that silently stops updating. Four independent toggles:

| toggle | effect |
| --- | --- |
| Interval | panes share the toolbar timeframe. Off, each option pane gets its own selector — useful for reading the underlying on 15m while scalping the option on 1m. |
| Crosshair | hovering one pane marks the same bar on the others, each at **its own** price for that bar. A bar a pane does not have clears rather than snapping to a neighbour. |
| Time | shared *logical* range — scroll and zoom by bar index. |
| Date range | shared *time* range — align by timestamp. This is the one that matters across contracts: an illiquid strike has far fewer bars than its underlying, so bar-index alignment puts them at different dates. Wins when both are on. |

**Only the chart under the pointer drives the layout.** A synchronous re-entrancy flag does not work here: applying a range to a pane makes that pane emit its own (clamped) range a frame *later*, after the flag has cleared, which is then pushed back onto the chart being dragged — the view snaps back and zooming is impossible. Ownership is claimed on `pointerenter`/`pointerdown` instead, and echoes from panes the user is not touching are dropped.

Only the CE/PE option panes remain separate charts, so they are all the sync layer still has to manage - and they share **zoom only, never position**. They sit on the same clock but not the same bars, and their history routinely ends earlier than the underlying's. Forcing a shared position (by visible range, or by matching right edges in time) scrolled the legs hundreds of bars past their own data and dragged the underlying's padding to -1 whenever a leg was the one being zoomed. Copying bar spacing alone keeps every pane at the same zoom while each keeps its own latest bar and its own right-hand gap.

Sync targets are resolved **inside** each handler rather than captured when it was wired: the option panes are rebuilt whenever the leg or expiry changes, and a captured array goes stale, so every call lands on a disposed chart and is swallowed - the symptom being a zoom that silently stops propagating.

Charts keep `rightOffset: 8` bars of space after the live bar; `fitContent()` ignores `rightOffset`, so the gap is scrolled in explicitly after every data load. Oscillator panels are drag-resizable (80–600px, persisted per indicator under `chart-osc-heights`); the charts are `autoSize`, so setting the container height is the whole implementation.

Two details worth keeping: VWAP **resets each IST day** (a multi-day cumulative VWAP is not a level anyone trades against), and RSI returns **50, not 100**, on a perfectly flat series — a bare `loss === 0` guard paints an unmoving illiquid strike as maximally overbought.

### Cross-segment underlying resolution (`utils/underlying.util.js`)

Options work across NFO, BFO, MCX and CRYPTO, and **no single rule maps a symbol to the key its options are filed under**:

| symbol | `instruments.underlying_key` | options filed under |
| --- | --- | --- |
| BANKNIFTY (index) | `BANKNIFTY` | BANKNIFTY |
| NATGASMINI28JUL26FUT (MCX) | `NATGASMINI` | NATGASMINI |
| BTCUSDFUT (crypto perpetual) | `BTCUSDFUT` | **BTC** |

A crypto perpetual is its own `underlying_key`, so following that column lands on a key with no options. The watchlist row's `underlying_symbol` holds `BTC` there — but on MCX the same column holds a display name with spaces (`"NATGASMINI 28 Jul 26 FUT"`). `resolveOptionsUnderlyingKey` therefore tries each candidate and returns the first that **actually has CE/PE rows**, rather than trusting one source. It fails to null rather than to a wrong key.

**Expiry formats differ by exchange**: `DD-MMM-YY` on NFO/BFO/MCX/CDS, `YYYY-MM-DD` on CRYPTO, and absent on perpetuals. Both parse through `parseExpiry`, which round-trips the components — `Date.UTC(2026, 12, 40)` silently rolls over to 2027-02-09, so an out-of-range feed value would otherwise resolve to a real-looking expiry and select the wrong contracts.

Option lot size comes from the instruments master, never the watchlist row: an index row is `lot_size 1` (correct — an index is not tradeable) while its options trade at 30/65/20. Verified as a single consistent value per underlying across all four segments; `resolveOptionLotSize` returns null on ambiguity so the UI shows no unit figure rather than a wrong one.

### Chart-native order entry

The chart carries a full order surface: an OHLC/LTP legend, a product toggle (MIS/CNC/NRML), an inline quantity, floating BUY/SELL tickets over the canvas, and a right-click context menu.

**The context menu is price-aware.** Right-clicking at a price offers only the order types that are valid *at* that price, because that is what the types mean:

| | valid when |
| --- | --- |
| Buy Limit | below LTP (buy cheaper than market) |
| Buy Stop | above LTP (buy a breakout) |
| Sell Limit | above LTP (sell dearer than market) |
| Sell Stop | below LTP (protective exit) |

Invalid combinations are shown **disabled with the reason**, not hidden — the operator learns the rule rather than wondering where the option went. Offering them would submit orders every broker rejects.

**`order.service.placeOrder` honours a caller-specified resting order.** Everything else in that function exists to *choose* a price type for the caller — MARKET where the broker supports it, otherwise a marketable LIMIT synthesised from live quote + buffer. That is correct for "fill this now" callers (quick orders, auto-exit, retries), which is all the route previously had. It is catastrophic for a caller that picked a price: a chart right-click of "Buy Limit @ 64,190.76" was being rewritten to `pricetype: MARKET, price: 0` and executing immediately. The `callerChosePrice` guard now short-circuits that override when `pricetype` is LIMIT/SL/SL-M **and** a price or trigger is supplied. Do not remove it.

**`position_size` is a SIGNED net target**, not a magnitude — negative means net short, exactly as `quick-order.service._computeTarget()` produces and passes to the same broker endpoint. The old `< 0` rejection in `_normalizeOrderData` made it impossible to open a short through this route.

**Routing differs by order type, and must.**

- **MARKET → `POST /api/v1/quickorders`.** Fans out to the watchlist's instances and keeps every per-symbol guardrail: margin sizing, product resolution, auto-exit registration.
- **LIMIT / SL-M → `POST /api/v1/orders`, once per target instance.** Quick-order derives its price type from the *instance* and computes any limit price itself from live quote + buffer — there is no path there for a caller-supplied price, and the entire point of clicking a price on a chart is that the operator chose it. The manual order route accepts explicit `pricetype`, `price` and `trigger_price`, so limit/stop fan out explicitly with a per-instance idempotency key (`<stamp>-<instanceId>`).

A stop sends its price in `trigger_price` with `price: 0`; a limit sends `price` with `trigger_price: 0`. Getting that backwards is silently accepted by some brokers and rejected by others.

Limit and stop orders **rest at the broker** — unlike the exit levels below, which are monitored server-side. The confirmation says so explicitly, because it is the difference between an order that survives a restart of this app and one that does not.

### Exit levels on the chart

Dragging a stop or target line **does not place anything with a broker.** It edits the per-symbol risk config in `watchlist_symbols` that `auto-exit.service` already monitors through `risk-controls.service` — the mechanism actually in use here (every existing strategy leg is `POLLING`; none are `GTT`).

This was a deliberate choice over creating broker-side GTTs. Under fan-out a dragged line would otherwise become N resting triggers at N brokers that can partially fill, partially cancel and silently diverge from each other and from your config, with no reconciliation path. Editing config instead means **one line = one config value**, applied by a service that already handles multiple instances.

Levels are stored as **points relative to entry**, because that is how `risk-controls` consumes them:

```
targetPrice = entry + direction * targetPoints
stopPrice   = entry - direction * stoplossPoints
```

The chart applies the exact inverse. Keeping one formula on both sides is the point — a line rendered where the monitor would not act is worse than no line. Round-trip is verified for long and short in `Test/unit/`.

`mode` (`direct` / `futures` / `options`) comes from `riskControlsService._determineMode`, the same function auto-exit uses, and the resolved **column names are echoed in the response** so the client writes exactly the columns the server resolved. The chart never re-derives the mode from its own trade mode: the server decides from symbol name and type, and a client that guessed differently would write to columns nothing reads. (`SENSEX` resolves to `futures` via `symbol_type = INDEX`, not to the chart's `EQUITY`.)

Lines only appear when a position is open — target and stop are defined relative to an entry price, and without one there is nothing truthful to draw. The confirmation states plainly that this is **symbol-level** config: it changes the rule for every future position on that symbol, not just the open one. That is a different mental model from a single-instance terminal, where a dragged line belongs to one position.

**One registry owns every price line.** `_priceLines` records each line on the current series and `redrawChartLines()` is the only thing that draws. Position and levels share a series, so per-feature clear/draw pairs raced: a reassigned handle map orphaned lines that then stayed on the chart permanently with no handle left to remove them. Never create a price line outside `addPriceLine()`.

### API
- `GET /api/v1/history?exchange&symbol&timeframe&from&to` — candles; `from`/`to` are unix seconds. Response carries `stale` and `source`.
- `GET /api/v1/history/timeframes?exchange` — timeframes the serving broker supports.
- `GET /api/v1/history/symbols` — chartable (and therefore tradeable) symbols.
- `GET /api/v1/positions/symbol?exchange&symbol` — one symbol's position, aggregated + per-instance legs (`pages.positions.view`).
- `GET /api/v1/quickorders/targets?symbolId` — the instances an order would reach, without placing it (`orders.place`).
- `GET /api/v1/history/levels?symbolId` — the symbol's target/stop/trailing points, the resolved mode, and the column names to write back to. Writes go to the existing `PUT /api/v1/watchlists/:id/symbols/:symbolId`.

All three require `pages.watchlists.view`; no new permission key was introduced, so existing roles work unchanged.

## 11) Frontend Architecture

### 11.0 Design Tokens & Styling Rules
There are two stylesheet bundles that share almost nothing: the dashboard (`tokens-base.css` plus the feature sheets) and the standalone pages that load only `landing.css` (`index.html`, `login.html`, `access-pending.html`). Anything that must not drift between them lives in its own file, imported by both.

- **`css/type-scale.css` is the only place a font-size may be defined.** Eleven steps, `--font-size-3xs` (10px) through `--font-size-5xl` (48px), every one a whole pixel at the 16px root. Stylesheets reference `var(--font-size-*)` and never inline a raw value; when the ladder was incomplete, raw values proliferated and splintered into near-duplicates (11px / 11.008px / 11.2px coexisted, as did 9.6 / 10 / 10.4). 10px is a hard floor. If you need a size that isn't there, add a step.
- **`css/fonts.css` self-hosts the webfonts** (Outfit, JetBrains Mono; latin subset, `font-display: swap`). Nothing may reference `fonts.googleapis.com` — a third-party host on the critical path delays first paint of the whole terminal, and an `@import` to one is worse still, since it blocks before it even begins fetching.
- **Colour is theme-specific, and both themes are checked against WCAG AA (4.5:1).** Do not assume a value that passes on `#0A0A0B` also passes on `#FFFFFF`. `--color-profit` / `--color-loss` are the most-read values in the product and carry separate light/dark tonal variants for exactly this reason. `--color-primary` is a *fill* that carries `--color-primary-content` text, so it is the darker `#D93A15` rather than the `#FF5733` signal orange (white on `#FF5733` is 3.15:1); `#FF5733` survives as `--color-accent`, used as text/border on dark surfaces.
- **Never convey state by colour alone.** Change % carries a `+`/`-` sign, the feed pill states its condition in words, badges carry text.
- **Numeric columns use `.font-mono`** (JetBrains Mono) with `font-variant-numeric: tabular-nums`, so digits stay column-aligned as values tick and prices don't reflow their column.

DaisyUI note: `tailwind.config.js` declares a custom `simplifyed` theme, but the built `tailwind.css` contains DaisyUI's stock `dark`/`light` — the config and the artifact are out of sync, and the app's real appearance comes from the hand-rolled variables in `tokens-base.css`. **Rebuilding `tailwind.css` with the current config would drop the `dark`/`light` themes the app actually uses.** Reconcile the config before running `npm run build:css`.

### 11.1 Pages
- `public/index.html`: marketing/landing page, links to `/login.html`.
- `public/login.html`: login screen (local email/password, see §4.1).
- `public/access-pending.html`: shown to authenticated users with no role assigned yet (`ACCESS_PENDING`, see `requireAuth` in §4.2).
- `public/dashboard.html`: main app shell.
- Settings is a tab within the dashboard shell, not a separate page (rendered via `settings-*.js`).

### 11.2 Frontend JS Modules
No bundler - plain `<script defer>` tags loading small, feature-scoped files (naming convention: `<area>-<concern>.js`). All 33 carry `defer`, so they download in parallel and execute in document order; the code already assumes that ordering. The one inline script in `<head>` is deliberately *not* deferred — it applies the stored theme before the stylesheets parse, which is what keeps a light-mode user from seeing a dark repaint on every load.
- `dashboard-core.js` + `dashboard-init.js`: app state, view switching, bootstrap. Also owns the navbar **feed-status pill** (`resolveFeedState`), which reports the market-data feed as Live / Polling / Stale Ns / Paused / Disconnected / Connecting. Freshness comes from `markDataReceived()`, called from the quote-meta choke point in `dashboard-watchlists-quotes.js` so every feed path — WS push and REST poll alike — advances the same clock.
- `dashboard-instances.js`, `dashboard-orders.js`, `dashboard-positions.js`, `dashboard-trades.js`, `dashboard-pnl.js`, `dashboard-overview.js`, `dashboard-notifications.js`, `dashboard-playground.js`: one file per dashboard section.
- `dashboard-watchlists-core.js`, `-crud.js`, `-modals.js`, `-positions.js`, `-quotes.js`: watchlist view, split by concern.
- `quick-order-core.js` + `quick-order-init.js`, `-controls.js`, `-expansion.js`, `-instruments.js`, `-option-chain.js`, `-place.js`, `-preview.js`, `-selectors.js`: watchlist row expansion and trade controls (see §7.2-7.4).
- `settings-core.js` + `-init.js`, `-data.js`, `-general.js`, `-rbac.js`, `-status.js`: settings UI, RBAC admin, import/export.
- `settings-schema.js`: renders the General tab from `GET /api/v1/settings/schema` (groups, sections, paired fields, live unit hints). Replaced the hardcoded category lists that used to decide what the screen showed.
- `strategy-builder.js`: multi-leg strategy CRUD/execution UI (see §7.10).
- `dashboard-chart.js`: chart view (see §10.5). Disposes its chart instance on navigation away — `createChart` attaches a ResizeObserver and canvas that outlive the `innerHTML` swap otherwise.
- `api-client.js`: API wrapper for all endpoints, attaches the Bearer token from `localStorage` and clears it on a 401.
- `utils.js`: formatting/UI helpers.

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
- **public-config**: unauthenticated WS-gateway and feed-timing config for the frontend bootstrap. Deliberately carries nothing sensitive; the TradingView webhook token is served separately by **webhook-config**, behind `settings.manage`.

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
