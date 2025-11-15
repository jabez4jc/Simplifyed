# Watchlist Trading Spec v3 - Quick Reference Guide

## TL;DR: Can We Implement This?

**YES ✅** - The spec can be implemented without breaking existing functionality.

**Strategy:** Incremental, additive changes with feature flags.

---

## Key Changes Summary

### What You'll Get:

1. **6-Tier Settings System**
   - Global → Index → Watchlist → User → Symbol → Per-Click
   - Admin controls global/index/watchlist
   - Users control their own defaults
   - Per-click overrides for one-off trades

2. **Server-Side Risk Management**
   - Automatic TP/SL/TSL enforcement
   - No manual monitoring needed
   - Per-unit points (survives lot-size changes)
   - Trailing stops with arming/breakeven

3. **Advanced Trading Features**
   - Strike anchoring (ANCHOR_OFS) vs floating (FLOAT_OFS)
   - Pyramiding with automatic re-anchoring
   - Scope-based exits (close all CE, all PE, or all)
   - Non-accumulation (no accidental position stacking)

4. **Position-Aware Intelligence**
   - Server calculates exact delta needed
   - Instances execute delta only
   - Intent tracking for audit trail
   - Idempotent risk exits

---

## What Changes in Your Current App?

### ✅ No Changes Needed:
- Existing watchlists keep working
- Current order placement flow unchanged (unless you enable new features)
- All existing tables remain untouched
- Frontend UI mostly unchanged (enhancements are additive)

