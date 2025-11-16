# Phase 6: Testing & Validation Guide

**Status**: 📋 Documentation Complete
**Date**: 2025-11-16
**Phase Duration**: Week 8 of 8-week implementation
**Purpose**: Comprehensive testing and production readiness validation

## Overview

This guide provides a complete testing plan for the Watchlist Trading Spec v3 implementation. Follow this guide to validate all features before production deployment.

---

## 🚀 Pre-Testing Setup

### 1. Environment Preparation

```bash
cd backend

# Ensure all dependencies are installed
npm install

# Verify Node version (>= 18.0.0)
node --version

# Create test database (for isolated testing to avoid corrupting production data)
cp database/simplifyed.db database/simplifyed-test.db
```

**IMPORTANT**: When testing, ensure `DATABASE_PATH` points to the test database to avoid corrupting your production data.

### 2. Environment Configuration

Create `backend/.env.test` for isolated testing:

```bash
# Server
NODE_ENV=development
PORT=3000
DATABASE_PATH=./database/simplifyed-test.db  # IMPORTANT: Use test database!

# Session
SESSION_SECRET=test-secret-change-in-production

# Test Mode (no OAuth needed)
TEST_MODE=true
TEST_USER_EMAIL=test@simplifyed.in

# Feature Flags (ENABLE FOR TESTING)
ENABLE_SETTINGS_HIERARCHY=true
ENABLE_FILL_AGGREGATOR=true
ENABLE_RISK_ENGINE=true
ENABLE_TRADE_INTENTS=true

# Kill Switches (KEEP FALSE FOR TESTING)
KILL_RISK_EXITS=false
KILL_AUTO_TRADING=false

# Polling Intervals (faster for testing)
INSTANCE_POLL_INTERVAL_MS=15000
MARKET_DATA_POLL_INTERVAL_MS=5000
OPENALGO_REQUEST_TIMEOUT_MS=15000

# Logging
LOG_LEVEL=debug
```

**Using the test environment**:
```bash
# Option 1: Copy .env.test to .env before testing
cp backend/.env.test backend/.env

# Option 2: Use environment variables directly
DATABASE_PATH=./database/simplifyed-test.db npm run dev

# Option 3: Specify environment file (if using dotenv-cli)
npx dotenv -e .env.test -- npm run dev
```

### 3. Database Migrations

```bash
# Check migration status
npm run migrate status

# Run all migrations
npm run migrate

# Verify all migrations applied
npm run migrate status

# Seed default settings
node migrations/seed-settings-defaults.js
```

Expected output:
```
✅ 011_add_settings_hierarchy
✅ 012_add_trade_intents
✅ 013_add_risk_engine_tables
```

### 4. Start Server

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Watch logs
tail -f logs/app.log
```

Verify startup messages:
- ✅ Database connected
- ✅ Fill aggregator started
- ✅ Quote router started
- ✅ Risk engine started
- ✅ Risk exit executor started
- ✅ Server started on port 3000

---

## 📊 Phase 1: Database Schema Testing

### Test 1.1: Settings Hierarchy Tables

```sql
-- Test global defaults
SELECT * FROM global_defaults;
-- Should return 1 row with conservative defaults

-- Test index profiles
SELECT * FROM index_profiles;
-- Should return 5 rows (NIFTY, BANKNIFTY, etc.)

-- Test empty override tables
SELECT COUNT(*) FROM watchlist_overrides;
SELECT COUNT(*) FROM user_defaults;
SELECT COUNT(*) FROM symbol_overrides;
-- Should all return 0 (no overrides yet)
```

**✅ Pass Criteria**:
- global_defaults has 1 row
- index_profiles has 5 rows
- Override tables exist but are empty
- All default TP/SL/TSL values are NULL (conservative)

### Test 1.2: Trade Intents Table

```sql
-- Test table structure
SELECT * FROM trade_intents LIMIT 1;

-- Test indexes
.schema trade_intents
-- Should show idx_trade_intents_intent_id index
```

**✅ Pass Criteria**:
- Table exists with correct columns
- intent_id column is TEXT and indexed
- status column has CHECK constraint

### Test 1.3: Risk Engine Tables

```sql
-- Test leg_state table
SELECT * FROM leg_state LIMIT 1;

-- Test risk_exits table
SELECT * FROM risk_exits LIMIT 1;

