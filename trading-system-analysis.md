# Trading System Order Tracking & Trade Monitoring Analysis

## Executive Summary

This document provides a comprehensive analysis of the order tracking and trade monitoring system in the Simplifyed trading platform. The system is built on **Node.js** with **SQLite** database, integrating with **OpenAlgo broker API** using a multi-service architecture with interval-based polling for real-time monitoring.

## System Architecture Overview

### Core Services

1. **AutoExitService** (`auto-exit.service.js`)
   - Monitors positions and triggers automated exits
   - Runs every 5 seconds
   - Handles live trading instances (non-analyzer mode)

2. **OrderMonitorService** (`order-monitor.service.js`)
   - Monitors analyzer mode instances for target hits
   - Runs every 5 seconds
   - Simulates exits and logs to `analyzer_trades` table

3. **RiskControlsService** (`risk-controls.service.js`)
   - Evaluates exit conditions (target, stop loss, trailing)
   - Maintains trailing stop loss state in memory
   - Supports per-mode configurations (Direct, Futures, Options)

4. **MarketDataFeedService** (`market-data-feed.service.js`)
   - Centralized caching for quotes, positions, orders, funds
   - Dynamic interval: 5s active / 10s idle
   - HTTP/2 multiplexing for parallel requests

5. **PollingService** (`polling.service.js`)
   - Orchestrates periodic updates
   - Instance polling: Every 15 seconds
   - Health checks: Every 5 minutes

---

## Order Tracking System

### 1. Order Placement Flow

**Entry Point**: `order.service.js:32` - `placeOrder()`

```javascript
// User places order via API
POST /api/v1/orders

// Order is placed using placesmartorder (position-aware)
const response = await orderPlacementService.placeSmartOrder(instance, orderData);

// Order saved to database
INSERT INTO watchlist_orders (
  watchlist_id, instance_id, symbol, exchange,
  side, quantity, order_type, status, order_id
)
```

**Order Status Mapping** (`order.service.js:529`):
```javascript
const statusMap = {
  'open': 'open',
  'pending': 'pending',
  'complete': 'complete',
  'cancelled': 'cancelled',
  'rejected': 'rejected',
  'trigger pending': 'pending',
  'partially filled': 'open'
};
```

### 2. Order Status Synchronization

**Service**: `PollingService` (runs every 15 seconds)

**Process**:
1. Fetches all active instances
2. Calls `orderService.syncOrderStatus(instanceId)` for each
3. Retrieves orderbook from OpenAlgo
4. Updates local database with broker order status

**Order Status Update Logic** (`order.service.js:456-523`):
```javascript
async syncOrderStatus(instanceId) {
  // Get orderbook from broker
  const orderbook = await openalgoClient.getOrderBook(instance);

  // Get pending orders from database
  const pendingOrders = await db.all(
    `SELECT * FROM watchlist_orders
     WHERE instance_id = ? AND status IN ('pending', 'open')`,
    [instanceId]
  );

  // Match and update
  for (const dbOrder of pendingOrders) {
    const brokerOrder = orderbook.find(
      o => o.orderid === dbOrder.order_id
    );

    if (brokerOrder) {
      const status = this._mapOrderStatus(brokerOrder.status);
      await db.run(
        `UPDATE watchlist_orders
         SET status = ?, broker_order_id = ?, metadata = ?
         WHERE id = ?`,
        [status, brokerOrder.orderid, JSON.stringify(brokerOrder), dbOrder.id]
      );
    }
  }
}
```

### Database Schema

