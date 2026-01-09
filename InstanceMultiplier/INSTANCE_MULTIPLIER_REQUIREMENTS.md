# Instance Multiplier Feature - Requirements Document

**Date**: 2025-01-09
**Version**: 1.0
**Status**: Requirements Phase

---

## Overview

Implement instance-specific multipliers that scale trade quantities for each trading instance. This allows different instances to execute trades with different position sizes based on their configured multiplier.

### Business Use Case

Traders may want to:
- Allocate different risk levels to different broker accounts
- Maintain consistency across multiple accounts with proportional sizing
- Test strategies with smaller position sizes on some instances
- Scale up successful strategies on specific accounts

### Example Scenario

**Signal**: BUY 2 lots of BANKNIFTY

| Instance | Multiplier | Executed Quantity |
|----------|------------|-------------------|
| Account A | 1x | 2 lots (50 contracts) |
| Account B | 2x | 4 lots (100 contracts) |
| Account C | 3x | 6 lots (150 contracts) |

---

## Functional Requirements

### FR-1: Multiplier Support
**System shall** support integer multipliers for all trading instances.

**Details**:
- Multiplier values: 1x, 2x, 3x, ..., 999x
- Default value: 1x (no scaling)
- Only integer values allowed (no decimals)

### FR-2: Trade Mode Coverage
**System shall** apply multipliers to all trade modes.

**Trade Modes**:
- EQUITY: BUY, SELL, SHORT, COVER, EXIT
- FUTURES: BUY, SELL, SHORT, COVER, EXIT
- OPTIONS (BUYER): BUY_CE, BUY_PE, REDUCE_CE, REDUCE_PE, CLOSE_ALL_CE, CLOSE_ALL_PE, EXIT_ALL
- OPTIONS (WRITER): SELL_CE, SELL_PE, INCREASE_CE, INCREASE_PE, CLOSE_ALL_CE, CLOSE_ALL_PE, EXIT_ALL

### FR-3: Signal Source Coverage
**System shall** apply multipliers to all signal sources.

**Signal Sources**:
- Frontend trading buttons
- API calls (direct order placement)
- TradingView alerts (webhook broadcasts)

### FR-4: Configuration Management
**System shall** allow configuring multipliers per instance.

**Requirements**:
- Multiplier stored in database
- Configurable via UI
- Bulk update capability
- Valid range: 1 to 999 (inclusive)

### FR-5: Quantity Calculation
**System shall** calculate final quantity as:
```
Final Quantity = Base Quantity × Lot Size × Instance Multiplier
```

**Example**:
- Input: 2 lots
- Lot Size: 25 (BANKNIFTY)
- Multiplier: 3x
- Calculation: 2 × 25 × 3 = 150 contracts

### FR-6: Position-Aware Trading
**System shall** apply multiplier to position-aware trades.

**Examples**:
- BUY action: Multiplies the additional quantity
- REDUCE action: Multiplies the reduction quantity
- EXIT action: Multiplies the closing quantity

---

## Non-Functional Requirements

### NFR-1: Performance
**System shall** maintain existing performance characteristics.

**Metrics**:
- Additional latency: < 5ms per order
- No degradation in multi-instance parallel execution
- Database query overhead: < 1ms

### NFR-2: Backwards Compatibility
**System shall** be backwards compatible with existing instances.

**Requirements**:
- Existing instances default to multiplier = 1
- No changes to API contracts
- No changes to existing order flow
- Graceful handling of missing multiplier field

### NFR-3: Observability
**System shall** provide visibility into multiplier usage.

**Requirements**:
- Log multiplier value with each order
- Track orders by multiplier value
- Alert on invalid multiplier values

### NFR-4: Validation
**System shall** validate multiplier values.

**Rules**:
- Type: Integer only
- Range: 1 to 999
- Required: No (defaults to 1)
- Storage: INTEGER field in database

---

## Data Requirements

### DR-1: Database Schema
**Table**: `instances`

**New Field**:
```
Name: multiplier
Type: INTEGER
Default: 1
Constraint: CHECK (multiplier >= 1 AND multiplier <= 999)
```

### DR-2: API Responses
**GET /instances** shall include multiplier field:
```json
{
  "id": 123,
  "name": "Zerodha Account",
  "multiplier": 2,
  ...
}
```

