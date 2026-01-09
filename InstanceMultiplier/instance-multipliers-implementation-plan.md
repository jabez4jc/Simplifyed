# Instance Multipliers Implementation Plan

## Executive Summary

This document outlines the comprehensive implementation plan for adding instance multipliers to the trading system. The feature allows each trading instance to apply a multiplier (1x, 2x, 3x, etc.) to order quantities across all trade modes (EQUITY, FUTURES, OPTIONS) and signal sources (Frontend buttons, API calls, TradingView alerts).

## Current System Analysis

### Architecture Overview
- **Database**: SQLite with instances table managing all broker connections
- **Order Flow**: QuickOrderService → OpenAlgo Client → Broker APIs
- **Broadcast System**: TradingView webhooks → Multiple instances (parallelized)
- **Current Quantity Calculation**: `tradeQuantity = quantity * lotSize` (line 757 in quick-order.service.js)

### Key Files Identified
1. `/backend/src/services/instance.service.js` - CRUD operations for instances
2. `/backend/src/services/quick-order.service.js` - Order quantity calculation (lines 740-766)
3. `/backend/src/services/tradingview-broadcast.service.js` - Multi-instance broadcasting
4. `/backend/src/routes/v1/instances.js` - API endpoints for instance management
5. `/backend/migrations/` - Database schema migrations

## Requirements

### Functional Requirements
- Apply to ALL trade modes: EQUITY, FUTURES, OPTIONS
- Integer multipliers only: 1x, 2x, 3x, etc. (minimum: 1)
- Database field: UI configurable multiplier per instance
- Apply to ALL signal sources:
  - Frontend quick-order buttons
  - API direct calls
  - TradingView webhook alerts
- Backwards compatible: default multiplier = 1 (no change to existing behavior)

### Non-Functional Requirements
- Minimal code changes
- Clear separation of concerns
- Performance: maintain parallel multi-instance broadcasting
- Edge cases handled:
  - Position-aware trading
  - Options with multiple strikes
  - Lot size variations

## Implementation Strategy

### Phase 1: Database Schema Changes
**File**: New migration (e.g., `043_add_instance_multiplier.js`)

**Changes**:
- Add `multiplier INTEGER DEFAULT 1` column to instances table
- Default value of 1 ensures backwards compatibility
- Integer type to enforce whole number multipliers only

**Migration Code**:
```javascript
export async function up(db) {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN multiplier INTEGER DEFAULT 1
  `);
}
```

### Phase 2: Backend Service Layer Updates

#### 2.1 Instance Service (`/backend/src/services/instance.service.js`)

**Changes Required**:
1. Add multiplier to `_normalizeInstanceData()` method (around line 1073)
   - Validate multiplier is an integer ≥ 1
   - Sanitize and normalize input

2. Add multiplier to `createInstance()` method (around line 137)
   - Include multiplier in INSERT columns and values
   - Default to 1 if not provided

3. Add multiplier to `updateInstance()` method (around line 226)
   - Include multiplier in UPDATE queries
   - Validate multiplier is integer ≥ 1

**Key Code Locations**:
- Line 1073-1185: `_normalizeInstanceData()` - Add multiplier validation
- Line 168-189: `createInstance()` - Add multiplier to INSERT
- Line 262-282: `updateInstance()` - Add multiplier to UPDATE

**Implementation Details**:
```javascript
// In _normalizeInstanceData()
if (data.multiplier !== undefined) {
  const multiplier = parseInt(data.multiplier, 10);
  if (!Number.isInteger(multiplier) || multiplier < 1) {
    errors.push({ field: 'multiplier', message: 'Multiplier must be an integer ≥ 1' });
  } else {
    normalized.multiplier = multiplier;
  }
}

// In createInstance()
columns.push('multiplier');
values.push(normalized.multiplier || 1);

// In updateInstance()
if (normalized.multiplier !== undefined) {
  fields.push('multiplier = ?');
  values.push(normalized.multiplier);
}
```

#### 2.2 QuickOrder Service (`/backend/src/services/quick-order.service.js`)

**Changes Required**:
1. Modify quantity calculation at line 757
   - Current: `const tradeQuantity = quantity * lotSize;`
   - New: `const tradeQuantity = quantity * lotSize * instance.multiplier;`

2. Update logging to include multiplier
   - Add `instanceMultiplier` to log context

**Critical Code Change** (Line 757):
```javascript
// BEFORE
const tradeQuantity = quantity * lotSize;