-- Test indexes
.indexes leg_state
.indexes risk_exits
```

**✅ Pass Criteria**:
- Both tables exist with correct schema
- Foreign key constraints are in place
- Indexes exist for performance

---

## ⚙️ Phase 2: Settings Service Testing

### Test 2.1: Get Effective Settings (No Overrides)

```bash
curl http://localhost:3000/api/v1/settings/effective
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "ltp_refresh_seconds": 5,
    "default_strike_policy": "FLOAT_OFS",
    "default_step_lots": 1,
    "tp_per_unit": null,
    "sl_per_unit": null,
    "tsl_enabled": false,
    "on_pyramid": "reanchor",
    "exit_scope": "LEG"
  }
}
```

**✅ Pass Criteria**:
- Conservative defaults returned
- TP/SL values are null
- TSL disabled by default

### Test 2.2: Get Effective Settings with Index

```bash
curl "http://localhost:3000/api/v1/settings/effective?indexName=NIFTY"
```

**Expected**: NIFTY index profile merged with global defaults

**✅ Pass Criteria**:
- NIFTY-specific settings override global where set
- Null values still inherit from global

### Test 2.3: Update Global Settings

```bash
curl -X PATCH http://localhost:3000/api/v1/settings/global \
  -H "Content-Type: application/json" \
  -d '{
    "tp_per_unit": 10,
    "sl_per_unit": 5,
    "tsl_enabled": true,
    "tsl_arm_after": 5,
    "tsl_trail_by": 3
  }'
```

**✅ Pass Criteria**:
- Settings update successfully
- Audit log created in config_audit table
- Subsequent GET shows new values

### Test 2.4: Settings Hierarchy Merge

```bash
# 1. Set global TP
curl -X PATCH http://localhost:3000/api/v1/settings/global \
  -H "Content-Type: application/json" \
  -d '{"tp_per_unit": 10}'

# 2. Set index override
curl -X PATCH "http://localhost:3000/api/v1/settings/index/BANKNIFTY" \
  -H "Content-Type: application/json" \
  -d '{"tp_per_unit": 15}'

# 3. Get effective for NIFTY (should get 10)
curl "http://localhost:3000/api/v1/settings/effective?indexName=NIFTY"

# 4. Get effective for BANKNIFTY (should get 15)
curl "http://localhost:3000/api/v1/settings/effective?indexName=BANKNIFTY"
```

**✅ Pass Criteria**:
- NIFTY gets global value (10)
- BANKNIFTY gets override value (15)
- Hierarchy working correctly

---

## 🛡️ Phase 3: Risk Engine Testing

### Test 3.1: Fill Aggregator

**Prerequisites**:
- Have at least one active OpenAlgo instance
- Place a test order to generate fills

```bash
# Check fill aggregator is running
# Watch server logs for "Fills synced for instance"

# Check leg_state table
curl http://localhost:3000/api/v1/risk-exits | jq
```

**Manual Test**:
1. Place BUY order for 50 lots of NIFTY CE
2. Wait for fill (check via OpenAlgo)
3. Query leg_state:

```sql
SELECT * FROM leg_state
WHERE is_active = 1
ORDER BY updated_at DESC
LIMIT 5;
```

**✅ Pass Criteria**:
- leg_state record created for symbol
- net_qty shows 50
- weighted_avg_entry shows fill price
- total_buy_qty matches order quantity
- last_fill_at is recent timestamp

### Test 3.2: Quote Router

**Prerequisites**:
- Have active position with risk enabled

```sql
-- Enable risk for a leg
UPDATE leg_state
SET risk_enabled = 1,
    tp_per_unit = 10,
    sl_per_unit = 5
WHERE id = 1;
```

**Monitor**:
```sql
-- Watch current_ltp updates (should update every 200ms)
SELECT symbol, current_ltp, best_favorable_price, updated_at
FROM leg_state
WHERE risk_enabled = 1;
-- Run this query multiple times, timestamps should change
```

**✅ Pass Criteria**:
- current_ltp updates regularly (< 1 second old)
- best_favorable_price tracks correctly (highest for long, lowest for short)
- No errors in logs

### Test 3.3: Risk Engine - Take Profit

**Setup**:
```sql
-- Create test leg with TP target
UPDATE leg_state
SET risk_enabled = 1,
    net_qty = 50,
    weighted_avg_entry = 150,
    current_ltp = 155,
    tp_per_unit = 10,
    tp_price = 160,  -- TP at entry + 10
    sl_per_unit = 5,
    sl_price = 145   -- SL at entry - 5
