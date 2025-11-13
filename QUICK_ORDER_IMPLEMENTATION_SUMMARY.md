# Quick Order Implementation Summary

## Overview
Complete implementation of the watchlist row expansion feature with quick order placement for EQUITY, FUTURES, and OPTIONS trading modes.

## Features Implemented

### 1. Expiry Date Selector ✅
- **Location**: Shows when FUTURES or OPTIONS mode is selected
- **Functionality**:
  - Fetches available expiries from OpenAlgo API
  - Auto-selects nearest expiry by default
  - User can select any available expiry from dropdown
  - Expiry is included in order request

### 2. Options Leg Selector ✅
- **Location**: Shows when OPTIONS mode is selected
- **Options**: ITM3, ITM2, ITM1, ATM, OTM1, OTM2, OTM3
- **Default**: ATM
- **Functionality**: Selected leg is used for strike price calculation

### 3. Trade Mode Switching ✅
- **Modes**: EQUITY, FUTURES, OPTIONS
- **Auto-detection**: Based on symbol type (INDEX → OPTIONS, EQUITY_FNO → EQUITY by default)
- **Dynamic UI**: Shows/hides expiry and options leg selectors based on mode

### 4. Order Placement ✅
- **OPTIONS Actions**: BUY CE, SELL CE, BUY PE, SELL PE, EXIT, EXIT ALL
- **EQUITY/FUTURES Actions**: BUY, SELL, EXIT
- **Broadcasts to all assigned instances** when no specific instance selected

## Issues Fixed

### Issue 1: Exchange Mapping for Derivatives
**Problem**: NIFTY stored with exchange `NSE_INDEX`, but derivatives trade on `NFO`
**Solution**: Added `getDerivativeExchange()` to map:
- `NSE_INDEX` → `NFO`
- `NSE` → `NFO`
- `BSE` → `BFO`
- etc.

**Files**: `backend/public/js/quick-order.js:364-378`

### Issue 2: Instance Query Reliability
**Problem**: `api.getInstances({ is_active: 1 })` not returning results
**Solution**: Added fallback logic to fetch all instances and filter client-side

**Files**: `backend/public/js/quick-order.js:341-363`

### Issue 3: API Contract Mismatch
**Problem**: Route expected `symbol`/`exchange`, service expected `symbolId`
**Solution**: Updated route to accept `symbolId` (watchlist symbol database ID)

**Files**:
- `backend/src/routes/v1/quickorders.js:30-115`
- `backend/public/js/quick-order.js:467`

### Issue 4: Undefined Instance ID
**Problem**: Service threw error when `instanceId` was undefined
**Solution**: Modified service to treat undefined as "broadcast to all assigned instances"

**Files**: `backend/src/services/quick-order.service.js:148-165`

### Issue 5: Trade Mode Not Persisted
**Problem**: `selectedTradeModes` Map was empty, defaulting to EQUITY
**Solution**: Initialize Map with default values when row first expands

**Files**: `backend/public/js/quick-order.js:63-73`

### Issue 6: No Instances Assigned to Watchlist
**Problem**: `watchlist_instances` table was empty
**Solution**: Created script to assign instances to watchlists

**Files**: `backend/assign-instance-to-watchlist.js`

**Run with**: `node backend/assign-instance-to-watchlist.js`

## API Endpoints

### POST /api/v1/quickorders
Place a quick order from watchlist row.

**Request Body**:
```json
{
  "symbolId": 123,
  "action": "BUY_CE",
  "tradeMode": "OPTIONS",
  "optionsLeg": "ATM",
  "quantity": 1,
  "expiry": "2025-11-18",
  "instanceId": 1,
  "product": "MIS"
}
```

**Response**:
```json
{
  "status": "success",
  "message": "Quick order placed: 1 successful, 0 failed",
  "data": {
    "results": [...],
    "summary": {
      "total": 1,
      "successful": 1,
      "failed": 0
    }
  }
}
```

### GET /api/v1/symbols/expiry
Get available expiry dates for a symbol.

**Query Parameters**:
- `symbol` - Underlying symbol (e.g., NIFTY, BANKNIFTY)
- `instanceId` - Instance ID to fetch expiries from
- `exchange` - Exchange (e.g., NFO, BFO)

**Response**:
```json
{
  "status": "success",
  "data": ["2025-11-18", "2025-11-25", "2025-12-26", ...]
}
```

## Frontend Components

### QuickOrderHandler Class
**Location**: `backend/public/js/quick-order.js`

**Key Methods**:
- `toggleRowExpansion(watchlistId, symbolId)` - Expand/collapse row
- `loadExpansionContent(watchlistId, symbolId)` - Load trading controls with expiries
- `selectTradeMode(symbolId, mode)` - Switch between EQUITY/FUTURES/OPTIONS
- `selectExpiry(symbolId, expiry)` - Select expiry date
- `selectOptionsLeg(symbolId, leg)` - Select strike offset
- `updateQuantity(symbolId, quantity)` - Update order quantity
- `placeOrder(watchlistId, symbolId, action)` - Place order
- `fetchAvailableExpiries(symbol, exchange)` - Fetch expiry dates from API
- `getDerivativeExchange(exchange, symbolType)` - Map cash to derivative exchange