// AFTER
const instanceMultiplier = instance.multiplier || 1;
const tradeQuantity = quantity * lotSize * instanceMultiplier;
```

**Additional Logging Update** (Lines 761-773):
```javascript
log.info('Calculated trade quantity', {
  // ... existing fields ...
  instanceMultiplier,
  finalTradeQuantity: tradeQuantity,
  // ...
});
```

#### 2.3 TradingView Broadcast Service (`/backend/src/services/tradingview-broadcast.service.js`)

**Changes Required**:
1. Modify `_dispatchToTarget()` method (around line 406)
   - Fetch instance data to get multiplier
   - Apply multiplier to quantity before dispatching
   - Include multiplier in log context

2. No changes needed to `_resolveTargets()` or `broadcast()` methods
   - Multiplier applied per-instance in dispatch phase

**Implementation Approach**:
The multiplier needs to be applied when resolving which instances to target. Since the broadcast service works with targets (configured URLs), we need to:

1. Fetch instance data when broadcasting
2. Apply multiplier to quantity for each target
3. Log the multiplier being used

**Key Changes**:
```javascript
// In broadcast() method - need to resolve instances with multipliers
const { targets, watchlist } = await this._resolveTargets({ watchlistId, watchlistSlug });

// Fetch instance data for each target to get multiplier
// This requires modifying how targets are resolved or adding instance lookup

// In _dispatchToTarget() - apply multiplier
const instance = await instanceService.getInstanceById(target.instanceId);
const instanceMultiplier = instance.multiplier || 1;
const finalQuantity = payload.quantity * instanceMultiplier;

const body = JSON.stringify({
  ...payload,
  quantity: finalQuantity,  // Override quantity with multiplier-applied value
  apikey: target.apikey,
});
```

**Note**: This approach requires modifying how targets are resolved to include instance IDs and multipliers. The `_resolveTargets()` method needs enhancement to fetch instance data.

### Phase 3: API Layer Updates

#### 3.1 Instance Routes (`/backend/src/routes/v1/instances.js`)

**Changes Required**:
- GET `/api/v1/instances` - Response already includes all instance fields, multiplier will be included automatically
- POST `/api/v1/instances` - Accept multiplier in request body
- PUT `/api/v1/instances/:id` - Accept multiplier in request body
- Bulk operations - Multiplier will be included if provided

**Validation to Add** (around line 152 in create route):
```javascript
// Validate multiplier
if (req.body.multiplier !== undefined) {
  const multiplier = parseInt(req.body.multiplier, 10);
  if (!Number.isInteger(multiplier) || multiplier < 1) {
    throw new ValidationError('Multiplier must be an integer ≥ 1');
  }
}
```

### Phase 4: Frontend UI Updates

#### 4.1 Instance Management UI

**Changes Required**:
1. Add multiplier input field to instance creation form
2. Add multiplier input field to instance editing form
3. Display multiplier in instance list/table
4. Validation: Integer ≥ 1

**File Location**: `/backend/public/js/quick-order.js` or similar frontend component

**UI Requirements**:
- Input type: number
- Min value: 1
- Step: 1
- Default value: 1
- Label: "Multiplier"
- Help text: "Multiply all order quantities for this instance (1x, 2x, 3x, etc.)"

**Implementation Example**:
```html
<div class="form-group">
  <label for="multiplier">Multiplier</label>
  <input type="number" id="multiplier" name="multiplier" min="1" step="1" value="1" />
  <small class="form-text text-muted">Multiply all order quantities (1x, 2x, 3x, etc.)</small>
