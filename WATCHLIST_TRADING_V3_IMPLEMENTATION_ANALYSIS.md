# Watchlist Trading Spec v3 - Implementation Analysis

**Date:** 2025-11-15
**Status:** Analysis Phase
**Goal:** Integrate advanced trading features without breaking existing functionality

---

## Executive Summary

The Watchlist Trading Spec v3 introduces a sophisticated server-authoritative trading system with:
- **Settings Precedence System**: 6-tier configuration hierarchy
- **Per-Unit Risk Management**: Server-side TP/SL/TSL enforcement
- **Advanced Order Orchestration**: Target-based positions, delta calculation, non-accumulation
- **Symbol Resolution**: Strike policies (FLOAT_OFS, ANCHOR_OFS), expiry management
- **Risk Engine**: Trailing stops, pyramiding, scope-based exits (LEG/TYPE/INDEX)

---

## Current State Analysis

### ✅ What's Already Implemented

1. **Basic Watchlist System** ✓
   - Watchlists table with CRUD operations
   - Symbol management (watchlist_symbols)
   - Instance assignments (watchlist_instances)
   - Orders tracking (watchlist_orders)
   - Positions tracking (watchlist_positions)

2. **Order Placement** ✓
   - Using `placesmartorder` (position-aware)
   - Position_size parameter supported
   - Basic validation and error handling

3. **Quick Order UI** ✓
   - Row expansion for trading controls
   - Trade mode selection (EQUITY/FUTURES/OPTIONS)
   - Options leg selection (ATM/ITM/OTM)
   - Expiry selection
   - Action buttons (BUY/SELL/EXIT, BUY_CE/SELL_CE/etc)

4. **Basic Risk Configuration** ✓
   - Target type/value in watchlist_symbols
   - SL type/value in watchlist_symbols
   - Trailing stop fields (ts_type, ts_value)

5. **Symbol Metadata** ✓
   - Symbol type classification (EQUITY/FUTURES/OPTIONS/INDEX)
   - Expiry, strike, option_type fields
   - Instruments cache with FTS5 search

### ❌ What's Missing (Spec v3 Requirements)

1. **Settings Precedence System**
   - No global_defaults table
   - No index_profiles table
   - No watchlist_overrides table
   - No user_defaults table
   - No symbol_overrides table
   - No config_audit table
   - No settings merge logic

2. **Intent System**
   - No intents table
   - No intent_id tracking
   - No resolved config snapshots

3. **Server-Side Risk Engine**
   - No Fill Aggregator service
   - No Quote Router service
   - No Risk Engine service
   - No per-leg state tracking (net_qty, weighted_avg_entry, best_favorable)
   - No TSL arming/trailing logic
   - No scope-based exits (LEG/TYPE/INDEX)

4. **Advanced Symbol Resolution**
   - No strike policy support (FLOAT_OFS vs ANCHOR_OFS)
   - No strike anchoring state

5. **Pyramiding Support**
   - No reanchor mode
   - No weighted average entry recalculation

6. **Risk Trigger Idempotency**
   - No risk_trigger_id tracking
   - No deduplication for exits

7. **Settings API**
   - No /settings/effective endpoint
   - No /settings/global, /settings/index, etc.

---

## Implementation Strategy

### Phase 1: Database Schema Extensions (Non-Breaking)

**Goal:** Add new tables without modifying existing schema

#### New Tables to Create:

1. **global_defaults** (singleton table)
```sql
CREATE TABLE global_defaults (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ltp_refresh_seconds INTEGER DEFAULT 5,
  default_strike_policy TEXT DEFAULT 'FLOAT_OFS',
  default_step_lots INTEGER DEFAULT 1,
  default_step_contracts INTEGER DEFAULT 1,
  tp_per_unit REAL,
  sl_per_unit REAL,
  tsl_enabled BOOLEAN DEFAULT 0,
  tsl_trail_by REAL,
  tsl_step REAL,
  tsl_arm_after REAL,
  tsl_breakeven_after REAL,
  disallow_auto_reverse BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

2. **index_profiles** (NIFTY, BANKNIFTY, etc.)
```sql
CREATE TABLE index_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  index_name TEXT NOT NULL UNIQUE,
  exchange_segment TEXT NOT NULL,
  strike_step INTEGER,
  risk_anchor_mode TEXT DEFAULT 'GLOBAL',
  default_offset TEXT DEFAULT 'ATM',
  default_product TEXT DEFAULT 'MIS',
  -- Risk overrides (nullable = inherit from global)
  tp_per_unit REAL,
  sl_per_unit REAL,
  tsl_enabled BOOLEAN,
  tsl_trail_by REAL,
  tsl_step REAL,
  tsl_arm_after REAL,
  tsl_breakeven_after REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

