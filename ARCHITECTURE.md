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
- `backend/scripts/*`: test-database builder, password reset CLI, chart vendoring.

## 3) Runtime Architecture

### 3.1 Server Bootstrap
- **Entry**: `backend/server.js` creates an Express app, applies middleware, and mounts routes.
- **Environment**: Forces timezone to IST for consistent timestamps.
- **Sessions**: none server-side - authentication is a stateless JWT (see §4.1).
- **Config**: Loads environment + DB settings via `core/config.js`.

### 3.2 Middleware Pipeline
Order of major middleware:
1. Security headers (Helmet).
2. CORS (configured by settings).
3. Compression.
4. JSON/body parsing (with size limits).
5. Correlation ID and request logging.
6. Optional auth (local Bearer JWT / test-mode).
7. Instruments refresh background check.
8. Audit logger for API write operations.
9. API routes.
10. Error handling and 404 fallback.

### 3.3 Background Services Lifecycle
The server starts background services after a successful login/signup or during `optionalAuth` if an authenticated session exists:
- `MarketDataFeedService`: central quote/position/funds cache, multi-quote batching, WS integration.
- `PollingService`: periodic instance polling (P&L, orders, health status).
- `AutoExitService`: monitoring-based auto-exit logic for targets, stops, trailing stops.
- `TelegramService`: order notifications and summaries.
- `InstanceHealthService`: cron-based endpoint capability checks.

## 4) Authentication & Authorization

### 4.1 Auth Methods
All methods issue/verify a Bearer JWT checked in `middleware/auth.js`'s `optionalAuth`; there is no server-side session.
- **Local email/password** (the only user-facing method): `POST /api/v1/auth/register` (bootstrap-only - closes once any user exists), `/login`, `/change-password`. Tokens are HS256, signed with `config.auth.jwtSecret` (env `JWT_SECRET`), 7-day expiry. Passwords are bcrypt hashes (cost 10); `attachRoleAndPermissions` deliberately never selects `password_hash`, since its return value becomes `req.user` and is serialized into API responses.
- **Test mode**: `ENABLE_TEST_MODE=true` bypasses auth entirely with a hardcoded admin user - never enable in production.
- Accounts after the first are created by an admin (Settings → Access Control, `rbac.service.js`), not by self-service signup. `scripts/set-user-password.js` is the CLI escape hatch for a lost password; it has no HTTP route.
- The WebSocket gateway authenticates with the same JWT, sent as a `token` query parameter (a browser cannot set headers on a WebSocket upgrade).

### 4.2 RBAC
- Roles, permissions, and user-role assignments are stored in DB.
- `middleware/auth.js` attaches user + permissions to the request.
- `requirePermission` checks are used on most routes.

### 4.3 Audit Logging
- Writes to `audit_logs` for mutating requests, including quick orders, instance changes and every TradingView webhook call (the one order path with no logged-in user).
- There is no Audit Logs page or `/api/v1/audit` route any more (removed 2026-09-29 as noise for operators); the table is for after-the-fact investigation straight from the database.
- Rows older than 7 days are deleted at startup and every 6 hours (`server.js`).

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
- **watchlist_options_state**: aggregate options positions by watchlist/symbol/expiry/strike.
- **quick_orders**: storage for quick-order requests and responses.

### Market Data & Instruments
- **quote_snapshots**: per-instance quote snapshots with dedupe hashes.
- **instruments**: cached instrument master.
- **instruments_refresh_log**: import history.
- **symbol_cache**: symbol lookup optimization.
- **expiry_calendar**: expiry utilities.

### Strategies & GTT
- **strategies**: named multi-leg strategy scoped to a watchlist, optional `webhook_slug` for TradingView-style triggering, `entry_trigger` (MANUAL/webhook).
- **strategy_legs**: per-leg config (option_type, action, strike_policy/offset, qty, product, target/stoploss/trailing points, `exit_mechanism`).
- **strategy_leg_executions**: one row per leg per instance execution - resolved symbol, entry/exit order IDs and status/prices, `opened_at`/`closed_at`.
- **gtt_orders**: GTT-style trigger records placed for leg exits (see 7.x below), linked to `strategy_legs` via `strategy_leg_id`.

### Risk & Monitoring
- **trailing_state**: trailing stop-loss state across instances and symbols.
- **risk_events**: audit trail of risk-control actions (target/stop/trailing hits) with previous/new values.
- **daily_instance_pnl_snapshots**: daily P&L snapshots.
- **notifications**: system and health notifications.
- **telegram_subscribers**: Telegram link state per user.

### Settings & Access
- **application_settings**: settings by category, data type, description, sensitive flag.
- **roles / permissions / role_permissions / user_roles**: RBAC model.
- **audit_logs**: request audit trail (write-only; for investigation from the database).