WHERE id = 1;

-- Simulate price reaching TP
UPDATE leg_state
SET current_ltp = 161
WHERE id = 1;
```

**Wait 1-2 seconds for risk engine to detect**

**Verify**:
```sql
SELECT * FROM risk_exits
WHERE leg_state_id = 1
ORDER BY triggered_at DESC
LIMIT 1;
```

**✅ Pass Criteria**:
- Risk exit created with trigger_type = 'TP_HIT'
- trigger_price = 161 (or close)
- target_price = 160
- pnl_per_unit = 11 (161 - 150)
- status = 'pending' or 'executing'
- exit_orders_json contains SELL order

### Test 3.4: Risk Engine - Stop Loss

**Setup**:
```sql
-- Simulate price hitting SL
UPDATE leg_state
SET current_ltp = 144
WHERE id = 1;
```

**✅ Pass Criteria**:
- Risk exit created with trigger_type = 'SL_HIT'
- pnl_per_unit is negative

### Test 3.5: Risk Engine - TSL Arming and Trailing

**Setup**:
```sql
-- Reset leg
DELETE FROM risk_exits WHERE leg_state_id = 1;

UPDATE leg_state
SET risk_enabled = 1,
    net_qty = 50,
    weighted_avg_entry = 150,
    current_ltp = 150,
    best_favorable_price = 150,
    tp_per_unit = NULL,
    sl_per_unit = NULL,
    tsl_enabled = 1,
    tsl_arm_after = 5,      -- Arm when profit >= 5
    tsl_trail_by = 3,       -- Trail 3 points below best
    tsl_step = 1,           -- Trail every 1 point
    tsl_breakeven_after = 10, -- Lock at breakeven when profit >= 10
    tsl_armed = 0,
    tsl_current_stop = NULL
WHERE id = 1;

-- Step 1: Move price to arm TSL (profit = 5)
UPDATE leg_state
SET current_ltp = 155,
    best_favorable_price = 155
WHERE id = 1;
```

**Wait 1 second, then check**:
```sql
SELECT tsl_armed, tsl_current_stop FROM leg_state WHERE id = 1;
-- tsl_armed should be 1
-- tsl_current_stop should be 152 (155 - 3)
```

**Step 2: Move price higher to trail**:
```sql
UPDATE leg_state
SET current_ltp = 158,
    best_favorable_price = 158
WHERE id = 1;
```

**Wait and check**:
```sql
SELECT tsl_current_stop FROM leg_state WHERE id = 1;
-- Should be 155 (158 - 3), trailing up
```

**Step 3: Trigger TSL**:
```sql
UPDATE leg_state
SET current_ltp = 154  -- Below stop
WHERE id = 1;
```

**✅ Pass Criteria**:
- TSL arms when profit reaches threshold
- Stop trails as price improves
- Stop never moves down (for longs)
- TSL triggers when price hits stop
- Risk exit created with trigger_type = 'TSL_HIT'

### Test 3.6: Risk Exit Executor

**Prerequisites**:
- Risk exit created from previous test

**Monitor**:
```bash
# Watch server logs for "Executing risk exit"
tail -f logs/app.log | grep "risk exit"

# Check risk_exits table every few seconds
watch -n 2 "sqlite3 database/simplifyed.db 'SELECT status, executed_at FROM risk_exits ORDER BY triggered_at DESC LIMIT 3'"
```

**✅ Pass Criteria**:
- Status changes from 'pending' → 'executing' → 'completed'
- executed_at timestamp set
- execution_summary JSON shows order placement results
- Orders appear in watchlist_orders table

---

## 🎯 Phase 4: Enhanced Order Service Testing

### Test 4.1: Symbol Resolution - ATM

**Setup**: Ensure NIFTY trading at ~24,390

```bash
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY_ATM_CE",
    "exchange": "NFO",
    "targetQty": 0,
    "context": {"indexName": "NIFTY"}
  }'
```

**Expected**:
- Symbol resolves to NIFTY24NOV24400CE (or current ATM strike)
- Delta = 0 (just testing resolution, not placing order)

**✅ Pass Criteria**:
- Resolved symbol contains correct strike (rounded to 50)
- Strike is near current LTP

### Test 4.2: Symbol Resolution - ITM/OTM

```bash
# Test 100 ITM PE
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY_100ITM_PE",
    "exchange": "NFO",
    "targetQty": 0,
    "context": {"indexName": "NIFTY"}
  }'