3. **watchlist_overrides**
```sql
CREATE TABLE watchlist_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL,
  index_name TEXT,
  -- Optional overrides
  strike_policy TEXT,
  step_lots INTEGER,
  tp_per_unit REAL,
  sl_per_unit REAL,
  tsl_enabled BOOLEAN,
  tsl_trail_by REAL,
  tsl_step REAL,
  tsl_arm_after REAL,
  tsl_breakeven_after REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (watchlist_id) REFERENCES watchlists(id) ON DELETE CASCADE,
  UNIQUE(watchlist_id, index_name)
);
```

4. **user_defaults**
```sql
CREATE TABLE user_defaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  -- Optional overrides
  strike_policy TEXT,
  step_lots INTEGER,
  step_contracts INTEGER,
  tp_per_unit REAL,
  sl_per_unit REAL,
  tsl_enabled BOOLEAN,
  tsl_trail_by REAL,
  tsl_step REAL,
  tsl_arm_after REAL,
  tsl_breakeven_after REAL,
  disallow_auto_reverse BOOLEAN,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

5. **symbol_overrides** (for direct symbols/futures)
```sql
CREATE TABLE symbol_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  exchange TEXT NOT NULL,
  -- Optional overrides
  step_contracts INTEGER,
  tp_per_unit REAL,
  sl_per_unit REAL,
  tsl_enabled BOOLEAN,
  tsl_trail_by REAL,
  tsl_step REAL,
  tsl_arm_after REAL,
  tsl_breakeven_after REAL,
  disallow_auto_reverse BOOLEAN,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

6. **config_audit**
```sql
CREATE TABLE config_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  scope_key TEXT,
  changed_json TEXT NOT NULL,
  changed_by INTEGER,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);
```

7. **trade_intents** (renamed from 'intents' to avoid confusion)
```sql
CREATE TABLE trade_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL UNIQUE,
  watchlist_id INTEGER,
  user_id INTEGER NOT NULL,
  trade_mode TEXT NOT NULL,
  index_name TEXT,
  symbol TEXT NOT NULL,
  mode TEXT,
  expiry TEXT,
  strike_policy TEXT,
  offset TEXT,
  step_lots INTEGER,
  step_contracts INTEGER,
  lotsize INTEGER,
  resolved_config_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (watchlist_id) REFERENCES watchlists(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

8. **leg_state** (for risk engine)
```sql
CREATE TABLE leg_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  index_name TEXT,
  expiry TEXT,
  option_type TEXT,
  instance_id INTEGER,

  -- Position tracking
  net_qty INTEGER DEFAULT 0,
  weighted_avg_entry REAL,
  best_favorable_price REAL,
  last_trail_price REAL,

  -- Risk state
  risk_enabled BOOLEAN DEFAULT 0,
  tp_price REAL,
  sl_price REAL,
  tsl_armed BOOLEAN DEFAULT 0,
  tsl_current_stop REAL,

  -- Scope
  scope TEXT DEFAULT 'LEG',

  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (instance_id) REFERENCES instances(id),
  UNIQUE(symbol, exchange, instance_id)
);
```

9. **risk_exits** (for tracking risk-triggered exits)
```sql
CREATE TABLE risk_exits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  risk_trigger_id TEXT NOT NULL UNIQUE,
  leg_state_id INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_price REAL,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (leg_state_id) REFERENCES leg_state(id)
);
```

#### Migration Strategy:
- Create migration `011_add_settings_hierarchy.js`
- Create migration `012_add_trade_intents.js`
- Create migration `013_add_risk_engine_tables.js`
- All migrations are **additive only** - no existing tables modified

---

### Phase 2: Settings Service (New Service)

**Goal:** Implement settings precedence and merge logic

#### New Service: `settings.service.js`

**Key Methods:**
```javascript
class SettingsService {
  // Get merged effective settings
  async getEffectiveSettings({ userId, watchlistId, indexName, symbol }) {
    // Merge in order: Global → Index → Watchlist → User → Symbol
  }

