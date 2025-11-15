# Watchlist Trading Spec v3 - System Architecture

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             FRONTEND (Browser)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Dashboard   │  │ Quick Order  │  │   Settings   │  │  Watchlist   │   │
│  │  (Existing)  │  │  (Enhanced)  │  │    (NEW)     │  │  (Existing)  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                  │                  │                  │           │
│         └──────────────────┴──────────────────┴──────────────────┘           │
│                                      │                                        │
└──────────────────────────────────────┼────────────────────────────────────────┘
                                       │
                                       │ HTTP/REST
                                       │
┌──────────────────────────────────────▼────────────────────────────────────────┐
│                          BACKEND SERVER (Node.js/Express)                      │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌─────────────────────────────── API ROUTES ─────────────────────────────┐  │
│  │                                                                          │  │
│  │  /api/v1/watchlists/*  (Existing)                                      │  │
│  │  /api/v1/orders/*       (Enhanced with intent creation)                │  │
│  │  /api/v1/settings/*     (NEW - Settings hierarchy)                     │  │
│  │  /api/v1/symbols/*      (Existing - Symbol search)                     │  │
│  │  /api/v1/instruments/*  (Existing - Instruments cache)                 │  │
│  │                                                                          │  │
│  └──────────────────────────────┬───────────────────────────────────────────┘  │
│                                 │                                              │
│  ┌─────────────────────────────▼─── SERVICES ───────────────────────────┐    │
│  │                                                                        │    │
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐         │    │
│  │  │   Watchlist    │  │     Order      │  │   Settings     │         │    │
│  │  │   (Existing)   │  │  (Enhanced)    │  │     (NEW)      │         │    │
│  │  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘         │    │
│  │           │                   │                   │                  │    │
│  │           │     ┌─────────────▼──────────┐        │                  │    │
│  │           │     │   Intent Creation      │        │                  │    │
│  │           │     │   Symbol Resolution    │        │                  │    │
│  │           │     │   Delta Calculation    │        │                  │    │
│  │           │     └─────────────┬──────────┘        │                  │    │
│  │           │                   │                   │                  │    │
│  │  ┌────────▼───────────────────▼───────────────────▼────────┐        │    │
│  │  │         Order Orchestrator (Server Authority)           │        │    │
│  │  │  - Resolves symbols                                     │        │    │
│  │  │  - Computes target positions                            │        │    │
│  │  │  - Broadcasts deltas to instances                       │        │    │
│  │  └────────────────────────────┬─────────────────────────────┘        │    │
│  │                                │                                      │    │
│  └────────────────────────────────┼──────────────────────────────────────┘    │
│                                   │                                           │
│  ┌────────────────────────────────▼──── RISK ENGINE (NEW) ─────────────┐     │
│  │                                                                       │     │
│  │  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐        │     │
│  │  │      Fill      │  │     Quote      │  │      Risk      │        │     │
│  │  │   Aggregator   │  │     Router     │  │     Engine     │        │     │
│  │  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘        │     │
│  │           │                   │                   │                 │     │
│  │           │                   │                   │                 │     │
│  │  ┌────────▼───────────────────▼───────────────────▼────────┐       │     │
│  │  │              Background Polling Services                │       │     │
│  │  │  - Fill Polling (2s): Sync tradebook/orderbook         │       │     │
│  │  │  - Quote Polling (200ms): Fetch market quotes          │       │     │
│  │  │  - Risk Polling (1s): Check TP/SL/TSL thresholds       │       │     │
│  │  └─────────────────────────────────────────────────────────┘       │     │
│  │                                                                      │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                                │
│  ┌──────────────────────────── DATABASE (SQLite) ──────────────────────────┐ │
│  │                                                                           │ │
│  │  EXISTING TABLES:                    NEW TABLES:                        │ │
│  │  ┌────────────────┐                  ┌────────────────┐                │ │
│  │  │  watchlists    │                  │global_defaults │                │ │
│  │  │watchlist_symbols│                 │ index_profiles │                │ │
│  │  │watchlist_orders│                  │watchlist_overr.│                │ │
│  │  │watchlist_pos.  │                  │ user_defaults  │                │ │
│  │  │  instances     │                  │symbol_overrides│                │ │
│  │  │  users         │                  │ config_audit   │                │ │
│  │  │ instruments    │                  │ trade_intents  │                │ │
│  │  │ market_data    │                  │   leg_state    │                │ │
│  │  └────────────────┘                  │  risk_exits    │                │ │
│  │                                       └────────────────┘                │ │
│  └───────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
└────────────────────────────────┬───────────────────────────────────────────────┘
                                 │
                                 │ HTTP/REST (OpenAlgo API)
                                 │
┌────────────────────────────────▼───────────────────────────────────────────────┐
│                         OPENALGO INSTANCES (Multiple)                          │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ Instance 1  │  │ Instance 2  │  │ Instance 3  │  │ Instance N  │         │
│  │             │  │             │  │             │  │             │         │
│  │ (Angel)     │  │ (Zerodha)   │  │ (Upstox)    │  │ (Analyzer)  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                                                │
│  Each instance receives:                                                      │
│  - Order with DELTA (quantity to trade)                                      │
│  - Position target (final desired position)                                  │
│  - Resolved symbols (no re-resolution)                                       │
│  - Risk exits (when thresholds breach)                                       │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Trade Execution

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: User Clicks Trade Button (e.g., "BUY CE")                           │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Frontend Gathers Context                                             │
│                                                                               │
│  - User ID                                                                   │
│  - Watchlist ID                                                               │
│  - Symbol ID                                                                  │
│  - Action (BUY_CE, SELL_PE, etc.)                                            │
│  - Trade Mode (OPTIONS/FUTURES/EQUITY)                                       │
│  - Options Leg (ATM/ITM1/OTM2/etc)                                           │
│  - Expiry (YYYY-MM-DD)                                                        │
│  - Quantity (step_lots × lotsize)                                            │
│  - Runtime Overrides (optional: TP/SL/TSL from UI panel)                     │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: POST /api/v1/orders/quick-order                                      │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Settings Service - Get Effective Config                              │
│                                                                               │
│  ┌────────────────┐                                                          │
│  │ Merge Settings │ → Global → Index → Watchlist → User → Symbol → Click    │
│  └────────┬───────┘                                                          │
│           │                                                                   │
│           ▼                                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │ Effective Config:                                                   │     │
│  │  - strike_policy: FLOAT_OFS                                         │     │
│  │  - step_lots: 1                                                     │     │
│  │  - tp_per_unit: 30                                                  │     │
│  │  - sl_per_unit: 20                                                  │     │
│  │  - tsl_enabled: true                                                │     │
│  │  - tsl_trail_by: 15                                                 │     │
│  │  - etc...                                                           │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Order Service - Create Trade Intent                                  │
│                                                                               │
│  intent_id = generateUUID()                                                  │
│                                                                               │
│  INSERT INTO trade_intents (                                                 │
│    intent_id,                                                                │
│    user_id,                                                                  │
│    watchlist_id,                                                             │
│    trade_mode,                                                               │
│    index_name,                                                               │
│    expiry,                                                                   │
│    resolved_config_json = JSON.stringify(effectiveConfig)                   │
│  )                                                                            │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Order Service - Resolve Symbol                                       │
│                                                                               │
│  IF trade_mode === 'OPTIONS':                                                │
│    // Call OpenAlgo OptionSymbol API                                         │
│    resolved = await openalgoClient.resolveOptionSymbol({                     │
│      underlying: 'NIFTY',                                                    │
│      exchange: 'NFO',                                                        │
│      expiry_date: '2025-11-20',                                              │
│      option_type: 'CE',                                                      │
│      strike: calculateStrike(ltp, offset, strike_step),                      │
│    })                                                                         │
│                                                                               │
│  RETURNS:                                                                     │
│    {                                                                          │
│      symbol: 'NIFTY25NOV24350CE',                                            │
│      lotsize: 50,                                                            │
│      tick_size: 0.05                                                         │
│    }                                                                          │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 7: Order Service - Calculate Target Position                            │
│                                                                               │
│  // Get current position from leg_state (or 0 if none)                       │
│  current_position = await getLegState(symbol, exchange, instance_id)         │
│  current_qty = current_position?.net_qty || 0                                │
│                                                                               │
│  // Calculate target based on action                                         │
│  IF action === 'BUY_CE':                                                     │
│    target = current_qty + (step_lots × lotsize)                              │
│  ELSE IF action === 'SELL_CE':                                               │
│    target = current_qty - (step_lots × lotsize)                              │
│  ELSE IF action === 'EXIT':                                                  │
│    target = 0                                                                │
│                                                                               │
│  // Calculate delta                                                           │
│  delta = Math.abs(target - current_qty)                                      │
│  action_side = target > current_qty ? 'BUY' : 'SELL'                         │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 8: Order Service - Place Orders to Instances                            │
│                                                                               │
│  // Get assigned instances for this watchlist                                │
│  instances = await getWatchlistInstances(watchlist_id)                       │
│                                                                               │
│  FOR EACH instance:                                                          │
│    orderData = {                                                             │
│      apikey: instance.api_key,                                               │
│      strategy: instance.strategy_tag,                                        │
│      exchange: 'NFO',                                                        │
│      symbol: 'NIFTY25NOV24350CE',                                            │
│      action: 'BUY',                                                          │
│      quantity: delta.toString(),                                             │
│      position_size: target.toString(),  // <-- Target position               │
│      product: 'MIS',                                                         │
│      pricetype: 'MARKET',                                                    │
│      price: '0',                                                             │
│      trigger_price: '0',                                                     │
│      disclosed_quantity: '0'                                                 │
│    }                                                                          │
│                                                                               │
│    response = await openalgoClient.placeSmartOrder(instance, orderData)      │
│                                                                               │
│    // Save to watchlist_orders                                               │
│    INSERT INTO watchlist_orders (...)                                        │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 9: Response to Frontend                                                 │
│                                                                               │
│  {                                                                            │
│    success: true,                                                            │
│    intent_id: "550e8400-e29b-41d4-a716-446655440000",                        │
│    summary: {                                                                │
│      total: 3,           // 3 instances                                      │
│      successful: 3,                                                          │
│      failed: 0                                                               │
│    },                                                                         │
│    results: [                                                                │
│      { instance_id: 1, success: true, order_id: "ABC123" },                 │
│      { instance_id: 2, success: true, order_id: "DEF456" },                 │
│      { instance_id: 3, success: true, order_id: "GHI789" }                  │
│    ]                                                                          │
│  }                                                                            │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 10: Frontend Shows Toast                                                │
│                                                                               │
│  "Order placed: 3/3 successful"                                              │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Risk Management (Continuous)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ BACKGROUND SERVICE 1: Fill Aggregator (Every 2 seconds)                      │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ FOR EACH active instance:                                                    │
│                                                                               │
│  1. Fetch tradebook from OpenAlgo                                            │
│  2. Fetch orderbook from OpenAlgo                                            │
│  3. Group fills by symbol                                                    │
│  4. Calculate net_qty per symbol                                             │
│  5. Calculate weighted_avg_entry                                             │
│  6. Update leg_state table                                                   │
│                                                                               │
│  UPDATE leg_state SET                                                        │
│    net_qty = calculated_qty,                                                 │
│    weighted_avg_entry = calculated_entry,                                    │
│    updated_at = NOW()                                                        │
│  WHERE symbol = ? AND instance_id = ?                                        │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ BACKGROUND SERVICE 2: Quote Router (Every 200ms)                             │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. Get all active symbols from leg_state WHERE risk_enabled = 1             │
│ 2. Batch fetch quotes from OpenAlgo                                          │
│ 3. Update market_data table                                                  │
│ 4. Track best_favorable_price for each leg                                   │
│                                                                               │
│  IF net_qty > 0 (long):                                                      │
│    best_favorable = MAX(current_ltp, previous_best)                          │
│  ELSE IF net_qty < 0 (short):                                                │
│    best_favorable = MIN(current_ltp, previous_best)                          │
│                                                                               │
│  UPDATE leg_state SET                                                        │
│    best_favorable_price = best_favorable,                                    │
│    updated_at = NOW()                                                        │
│  WHERE id = leg_state_id                                                     │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│ BACKGROUND SERVICE 3: Risk Engine (Every 1 second)                           │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ FOR EACH leg in leg_state WHERE risk_enabled = 1:                           │
│                                                                               │
│  1. Get current LTP from market_data                                         │
│  2. Calculate unrealized P&L = (ltp - weighted_avg_entry) × net_qty         │
│  3. Calculate P&L per unit = unrealized_pnl / net_qty                        │
│                                                                               │
│  4. Check TP threshold:                                                      │
│     IF net_qty > 0 (long):                                                   │
│       IF ltp >= tp_price:                                                    │
│         FIRE EXIT (reason: 'TP_HIT')                                         │
│                                                                               │
│  5. Check SL threshold:                                                      │
│     IF net_qty > 0 (long):                                                   │
│       IF ltp <= sl_price:                                                    │
│         FIRE EXIT (reason: 'SL_HIT')                                         │
│                                                                               │
│  6. Check TSL:                                                               │
│     IF tsl_enabled AND NOT tsl_armed:                                        │
│       IF pnl_per_unit >= tsl_arm_after:                                      │
│         tsl_armed = TRUE                                                     │
│         tsl_current_stop = weighted_avg_entry  // Start at breakeven        │
│                                                                               │
│     IF tsl_armed:                                                            │
│       new_stop = best_favorable_price - tsl_trail_by                         │
│       IF new_stop > tsl_current_stop + tsl_step:                             │
│         tsl_current_stop = new_stop                                          │
│                                                                               │
│       IF ltp <= tsl_current_stop:                                            │
│         FIRE EXIT (reason: 'TSL_HIT')                                        │
│                                                                               │
│  7. Update leg_state with new TSL values                                     │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼ (IF threshold breached)
┌──────────────────────────────────────────────────────────────────────────────┐
│ FIRE RISK EXIT                                                                │
│                                                                               │
│  risk_trigger_id = generateUUID()                                            │
│                                                                               │
│  // Check idempotency                                                        │
│  existing = SELECT * FROM risk_exits WHERE risk_trigger_id = ?              │
│  IF existing: RETURN (already fired)                                         │
│                                                                               │
│  // Create risk exit record                                                  │
│  INSERT INTO risk_exits (                                                    │
│    risk_trigger_id,                                                          │
│    leg_state_id,                                                             │
│    trigger_type,  // 'TP_HIT', 'SL_HIT', 'TSL_HIT'                           │
│    trigger_price                                                             │
│  )                                                                            │
│                                                                               │
│  // Send market exit to all instances                                        │
│  FOR EACH instance with this leg:                                            │
│    orderData = {                                                             │
│      symbol: leg.symbol,                                                     │
│      action: net_qty > 0 ? 'SELL' : 'BUY',  // Opposite side                │
│      quantity: Math.abs(net_qty),                                            │
│      position_size: 0,  // Flatten to zero                                  │
│      pricetype: 'MARKET'                                                     │
│    }                                                                          │
│    await placeSmartOrder(instance, orderData)                                │
│                                                                               │
│  // Update leg_state                                                         │
│  UPDATE leg_state SET                                                        │
│    risk_enabled = 0,  // Stop monitoring                                    │
│    net_qty = 0  // Will be updated by fill aggregator                       │
│                                                                               │
│  // Log alert                                                                │
│  INSERT INTO system_alerts (                                                 │
│    type: 'RISK_EXIT',                                                        │
│    severity: 'INFO',                                                         │
│    title: 'Risk exit triggered',                                            │
│    message: `${trigger_type} at ${trigger_price} for ${leg.symbol}`         │
│  )                                                                            │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Settings Precedence Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ REQUEST: Get effective settings for a trade                                  │
│                                                                               │
│ INPUT:                                                                        │
│   user_id = 1                                                                │
│   watchlist_id = 5                                                           │
│   index_name = 'NIFTY'                                                       │
│   symbol = null                                                              │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Load Global Defaults                                                 │
│                                                                               │
│  SELECT * FROM global_defaults WHERE id = 1                                  │
│                                                                               │
│  config = {                                                                  │
│    strike_policy: 'FLOAT_OFS',                                               │
│    step_lots: 1,                                                             │
│    tp_per_unit: null,                                                        │
│    sl_per_unit: null,                                                        │
│    tsl_enabled: false,                                                       │
│    ...                                                                        │
│  }                                                                            │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Merge Index Profile (if index_name provided)                         │
│                                                                               │
│  SELECT * FROM index_profiles WHERE index_name = 'NIFTY'                     │
│                                                                               │
│  indexConfig = {                                                             │
│    strike_step: 50,                                                          │
│    tp_per_unit: 30,  // Override global                                      │
│    sl_per_unit: 20,  // Override global                                      │
│    tsl_enabled: true,  // Override global                                    │
│    tsl_trail_by: 15,                                                         │
│    tsl_step: 5,                                                              │
│    ...                                                                        │
│  }                                                                            │
│                                                                               │
│  config = { ...config, ...removeNulls(indexConfig) }                         │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Merge Watchlist Overrides (if watchlist_id provided)                 │
│                                                                               │
│  SELECT * FROM watchlist_overrides                                           │
│  WHERE watchlist_id = 5 AND (index_name = 'NIFTY' OR index_name IS NULL)    │
│                                                                               │
│  watchlistConfig = {                                                         │
│    step_lots: 2,  // Override previous                                       │
│    ...                                                                        │
│  }                                                                            │
│                                                                               │
│  config = { ...config, ...removeNulls(watchlistConfig) }                     │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Merge User Defaults (if user_id provided)                            │
│                                                                               │
│  SELECT * FROM user_defaults WHERE user_id = 1                               │
│                                                                               │
│  userConfig = {                                                              │
│    tsl_trail_by: 20,  // Override previous                                   │
│    ...                                                                        │
│  }                                                                            │
│                                                                               │
│  config = { ...config, ...removeNulls(userConfig) }                          │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Merge Symbol Overrides (if symbol provided)                          │
│                                                                               │
│  SELECT * FROM symbol_overrides WHERE symbol = ?                             │
│                                                                               │
│  symbolConfig = { ... }                                                      │
│                                                                               │
│  config = { ...config, ...removeNulls(symbolConfig) }                        │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Apply Per-Click Overrides (from request)                             │
│                                                                               │
│  runtimeOverrides = {                                                        │
│    tp_per_unit: 50,  // User changed in UI panel                             │
│    sl_per_unit: 25   // User changed in UI panel                             │
│  }                                                                            │
│                                                                               │
│  config = { ...config, ...removeNulls(runtimeOverrides) }                    │
│                                                                               │
└────────────┬─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ FINAL EFFECTIVE CONFIG                                                        │
│                                                                               │
│  {                                                                            │
│    strike_policy: 'FLOAT_OFS',     // From global                            │
│    step_lots: 2,                   // From watchlist override                │
│    strike_step: 50,                // From index profile                     │
│    tp_per_unit: 50,                // From per-click override                │
│    sl_per_unit: 25,                // From per-click override                │
│    tsl_enabled: true,              // From index profile                     │
│    tsl_trail_by: 20,               // From user defaults                     │
│    tsl_step: 5,                    // From index profile                     │
│    tsl_arm_after: 10,              // From index profile                     │
│    tsl_breakeven_after: 12,        // From index profile                     │
│    ...                                                                        │
│  }                                                                            │
│                                                                               │
│  RETURN config                                                                │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Principles

### 1. Server Authority
- **Server** is the brain: resolves symbols, calculates targets, enforces risk
- **Instances** are executors: only trade the delta they're told

### 2. Non-Accumulation
- Every button click sets a **target position** (not incremental)
- Server calculates **delta** = target - current
- Instances execute delta only
- **Result:** No accidental position stacking

### 3. Per-Unit Risk
- Risk defined in **points per contract** (not rupees)
- Survives lot-size changes
- Easy to reason about (universal unit)

### 4. Idempotency
- **intent_id** for trade intents (no duplicate trades)
- **risk_trigger_id** for risk exits (single-shot)
- Server checks before executing

### 5. Restart-Safe
- Server rebuilds state from tradebook/orderbook on restart
- No in-memory state lost
- Risk monitoring resumes automatically

### 6. Settings Precedence
- 6-tier hierarchy: Global → Index → Watchlist → User → Symbol → Click
- Nulls inherit from higher level
- Per-click overrides are transient (not saved unless user chooses)

### 7. Deterministic Symbol Resolution
- Server resolves once per trade intent
- Symbols stored in intent
- Instances never re-resolve (prevents drift)

---

## Component Responsibilities

| Component | Responsibilities | Frequency |
|-----------|-----------------|-----------|
| **Frontend** | UI, user input, settings display | User-driven |
| **API Routes** | Request validation, auth, routing | Per request |
| **Settings Service** | Merge config hierarchy | Per trade (cached 30s) |
| **Order Service** | Intent creation, symbol resolution, delta calc | Per trade |
| **Fill Aggregator** | Sync fills, calculate weighted avg entry | 2 seconds |
| **Quote Router** | Fetch quotes, track best favorable | 200ms |
| **Risk Engine** | Check thresholds, arm/trail TSL, fire exits | 1 second |
| **Database** | Persist all state | Continuous |
| **OpenAlgo Instances** | Execute orders, report fills | Per order |

---

## Database Table Relationships

```
users
  └─── user_defaults (1:1)
  └─── trade_intents (1:N)

instances
  └─── watchlist_instances (N:M with watchlists)
  └─── leg_state (1:N)

watchlists
  └─── watchlist_symbols (1:N)
  └─── watchlist_orders (1:N)
  └─── watchlist_positions (1:N)
  └─── watchlist_instances (N:M with instances)
  └─── watchlist_overrides (1:N)

global_defaults (singleton)

index_profiles (1 per index: NIFTY, BANKNIFTY, etc.)

symbol_overrides (1 per direct symbol/future)

trade_intents (created per trade)
  └─── stores resolved_config_json

leg_state (1 per symbol per instance)
  └─── risk_exits (1:N, when risk triggers)

config_audit (append-only log)
```

---

This architecture ensures:
- ✅ **No breaking changes** to existing functionality
- ✅ **Gradual rollout** via feature flags
- ✅ **Server authority** for deterministic behavior
- ✅ **Restart-safe** operation
- ✅ **Audit trail** for compliance
- ✅ **Scalable** polling design