Migration 065 dropped the tables nothing used: `analyzer_trades`, `market_data`, `market_holidays`, `options_cache`, `order_monitor_log`, `symbol_search_cache`, `system_alerts`, `telegram_message_log`, `user_telegram_config`, `watchlist_positions`, `websocket_sessions`.
- **idempotency_keys**: request replay protection for orders.

## 6) Core Services (Responsibilities)

### 6.1 Config & Settings
- `core/config.js`: environment values, the fixed timing/rate tuning, and the few Settings rows it holds (broker timeout, rotated webhook token).
- `services/settings.service.js`: CRUD over `application_settings`, type validation, defaults, change events.
- **`config/settings-registry.js`: the single source of truth for what may be changed at runtime.**

**A setting is editable only if it appears in the registry.** `updateSetting()` rejects everything else, and `GET /api/v1/settings/schema` serves the registry (grouped, labelled, with current values) to the Settings screen. Adding a setting to the registry is the only step needed to surface it — there is no second list to keep in sync.

This is enforced server-side on purpose. The allowlist used to live only in `settings-core.js`, so it filtered *display* while the API still accepted a `PUT` to any key in the table. That included `test_mode.enabled`, which switches `optionalAuth` to a hardcoded admin identity for the whole process — an authentication kill switch one request away from anyone holding `settings.manage`.

**Every value has exactly one source** (since migration 067, 2026-09-30):

| Source | What | Where |
| ------ | ---- | ----- |
| Environment | Deployment facts and secrets | `PORT`, `JWT_SECRET`, `WEBHOOK_TOKEN`, Telegram, proxy |
| Fixed value | Internal timing and rate tuning: feed and poll intervals, cache lifetimes, health-check cadence, retry counts, request ceilings | the constants in `core/config.js` and the OpenAlgo client constructor |
| Setting | What an operator decides: spread guard, brokerage, market-order support, trading sessions, orders per second, broker response timeout | `application_settings`, with its one default in `ESSENTIAL_SETTINGS` (`settings-registry.js`), which also seeds fresh installs (`000_initial_schema`) |

Before 067 the tuning values were all three at once - an env default, a Settings > Advanced row and a hardcoded fallback - and the screen showed values the app was not using (retries: 5 shown, 3 used; the client copied the timeout from `.env` before the DB was read). Migration 067 deleted those rows and the two hidden debug rows that turned off rate limiting and the circuit breaker; each tuning constant keeps the value that was in effect.

Two classes of key are deliberately not settings:

| Class | Why | Examples |
| ----- | --- | -------- |
| Boot-only | Read once at module load or startup; editing does nothing until a restart | `server.port`, `cors.*`, `logging.*`, `database.path` |
| Secrets | Must come from the environment, where `getEnv(..., required)` can enforce them (the webhook token is the one exception: it is rotated from Access Control and stored as a sensitive row, never through this API) | `session.secret` |

Sensitive rows come back masked from `getSetting`/`getAllSettings`; server code reads a raw value with `settingsService.getRawValue(key)`. Migration 065 retired the IST blackout-window rows and three permissions nothing checked (`pages.audit.view`, `pages.api_playground.view`, `monitor.view`).

Settings are grouped by task (Orders & Costs, Trading Hours, Broker Connection). Every field carries a label, `help` (what it does) and `details` (when to raise or lower it, with an example) - the registry test fails a field without both - and where relevant a unit and bounds enforced server-side. The spread limit is stored as a fraction and edited as a percentage; timeouts are stored in ms and edited in seconds.

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
- `services/kill-switch.service.js` - the **global kill switch** (top bar, `POST /api/v1/kill-switch` with body `{ "confirm": "KILL" }`, permission `killswitch.execute`, held by every built-in role). For every active instance, in parallel: cancel all orders, close each open position with `quickOrderService.closeAllPositions` (LIMIT orders on Indian exchanges, chased until filled), read the book back, then switch to analyzer mode and set `session_cutoff_reason = 'KILL_SWITCH'` so the new-session auto-revert (which only undoes `SESSION_MAX_LOSS`) cannot put it back to live. A live instance whose positions are still open is left live and reported - in analyzer mode nothing would manage them. Returns 207 when any instance needs attention. There is no Pause: a trading app must never stop watching its positions.
- **Closing everything is LIMIT-only.** Close All (`POST /positions/:id/close`), the switch to analyzer mode and the kill switch all go through `quickOrderService.closeAllPositions`, one symbol at a time through the exit path. OpenAlgo's `closeposition` squares off at MARKET with no price, so the client method was deleted and `assertLimitOnlyCompliance` refuses the endpoint outright. Close All answers 502 with what is still open if anything could not be closed.
- `services/auto-exit.service.js`:
  - Continuous monitoring of positions.
  - Evaluates targets, stop-loss, trailing stop for equity/futures/options.
  - Triggers exit orders via quick-order flow.
- `services/risk-controls.service.js`:
  - Computes target/stop/trailing logic and persists trailing state.