**watchlist_orders table** (`000_initial_schema.js:146-178`):
```sql
CREATE TABLE watchlist_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL,
  instance_id INTEGER NOT NULL,
  symbol_id INTEGER,

  -- Order details
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  order_type TEXT NOT NULL,
  product_type TEXT NOT NULL,
  price REAL,
  trigger_price REAL,

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending',
  order_id TEXT,
  broker_order_id TEXT,
  message TEXT,
  metadata TEXT,

  -- Timestamps
  placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Trade Monitoring System

### 1. Market Data Feed Architecture

**Service**: `market-data-feed.service.js`

**Dynamic Intervals**:
- **Active** (positions open): 5 seconds
- **Idle** (no positions): 10 seconds

**Cache Layers**:
- Instance-level snapshots
- Symbol-level cache
- TTL: 5s display, 3s order-critical

**Position Refresh Flow** (`market-data-feed.service.js:409-455`):
```javascript
async refreshPositions({ force = false }) {
  const instances = await instanceService.getAllInstances({ is_active: true });

  for (const inst of instances) {
    // Check TTL
    const now = Date.now();
    const last = this.positionRefreshTimestamps.get(instanceId);
    const ttlMs = this._getStatefulTtlMs('positions'); // 5s active / 10s idle

    if (!force && now - last < ttlMs) {
      return; // Skip - TTL not expired
    }

    // Fetch position book
    const positionBook = await openalgoClient.getPositionBook(instance);

    // Cache result
    this.setPositionSnapshot(instanceId, positionBook);
    this.positionRefreshTimestamps.set(instanceId, now);
  }
}
```

### 2. Position Detection Logic

**Location**: `market-data-feed.service.js:1302-1320`

```javascript
_detectOpenPositions() {
  for (const [instanceId, snapshot] of this.positionCache.entries()) {
    for (const position of snapshot.data) {
      const netQty = this._getPositionNetQuantity(position);
      if (netQty !== 0) {
        return true; // Open position detected
      }
    }
  }
  return false;
}
```

---

## Auto-Exit Mechanisms

### 1. Auto-Exit Service Architecture

**Service**: `auto-exit.service.js`
- **Monitoring Interval**: Every 5 seconds
- **Scope**: All active (non-analyzer) instances
- **Prevents Duplicates**: 30-second pending exit lock

### 2. Complete Auto-Exit Workflow

```
┌─────────────────────────────────────────────────────────┐
│ 1. Auto-Exit Service Starts (server.js)                 │
│    └─ Runs every 5 seconds                              │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 2. Build Auto-Exit Configuration Lookup                 │
│    From: watchlist_symbols table                        │
│    Fields: target_points_*                              │
│            stoploss_points_*                            │
│            trailing_stoploss_points_*                   │
│            trailing_activation_points_*                 │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Monitor Each Active Instance                         │
│    For each instance with is_active = 1                 │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 4. Get Position Snapshot                                │
│    Source: marketDataFeedService.getPositionSnapshot()  │
│    Cache TTL: 5s active / 10s idle                      │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ 5. For Each Position (non-zero quantity)                │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
    ┌───────────────────────────────────────────┐
    │ 6. Resolve Entry Price (Multi-Layer Fallback) │
    └────────────────┬──────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 1: Position average_price              │
    │ Source: position.average_price               │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 2: Tradebook FIFO Calculation          │
    │ Process:                                     │
    │   - Get all trades for symbol                │
    │   - Sort by timestamp                        │
    │   - Match BUY/SELL to calculate remaining    │
    │   - Ignore dummy prices (0, 100)             │
    │   - Calculate weighted average               │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 3: Fallback Entry Price Cache          │
    │ Captured: During order placement             │
    │ TTL: 20 seconds grace period                 │
    │ Condition: Must be confirmed                 │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 4: Cross-Instance Median LTP           │
    │ Fallback: Last resort                        │
    │ Logic: Median LTP from instances with        │
    │        valid entry prices                    │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ 7. Resolve Current Price (LTP)               │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 1: Position LTP                        │
    │ Source: position.ltp                         │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 2: Cached Quotes (order-critical TTL)  │
    │ TTL: 3 seconds                               │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ Layer 3: Live LTP Fetch                      │
    │ Method: marketDataFeedService.fetchLtpForSymbol │
    │ Retry: 2 rounds across instances             │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ 8. Check Pending Exit (Duplicate Prevention)│
    │ Key: instanceId:exchange:symbol              │
    │ TTL: 30 seconds                              │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ 9. Evaluate Exit Conditions                  │
    │ Service: riskControlsService.evaluateExit()  │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │ 10. Trigger Exit if Threshold Met            │
    │ Service: quickOrderService.closePosition()   │
    │ Status: Mark as pending for 30s              │
    └────────────────┬────────────────────────────┘
                     │
                     ▼
                 [END]
