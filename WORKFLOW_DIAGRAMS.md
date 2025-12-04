# Order Placement Workflow Diagrams

Visual representation of order placement workflows for different trade modes.

---

## Complete System Flow

```
┌─────────────────────────────────────────────────────────────┐
│                       USER INTERFACE                        │
│  Trading Control Buttons: BUY, SELL, BUY_CE, REDUCE_CE...  │
└────────────────────────┬────────────────────────────────────┘
                         │ onClick
                         ▼
┌─────────────────────────────────────────────────────────────┐
│           FRONTEND (quick-order.js:1557-1684)               │
│  • Disable all buttons + show loading                       │
│  • Collect trade configuration                              │
│  • Call API with retry logic (max 3, delay 3s)             │
│  • Display toast notification                               │
│  • Re-enable buttons                                        │
└────────────────────────┬────────────────────────────────────┘
                         │ POST /api/v1/quickorders
                         ▼
┌─────────────────────────────────────────────────────────────┐
│         BACKEND API ROUTE (quickorders.js:44-174)           │
│  • Authenticate & authorize                                 │
│  • Validate request parameters                              │
│  • Log audit trail                                          │
└────────────────────────┬────────────────────────────────────┘
                         │ Service call
                         ▼
┌─────────────────────────────────────────────────────────────┐
│      QUICK ORDER SERVICE (quick-order.service.js:44-183)    │
│  • Validate symbol supports trade mode                      │
│  • Lookup symbol configuration (DB query ~15ms)             │
│  • Resolve instance(s) (DB query ~15ms)                     │
│  • Determine execution strategy:                            │
│    - DIRECT_ORDER (EQUITY/FUTURES)                          │
│    - OPTIONS_WITH_RECONCILIATION (OPTIONS)                  │
│    - CLOSE_POSITIONS (EXIT/CLOSE_ALL)                       │
└────────────────────────┬────────────────────────────────────┘
                         │ Execute strategy
                         ▼
┌─────────────────────────────────────────────────────────────┐
│   STRATEGY EXECUTION (quick-order.service.js:344-530)       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PRE-OPTIMIZATIONS (Parallel)                        │   │
│  │  • Option symbol pre-resolution (200-500ms)          │   │
│  │  • Position pre-fetching for all instances (parallel)│   │
│  │    [Inst1: 500ms, Inst2: 700ms, Inst3: 600ms]       │   │
│  │    Max = 700ms (not 1800ms!)                         │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PER-INSTANCE EXECUTION (Parallel via Promise.all)   │   │
│  │  Instance 1: Execute order →│                        │   │
│  │  Instance 2: Execute order →├─ Parallel execution    │   │
│  │  Instance 3: Execute order →│                        │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │ Per instance
                         ▼
┌─────────────────────────────────────────────────────────────┐
│         ORDER STRATEGY (Lines 598-1414)                     │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │ DIRECT_ORDER (EQUITY/FUTURES)                    │      │
│  │ • Resolve futures symbol (if FUTURES) ~300ms     │      │
│  │ • Fetch position (cached: 10ms, miss: 400ms)     │      │
│  │ • Calculate quantity                              │      │
│  │ • Place order → OpenAlgo (700-2000ms)            │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │ OPTIONS_WITH_RECONCILIATION                      │      │
│  │ • Resolve option symbol (pre-resolved or new)    │      │
│  │ • Fetch CE/PE positions                          │      │
│  │ • Calculate target positions                      │      │
│  │ • Place order(s) → OpenAlgo (700-2000ms each)    │      │
│  │                                                  │      │
│  │ ** FLOAT_OFS REDUCE with multiple strikes:      │      │
│  │    For each strike (PARALLEL):                  │      │
│  │      Strike 1: SELL order → OpenAlgo ──┐        │      │
│  │      Strike 2: SELL order → OpenAlgo ──┼─ Parallel│    │
│  │      Strike 3: SELL order → OpenAlgo ──┘        │      │
│  │    (Promise.allSettled - Lines 1163)            │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │ CLOSE_POSITIONS                                  │      │
│  │ • Fetch all open positions                       │      │
│  │ • Build close orders for each                    │      │
│  │ • Place orders → OpenAlgo (700-2000ms each)      │      │
│  └──────────────────────────────────────────────────┘      │
└────────────────────────┬────────────────────────────────────┘
                         │ Place order
                         ▼
┌─────────────────────────────────────────────────────────────┐
│    ORDER PLACEMENT SERVICE (order-placement.service.js)     │
│  • Validate order payload (~5ms)                            │
└────────────────────────┬────────────────────────────────────┘
                         │ OpenAlgo API call
                         ▼
┌─────────────────────────────────────────────────────────────┐
│       OPENALGO CLIENT (openalgo/client.js:600-850)          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ PRE-REQUEST                                          │   │
│  │ • Position snapshot (idempotency) 200-500ms         │   │
│  │ • Rate limiting check                                │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ RETRY LOOP (max 4 attempts, exponential backoff)    │   │
│  │                                                      │   │
│  │ Attempt 1: HTTP POST to OpenAlgo (0-15s timeout)    │   │
│  │            Network + Broker: 500-2000ms              │   │
│  │            ↓ FAIL? Retry if retriable                │   │
│  │ Delay 500ms (exponential: 500 × 2^0)                │   │
│  │                                                      │   │
│  │ Attempt 2: HTTP POST (500-2000ms)                   │   │
│  │            ↓ FAIL? Retry if retriable                │   │
│  │ Delay 1000ms (exponential: 500 × 2^1)               │   │
│  │                                                      │   │
│  │ Attempt 3: HTTP POST (500-2000ms)                   │   │
│  │            ↓ FAIL? Retry if retriable                │   │
│  │ Delay 2000ms (exponential: 500 × 2^2)               │   │
│  │                                                      │   │
│  │ Attempt 4: HTTP POST (500-2000ms)                   │   │
│  │            ↓ FAIL? Throw error                       │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP/2 Request
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   OPENALGO API SERVER                       │
│  • Routes to broker API                                     │
│  • Processes order                                          │
│  • Returns order ID and status                              │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                      BROKER API                             │
│  (Zerodha/Finvasia/Shoonya/etc.)                           │
│  • Validates order                                          │
│  • Places order on exchange                                 │
│  • Returns confirmation                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## EQUITY Mode Workflow

```
┌─────────────┐
│ Click BUY   │  User action
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│ Lock Buttons + Show Loading     │  <5ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Fetch Current Position          │  Cached: ~10ms
│ (for position-aware qty)        │  Miss: 200-800ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Calculate Quantity              │  <5ms
│ BUY: full qty                   │
│ SELL: min(qty, long_position)   │
│ SHORT: full qty                 │
│ COVER: min(qty, short_position) │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Build Order Payload             │  <5ms
│ {symbol, action, quantity...}   │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Place Order (OpenAlgo API)      │  ⏱️ CRITICAL PATH
│                                 │  Position snapshot: 200-500ms
│ Best:    700-1000ms             │  HTTP request: 500-2000ms
│ Typical: 1000-1500ms            │
│ Retry:   3000-5000ms            │  With retries:
└──────┬──────────────────────────┘  • Delay: 500-2000ms
       │                              • Total: +1500-4000ms
       ▼