### 6.6 External Integrations
- `integrations/openalgo/client.js`: HTTP2 client, backoff, per-instance health, circuit breaker.
  - **There are no time-of-day blackout windows.** The fixed IST windows were removed on 2026-09-29. An unreachable instance is paused by the failure-driven circuit breaker (`instance-health-tracker.service.js`, enforced in `request()`), with a doubling cooldown capped at 10 minutes; order calls and `ignoreCircuit` callers bypass it. Polling, by contrast, is gated per instance on `marketCalendarService.isInstanceMarketOpen()` - crypto brokers always count as open, Indian brokers while any of NSE/BSE/CDS/MCX is. Do not reintroduce a clock-based gate: it blocked working servers and cannot see that crypto trades 24x7.
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
- **Watchlists view** renders watchlists and symbols in a table. A watchlist created from the UI is active straight away (it used to default to inactive and was never quoted).
- **Add Symbol** searches the local instruments cache (FTS5 prefix match, `"query" *`): the stock ranks before its futures, futures before options, expired contracts are never listed, and the exchange filter narrows it.
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
  - Updates options state (`watchlist_options_state`) as needed.
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
- Only definite failures are retried. An uncertain one (timeout, network, 5xx, `ORDER_OUTCOME_UNKNOWN`) may already have closed the position, and a re-sent exit against a lagging position book sells again.

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
- Broadcast targets are resolved from watchlist assignments: active instances with order placement on. An inactive watchlist refuses the alert.
- LIMIT/SL alerts need a price, SL/SL-M a trigger price, and expired contracts are refused before any target is sent anything.
- Orders are placed per target instance with rate-limiting buckets.

### 7.10 Multi-Leg Strategies & GTT (`strategy.service.js`)

A **strategy** is a named group of legs (e.g. sell ATM CE + sell ATM PE) scoped to a watchlist, manageable via `/api/v1/strategies` and executable via webhook (`findByWebhookSlug`) or the UI.

- **Execution** (`executeStrategy`) resolves each leg's symbol/strike (once per broadcast for consistency, or per-instance for FLOAT_OFS reduce), then sends every leg for an instance in one `placeBasketOrder` call. Indian legs are marketable LIMIT orders priced from depth/quotes (SEBI); crypto legs go MARKET when the broker allows it (Settings > Market orders), since a LIMIT off the last quote rested unfilled - and was cancelled - whenever the price moved past it.
- **Exit tracking**: rather than a bespoke exit engine, each leg's resolved trading symbol gets a `watchlist_symbols` row carrying that leg's own target/stoploss/trailing config, so exits ride the existing `AutoExitService`/`RiskControlsService` polling loop used for regular watchlist symbols.
- **Basket safety**: a basket whose request fails with an unknown outcome is never re-sent. Each leg's outcome is read from the order book (`_basketOutcomeFromBook`); an unreadable book is `ORDER_OUTCOME_UNKNOWN`.
- **Targets**: an `instanceId` override must be one of the strategy's own active, order-enabled targets. Exit targets every active instance the ledger shows open legs on, whatever the current scope.
- **Double-entry guard**: a leg with an open ledger row is skipped. A row older than 60s is reconciled closed when the broker holds nothing in the leg's direction and its entry order is no longer working, so a leg closed by auto-exit or by hand is entered again by the next alert.
- **Exit sizing**: each contract and product is closed for the strategy's own quantity. A full close (chased until flat) is used only when the strategy is the sole holder; otherwise `exitPartOfPosition` exits just its share.
- **Status**: `GET /:id/status` (`getExecutionStatus`) aggregates `strategy_leg_executions` across instances for a strategy.
- **Risk events**: target/stop/trailing hits during strategy or watchlist-symbol monitoring are recorded to `risk_events`.

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
- `SettingsService.ensureEssentialSettings()` inserts any missing row from `ESSENTIAL_SETTINGS`.

### 9.2 Config Loading
- `config.loadFromDatabase()` reads the broker timeout and the rotated webhook token at startup, and again when an `openalgo` setting changes. The OpenAlgo client reads the timeout through a getter, so a change applies to the next call; it reloads the orders-per-second limit on a `rate_limits` change.
- The spread guard, brokerage and sessions are read from their rows at the point of use.

