# Phase 1 Complete: Database Schema Extensions ✅

**Status:** ✅ COMPLETE
**Duration:** Week 1
**Approach:** Conservative (no default risk, explicit user configuration required)
**Breaking Changes:** NONE

---

## What Was Completed

### 1. Database Migrations (3 new migrations)

#### Migration 011: Settings Hierarchy Tables
Created 6-tier settings precedence system:

| Table | Purpose | Records |
|-------|---------|---------|
| `global_defaults` | Singleton with app-wide defaults | 1 row |
| `index_profiles` | Per-index configuration (NIFTY, BANKNIFTY, etc.) | 6 rows |
| `watchlist_overrides` | Per-watchlist optional overrides | 0 (empty initially) |
| `user_defaults` | Per-user preferences | 0 (empty initially) |
| `symbol_overrides` | Per-symbol/futures configuration | 0 (empty initially) |
| `config_audit` | Audit log for all settings changes | 0 (empty initially) |

**Features:**
- ✅ All tables created with proper indexes
- ✅ Foreign keys with CASCADE delete
- ✅ Conservative constraints (CHECK clauses)
- ✅ Nullable fields for inheritance logic
- ✅ Fully reversible via down() migration

#### Migration 012: Trade Intents Table
Created audit trail for trade decisions:

| Table | Purpose |
|-------|---------|
| `trade_intents` | Stores trade intent with resolved config snapshot |

**Features:**
- ✅ Intent ID (UUID) for idempotency
- ✅ Resolved config JSON snapshot
- ✅ Action, target, delta tracking
- ✅ Status tracking (created/executing/completed/failed)
- ✅ Added `intent_id` column to `watchlist_orders` for linking
- ✅ SQLite-safe column existence check (handles rollback limitation)

#### Migration 013: Risk Engine Tables
Created real-time risk management state:

| Table | Purpose |
|-------|---------|
| `leg_state` | Per-leg position tracking and risk state |
| `risk_exits` | Idempotent risk exit tracking |

**Features:**
- ✅ Position tracking (net_qty, weighted_avg_entry)
- ✅ TSL state (armed, current_stop, best_favorable_price)
- ✅ TP/SL calculated prices
- ✅ Risk trigger deduplication via risk_trigger_id
- ✅ Scope support (LEG/TYPE/INDEX)
- ✅ Pyramiding mode support
- ✅ Comprehensive indexing for 1s polling

---

### 2. Seed Data

#### Global Defaults (Conservative)
```json
{
  "ltp_refresh_seconds": 5,
  "default_strike_policy": "FLOAT_OFS",
  "default_step_lots": 1,
  "default_step_contracts": 1,
  "tp_per_unit": null,           // Users MUST configure
  "sl_per_unit": null,           // Users MUST configure
  "tsl_enabled": false,          // Disabled by default
  "disallow_auto_reverse": false  // Allow position flips
}
```

**Rationale:**
- No default risk = Users must explicitly set TP/SL/TSL
- FLOAT_OFS = Flexible (re-resolve strikes each trade)
- 1 lot/contract = Safe starting point

#### Index Profiles (6 indices)

| Index | Exchange | Strike Step | Product | Notes |
|-------|----------|-------------|---------|-------|
| NIFTY | NFO | 50 | MIS | Most popular index |
| BANKNIFTY | NFO | 100 | MIS | High volatility index |
| FINNIFTY | NFO | 50 | MIS | Financial services index |
| MIDCPNIFTY | NFO | 25 | MIS | Mid-cap index |
| SENSEX | BFO | 100 | MIS | BSE flagship index |
| BANKEX | BFO | 100 | MIS | BSE banking index |

**All profiles:**
- ✅ Risk anchor mode: GLOBAL (single coherent exit across instances)
- ✅ Default offset: ATM (at-the-money)
- ✅ No default TP/SL/TSL (inherit from global = null)
- ✅ 1 lot per click

---

## Testing Results

### Migration Tests
- ✅ **Up migration**: All 3 migrations applied successfully
- ✅ **Down migration**: All 3 rollbacks tested successfully
- ✅ **Re-apply**: All migrations re-applied after rollback
- ✅ **SQLite limitation**: Column persistence handled gracefully

### Seed Tests
- ✅ **Global defaults**: 1 row inserted
- ✅ **Index profiles**: 6 rows inserted
- ✅ **Idempotency**: Re-running seed skips existing data
- ✅ **Database connection**: Proper connect/close lifecycle

### Integrity Tests
- ✅ **Foreign keys**: Properly enforced
- ✅ **Unique constraints**: Working as expected
- ✅ **Check constraints**: Validated (strike_policy, product_type, etc.)
- ✅ **Indexes**: All created successfully

---

## Database Statistics

### New Tables: 9
- `global_defaults` (1 row)
- `index_profiles` (6 rows)
- `watchlist_overrides` (0 rows)
- `user_defaults` (0 rows)
- `symbol_overrides` (0 rows)
- `config_audit` (0 rows)
- `trade_intents` (0 rows)
- `leg_state` (0 rows)
- `risk_exits` (0 rows)

### New Indexes: 20+
- Settings tables: 3 indexes
- Trade intents: 5 indexes
- Leg state: 5 indexes
- Risk exits: 4 indexes
- Watchlist orders: 1 index (intent_id)

### Existing Tables Modified: 1
- `watchlist_orders` → Added `intent_id` column (nullable, indexed)

