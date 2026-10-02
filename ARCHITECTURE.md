# Simplifyed Architecture

Simplifyed is a multi-instance admin and risk layer on top of [OpenAlgo](https://openalgo.in). One Node.js (ESM) / Express server, one SQLite file, a static HTML/JS frontend. It fans orders out to many OpenAlgo instances (one per broker account), watches positions, and enforces stop-loss, target and session limits.

This document describes the code as it is. History belongs in git. All paths are relative to `backend/` unless stated.

## 1. Runtime overview

```
Browser (public/*.html, public/js/*)         TradingView alerts
        |  REST /api/v1/*  + WS gateway             |  POST /webhook/tradingview/...
        v                                           v
 Express (server.js): helmet, cors, JSON, correlation id, request log, optionalAuth,
                      noStore, auditLogger
        |
   routes/v1/*  and  routes/tradingview-webhook.js     (thin: validate, authorise, delegate)
        |
   services/*                                          (all business logic)
        |
   +----+-------------------------------+
   |                                    |
 core/database.js (SQLite, sqlite3)   integrations/openalgo/client.js  --HTTP-->  OpenAlgo instances
                                      services/openalgo-ws.service.js --WS---->  (quotes, orders)
```

Process facts:

- `npm start` runs `node server.js`; the owner runs `node --watch`. There is no build step.
- On boot `server.js` runs migrations (the server refuses to start with pending ones), listens, then calls `startBackgroundServices()` unconditionally. A restart with no browser open still monitors stop-losses and session limits.
- `startBackgroundServices()` starts, in order: the market-data feed, auto-exit, polling. It is race-safe and logs its own failure.
- After listen it also starts the instance health cron and the instruments refresh crons (section 6).
- `unhandledRejection` is logged. `uncaughtException` is logged and exits with code 1.
- Authentication is JWT-only (`Authorization: Bearer`). The WS gateway takes the token as a `token` query parameter.

## 2. Repository layout

```
/                       README, INSTALL, QUICKSTART, BEGINNER_GUIDE, install.sh, update.sh,
                        uninstall-instance.sh, pre-install-check.sh
backend/
  server.js             boot, middleware order, route mounting, background services, shutdown
  src/config/           settings-registry.js  (the only list of runtime-editable settings)
  src/core/             config.js (constants + env), database.js, logger.js, errors.js, migration-check.js
  src/integrations/openalgo/
                        client.js (every broker call), instance-health-tracker.service.js (circuit breaker)
  src/middleware/       auth (optionalAuth, requirePermission), audit-logger, error-handler,
                        request-logger, no-store, instruments-refresh (reports only)
  src/routes/           tradingview-webhook.js, v1/*.js
  src/services/         one file per concern (section 3)
  src/utils/            pure helpers (section 7)
  migrations/           numbered, forward-only, each run in a transaction
  public/               html, js/, css/, vendor/ (generated), service-worker.js
  Test/                 unit, services, integration, live
  e2e/                  Playwright specs
  scripts/              prepare-test-db.js, set-user-password.js, sync-vendor-charts.js
  database/             SQLite files (gitignored)
docs/                   AUDIT-REPORT.md and per-phase review notes
```

`public/vendor/` is not tracked. `npm ci` regenerates it through the `postinstall` script (`scripts/sync-vendor-charts.js`), which copies `openalgo-charts` and `openalgo-script` out of `node_modules`.

## 3. Backend modules

### 3.1 Broker boundary

| Module | Role |
|---|---|
| `integrations/openalgo/client.js` | The only code that talks HTTP to OpenAlgo. Per-instance order throttle and concurrency limit, request timeout, SL-M to SL conversion, SEBI limit-only guard, lot-unit conversion (via `broker-units.service`), `ORDER_OUTCOME_UNKNOWN` handling through `_awaitOrderInBook`. |
| `integrations/openalgo/instance-health-tracker.service.js` | The circuit breaker. The single source of truth for whether a call to an instance is allowed. |
| `broker-units.service.js`, `broker-capabilities.service.js` | Per-broker lot units and capability flags. Units are converted only at the client boundary. |
| `openalgo-ws.service.js`, `ws-gateway.service.js` | Upstream OpenAlgo WebSocket per instance (quotes, order updates) and the downstream gateway that forwards events to browsers. |
| `instance-health-check.service.js`, `instance-health.service.js` | The one ping loop that writes `health_status` for the UI and feeds the tracker. |

### 3.2 Market data and positions

| Module | Role |
|---|---|
| `market-data-feed.service.js` | Shared, cached quotes, positions and funds, refreshed once per interval for every session. In-flight guards, parallel per-instance refresh, `symbolQuoteCache` fed by WS ticks. |
| `market-data-instance.service.js`, `quick-order-quotes.service.js` | Picks the instance used for market data; LTP lookups for order paths. |
| `positions.service.js` | Position views, chart entry price (`average_price` first, then entry-side tradebook average), closing. |
| `polling.service.js` | Per-instance cycle (session P&L, session cutoff, analyzer status). One cycle per instance at a time. |
| `instance-pnl.service.js`, `pnl-snapshot.service.js`, `dashboard.service.js` | Session P&L from broker MTM minus charges (`utils/trade-pnl.computeSessionPnl`). The dashboard and the session check use the same function. |
| `candle.service.js` | Historical candle cache for charts. |

### 3.3 Orders

| Module | Role |
|---|---|
| `order.service.js` | Place, modify, cancel; local `watchlist_orders` rows. |
| `order-placement.service.js` | Queue and coalescing (same source only), de-duplication, one call into the client. |
| `order-retry.service.js` | Re-prices an unfilled marketable LIMIT. Cancels only that symbol's own order ids, never the account. |
| `limit-price.service.js` | Marketable LIMIT pricing from bid/ask or LTP, tick rounding, spread guard (`SPREAD_TOO_WIDE`). Exits may bypass the spread guard; entries may not. |
| `order-payload.factory.js`, `order-repository.js`, `utils/order-validation.js`, `utils/order-helpers.js` | Payload shape, persistence, validation, shared helpers. |
| `quick-order.service.js`, `quick-order-history.service.js` | Option and future quick orders: FLOAT_OFS strike selection, buyer/writer modes, close and reduce flows. |
| `idempotency.service.js` | Request-id de-duplication; pending rows expire after 5 minutes. |
| `kill-switch.service.js` | The only code (with the explicit "Cancel all" route) that may call `cancelAllOrders`. Cancels, closes every position, switches instances to analyzer mode. |
| `gtt.service.js` | GTT trigger orders. |

### 3.4 Risk

| Module | Role |
|---|---|
| `auto-exit.service.js` | Stop-loss and target evaluation. Price comes from a fresh WS quote, else position LTP. Fails open when the market calendar is unknown. Closes only the matching product (and only a strategy leg's own quantity). |
| `exit-levels.service.js`, `utils/exit-levels.util.js` | Per-position exit levels (fixed, trailing). States `ARMED`, `TRIGGERING`, `TRIGGERED`, `FAILED` with an attempt counter. Stuck `TRIGGERING` rows are reset on boot. |
| `exit-loss-caps.service.js`, `risk-controls.service.js`, `risk-events.service.js` | Max-loss caps, session limits, the risk event log. |
| `market-calendar.service.js` | Exchange timings. `isExchangeOpen` returns `null` when unknown. |
| `notify.service.js` | One explicit `notify(type, message, meta)` for meaningful events. `telegram.service.js` sends to `TELEGRAM_DEFAULT_CHAT_ID` and is a silent no-op when unconfigured. |

### 3.5 Instruments, expiries, derivatives

| Module | Role |
|---|---|
| `instruments.service.js` | One `replaceExchange` import path (delete, bulk insert, one expiry format, in one transaction), then an FTS5 `rebuild`. Refresh is per segment (Indian, crypto). Daily crons plus a boot catch-up when stale. |
| `symbol-validation.service.js`, `utils/symbol-parsing.util.js`, `utils/underlying.util.js`, `utils/expiry.js` | Search, parsing, the single expiry parse/format helper. |
| `derivative-resolution.service.js`, `options-resolution.service.js`, `option-chain.service.js`, `option-greeks.service.js`, `utils/black76-pricing.util.js` | Contract resolution from the instruments table, option chain, greeks. |
| `expiry-management.service.js`, `futures-roll.service.js` | Nearest-expiry rules; futures auto-roll (`auto_roll` 0/1/2) at the purge crons, early roll only when flat. |

Expired contracts are purged and never queried.

### 3.6 Strategies, watchlists, webhooks

| Module | Role |
|---|---|
| `strategy.service.js` | Multi-leg strategies. A basket is never re-sent. The ledger is reconciled against the broker. An exit closes only the strategy's own quantity. |
| `watchlist.service.js`, `watchlist-symbol.service.js` | Watchlists (types include `broadcast`), symbol rows, instance mapping, targets and stop-losses. |
| `tradingview-broadcast.service.js` | Fans a broadcast alert out to the mapped targets through `order-placement.service`, once per target, with no retry of its own. |
| `routes/tradingview-webhook.js` | `POST /webhook/tradingview/broadcast/:slug?` and strategy slugs. Authenticated by the webhook token (`X-Webhook-Token`, `?token=`). |

### 3.7 Platform

| Module | Role |
|---|---|
| `settings.service.js`, `config/settings-registry.js` | Runtime settings (section 5). |
| `rbac.service.js`, `middleware/auth.js` | Users, roles, permissions. `optionalAuth` caches user, role and permissions for 30 s and is invalidated on any RBAC change. Routes gate on `requirePermission('<area>.<action>')`. |
| `retention.service.js` | The 6-hourly prune. Windows: `audit_logs` 7 d, `candles` 30 d, `risk_events` 30 d, read `notifications` 30 d, `quick_orders` 90 d, `watchlist_orders` 90 d. |
| `core/database.js` | Promise wrapper over sqlite3 with a serialised `transaction()` queue. Plain `db.run` calls made while a transaction is open run inside it and roll back with it. Keep long imports short (per exchange). |
| `core/logger.js` | Key-value logger. Prints every primitive meta key, redacts `token`, `api_key`, `apikey`, `password`, serialises `err` as its message. |

## 4. Data flow

### 4.1 An order from the UI or a webhook

1. Route validates the body (validation errors are **422**, not 400) and checks the permission.
2. The service resolves the contract (instruments table, never an expired one) and the order type for the exchange (Indian exchanges always LIMIT).
3. `limit-price.service` prices a marketable LIMIT from bid/ask or LTP and applies the spread guard.
4. `order-placement.service` queues it and calls `client.placeOrder` / `placeSmartOrder`.
5. The client throttles per instance, converts lot units, sends the request. On a timeout, network error or 5xx it reads the broker order book (`_awaitOrderInBook`) and either returns the found order or throws `ORDER_OUTCOME_UNKNOWN`. It never re-sends.
6. A `watchlist_orders` row is written; WS order updates and the poller sync its status.

### 4.2 Exit

1. `market-data-feed` keeps positions and quotes warm. WS ticks fill `symbolQuoteCache`.
2. `auto-exit` and `exit-levels` evaluate each position against its levels, using the WS price when fresh (within 5 s), else position LTP.
3. On a hit, `fire()` closes only the matching product and quantity with a LIMIT exit. A failed exit reverts the level to `ARMED` and increments its attempt count. After 3 attempts the level is `FAILED` and a notification is raised.
4. `polling` checks session P&L against the session max loss / target and the session cutoff. A cutoff switches the instance to analyzer mode through the safe toggle, which closes positions first.

### 4.3 Browser stream

`ws-gateway.service` forwards `quotes:update`, `positions:update`, `funds:update` and `order_update` for every instance to authenticated browsers. There is no per-instance boot-time filter. The client falls back to polling only for symbols the stream does not cover.

## 5. Settings: where each value lives

Each tunable value lives in exactly one place:

| Source | Use for | Examples |
|---|---|---|
| Environment (`.env`) | Deployment facts and secrets | `PORT`, `BASE_URL`, `DATABASE_PATH`, `JWT_SECRET`, `WEBHOOK_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_DEFAULT_CHAT_ID`, `WS_GATEWAY_*`, `LOG_LEVEL`, `PROXY_TLS_REJECT_UNAUTHORIZED` |
| Code constant (`core/config.js`) | Internal timing and rate tuning that an operator should not touch | feed intervals, circuit-breaker thresholds |
| Settings row (`config/settings-registry.js`) | Values an operator changes at runtime | spread guard, brokerage, trading sessions, orders per second, broker response timeout, futures roll days |

Rules:

- Never an env var **and** a Settings row for the same value; never a `||` fallback that duplicates a default. Defaults come from `settingDefault(key)`.
- A key absent from the registry cannot be written: `settings.service.updateSetting()` refuses it. The UI renders from `GET /api/v1/settings/schema`; adding a registry entry is the only step needed to surface a setting.
- Secrets (the webhook token) are read with `getSecret`. Never `SELECT *` from `application_settings` unfiltered.
- Settings UI groups: Orders & Costs, Trading Hours, Broker Connection, Futures, plus Access Control and status pages.

## 6. Background jobs

| Job | Where | Schedule |
|---|---|---|
| Market-data feed (quotes, positions, funds) | `market-data-feed.service` | Intervals from `core/config.js`; started at boot |
| Auto-exit evaluation | `auto-exit.service` | Started at boot |
| Instance polling (P&L, cutoff, analyzer check) | `polling.service` | Started at boot; analyzer check at 60 s |
| Instance health ping | `instance-health.service` | Cron every 3 h from 08:00 IST |
| Instruments refresh | `instruments.service` | Indian 08:30 IST, crypto 17:31 IST, and once at boot if stale |
| Futures purge and auto-roll | `futures-roll.service` | At the expiry purge crons (17:50 and 00:05 IST) and on startup |
| Retention prune | `retention.service` | Every 6 h |

## 7. Order-safety invariants

These are domain rules. Do not weaken them while changing code.

1. **SEBI limit-only.** NSE, BSE, NFO, BFO, MCX, CDS, BCD, NSE_INDEX and BSE_INDEX accept LIMIT orders only. SL-M becomes SL. Only crypto instances may send MARKET, and crypto defaults to MARKET.
2. **Never re-send an order whose outcome is unknown.** Check the order book. `placesmartorder` is position-targeted and not idempotent.
3. **Broker lot units** are converted only at the client boundary (`broker-units`).
4. **Expired contracts** are purged and never queried.
5. **Single-source settings** (section 5).
6. **Secrets** are never logged, printed or committed. Webhook token via `getSecret`.
7. **Strategy basket and ledger.** A basket is never re-sent, an exit closes only its own quantity, the ledger is reconciled against the broker.
8. **`cancelallorder` is account-wide.** Only the kill switch and the explicit "Cancel all" route may call it. Retries and closes cancel by symbol and order id.
9. **Schema changes** go through a new numbered migration. Never edit an applied migration.
10. **Analyzer mode** changes only through the safe toggle (broker call, then close positions), never by writing the local flag.

## 8. Data model

SQLite, WAL, migrations in `migrations/` (applied in a transaction, recorded in `schema_migrations`).

| Area | Tables |
|---|---|
| Accounts and access | `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `audit_logs`, `idempotency_keys` |
| Instances | `instances`, `daily_instance_pnl_snapshots`, `broker_lot_sizes`, `trailing_state` |
| Instruments | `instruments`, `instruments_fts` (FTS5, external content), `instruments_refresh_log`, `candles` |
| Watchlists | `watchlists`, `watchlist_symbols`, `watchlist_instances`, `watchlist_orders` |
| Orders | `quick_orders`, `gtt_orders` |
| Strategies | `strategies`, `strategy_legs`, `strategy_instances`, `strategy_leg_executions` |
| Risk | `exit_levels`, `exit_loss_caps`, `risk_events` |
| Platform | `application_settings`, `notifications`, `schema_migrations` |

Notes: `watchlist_orders` is what chart order lines read; `quick_orders` is synced on demand (merging them is deferred). FTS is rebuilt after every bulk instruments load, never edited by hand.

## 9. Frontend

Static pages (`index`, `login`, `dashboard`, `access-pending`) and plain ES modules under `public/js`. There is no bundler.

- `api-client.js` wraps `fetch` with the JWT and 401 handling. `utils.js` holds shared helpers; user text goes through `Utils.escapeHTML`, toasts use `textContent`.
- Dashboard: `dashboard-*.js` (overview, instances, orders, positions, trades, P&L, notifications, watchlists). Charts: `dashboard-chart-*.js` on `openalgo-charts` through `openalgo-charts-bridge.js`.
- Quick order: `quick-order-*.js`. Strategies: `strategy-builder.js`. Settings: `settings-*.js`, rendered from the registry schema.
- `service-worker.js` is network-first for `/js`, `/css` and `/vendor`, keeps one cached copy per path, and deletes old caches on activate.
- Cache busting: after changing any file under `public/js` or `public/css`, bump its `?v=` in the HTML that loads it.
- Dashboard toggles read the DOM, not a cached Set.

## 10. Testing

| Layer | Command | Runs against | When |
|---|---|---|---|
| Unit | `npm run test:unit` | Pure logic | Always |
| Services | `npm run test:services` | Service logic on a real SQLite copy | Always |
| Logic (unit + services) | `npm run test:logic` | Offline | After every change, with `npm run lint` |
| Integration | `npm run test:integration` | Routers through the real middleware stack, **real brokers** in analyzer mode | At phase gates only; serial |
| E2E | `npm run test:e2e` | Playwright on a booted server, real brokers, `database/e2e.db` copy | At phase gates only |
| Live | `npm run test:live` | Opt-in order tests on the test instances | At phase gates only |

Rules:

- `node:test`, supertest and Playwright only. Test scripts set `TELEGRAM_BOT_TOKEN=` so tests never message the operator.
- Tests never write `database/simplifyed.db`. `scripts/prepare-test-db.js` builds `database/test.db` from migrations.
- Test instances: Kotak **3**, Fyers **6**, Maha **19**, Ana **20**, Delta **26**. All must be in analyzer mode before a broker suite runs. Live tests must leave nothing open (no positions, no resting orders).
- Never print the webhook token in test output.
- Validation failures return 422.

## 11. Operations

- `install.sh` provisions the server and writes `backend/.env`; `update.sh` pulls, runs `npm ci` (which regenerates `public/vendor`), and reports keys missing from `.env`; `uninstall-instance.sh` removes one instance.
- First admin: `POST /api/v1/auth/register` (closes once any user exists). Password reset: `npm run set-password -- <email> <new-password>`.
- Webhook token rotation: Settings, Access Control, Rotate token. The new token overrides the `.env` value from then on.