┌─────────────────────────────────┐
│ Display Toast Notification      │  <10ms
│ "Order placed successfully"     │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Unlock Buttons + Refresh        │  <50ms
│ Position Tab                    │
└─────────────────────────────────┘

TOTAL TIME:
  Best case:    765ms
  Typical:     1455ms (1.5s)
  With retry:  3955ms (4s) ⚠️
```

---

## FUTURES Mode Workflow

```
┌─────────────┐
│ Click BUY   │  User action
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│ Lock Buttons + Show Loading     │  <5ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Resolve Futures Symbol          │  ⏱️ Additional overhead
│ BANKNIFTY + 28NOV24              │  Cached: ~5ms
│  → BANKNIFTY28NOV24FUT          │  Miss: 100-500ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Fetch Current Position          │  Cached: ~10ms
└──────┬──────────────────────────┘  Miss: 200-800ms
       │
       ▼
┌─────────────────────────────────┐
│ Resolve Lot Size                │  Cached: ~5ms
│ (e.g., BANKNIFTY = 25)          │  Miss: 50-200ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Calculate Quantity              │  <5ms
│ lots × lot_size                 │  2 lots × 25 = 50 qty
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Place Order (OpenAlgo API)      │  ⏱️ CRITICAL PATH
│ Best:    800-1500ms             │  700-2000ms
│ Typical: 1200-2000ms            │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Display Toast + Unlock Buttons  │
└─────────────────────────────────┘