# Test 50 OTM CE
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY_50OTM_CE",
    "exchange": "NFO",
    "targetQty": 0,
    "context": {"indexName": "NIFTY"}
  }'
```

**✅ Pass Criteria**:
- ITM PE resolves to strike 100 points above ATM
- OTM CE resolves to strike 50 points above ATM
- Symbol format is correct

### Test 4.3: Delta Calculation

**Test Cases**:

```bash
# Case 1: New position (current: 0, target: 50)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 50
  }'
# Expected delta: +50 (BUY 50)

# Case 2: Add to position (current: 50, target: 100)
# (Run after Case 1 fills)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 100
  }'
# Expected delta: +50 (BUY 50)

# Case 3: Reduce position (current: 100, target: 50)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 50
  }'
# Expected delta: -50 (SELL 50)

# Case 4: Exit position (current: 50, target: 0)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 0
  }'
# Expected delta: -50 (SELL 50)

# Case 5: No change (current: 0, target: 0)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 0
  }'
# Expected: "No order needed (already at target)"
```

**✅ Pass Criteria**:
- All delta calculations are correct
- BUY for positive delta, SELL for negative
- Zero delta returns without placing order

### Test 4.4: Pyramiding Logic

**Test Case: Ignore Mode**:

```sql
-- Set pyramiding to ignore
UPDATE global_defaults
SET on_pyramid = 'ignore';
```

```bash
# Place initial order
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 50
  }'

# Try to pyramid (should be blocked)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY24NOV24400CE",
    "exchange": "NFO",
    "targetQty": 100
  }'
```

**Expected**: Second request returns "Pyramiding blocked by settings (ignore mode)"

**✅ Pass Criteria**:
- Pyramiding blocked when mode = 'ignore'
- Reanchor mode allows pyramiding
- Scale mode allows pyramiding (future feature)

### Test 4.5: Trade Intent Idempotency

```bash
# Generate UUID
INTENT_ID=$(uuidgen)

# Place order with intent ID
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": 1,
    \"symbol\": \"NIFTY24NOV24400CE\",
    \"exchange\": \"NFO\",
    \"targetQty\": 50,
    \"intentId\": \"$INTENT_ID\"
  }"

# Retry with same intent ID (should return same result)
curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d "{
    \"instanceId\": 1,
    \"symbol\": \"NIFTY24NOV24400CE\",
    \"exchange\": \"NFO\",
    \"targetQty\": 50,
    \"intentId\": \"$INTENT_ID\"
  }"