### 🔧 Additions:
- 9 new database tables (all new, no modifications to existing)
- 4 new backend services (settings, fill-aggregator, quote-router, risk-engine)
- New settings API endpoints (/api/v1/settings/*)
- Enhanced quick-order UI (risk panel, strike policy selector)
- Background polling for fills and risk (new intervals: 1s, 2s, 200ms)

### ⚙️ Modifications:
- Order service gains intent creation (optional via feature flag)
- Polling service adds new intervals (can be disabled)
- Quick order UI adds risk panel (collapsible)

---

## Critical Success Factors

### 1. Feature Flags (Safety Net)
```javascript
// You control what's active
ENABLE_SETTINGS_HIERARCHY: false,     // Settings system
ENABLE_RISK_ENGINE: false,            // Auto TP/SL/TSL
ENABLE_SERVER_RESOLUTION: false,      // Symbol resolution on server
ENABLE_DELTA_CALCULATION: false,      // Target-based positions
```

**Deploy with all flags OFF** → Test in production → Enable gradually

### 2. Database Migrations (Additive Only)
- Migration 011: Settings tables (global_defaults, index_profiles, etc.)
- Migration 012: Trade intents
- Migration 013: Risk engine tables (leg_state, risk_exits)

**Zero impact on existing tables** - all new additions

### 3. Testing Before Enabling
- Run all QA scenarios from spec (page 15)
- Test with paper trading first
- Validate non-accumulation
- Test risk exits fire correctly

---

## Implementation Phases

### Phase 1: Database (1 week) - SAFE ✅
- Run migrations to add new tables
- Seed defaults for NIFTY/BANKNIFTY/etc
- **Impact:** None (tables unused until services built)

### Phase 2: Settings Service (1 week) - SAFE ✅
- Build settings merge logic
- Add settings API
- Build settings UI page
- **Impact:** None (optional feature, doesn't affect trading)

### Phase 3: Risk Engine (2 weeks) - MEDIUM RISK ⚠️
- Build fill aggregator (tracks positions)
- Build quote router (fetches prices)
- Build risk engine (enforces TP/SL/TSL)
- **Impact:** Only if ENABLE_RISK_ENGINE=true

### Phase 4: Enhanced Orders (2 weeks) - HIGH RISK 🔴
- Add intent creation
- Add server-side symbol resolution
- Add delta calculation
- **Impact:** Only if ENABLE_SERVER_RESOLUTION=true

### Phase 5: Frontend (1 week) - SAFE ✅
- Add risk panel to quick-order
- Add strike policy selector
- Integrate settings API
- **Impact:** UI enhancements, existing flows still work

### Phase 6: Testing (1 week) - CRITICAL 🔴
- QA all scenarios
- Paper trading validation
- Load testing
- **Impact:** Validation before production

---

## What to Do Now

### Option 1: Full Implementation (8 weeks)
Follow all phases sequentially.

**Pros:** Complete feature set
**Cons:** Long timeline, complex

### Option 2: Incremental MVP (4 weeks)
1. Database schema (Phase 1)
2. Settings service (Phase 2)
3. Basic risk engine (Phase 3, no TSL)
4. Skip server resolution (keep client-side)

**Pros:** Faster, lower risk
**Cons:** Missing advanced features

### Option 3: Settings Only (2 weeks)
1. Database schema (Phase 1)
2. Settings service (Phase 2)
3. Skip risk engine entirely

**Pros:** Easiest, safest
**Cons:** No auto risk management

---

## Key Questions to Answer

### 1. Do you need server-side risk management?
- **YES** → Implement Phase 3 (Risk Engine)
- **NO** → Skip it, keep manual risk management

### 2. Do you need settings hierarchy?
- **YES** → Implement Phase 2 (Settings Service)
- **NO** → Skip it, use global config only

### 3. Do you need strike anchoring?
- **YES** → Implement Phase 4 (Server Resolution)
- **NO** → Keep client-side resolution

### 4. Do you need pyramiding/re-anchoring?
- **YES** → Implement Phase 4 (Enhanced Orders)
- **NO** → Keep simple position tracking

---

## Risks & Mitigation

### Risk 1: Performance Degradation
**Cause:** New polling intervals (200ms, 1s, 2s)
**Mitigation:**
- Start with longer intervals (500ms, 2s, 5s)
- Monitor server load
- Tune based on actual usage

### Risk 2: Position Stacking
**Cause:** Delta calculation bug
**Mitigation:**
- Extensive testing of delta math
- Feature flag to disable
- Manual override capability

### Risk 3: Risk Exit Failures
**Cause:** Risk engine bug or API failure
**Mitigation:**
- Emergency kill switch
- Idempotency via risk_trigger_id
- Alerts on exit failures

### Risk 4: Symbol Resolution Errors
**Cause:** OpenAlgo API changes or errors
**Mitigation:**
- Fallback to client-side resolution
- Cache resolved symbols
- Validate before sending to instances

---

## Performance Impact Estimate

### Database:
- **New Tables:** 9 (minimal impact, well-indexed)
- **Query Frequency:** +50 queries/sec (settings cache reduces)
- **Storage:** +10MB per 1000 trades

### API:
- **New Endpoints:** 7 (/settings/*)
- **Request Rate:** +5 req/sec (mostly read, cacheable)

### Background Polling:
- **Quote Polling:** 200ms → 5 req/sec per instance
- **Fill Polling:** 2s → 0.5 req/sec per instance
- **Risk Polling:** 1s → 1 check/sec per active leg

**Total Load Increase:** ~20% (conservative estimate)

**Mitigation:**
- Caching (30-60s for settings)
- Batch API calls where possible
- Tune polling intervals based on actual load

---

## Breaking Change Assessment

### Database Schema: ✅ NO BREAKING CHANGES
- All new tables
- No modifications to existing tables
- Foreign keys safe (ON DELETE CASCADE)

### API Endpoints: ✅ NO BREAKING CHANGES
- All new endpoints under /settings/*
- Existing endpoints unchanged
- New optional parameters (backward compatible)

### Frontend: ✅ NO BREAKING CHANGES
- Existing UI continues to work
- New panels are additive/optional
- Trade buttons unchanged (just enhanced)

### Services: ✅ NO BREAKING CHANGES
- New services don't interfere with existing
- Order service modifications guarded by feature flags
- Polling service extensions optional

---

## Recommended Path Forward

### Week 1: Decision & Planning
- Review this analysis
- Decide which features to implement
- Set up feature flag configuration
- Plan migration schedule

### Week 2: Database
- Create Phase 1 migration
- Test migration up/down
- Seed default data
- **Deploy to production (safe, tables unused)**

### Week 3-4: Settings Service
- Implement settings.service.js
- Build settings API
- Create settings UI
- **Deploy with ENABLE_SETTINGS_HIERARCHY=false**

### Week 5: Testing
- Enable settings in staging
- Test precedence logic
- Validate UI
- **Enable in production for admins only**

### Week 6+: Risk Engine (Optional)
- Only if you need auto risk management
- Implement fill-aggregator, quote-router, risk-engine
- **Extensive testing before enabling**

---

## Emergency Rollback Procedure

### If Something Breaks:

1. **Disable Feature Flags** (instant rollback)
   ```javascript
   // config.js
   ENABLE_RISK_ENGINE: false,
   ENABLE_SERVER_RESOLUTION: false,
   ```

2. **Restart Server** (clears background polling)
   ```bash
   npm run restart
   ```

3. **Revert Deployment** (if needed)
   ```bash
   git revert <commit-hash>
   npm run deploy
   ```

4. **Database Rollback** (only if corruption)
   ```bash
   npm run migrate:rollback
   # Or restore from backup
   ```

**Expected Downtime:** < 5 minutes (feature flag toggle + restart)

---

## Success Metrics

### Phase 1-2 (Settings):
- ✅ Settings API response time < 100ms
- ✅ Zero errors in settings merge logic
- ✅ Audit log captures all changes

### Phase 3 (Risk Engine):
- ✅ Risk checks complete within 50ms
- ✅ TSL trails correctly (manual verification)
- ✅ Zero duplicate risk exits
- ✅ No false positives (exits when shouldn't)

### Phase 4 (Server Resolution):
- ✅ Symbol resolution 100% accurate
- ✅ Delta calculation matches expected
- ✅ Zero position stacking incidents

---

## Support & Resources

### Documentation:
- Full implementation analysis: `WATCHLIST_TRADING_V3_IMPLEMENTATION_ANALYSIS.md`
- Spec document: `Requirements/Watchlist_Trading_Spec_v3.md`
- OpenAlgo API: `Requirements/OpenAlgo_v1_Developer_Reference_Clean.md`

### Testing:
- QA checklist: Spec page 15
- Manual test scenarios: Spec page 15-16
- E2E tests: To be created in `e2e/watchlist-trading-v3.spec.js`

### Monitoring:
- Settings API metrics
- Risk engine polling status
- Fill aggregator lag
- Symbol resolution errors

---

## Final Recommendation

### 🎯 Recommended Approach:

1. **Start with Settings System** (Phases 1-2)
   - Low risk, high value
   - Establishes foundation for future enhancements
   - No impact on existing functionality

2. **Add Risk Engine Later** (Phase 3)
   - Only if needed for automated risk management
   - Requires more testing and validation
   - Higher complexity, higher value

3. **Skip Server Resolution** (Phase 4) initially
   - Keep client-side resolution working
   - Add later if strike anchoring needed
   - Most complex, highest risk

### Timeline:
- **Minimal:** 2 weeks (Settings only)
- **Recommended:** 4 weeks (Settings + Basic Risk)
- **Full:** 8 weeks (All features)

### Next Action:
**Decision:** Which features do you want to implement?

Choose your path, and I can help you start with Phase 1 migrations immediately.

---

**Questions? Let's discuss:**
- Which features are must-haves?
- What's your risk tolerance?
- What's your timeline?
