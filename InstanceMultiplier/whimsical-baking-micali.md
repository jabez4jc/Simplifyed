# Instance Multiplier Implementation Plan

**Date**: 2025-01-09
**Project**: Instance Multiplier Feature
**Status**: Planning Phase - Awaiting Approval

---

## Executive Summary

Implement instance-specific multipliers for trade signals, allowing different trading instances to execute orders with quantities scaled by their configured multiplier (1x, 2x, 3x, etc.).

**Example**:
- Signal: BUY 2 lots of BANKNIFTY
- Instance A (1x): 2 lots executed
- Instance B (2x): 4 lots executed
- Instance C (3x): 6 lots executed

---

## Requirements ✅

| Requirement | Status | Implementation |
|------------|--------|----------------|
| Apply to ALL trade modes (EQUITY, FUTURES, OPTIONS) | ✅ Confirmed | Single implementation point at quantity calculation |
| Integer multipliers only (1x, 2x, 3x, etc.) | ✅ Confirmed | INTEGER field with validation (1-999) |
| Database field (UI configurable) | ✅ Confirmed | New `multiplier` column in instances table |
| Apply to ALL signal sources | ✅ Confirmed | Frontend, API, and TradingView all use same calculation point |

---

## Architecture Overview

### Core Concept
Apply multiplier at the **quantity calculation layer** in `quick-order.service.js` line 757, ensuring all signal sources (frontend buttons, API calls, TradingView webhooks) are affected uniformly.

### Data Flow
```
Trade Signal (e.g., BUY 2 lots)
    ↓
Instance Resolution (A=1x, B=2x, C=3x)
    ↓
QuickOrderService.quantityCalculation()
    ↓
Base: 2 lots × lot_size (25) = 50 contracts
    ↓
Instance A: 50 × 1 = 50 contracts
Instance B: 50 × 2 = 100 contracts
Instance C: 50 × 3 = 150 contracts
    ↓
Parallel execution to all instances
```

### Key Design Decisions
1. **Single Implementation Point**: Modify line 757 in `quick-order.service.js`
2. **Default to 1**: Use `instance.multiplier || 1` for backwards compatibility
3. **No API Changes**: Existing OpenAlgo integration unchanged
4. **Preserve Parallelism**: Multi-instance broadcasting remains parallel

---

## Implementation Plan

### Phase 1: Database Schema (30 minutes)

**File**: `/backend/migrations/043_add_instance_multiplier.js`

```javascript
export async function up(db) {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN multiplier INTEGER DEFAULT 1
  `);

  // Add constraint for valid range
  await db.run(`
    CREATE TABLE instances_multiplier_temp AS
    SELECT id, name, multiplier FROM instances
  `);

  await db.run(`
    UPDATE instances_multiplier_temp
    SET multiplier = 1
    WHERE multiplier IS NULL OR multiplier < 1 OR multiplier > 999
  `);

  await db.run(`DROP TABLE instances`);
  await db.run(`
    CREATE TABLE instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host_url TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL,
      strategy_tag TEXT,
      is_primary_admin BOOLEAN DEFAULT 0,
      is_secondary_admin BOOLEAN DEFAULT 0,
      order_placement_enabled BOOLEAN DEFAULT 1,
      target_profit REAL DEFAULT 5000,
      target_loss REAL DEFAULT 2000,
      current_balance REAL DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      multiplier INTEGER DEFAULT 1,
      is_active BOOLEAN DEFAULT 1,
      is_analyzer_mode BOOLEAN DEFAULT 0,
      health_status TEXT DEFAULT 'unknown',
      last_health_check DATETIME,
      last_ping_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    INSERT INTO instances (
      id, name, host_url, api_key, strategy_tag,
      is_primary_admin, is_secondary_admin, order_placement_enabled,
      target_profit, target_loss,
      current_balance, realized_pnl, unrealized_pnl, total_pnl,
      multiplier, is_active, is_analyzer_mode,
      health_status, last_health_check, last_ping_at,
      created_at, last_updated
    )
    SELECT
      id, name, host_url, api_key, strategy_tag,
      is_primary_admin, is_secondary_admin, order_placement_enabled,
      target_profit, target_loss,
      current_balance, realized_pnl, unrealized_pnl, total_pnl,
      COALESCE(multiplier, 1),
      is_active, is_analyzer_mode,
      health_status, last_health_check, last_ping_at,
      created_at, last_updated
    FROM instances_multiplier_temp
  `);

  await db.run(`DROP TABLE instances_multiplier_temp`);
}

