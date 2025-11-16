# Phase 5 Progress: API Routes Complete

**Status**: 🔄 In Progress (API Routes Complete)
**Date**: 2025-11-16
**Phase Duration**: Week 7 of 8-week implementation

## Overview

Phase 5 adds the final API routes needed to expose the enhanced order service and risk management features to the frontend. This completes the REST API layer for the Watchlist Trading Spec v3 implementation.

## What Was Built

### 1. Enhanced Order Routes (`backend/src/routes/v1/orders.js` - MODIFIED)

**NEW ENDPOINTS**:

#### `POST /api/v1/orders/enhanced`
Place order with server-side intelligence

**Request Body**:
```json
{
  "instanceId": 1,
  "watchlistId": 1,
  "symbol": "NIFTY_ATM_CE",  // Template or actual symbol
  "exchange": "NFO",
  "targetQty": 50,            // Target position (not delta)
  "intentId": "optional-uuid",// For idempotency
  "context": {
    "indexName": "NIFTY",
    "expiry": "2024-11-28"
  }
}
```

**Response**:
```json
{
  "status": "success",
  "message": "Order placed successfully",
  "data": {
    "success": true,
    "intent_id": "uuid-1234",
    "order": {...},
    "delta": 50,
    "resolved_symbol": "NIFTY24NOV24400CE"
  }
}
```

**Features**:
- Server-side symbol resolution (templates → actual symbols)
- Delta calculation (target - current = order qty)
- Pyramiding logic enforcement
- Idempotent via intent_id
- Automatic risk enablement

#### `GET /api/v1/orders/intents`
Get trade intents with filters

**Query Params**:
- `status`: pending, failed, completed
- `instanceId`: Filter by instance

**Response**:
```json
{
  "status": "success",
  "data": [
    {
      "intent_id": "uuid-1234",
      "symbol": "NIFTY24NOV24400CE",
      "action": "BUY",
      "target_qty": 50,
      "status": "completed",
      "created_at": "2024-11-16T10:00:00Z"
    }
  ],
  "count": 1
}
```

#### `GET /api/v1/orders/intents/:intentId`
Get trade intent execution summary

**Response**:
```json
{
  "status": "success",
  "data": {
    "intent": {...},
    "orders": [...],
    "order_count": 1,
    "total_qty": 50,
    "successful_orders": 1,
    "failed_orders": 0
  }
}
```

#### `POST /api/v1/orders/intents/:intentId/retry`
Retry a failed trade intent

**Response**:
```json
{
  "status": "success",
  "message": "Intent reset for retry",
  "data": {...}
}
```

### 2. Risk Exits Routes (`backend/src/routes/v1/risk-exits.routes.js` - NEW)

**NEW FILE**: Complete risk exit monitoring API

#### `GET /api/v1/risk-exits`
Get risk exits with filters

**Query Params**:
- `status`: pending, executing, completed, failed
- `instanceId`: Filter by instance
- `limit`: Max results (default: 100)

**Response**:
```json
{
  "status": "success",
  "data": [
    {
      "risk_trigger_id": "uuid-5678",
      "trigger_type": "TP_HIT",
      "trigger_price": 160,
      "target_price": 160,
      "qty_at_trigger": 50,
      "pnl_per_unit": 10,
      "total_pnl": 500,
      "status": "completed",
      "symbol": "NIFTY24NOV24400CE",
      "instance_name": "Production",
      "triggered_at": "2024-11-16T10:30:00Z"
    }
  ],
  "count": 1
}
```

#### `GET /api/v1/risk-exits/:riskTriggerId`
Get specific risk exit details

**Response**:
```json
{
  "status": "success",
  "data": {
    "risk_trigger_id": "uuid-5678",
    "trigger_type": "TP_HIT",
    "exit_orders": [
      {
        "symbol": "NIFTY24NOV24400CE",
        "action": "SELL",
        "qty": 50,
        "reason": "TP_HIT_LEG"
      }
    ],
    "execution_summary": {
      "orders_placed": 1,
      "total_orders": 1
    }
  }
}
```

#### `GET /api/v1/risk-exits/stats/summary`
Get risk exit statistics

**Query Params**:
- `instanceId`: Filter by instance
- `days`: Period in days (default: 7)

**Response**:
```json
{
  "status": "success",
  "data": {
    "total_exits": 25,
    "completed": 23,
    "failed": 1,
    "pending": 1,
    "tp_exits": 15,
    "sl_exits": 5,
    "tsl_exits": 5,
    "total_pnl": 12500,
    "avg_pnl": 500,
    "executor": {
      "active_executions": 0,
      "is_running": true
    },
    "period_days": 7
  }
}
```

#### `GET /api/v1/risk-exits/pending/list`
Get all pending risk exits

**Response**:
```json
{
  "status": "success",
  "data": [
    {
      "risk_trigger_id": "uuid-9999",
      "trigger_type": "SL_HIT",
      "status": "pending",
      "triggered_at": "2024-11-16T11:00:00Z"
    }
  ],
  "count": 1
}
```

### 3. Routes Integration (`backend/src/routes/v1/index.js` - MODIFIED)

**Added**:
- Imported `riskExitsRoutes`
- Mounted at `/api/v1/risk-exits`