### 9.3 Settings API
- `GET /api/v1/settings/schema`: **what the Settings UI renders from** — the registry (groups → sections → fields, with labels, help, units and bounds) hydrated with current values. Only runtime-editable settings appear.
- `GET /api/v1/settings`: all settings grouped by category (raw; includes non-editable rows).
- `PUT /api/v1/settings`: the only write - the Settings screen saves through it. Runs inside `db.transaction()`; a key absent from the registry, or a value outside its bounds (including a trading session that is not HH:MM), is collected into `errors` rather than rolling back the valid keys in the same save.

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
- **General** renders every group from the schema, stacked: Orders & Costs, Trading Hours, Broker Connection. There is no Advanced panel (removed 2026-09-30). Each field shows its default; millisecond settings are edited in seconds and stored in ms.
- **Access Control** (admin only): users, roles, permissions, and the **TradingView webhook token** - "Rotate token" issues a new random token (`POST /api/v1/webhook-config/rotate`, `settings.manage`), stores it as the sensitive setting `webhooks.tradingview.token` (which `config.load()` reads ahead of `WEBHOOK_TOKEN` in `.env`), and refuses the old one immediately.
- **Data Management**: instruments refresh/upload and CSV import/export. **System Status**: health and feed state.
- Sensitive settings are masked and have visibility toggles.

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

**Why the topology differs from the rest of the app.** Orders fan out to every associated instance; candles come from exactly **one**. OHLC for a symbol is the same market fact whichever broker reports it, so fanning out would multiply rate-limit cost for identical data. `candle.service.js` picks a single instance from the existing market-data pool, filtered by broker class — a `CRYPTO` symbol asked of an Indian broker is a guaranteed failure, so there is deliberately no fallback to a mismatched broker.

**Symbols come from `watchlist_symbols`, not free text.** A charted symbol must also be a *tradeable* symbol: the watchlist row carries the quantity defaults, product, tick buffers and risk/auto-exit config that every order path depends on. Sourcing the picker anywhere else would produce a chart whose trade buttons could not later be wired up without bypassing those guardrails.

**The `candles` cache (migration 060) is not an optimisation, it is load-bearing.**
- `history` shares the per-instance rate limiter with the live trading feed. Uncached, a user scrubbing timeframes competes with position and quote polling for the same budget.
- When the instance is unreachable (its circuit breaker is open), an uncached chart simply fails; with the cache it serves last-known candles and sets `stale: true`, which the UI states in words.
- A `MIN_FETCH_INTERVAL_MS` cooldown means repeated requests for the same symbol/timeframe cannot translate into broker traffic.
- Rows are upserted, not ignored on conflict: the newest candle of a live session is still forming, and `ON CONFLICT DO NOTHING` would freeze the current bar at its first value.