</div>
```

### Phase 5: Testing & Validation

#### 5.1 Test Scenarios

**Unit Tests**:
1. Instance CRUD operations with multiplier
2. Quantity calculation with various multipliers
3. Multiplier validation (≥ 1, integer only)

**Integration Tests**:
1. Quick order flow with multiplier
2. TradingView webhook broadcast with multipliers
3. Multi-instance broadcast with different multipliers
4. Position-aware trading with multipliers

**Edge Cases**:
1. Options with different lot sizes per strike
2. Futures with varying multipliers
3. Switching multipliers mid-session
4. Broadcasting to instances with different multipliers

#### 5.2 Test Cases

**Test Case 1: Basic Multiplier**
- Instance multiplier: 2x
- Order quantity: 10
- Expected: 20 (10 × 2)

**Test Case 2: Position-Aware Trading**
- Instance multiplier: 3x
- Current position: -5 lots
- Order quantity: 10
- Expected: 30 lots (10 × 3)

**Test Case 3: Options Trading**
- Instance multiplier: 2x
- Option strike A: 5 lots
- Option strike B: 7 lots
- Expected: A: 10, B: 14

**Test Case 4: Multi-Instance Broadcast**
- Instance 1: multiplier 1x
- Instance 2: multiplier 2x
- Instance 3: multiplier 3x
- Order quantity: 10
- Expected: Instance 1: 10, Instance 2: 20, Instance 3: 30

### Phase 6: Documentation Updates

**Files to Update**:
1. API documentation for instance endpoints
2. User guide for multiplier configuration
3. README updates for new feature
4. Migration guide for database changes

**Key Documentation Points**:
- Default multiplier value (1)
- Supported multiplier range (1 to maximum integer)
- Impact on existing orders
- Best practices for multiplier usage

## Implementation Timeline

### Week 1: Database & Backend Services
- Day 1-2: Create and apply database migration
- Day 3-4: Update Instance service with multiplier support
- Day 5: Update QuickOrder service quantity calculation

### Week 2: Broadcast System & API
- Day 1-2: Update TradingView broadcast service
- Day 3: Update API routes and validation
- Day 4: API testing

### Week 3: Frontend & Integration
- Day 1-2: Frontend UI for multiplier configuration
- Day 3-4: Integration testing
- Day 5: End-to-end testing

### Week 4: Documentation & Deployment
- Day 1-2: Update documentation
- Day 3-4: Performance testing
- Day 5: Production deployment

## Risk Assessment

### Low Risk
- Database migration (non-destructive, default value provided)
- Instance service updates (isolated to CRUD operations)
- API validation (defensive programming)

### Medium Risk
- QuickOrder service modification (critical path, affects all orders)
  - **Mitigation**: Thorough testing, include in log output
- TradingView broadcast updates (affects webhook signals)
  - **Mitigation**: Test with staging webhooks

### High Risk
- None identified

## Performance Considerations

### Current Performance
- Multi-instance broadcasting: Parallel via Promise.allSettled
- QuickOrder processing: Synchronous per order
- Database queries: Efficient with proper indexing

### Performance Impact
- **Minimal**: Multiplier is a single integer field fetch
- **No Impact**: Quantity calculation is O(1) operation
- **Parallelism Maintained**: Broadcasting remains parallel

### Optimization Opportunities
1. Cache multiplier values in memory (like other instance metadata)
2. Batch fetch multipliers for multi-instance operations
3. Lazy loading for instances not currently trading

## Backwards Compatibility

### Default Behavior
- **Multiplier default**: 1 (no change to existing orders)
- **Migration**: Non-destructive, existing instances get multiplier = 1
- **API**: Optional parameter, defaults to 1
- **UI**: Hidden by default, shows when instance has multiplier > 1

### Migration Path
1. Apply database migration (adds multiplier column with default 1)
2. Deploy backend (handles new column gracefully)
3. Deploy frontend (shows multiplier UI)
4. Users can optionally configure multipliers
5. No action required for existing setups

## Success Criteria

### Functional Criteria
- [ ] Instances can be created with multiplier 1-999
- [ ] Quick orders multiply quantity by instance multiplier
- [ ] TradingView webhooks multiply quantity by instance multiplier
- [ ] Position-aware trading respects multipliers
- [ ] Options trading with multiple strikes respects multipliers

### Technical Criteria
- [ ] Database migration completes without errors
- [ ] All existing tests pass
- [ ] New unit tests for multiplier validation
- [ ] Integration tests for all signal sources
- [ ] Performance impact < 5ms per order

### Business Criteria
- [ ] Feature documented in user guide
- [ ] Support documentation updated
- [ ] No breaking changes to existing users
- [ ] Clear UI for multiplier configuration

## Conclusion

The instance multipliers feature can be implemented with minimal disruption to the existing codebase. The phased approach ensures:
1. Database stability through non-destructive migration
2. Backwards compatibility through default values
3. Clear separation of concerns across service layers
4. Comprehensive testing before production deployment

The feature enhances the system's flexibility while maintaining its reliability and performance characteristics.