  // Update global defaults
  async updateGlobalDefaults(updates, userId) { }

  // Update index profile
  async updateIndexProfile(indexName, updates, userId) { }

  // Update watchlist overrides
  async updateWatchlistOverrides(watchlistId, updates, userId) { }

  // Update user defaults
  async updateUserDefaults(userId, updates) { }

  // Update symbol overrides
  async updateSymbolOverrides(symbol, exchange, updates, userId) { }

  // Audit trail
  async logConfigChange(scope, scopeKey, changes, userId) { }
}
```

**Integration Points:**
- Used by order service before placing trades
- Exposed via new API endpoints
- Frontend can fetch effective config before showing UI

---

### Phase 3: Risk Engine Services (New Services)

**Goal:** Implement server-side risk management

#### New Service 1: `fill-aggregator.service.js`

**Responsibilities:**
- Poll orderbook/tradebook from OpenAlgo
- Maintain leg_state table (net_qty, weighted_avg_entry)
- Track best_favorable_price for TSL
- Update position aggregates

**Key Methods:**
```javascript
class FillAggregatorService {
  async syncFills(instanceId) {
    // Poll tradebook
    // Update leg_state
    // Calculate weighted average entry
    // Update best_favorable_price
  }

  async getLegState(symbol, exchange, instanceId) { }

  async updateLegState(legId, updates) { }
}
```

#### New Service 2: `quote-router.service.js`

**Responsibilities:**
- Fetch quotes from OpenAlgo
- Route quotes to appropriate legs
- Determine correct price (option premium vs underlying)

**Key Methods:**
```javascript
class QuoteRouterService {
  async fetchQuotes(symbols) {
    // Batch fetch from OpenAlgo
  }

  async getQuoteForLeg(symbol, exchange, mode) {
    // Return option premium for OPTIONS mode
    // Return underlying price for FUTURES mode
  }
}
```

#### New Service 3: `risk-engine.service.js`

**Responsibilities:**
- Enforce TP/SL/TSL per unit
- Arm and trail TSL
- Fire market exits when thresholds hit
- Handle scope-based exits (LEG/TYPE/INDEX)

**Key Methods:**
```javascript
class RiskEngineService {
  async checkRiskLevels(legStateId) {
    // Get leg state
    // Get current quote
    // Check TP/SL thresholds
    // Check TSL arming
    // Update TSL trailing
    // Fire exit if needed
  }

  async armTSL(legStateId, currentPrice) { }

  async trailTSL(legStateId, currentPrice) { }

  async fireRiskExit(legStateId, triggerType, triggerPrice) {
    // Create risk_trigger_id
    // Send market exit to all instances
    // Log to risk_exits table
  }

  async handleScopeExit(scope, indexName, expiry, optionType) {
    // Exit multiple legs based on scope
  }
}
```

---

### Phase 4: Enhanced Order Service (Modify Existing)

**Goal:** Add intent tracking, symbol resolution, pyramiding

#### Modifications to `order.service.js`:

**New Methods:**
```javascript
class OrderService {
  // Create trade intent with resolved config snapshot
  async createTradeIntent(params, userId) {
    const effectiveConfig = await settingsService.getEffectiveSettings(params);
    const intent = {
      intent_id: generateUUID(),
      ...params,
      resolved_config_json: JSON.stringify(effectiveConfig)
    };
    await db.run('INSERT INTO trade_intents ...');
    return intent;
  }

  // Resolve option symbol using OptionSymbol API
  async resolveOptionSymbol(indexName, expiry, optionType, strike, offset) {
    // Call OpenAlgo OptionSymbol API
    // Return { symbol, lotsize, tick_size }
  }

  // Calculate target position based on button action
  async calculateTarget(currentPosition, action, stepSize, mode) {
    // BUY: current + step
    // SELL: current - step
    // EXIT: 0
    // Handle ANCHOR_OFS vs FLOAT_OFS
  }

