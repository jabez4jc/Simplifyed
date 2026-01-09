# Instance Multipliers - Technical Specification

## Overview
This document provides detailed, line-by-line code changes required to implement instance multipliers across the trading system.

## Critical Files for Implementation

### 1. Database Migration: Add Multiplier Column

**File**: `/backend/migrations/043_add_instance_multiplier.js`

```javascript
/**
 * Migration 043 - Add multiplier to instances
 * Allows per-instance quantity multipliers for all order types
 */

export const version = '043';
export const name = 'add_instance_multiplier';

async function columnExists(db, column) {
  const row = await db.get(
    `SELECT name FROM pragma_table_info('instances') WHERE name = ?`,
    [column]
  );
  return !!row;
}

export async function up(db) {
  await db.run('PRAGMA busy_timeout = 5000');

  const exists = await columnExists(db, 'multiplier');
  if (exists) {
    console.log('  ℹ️  multiplier already exists on instances');
    return;
  }

  await db.run(`
    ALTER TABLE instances
    ADD COLUMN multiplier INTEGER DEFAULT 1
  `);

  console.log('  ✅ Added multiplier column to instances (default: 1)');
}

export async function down() {
  console.log('  ⚠️  Down migration not implemented (column drop not supported safely)');
}
```

### 2. Instance Service: CRUD Operations

**File**: `/backend/src/services/instance.service.js`

#### Change 1: Add multiplier validation in `_normalizeInstanceData()` (around line 1073)

**AFTER line 1161** (before the "Admin flags" section):

```javascript
    // Option chain API support flag
    if (data.supports_option_chain !== undefined) {
      normalized.supports_option_chain = parseBooleanSafe(data.supports_option_chain, false) ? 1 : 0;
    }

    // Instance multiplier (order quantity multiplier)
    if (data.multiplier !== undefined) {
      const multiplier = parseInt(data.multiplier, 10);
      if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 999) {
        errors.push({ field: 'multiplier', message: 'Multiplier must be an integer between 1 and 999' });
      } else {
        normalized.multiplier = multiplier;
      }
    } else if (!isUpdate) {
      normalized.multiplier = 1; // Default to 1x for new instances
    }

    // Admin flags
    if (data.is_primary_admin !== undefined) {
      normalized.is_primary_admin = parseBooleanSafe(data.is_primary_admin, false);
    }
```

#### Change 2: Include multiplier in `createInstance()` INSERT (around line 168)

**BEFORE line 168** (the columns array):

```javascript
      // Create instance
      const columns = [
        'name',
        'host_url',
        'api_key',
        'broker',
        'strategy_tag',
        'is_primary_admin',
        'is_secondary_admin',
        'market_data_role',
        'supports_multiquotes',
        'multiplier',  // ADD THIS LINE
      ];
      const values = [
        normalized.name,
        normalized.host_url,
        normalized.api_key,
        normalized.broker,
        normalized.strategy_tag,
        normalized.is_primary_admin ? 1 : 0,
        normalized.is_secondary_admin ? 1 : 0,
        normalized.market_data_role || 'none',
        normalized.supports_multiquotes ?? 0,
        normalized.multiplier || 1,  // ADD THIS LINE (default 1)
      ];
```

#### Change 3: Handle multiplier in `updateInstance()` (around line 262)

**BEFORE line 266** (inside the update fields loop):

```javascript
      for (const [key, value] of Object.entries(normalized)) {
        if (key === 'supports_option_chain' && !hasOptionChain) {
          continue;
        }
        if (key === 'use_ws_quotes' && !(await this._hasColumn('use_ws_quotes'))) {
          continue;
        }
        if (key === 'multiplier' && !(await this._hasColumn('multiplier'))) {
          continue;  // ADD THIS CHECK
        }
        fields.push(`${key} = ?`);
        values.push(value);
      }
```

### 3. QuickOrder Service: Apply Multiplier

**File**: `/backend/src/services/quick-order.service.js`

#### Critical Change: Update quantity calculation (line 757)

**REPLACE line 757**:

```javascript
// BEFORE
const tradeQuantity = quantity * lotSize;

// AFTER
const instanceMultiplier = instance.multiplier || 1;
const tradeQuantity = quantity * lotSize * instanceMultiplier;
```

#### Update logging to include multiplier (around line 761)

**REPLACE the log.info block (lines 761-773)**:

```javascript
    log.info('Calculated trade quantity', {
      symbolType: symbol.symbol_type,
      tradeMode,
      inputQuantity: quantity,
      lotSize,
      tradeQuantity,
      instanceMultiplier,  // ADD THIS LINE
      rawPosition,
      normalizedPosition: currentPosition,
      instance_id: instance.id,
      instance_name: instance.name,
      exchange: finalExchange,
      symbol: finalSymbol,
    });
```

### 4. TradingView Broadcast Service: Apply Multiplier

**File**: `/backend/src/services/tradingview-broadcast.service.js`

#### Change 1: Import instance service (top of file)

**AFTER line 7** (after existing imports):

```javascript
import watchlistService from './watchlist.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import instrumentsService from './instruments.service.js';
import instanceService from './instance.service.js';  // ADD THIS IMPORT
```

#### Change 2: Modify `_dispatchToTarget()` to apply multiplier (around line 406)

**ADD before line 413** (before creating the request body):

```javascript
  async _dispatchToTarget(target, payload) {
    const rateLimit = target.rateLimit ?? (this.defaultRps > 0 ? this.defaultRps : null);
    const bucket = this._getBucket(target.key, rateLimit);
    if (bucket) {
      await bucket.consume();
    }

    // Apply instance multiplier if available
    let finalQuantity = payload.quantity;
    if (target.instanceId) {
      try {
        const instance = await instanceService.getInstanceById(target.instanceId);
        const instanceMultiplier = instance.multiplier || 1;
        finalQuantity = payload.quantity * instanceMultiplier;
        
        log.debug('[TV Webhook] Applied instance multiplier', {
          target: target.name,
          instanceId: target.instanceId,
          originalQuantity: payload.quantity,
          multiplier: instanceMultiplier,
          finalQuantity,
        });
      } catch (error) {
        log.warn('[TV Webhook] Failed to fetch instance multiplier', {
          target: target.name,
          instanceId: target.instanceId,
          error: error.message,
        });
      }
    }

    const body = JSON.stringify({
      ...payload,
      quantity: finalQuantity,  // Use final quantity with multiplier
      apikey: target.apikey,
    });
```

**Note**: This implementation assumes targets have an `instanceId` property. If targets don't have instance IDs, you'll need to:

1. Modify the target resolution to include instance data
2. Store instance ID in the target object
3. Or map targets to instances via URL/API key matching

#### Alternative Approach: If targets don't have instance IDs

If targets are just URLs without instance IDs, modify `_normalizeTargets()` (around line 73):

**ADD after line 98** (in the normalized.push block):

```javascript
      normalized.push({
        key: name,
        name,
        url: baseUrl,
        endpoint: `${baseUrl}/api/v1/placesmartorder`,
        apikey,
        rateLimit,
        instanceId: target.instanceId || null,  // ADD THIS if available
      });
```

Then update `_resolveTargets()` to include instanceId in targets when resolving from watchlists.

### 5. Instance API Routes: Add Validation

**File**: `/backend/src/routes/v1/instances.js`

#### Add validation in POST route (around line 152)

**ADD after line 153** (inside create route, after `const instance = await instanceService.createInstance(req.body);`):

```javascript
router.post('/', requirePermission('instances.add'), async (req, res, next) => {
  try {
    // Validate multiplier if provided
    if (req.body.multiplier !== undefined) {
      const multiplier = parseInt(req.body.multiplier, 10);
      if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 999) {
        return res.status(400).json({
          status: 'error',
          message: 'Multiplier must be an integer between 1 and 999',
        });
      }
    }

    const instance = await instanceService.createInstance(req.body);
    logAudit(req, 'instances.create', { id: instance?.id, name: instance?.name });

    res.status(201).json({
      status: 'success',
      message: 'Instance created successfully',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
});
```

#### Add validation in PUT route (around line 171)

