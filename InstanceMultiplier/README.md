# Instance Multipliers Implementation Guide

## Overview
This repository contains comprehensive documentation for implementing instance multipliers in the trading system. The feature allows each trading instance to apply a multiplier (1x, 2x, 3x, etc.) to order quantities across all trade modes and signal sources.

## 📚 Documentation Index

### 1. [Implementation Summary](implementation-summary.md) ⭐ START HERE
**Purpose**: Quick-start guide for developers  
**Audience**: All developers  
**Read Time**: 5 minutes  
**Contains**:
- Priority-ordered file modifications
- Copy-paste ready code snippets
- Verification checklist
- Timeline estimate

### 2. [Technical Specification](technical-specification-multipliers.md) 🔧
**Purpose**: Detailed line-by-line code changes  
**Audience**: Backend developers  
**Read Time**: 30 minutes  
**Contains**:
- Exact file locations and line numbers
- Complete code snippets for each change
- Unit and integration test examples
- Deployment checklist
- Common pitfalls and solutions

### 3. [Full Implementation Plan](instance-multipliers-implementation-plan.md) 📋
**Purpose**: Comprehensive project plan  
**Audience**: Technical leads, project managers  
**Read Time**: 45 minutes  
**Contains**:
- Current system analysis
- Requirements and architecture
- Phased implementation approach
- Risk assessment
- Performance considerations
- Success criteria

### 4. [Data Flow Architecture](data-flow-architecture.md) 🏗️
**Purpose**: Visual architecture and data flows  
**Audience**: All team members  
**Read Time**: 20 minutes  
**Contains**:
- System architecture diagrams
- Step-by-step data flow scenarios
- Code flow diagrams
- Database schema
- Error handling scenarios
- Logging and monitoring

## 🚀 Quick Start

### For Experienced Developers (15 minutes)

1. **Read**: [Implementation Summary](implementation-summary.md) (5 min)
2. **Create**: Database migration (5 min)
3. **Modify**: QuickOrder service line 757 (5 min)

You're done with the critical path!

### For Full Implementation (1-2 weeks)

1. **Week 1**: Backend services
   - Database migration (0.5 day)
   - Instance service updates (2 days)
   - QuickOrder service updates (1 day)
   - TradingView broadcast updates (2 days)

2. **Week 2**: API, Frontend, Testing
   - API routes validation (1 day)
   - Frontend UI (2-3 days)
   - Testing (2-3 days)
   - Documentation (1 day)

## 📁 File Structure

```
/Users/jnt/.claude/plans/
├── README.md                                           # This file
├── implementation-summary.md                           # Quick start guide
├── technical-specification-multipliers.md              # Detailed code changes
├── instance-multipliers-implementation-plan.md         # Full project plan
└── data-flow-architecture.md                          # Architecture diagrams
```

## 🎯 Critical Files to Modify

### Priority 1 (Core)
1. `/backend/migrations/043_add_instance_multiplier.js` - Database schema
2. `/backend/src/services/quick-order.service.js` - Quantity calculation
3. `/backend/src/services/instance.service.js` - CRUD operations

### Priority 2 (Integration)
4. `/backend/src/services/tradingview-broadcast.service.js` - Broadcast support
5. `/backend/src/routes/v1/instances.js` - API validation

### Priority 3 (UI)
6. Frontend instance management forms

## 🔑 Key Implementation Points

### Most Critical Change
**File**: `/backend/src/services/quick-order.service.js`  
**Line**: 757  
**Change**: 
```javascript
// FROM:
const tradeQuantity = quantity * lotSize;

// TO:
const instanceMultiplier = instance.multiplier || 1;
const tradeQuantity = quantity * lotSize * instanceMultiplier;
```

### Database Migration
```javascript
// Create: /backend/migrations/043_add_instance_multiplier.js
await db.run(`
  ALTER TABLE instances
  ADD COLUMN multiplier INTEGER DEFAULT 1
`);
```

## ✅ Success Criteria

- [ ] Database migration applied successfully
- [ ] Instances can be created with multipliers 1-999
- [ ] Quick orders multiply quantity by instance multiplier
- [ ] TradingView webhooks multiply quantity by instance multiplier
- [ ] UI displays and configures multipliers
- [ ] All existing tests pass
- [ ] Performance impact < 5ms per order

## 🧪 Testing

### Minimum Testing Required
1. Unit test: Multiplier calculation
2. Integration test: Quick order flow
3. Integration test: TradingView broadcast