export async function down(db) {
  await db.run(`
    ALTER TABLE instances
    DROP COLUMN multiplier
  `);
}
```

**Rollback Strategy**: Migration includes `down()` function to remove column if needed.

---

### Phase 2: Core Quantity Calculation (15 minutes) 🔴 CRITICAL

**File**: `/backend/src/services/quick-order.service.js`

**Current Code** (Line 757):
```javascript
const tradeQuantity = quantity * lotSize;
```

**New Code** (Line 757):
```javascript
const instanceMultiplier = instance.multiplier || 1;
const tradeQuantity = quantity * lotSize * instanceMultiplier;
```

**Updated Logging** (Lines 761-773):
```javascript
log.info('Calculated trade quantity', {
  symbolType: symbol.symbol_type,
  tradeMode,
  inputQuantity: quantity,
  lotSize,
  baseQuantity: quantity * lotSize,
  instanceMultiplier,
  finalQuantity: tradeQuantity,
  rawPosition,
  normalizedPosition: currentPosition,
  instance_id: instance.id,
  instance_name: instance.name,
  instance_multiplier: instanceMultiplier,
  exchange: finalExchange,
  symbol: finalSymbol,
});
```

**Verification**: This is the ONLY location where quantity is calculated for all trade modes. Any order (EQUITY, FUTURES, OPTIONS) will use this calculation.

---

### Phase 3: Instance Service Updates (2 hours)

**File**: `/backend/src/services/instance.service.js`

#### Add Multiplier to Instance Data Structure

**Find method**: `async createInstance(data)` (around line 100-200)

**Add validation**:
```javascript
// Validate multiplier
if (data.multiplier !== undefined) {
  const multiplier = parseIntSafe(data.multiplier, 'multiplier');
  if (isNaN(multiplier) || multiplier < 1 || multiplier > 999) {
    throw new ValidationError('multiplier must be an integer between 1 and 999');
  }
  data.multiplier = multiplier;
} else {
  data.multiplier = 1; // Default
}
```

#### Update CRUD Operations

1. **`getInstanceById()`**: Include multiplier in SELECT queries
2. **`getInstances()`**: Include multiplier in SELECT queries
3. **`updateInstance()`**: Add multiplier to updateable fields
4. **`createInstance()`**: Add multiplier to INSERT fields

**Example query updates** (replace all SELECT * with explicit fields):
```javascript
// BEFORE:
SELECT * FROM instances WHERE ...

// AFTER:
SELECT id, name, host_url, api_key, strategy_tag,
       is_primary_admin, is_secondary_admin, order_placement_enabled,
       target_profit, target_loss,
       current_balance, realized_pnl, unrealized_pnl, total_pnl,
       multiplier,  // ADD THIS
       is_active, is_analyzer_mode,
       health_status, last_health_check, last_ping_at,
       created_at, last_updated