```

### 3. Risk Controls Evaluation

**Service**: `risk-controls.service.js:13-56`

```javascript
evaluateExit({ key, side, currentPrice, entryPrice, configEntry, symbol }) {
  // Determine mode: direct/futures/options
  const mode = this._determineMode(configEntry, symbol);

  // Get thresholds for mode
  const thresholds = this._getThresholds(configEntry, mode);
  if (!thresholds) return { mode, reason: null };

  // Calculate target and stop prices
  const direction = side === 'LONG' ? 1 : -1;
  const targetPrice = thresholds.targetPoints
    ? entryPrice + direction * thresholds.targetPoints
    : null;
  const stopPrice = thresholds.stoplossPoints
    ? entryPrice - direction * thresholds.stoplossPoints
    : null;

  // Evaluate trailing stop loss
  const trailingHit = this._evaluateTrailing(
    key, side, currentPrice, entryPrice,
    thresholds.trailingPoints,
    thresholds.trailingActivationPoints
  );

  // Check target and stop loss
  const targetHit = targetPrice && (
    (side === 'LONG' && currentPrice >= targetPrice) ||
    (side === 'SHORT' && currentPrice <= targetPrice)
  );
  const stopHit = stopPrice && (
    (side === 'LONG' && currentPrice <= stopPrice) ||
    (side === 'SHORT' && currentPrice >= stopPrice)
  );

  // Return reason
  let reason = null;
  if (targetHit) reason = 'TARGET_MET';
  else if (stopHit) reason = 'STOPLOSS_HIT';
  else if (trailingHit) reason = 'TSL_HIT';

  return { mode, reason };
}
```

### 4. Trailing Stop Loss Logic

**Service**: `risk-controls.service.js:68-108`

```javascript
_evaluateTrailing(key, side, currentPrice, entryPrice, trailingPoints, activationPoints) {
  if (!trailingPoints) return false;

  const profit = side === 'LONG'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;

  // Initialize or get trailing state
  const state = this.trailingState.get(key) || {
    highest: currentPrice,
    lowest: currentPrice,
    activated: !activationPoints // Immediate activation if no threshold
  };

  // Update highest/lowest
  state.highest = Math.max(state.highest, currentPrice);
  state.lowest = Math.min(state.lowest, currentPrice);

  // Check activation threshold
  if (activationPoints && !state.activated) {
    if (profit >= activationPoints) {
      state.activated = true;
      log.debug('Trailing activation reached', { key, profit, activationPoints });
    } else {
      this.trailingState.set(key, state);
      return false;
    }
  }

  // Calculate trailing trigger
  if (side === 'LONG') {
    const trigger = state.highest - trailingPoints;
    this.trailingState.set(key, state);
    return currentPrice <= trigger;
  } else {
    const trigger = state.lowest + trailingPoints;
    this.trailingState.set(key, state);
    return currentPrice >= trigger;
  }
}
```

### 5. Exit Execution

**Service**: `auto-exit.service.js:240-269`

```javascript
async _executeAutoExit(instance, position, mode, reason = 'AUTO_EXIT') {
  const positionSymbol = position.symbol || position.tradingsymbol;
  const positionExchange = position.exchange;
  const quantity = Math.abs(this._getPositionQuantity(position));
  const tradeMode = TRADE_MODE_MAP[mode] || 'FUTURES';

  try {
    await quickOrderService.closePosition(
      instance,
      { symbol: positionSymbol, exchange: positionExchange },
      { tradeMode, product, strategy: reason }
    );

    log.info('Auto-exit triggered', {
      instance_id: instance.id,
      symbol: positionSymbol,
      reason,
    });
  } catch (error) {
    log.warn('Auto-exit close failed', { error: error.message });
  }
}
```

---

## Database Schema for Auto-Exit Configuration

### watchlist_symbols Table Extensions

**Migration 015**: Auto-exit configuration (`015_watchlist_symbol_auto_exits.js`)

```sql
-- Per-mode target/stop/trailing configurations
ALTER TABLE watchlist_symbols ADD COLUMN target_points_direct REAL;
ALTER TABLE watchlist_symbols ADD COLUMN stoploss_points_direct REAL;
ALTER TABLE watchlist_symbols ADD COLUMN trailing_stoploss_points_direct REAL;

ALTER TABLE watchlist_symbols ADD COLUMN target_points_futures REAL;
ALTER TABLE watchlist_symbols ADD COLUMN stoploss_points_futures REAL;
ALTER TABLE watchlist_symbols ADD COLUMN trailing_stoploss_points_futures REAL;

ALTER TABLE watchlist_symbols ADD COLUMN target_points_options REAL;
ALTER TABLE watchlist_symbols ADD COLUMN stoploss_points_options REAL;
ALTER TABLE watchlist_symbols ADD COLUMN trailing_stoploss_points_options REAL;
```

**Migration 016**: Trailing activation thresholds (`016_watchlist_symbol_trailing_activation.js`)

```sql
-- Trailing activation points (profit required before trailing starts)
ALTER TABLE watchlist_symbols ADD COLUMN trailing_activation_points_direct REAL;
ALTER TABLE watchlist_symbols ADD COLUMN trailing_activation_points_futures REAL;
ALTER TABLE watchlist_symbols ADD COLUMN trailing_activation_points_options REAL;
```

### Order Monitor Log Table

**Migration 008**: `order_monitor_log` (`008_add_order_monitoring.js`)

```sql
CREATE TABLE order_monitor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,

  -- Trigger details
  trigger_type TEXT NOT NULL,
  entry_price REAL NOT NULL,
  trigger_price REAL NOT NULL,
  target_value REAL NOT NULL,
  exit_quantity INTEGER NOT NULL,

  -- Analyzer mode
  is_analyzer_mode BOOLEAN DEFAULT 0,
  simulated_pnl REAL,

  -- Live mode
  exit_order_id TEXT,
  exit_status TEXT,
  error_message TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (instance_id) REFERENCES instances (id)
);
```

---

## Complete Workflows with Examples

### Scenario 1: Long Position with Target and Stop Loss

**Setup**:
- Symbol: `RELIANCE` (NSE)
- Entry: 2500 (BUY 100 qty)
- Target: +50 points (2550)
- Stop Loss: -30 points (2470)
- Mode: `direct`

**Workflow Timeline**:

```
T+0s: Order placed
  ├─ Order saved to watchlist_orders table
  └─ Entry price captured in fallback cache

