# Instance Multipliers - Implementation Summary

## Quick Start Guide

### Files to Modify (Priority Order)

#### Priority 1: Critical Files (Core Functionality)

1. **Database Migration** 
   - File: `/backend/migrations/043_add_instance_multiplier.js`
   - Action: Create migration to add `multiplier INTEGER DEFAULT 1` column
   - Effort: 30 minutes

2. **QuickOrder Service** (MOST CRITICAL)
   - File: `/backend/src/services/quick-order.service.js`
   - Line: 757
   - Action: Change `const tradeQuantity = quantity * lotSize;` to `const tradeQuantity = quantity * lotSize * (instance.multiplier || 1);`
   - Effort: 15 minutes

3. **Instance Service** (CRUD Operations)
   - File: `/backend/src/services/instance.service.js`
   - Actions:
     - Add multiplier validation in `_normalizeInstanceData()` (lines ~1161)
     - Include multiplier in `createInstance()` INSERT (line ~168)
     - Handle multiplier in `updateInstance()` UPDATE (line ~262)
   - Effort: 2 hours

#### Priority 2: Integration Files (Broadcast & API)

4. **TradingView Broadcast Service**
   - File: `/backend/src/services/tradingview-broadcast.service.js`
   - Actions:
     - Import instanceService (line ~7)
     - Modify `_dispatchToTarget()` to apply multiplier (line ~406)
   - Effort: 2 hours
   - Note: Requires understanding how targets map to instances

5. **Instance API Routes**
   - File: `/backend/src/routes/v1/instances.js`
   - Actions:
     - Add validation in POST route (line ~152)
     - Add validation in PUT route (line ~171)
   - Effort: 1 hour

#### Priority 3: UI Files

6. **Frontend Components**
   - File: `/backend/public/js/quick-order.js` (or frontend equivalent)
   - Actions:
     - Add multiplier input field to instance form
     - Display multiplier in instance list
   - Effort: 2-4 hours

## Implementation Steps

### Step 1: Database (Start Here)
```bash
# Create migration file
touch /backend/migrations/043_add_instance_multiplier.js

# Apply migration (after creating file)
npm run migrate
```

### Step 2: Backend Services
1. Update `instance.service.js` - Add CRUD support
2. Update `quick-order.service.js` - Apply multiplier to quantities
3. Update `tradingview-broadcast.service.js` - Support broadcast with multipliers

### Step 3: API Layer
1. Update `instances.js` - Add validation and multiplier handling

### Step 4: Frontend
1. Add multiplier UI components
2. Display multiplier in instance management interface

### Step 5: Testing
1. Run existing tests to ensure no regression
2. Create new tests for multiplier functionality
3. Test manually with sample data

## Key Code Changes (Copy-Paste Ready)

### QuickOrder Service (Line 757)
```javascript
// Change this line:
const tradeQuantity = quantity * lotSize;

// To this:
const instanceMultiplier = instance.multiplier || 1;
const tradeQuantity = quantity * lotSize * instanceMultiplier;
```

### Instance Service Validation
```javascript
// Add in _normalizeInstanceData() around line 1161:
if (data.multiplier !== undefined) {
  const multiplier = parseInt(data.multiplier, 10);
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 999) {
    errors.push({ field: 'multiplier', message: 'Multiplier must be 1-999' });
  } else {
    normalized.multiplier = multiplier;
  }
} else if (!isUpdate) {
  normalized.multiplier = 1;
}
```

