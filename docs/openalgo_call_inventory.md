# OpenAlgo Call Inventory

Step 1 of the rate‑limit project documents every place where the application talks to OpenAlgo today. The table below groups the calls by feed/action so we know which ones must move behind the shared caching/polling service later.

## Legend

| Feed | Description |
| --- | --- |
| Quotes | LTP/quote/depth style data |
| Book | Position book / order book / funds |
| Symbol | Instruments / search / validation |
| Options | Expiry, option chain, quick order resolution |
| Orders | Order placement / cancellation / close positions |
| Admin | Ping/analyzer toggles/health |

## Call Inventory

| File | Function / Path | Feed | Notes + cadence |
| --- | --- | --- | --- |
| `routes/v1/positions.js` | `GET /positions/:instanceId` (`getPositionBook`) | Book | On-demand when user opens an instance positions view. |
|  | `GET /positions/:instanceId/pnl` → `pnlService` | Book | P&L fetch includes tradebook/positionbook/funds via service. |
|  | `POST /positions/:instanceId/close` (`closePosition`) | Orders | Issued when user clicks “Close all positions”. |
| `routes/v1/symbols.js` | `GET /symbols/quotes` (`getQuotes`) | Quotes | Called from dashboard watchlist polling. |
|  | `GET /symbols/expiry` (`getExpiry`) | Options | Used when configuring symbols. |
|  | `GET /symbols/option-chain` (`getOptionChain`) | Options | Used in option leg UI. |
| `services/polling.service.js` | `pollMarketData` (`getQuotes`) | Quotes | Background auto-refresh for watchlists (currently per user). |
| `services/positions.service.js` | `_fetchInstancePositions` (`getPositionBook`) | Book | Server side aggregator for `/positions/all`. Called every 10 s per active instance. |
| `services/order.service.js` | `placeOrder`, `cancelOrder`, `cancelAllOrders`, `getOrderBook` | Orders | Direct OpenAlgo writes/reads for manual orders. |
| `services/quick-order.service.js` | `placeSmartOrder`, `getOpenPosition`, `getPositionBook`, `getQuotes`, `searchSymbols`, `getOptionChain`, `getExpiry`, `closePosition` | Orders/Book/Options | Heavily used when executing quick orders, including FLOAT_OFS reductions and EXIT_ALL. |
| `services/options-resolution.service.js` | `getOptionChain`, `searchSymbols` | Options/Symbol | Called whenever we resolve strikes/expiries. |
| `services/expiry-management.service.js` | `getExpiry` | Options | Weekly refresh + on-demand fallback. |
| `services/pnl.service.js` | `getTradeBook`, `getPositionBook`, `getFunds` | Book | Used for P&L widgets; runs whenever `/positions/aggregate/pnl` is hit. |
| `services/dashboard.service.js` | `getFunds` | Book | For cards on the dashboard view. |
| `services/instruments.service.js` | `getInstruments` | Symbol | Import pipeline + manual refresh CLI hitting each exchange. |
| `services/symbol-validation.service.js` | `searchSymbols`, `getSymbol` | Symbol | During watchlist symbol search/validation. |
| `services/order-monitor.service.js` | `getPositionBook` | Book | Analyzer/TSL monitor uses it on a schedule. |
| `services/instance.service.js` | `ping`, `getAnalyzerStatus`, `getFunds`, `getTradeBook`, `getPositionBook`, `closePosition`, `cancelAllOrders`, `toggleAnalyzer`, `testConnection`, `getFunds (test)`, `getPositionBook (verify)` | Admin/Book/Orders | Instance health checks plus admin actions. |
| `services/polling.service.js` | `getQuotes` | Quotes | Secondary mention: used for per-watchlist instance polling. |

## Observations

1. **Quotes are fetched in multiple places**: watchlist views (front-end), `polling.service`, quick-order expiry resolution, and dashboard cards. All of these should go through one cache keyed by market-data instance.
2. **Position Book is the busiest “Book” call**: `positions.service`, `quick-order.service`, `pnl.service`, instance admin pages, analyzer services. We need per-instance caches plus invalidation hooks (e.g., after quick-order placements).
3. **Option-chain & expiry calls** currently happen per browser interaction. Those should be cached centrally with TTLs since expiry lists change slowly.
4. **Order placement/cancellation** must stay real-time but should notify the feed service to refresh caches (positions/orders) immediately.
5. **Health/ping calls** (`instance.service`) can stay direct but should throttle (e.g., every 60 s) and share results with the dashboard so multiple admins don’t trigger concurrent pings.

This inventory will drive the implementation of the market-data feed service: each feed type above becomes a polling loop (with per-instance configuration) plus cached accessors for the REST layer. Next step: design and wire up the feed service itself.