T+5s: Auto-exit cycle starts
  ├─ Gets position snapshot (qty: 100, avg: 2500, ltp: 2505)
  ├─ Resolve entry price: 2500 (from position average)
  └─ Resolve current price: 2505 (from position ltp)

T+10s: Price moves to 2552
  ├─ Current price: 2552
  ├─ Target price: 2500 + 50 = 2550
  ├─ Target hit? YES (2552 >= 2550)
  └─ Action: Execute SELL order for 100 qty
     └─ Log: TARGET_MET

T+15s: Position closed
  └─ Pending exit cleared
```

### Scenario 2: Short Position with Trailing Stop Loss

**Setup**:
- Symbol: `BANKNIFTY` (NSE)
- Entry: 45,000 (SELL 50 qty)
- Trailing: 100 points
- Activation: 50 points profit
- Mode: `futures`

**Workflow Timeline**:

```
T+0s: Short position entered
  ├─ Position: qty: -50, avg: 45000
  └─ Trailing state initialized: { highest: 45000, lowest: 45000, activated: false }

T+5s: Price drops to 44900 (100 pts profit)
  ├─ Profit: 45000 - 44900 = 100
  ├─ Activation threshold: 50 pts
  ├─ Activated? YES
  ├─ Update state: { highest: 44900, activated: true }
  └─ Trailing trigger: 44900 - 100 = 44800

T+10s: Price drops further to 44850
  ├─ Current price: 44850
  ├─ New highest: 44850 (since SHORT, we track lowest)
  ├─ Update state: { lowest: 44850, activated: true }
  └─ New trigger: 44850 + 100 = 44950

T+15s: Price rebounds to 44960
  ├─ Current price: 44960
  ├─ Trigger: 44950
  ├─ Trailing hit? YES (44960 >= 44950)
  └─ Action: Execute BUY order to cover
     └─ Log: TSL_HIT
```

### Scenario 3: Entry Price Resolution via Tradebook

**Setup**:
- Broker doesn't provide average_price in position
- Multiple partial fills

**Workflow**:

```
Order 1: BUY 50 @ 2500
Order 2: BUY 30 @ 2510
Order 3: BUY 20 @ 2495

Total: 100 qty

Auto-exit needs entry price:
├─ Layer 1: position.average_price → NULL (broker doesn't provide)
├─ Layer 2: Tradebook FIFO
│  ├─ Sort trades by timestamp
│  ├─ Calculate weighted average:
│  │  (50×2500 + 30×2510 + 20×2495) / 100
│  │  = 2502
│  └─ Result: 2502
└─ Entry price: 2502
```

---

## Fallback Mechanisms

### 1. Price Resolution Fallbacks

**Current Price (LTP)** (`auto-exit.service.js:411-459`):

```javascript
async _resolveCurrentPrice(position, rawExchange, rawSymbol, instanceId) {
  // Layer 1: Position LTP
  let currentPrice = extractLtp(position);
  if (currentPrice && currentPrice > 0) {
    return { price: currentPrice, source: 'position_ltp' };
  }

  // Layer 2: Cached quotes (3s TTL for order-critical)
  const { cached } = marketDataFeedService.getCachedQuotesForSymbols(
    [{ exchange: rawExchange, symbol: rawSymbol }],
    { orderCritical: true }
  );
  if (cached?.length) {
    currentPrice = extractLtp(cached[0]);
    return { price: currentPrice, source: 'cached_quote' };
  }

  // Layer 3: Live fetch (2 rounds, multi-instance)
  const ltpResult = await marketDataFeedService.fetchLtpForSymbol(
    rawExchange, rawSymbol, { maxRounds: 2 }
  );
  return { price: ltpResult.ltp, source: 'live_fetch' };
}
```

**Entry Price** (`auto-exit.service.js:286-409`):

```javascript
// Layer 1: Position average
let entryPrice = extractAveragePrice(position);

// Layer 2: Tradebook FIFO
if (!entryPrice) {
  entryPrice = this._resolveEntryPriceFromTrades(
    tradebook, symbol, exchange, side, quantity
  );
}

// Layer 3: Fallback cache
if (!entryPrice) {
  const cachedEntry = marketDataFeedService.getFallbackEntryPrice(
    instance.id, exchange, symbol
  );
  if (cachedEntry?.price) {
    entryPrice = cachedEntry.price;
  }
}

// Layer 4: Cross-instance median LTP
if (!entryPrice) {
  entryPrice = await this._resolveCrossInstanceMedianLtp(symbol, exchange);
}

// Guard: Defer if provisional fallback (< 20s old)
if (entryPrice && isFromFallbackCache && !confirmed) {
  if (Date.now() - capturedAt < 20000) {
    log.info('Auto-exit deferring: provisional fallback entry price');
    return; // Defer evaluation
  }
}
```

### 2. Circuit Breaker Pattern

**Service**: `market-data-feed.service.js:1010-1060`

```javascript
_shouldSkipPolling(key) {
  const state = this.failureState.get(key);
  if (!state) return false;

  // Check if in cooldown
  if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
    return true; // Skip polling
  }
  return false;
}