**Complete API Structure**:
```
/api/v1/
  ├── /orders                    (existing + enhanced endpoints)
  │   ├── POST /enhanced        ← NEW
  │   ├── GET /intents          ← NEW
  │   ├── GET /intents/:id      ← NEW
  │   └── POST /intents/:id/retry ← NEW
  │
  ├── /risk-exits               ← NEW
  │   ├── GET /
  │   ├── GET /:riskTriggerId
  │   ├── GET /stats/summary
  │   └── GET /pending/list
  │
  ├── /settings                 (from Phase 2)
  ├── /instances                (existing)
  ├── /watchlists               (existing)
  ├── /positions                (existing)
  └── ...
```

## API Usage Examples

### Example 1: Place Order with Template Symbol

```bash
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "watchlistId": 1,
    "symbol": "NIFTY_ATM_CE",
    "exchange": "NFO",
    "targetQty": 50,
    "context": {
      "indexName": "NIFTY"
    }
  }'
```

**What Happens**:
1. Server resolves "NIFTY_ATM_CE" to "NIFTY24NOV24400CE" (based on current LTP)
2. Checks current position (e.g., 0 lots)
3. Calculates delta: 50 - 0 = 50 (BUY 50)
4. Creates trade intent with UUID
5. Places order via OpenAlgo
6. Enables risk management (TP/SL/TSL) from settings
7. Returns result with resolved symbol and delta

### Example 2: Monitor Risk Exits

```bash
# Get recent risk exits
curl http://localhost:3000/api/v1/risk-exits?limit=10

# Get TP exits only
curl "http://localhost:3000/api/v1/risk-exits?status=completed&limit=20"

# Get stats for last 7 days
curl http://localhost:3000/api/v1/risk-exits/stats/summary?days=7

# Get specific risk exit details
curl http://localhost:3000/api/v1/risk-exits/uuid-5678
```

### Example 3: Check Pending Intents

```bash
# Get all pending intents
curl http://localhost:3000/api/v1/orders/intents?status=pending

# Get intent summary
curl http://localhost:3000/api/v1/orders/intents/uuid-1234

# Retry failed intent
curl -X POST http://localhost:3000/api/v1/orders/intents/uuid-1234/retry
```

## Integration with Existing Features

### Combines with Phase 2 Settings

The enhanced order endpoint automatically uses the settings service:

```javascript
// Settings determine:
// - Strike policy (FLOAT_OFS vs DISCRETE_OFS)
// - TP/SL/TSL configuration
// - Pyramiding mode (reanchor, scale, ignore)
// - Exit scope (LEG, TYPE, INDEX)

const settings = await settingsService.getEffectiveSettings({
  userId,
  watchlistId,
  indexName,
  symbol,
  exchange
});
```

### Combines with Phase 3 Risk Engine

Risk exits are created by the risk engine and exposed via the new routes:

```javascript
// Risk engine creates risk_exits records
// Risk exit executor processes them
// Frontend polls /api/v1/risk-exits to show status
```

### Combines with Phase 4 Services

The enhanced order endpoint uses all Phase 4 services:

```javascript
// Symbol Resolver: Template → Actual symbol
// Trade Intent: Idempotency tracking
// Order Service: Delta calculation + placement
// Fill Aggregator: Position tracking
// Risk Engine: TP/SL/TSL monitoring
```

## Authentication

All endpoints use the existing authentication middleware:
- Authenticated requests use `req.user.id`
- Test mode defaults to user ID 1

## Error Handling

Standard error responses:

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "targetQty",
      "message": "targetQty is required"
    }
  ]
}
```

## What's Next

### Phase 5 Remaining (Frontend UI):
- [ ] Settings management UI
- [ ] Enhanced quick order form (template symbol support)
- [ ] Risk exits monitoring dashboard
- [ ] Position monitoring with current P&L
- [ ] Trade intents history view

### Phase 6: Testing & Validation (Week 8):
- [ ] End-to-end testing with paper trading
- [ ] Load testing
- [ ] Edge case testing
- [ ] Production readiness review

## Summary

Phase 5 API routes complete the REST API layer for:

✅ **Enhanced order placement** (POST /api/v1/orders/enhanced)
✅ **Trade intent management** (GET/POST /api/v1/orders/intents/...)
✅ **Risk exit monitoring** (GET /api/v1/risk-exits/...)
✅ **Risk exit statistics** (GET /api/v1/risk-exits/stats/summary)

The backend is now **fully API-complete** and ready for frontend integration.

All features are:
- RESTful and well-documented
- Integrated with existing authentication
- Using existing error handling
- Following established patterns

**Next Step**: Create frontend UI components to consume these APIs.

---

**API Routes Complete**: 2025-11-16
**Ready for Frontend Development**: Yes
**Ready for Production**: No (requires Phase 5 Frontend + Phase 6 Testing)

## Files Changed

```
✅ backend/src/routes/v1/orders.js (MODIFIED - added 4 enhanced endpoints)
✅ backend/src/routes/v1/risk-exits.routes.js (NEW - 5 endpoints)
✅ backend/src/routes/v1/index.js (MODIFIED - registered risk-exits routes)
```

**Total**: 1 new routes file, 2 modified files, 8 new API endpoints
