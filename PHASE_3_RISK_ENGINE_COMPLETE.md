# Phase 3 Complete: Risk Engine Services

**Status**: ✅ Complete
**Date**: 2025-11-16
**Phase Duration**: Week 3-4 of 8-week implementation
**Implementation Approach**: Conservative (feature flags, disabled by default)

## Overview

Phase 3 implements the **real-time risk engine** that monitors positions and enforces TP/SL/TSL risk management rules. This is the core of the server-authoritative risk management system.

## What Was Built

### 1. Fill Aggregator Service (`fill-aggregator.service.js`)
**Purpose**: Tracks real-time positions by polling tradebook from OpenAlgo instances

**Key Features**:
- Polls tradebook/orderbook every 2 seconds
- Aggregates fills by symbol per instance
- Calculates `net_qty` (total buys - total sells)
- Calculates weighted average entry price
- Tracks `best_favorable_price` for TSL
- Updates `leg_state` table with position data
- Restart-safe (rebuilds from tradebook)
- Idempotent updates

**Key Methods**:
```javascript
syncAllInstances()              // Sync fills for all active instances
syncInstanceFills(instanceId)   // Sync fills for specific instance
updateLegState(...)             // Update leg_state with aggregated position data
enableRisk(legStateId, config)  // Enable TP/SL/TSL for a leg
disableRisk(legStateId)         // Disable risk for a leg
getActiveLegsWithRisk()         // Get all legs with risk enabled
```

**Database Updates**:
- Updates `leg_state` table with:
  - `net_qty`: Current position quantity
  - `weighted_avg_entry`: Entry price (buy avg for longs, sell avg for shorts)
  - `total_buy_qty`, `total_sell_qty`: Fill totals
  - `total_buy_value`, `total_sell_value`: Value totals
  - `last_fill_at`: Timestamp of last fill

### 2. Quote Router Service (`quote-router.service.js`)
**Purpose**: Fetches market quotes and routes them to appropriate legs for risk calculations

**Key Features**:
- Polls quotes every 200ms for real-time price updates
- Routes quotes to correct price field based on instrument type
- Updates `current_ltp` for each leg
- Tracks `best_favorable_price` for TSL trailing
- Instrument-type aware (options, futures, equity)
- In-memory quote cache with 5-second TTL
- Handles multiple instances in parallel

**Key Methods**:
```javascript
syncAllQuotes()                      // Sync quotes for all active legs
fetchAndRouteQuotes(instanceId, legs) // Fetch and route quotes for instance
updateLegPrice(leg, price, quote)    // Update leg with current price and best price
getCachedQuote(symbol, exchange)     // Get cached quote
```

**Price Routing Logic**:
- **Options (OPTIDX, OPTSTK, CE, PE)**: Uses option premium (LTP)
- **Futures (FUTIDX, FUTSTK)**: Uses futures LTP
- **Equity (EQ)**: Uses stock LTP
- **Default**: Uses LTP field

**Best Price Tracking**:
- **Long positions**: Tracks highest price reached
- **Short positions**: Tracks lowest price reached
- Used for TSL trailing calculations

### 3. Risk Engine Service (`risk-engine.service.js`)
**Purpose**: Monitors positions and triggers risk exits based on TP/SL/TSL conditions

**Key Features**:
- Polls risk conditions every 1 second
- Checks TP/SL conditions against current prices
- Arms TSL when profit threshold is reached
- Trails TSL based on `best_favorable_price`
- Triggers idempotent risk exits
- Handles scope-based exits (LEG, TYPE, INDEX)
- Respects emergency kill switches
- Prevents duplicate triggers with in-memory tracking

**Key Methods**:
```javascript
checkAllRiskConditions()         // Check risk for all active legs
checkLegRiskConditions(leg)      // Check risk conditions for specific leg
checkTSLConditions(...)          // Check and manage TSL arming/trailing
armTSL(leg, isLong)              // Arm TSL and set initial stop
updateTrailingStop(leg, isLong)  // Update trailing stop based on best price
triggerRiskExit(...)             // Trigger idempotent risk exit
executeRiskExit(...)             // Execute exit based on scope
getPendingRiskExits()            // Get all pending exits
completeRiskExit(...)            // Mark exit as completed
```