TOTAL TIME:
  Best case:    1045ms
  Typical:     1955ms (2s)
  With retry:  4455ms (4.5s)
```

---

## OPTIONS Mode - BUY_CE Workflow (FLOAT_OFS)

```
┌──────────────┐
│ Click BUY_CE │  User action (BUYER mode)
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────┐
│ Lock Buttons + Show Loading     │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Resolve Option Symbol (Pre-resolved or new)     │  ⏱️
│                                                 │
│ 1. Get underlying LTP                          │  Cached: 5ms
│    BANKNIFTY → 24,123                          │  Miss: 200-400ms
│                                                 │
│ 2. Calculate ATM strike                        │  <1ms
│    24,123 → 24,100 (round to 100)             │
│                                                 │
│ 3. Apply offset                                │  <1ms
│    ITM3: -300 → 23,800                         │
│    ATM:    0 → 24,100                          │
│    OTM1: +100 → 24,200                         │
│                                                 │
│ 4. Build option symbol                         │  <1ms
│    BANKNIFTY + 28NOV24 + 24100 + CE            │
│    → BANKNIFTY28NOV2424100CE                   │
│                                                 │
│ 5. Verify symbol exists                        │  Cached: 5ms
│    (instruments API call)                      │  Miss: 200-500ms
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Fetch Current CE Positions      │  Preloaded: instant
│ (for this underlying + expiry)  │  Cached: 10ms
└──────┬──────────────────────────┘  Miss: 300-800ms
       │
       ▼
┌─────────────────────────────────┐
│ Calculate Target Position       │  <5ms
│ Current: 0 lots                 │
│ Add: 2 step_lots                │
│ Target: 2 lots                  │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Build Order Payload             │  <5ms
│ Symbol: BANKNIFTY28NOV2424100CE │
│ Action: BUY                     │
│ Quantity: 50 (2 lots × 25)      │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Place Order (OpenAlgo API)      │  ⏱️ CRITICAL PATH
│ Typical: 1200-2000ms            │  700-2000ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Save to Database                │  ~10ms
│ (if ANCHOR_OFS: save anchor)    │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Display Toast + Unlock Buttons  │
└─────────────────────────────────┘

TOTAL TIME:
  Best case (pre-resolved, cached): 1045ms
  Typical:                         2055ms (2s)
  With retry:                      4555ms (4.5s)
```

---

## OPTIONS Mode - REDUCE_CE Workflow (FLOAT_OFS, Multiple Strikes) 🔴

```
┌────────────────┐
│ Click REDUCE_CE│  User action (BUYER mode)
└──────┬─────────┘  Reduce long CE positions
       │
       ▼
┌─────────────────────────────────┐
│ Lock Buttons + Show Loading     │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Fetch ALL Open CE Positions                    │  ⏱️ API Call
│ (for this underlying + expiry)                 │  300-800ms
│                                                 │
│ Results:                                       │
│  ├─ BANKNIFTY28NOV2424000CE: 3 lots (long)    │
│  ├─ BANKNIFTY28NOV2424100CE: 2 lots (long)    │
│  └─ BANKNIFTY28NOV2424200CE: 1 lot  (long)    │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Calculate Target for Each Strike               │  <10ms
│ (step_lots = 2)                                 │
│                                                 │
│ Strike 24000:                                   │
│  Current: 3 lots → Target: 1 lot               │
│  Reduce by: 2 lots → SELL 50 qty               │
│                                                 │
│ Strike 24100:                                   │
│  Current: 2 lots → Target: 0 lots              │
│  Reduce by: 2 lots → SELL 50 qty               │
│                                                 │
│ Strike 24200:                                   │
│  Current: 1 lot → Target: 0 lots               │
│  Reduce by: 1 lot → SELL 25 qty                │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Build Order Payloads for Each Strike           │  <10ms
│ Order 1: SELL 50 BANKNIFTY28NOV2424000CE       │
│ Order 2: SELL 50 BANKNIFTY28NOV2424100CE       │
│ Order 3: SELL 25 BANKNIFTY28NOV2424200CE       │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Place Orders IN PARALLEL                        │  ⏱️ CRITICAL
│ (Promise.allSettled - Line 1163)                │
│                                                 │
│  Order 1 → OpenAlgo API ──┐                    │
│                           │                    │
│  Order 2 → OpenAlgo API ──┼─ Parallel!         │  Each: 700-2000ms
│                           │                    │  Max: 1500ms typical
│  Order 3 → OpenAlgo API ──┘                    │
│                                                 │
│ Each order includes:                            │
│  • Position snapshot: 200-500ms                 │
│  • HTTP request: 500-2000ms                     │
│  • Retry if fail (exponential backoff)          │
│                                                 │
│ Best case (all succeed 1st try): 1500ms        │
│ Typical (no retries): 1500-2000ms              │
│ With 1 retry each: 3000-4500ms ⚠️              │
│ With 2 retries each: 5000-7000ms 🔴            │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Update Database for Each Order  │  ~30ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Display Toast                   │  <10ms
│ "3/3 orders successful"         │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Unlock Buttons + Refresh        │
└─────────────────────────────────┘

