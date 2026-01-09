# Instance Multipliers - Data Flow Architecture

## Overview
This document visualizes how the multiplier flows through the system from configuration to order placement.

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     INSTANCE CONFIGURATION                       │
│                                                                   │
│  ┌─────────────────┐    ┌─────────────────┐                      │
│  │   Instance A     │    │   Instance B     │                      │
│  │  Multiplier: 1x │    │  Multiplier: 3x  │                      │
│  └─────────────────┘    └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Fetched from DB
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SIGNAL SOURCES (Input)                         │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Frontend     │  │   API Call   │  │ TradingView  │          │
│  │ Quick Order  │  │   Direct     │  │   Webhook    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                  │                  │                   │
│         │  Qty: 10        │  Qty: 10        │  Qty: 10         │
│         │                  │                  │                   │
└─────────┼──────────────────┼──────────────────┼───────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                ORDER PROCESSING LAYER                            │
│                                                                   │
│  ┌──────────────────────────────────────────────────┐          │
│  │  QuickOrder Service (quick-order.service.js)     │          │
│  │                                                   │          │
│  │  Line 757:                                       │          │
│  │  tradeQuantity = qty * lotSize * multiplier      │          │
│  │                                                   │          │
│  │  Instance A: 10 * 1 * 1 = 10                     │          │
│  │  Instance B: 10 * 1 * 3 = 30                     │          │
│  └────────────────────┬─────────────────────────────┘          │
│                       │                                         │
│                       ▼ Final Quantity                         │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                MULTI-INSTANCE BROADCAST                         │
│                                                                   │
│  ┌──────────────────────┐     ┌──────────────────────┐         │
│  │  TradingView Service  │────▶│  Instance A (1x)    │         │
│  │  (broadcast.service)  │     │  Receives: 10       │         │
│  │                       │     └──────────────────────┘         │
│  │  Applies multiplier   │                                     │
│  │  per instance         │     ┌──────────────────────┐         │
│  └──────────────────────┘     │  Instance B (3x)      │         │
│                               │  Receives: 30         │         │
│                               └──────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     BROKER EXECUTION                            │
│                                                                   │
│  ┌─────────────────┐         ┌─────────────────┐                │
│  │   Broker A      │         │   Broker B      │                │
│  │ Order: 10 qty  │         │ Order: 30 qty  │                │
│  └─────────────────┘         └─────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

## Detailed Data Flow Scenarios

### Scenario 1: Frontend Quick Order

```
Frontend User
    │
    │ Click "Buy 10 qty"
    ▼
Frontend Form
    │
    ├─▶ Instance ID: 1
    ├─▶ Quantity: 10
    ├─▶ Exchange: NSE
    ├─▶ Symbol: RELIANCE
    ▼
API Route (instances API)
    │
    ├─▶ Validate multiplier exists (default 1)
    ▼
Instance Service
    │
    ├─▶ Fetch instance from DB
    │   {
    │     id: 1,
    │     name: "Broker A",
    │     multiplier: 2,
    │     ...
    │   }
    ▼
QuickOrder Service (Line 757)
    │
    ├─▶ lotSize = 1 (for RELIANCE)
    ├─▶ quantity = 10 (user input)
    ├─▶ instance.multiplier = 2
    │
    ├─▶ CALC: tradeQuantity = 10 * 1 * 2 = 20
    │
    ▼
OpenAlgo Client
    │
    ├─▶ placeSmartOrder({
    │     exchange: "NSE",
    │     tradingsymbol: "RELIANCE",
    │     quantity: 20,  ← MULTIPLIED!
    │     ...
    │   })
    ▼
Broker API
    │
    └─▶ Executes order for 20 qty (2x original)
```

### Scenario 2: TradingView Webhook Broadcast