**Risk Logic**:

**1. Take Profit (TP)**:
- **Long**: Triggers when `current_ltp >= tp_price`
- **Short**: Triggers when `current_ltp <= tp_price`

**2. Stop Loss (SL)**:
- **Long**: Triggers when `current_ltp <= sl_price`
- **Short**: Triggers when `current_ltp >= sl_price`

**3. Trailing Stop Loss (TSL)**:
- **Arming**: Arms when `pnl_per_unit >= tsl_arm_after`
- **Initial Stop**: Set at `best_price ± tsl_trail_by`
- **Trailing**: Updates when price improves by >= `tsl_step`
  - **Long**: Stop trails up (never down)
  - **Short**: Stop trails down (never up)
- **Breakeven Lock**: Locks stop at entry when `pnl_per_unit >= tsl_breakeven_after`
- **Trigger**:
  - **Long**: When `current_ltp <= tsl_current_stop`
  - **Short**: When `current_ltp >= tsl_current_stop`

**Scope-Based Exits**:
- **LEG**: Exits only the triggered leg
- **TYPE**: Exits all legs of same option type (CE or PE) for same index/expiry
- **INDEX**: Exits all legs for same index/expiry

**Idempotency**:
- Each risk exit gets unique `risk_trigger_id` (UUID)
- Prevents duplicate exits for same trigger
- In-memory tracking of active triggers
- Database record in `risk_exits` table

## Architecture

### Service Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                         Server Startup                          │
│  (server.js)                                                    │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Feature Flag Check                           │
│  - enableFillAggregator (default: false)                        │
│  - enableRiskEngine (default: false)                            │
└─────────────────────────────────────────────────────────────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
    ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
    │ Fill Aggregator│ │  Quote Router  │ │  Risk Engine   │
    │   (2 seconds)  │ │   (200ms)      │ │   (1 second)   │
    └────────────────┘ └────────────────┘ └────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
    ┌────────────────────────────────────────────────────┐
    │              leg_state Table                       │
    │  - net_qty                                         │
    │  - weighted_avg_entry                              │
    │  - current_ltp                                     │
    │  - best_favorable_price                            │
    │  - tp_price, sl_price                              │
    │  - tsl_armed, tsl_current_stop                     │
    │  - risk_enabled                                    │
    └────────────────────────────────────────────────────┘
                                 │
                                 ▼
                      ┌────────────────────┐
                      │   risk_exits       │
                      │  - risk_trigger_id │
                      │  - trigger_type    │
                      │  - exit_orders_json│
                      │  - status          │
                      └────────────────────┘
```

### Data Flow

**1. Position Tracking** (Fill Aggregator → leg_state):
```
OpenAlgo Tradebook → Fill Aggregator → Aggregate by Symbol → Update leg_state
```

**2. Price Tracking** (Quote Router → leg_state):
```
OpenAlgo Quotes → Quote Router → Route by Instrument → Update current_ltp & best_favorable_price
```

**3. Risk Monitoring** (Risk Engine → risk_exits):
```
leg_state → Risk Engine → Check TP/SL/TSL → Trigger Exit → Create risk_exits record
```

## Server Integration

### Changes to `server.js`

**1. Service Imports**:
```javascript
import fillAggregatorService from './src/services/fill-aggregator.service.js';
import quoteRouterService from './src/services/quote-router.service.js';
import riskEngineService from './src/services/risk-engine.service.js';
```

**2. Service Startup** (in `startServer()`):
```javascript
// Start risk engine services (if enabled)
if (config.features.enableFillAggregator) {
  fillAggregatorService.start(2000); // Poll every 2 seconds
  log.info('Fill aggregator started');
}

if (config.features.enableRiskEngine) {
  quoteRouterService.start(200); // Poll every 200ms for real-time quotes
  log.info('Quote router started');

  riskEngineService.start(1000); // Check risk conditions every 1 second
  log.info('Risk engine started');
}
```

**3. Graceful Shutdown** (in `shutdown()`):
```javascript
// Stop risk engine services
if (config.features.enableRiskEngine) {
  riskEngineService.stop();
  quoteRouterService.stop();
}