  // Handle pyramiding (reanchor mode)
  async handlePyramiding(legStateId, newFill) {
    // Recalculate weighted average entry
    // Reset TP/SL/TSL based on new entry
  }
}
```

**Integration:**
- Create intent before placing order
- Resolve symbols on server (instances never re-resolve)
- Calculate delta (target - current) before sending to instances
- Store intent_id with order

---

### Phase 5: API Endpoints (New Routes)

**Goal:** Expose settings and enhanced trading endpoints

#### New Routes: `settings.routes.js`

```javascript
GET    /api/v1/settings/effective?user_id&watchlist_id&index&symbol
PATCH  /api/v1/settings/global
PATCH  /api/v1/settings/index/:indexName
PATCH  /api/v1/settings/watchlist/:watchlistId
PATCH  /api/v1/settings/user/:userId
PATCH  /api/v1/settings/symbol/:symbol
GET    /api/v1/settings/audit
```

#### Enhanced Routes: `orders.routes.js`

```javascript
POST   /api/v1/orders/quick-order
  - Create trade intent
  - Resolve symbols
  - Calculate targets
  - Get effective settings
  - Place orders with deltas
  - Return intent_id

GET    /api/v1/orders/intent/:intentId
  - Get intent with resolved config

POST   /api/v1/orders/risk-exit
  - Manual risk exit trigger
```

---

### Phase 6: Frontend Enhancements (Modify Existing)

**Goal:** Add settings UI, runtime overrides, per-click config

#### Modifications to `quick-order.js`:

**New Features:**
```javascript
class QuickOrderHandler {
  // Show risk panel before order
  async showRiskPanel(symbolId) {
    // Fetch effective settings
    // Show TP/SL/TSL inputs
    // Option to "Use Once" or "Save as Default"
  }

  // Save runtime overrides
  async saveRuntimeOverride(scope, scopeKey, overrides) {
    // POST to settings API
  }

  // Show strike policy selector
  renderStrikePolicy(symbolId) {
    // FLOAT_OFS vs ANCHOR_OFS toggle
  }
}
```

#### New UI: `settings.html` + `settings.js`

**Settings Management Page:**
- Global Defaults tab
- Index Profiles tab (NIFTY, BANKNIFTY, etc.)
- Watchlist Overrides tab
- User Defaults tab
- Symbol Overrides tab
- Audit Log viewer

---

### Phase 7: Background Services (New Services)

**Goal:** Continuous risk monitoring and fill tracking

#### New Service: `polling.service.js` enhancements

**Add Risk Polling:**
```javascript
class PollingService {
  // Existing instance polling (15s)
  startInstancePolling() { }

  // NEW: Fill aggregator polling (2s)
  startFillPolling() {
    setInterval(async () => {
      const instances = await getActiveInstances();
      for (const instance of instances) {
        await fillAggregator.syncFills(instance.id);
      }
    }, 2000);
  }

  // NEW: Risk engine polling (1s)
  startRiskPolling() {
    setInterval(async () => {
      const activeLegs = await getLegStatesWithRisk();
      for (const leg of activeLegs) {
        await riskEngine.checkRiskLevels(leg.id);
      }
    }, 1000);
  }