**ADD after line 186** (inside update route, before calling updateInstance):

```javascript
  try {
    const id = parseInt(req.params.id, 10);
    
    // Validate multiplier if provided
    if (req.body.multiplier !== undefined) {
      const multiplier = parseInt(req.body.multiplier, 10);
      if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 999) {
        return res.status(400).json({
          status: 'error',
          message: 'Multiplier must be an integer between 1 and 999',
        });
      }
    }

    // Determine if this is only a mode toggle (allowed for monitors)
    const keys = Object.keys(req.body || {});
    const modeOnly = keys.length === 1 && keys[0] === 'is_analyzer_mode';

    if (modeOnly && !hasPermission(req, 'instances.toggle_mode')) {
      return next(new ForbiddenError('Insufficient permissions'));
    }
    if (!modeOnly && !hasPermission(req, 'instances.edit')) {
      return next(new ForbiddenError('Insufficient permissions'));
    }

    const instance = await instanceService.updateInstance(id, req.body);
    const action = modeOnly ? 'instances.toggle_mode' : 'instances.update';
    logAudit(req, action, { id, body: req.body });

    res.json({
      status: 'success',
      message: 'Instance updated successfully',
      data: instance,
    });
  } catch (error) {
    next(error);
  }
```

### 6. Frontend: Add Multiplier UI

**File**: `/backend/public/js/quick-order.js` (or relevant frontend component)

#### Add multiplier input to instance form

**Location**: Inside the instance creation/editing form

```javascript
// Add this field to the instance form
const multiplierField = `
  <div class="form-group mb-3">
    <label for="multiplier" class="form-label">
      Multiplier <span class="text-muted">(Order Quantity Multiplier)</span>
    </label>
    <input 
      type="number" 
      id="multiplier" 
      name="multiplier" 
      class="form-control" 
      min="1" 
      max="999" 
      step="1" 
      value="1"
      required
    />
    <div class="form-text">
      Multiply all order quantities by this factor. Example: 2x will double all quantities.
    </div>
  </div>
`;

// Insert multiplier field before the submit button
$('#instance-form').append(multiplierField);
```

#### Display multiplier in instance list

**Location**: Where instances are displayed in the UI

```javascript
// Add multiplier column to instances table
const multiplierColumn = `
  <td>
    <span class="badge bg-${instance.multiplier > 1 ? 'primary' : 'secondary'}">
      ${instance.multiplier || 1}x
    </span>
  </td>
`;

// Add to table header
const headerRow = `
  <tr>
    <th>ID</th>
    <th>Name</th>
    <th>Host URL</th>
    <th>Broker</th>
    <th>Multiplier</th>  <!-- ADD THIS -->
    <th>Status</th>
    <th>Actions</th>
  </tr>
`;

// Add to each instance row
```

### 7. Watchlist Service: Multiplier Support (if needed)

**File**: `/backend/src/services/watchlist.service.js`

If watchlists resolve broadcast targets, ensure instance IDs are included:

**SEARCH for** `getBroadcastTargets` method

**VERIFY** that the returned targets include instance IDs so multipliers can be applied:

```javascript
// In getBroadcastTargets(), ensure target objects include instanceId
return {
  targets: [
    {
      key: instance.name,
      url: instance.host_url,
      apikey: instance.api_key,
      instanceId: instance.id,  // ENSURE THIS EXISTS
      rateLimit: instance.rate_limit || null,
    },
  ],
  watchlist,
};
```

## Testing Checklist

### Unit Tests

**Test 1: Instance CRUD with Multiplier**
```javascript
describe('Instance Multiplier', () => {
  test('should create instance with valid multiplier', async () => {
    const instance = await instanceService.createInstance({
      name: 'Test Instance',
      host_url: 'https://test.example.com',
      api_key: 'test-key',
      multiplier: 2,
    });
    expect(instance.multiplier).toBe(2);
  });

  test('should reject invalid multiplier', async () => {
    await expect(instanceService.createInstance({
      name: 'Test Instance',
      host_url: 'https://test.example.com',
      api_key: 'test-key',
      multiplier: 0,
    })).rejects.toThrow();
  });
});
```