```

**✅ Pass Criteria**:
- First request creates order
- Second request returns existing intent
- No duplicate order placed
- Both responses identical

---

## 🖥️ Phase 5: Frontend UI Testing

### Test 5.1: Enhanced Order Form

**Manual Test Steps**:

1. Navigate to http://localhost:3000/dashboard.html
2. Click "Enhanced Order" (🎯) in sidebar
3. Verify form loads with all fields
4. Select an instance
5. Enter template symbol: `NIFTY_ATM_CE`
6. Verify index auto-detected to "NIFTY"
7. Enter target quantity: `50`
8. Click "Place Order"
9. Verify:
   - Loading state shown
   - Order result displayed
   - Resolved symbol shown (e.g., NIFTY24NOV24400CE)
   - Delta shown (e.g., BUY 50 lots)
   - Intent ID displayed
10. Scroll to "Recent Trade Intents"
11. Verify intent appears in table
12. Check status badge color

**✅ Pass Criteria**:
- Form validation works
- Template symbols resolve correctly
- Order placement succeeds
- Results display correctly
- Recent intents update

### Test 5.2: Risk Exits Dashboard

**Manual Test Steps**:

1. Navigate to "Risk Exits" (🛡️)
2. Verify statistics cards load:
   - Total Exits
   - TP/SL/TSL counts
   - Total & Avg P&L
3. Verify table loads with data
4. Test filters:
   - Change status to "Completed"
   - Change instance filter
   - Change limit to 25
   - Click "Apply Filters"
5. Verify table updates
6. Check auto-refresh:
   - Checkbox should be checked
   - Table should refresh every 5 seconds
7. Uncheck auto-refresh
   - Updates should stop
8. Verify color coding:
   - TP exits: Green
   - SL exits: Red
   - TSL exits: Yellow
   - Positive P&L: Green
   - Negative P&L: Red

**✅ Pass Criteria**:
- All statistics display correctly
- Filters work as expected
- Auto-refresh toggles correctly
- Colors match P&L/trigger type
- No JavaScript errors in console

### Test 5.3: Navigation and Cleanup

**Manual Test Steps**:

1. Navigate to "Risk Exits"
2. Wait for auto-refresh to start
3. Navigate to "Dashboard"
4. Open browser console
5. Verify no ongoing polling for risk exits
6. Navigate back to "Risk Exits"
7. Verify auto-refresh resumes

**✅ Pass Criteria**:
- Auto-refresh stops when leaving view
- No memory leaks from polling intervals
- Cleanup functions execute properly

---

## 🔗 End-to-End Integration Testing

### E2E Test 1: Complete Trading Cycle with TP

**Scenario**: Place order, monitor position, automatic TP exit

**Steps**:

1. **Setup**:
```sql
-- Set global TP
UPDATE global_defaults
SET tp_per_unit = 10;
```

2. **Place Order via UI**:
   - Enhanced Order → NIFTY_ATM_CE → Target: 50
   - Wait for order execution
   - Verify position appears in leg_state

3. **Monitor Risk Engine**:
```sql
SELECT * FROM leg_state WHERE is_active = 1;
-- Should show risk_enabled = 1, tp_price set
```

4. **Simulate TP Trigger**:
```sql
-- Set current price above TP
UPDATE leg_state
SET current_ltp = weighted_avg_entry + 11
WHERE id = (SELECT id FROM leg_state WHERE is_active = 1 LIMIT 1);
```

5. **Watch Risk Exits Dashboard**:
   - Should show new TP exit within 5 seconds
   - Status: pending → executing → completed
   - P&L positive

6. **Verify Position Closed**:
```sql
SELECT net_qty FROM leg_state WHERE id = 1;
-- Should be 0 after exit executes
```

**✅ Pass Criteria**:
- Order placed successfully
- Risk enabled automatically
- TP detected by risk engine
- Exit executor places order
- Position closed
- P&L tracked correctly

### E2E Test 2: TSL with Breakeven Lock

**Scenario**: Position moves into profit, TSL arms, trails, locks at breakeven, then exits

**Steps**:

1. **Setup**:
```sql
UPDATE global_defaults
SET tsl_enabled = 1,
    tsl_arm_after = 5,
    tsl_trail_by = 3,
    tsl_breakeven_after = 10;
```

2. **Place Order**: NIFTY_ATM_CE, 50 lots

3. **Move Price to Arm** (profit = 5):
```sql
UPDATE leg_state
SET current_ltp = weighted_avg_entry + 5
WHERE is_active = 1;
```

4. **Verify TSL Armed**:
```sql
SELECT tsl_armed, tsl_current_stop FROM leg_state WHERE is_active = 1;
```

5. **Move Price Higher** (profit = 12):
```sql
UPDATE leg_state
SET current_ltp = weighted_avg_entry + 12,
    best_favorable_price = weighted_avg_entry + 12
WHERE is_active = 1;
```

6. **Verify Stop at Breakeven**:
```sql
SELECT tsl_current_stop, weighted_avg_entry FROM leg_state WHERE is_active = 1;
-- Stop should be at or above entry (breakeven locked)
```

7. **Trigger Exit**:
```sql
UPDATE leg_state
SET current_ltp = weighted_avg_entry - 1
WHERE is_active = 1;
```

8. **Monitor Risk Exits Dashboard**:
   - Should show TSL_HIT exit
   - P&L should be near breakeven

**✅ Pass Criteria**:
- TSL arms correctly
- Trailing works
- Breakeven lock activates
- Exit triggered
- P&L protected by breakeven

### E2E Test 3: Scope-Based Exit (TYPE)

**Scenario**: Multiple CE positions, TP on one triggers exit for all CEs

**Steps**:

1. **Setup**:
```sql
UPDATE global_defaults
SET tp_per_unit = 10,
    exit_scope = 'TYPE';