```
TradingView Alert
    │
    ├─▶ {"symbol": "RELIANCE", "qty": 10, "side": "BUY"}
    ▼
TradingView Webhook Route
    │
    ├─▶ Parse payload
    ├─▶ quantity = 10
    ▼
TradingView Broadcast Service
    │
    ├─▶ Resolve targets (2 instances)
    │   Instance A: multiplier = 1
    │   Instance B: multiplier = 3
    │
    ├─▶ Parallel dispatch:
    │
    ├─▶ Dispatch to Instance A
    │   ├─▶ Fetch multiplier: 1
    │   ├─▶ finalQuantity = 10 * 1 = 10
    │   └─▶ POST /api/v1/placesmartorder
    │
    └─▶ Dispatch to Instance B
        ├─▶ Fetch multiplier: 3
        ├─▶ finalQuantity = 10 * 3 = 30
        └─▶ POST /api/v1/placesmartorder

Both instances receive different quantities!
    │
    ▼
Parallel Execution
    │
    ┌──────────────┬──────────────┐
    ▼              ▼
Broker A        Broker B
Order: 10      Order: 30
```

## Code Flow Diagram

### QuickOrder Service Flow

```
START: Place Quick Order
    │
    ▼
Fetch Instance Data
    │
    ├─▶ instance.multiplier = ?
    │
    ▼
Calculate Quantity (Line 757)
    │
    ├─▶ quantity = user_input (e.g., 10)
    ├─▶ lotSize = resolved from symbol (e.g., 1)
    ├─▶ multiplier = instance.multiplier || 1
    │
    ├─▶ tradeQuantity = quantity * lotSize * multiplier
    │
    ▼
Log Calculation (Line 761)
    │
    ├─▶ Log: inputQuantity, lotSize, tradeQuantity, multiplier
    │
    ▼
Place Order via OpenAlgo Client
    │
    └─▶ { quantity: tradeQuantity, ... }
    │
    ▼
END
```

### TradingView Broadcast Flow

```
START: Receive Webhook
    │
    ▼
Parse & Validate Payload
    │
    ├─▶ normalized.quantity = ?
    │
    ▼
Resolve Targets
    │
    ├─▶ Get all broadcast targets
    ├─▶ For each target, fetch instance data
    │
    ▼
For Each Target (Parallel)
    │
    ├─▶ Get instance ID from target
    ├─▶ Fetch instance.multiplier
    │
    ├─▶ finalQuantity = payload.quantity * multiplier
    │
    ▼
Dispatch to Target
    │
    ├─▶ Apply multiplier to payload
    ├─▶ POST to broker endpoint
    │
    ▼
END (Promise.allSettled)
```

## Database Schema

### Instances Table (After Migration)

```sql
CREATE TABLE instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host_url TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  strategy_tag TEXT,
  -- ... other fields ...
  multiplier INTEGER DEFAULT 1,  -- NEW FIELD
  -- ... other fields ...
);
```

### Multiplier Values by Instance Type

| Instance | Multiplier | Use Case |
|----------|-----------|----------|
| Primary Admin | 1x | Standard trading |
| Secondary Admin | 1x | Backup/Standby |
| Paper Trading | 1x | Testing/Simulation |
| Production Live | 2x | Double position sizing |
| Scalping | 3x | High-frequency, small targets |
| Swing Trading | 1x | Longer holding period |

## Multiplier Application Matrix

### Trade Mode Support

| Trade Mode | Multiplier Applied | Example |
|------------|-------------------|---------|
| EQUITY | ✅ Yes | RELIANCE: 10 qty → 20 qty (2x) |
| FUTURES | ✅ Yes | NIFTY: 1 lot → 2 lots (2x) |
| OPTIONS | ✅ Yes | Strike selection, applied per strike |
| COVER | ✅ Yes | Position-aware, multiplier applied |
| AMO | ✅ Yes | After-market, multiplier applied |

### Signal Source Support

| Source | Multiplier Applied | Implementation |
|--------|-------------------|----------------|
| Frontend Quick Buttons | ✅ Yes | quick-order.service.js line 757 |
| API Direct Calls | ✅ Yes | API routes → instance service |
| TradingView Webhooks | ✅ Yes | broadcast.service.js dispatch |
| Watchlist Auto-Trading | ✅ Yes | Same as quick-order flow |
| Scheduled Orders | ✅ Yes | Same as quick-order flow |

## Performance Characteristics

### Query Patterns