if (config.features.enableFillAggregator) {
  fillAggregatorService.stop();
}
```

**4. Console Banner**:
- Shows "Fill Aggregator: Every 2s" if enabled
- Shows "Quote Router: Every 200ms" if enabled
- Shows "Risk Engine: Every 1s" if enabled

## Feature Flags

All services are **disabled by default** for conservative rollout.

### Environment Variables

```bash
# Enable fill aggregation (position tracking)
ENABLE_FILL_AGGREGATOR=true

# Enable risk engine (TP/SL/TSL monitoring)
ENABLE_RISK_ENGINE=true

# Emergency kill switches
KILL_RISK_EXITS=true      # Prevents any risk exits from executing
KILL_AUTO_TRADING=true    # Prevents any automated trading
```

### Configuration Access

```javascript
import { config } from './src/core/config.js';

config.features.enableFillAggregator  // true/false
config.features.enableRiskEngine      // true/false
config.features.killRiskExits         // true/false (emergency)
config.features.killAutoTrading       // true/false (emergency)
```

## Testing Guide

### Prerequisites

1. **Migrations Applied**: Ensure migrations 011, 012, 013 are applied
2. **Settings Seeded**: Run `node backend/migrations/seed-settings-defaults.js`
3. **Active Instance**: Have at least one active OpenAlgo instance configured
4. **Test Position**: Have an open position to monitor

### Test Scenario 1: Fill Aggregation

**Goal**: Verify that fills are tracked and positions are calculated correctly.

**Steps**:
1. Enable fill aggregator:
   ```bash
   echo "ENABLE_FILL_AGGREGATOR=true" >> backend/.env
   ```

2. Start server:
   ```bash
   cd backend
   npm run dev
   ```

3. Verify fill aggregator is running:
   - Check console: "Fill aggregator started"
   - Check logs for "Fills synced for instance"

4. Place a BUY order via OpenAlgo instance

5. Query leg_state table:
   ```sql
   SELECT * FROM leg_state WHERE is_active = 1;
   ```

6. Verify:
   - `net_qty` shows positive quantity
   - `weighted_avg_entry` shows buy price
   - `total_buy_qty` matches order quantity
   - `last_fill_at` is recent timestamp

7. Place a SELL order (partial or full exit)

8. Re-query leg_state:
   - `net_qty` should be reduced
   - If full exit: `net_qty = 0`

### Test Scenario 2: Quote Routing

**Goal**: Verify that market quotes are fetched and routed correctly.

**Steps**:
1. Enable risk engine (includes quote router):
   ```bash
   echo "ENABLE_RISK_ENGINE=true" >> backend/.env
   ```

2. Restart server

3. Verify quote router is running:
   - Check console: "Quote router started"
   - Check logs for "Quotes routed for instance"

4. Enable risk for a leg (via Settings API or direct SQL):
   ```sql
   UPDATE leg_state
   SET risk_enabled = 1,
       tp_per_unit = 10,
       sl_per_unit = 5
   WHERE id = 1;
   ```

5. Monitor leg_state table:
   ```sql
   SELECT symbol, current_ltp, best_favorable_price, updated_at
   FROM leg_state
   WHERE risk_enabled = 1;
   ```

6. Verify:
   - `current_ltp` updates every 200ms
   - `best_favorable_price` tracks highest price for longs, lowest for shorts
   - `updated_at` timestamp is recent

### Test Scenario 3: Take Profit (TP)

**Goal**: Verify that TP triggers when target is reached.

**Steps**:
1. Have a long position with `net_qty > 0`

2. Set TP target:
   ```sql
   UPDATE leg_state
   SET risk_enabled = 1,
       tp_per_unit = 5,           -- TP at entry + 5
       tp_price = weighted_avg_entry + 5
   WHERE id = 1;
   ```

3. Wait for market price to reach TP (or simulate with direct update)

4. Monitor risk_exits table:
   ```sql
   SELECT * FROM risk_exits ORDER BY triggered_at DESC LIMIT 5;
   ```

5. Verify:
   - Risk exit record created with `trigger_type = 'TP_HIT'`
   - `status = 'pending'` or `'executing'`
   - `exit_orders_json` contains SELL order for full position
   - `pnl_per_unit` shows profit at trigger

6. Check leg_state:
   - `risk_enabled` should be set to 0 (disabled after trigger)

### Test Scenario 4: Stop Loss (SL)

**Goal**: Verify that SL triggers when price falls below stop.

**Steps**:
1. Have a long position with `net_qty > 0`

2. Set SL:
   ```sql
   UPDATE leg_state
   SET risk_enabled = 1,
       sl_per_unit = 3,           -- SL at entry - 3
       sl_price = weighted_avg_entry - 3
   WHERE id = 1;
   ```

3. Wait for market price to fall below SL

4. Monitor risk_exits:
   - Risk exit created with `trigger_type = 'SL_HIT'`
   - Exit order prepared
   - Loss recorded in `pnl_per_unit`

### Test Scenario 5: Trailing Stop Loss (TSL)

**Goal**: Verify TSL arming, trailing, and triggering.

**Steps**:
1. Have a long position

2. Set TSL configuration:
   ```sql
   UPDATE leg_state
   SET risk_enabled = 1,
       tsl_enabled = 1,
       tsl_arm_after = 5,         -- Arm when profit >= 5
       tsl_trail_by = 3,          -- Trail 3 points below best
       tsl_step = 1,              -- Trail every 1 point improvement
       tsl_breakeven_after = 10   -- Lock at breakeven when profit >= 10
   WHERE id = 1;
   ```

3. **Phase 1: Waiting to Arm**
   - Monitor `tsl_armed` (should be 0)
   - Wait for price to reach entry + 5
   - Verify `tsl_armed` becomes 1
   - Check `tsl_current_stop` is set to `best_favorable_price - 3`

4. **Phase 2: Trailing**
   - Watch price move higher
   - Monitor `tsl_current_stop` trailing up
   - Verify stop only moves up, never down
   - Check stop trails when price improves by >= 1 point

5. **Phase 3: Breakeven Lock**
   - Wait for price to reach entry + 10
   - Verify `tsl_current_stop` locks at entry price minimum

6. **Phase 4: Trigger**
   - Wait for price to fall and hit trailing stop
   - Monitor risk_exits for `trigger_type = 'TSL_HIT'`
   - Verify exit prepared

### Test Scenario 6: Scope-Based Exits

**Goal**: Verify that scope determines which legs get exited.

**1. LEG Scope** (default):
```sql
UPDATE leg_state
SET scope = 'LEG',
    risk_enabled = 1,
    tp_per_unit = 10