  // NEW: Quote routing polling (200ms)
  startQuotePolling() {
    setInterval(async () => {
      const symbols = await getActiveSymbols();
      await quoteRouter.fetchQuotes(symbols);
    }, 200);
  }
}
```

---

## Risk Assessment & Compatibility

### ✅ Low Risk (Non-Breaking Changes)

1. **New Database Tables**
   - All new tables, no modifications to existing
   - Foreign keys use ON DELETE CASCADE safely
   - Existing code unaffected

2. **New Services**
   - settings.service.js - completely new
   - fill-aggregator.service.js - completely new
   - quote-router.service.js - completely new
   - risk-engine.service.js - completely new
   - No conflicts with existing services

3. **New API Endpoints**
   - All under /settings/* namespace
   - No modifications to existing endpoints
   - Backward compatible

### ⚠️ Medium Risk (Requires Testing)

1. **Order Service Modifications**
   - Adding intent creation before order placement
   - Need to ensure existing order flow still works
   - Add feature flags to enable/disable new behavior

2. **Frontend Quick Order Modifications**
   - Adding risk panel UI
   - Need to ensure existing trade buttons still work
   - Make risk panel optional/collapsible

3. **Polling Service Extensions**
   - Adding new polling intervals
   - May increase load on server/OpenAlgo
   - Need performance monitoring

### ❌ High Risk (Needs Careful Implementation)

1. **Symbol Resolution on Server**
   - Moving resolution from client to server
   - Instances must never re-resolve
   - Critical for ANCHOR_OFS strike policy

2. **Delta Calculation**
   - Server must calculate exact delta
   - Instances execute delta only
   - Failure could cause position stacking

3. **Risk Engine Exits**
   - Automatic market exits on threshold breach
   - Need kill switch for emergencies
   - Must be idempotent (one exit per trigger)

---

## Feature Flags Strategy

**Gradual Rollout with Feature Toggles:**

```javascript
// config.js
export const FEATURE_FLAGS = {
  ENABLE_SETTINGS_HIERARCHY: false,     // Phase 2
  ENABLE_TRADE_INTENTS: false,          // Phase 4
  ENABLE_SERVER_RESOLUTION: false,      // Phase 4
  ENABLE_DELTA_CALCULATION: false,      // Phase 4
  ENABLE_RISK_ENGINE: false,            // Phase 3
  ENABLE_FILL_AGGREGATOR: false,        // Phase 3
  ENABLE_TSL_TRAILING: false,           // Phase 3
  ENABLE_PYRAMIDING: false,             // Phase 4
  ENABLE_SCOPE_EXITS: false,            // Phase 3
};
```

**Benefits:**
- Deploy code without activating features
- Test in production with limited users
- Rollback instantly if issues arise
- Gradual validation of each component

---

## Implementation Phases Timeline

### Phase 1: Database (Week 1)
- Create all new tables via migrations
- Seed global_defaults with sensible defaults
- Seed index_profiles for NIFTY, BANKNIFTY, FINNIFTY, SENSEX
- **Risk:** Low - No code changes, only schema additions

### Phase 2: Settings Service (Week 2)
- Implement settings.service.js
- Add settings API endpoints
- Build Settings UI page
- **Risk:** Low - New functionality, existing code unaffected

### Phase 3: Risk Engine (Week 3-4)
- Implement fill-aggregator.service.js
- Implement quote-router.service.js
- Implement risk-engine.service.js
- Add background polling for fills/risk
- **Risk:** Medium - New background processes, needs monitoring

### Phase 4: Enhanced Orders (Week 5-6)
- Add intent creation to order service
- Add server-side symbol resolution
- Add delta calculation
- Add pyramiding support
- **Risk:** High - Modifies core order flow, needs extensive testing

### Phase 5: Frontend Integration (Week 7)
- Add risk panel to quick-order.js
- Add strike policy selector
- Add runtime overrides UI
- Integrate with settings API
- **Risk:** Medium - UI changes, existing flows must work

### Phase 6: Testing & Validation (Week 8)
- QA all scenarios from spec
- Test with real broker (paper trading)
- Validate non-accumulation
- Test TSL arming/trailing
- Test scope exits
- **Risk:** Critical - Must validate before production

---

## Testing Strategy

### Unit Tests
- Settings merge logic (precedence order)
- Delta calculation (BUY/SELL/EXIT)
- TSL arming/trailing math
- Weighted average entry calculation

### Integration Tests
- Order placement with intents
- Symbol resolution flow
- Risk exit firing
- Fill aggregation from tradebook

### E2E Tests (Playwright)
- Complete trade flow (UI → Server → Instances)
- Settings changes propagating to trades
- Runtime overrides working
- Risk exits triggered correctly

### Manual QA Checklist (from Spec)
- ✅ Buttons always set targets, no stacking
- ✅ Symbols resolved deterministically
- ✅ TP/SL/TSL in per-unit points
- ✅ TSL arms, trails, respects breakeven
- ✅ CLOSE_ALL/EXIT_ALL flatten correctly
- ✅ Duplicate clicks debounced
- ✅ Risk exits are idempotent
- ✅ Restart-safe (rebuild from tradebook)

---

## Rollback Plan

### If Issues Arise:

1. **Immediate Actions:**
   - Disable feature flags via config
   - Restart server to clear polling services
   - Revert to previous deployment

2. **Database Rollback:**
   - Run migration down scripts
   - Restore from backup if needed
   - Existing functionality unaffected (new tables only)

3. **Partial Rollback:**
   - Can disable individual features via flags
   - Keep settings system, disable risk engine
   - Keep intents, disable server resolution

---

## Migration Path for Existing Data

### Existing watchlist_symbols Fields:

**Current Fields:**
- `target_type`, `target_value` → Map to new TP per-unit
- `sl_type`, `sl_value` → Map to new SL per-unit
- `ts_type`, `ts_value` → Map to new TSL config

**Migration Script:**
```javascript
// One-time migration to populate symbol_overrides from watchlist_symbols
async function migrateExistingRisk() {
  const symbols = await db.all('SELECT * FROM watchlist_symbols WHERE target_value IS NOT NULL');
  for (const sym of symbols) {
    // Create symbol_override if risk configured
    if (sym.target_type === 'POINTS') {
      await createSymbolOverride(sym.symbol, {
        tp_per_unit: sym.target_value,
        sl_per_unit: sym.sl_value
      });
    }
  }
}
```

---

## Performance Considerations

### Database Query Optimization:
- Add indexes on leg_state(symbol, exchange, instance_id)
- Add indexes on trade_intents(intent_id)
- Add indexes on risk_exits(risk_trigger_id)

### Polling Frequency Tuning:
- Quote polling: 200ms (5 req/sec per instance)
- Fill polling: 2s (conservative, can tune based on load)
- Risk polling: 1s (critical for exits)
- Instance polling: 15s (existing, unchanged)

### Caching Strategy:
- Cache effective settings for 30-60s (reduce DB hits)
- Cache instrument data (existing instruments cache)
- Cache quotes in memory (quote-router service)

---

## Security Considerations

### Settings Permissions:
- **Global/Index/Watchlist**: Admin only
- **User**: Self-service (user can edit own defaults)
- **Symbol**: Admin or assigned users
- **Audit**: All changes logged with user ID

### Risk Engine Safety:
- Emergency kill switch (disable all risk exits)
- Manual override capability
- Alert on frequent risk exits (possible config error)
- Rate limiting on API endpoints

---

## Monitoring & Observability

### New Metrics to Track:
- Settings API response times
- Risk engine check latency
- Fill aggregator lag
- Quote router update frequency
- Intent creation rate
- Risk exit count (per hour)

### Alerts to Configure:
- Risk engine stopped polling (critical)
- Fill aggregator errors (warning)
- Symbol resolution failures (warning)
- High risk exit rate (anomaly detection)

---

## Documentation Updates Needed

1. **API Documentation**
   - Settings endpoints
   - Enhanced order endpoints
   - Intent schema

2. **User Guide**
   - Settings hierarchy explanation
   - Per-unit risk configuration
   - Strike policies (FLOAT_OFS vs ANCHOR_OFS)
   - Scope-based exits

3. **Developer Guide**
   - Risk engine architecture
   - Adding new index profiles
   - Testing risk scenarios

---

## Conclusion

### Feasibility: ✅ IMPLEMENTABLE

The Watchlist Trading Spec v3 can be implemented incrementally without breaking existing functionality by:

1. **Adding new tables** instead of modifying existing schema
2. **Creating new services** alongside existing services
3. **Using feature flags** to control rollout
4. **Maintaining backward compatibility** at all layers

### Recommended Approach:

**Start Small:**
- Phase 1-2 first (Database + Settings)
- Validate settings precedence works correctly
- Build confidence before touching order flow

**Parallel Development:**
- Risk engine can be built independently
- Settings system can be tested in isolation
- Frontend changes are mostly additive

**Safety First:**
- Feature flags everywhere
- Extensive testing before enabling
- Rollback plan ready
- Emergency kill switches

### Timeline: 8 weeks for full implementation

### Next Steps:
1. Review and approve this analysis
2. Create Phase 1 migration (database schema)
3. Set up feature flag configuration
4. Begin settings service implementation
5. Write comprehensive tests

---

**Author:** Claude Code
**Reviewed By:** [Pending]
**Approved By:** [Pending]