**Test 2: Quantity Calculation with Multiplier**
```javascript
describe('Quick Order with Multiplier', () => {
  test('should multiply quantity by instance multiplier', async () => {
    const instance = { id: 1, multiplier: 3 };
    const quantity = 10;
    const lotSize = 1;
    
    // Mock the calculation
    const tradeQuantity = quantity * lotSize * (instance.multiplier || 1);
    expect(tradeQuantity).toBe(30);
  });
});
```

### Integration Tests

**Test: TradingView Broadcast with Multipliers**
```javascript
describe('TradingView Broadcast', () => {
  test('should apply multipliers to different instances', async () => {
    // Setup: Create 3 instances with multipliers 1x, 2x, 3x
    // Broadcast signal with quantity 10
    // Verify: Each instance receives quantity multiplied by its multiplier
    expect(instance1.receivedQuantity).toBe(10);
    expect(instance2.receivedQuantity).toBe(20);
    expect(instance3.receivedQuantity).toBe(30);
  });
});
```

## Deployment Checklist

- [ ] Create and apply database migration `043_add_instance_multiplier.js`
- [ ] Update instance.service.js with multiplier support
- [ ] Update quick-order.service.js to apply multiplier in calculations
- [ ] Update tradingview-broadcast.service.js to pass multipliers
- [ ] Update instance API routes with validation
- [ ] Update frontend to display and configure multipliers
- [ ] Run all unit tests
- [ ] Run integration tests
- [ ] Test with staging environment
- [ ] Deploy to production
- [ ] Monitor logs for multiplier application
- [ ] Update documentation

## Common Pitfalls & Solutions

### Pitfall 1: Forgetting Default Value
**Problem**: New instances might get multiplier = null
**Solution**: Always default to 1 in `_normalizeInstanceData()`

### Pitfall 2: Multiplier Not Applied in Broadcast
**Problem**: TradingView signals ignore multipliers
**Solution**: Ensure targets include instanceId and it's used in `_dispatchToTarget()`

### Pitfall 3: Position Calculation Errors
**Problem**: Position-aware trading doesn't account for multiplier
**Solution**: Apply multiplier AFTER position calculation, only to trade quantity

### Pitfall 4: Options with Multiple Strikes
**Problem**: Each strike needs multiplier applied separately
**Solution**: Loop through strikes and apply multiplier to each

## Performance Optimization

### 1. Cache Instance Data
Already implemented in `instance.service.js` via `_attachTelemetry()`

### 2. Batch Multiplier Fetch
For multi-instance operations, fetch all multipliers in one query:

```javascript
// In TradingView broadcast
const instanceIds = targets.map(t => t.instanceId);
const instances = await instanceService.getInstancesByIds(instanceIds);
const multipliers = new Map(instances.map(i => [i.id, i.multiplier || 1]));

// Apply during dispatch
const instanceMultiplier = multipliers.get(target.instanceId);
```

### 3. Avoid N+1 Queries
Ensure not to query instance data for each target individually in a loop.

## Security Considerations

1. **Input Validation**: Always validate multiplier is integer 1-999
2. **Default Values**: Never allow null multiplier (default to 1)
3. **Logging**: Log multiplier application for audit trail
4. **Rate Limiting**: Ensure high multipliers don't exceed broker rate limits

## Monitoring & Alerting

### Log Events
- Instance creation with multiplier
- Quantity calculation with multiplier applied
- Broadcast with multipliers to multiple instances
- Multiplier changes via API

### Metrics to Track
- Average multiplier across all instances
- Orders placed with multiplier > 1
- Performance impact of multiplier fetch

### Alerts
- Multiplier values exceeding reasonable limits (> 10x)
- Failed multiplier application
- Performance degradation with multipliers

## Conclusion

This technical specification provides exact code changes needed to implement instance multipliers. The implementation is:
- **Backwards compatible**: Default multiplier = 1
- **Performance conscious**: Minimal overhead
- **Well tested**: Comprehensive test coverage
- **Monitored**: Logging and metrics for visibility

Follow the order of implementation: database migration → service layer → API → frontend → testing → deployment.