_recordFailure(key, error) {
  const state = this.failureState.get(key) || { failures: 0 };

  state.failures += 1;

  // Open circuit after 3 failures
  if (state.failures >= this.failureThreshold) {
    const jitter = Math.random() * this.cooldownJitterMs;
    state.cooldownUntil = Date.now() + this.cooldownMs + jitter;

    log.warn('Opened circuit breaker', { key, cooldownMs: this.cooldownMs });
  }

  this.failureState.set(key, state);
}
```

**Cooldown Periods**:
- **Normal failures**: 5 minutes
- **DNS/HTML errors**: 2 minutes (max 3 retries, then manual refresh)
- **Rate limiting**: Exponential backoff

### 3. Rate Limiting

**Service**: `openalgo/client.js:87-96`

```javascript
// Per-instance limits
this.rpsLimitPerInstance = 5;      // 5 requests/second
this.rpmLimitPerInstance = 300;    // 300 requests/minute
this.ordersPerSecondLimit = 10;    // 10 orders/second

// Rate limit check
_checkRateLimit(instance, requestType) {
  const now = Date.now();
  const key = instance.id;

  // Get or create rate limit state
  let state = this.instanceRate.get(key) || { rps: [], rpm: [], orders: [] };

  // Clean old timestamps (>1 min for RPM)
  state.rpm = state.rpm.filter(ts => now - ts < 60000);

  // Check limits
  if (state.rpm.length >= this.rpmLimitPerInstance) {
    throw new Error('RPM limit exceeded');
  }

  // Record request
  state.rpm.push(now);
  this.instanceRate.set(key, state);
}
```

### 4. Data Freshness TTLs

**Market Data Feed** (`market-data-feed.service.js:999-1008`):

```javascript
_getStatefulTtlMs(feed) {
  const activeTtl = 5000;  // 5s when positions open
  const idleTtl = 10000;   // 10s when no positions

  if (feed === 'positions' || feed === 'orderbook' || feed === 'tradebook') {
    return this.hasOpenPositions ? activeTtl : idleTtl;
  }

  return this.QUOTE_TTL_MS; // 5s default
}
```

**Order-Critical TTL**: 3 seconds (aggressive for exit triggers)
**Display TTL**: 5 seconds (relaxed for UI)

---

## Price Extraction Utilities

### extractLtp() - Last Traded Price

**Location**: `price-extraction.js:15-87`

```javascript
export function extractLtp(data) {
  if (!data) return null;

  // Primary candidates: various LTP field names (most reliable)
  const primaryCandidates = [
    data.ltp, data.LTP, data.last_price, data.lastPrice,
    data.last_traded_price, data.lastTradedPrice,
    data.ltp_value, data.ltpValue,
  ];

  for (const value of primaryCandidates) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Fallback 1: use mid-price (bid + ask) / 2 if both are valid and non-zero
  const bid = parseFloat(data.bid);
  const ask = parseFloat(data.ask);

  if (!isNaN(bid) && bid > 0 && !isNaN(ask) && ask > 0) {
    const midPrice = (bid + ask) / 2;
    return midPrice;
  }

  // Fallback 2: use bid or ask alone
  if (!isNaN(bid) && bid > 0) return bid;
  if (!isNaN(ask) && ask > 0) return ask;

  // Fallback 3: use close, prev_close, open, high, low
  const secondaryCandidates = [
    data.close, data.prev_close, data.prevClose,
    data.previous_close, data.previousClose,
    data.open, data.high, data.low, data.price,
  ];

  for (const value of secondaryCandidates) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}