**State Management**:
```javascript
{
  expandedRows: Set,              // Which rows are expanded
  defaultQuantities: Map,         // symbolId -> quantity
  selectedTradeModes: Map,        // symbolId -> "EQUITY"|"FUTURES"|"OPTIONS"
  selectedOptionsLegs: Map,       // symbolId -> "ATM"|"ITM1"|...
  selectedExpiries: Map,          // symbolId -> "2025-11-18"
  availableExpiries: Map          // symbolId -> ["2025-11-18", ...]
}
```

## Backend Services

### QuickOrderService
**Location**: `backend/src/services/quick-order.service.js`

**Key Changes**:
- Accept `expiry` parameter (line 39)
- Accept `optionsLeg` parameter (line 40)
- Use user-selected expiry instead of auto-selecting (line 353-364)
- Use user-selected options leg for strike calculation (line 367-368)
- Handle undefined instanceId by broadcasting (line 150)

## Testing Tools

### 1. Instance Diagnostics Page
**URL**: `http://localhost:3000/instance-diagnostics.html`

**Features**:
- Check all instances status
- Force activate instances
- Test connection
- Test expiry fetch

### 2. Quick Order Flow Test Page
**URL**: `http://localhost:3000/test-quick-order-flow.html`

**Features**:
- Test script loading
- Test active instance check
- Test API expiry fetch
- Test QuickOrderHandler methods
- Full integration test with mock watchlist

### 3. Setup Instance Page
**URL**: `http://localhost:3000/setup-instance.html`

**Features**:
- Add Flattrade instance
- Test expiry fetch
- Quick navigation to dashboard

## Setup Instructions

### 1. Ensure Database is Migrated
```bash
cd backend
npm run migrate
```

### 2. Add OpenAlgo Instance
```bash
# Either use setup-instance.html in browser
# Or run:
curl -X POST http://localhost:3000/api/v1/instances \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Flattrade OpenAlgo",
    "host_url": "https://flattrade.simplifyed.in",
    "api_key": "YOUR_API_KEY",
    "is_active": true,
    "order_placement_enabled": true
  }'
```

### 3. Assign Instance to Watchlist
```bash
cd backend
node assign-instance-to-watchlist.js
```

### 4. Start Server
```bash
cd backend
npm run dev
```

### 5. Open Dashboard
```
http://localhost:3000/dashboard.html
```

## Usage Flow

1. **Navigate to Watchlists**
2. **Expand a watchlist** (click ▶)
3. **Expand a symbol row** (click ▼)
4. **Select trade mode**: EQUITY / FUTURES / OPTIONS
5. **For FUTURES/OPTIONS**: Select expiry from dropdown
6. **For OPTIONS**: Select options leg (ATM, ITM1, etc.)
7. **Set quantity**
8. **Click action button**:
   - OPTIONS: BUY CE, SELL CE, BUY PE, SELL PE, EXIT, EXIT ALL
   - EQUITY/FUTURES: BUY, SELL, EXIT

## File Structure

```
backend/
├── public/
│   ├── js/
│   │   ├── quick-order.js           # Main quick order handler
│   │   ├── api-client.js            # API client with placeQuickOrder()
│   │   └── utils.js                 # Utility functions
│   ├── css/
│   │   └── styles.css               # Styles for quick order UI
│   ├── dashboard.html               # Main dashboard
│   ├── instance-diagnostics.html    # Diagnostic tool
│   ├── setup-instance.html          # Instance setup tool
│   └── test-quick-order-flow.html   # Testing tool
├── src/
│   ├── routes/v1/
│   │   ├── quickorders.js           # Quick order API routes
│   │   └── symbols.js               # Symbol/expiry API routes
│   └── services/
│       ├── quick-order.service.js   # Quick order business logic
│       ├── options-resolution.service.js  # Strike price calculation
│       └── expiry-management.service.js   # Expiry selection logic
└── assign-instance-to-watchlist.js  # Helper script
```

## Debug Logging

Enable debug logging by checking browser console:
- `[QuickOrder]` prefix on all logs
- Shows trade mode selection, expiry fetching, order data
- Displays Map contents for debugging state

## Known Limitations

1. **FUTURES Expiry Selection**:
   - Works if symbol is already a FUTURES symbol
   - Underlying → futures resolution needs enhancement

2. **Position Reconciliation**:
   - OPTIONS orders auto-close opposite positions
   - May need user confirmation UI in future

3. **Lot Size Handling**:
   - Currently uses lot_size from watchlist_symbols table
   - May need enhancement for dynamic lot size lookup

## Next Steps

1. Add position display in expansion row
2. Add order confirmation dialog
3. Add P&L display per symbol
4. Enhance FUTURES symbol resolution
5. Add order status tracking in UI
6. Add cancel order functionality from expansion row

## Git Commits

Key commits implementing this feature:
- `a11e5d3` - Exchange mapping fix
- `87d5d8d` - User-selected expiry/leg support
- `f16c690` - Route parameter fix
- `e047fb0` - Instance ID broadcast fix
- `4fe742f` - Map initialization fix
- `ac19539` - Instance assignment script

## Status

✅ **COMPLETE** - Feature fully functional for OPTIONS trading
⚠️ **PARTIAL** - FUTURES needs additional work for underlying resolution
✅ **TESTED** - Tested with Flattrade OpenAlgo instance

---

**Last Updated**: 2025-11-12
**Branch**: `claude/document-app-routes-011CV4BntUihn6sWbSm5u2XT`