### DR-3: API Requests
**POST /instances** shall accept optional multiplier:
```json
{
  "name": "New Account",
  "multiplier": 3,
  ...
}
```

**PATCH /instances/:id** shall accept optional multiplier.

---

## Integration Requirements

### IR-1: TradingView Integration
**System shall** apply multipliers when broadcasting to multiple instances.

**Flow**:
1. TradingView webhook received
2. Signal normalized
3. Targets resolved (instances with multipliers)
4. Per-instance quantity calculated with multiplier
5. Parallel execution to all instances

**Note**: TradingView sends single payload; backend applies multiplier per instance.

### IR-2: Multi-Instance Broadcast
**System shall** maintain parallel execution across instances.

**Requirements**:
- All instances execute simultaneously
- Each instance uses its own multiplier
- No serialization due to multipliers
- Results aggregated for user

### IR-3: Frontend Integration
**System shall** provide UI for multiplier management.

**UI Elements**:
- Instance creation form: multiplier field
- Instance list: display multiplier column
- Instance edit: update multiplier
- Bulk edit: update multiple multipliers

---

## User Stories

### US-1: Configure Instance Multiplier
**As a** trader,
**I want to** set a multiplier for each trading instance,
**So that** I can control position sizing per account.

**Acceptance Criteria**:
- Given I'm creating a new instance, when I set multiplier to 3, then orders execute with 3x quantity
- Given I'm editing an existing instance, when I change multiplier to 2, then future orders use 2x quantity
- Given I set multiplier to 0, when I try to save, then system shows error "Multiplier must be 1-999"

### US-2: View Instance Multipliers
**As a** trader,
**I want to** see the multiplier for each instance,
**So that** I can verify my configuration.

**Acceptance Criteria**:
- Given I have multiple instances with different multipliers, when I view the instances list, then I see each multiplier displayed
- Given I filter instances, when I look at results, then multiplier column is visible

### US-3: Trade with Multiplier
**As a** trader,
**I want to** execute trades that respect instance multipliers,
**So that** different accounts trade with proportional sizes.

**Acceptance Criteria**:
- Given I have Instance A (1x) and Instance B (2x), when I click BUY 2 lots, then Instance A executes 2 lots and Instance B executes 4 lots
- Given I have options trading enabled with multiplier 3x, when I click BUY_CE 2 lots, then 6 lots are executed

### US-4: Bulk Update Multipliers
**As a** trader,
**I want to** update multipliers for multiple instances at once,
**So that** I can quickly adjust my strategy.

**Acceptance Criteria**:
- Given I select 3 instances, when I choose bulk edit and set multiplier to 2x, then all 3 instances are updated to 2x
- Given I have 10 instances, when I use bulk edit, then the operation completes successfully

### US-5: Default Multiplier
**As a** trader,
**I want** new instances to default to 1x multiplier,
**So that** existing behavior is preserved.

**Acceptance Criteria**:
- Given I create a new instance without setting multiplier, when I save, then the instance has multiplier = 1
- Given I view an old instance created before this feature, when I check its multiplier, then it shows 1

---

## Testing Requirements

### TR-1: Unit Tests
**System shall** have unit tests for multiplier logic.

**Test Cases**:
- Multiplier defaults to 1 when not set
- Multiplier validation rejects values < 1
- Multiplier validation rejects values > 999
- Multiplier validation rejects non-integers
- Quantity calculation applies multiplier correctly

### TR-2: Integration Tests
**System shall** have integration tests for end-to-end flows.

**Test Cases**:
- Frontend → API → Backend → Order execution with multiplier
- TradingView webhook → Multi-instance broadcast with different multipliers
- All trade modes (EQUITY, FUTURES, OPTIONS) with multipliers
- Position-aware trading with multipliers

### TR-3: Performance Tests
**System shall** maintain performance with multipliers.

**Test Cases**:
- 3 instances with multipliers execute in parallel (same time as before)
- Single instance with multiplier has < 5ms additional latency
- Database queries perform within acceptable limits

### TR-4: Compatibility Tests
**System shall** maintain backwards compatibility.

**Test Cases**:
- Old instances without multiplier field work correctly
- Existing API calls work without multiplier field
- Orders execute correctly when multiplier field is missing