FROM instances WHERE ...
```

---

### Phase 4: API Routes Updates (1 hour)

**File**: `/backend/src/routes/v1/instances.js`

#### Add Multiplier Validation (POST /instances)

**Find section**: Validation of instance data (around line 100-200)

**Add after other validations**:
```javascript
// Validate multiplier
if (body.multiplier !== undefined) {
  const multiplier = parseIntSafe(body.multiplier, 'multiplier');
  if (isNaN(multiplier) || multiplier < 1 || multiplier > 999) {
    return res.status(400).json({
      error: 'Invalid multiplier',
      details: 'multiplier must be an integer between 1 and 999'
    });
  }
}
```

#### Add Multiplier to Bulk Update

**Find route**: `PATCH /instances/bulk` (around line 400-500)

**Add validation**:
```javascript
if (updates.multiplier !== undefined) {
  const multiplier = parseIntSafe(updates.multiplier, 'multiplier');
  if (isNaN(multiplier) || multiplier < 1 || multiplier > 999) {
    return res.status(400).json({
      error: 'Invalid multiplier',
      details: 'multiplier must be an integer between 1 and 999'
    });
  }
}
```

#### Add Multiplier to Instance Response

**Find function**: Format instance response (around line 300)

**Add multiplier to response**:
```javascript
const formattedInstance = {
  id: instance.id,
  name: instance.name,
  host_url: instance.host_url,
  api_key: instance.api_key,
  strategy_tag: instance.strategy_tag,
  is_primary_admin: instance.is_primary_admin,
  is_secondary_admin: instance.is_secondary_admin,
  order_placement_enabled: instance.order_placement_enabled,
  target_profit: instance.target_profit,
  target_loss: instance.target_loss,
  current_balance: instance.current_balance,
  realized_pnl: instance.realized_pnl,
  unrealized_pnl: instance.unrealized_pnl,
  total_pnl: instance.total_pnl,
  multiplier: instance.multiplier,  // ADD THIS
  is_active: instance.is_active,
  is_analyzer_mode: instance.is_analyzer_mode,
  health_status: instance.health_status,
  last_health_check: instance.last_health_check,
  last_ping_at: instance.last_ping_at,
  created_at: instance.created_at,
  last_updated: instance.last_updated,
};
```

---

### Phase 5: TradingView Broadcast Integration (2 hours)

**File**: `/backend/src/services/tradingview-broadcast.service.js`

#### Update Target Resolution

**Find method**: `_resolveTargets()` (lines 122-133)

**No changes needed** - targets are already resolved per instance.

#### Update Broadcast Logging

**Find section**: Broadcast results logging (lines 287-296)

**Update to include multiplier**:
```javascript
// Record counters for broadcast watchlists
if (watchlist?.id) {
  try {
    await watchlistService.recordBroadcast(watchlist.id, {
      received: 1,
      success: okCount > 0 ? 1 : 0,
    });
  } catch (err) {
    log.warn('[TV Webhook] Failed to record broadcast counters', {
      error: err?.message,
      watchlistId: watchlist.id,
    });
  }
}

// Log per-instance multiplier info
log.info('[TV Webhook] Broadcast completed', {
  targetsCount: targets.length,
  successful: okCount,
  failed: failCount,
  perTarget: targets.map(t => ({
    name: t.name,
    multiplier: t.multiplier || 1,
    status: t.status,
  })),
});
```

**Note**: TradingView broadcast already sends the same payload to all instances. The multiplier will be applied at the instance level during order placement. No changes to broadcast payload are needed.

---

### Phase 6: Frontend UI Updates (2-4 hours)

#### Instance Management Page

**Location**: `/backend/public/instances.html`

**Add to instance form**:
```html
<div class="form-group">
  <label for="multiplier">Multiplier</label>
  <input
    type="number"
    id="multiplier"
    name="multiplier"
    min="1"
    max="999"
    value="1"
    required
  />
  <small class="form-text text-muted">
    Integer multiplier for trade quantities (1x, 2x, 3x, etc.)
  </small>
</div>
```

**Validation**: Same as backend (1-999, integer only)

#### Instance Display Table

**Add column**:
```html
<th>Multiplier</th>
<td>{{ instance.multiplier || 1 }}x</td>
```

#### Bulk Edit Modal

**Add multiplier field to bulk edit form**:
```html
<div class="form-group">
  <label>
    <input type="checkbox" id="updateMultiplier" />
    Update Multiplier
  </label>
  <input
    type="number"
    id="bulkMultiplier"
    min="1"
    max="999"
    disabled
  />
</div>
```

#### JavaScript Updates

**File**: `/backend/public/js/instances.js`

**Add to create/update functions**:
```javascript
// When creating/updating instance
const instanceData = {
  // ... other fields
  multiplier: $('#multiplier').val() || 1,
};