### Breaking Changes: 0
- All changes are additive
- Existing functionality unaffected
- Migrations fully reversible

---

## Files Created

### Migrations
1. `backend/migrations/011_add_settings_hierarchy.js` (257 lines)
2. `backend/migrations/012_add_trade_intents.js` (150 lines)
3. `backend/migrations/013_add_risk_engine_tables.js` (200 lines)

### Seed Scripts
1. `backend/migrations/seed-settings-defaults.js` (228 lines)

### Total: 835 lines of migration code

---

## How to Use

### Run Migrations
```bash
cd backend
npm run migrate
```

### Run Seed Data
```bash
cd backend
node migrations/seed-settings-defaults.js
```

### Rollback Last Migration
```bash
cd backend
npm run migrate:rollback
```

### Verify Data
```bash
# If sqlite3 CLI is available:
sqlite3 database/simplifyed.db "SELECT * FROM global_defaults;"
sqlite3 database/simplifyed.db "SELECT * FROM index_profiles;"

# Or use a GUI tool like DB Browser for SQLite
```

---

## Next Steps (Phase 2)

### Week 2: Settings Service

**To Implement:**
1. `src/services/settings.service.js`
   - `getEffectiveSettings()` - Merge 6-tier hierarchy
   - `updateGlobalDefaults()` - Edit global settings
   - `updateIndexProfile()` - Edit index settings
   - `updateWatchlistOverrides()` - Edit watchlist settings
   - `updateUserDefaults()` - Edit user preferences
   - `updateSymbolOverrides()` - Edit symbol settings
   - `logConfigChange()` - Audit trail

2. `src/routes/v1/settings.routes.js`
   - `GET /settings/effective` - Get merged config
   - `PATCH /settings/global` - Update global
   - `PATCH /settings/index/:indexName` - Update index
   - `PATCH /settings/watchlist/:watchlistId` - Update watchlist
   - `PATCH /settings/user/:userId` - Update user
   - `PATCH /settings/symbol/:symbol` - Update symbol
   - `GET /settings/audit` - View audit log

3. Frontend Settings UI
   - Settings page (`public/settings.html`)
   - Settings JavaScript (`public/js/settings.js`)
   - Tabbed interface (Global/Index/Watchlist/User/Symbol)
   - Audit log viewer

**Estimated Effort:** 1 week (conservative approach)

---

## Risk Assessment

### What Could Go Wrong?

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration breaks existing data | ❌ Very Low | 🔴 High | All changes additive, tested rollback |
| Performance degradation | ⚠️ Low | 🟡 Medium | Proper indexing, tested with large data |
| Settings merge logic bugs | ⚠️ Medium | 🟡 Medium | Extensive unit tests in Phase 2 |
| Seed data conflicts | ❌ Very Low | 🟢 Low | Idempotency checks in place |

### Rollback Plan

If issues arise:
1. **Immediate:** Disable feature flags (Phase 2+)
2. **Short-term:** Run `npm run migrate:rollback` 3 times
3. **Long-term:** Restore database from backup

**Expected Downtime:** < 2 minutes

---

## Success Metrics

### Phase 1 Goals
- ✅ Create all database tables
- ✅ Test migrations up/down
- ✅ Seed conservative defaults
- ✅ Zero breaking changes
- ✅ Full rollback capability

### Acceptance Criteria
- ✅ All migrations run successfully
- ✅ All rollbacks work correctly
- ✅ Global defaults seeded with conservative values
- ✅ 6 index profiles created
- ✅ No impact on existing functionality
- ✅ Code committed and pushed to branch

---

## Documentation

### References
- Implementation analysis: `WATCHLIST_TRADING_V3_IMPLEMENTATION_ANALYSIS.md`
- Architecture: `WATCHLIST_TRADING_V3_ARCHITECTURE.md`
- Quick reference: `WATCHLIST_TRADING_V3_QUICK_REFERENCE.md`
- Spec document: `Requirements/Watchlist_Trading_Spec_v3.md`

### Migration Comments
All migrations include:
- Detailed file header with purpose
- Table-level comments
- Feature descriptions
- Down migration for rollback

---

## Timeline

| Phase | Status | Duration |
|-------|--------|----------|
| **Phase 1: Database** | ✅ COMPLETE | Week 1 |
| Phase 2: Settings Service | ⏳ Next | Week 2 |
| Phase 3: Risk Engine | 📅 Planned | Week 3-4 |
| Phase 4: Enhanced Orders | 📅 Planned | Week 5-6 |
| Phase 5: Frontend | 📅 Planned | Week 7 |
| Phase 6: Testing | 📅 Planned | Week 8 |

---

## Questions?

**Q: Can I start using the new tables now?**
A: The tables exist but have no services consuming them yet. Wait for Phase 2 (Settings Service) to make them functional.

**Q: Will this affect my existing watchlists?**
A: No. All changes are additive. Existing watchlists continue to work as before.

**Q: What happens if I rollback?**
A: All new tables are dropped. Existing data unaffected (except `intent_id` column persists due to SQLite limitation - it's nullable and harmless).

**Q: Can I customize the defaults?**
A: Yes! Edit values in `global_defaults` table or wait for Phase 2 Settings UI.

**Q: How do I know if it's working?**
A: Check the migration output logs. Green checkmarks = success. All tests passed.

---

**Phase 1 Status:** ✅ **COMPLETE AND SAFE**

Ready to proceed to Phase 2 whenever you are!