TOTAL TIME (3 strikes):
  Best case:              1845ms (~2s)
  Typical (no retries):   2655ms (~3s)
  With 1 retry each:      4655ms (~5s) ⚠️
  With 2 retries each:    7655ms (~8s) 🔴

THIS IS WHERE 5+ SECOND DELAYS OCCUR!

Key insight: Even with parallelization, if each order
takes 1500ms and retries once (+2000ms), the total is
still 3500ms since they run in parallel. The max time
is determined by the slowest order, not the sum.
```

---

## OPTIONS Mode - REDUCE_CE Workflow (ANCHOR_OFS) ✅

```
┌────────────────┐
│ Click REDUCE_CE│  User action (BUYER mode)
└──────┬─────────┘  Reduce long CE position at anchored strike
       │
       ▼
┌─────────────────────────────────┐
│ Lock Buttons + Show Loading     │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Retrieve Anchored Strike from Database          │  ~10ms
│ SELECT anchored_strike, anchored_symbol         │
│ FROM option_anchors                             │
│ WHERE watchlist_symbol_id = ? AND ...           │
│                                                 │
│ Result: Strike 24,100                           │
│         Symbol: BANKNIFTY28NOV2424100CE         │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Fetch Position for Anchor Strike│  Cached: 10ms
│ Current: 4 lots at 24,100        │  Miss: 300-500ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Calculate Target Position       │  <5ms
│ Current: 4 lots                 │
│ Reduce by: 2 step_lots          │
│ Target: 2 lots                  │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Build Order Payload             │  <5ms
│ SELL 50 BANKNIFTY28NOV2424100CE │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Place SINGLE Order              │  ⏱️ 700-2000ms
│ (OpenAlgo API)                  │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Update Database                 │  ~10ms
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Display Toast + Unlock Buttons  │
└─────────────────────────────────┘

TOTAL TIME:
  Best case (cached):     765ms
  Typical:              1555ms (1.5s)
  With 1 retry:         3555ms (3.5s)

MUCH FASTER than FLOAT_OFS with multiple strikes!
```

---

## Multi-Instance Broadcasting (3 Instances)

```
┌─────────────┐
│ Click BUY   │  No specific instance selected
└──────┬──────┘  Broadcast to ALL assigned instances
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Resolve Instances                               │  ~15ms
│ SELECT i.* FROM instances i                     │  (DB query)
│ JOIN watchlist_instances wi ON ...              │
│ WHERE wi.watchlist_id = ?                       │
│   AND i.is_active = 1                           │
│   AND i.order_placement_enabled = 1             │
│                                                 │
│ Results:                                        │
│  ├─ Instance 1: Zerodha (TOTP)                  │
│  ├─ Instance 2: Finvasia (API Key)              │
│  └─ Instance 3: Shoonya (API Key)               │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ PRE-FETCH POSITIONS (PARALLEL) ✅ Optimization  │
│                                                 │
│  Instance 1 position API ──┐                   │
│      ⏱️ 500ms              │                   │
│                            │                   │
│  Instance 2 position API ──┼─ Parallel!        │
│      ⏱️ 700ms              │  Max = 700ms      │
│                            │                   │
│  Instance 3 position API ──┘                   │
│      ⏱️ 600ms                                  │
│                                                 │
│ Without parallelization: 500+700+600 = 1800ms  │
│ With parallelization: max(500,700,600) = 700ms │
│ TIME SAVED: 1100ms! ✅                          │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ PLACE ORDERS (PARALLEL) ✅ Optimization         │
│                                                 │
│  Instance 1 order API ──┐                      │
│      ⏱️ 1000ms           │                      │
│                          │                      │
│  Instance 2 order API ──┼─ Parallel!           │
│      ⏱️ 1500ms           │  Max = 1500ms       │
│                          │                      │
│  Instance 3 order API ──┘                      │
│      ⏱️ 1200ms                                  │
│                                                 │
│ Without parallelization: 1000+1500+1200=3700ms │
│ With parallelization: max(1000,1500,1200)=1500ms│
│ TIME SAVED: 2200ms! ✅                          │
└──────┬──────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Aggregate Results               │  <10ms
│ Success: 3/3                    │
│ Failed: 0/3                     │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Display Toast                   │
│ "Order placed: 3/3 successful"  │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ Unlock Buttons + Refresh        │
└─────────────────────────────────┘