// Validate before sending
if (instanceData.multiplier < 1 || instanceData.multiplier > 999) {
  alert('Multiplier must be between 1 and 999');
  return;
}
```

---

## Testing Strategy

### Unit Tests

1. **Quantity Calculation Test**
   - File: `/backend/test/multiplier-quantity.test.js`
   - Test: Verify multiplier applied correctly for all trade modes
   - Test: Default multiplier = 1 when not set
   - Test: Integer validation

2. **Instance Service Test**
   - File: `/backend/test/instance-multiplier.test.js`
   - Test: CRUD operations include multiplier
   - Test: Validation rules (1-999, integer only)
   - Test: Default value on create

3. **API Routes Test**
   - File: `/backend/test/instance-api-multiplier.test.js`
   - Test: POST /instances validates multiplier
   - Test: PATCH /instances/bulk validates multiplier
   - Test: GET /instances includes multiplier in response

### Integration Tests

4. **Multi-Instance Broadcast Test**
   - File: `/backend/test/multiplier-broadcast.test.js`
   - Test: TradingView webhook applies multiplier per instance
   - Test: Parallel execution with different multipliers
   - Test: Logging includes multiplier values

5. **Trade Mode Tests**
   - File: `/backend/test/multiplier-trade-modes.test.js`
   - Test: EQUITY mode with multiplier
   - Test: FUTURES mode with multiplier
   - Test: OPTIONS mode with multiplier
   - Test: All action types (BUY, SELL, SHORT, COVER, EXIT)

### End-to-End Tests

6. **Frontend to Backend Test**
   - Test: Create instance with multiplier via UI
   - Test: Update multiplier via UI
   - Test: Execute trade with multiplier
   - Test: Verify correct quantity at broker

### Manual Testing Scenarios

**Scenario 1**: Single Instance
```
Setup: Instance with 2x multiplier
Action: BUY 2 lots RELIANCE
Expected: 4 lots executed (2 × 2)
```

**Scenario 2**: Multiple Instances
```
Setup: Instance A (1x), Instance B (2x), Instance C (3x)
Action: BUY 1 lot NIFTY
Expected:
  - Instance A: 1 lot executed
  - Instance B: 2 lots executed
  - Instance C: 3 lots executed