```

### extractAveragePrice() - Entry Price

**Location**: `price-extraction.js:94-117`

```javascript
export function extractAveragePrice(position) {
  if (!position) return null;

  const candidates = [
    position.average_price, position.averagePrice,
    position.avg_price, position.avgPrice,
    position.avgprice, position.open_price,
    position.openPrice, position.entry_price,
    position.entryPrice,
  ];

  for (const value of candidates) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}
```

---

## Potential Issues & Root Causes

### Issue 1: Automated Exit Orders Not Triggering

**Symptoms**:
- Target/stop loss not hit even when price crosses threshold
- No logs in `order_monitor_log` table
- Position remains open

**Possible Causes**:

#### A. Entry Price Not Resolved
**Root Cause**: Fallback entry price is provisional (< 20s old)
**Location**: `auto-exit.service.js:179-195`

```javascript
// This guard prevents exit evaluation if fallback entry is too new
if (
  entryPrice &&
  entryPriceSource?.startsWith('fallback_cache') &&
  !entryFallbackMeta?.confirmed &&
  Date.now() - entryFallbackMeta.capturedAt < 20000 // 20s grace
) {
  log.info('Auto-exit deferring: provisional fallback entry price');
  return; // Skips evaluation
}
```

**Solution**: Wait 20 seconds after position open, or ensure broker provides average_price

#### B. Pending Exit Blocking
**Root Cause**: Exit already triggered, waiting for completion
**Location**: `auto-exit.service.js:559-567`

```javascript
_isPendingExit(key) {
  const timestamp = this.pendingExits.get(key);
  if (!timestamp) return false;

  // Clear after 30 seconds
  if (Date.now() - timestamp > 30 * 1000) {
    this.pendingExits.delete(key);
    return false;
  }
  return true; // Block re-evaluation
}
```

**Check**: Look for pending exits in logs:
```bash
grep "pending exit" logs | tail -20
```

#### C. Configuration Not Found
**Root Cause**: Symbol not in watchlist or auto-exit config missing
**Location**: `auto-exit.service.js:494-513`

```javascript
_findConfig(symbol, exchange, lookup) {
  const directKey = `${exchange}:${symbol}`;

  // Try exact match
  if (lookup.has(directKey)) {
    return lookup.get(directKey)?.[0] || null;
  }

  // Try underlying match (for derivatives)
  for (const rows of lookup.values()) {
    for (const row of rows) {
      const underlying = row.underlying_symbol;
      if (symbol.startsWith(underlying)) {
        return row;
      }
    }
  }

  return null; // No config found
}
```

**Solution**: Verify symbol exists in `watchlist_symbols` with auto-exit settings

#### D. Circuit Breaker Open
**Root Cause**: Market data feed in cooldown
**Location**: `market-data-feed.service.js:1010-1025`

```javascript
_shouldSkipPolling(key) {
  const state = this.failureState.get(key);
  if (!state) return false;

  if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
    return true; // Skipping refresh
  }
  return false;
}
```

**Check**: Look for circuit breaker logs:
```bash
grep -i "circuit breaker\|cooldown" logs | tail -10
```

**Solution**:
- Check instance health: `GET /api/v1/instances/:id/health`
- Manually refresh: `POST /api/v1/instances/:id/refresh`

#### E. Price Resolution Failed
**Root Cause**: All price fallback layers exhausted
**Location**: `auto-exit.service.js:197-207`

```javascript
if (!currentPrice || !entryPrice) {
  log.error('Auto-exit skipped: unable to resolve price data', {
    instance_id: instance.id,
    symbol: symbol,
    entry_source: entryPriceSource,
    ltp_source: currentPriceSource,
  });
  return;
}
```

**Check**: Look for this error in logs

**Solution**: Verify market data instance is healthy and connected

#### F. Mode Determination Failed
**Root Cause**: Symbol doesn't match any mode pattern
**Location**: `risk-controls.service.js:122-138`

```javascript
_determineMode(entry, symbol) {
  const normalizedSymbol = (symbol || '').toUpperCase();

  // Options: Contains CE or PE
  if (normalizedSymbol.includes('CE') || normalizedSymbol.includes('PE')) {
    return 'options';
  }

  // Futures: Contains FUT
  if (normalizedSymbol.includes('FUT')) {
    return 'futures';
  }

  // Direct: Everything else
  return 'direct';
}
```

**Solution**: Ensure symbol patterns are correct (e.g., `RELIANCE CE 2500` for options)

### Issue 2: Trailing Stop Loss Not Activating

**Symptoms**:
- Trailing stop loss configured but never triggers
- Price moves favorably then reverses without exit

**Possible Causes**:

#### A. Activation Threshold Not Met
**Root Cause**: Profit never reached activation points
**Location**: `risk-controls.service.js:84-91`

```javascript
if (activationPoints && !state.activated) {
  if (profit >= activationPoints) {
    state.activated = true;
  } else {
    this.trailingState.set(key, state);
    return false; // Not activated yet
  }
}
```

**Solution**: Lower activation threshold or verify entry price

#### B. Trailing State Not Persisted
**Root Cause**: Server restart clears in-memory state
**Location**: `risk-controls.service.js:10` (Map in memory)

```javascript
constructor() {
  this.trailingState = new Map(); // Lost on restart
}
```

**Solution**: Trailing state is per-session; ensure minimal restart during trading hours

#### C. Wrong Direction Calculation
**Root Cause**: Position side (LONG/SHORT) miscalculated
**Location**: `auto-exit.service.js:139`

```javascript
const side = positionQty > 0 ? 'LONG' : 'SHORT';
```

**Solution**: Verify position quantity is correctly parsed

### Issue 3: False Triggers / Premature Exits

**Symptoms**:
- Exit triggers too early
- Price briefly touches threshold then continues favorably

**Possible Causes**:

#### A. No Confirmation Required
**Root Cause**: System triggers on first touch without confirmation
**Location**: `risk-controls.service.js:41-48`

```javascript
const targetHit = targetPrice && (
  (side === 'LONG' && currentPrice >= targetPrice) ||
  (side === 'SHORT' && currentPrice <= targetPrice)
);
// Triggers immediately on touch
```

**Solution**: Add confirmation logic or widen thresholds

#### B. Stale Price Data
**Root Cause**: Using cached price beyond TTL
**Location**: `market-data-feed.service.js:283-303`

```javascript
getCachedQuotesForSymbols(symbols, options) {
  const ttlMs = options.ttlMs ?? (orderCritical ? 3000 : 5000);
  // Uses cached price if within TTL
}
```

**Solution**: Verify TTL settings and market data freshness

### Issue 4: Order Placement Fails After Trigger

**Symptoms**:
- Exit condition met and logged
- But position not closed
- No exit order placed

**Possible Causes**:

#### A. Quick Order Service Failure
**Root Cause**: Error in `quickOrderService.closePosition()`
**Location**: `auto-exit.service.js:240-269`

```javascript
try {
  await quickOrderService.closePosition(...);
} catch (error) {
  log.warn('Auto-exit close failed', { error: error.message });
  // Position remains open
}
```

**Check**: Look for "Auto-exit close failed" in logs

**Solution**: Debug quickOrderService for specific error

#### B. Duplicate Order Prevention
**Root Cause**: Order already exists for same symbol
**Location**: `quick-order.service.js`

**Check**: Verify no pending orders for symbol

#### C. Insufficient Margin/Funds
**Root Cause**: Broker rejects order due to insufficient funds
**Check**: `GET /api/v1/instances/:id/funds`

---

## Debugging Steps

### Step 1: Check Auto-Exit Configuration

```sql
SELECT
  symbol, exchange,
  target_points_direct, stoploss_points_direct, trailing_stoploss_points_direct,
  trailing_activation_points_direct