```

2. **Place Multiple Orders**:
   - NIFTY24NOV24400CE → 50 lots
   - NIFTY24NOV24450CE → 50 lots
   - NIFTY24NOV24400PE → 50 lots

3. **Verify All Positions**:
```sql
SELECT symbol, net_qty, option_type FROM leg_state WHERE is_active = 1;
-- Should show 3 positions
```

4. **Trigger TP on First CE**:
```sql
UPDATE leg_state
SET current_ltp = weighted_avg_entry + 11
WHERE symbol LIKE '%24400CE';
```

5. **Monitor Risk Exits**:
   - Should create exit for both CEs
   - PE should remain untouched

6. **Verify Results**:
```sql
SELECT symbol, net_qty FROM leg_state WHERE is_active = 1;
-- Both CEs should be 0, PE still 50
```

**✅ Pass Criteria**:
- Scope correctly identifies TYPE (CE)
- All CE positions exit
- PE positions unaffected
- Exit orders placed for all in scope

---

## ⚡ Performance Testing

### Test P.1: Database Load

```bash
# Monitor database writes
watch -n 1 "lsof database/simplifyed.db | wc -l"

# Check database size
ls -lh database/simplifyed.db

# Monitor query performance
sqlite3 database/simplifyed.db '.timer on' 'SELECT * FROM leg_state WHERE risk_enabled = 1;'
```

**Benchmarks**:
- Queries should complete < 50ms
- Database file should remain < 100MB (with reasonable data)
- Write load should be sustainable

### Test P.2: Memory Usage

```bash
# Monitor Node.js memory
while true; do
  ps aux | grep node | grep -v grep | awk '{print $6/1024 " MB"}'
  sleep 5
done
```

**Benchmarks**:
- Memory should stabilize < 500MB
- No memory leaks over 30 minutes

### Test P.3: API Response Times

```bash
# Test enhanced order endpoint
time curl -X POST http://localhost:3000/api/v1/orders/enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": 1,
    "symbol": "NIFTY_ATM_CE",
    "exchange": "NFO",
    "targetQty": 0
  }'

# Test risk exits endpoint
time curl http://localhost:3000/api/v1/risk-exits?limit=100
```

**Benchmarks**:
- Enhanced order (no OpenAlgo call): < 500ms
- Risk exits query: < 200ms

---

## 🐛 Edge Case Testing

### Edge 1: Network Failure During Order Placement

**Test**: Disconnect network during order placement

**Expected**:
- Timeout after 15 seconds
- Intent marked as 'failed'
- Error message shown to user
- Can retry via intent ID

### Edge 2: Duplicate Fill Events

**Test**: Manually insert duplicate fill in tradebook simulation

**Expected**:
- Fill aggregator handles duplicates
- net_qty calculated correctly
- No double-counting

### Edge 3: Price Gaps (TSL)

**Test**: Price jumps past TSL stop

```sql
-- Set TSL stop at 155
UPDATE leg_state SET tsl_current_stop = 155 WHERE id = 1;

-- Jump price to 150 (gap through stop)
UPDATE leg_state SET current_ltp = 150 WHERE id = 1;
```

**Expected**:
- Risk engine still triggers exit
- P&L calculated at actual price (150), not stop (155)

### Edge 4: Concurrent Order Placement

**Test**: Place two orders with same intent_id simultaneously

**Expected**:
- First request processes
- Second request returns existing intent
- Only one order placed

### Edge 5: Kill Switch Activation

**Test**:
```bash
# Set kill switch
echo "KILL_RISK_EXITS=true" >> backend/.env