---

## Edge Cases

### EC-1: Missing Multiplier
**Scenario**: Instance created before feature rollout
**Expected**: System treats as multiplier = 1
**Test**: Verify default value applied

### EC-2: Invalid Multiplier Value
**Scenario**: Database has invalid multiplier (0, negative, > 999)
**Expected**: System validates and corrects or rejects
**Test**: Verify validation prevents save

### EC-3: Options Multi-Strike Orders
**Scenario**: Options REDUCE action across multiple strikes
**Expected**: Each strike order uses the same multiplier
**Test**: Verify multiplier applied to each individual order

### EC-4: Position Size Limit
**Scenario**: Multiplied quantity exceeds position limits
**Expected**: System respects existing position limits
**Test**: Verify position limits still enforced

### EC-5: Rate Limiting
**Scenario**: Multiple instances with different multipliers
**Expected**: Each instance subject to same rate limits
**Test**: Verify rate limiting unaffected by multiplier

---

## Success Criteria

### Functional
- [ ] All trade modes support multipliers
- [ ] All signal sources apply multipliers
- [ ] UI allows viewing and editing multipliers
- [ ] Bulk update works correctly
- [ ] Validation prevents invalid values

### Performance
- [ ] < 5ms additional latency per order
- [ ] Parallel execution maintained
- [ ] No increase in error rate

### Compatibility
- [ ] Existing instances work without changes
- [ ] No breaking API changes
- [ ] All existing tests pass

### Quality
- [ ] 90%+ test coverage for multiplier features
- [ ] Logging provides clear visibility
- [ ] Error handling for edge cases

---

## Open Questions

### Q1: Should multipliers be visible to end users?
**Context**: Instances are managed by admins, but multiplier affects all trades.
**Decision Needed**: Who can view/edit multipliers?

### Q2: Should there be instance-level multiplier enable/disable?
**Context**: Some instances might want to opt-out of multipliers entirely.
**Decision Needed**: Always apply multiplier, or make it configurable per instance?

### Q3: Should multipliers be auditable?
**Context**: Multiplier changes affect trade quantities.
**Decision Needed**: Log multiplier changes for compliance?

### Q4: Should there be maximum multiplier warnings?
**Context**: High multipliers (10x, 100x) could be risky.
**Decision Needed**: Alert when multiplier exceeds threshold?

---

## Dependencies

### Database
- Migration to add multiplier column to instances table
- Existing instance records need default value (1)

### Backend Services
- QuickOrderService: Apply multiplier to quantity calculation
- InstanceService: CRUD operations with multiplier
- TradingView Broadcast: Logging with multiplier info

### API Layer
- Validation for multiplier field
- Response format updates

### Frontend
- UI components for multiplier management
- Form validation
- Table display

---

## Risks

### Risk 1: Incorrect Multiplier Application
**Impact**: High
**Probability**: Low
**Mitigation**: Comprehensive testing, clear logging

### Risk 2: Performance Degradation
**Impact**: Medium
**Probability**: Very Low
**Mitigation**: Minimal calculation overhead, already optimized

### Risk 3: Backwards Compatibility Issues
**Impact**: High
**Probability**: Low
**Mitigation**: Default to 1, extensive compatibility testing

### Risk 4: User Confusion
**Impact**: Medium
**Probability**: Medium
**Mitigation**: Clear UI labels, tooltips, documentation

---

## Timeline Estimate

### Phase 1: Core Implementation (8 hours)
- Database migration
- Quantity calculation update
- Instance service updates

### Phase 2: Integration (4 hours)
- API validation
- TradingView logging
- Error handling

### Phase 3: UI Development (4-8 hours)
- Form components
- Table display
- Bulk edit

### Phase 4: Testing (8-16 hours)
- Unit tests
- Integration tests
- E2E tests
- Performance testing

**Total Estimate**: 24-36 hours (3-5 days)

---

## Approval

**Required Approvals**:
- [ ] Product Owner
- [ ] Technical Lead
- [ ] QA Lead

**Sign-off**:
- Product Owner: _________________ Date: _________
- Technical Lead: _______________ Date: _________
- QA Lead: _____________________ Date: _________

---

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-09 | Claude Code | Initial requirements document |

---

**END OF REQUIREMENTS**