TOTAL TIME:
  Position pre-fetch: 700ms (parallel)
  Order placement:   1500ms (parallel)
  Other overhead:      50ms
  ────────────────────────
  Total:            2250ms (~2.3s) ✅

WITHOUT PARALLELIZATION:
  Position fetches:  1800ms (serial)
  Order placements:  3700ms (serial)
  Other overhead:      50ms
  ────────────────────────
  Total:            5550ms (~5.5s) 🔴

PARALLELIZATION SAVES: 3300ms (60% faster)!
```

---

## Retry Flow Visualization

```
┌─────────────────────────────────────────────────────────────┐
│               ORDER PLACEMENT WITH RETRIES                  │
└─────────────────────────────────────────────────────────────┘

LAYER 1: OPENALGO CLIENT RETRIES (Exponential Backoff)
────────────────────────────────────────────────────────

Attempt 1 ──────────────►  🌐 Broker API
                          ⏱️ 0-15000ms timeout
                          ↓ FAIL? (5xx, timeout, network)
                          ↓ Retriable? YES
                          ↓
            Delay 500ms   ⏳ (exponential: 500 × 2^0)
                          ↓
Attempt 2 ──────────────►  🌐 Broker API
                          ⏱️ 0-15000ms timeout
                          ↓ FAIL? (5xx, timeout, network)
                          ↓ Retriable? YES
                          ↓
            Delay 1000ms  ⏳ (exponential: 500 × 2^1)
                          ↓
Attempt 3 ──────────────►  🌐 Broker API
                          ⏱️ 0-15000ms timeout
                          ↓ FAIL? (5xx, timeout, network)
                          ↓ Retriable? YES
                          ↓
            Delay 2000ms  ⏳ (exponential: 500 × 2^2)
                          ↓
Attempt 4 ──────────────►  🌐 Broker API
                          ⏱️ 0-15000ms timeout
                          ↓ FAIL? Throw error ❌
                          ↓ SUCCESS? Return ✅

WORST CASE: 15s + 500ms + 15s + 1000ms + 15s + 2000ms + 15s
          = 63,500ms (~64 seconds) 🔴🔴🔴

TYPICAL (1 retry): 1500ms + 500ms + 1500ms
                 = 3,500ms (~3.5 seconds) ⚠️


LAYER 2: FRONTEND RETRIES (Fixed 3-Second Delay)
────────────────────────────────────────────────

Frontend Attempt 1 ────►  Backend API (includes Layer 1 retries)
                         ⏱️ 1000-65000ms
                         ↓ FAIL? (status 0 or 5xx)
                         ↓ Retriable? YES
                         ↓
           Delay 3000ms  ⏳ (fixed delay)
                         ↓
Frontend Attempt 2 ────►  Backend API (includes Layer 1 retries)
                         ⏱️ 1000-65000ms
                         ↓ FAIL? (status 0 or 5xx)
                         ↓ Retriable? YES
                         ↓
           Delay 3000ms  ⏳ (fixed delay)
                         ↓
Frontend Attempt 3 ────►  Backend API (includes Layer 1 retries)
                         ⏱️ 1000-65000ms
                         ↓ FAIL? Throw error ❌
                         ↓ SUCCESS? Display ✅

WORST CASE COMBINED:
  Backend attempt 1:     63,500ms (all retries fail, throw 5xx)
  Frontend delay:         3,000ms
  Backend attempt 2:     63,500ms (all retries fail, throw 5xx)
  Frontend delay:         3,000ms
  Backend attempt 3:     63,500ms (finally succeeds)
  ────────────────────────────
  Total:               196,500ms (~3 minutes 16 seconds) 🔴🔴🔴