### Full Test Suite
See [Technical Specification](technical-specification-multipliers.md#testing) for complete test scenarios.

## 📊 Monitoring

### Log Messages to Watch
```
Instance created { multiplier: 2 }
Calculated trade quantity { instanceMultiplier: 2 }
[TV Webhook] Applied instance multiplier { finalQuantity: 20 }
```

### Metrics to Track
- `instance_multipliers_configured_total`
- `order_quantity_multiplier_applied_total`
- `api_validation_multiplier_errors_total`

## 🚨 Common Pitfalls

### Pitfall 1: Forgetting Default Value
**Problem**: New instances get multiplier = null  
**Solution**: Always default to 1 in `_normalizeInstanceData()`

### Pitfall 2: Multiplier Not Applied in Broadcast
**Problem**: TradingView signals ignore multipliers  
**Solution**: Ensure targets include instanceId

### Pitfall 3: Position Calculation Errors
**Problem**: Position-aware trading ignores multipliers  
**Solution**: Apply multiplier AFTER position calc, only to trade qty

## 📞 Support

### Questions?
1. Check [Technical Specification](technical-specification-multipliers.md#common-pitfalls--solutions)
2. Review [Data Flow Architecture](data-flow-architecture.md#error-handling-scenarios)
3. Verify implementation against [Checklist](implementation-summary.md#verification-checklist)

### Debug Commands
```bash
# Check multiplier column exists
sqlite3 database.db "PRAGMA table_info(instances);"

# Check multiplier values
sqlite3 database.db "SELECT id, name, multiplier FROM instances;"

# Check logs
grep -i "multiplier" /var/log/app.log | tail -50
```

## 🎓 Learning Path

### For New Team Members
1. Start with [Implementation Summary](implementation-summary.md)
2. Read [Data Flow Architecture](data-flow-architecture.md) for understanding
3. Follow [Technical Specification](technical-specification-multipliers.md) for implementation
4. Reference [Full Plan](instance-multipliers-implementation-plan.md) for context

### For Reviewers
1. Read [Full Implementation Plan](instance-multipliers-implementation-plan.md) (Requirements & Architecture)
2. Review [Data Flow Architecture](data-flow-architecture.md) (Diagrams)
3. Check [Implementation Summary](implementation-summary.md) (Checklist)
4. Validate against [Technical Specification](technical-specification-multipliers.md) (Code)

## 🏗️ Architecture Highlights

```
┌─────────────────┐
│  Frontend/API   │  User places order for 10 qty
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ QuickOrder Svc  │  Calculates: 10 * 1 * 3 = 30 (3x multiplier)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  OpenAlgo API   │  Sends order to broker for 30 qty
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Broker       │  Executes order for 30 qty
└─────────────────┘
```

## 🔒 Security

- Input validation: Multiplier must be integer 1-999
- Default value: 1 (no multiplication)
- Logging: Full audit trail of multiplier usage
- Rate limiting: Monitor for unusual multiplier values

## 📈 Performance

- **Database**: +1 column read per instance (0.1ms)
- **Calculation**: +1 multiplication (negligible)
- **Broadcast**: Parallel execution maintained
- **Total Impact**: < 5ms per order

## 🔄 Backwards Compatibility

- ✅ Default multiplier = 1 (no change to existing behavior)
- ✅ Existing instances get multiplier = 1 automatically
- ✅ No breaking changes to API
- ✅ No changes required for existing users

## 📝 Notes

- All code changes are non-destructive
- Migration is reversible (data preserved)
- Feature can be enabled gradually
- Zero downtime deployment possible

## 🤝 Contributing

When implementing:

1. Follow the order in [Implementation Summary](implementation-summary.md#implementation-steps)
2. Test each change before proceeding
3. Update this README if you find issues
4. Document any new scenarios discovered

## 📄 License

This implementation guide is part of the Simplifyed trading system project.

---

**Status**: ✅ Ready for Implementation  
**Last Updated**: 2026-01-09  
**Version**: 1.0  

## 📞 Quick Reference

| What | Where | How Long |
|------|-------|----------|
| Read docs | All 4 files | 1-2 hours |
| Core implementation | 3 files | 1-2 days |
| Full implementation | 6 files | 1-2 weeks |
| Testing | Various | 2-3 days |

**Need Help?** Start with [Implementation Summary](implementation-summary.md) 🚀