```

**Scenario 3**: Options Trading
```
Setup: Instance with 2x multiplier
Action: BUY_CE 2 lots BANKNIFTY ATM
Expected: 4 lots executed (2 × 2)
```

**Scenario 4**: Position-Aware Trading
```
Setup: Instance with 2x multiplier, currently long 2 lots
Action: BUY 2 lots
Expected: Target position = 4 lots (2 current + 2 new, all × 2 = 8 total)
```

---

## Rollout Plan

### Phase 1: Development (1-2 days)
- Implement all changes
- Run unit tests
- Run integration tests

### Phase 2: Staging (2-3 days)
- Deploy to staging environment
- Run E2E tests
- Test with real (paper trading) instances
- Performance testing

### Phase 3: Production (1 day)
- Deploy to production
- Monitor error rates
- Monitor multiplier application logs

### Rollback Plan

If issues arise:
1. **Option 1**: Disable multiplier by setting all instances to 1x
2. **Option 2**: Run migration `down()` to remove column
3. **Option 3**: Hotfix to remove multiplier application from code

---

## Performance Impact

### Latency
- **Additional calculation**: < 1ms per order
- **Database field lookup**: < 1ms (cached)
- **Total impact**: Negligible (< 2ms per order)

### Memory
- **Per instance**: +4 bytes (INTEGER field)
- **Total for 100 instances**: < 1KB

### Database
- **Migration time**: < 1 second (for typical database size)
- **Query performance**: No impact (SELECT includes one more field)

### Parallelism
- **Multi-instance broadcasting**: Unchanged (still parallel)
- **No serialization**: All instances execute simultaneously

---

## Risk Assessment

| Risk | Severity | Probability | Mitigation |
|------|----------|-------------|------------|
| Incorrect multiplier application | High | Low | Extensive testing, logging |
| Breaking existing functionality | High | Low | Backwards compatible (default = 1) |
| Performance degradation | Low | Very Low | Minimal calculation overhead |
| Database migration issues | Medium | Low | Test migration thoroughly, provide rollback |
| UI integration issues | Medium | Medium | Progressive enhancement (works without multiplier field) |
| Validation bypass | Low | Low | Server-side validation in multiple layers |

---

## Monitoring & Observability

### Logging

**Enhanced logging** in `quick-order.service.js`:
```javascript
log.info('Trade executed with multiplier', {
  instance_id: instance.id,
  instance_name: instance.name,
  instance_multiplier: instanceMultiplier,
  base_quantity: quantity * lotSize,
  final_quantity: tradeQuantity,
  symbol: finalSymbol,
  action: action,
  trade_mode: tradeMode,
});
```

### Metrics

**Track in monitoring dashboard**:
- Orders with multiplier ≠ 1 (percentage)
- Average multiplier value across instances
- Orders by multiplier value (1x, 2x, 3x, etc.)
- Error rate for multiplier validation

### Alerts

**Set up alerts for**:
- Invalid multiplier values detected
- Multiplier application failures
- Sudden change in multiplier distribution

---

## Compatibility

### Backwards Compatibility
- ✅ Default multiplier = 1 (existing behavior)
- ✅ No changes to API contracts
- ✅ No changes to OpenAlgo integration
- ✅ Existing instances work without modification

### Forwards Compatibility
- ✅ New field optional (defaults to 1)
- ✅ Existing code handles missing field gracefully
- ✅ Can be rolled out instance-by-instance

### API Compatibility
- ✅ All existing endpoints work unchanged
- ✅ New multiplier field optional in requests
- ✅ Multiplier included in GET responses

---

## Future Enhancements

### Potential Additions
1. **Per-Market Multipliers**: Different multipliers for EQUITY vs FUTURES vs OPTIONS
2. **Time-Based Multipliers**: Different multipliers based on time of day
3. **Risk-Based Multipliers**: Dynamic multipliers based on account balance
4. **Per-Symbol Multipliers**: Instance multiplier applies only to specific symbols
5. **Multiplier Strategies**: Predefined strategies (Conservative, Aggressive, etc.)

### Implementation Readiness
Current implementation provides the foundation for all future enhancements with minimal changes.

---

## Success Criteria

### Functional
- [ ] All trade modes apply multiplier correctly
- [ ] All signal sources (Frontend, API, TradingView) apply multiplier
- [ ] Default multiplier = 1 for backwards compatibility
- [ ] Validates multiplier range (1-999, integer)
- [ ] Multi-instance broadcasting works with different multipliers

### Performance
- [ ] < 5ms additional latency per order
- [ ] No degradation in parallel execution
- [ ] No increase in error rate

### Quality
- [ ] 100% test coverage for multiplier logic
- [ ] All existing tests pass
- [ ] E2E tests verify end-to-end functionality
- [ ] Logging provides clear visibility

### User Experience
- [ ] Intuitive UI for setting multipliers
- [ ] Clear validation messages
- [ ] Multiplier visible in instance list
- [ ] Bulk update functionality works

---

## Budget & Timeline

### Time Estimate
- **Database migration**: 30 minutes
- **Core calculation change**: 15 minutes
- **Instance service**: 2 hours
- **API routes**: 1 hour
- **TradingView integration**: 2 hours
- **Frontend UI**: 2-4 hours
- **Testing**: 1-2 days
- **Documentation**: 1 hour

**Total**: 1-2 days for experienced developer

### Cost
- **Development time**: 8-16 hours
- **Testing time**: 8-16 hours
- **Total**: 16-32 hours

---

## Approval Required

This plan requires approval before implementation. Key decisions needed:

1. ✅ **Multiplier range**: Confirmed (1-999, integer only)
2. ✅ **Database field**: Confirmed (INTEGER column with default = 1)
3. ✅ **All trade modes**: Confirmed (EQUITY, FUTURES, OPTIONS)
4. ✅ **All signal sources**: Confirmed (Frontend, API, TradingView)

**Ready for Implementation**: ✅ YES

---

## Appendix

### Critical Files Summary

| File | Purpose | Change Type | Priority |
|------|---------|-------------|----------|
| `/backend/migrations/043_add_instance_multiplier.js` | Database schema | New file | P0 |
| `/backend/src/services/quick-order.service.js` | Quantity calculation | Modify line 757 | P0 |
| `/backend/src/services/instance.service.js` | CRUD operations | Modify queries | P1 |
| `/backend/src/routes/v1/instances.js` | API validation | Add validation | P1 |
| `/backend/src/services/tradingview-broadcast.service.js` | Logging | Update logs | P2 |
| `/backend/public/instances.html` | UI form | Add field | P2 |
| `/backend/public/js/instances.js` | UI logic | Update handlers | P2 |

### Quick Reference Commands

**Run migration**:
```bash
cd /backend
npm run migrate
```

**Run tests**:
```bash
npm test -- --grep "multiplier"
```

**Check logs**:
```bash
tail -f logs/app.log | grep "multiplier"
```

**Verify database**:
```bash
sqlite3 data/app.db "SELECT id, name, multiplier FROM instances LIMIT 5;"
```

---

## Contact

**Technical Lead**: Claude Code
**Plan Version**: 1.0
**Last Updated**: 2025-01-09

---

**END OF PLAN**