REALISTIC WORST CASE:
  Backend attempt 1:      4,000ms (1 retry, succeeds)
  Frontend success!
  ────────────────────────────
  Total:                 4,000ms (~4 seconds) ⚠️

REALISTIC BAD CASE (Frontend retries):
  Backend attempt 1:      4,000ms (backend retries, returns 503)
  Frontend delay:         3,000ms
  Backend attempt 2:      4,000ms (backend retries, succeeds)
  ────────────────────────────
  Total:                11,000ms (~11 seconds) 🔴
```

---

## Latency Sources Breakdown

```
┌────────────────────────────────────────────────────────┐
│           WHERE THE TIME GOES (Typical Order)          │
└────────────────────────────────────────────────────────┘

EQUITY ORDER (1455ms total)
───────────────────────────────────────────────────────
Frontend processing:         15ms  ▏ 1%
Backend validation:          10ms  ▏ 1%
Database queries:            15ms  ▏ 1%
Position fetch (live):      400ms  ████ 27%
Order payload building:       5ms  ▏ 0%
OpenAlgo API call:         1000ms  ████████████████ 69%  🔴
Response processing:         10ms  ▏ 1%


OPTIONS BUY_CE ORDER (2055ms total)
───────────────────────────────────────────────────────
Frontend processing:         15ms  ▏ 1%
Backend validation:          10ms  ▏ 0%
Database queries:            15ms  ▏ 1%
Option symbol resolution:   300ms  ██ 15%
Position fetch (live):      500ms  ████ 24%
Order payload building:       5ms  ▏ 0%
OpenAlgo API call:         1200ms  ████████████ 58%  🔴
Response processing:         10ms  ▏ 0%


OPTIONS REDUCE_CE FLOAT (3 strikes, 2655ms total)
───────────────────────────────────────────────────────
Frontend processing:         15ms  ▏ 1%
Backend validation:          10ms  ▏ 0%
Database queries:            15ms  ▏ 1%
Fetch all positions:        600ms  ████ 23%
Multi-strike calculation:    15ms  ▏ 1%
OpenAlgo API (3 parallel):  1500ms  ████████████ 56%  🔴
  (max of 3 orders, not sum)
Update database (3 orders):  30ms  ▏ 1%
Response processing:         10ms  ▏ 0%


WITH RETRIES (4655ms total - 1 retry per order)
───────────────────────────────────────────────────────
Frontend processing:         15ms  ▏ 0%
Backend validation:          10ms  ▏ 0%
Database queries:            15ms  ▏ 0%
Fetch all positions:        600ms  ████ 13%
OpenAlgo API (with retries):
  Attempt 1:               1500ms  ████ 32%  🔴
  Retry delay:              500ms  █ 11%     ⚠️
  Attempt 2:               1500ms  ████ 32%  🔴
Update database:             30ms  ▏ 1%
Response processing:         10ms  ▏ 0%

KEY INSIGHT: OpenAlgo API calls dominate the latency!
  - 58-69% of total time in normal cases
  - 64%+ with retries

OPTIMIZATION TARGETS:
  🔴 OpenAlgo API latency (broker-dependent, limited control)
  ⚠️ Retry delays (configurable, can optimize)
  📊 Position fetching (caching helps, but expires quickly)
  🔧 Symbol resolution (caching helps, 5-min TTL)
```

---

## Configuration Impact Analysis

```
┌────────────────────────────────────────────────────────┐
│     IMPACT OF DIFFERENT CONFIGURATION VALUES           │
└────────────────────────────────────────────────────────┘

SCENARIO: Single order with broker slowness
────────────────────────────────────────────────────────

CURRENT CONFIG:
  OpenAlgo timeout:     15,000ms
  Max retries:          3
  Retry delay:          500ms (exponential)
  Frontend retry delay: 3,000ms

  Order fails 2×, succeeds on attempt 3:
    Attempt 1:  2000ms (slow broker, fails)
    Delay:       500ms
    Attempt 2:  2000ms (still slow, fails)
    Delay:      1000ms
    Attempt 3:  2000ms (succeeds)
    ─────────────────
    Total:      7500ms ⚠️


OPTIMIZED CONFIG:
  OpenAlgo timeout:     10,000ms (-5s)
  Max retries:          2 (-1)
  Retry delay:          300ms (-200ms, exponential)
  Frontend retry delay: 1,000ms (-2s)

  Same scenario (fails 2×, succeeds attempt 3):
    Attempt 1:  2000ms
    Delay:       300ms
    Attempt 2:  2000ms
    Delay:       600ms
    Attempt 3:  2000ms
    ─────────────────
    Total:      6900ms (8% faster) ✅