### Database Migration
```javascript
export async function up(db) {
  await db.run('PRAGMA busy_timeout = 5000');
  
  const row = await db.get(
    `SELECT name FROM pragma_table_info('instances') WHERE name = ?`,
    ['multiplier']
  );
  if (row) {
    console.log('  ℹ️  multiplier already exists');
    return;
  }
  
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN multiplier INTEGER DEFAULT 1
  `);
  
  console.log('  ✅ Added multiplier column');
}
```

## Testing Strategy

### Minimum Viable Testing

1. **Unit Test - Multiplier Calculation**
   ```javascript
   const instance = { multiplier: 2 };
   const quantity = 10;
   const lotSize = 1;
   const result = quantity * lotSize * (instance.multiplier || 1);
   assert(result === 20);
   ```

2. **Integration Test - Order Flow**
   - Create instance with multiplier = 2
   - Place order for quantity = 10
   - Verify broker receives quantity = 20

3. **Integration Test - Broadcast**
   - Create 2 instances with multipliers 1x and 2x
   - Broadcast signal with quantity = 10
   - Verify instance 1 gets 10, instance 2 gets 20

### Full Test Suite

1. Test all CRUD operations with multiplier
2. Test edge cases (multiplier = 1, 999, invalid values)
3. Test with position-aware trading
4. Test with options (multiple strikes)
5. Test with different trade modes (EQUITY, FUTURES, OPTIONS)
6. Test API validation
7. Test UI components

## Verification Checklist

After implementation, verify:

- [ ] New instances default to multiplier = 1
- [ ] Existing instances have multiplier = 1 (after migration)
- [ ] Can create instance with multiplier = 5
- [ ] Quick order with quantity = 10 sends quantity = 50 to broker
- [ ] TradingView webhook broadcasts with multipliers applied
- [ ] UI shows multiplier for each instance
- [ ] API validates multiplier range (1-999)
- [ ] Logs show multiplier application
- [ ] No performance degradation
- [ ] All existing tests pass

## Rollback Plan

If issues occur:

1. **Remove multiplier from calculations**
   - Revert quick-order.service.js line 757 to original
   - Orders work as before (no multiplication)

2. **Hide multiplier UI**
   - Comment out multiplier field in frontend
   - Feature hidden but code remains

3. **Revert database migration** (if needed)
   - SQLite doesn't support column drop easily
   - Can set all multipliers to 1 to effectively disable

## Monitoring After Deployment

### Log Messages to Watch For

1. Instance creation with multiplier
   ```
   Instance created { id: X, name: Y, multiplier: 2 }
   ```

2. Quantity calculation with multiplier
   ```
   Calculated trade quantity { inputQuantity: 10, tradeQuantity: 20, instanceMultiplier: 2 }
   ```

3. Broadcast with multipliers
   ```
   [TV Webhook] Applied instance multiplier { target: X, multiplier: 3, finalQuantity: 30 }
   ```

### Metrics to Track

1. Count of instances with multiplier > 1
2. Average multiplier value across instances
3. Orders placed with multiplier > 1
4. API errors related to multiplier validation

## Performance Impact

Expected impact: **NEGLIGIBLE**

- Database fetch: +1 column read per instance (0.1ms)
- Calculation: +1 multiplication operation (negligible)
- No additional API calls
- No change to parallel broadcasting

## Documentation Updates Required

1. **API Documentation**
   - Add multiplier field to instance schema
   - Document validation rules (1-999)

2. **User Guide**
   - How to configure multipliers
   - Use cases and examples
   - Best practices

3. **README**
   - Feature summary
   - Breaking changes (none)

## Support & Troubleshooting

### Common Issues

**Issue**: Multiplier not applied to orders
- **Check**: Is instance.multiplier defined?
- **Check**: Is multiplier in the database?
- **Fix**: Verify migration ran successfully

**Issue**: Broadcasting uses wrong multiplier
- **Check**: Do targets include instanceId?
- **Check**: Is instanceService imported?
- **Fix**: Ensure targets map to instances correctly

**Issue**: API rejects valid multiplier
- **Check**: Validation logic in routes
- **Fix**: Ensure 1-999 range check is correct

### Debug Commands

```bash
# Check if multiplier column exists
sqlite3 database.db "PRAGMA table_info(instances);"

# Check multiplier values
sqlite3 database.db "SELECT id, name, multiplier FROM instances;"

# Check logs for multiplier application
grep -i "multiplier" /var/log/app.log | tail -50
```

## Success Criteria

✅ **Feature Complete When**:
- All 7 files modified according to spec
- Database migration applied successfully
- All tests passing (existing + new)
- Manual testing confirms:
  - Quick orders multiply by instance multiplier
  - TradingView broadcasts multiply by instance multiplier
  - UI displays and configures multipliers
  - API validates multipliers correctly

✅ **Ready for Production When**:
- Staging environment tested successfully
- No performance degradation
- No breaking changes to existing users
- Documentation complete
- Support team briefed

## Timeline Estimate

**Total Effort**: 1-2 weeks (for experienced developer)

- Database migration: 0.5 day
- Backend services: 3 days
- API layer: 1 day
- Frontend: 2-3 days
- Testing: 2-3 days
- Documentation: 1 day

**Parallelizable**: Frontend and testing can start after backend services are 50% complete.

## Resources

- **Full Implementation Plan**: `/Users/jnt/.claude/plans/instance-multipliers-implementation-plan.md`
- **Technical Specification**: `/Users/jnt/.claude/plans/technical-specification-multipliers.md`
- **This Summary**: `/Users/jnt/.claude/plans/implementation-summary.md`

## Next Steps

1. Review all three documents
2. Start with database migration (Priority 1)
3. Modify quick-order.service.js (most critical change)
4. Update instance.service.js (CRUD operations)
5. Continue with remaining files in priority order
6. Test thoroughly at each step
7. Deploy and monitor

---

**Questions?** Review the detailed documents for comprehensive information.