FROM watchlist_symbols
WHERE symbol = 'RELIANCE' AND exchange = 'NSE';
```

### Step 2: Verify Position Data

```sql
SELECT
  p.*,
  i.name as instance_name
FROM watchlist_positions p
JOIN instances i ON p.instance_id = i.id
WHERE p.symbol = 'RELIANCE' AND p.exchange = 'NSE'
  AND p.status = 'OPEN';
```

### Step 3: Check Recent Exit Triggers

```sql
SELECT * FROM order_monitor_log
WHERE symbol = 'RELIANCE' AND exchange = 'NSE'
ORDER BY created_at DESC
LIMIT 20;
```

### Step 4: Review Auto-Exit Logs

```bash
# Check for auto-exit evaluations
grep "Auto-exit evaluation" /var/log/app.log | tail -50

# Check for price resolution
grep "unable to resolve price" /var/log/app.log | tail -20

# Check for pending exits
grep "pending exit" /var/log/app.log | tail -20
```

### Step 5: Verify Market Data Feed

```javascript
// API to check market data freshness
GET /api/v1/market-data/quotes?symbol=RELIANCE&exchange=NSE

// Response includes fetchedAt timestamp
{
  "data": [...],
  "fetchedAt": 1704123456789
}
```

### Step 6: Test Price Resolution Manually

```javascript
// Use market data feed service directly
const ltp = await marketDataFeedService.fetchLtpForSymbol('NSE', 'RELIANCE');
console.log('LTP:', ltp);