AGGRESSIVE CONFIG (higher risk):
  OpenAlgo timeout:      8,000ms
  Max retries:           1
  Retry delay:           200ms
  Frontend retry delay:  500ms

  Same scenario (but only 1 retry allowed):
    Attempt 1:  2000ms
    Delay:       200ms
    Attempt 2:  2000ms (succeeds)
    ─────────────────
    Total:      4200ms (44% faster!) ✅

  Risk: 3rd attempt not available, may fail more often


TIMEOUT IMPACT (broker timeouts after 15s):
────────────────────────────────────────────

Current (15s timeout):
  Attempt 1: 15000ms (timeout)
  Delay:       500ms
  Attempt 2: 15000ms (timeout)
  Delay:      1000ms
  Attempt 3:  1500ms (succeeds)
  ─────────────────
  Total:     33000ms (33 seconds!) 🔴🔴

Optimized (10s timeout):
  Attempt 1: 10000ms (timeout)
  Delay:       300ms
  Attempt 2: 10000ms (timeout)
  Delay:       600ms
  Attempt 3:  1500ms (succeeds)
  ─────────────────
  Total:     22400ms (22 seconds, 32% faster) ✅
```

---

## Cache Impact Analysis

```
┌────────────────────────────────────────────────────────┐
│              CACHE HIT vs MISS COMPARISON               │
└────────────────────────────────────────────────────────┘

OPTIONS BUY_CE ORDER
────────────────────────────────────────────────────────

SCENARIO A: ALL CACHE HITS (Best Case)
  Frontend:                15ms
  Backend:                 15ms
  Database:                15ms
  Symbol resolution:        5ms  (cached!)
  Position fetch:          10ms  (cached!)
  Order API:             1000ms
  Response:                10ms
  ──────────────────────────
  Total:                 1070ms ✅ FAST

SCENARIO B: ALL CACHE MISSES (Worst Case)
  Frontend:                15ms
  Backend:                 15ms
  Database:                15ms
  Symbol resolution:      500ms  (API call)
  Position fetch:         800ms  (API call)
  Order API:             1000ms
  Response:                10ms
  ──────────────────────────
  Total:                 2355ms (2.2× slower) 🔴

CACHE IMPACT: +1285ms (120% slower)


POSITION CACHE TTL COMPARISON
────────────────────────────────────────────────────────

Current TTL: 8 seconds
  During active trading (1 order every 5 seconds):
    Order 1:  Cache miss  (first order)
    Order 2:  Cache hit   (5s < 8s TTL)
    Order 3:  Cache miss  (10s > 8s TTL)
    Order 4:  Cache hit   (15s, cached from order 3)
    ──────────────────────
    Cache hit rate: 50%
    Avg penalty: 400ms × 50% = 200ms per order

Proposed TTL: 15 seconds
  Same scenario:
    Order 1:  Cache miss
    Order 2:  Cache hit   (5s < 15s)
    Order 3:  Cache hit   (10s < 15s)
    Order 4:  Cache hit   (15s = 15s, just barely!)
    ──────────────────────
    Cache hit rate: 75%
    Avg penalty: 400ms × 25% = 100ms per order
    IMPROVEMENT: 100ms saved per order ✅

Trade-off: Stale position data risk increases
```

---

## Summary

The diagrams above illustrate:

1. **Complete system flow** from button click to broker API
2. **Trade mode workflows** (EQUITY, FUTURES, OPTIONS)
3. **Multi-strike parallelization** (already implemented!)
4. **Multi-instance broadcasting** (with parallelization)
5. **Retry mechanisms** (3 layers of defense)
6. **Latency breakdown** (where time is spent)
7. **Configuration impact** (tuning for performance)
8. **Cache effectiveness** (hits vs misses)

Key takeaways:

- ✅ **System is well-architected** with parallel execution
- 🔴 **Primary bottleneck:** Broker API latency (58-69% of time)
- ⚠️ **Secondary bottleneck:** Retry logic (adds 3-10 seconds)
- 📊 **Optimization opportunity:** Reduce timeouts and retry delays
- 🎯 **UX improvement:** Add progress indicators for multi-order operations