```
Quick Order (Single Instance)
├─▶ Fetch instance: 1 query
├─▶ Calculate: O(1)
└─▶ Total: ~5ms

TradingView Broadcast (N Instances)
├─▶ Fetch all instances: 1 query
├─▶ Apply multipliers: O(N)
└─▶ Total: ~5ms + (N × 2ms)
```

### Memory Usage

- **Per Instance**: +4 bytes (integer multiplier)
- **Caching**: Already cached in instance telemetry
- **Impact**: Negligible

## Error Handling Scenarios

### Scenario: Missing Multiplier

```
Instance exists, multiplier = NULL
    │
    ▼
QuickOrder Service (Line 757)
    │
    ├─▶ multiplier = instance.multiplier || 1
    ├─▶ Falls back to 1
    │
    ▼
Order Placed
    └─▶ No multiplication (acts as 1x)
```

### Scenario: Invalid Multiplier

```
API Route Validation
    │
    ├─▶ multiplier = "abc" (invalid)
    ├─▶ Validation fails
    │
    ▼
Error Response
    └─▶ HTTP 400: "Multiplier must be 1-999"
```

### Scenario: Broadcast Target Without Instance ID

```
Target exists but no instanceId
    │
    ▼
TradingView Dispatch
    │
    ├─▶ Cannot fetch multiplier
    ├─▶ Warning logged
    ├─▶ Uses original quantity (no multiplication)
    │
    ▼
Order Placed
    └─▶ Warning: "Failed to fetch instance multiplier"
```

## Logging & Monitoring

### Log Output Examples

```
[INFO] Instance created { id: 5, name: "Production", multiplier: 2 }

[INFO] Calculated trade quantity {
  inputQuantity: 10,
  lotSize: 1,
  tradeQuantity: 20,
  instanceMultiplier: 2,  ← NEW FIELD
  instance_id: 5,
  symbol: "RELIANCE"
}

[DEBUG] [TV Webhook] Applied instance multiplier {
  target: "Production",
  instanceId: 5,
  originalQuantity: 10,
  multiplier: 2,
  finalQuantity: 20
}
```

### Metrics to Track

```
instance_multipliers_configured_total
instance_multipliers_avg_value
order_quantity_multiplier_applied_total
order_quantity_multiplier_avg_factor
broadcast_multiplier_distribution
api_validation_multiplier_errors_total
```

## Testing Data Flows

### Test Setup

```javascript
// Setup: Create test instances
const instance1 = await instanceService.createInstance({
  name: "Test A",
  multiplier: 1,
});

const instance2 = await instanceService.createInstance({
  name: "Test B",
  multiplier: 3,
});

// Test: Quick Order
const result = await quickOrderService.placeOrder({
  instance: instance2,
  quantity: 10,
  symbol: "RELIANCE",
});

// Verify: Broker receives 30 (10 * 3)
assert(result.order.quantity === 30);

// Test: Broadcast
const broadcastResult = await tradingViewService.broadcast({
  quantity: 10,
}, {});

// Verify: Different instances get different quantities
assert(instanceAReceived === 10);
assert(instanceBReceived === 30);
```

## Security Considerations

### Input Validation

```javascript
// Multiplier must be:
- Integer (not float)
- Range: 1 to 999
- Not null/undefined
- Not negative
- Not zero
```

### Rate Limiting Impact

```
High Multiplier Example:
├─▶ User sets multiplier = 100x
├─▶ Places order for qty = 10
├─▶ Broker receives qty = 1000
├─▶ May hit broker rate limits
└─▶ Monitor for unusual multiplier values
```

## Conclusion

The multiplier flows through the system at multiple points:

1. **Configuration**: Stored in database per instance
2. **Calculation**: Applied in quick-order.service.js
3. **Broadcast**: Applied per instance in tradingview-broadcast.service.js
4. **Execution**: Sent to broker with multiplied quantity

The implementation is:
- ✅ Backwards compatible (defaults to 1)
- ✅ Minimal performance impact
- ✅ Consistent across all signal sources
- ✅ Well logged and monitored
- ✅ Thoroughly validated

All paths through the system apply the multiplier consistently, ensuring predictable behavior regardless of how orders are initiated.