// Check entry price resolution
const entry = marketDataFeedService.getFallbackEntryPrice(instanceId, 'NSE', 'RELIANCE');
console.log('Entry:', entry);
```

### Step 7: Monitor Real-Time Cycles

Enable debug logging for auto-exit:
```javascript
// In config
logging: {
  level: 'debug',
  filters: ['auto-exit', 'risk-controls']
}
```

Then watch logs:
```bash
tail -f /var/log/app.log | grep -E "Auto-exit|risk-controls"
```

---

## Summary of Critical Paths

### Order Tracking Path:
1. **Place Order** → `order.service.js:placeOrder()`
2. **Save to DB** → `watchlist_orders` table
3. **Poll Status** → `polling.service.js:pollAllInstances()` (every 15s)
4. **Sync with Broker** → `order.service.js:syncOrderStatus()`
5. **Update DB** → Status mapping and metadata

### Trade Monitoring Path:
1. **Refresh Positions** → `market-data-feed.service.js:refreshPositions()` (5-10s interval)
2. **Cache Positions** → In-memory snapshot with TTL
3. **Detect Open Positions** → Check net quantity != 0
4. **Adjust Interval** → 5s if open, 10s if idle

### Auto-Exit Path:
1. **Build Config Lookup** → From `watchlist_symbols` table
2. **Get Position Snapshot** → From cache or live fetch
3. **Resolve Entry Price** → 4-layer fallback (position → tradebook → cache → cross-instance)
4. **Resolve Current Price** → 3-layer fallback (position → cache → live)
5. **Evaluate Exit** → Target/Stop/Trailing via `risk-controls.service.js`
6. **Execute Exit** → Via `quickOrderService.closePosition()`
7. **Mark Pending** → 30-second cooldown to prevent duplicates

### Fallback Hierarchy:

**Entry Price**:
1. Position average_price
2. Tradebook FIFO calculation
3. Fallback cache (with 20s grace period)
4. Cross-instance median LTP

**Current Price (LTP)**:
1. Position LTP
2. Cached quotes (3s TTL)
3. Live fetch (2 rounds)

**Market Data**:
1. Cache (5s active / 10s idle)
2. Live fetch with retry
3. Circuit breaker on failure

---

## Monitoring & Alerting

### Key Metrics to Monitor

1. **Auto-Exit Cycle Duration**
   - Expected: < 100ms per instance
   - Alert if: > 500ms

2. **Price Resolution Success Rate**
   - Expected: > 99%
   - Alert if: < 95%

3. **Circuit Breaker Triggers**
   - Expected: < 5 per day
   - Alert if: > 10 per day

4. **Pending Exit Duration**
   - Expected: < 30 seconds
   - Alert if: > 60 seconds

### Log Analysis Queries

```bash
# Check auto-exit performance
grep "Auto-exit evaluation" app.log | \
  awk '{print $NF}' | sort | uniq -c | sort -rn

# Check price resolution failures
grep "unable to resolve price" app.log | \
  awk -F'symbol:' '{print $2}' | awk '{print $1}' | sort | uniq -c

# Check trailing stop activations
grep "Trailing activation reached" app.log | wc -l

# Check exit triggers by reason
grep "Auto-exit evaluation met threshold" app.log | \
  awk -F'reason:' '{print $2}' | awk '{print $1}' | sort | uniq -c
```

---

## Recommendations

### 1. Implement Confirmation Logic
Add a confirmation period (e.g., 5 seconds) before triggering exits to avoid false positives during volatile market conditions.

### 2. Persist Trailing State
Save trailing stop loss state to database to survive server restarts during trading hours.

### 3. Add Exit Order Status Tracking
Track exit order placement status in `order_monitor_log` to distinguish between trigger evaluation and order execution failures.

### 4. Implement Health Dashboard
Create a real-time dashboard showing:
- Auto-exit cycle status
- Price resolution health
- Circuit breaker states
- Pending exits

### 5. Add Granular Logging
Implement structured logging with correlation IDs to trace individual position monitoring lifecycles.

### 6. Test Fallback Mechanisms
Create automated tests for each fallback layer to ensure they work correctly under various failure scenarios.

---

## Conclusion

The trading system implements a robust multi-layered approach to order tracking and trade monitoring with comprehensive fallback mechanisms. The key to diagnosing issues is to trace through the fallback chain at each step to identify where the chain breaks.

The most common issues stem from:
1. Entry price resolution delays (20-second grace period)
2. Circuit breaker activations during market volatility
3. Configuration mismatches (symbol not in watchlist)
4. Rate limiting from broker APIs

Regular monitoring of the debug logs and health endpoints is essential for maintaining system reliability during live trading operations.