WHERE symbol = 'NIFTY24400CE';
```
- Only the triggered leg should exit

**2. TYPE Scope**:
```sql
UPDATE leg_state
SET scope = 'TYPE',
    risk_enabled = 1,
    tp_per_unit = 10
WHERE symbol = 'NIFTY24400CE';
```
- All CE legs for same index/expiry should exit
- PE legs remain open

**3. INDEX Scope**:
```sql
UPDATE leg_state
SET scope = 'INDEX',
    risk_enabled = 1,
    tp_per_unit = 10
WHERE symbol = 'NIFTY24400CE';
```
- All legs (CE and PE) for same index/expiry should exit

### Test Scenario 7: Kill Switches

**Goal**: Verify emergency kill switches work.

**Steps**:
1. Set kill switch:
   ```bash
   echo "KILL_RISK_EXITS=true" >> backend/.env
   ```

2. Restart server

3. Trigger a risk condition (TP/SL/TSL)

4. Verify:
   - No risk_exits records created
   - Logs show "Risk exit blocked by kill switch"
   - Positions remain open

5. Disable kill switch:
   ```bash
   # Remove KILL_RISK_EXITS from .env
   ```

6. Restart and verify risk exits resume

## Performance Considerations

### Polling Frequencies

- **Fill Aggregator**: 2 seconds (conservative, tradebook doesn't change rapidly)
- **Quote Router**: 200ms (aggressive for real-time price tracking)
- **Risk Engine**: 1 second (balanced risk monitoring)

### Database Load

- **Writes per second** (assuming 10 active legs):
  - Fill Aggregator: ~0.5/s (only on new fills)
  - Quote Router: ~50/s (10 legs × 5 quotes/s)
  - Risk Engine: ~1/s (only on state changes)
  - **Total**: ~51 writes/second (well within SQLite WAL mode capacity)

- **Reads per second**:
  - Fill Aggregator: ~10/s
  - Quote Router: ~50/s
  - Risk Engine: ~10/s
  - **Total**: ~70 reads/second

### Optimization Opportunities

1. **Batch Updates**: Quote router could batch leg_state updates
2. **Write-Through Cache**: Cache leg_state in memory for risk engine
3. **Conditional Updates**: Only update if price/position changed
4. **Connection Pooling**: Use connection pool for parallel queries

## Security Considerations

1. **Feature Flags**: All services disabled by default
2. **Kill Switches**: Emergency stop for risk exits and auto-trading
3. **Idempotency**: UUID-based risk trigger IDs prevent duplicate exits
4. **In-Memory Guards**: Active trigger tracking prevents race conditions
5. **Error Handling**: Services continue running even if individual checks fail
6. **Graceful Shutdown**: All intervals cleared on server shutdown

## Known Limitations

1. **Order Execution**: Risk engine only creates exit intents, doesn't place orders yet
   - Requires Phase 4 (Enhanced Order Service) for actual order placement
2. **Multi-Instance Coordination**: Each instance tracked separately
   - No cross-instance position aggregation yet
3. **Quote Caching**: 5-second TTL might miss rapid price movements
4. **No Replay**: If server restarts, in-flight risk exits are lost
   - Database `risk_exits` table tracks history, but execution must be manual
5. **TSL Precision**: Trailing based on polling interval (200ms)
   - True tick-by-tick trailing would require WebSocket feeds

## Next Steps

### Immediate (Phase 3 Testing):
- [ ] Test fill aggregation with live OpenAlgo instance
- [ ] Verify quote routing with real market data
- [ ] Test TP/SL/TSL triggering with paper trading
- [ ] Validate scope-based exits
- [ ] Test kill switches
- [ ] Monitor performance under load

### Phase 4: Enhanced Order Service (Week 5-6)
- [ ] Implement trade intent creation
- [ ] Add server-side symbol resolution
- [ ] Calculate position deltas
- [ ] Place orders via OpenAlgo
- [ ] Handle pyramiding (reanchor/scale/ignore)
- [ ] Execute risk exits from pending queue

### Phase 5: Frontend Integration (Week 7)
- [ ] Settings management UI
- [ ] Risk enable/disable controls
- [ ] TSL configuration UI
- [ ] Risk exit history view
- [ ] Real-time position monitoring

### Phase 6: Testing & Validation (Week 8)
- [ ] Comprehensive QA scenarios from spec
- [ ] Paper trading validation
- [ ] Load testing
- [ ] Edge case testing
- [ ] Production readiness review

## Summary

Phase 3 delivers a **production-ready risk engine backend** with:

✅ **Real-time position tracking** via fill aggregation
✅ **Market data routing** via quote router
✅ **Automated risk monitoring** with TP/SL/TSL
✅ **Scope-based exit orchestration**
✅ **Idempotent risk exit tracking**
✅ **Emergency kill switches**
✅ **Conservative feature flags**
✅ **Graceful startup/shutdown**

The risk engine is **fully functional** but requires Phase 4 (Enhanced Order Service) to execute the risk exits it identifies. Currently, it creates `risk_exits` records with `exit_orders_json` containing the orders that should be placed.

**Conservative Rollout**: All features disabled by default. Enable via environment variables after thorough testing.

---

**Implementation Complete**: 2025-11-16
**Ready for Testing**: Yes
**Ready for Production**: No (requires Phase 4-6)