# Restart server
# Trigger risk condition
```

**Expected**:
- Risk exits detected but not executed
- Log message: "Risk exit blocked by kill switch"
- Positions remain open

---

## ✅ Production Readiness Checklist

### Security

- [ ] SESSION_SECRET changed from default
- [ ] Google OAuth configured (production)
- [ ] Database file permissions restricted
- [ ] API rate limiting considered
- [ ] CORS origins restricted
- [ ] Helmet security headers enabled
- [ ] Input validation on all endpoints
- [ ] SQL injection prevention verified
- [ ] No secrets in logs

### Configuration

- [ ] Environment variables documented
- [ ] Default feature flags set correctly
- [ ] Kill switches tested and working
- [ ] Logging level appropriate (info/warn in prod)
- [ ] Database backup strategy in place
- [ ] Migration rollback tested
- [ ] Polling intervals tuned for production

### Monitoring

- [ ] Winston logs configured
- [ ] Log rotation enabled
- [ ] Error tracking setup (Sentry, etc.)
- [ ] Performance monitoring (APM)
- [ ] Database monitoring
- [ ] Alert thresholds defined
- [ ] Health check endpoint verified
- [ ] Ready check endpoint verified

### Testing

- [ ] All Phase 1-5 tests passed
- [ ] End-to-end scenarios validated
- [ ] Edge cases tested
- [ ] Performance benchmarks met
- [ ] Load testing completed
- [ ] Paper trading validation (1 week minimum)
- [ ] Rollback procedure tested

### Documentation

- [ ] API documentation complete
- [ ] User guide created
- [ ] Admin guide created
- [ ] Troubleshooting guide created
- [ ] Architecture diagrams updated
- [ ] Database schema documented
- [ ] Deployment guide created
- [ ] Disaster recovery plan documented

### Deployment

- [ ] Production database initialized
- [ ] Migrations tested on production
- [ ] Backup before deployment
- [ ] Rollback plan ready
- [ ] Monitoring active
- [ ] Team trained
- [ ] Support process defined
- [ ] Incident response plan ready

---

## 📋 Test Execution Checklist

### Day 1: Database & Settings

- [ ] Phase 1 tests (Database Schema)
- [ ] Phase 2 tests (Settings Service)
- [ ] Database performance tests

### Day 2: Risk Engine

- [ ] Phase 3 tests (Fill Aggregator)
- [ ] Phase 3 tests (Quote Router)
- [ ] Phase 3 tests (Risk Engine TP/SL)
- [ ] Phase 3 tests (TSL)
- [ ] Phase 3 tests (Risk Exit Executor)

### Day 3: Enhanced Orders

- [ ] Phase 4 tests (Symbol Resolution)
- [ ] Phase 4 tests (Delta Calculation)
- [ ] Phase 4 tests (Pyramiding)
- [ ] Phase 4 tests (Trade Intents)

### Day 4: Frontend

- [ ] Phase 5 tests (Enhanced Order UI)
- [ ] Phase 5 tests (Risk Exits Dashboard)
- [ ] Phase 5 tests (Navigation & Cleanup)

### Day 5: Integration

- [ ] E2E Test 1 (TP Cycle)
- [ ] E2E Test 2 (TSL with Breakeven)
- [ ] E2E Test 3 (Scope-Based Exit)

### Day 6: Edge Cases & Performance

- [ ] All edge case tests
- [ ] All performance tests
- [ ] Load testing

### Day 7: Paper Trading

- [ ] Deploy to paper trading environment
- [ ] Run real scenarios with live data
- [ ] Monitor for 24 hours
- [ ] Validate all automations

### Day 8: Production Prep

- [ ] Complete production readiness checklist
- [ ] Review all test results
- [ ] Document any issues
- [ ] Prepare deployment plan
- [ ] Final review meeting

---

## 🎯 Success Criteria

**All tests must pass**:
- ✅ Database schema correct
- ✅ Settings hierarchy working
- ✅ Risk engine detecting conditions
- ✅ Risk exits executing automatically
- ✅ Enhanced orders placing correctly
- ✅ Frontend UI functional
- ✅ End-to-end flows complete
- ✅ Edge cases handled
- ✅ Performance acceptable
- ✅ Production checklist complete

**Paper Trading Validation** (1 week minimum):
- ✅ At least 20 automated trades executed
- ✅ At least 10 risk exits triggered
- ✅ No critical bugs
- ✅ Performance stable
- ✅ No data corruption

---

## 🐛 Known Issues & Limitations

Document any issues found during testing:

1. **Issue**: Description
   - **Severity**: Critical/High/Medium/Low
   - **Impact**: Who/what is affected
   - **Workaround**: Temporary solution
   - **Status**: Open/In Progress/Fixed

2. **Limitation**: Description
   - **Reason**: Why this limitation exists
   - **Impact**: What it affects
   - **Future**: Plan to address

---

## 📞 Support & Escalation

**Testing Issues**:
- Check logs: `tail -f backend/logs/app.log`
- Check database: `sqlite3 database/simplifyed.db`
- Restart services: `npm run dev`

**Bug Reporting**:
- Create issue at: https://github.com/jabez4jc/Simplifyed/issues
- Include: logs, steps to reproduce, expected vs actual
- Tag: `bug`, `testing`, `phase-6`

---

## ✅ Sign-Off

**Tested By**: _________________
**Date**: _________________
**Result**: Pass / Fail / Conditional Pass
**Notes**: _________________

---

**Phase 6 Complete**: Ready for production deployment upon successful test completion and sign-off.