**Time axis.** Stored `ts` is a true UTC epoch in seconds exactly as the broker returns it (verified: BSE's first candle of the day is 03:45Z = 09:15 IST). The engine takes raw UTC seconds and labels the axis in an IANA zone (`CHART_TIMEZONE = 'Asia/Kolkata'`), so no value is shifted before it is charted. `IST_OFFSET_SECONDS` survives only for bucket arithmetic in `dashboard-chart-live.js` (which bar a tick belongs to).

**Library.** [openalgo-charts](https://www.npmjs.com/package/openalgo-charts) (Apache-2.0, the OpenAlgo project's own clean-room engine), installed from npm and copied into `public/vendor/openalgo-charts` by `scripts/sync-vendor-charts.js` on every install. It ships as native ES modules; `public/js/openalgo-charts-bridge.js` loads the tiers this app uses (core, indicators, drawing, profile, trade, transforms, WebGL) and exposes them as `window.OAC` for the classic `dashboard-chart*.js` scripts. User studies are compiled by the vendored OpenScript engine (`public/vendor/openalgo-script`). Keep the attribution line under the chart.

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

The dashboard shell runs a 15-second tick. It used to call `loadView(currentView)` — a **full re-render of whatever view was open**, which is why the app looked like it was reloading every few seconds. That behaviour predates every view growing its own updating mechanism, so by the time it was removed it was redundant everywhere and destructive in places: the chart tore down its candles, option panes and indicator sub-charts mid-interaction (leaving "Trade options" ticked with nothing beneath it), and settings lost unsaved edits.

The tick now consults `AUTO_REFRESH_VIEWS` in `dashboard-core.js` and touches only:

| view | how |
| --- | --- |
| instances | re-render (health status, no local state to lose) |
| notifications | re-render |
| orders | `loadOrders(..., { ensureView: false })` — data only, keeps the filter, scroll and expanded rows |

Every other view keeps itself current by other means: watchlists has an adaptive poller, positions is driven by WebSocket pushes plus a 60s snapshot resync, dashboard and trades have their own intervals, the chart refreshes its own candles, and strategies/daily-P&L are static until acted on. Settings is deliberately never auto-refreshed — it holds unsaved input.

**Anything added to that map must update data in place.** A full re-render on a timer is a page refresh in everything but name.

**Resuming** (returning to the tab after the visibility handler paused things) goes through `resumeBackgroundData()`, not `refreshCurrentView(true)`. The old path rebuilt whatever was open, so stepping away from the chart and back destroyed the candles, the option panes and every indicator sub-chart while leaving "Trade options" ticked with nothing beneath it. Resume now refreshes in place where it can (`RESUME_IN_PLACE`, which adds `chart: loadChartData` to the map above) and only falls back to a re-render for `watchlists`, `positions`, `trades` and `dashboard` — the views whose pollers are started by their own render, where skipping the rebuild would leave them silently frozen.

The tick itself is also now started at init. It previously only began after a tab switch, which is why the symptom appeared partway through a session rather than immediately.

### Option scalping layout & indicators

While "Trade options on this underlying" is on, the chart splits into three panes: the underlying, plus the resolved CE and PE. `GET /api/v1/history/option-legs` resolves those contracts from the instruments master against the live price. That is a **display** resolution — the strike each instance finally trades is resolved independently at execution and may differ if the underlying moves, which the confirmation states.

Indicators come from the engine's registry (`registerBuiltinIndicators()` in the bridge) plus any **OpenScript** study written in the OpenScript editor, which is compiled by the vendored OpenScript engine and registered like a built-in (a script that does not compile shows its diagnostics and registers nothing). The chart owns its studies, as openalgo-charts is designed: each is an instance with its own legend row (eye, gear, close) and its own settings dialog, and both that dialog and the indicator picker are the widget tier's (`mountIndicatorSettings`, `mountIndicatorPicker`), mounted over the bare charts through `createAlertUi(...).context`. Overlays share the price scale; oscillators (RSI, MACD, ...) are panes of the same chart. What is on each chart is persisted to `localStorage` under `chart-indicators` (`-ce` / `-pe` for the option panes) and put back on a rebuilt chart; a pre-2.6 `chart-indicator-config` is migrated once.

**Zoom survives a reload.** `loadChartData` used to end in `fitContent()`, so every refetch threw away whatever the user had zoomed into — returning to the browser tab, coming back to the chart view, even toggling an indicator. The view is now captured before the data is replaced and restored after, as **bar spacing plus scroll position** rather than a visible range: those are independent of bar index, so appending live bars or refetching a slightly different window does not shift the view, and scroll position measured from the right edge keeps a live chart following the latest bar at the chosen zoom.

Two details that took a second pass. The view is filed under `exchange|symbol|timeframe` **as it was when the geometry was made** (`_activeViewKey`), not the current key — on a timeframe switch the state already names the new timeframe, so the old zoom would be saved under it. And a chart with no data yet is never captured, because rebuilding the chart would otherwise overwrite the saved zoom with the empty chart's defaults a moment before restoring from it. A symbol or timeframe seen for the first time still frames itself with `fitContent`.

**Live price** (`public/js/dashboard-chart-live.js`). Candles arrive from the history API in bulk; ticks arrive on the quote stream. `applyChartQuote` joins them — each tick folds into the bar it belongs to and a tick past the bar's end opens a new one, via `series.update()` rather than a refetch, so the price moves without flicker and without losing your zoom.

Three rules that are silent when wrong, and so are pinned by tests:

- **Buckets are computed in IST**, matching the history API's own day boundaries. A UTC-bucketed daily bar rolls over at 05:30 IST — mid-session for crypto.
- **A tick older than the last drawn bar is dropped.** A late or replayed message would otherwise rewrite a closed bar with a stale price.
- **A non-positive LTP is dropped.** Zero is what a broker returns for a contract it has no quote for; charting it draws a wick to zero and rescales the pane.

The stream is preferred; a 3-second REST poll of `/snapshots/quotes` is the fallback, checked per tick rather than at start-up because the socket can drop at any time and a chart that silently stops moving is the worst failure here. Only the underlying updates live — the stream carries the symbols the watchlists subscribe to, and the resolved CE/PE contracts are not among them, so the option panes hold their fetched history rather than showing an invented tick.

**Indicators advance with the price.** Indicators are engine instances attached to the chart (`chart.addIndicator()`), which recompute when the series data changes, so a live tick moves them without a refetch.

**Index segments (`NSE_INDEX`, `BSE_INDEX`) were never subscribed on any WebSocket, ever.** Two compounding bugs in `market-calendar.service.js` and `openalgo-ws.service.js`, both found while chasing the NIFTY symptom above:

- `isExchangeOpen` matched a symbol's exchange **exactly** against the market-timings table, which answers for `NSE`, `BSE`, `NFO`, `BFO`, `MCX`, `BCD`, `CDS`, `NCO`, `CRYPTO` — never for an index segment. `NSE_INDEX`/`BSE_INDEX` therefore never found an entry and `isExchangeOpen` returned `false` **unconditionally**, at any time of day. `filterOpenSymbols` used that to build the WebSocket subscription list, so NIFTY and BANKNIFTY were silently excluded from every subscription, permanently — which is exactly why the cached quote could only ever get older. `CALENDAR_EXCHANGE_ALIASES` now maps each index segment onto the real exchange whose session governs it; the symbol itself keeps its real segment label everywhere else, only the *open-check* is aliased.
- Once that was fixed, a second bug surfaced: the WebSocket's round-robin symbol assignment had no concept of which **broker** a connection belonged to. With one crypto instance and one Indian-broker instance as the only two live connections, an Indian index had a coin-flip chance of being round-robined onto the crypto connection — which has no NSE session to subscribe to, so no quote for it ever arrives there. It still looked "subscribed" (`desired.add` succeeds regardless), so the failure was invisible until the cached snapshot's age was checked directly. `syncAll` now filters candidate connections by `isCryptoBroker`/`isCryptoExchange` compatibility (from the existing `broker-type.util.js`, already used for candle-fetch instance selection) before round-robining, per symbol-class bucket.

**A stale or malformed quote is never charted.** Two guards, because the failure was real and visible: NIFTY jumped from 23,955 to 25,665 in a single candle and then flat-lined.

- **Staleness.** Every instance's quote snapshot carries a `stale` flag from `/snapshots/quotes`, and the chart poll now honours it. It had not, so a broker snapshot cached in **January** was still being charted in **July** — 190 days old — and since every later poll returned that same frozen value, the line went flat after the gap. The WebSocket push path carries no such flag, so `applyChartQuote` independently rejects any quote whose own `timestamp`/`ltt` is more than six hours old. Deliberately not `ltpTs`, which is stamped on arrival and makes a six-month-old snapshot look new. The status line says so rather than freezing silently at a wrong price.
- **INT32 sentinels.** Broker feeds relayed through OpenAlgo send `2^31` for fields they have no value for, and prices are scaled by 100, so an unset price arrives as `21474836.48`. The NIFTY packet carried exactly that in open/high/low and `2^31` as volume. `sanitiseQuote` in the feed service strips them at ingestion — dropped rather than zeroed, since a missing high is honest and a high of 0 is a price that never traded — and discards the quote entirely when no usable last price remains. The chart refuses them again on its own side.

The generous six-hour window is intentional: an illiquid contract's last trade can legitimately be hours old while its price is still the right one to show. It exists to catch snapshots that are months stale, not to police normal quiet markets.

**Volume is a delta, not the counter.** Broker quotes report volume cumulatively for the session. Assigning it straight to the bar would give the live candle the whole day's volume and drag VWAP toward it, so the bar's volume is the increase since it opened. A counter that goes backwards (session rollover, feed reset) rebaselines rather than emitting a negative volume. Without a volume field the bar stays at zero and VWAP simply holds — correct for a volume-weighted average with nothing to weight by.

**Volume** is a histogram series pinned to the bottom fifth of the price pane, so it reads as context rather than as a second chart.

**Candlestick patterns** (`public/js/chart-patterns.js`). 44 classical patterns as pure functions over candles, drawn as markers on the candle series by `applyPatternsTo` (`dashboard-chart-panes.js`). Each is independently toggleable with its own marker colour and placement (`chart-patterns` in localStorage), defaulting to green-below for bullish and red-above for bearish.

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

`public/js/dashboard-chart-draw.js` is a thin adapter over openalgo-charts' own `DrawingController` (the `draw` tier). The engine is headless and owns placement (live preview, click-click and press-drag-release), selection, whole-shape and per-anchor dragging, magnet snap to O/H/L/C, undo/redo and JSON serialisation. The adapter adds:

- **A vertical icon rail** grouping every tool the engine registers into this app's categories (`TOOL_CATEGORY`). A tool not named there lands under "More", so a library upgrade that ships new tools exposes them immediately.
- **Per-instrument persistence** in `localStorage` (`chart-draw:{exchange}:{symbol}`), saved on every change.
- **A horizontal line doubles as an order ticket.** It is the only shape naming a single price, so right-clicking one opens the chart's ordinary limit/stop menu at that price through `contextMenuItemsFor` + `confirmChartOrder` - the same validity rules, sizing and blast-radius confirmation as any other chart order. Nothing in the adapter places an order on its own.

**Trading in options mode.** The CE/PE tickets fan out at market with a strike resolved per instance. The underlying stays tradeable by right-clicking the main chart (blocked only when it genuinely cannot be traded, e.g. an index), and a specific leg is tradeable by right-clicking its own pane - LIMIT and SL-M only, on that exact contract, sent to `/orders` with the symbol named outright. Sizing takes a `forOptions` flag throughout (`sizingUnit`, `lotSize`, `typedLots`, `typedUnits`, `sizingBreakdown`) so a futures order placed while options mode is on is never sized with the option's lot size.

### Chart fits the viewport, panes and sync

`chartBudgetHeight()` caps the chart container to the height the viewport actually has (`window.innerHeight` minus the container's top), and a debounced resize listener reapplies it, so enabling oscillators never pushes them below the fold.

**Oscillators are panes of the price chart** (`panes()` on one chart instance), so they share one time scale and cannot drift out of line with the candles.

**Underlying, CE and PE are separate chart instances** - three instruments, three `createChart()` calls - joined by the engine's own link group (`createLinkGroup`, rebuilt by `syncCharts()` in `public/js/dashboard-chart-sync.js` whenever the set of charts changes). The group moves everything across charts as a **time**, never a bar index: bar N is a different instant on each chart, because an option's history starts later and skips minutes with no trades.

| toggle | effect |
| --- | --- |
| Crosshair | hovering one chart draws a vertical line on the others at the bar open at that instant; nothing outside a chart's own data. |
| Align time | panning or zooming one shows the same wall-clock window on the others, right-hand margin included, so the latest bars line up. The group follows gestures only, so `alignFollowers()` re-maps the panes after a load, a restored view and each new live bar. |
| Interval | panes share the toolbar timeframe. Off, each option pane gets its own selector. |

Until 2026-09-30 this was hand-rolled: the crosshair drew a horizontal price line on the other charts (no vertical line), and zoom shared bar spacing only, so each chart kept its own scroll and the right edges drifted apart. The CE/PE panes also never updated after they opened; they now poll their contracts through `POST /symbols/quotes` every 3 s (`pollOptionPaneQuotes`), and live bars are bucketed by `timeframeSeconds()`, which parses every picker timeframe (a six-entry table bucketed 3m and 10s charts into 5m bars). Both charts share `HISTORY_SPAN_DAYS`.

**Trading from the chart itself.** Right-click on the underlying or a pane opens the order menu at the pointer (it is `position: fixed`; positioned against the underlying's box it opened far from a pane click). A price picked there is a resting order: `order.service` rounds it to the contract's tick and sends it as a plain `placeorder` (`orderPlacementService.placeRestingOrder`) - no position target, no queue coalescing, no retry chase. As a `placesmartorder` it was filled on the spot by OpenAlgo's analyzer even at half the market, and the retry service cancelled or chased it. Working-order lines (`dashboard-chart-orders.js`) load `status=open,pending` (a stop waiting for its trigger is `pending`), are keyed by the app's order row id, and act on the engine's gestures: `order:<id>` drag ends in `POST /orders/:id/modify` (limit moves its price; a stop its trigger, SL-M re-converted to SL), and the line's x (`order:<id>::close`) cancels. Nothing listened to those before, so the handles did nothing. Covered by `Test/integration/chart-orders.test.js` on the real crypto analyzer account and `e2e/options-orders.spec.js`.

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

**Product rule - the same on every path** (chart, watchlist, `/quickorders`, `/orders`): equity takes MIS, NRML or CNC; futures and options (NFO, BFO, MCX, CDS, BCD, NCO and crypto) take MIS or NRML, and CNC becomes NRML because F&O has no delivery product (`quick-order._resolveProductForOrder`, `order.service._normalizeOrderData`, `isDerivativeExchange`). The watchlist offers MIS/NRML for F&O; the chart's CNC button is shown as NRML in the confirmation. Reduce/increase/close act on the position that exists, in that position's own product. Until 2026-09-30 the chart sent no product on its option (quick-order) path, so every chart option order went as MIS. Its product buttons and symbol picker were also wired only after the price history loaded: a click before then did nothing, and a symbol picked early changed the dropdown but not the chart or its order tickets. Both are now wired before the first await, and `loadChartData` / `loadChartTradePanel` drop a response that arrives after the symbol or timeframe changed. `/orders` works out each instance's `position_size` from that instance's own position when the caller sends none; the chart no longer sends one summed across instances. Covered by `Test/integration/options-orders.test.js` (CE and PE on the real crypto analyzer account) and `e2e/options-orders.spec.js`.

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
- `dashboard-core.js` + `dashboard-init.js`: app state, view switching, bootstrap. Also owns the navbar **feed-status pill** (`resolveFeedState`), which reports the market-data feed as Live / Polling / Stale Ns / Disconnected / Connecting. Freshness comes from `markDataReceived()`, called from the quote-meta choke point in `dashboard-watchlists-quotes.js` so every feed path — WS push and REST poll alike — advances the same clock.
- `dashboard-instances.js`, `dashboard-orders.js`, `dashboard-positions.js`, `dashboard-trades.js`, `dashboard-pnl.js`, `dashboard-overview.js`, `dashboard-notifications.js`: one file per dashboard section. The Orders page has two panels: the live broker **order book** per instance, and one **Order history** that merges watchlist, strategy, webhook and manual orders (filter by instance name and status; "From" says where each order came from).
- `dashboard-watchlists-core.js`, `-crud.js`, `-modals.js`, `-positions.js`, `-quotes.js`: watchlist view, split by concern.
- `quick-order-core.js` + `quick-order-init.js`, `-controls.js`, `-expansion.js`, `-instruments.js`, `-option-chain.js`, `-place.js`, `-preview.js`, `-selectors.js`: watchlist row expansion and trade controls (see §7.2-7.4).
- `settings-core.js` + `-init.js`, `-data.js`, `-general.js`, `-rbac.js`, `-status.js`: settings UI, RBAC admin, import/export.
- `settings-schema.js`: renders the General tab from `GET /api/v1/settings/schema` (groups, sections, paired fields, live unit hints, defaults) as Simple + Advanced (see §9.6). Replaced the hardcoded category lists that used to decide what the screen showed.
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
- Payloads are normalized and broadcast to watchlist instances; a strategy's own slug executes or exits its legs instead.
- The token is the only credential. Rotate it from Settings → Access Control; the new token takes effect at once and survives restarts.

### 12.3 Telegram
- Bot integration for order alerts and summaries.
- User linking via `/start` command with one-time codes.

## 13) API Surface Overview

Route groups under `/api/v1` (by module):
- **auth**: `register` (bootstrap-only), `login`, `change-password` - local email/password auth (see §4.1).
- **instances**: instance CRUD, analyzer toggle, connection/API-key tests, refresh, CSV import/export.
- **watchlists**: watchlist CRUD, symbol management, instance assignments, CSV import/export.
- **strategies**: multi-leg strategy CRUD, leg management, execute/exit, status (see §7.10).
- **quickorders**: watchlist trading actions (equity/futures/options) with idempotency support.
- **orders**: manual order placement and order history.
- **positions**: per-instance positions, per-symbol legs for the chart, close one / close all.
- **symbols**: symbol search, quotes, expiries, option-chain utilities.
- **instruments**: instrument cache stats, upload, fetch-from-instance.
- **dashboard**: dashboard metrics aggregation.
- **monitor**: `status` (System Status tab).
- **settings**: list, schema, save, reset (see §9.3).
- **webhook-config**: `GET` the TradingView token for building alert URLs, `POST /rotate` to replace it - both behind `settings.manage`.
- **option-chain**: option chain for an underlying/expiry.
- **trades**: tradebook access and reconciliations.
- **rbac**: roles, permissions, and user role management.
- **notifications**: health and system notifications.
- **health-check / ready / health**: runtime and readiness probes.
- **telemetry**: rate-limit and cache visibility.
- **snapshots / pnl-snapshots**: cache snapshots and daily P&L export.
- **public-config**: unauthenticated WS-gateway and feed-timing config for the frontend bootstrap. Deliberately carries nothing sensitive; the TradingView webhook token is served separately by **webhook-config**, behind `settings.manage`.

Webhook routes (public token auth):
- **/webhook/tradingview**: TradingView broadcast endpoints.

## 13.5) Testing

There is no fake broker anywhere in the suite. Pure logic is tested offline; anything that talks to a broker talks to the operator's real OpenAlgo instances, in analyzer mode.

| Layer | Where | Broker | Command |
| --- | --- | --- | --- |
| Logic | `Test/unit`, `Test/services` | none (single client methods stubbed for pricing/retry maths) | `npm run test:logic` |
| Routes & flows | `Test/integration` | real: Jz Kotak, Jz Fyers, Jabez Crypto | `npm run test:integration` |
| Browser e2e | `e2e/*.spec.js` (Playwright, port 3111) | real: the same three | `npm run test:e2e` |
| Live orders | `Test/live` | real: all five, including Maha and Ana | `npm run test:live` |

Rules the real-broker layers share (`Test/helpers/real-broker.js`, `e2e/broker.js`):
- Instances are **copied** out of `database/simplifyed.db` (URL + key) into a throwaway database; the production database is only ever read.
- **Interlock:** no test can switch an account to live, and nothing that places, changes or cancels an order is sent until the broker itself confirms analyzer mode (the local `is_analyzer_mode` column is not trusted).
- **Nothing left open:** every test that orders closes what it opened and fails if the broker still shows a position or working order.
- "Broker down" is a real unreachable address (`127.0.0.1:9`), and a rejection is a real one (an unlisted contract, a key the broker refuses) - never a scripted response.
- Crypto (BTC, 24x7) carries the always-on steps; NSE and MCX steps run only while that exchange is open and are skipped otherwise.
- Integration files run one at a time (`--test-concurrency=1`): they share the real accounts.
- The webhook token is never printed. E2E reads a token rotated from Settings out of its database copy, else `WEBHOOK_TOKEN`.

## 14) Operational Notes

- **Migrations** are applied via `backend/migrations/migrate.js`.
- **Instruments** refresh themselves (stale-cache check, 17:31 IST crypto refresh); Settings → Data Management refreshes by hand.
- **Test runs** get an empty `TELEGRAM_BOT_TOKEN`, so test orders never message the operator.

## 15) Key Architectural Guarantees

- Centralized market data feed avoids duplicated broker calls.
- Quick orders are position-aware and idempotent where possible.
- RBAC and audit logs provide traceability for admin actions.
- Health checks prevent unhealthy instances from being used for trading or market data.
