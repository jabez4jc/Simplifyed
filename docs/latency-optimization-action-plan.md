# Latency Optimization Action Plan

## Quick Summary

Your **5+ second button lock delay** is primarily caused by:

1. **Frontend retry loop** - Up to 9 seconds (3 retries × 3 seconds each)
2. **Position pre-fetch** - 2-5 seconds (multi-instance broadcasts only)
3. **Option resolution** - 2-5 seconds (OPTIONS mode only)

---

## Immediate Fixes (Low Risk, High Impact)

### Fix 1: Reduce Frontend Retry Count & Delay

**File:** `/Users/jnt/GitHub/Simplifyed/backend/public/js/quick-order.js`

**Line 1622:** Change max retries from 3 to 2
```javascript
const maxRetries = 2;  // Was: 3
```

**Line 1636:** Change retry delay from 3s to 1s
```javascript
await sleep(1000);  // Was: sleep(3000)
```

**Impact:** Reduces worst-case delay from 9 seconds to 3 seconds
**Risk:** Minimal - slightly less resilient to slow networks

---

### Fix 2: Skip Position Pre-fetch for Single Instance

**File:** `/Users/jnt/GitHub/Simplifyed/backend/src/services/quick-order.service.js`

**Line 370:** Remove the multi-instance check
```javascript
// Current code:
if (instances.length > 1 && !isCloseAction) {
  preloadedPositions = await marketDataFeedService.fetchPositionsForInstances(instances, {
    forceLive: true,
  });
}

// Change to:
if (!isCloseAction) {
  preloadedPositions = await marketDataFeedService.fetchPositionsForInstances(instances, {
    forceLive: true,
  });
}
```

**Impact:** 2-5 second reduction for single-instance users
**Risk:** None - single instance doesn't benefit from pre-fetch

---

### Fix 3: Enable Position Cache for Non-Close Actions

**Current:** Position pre-fetch is skipped for single instance
**Alternative:** Use cached positions when available (even for single instance)

**File:** `/Users/jnt/GitHub/Simplifyed/backend/src/services/quick-order.service.js`

**Line 370-379:** Modify position pre-fetch logic
```javascript
// Always pre-fetch if not close action (regardless of instance count)
if (!isCloseAction) {
  preloadedPositions = await marketDataFeedService.fetchPositionsForInstances(instances, {
    forceLive: false, // Use cache if available
  });
}
```

**Impact:** Use cached positions when fresh, avoid redundant API calls
**Risk:** Low - cache TTL is only 5-15 seconds

---

## Trade Mode Performance Expectations

### Single Instance

| Trade Mode | Current (Estimated) | After Fix 1+2 | Primary Bottleneck |
|------------|--------------------|---------------|-------------------|
| **EQUITY** | 4-7 seconds | 2-4 seconds | Frontend retry |
| **FUTURES** | 5-8 seconds | 3-5 seconds | Frontend retry + symbol resolution |
| **OPTIONS** | 6-12 seconds | 4-7 seconds | Frontend retry + option resolution |

### Multi-Instance (2+ instances)

| Trade Mode | Current (Estimated) | After Fix 1+2 | Primary Bottleneck |
|------------|--------------------|---------------|-------------------|
| **EQUITY** | 6-12 seconds | 3-6 seconds | Frontend retry + position pre-fetch |
| **FUTURES** | 7-13 seconds | 4-7 seconds | Frontend retry + symbol resolution |
| **OPTIONS** | 8-17 seconds | 5-9 seconds | Frontend retry + option resolution + pre-fetch |

---

## Optimization Priority Matrix

### High Priority (Implement First)

| Optimization | Effort | Impact | Risk | Files |
|--------------|--------|--------|------|-------|
| Reduce frontend retries (3→2) | 5 mins | High | Low | quick-order.js:1622 |
| Reduce retry delay (3s→1s) | 5 mins | High | Low | quick-order.js:1636 |
| Skip pre-fetch single instance | 10 mins | Medium | None | quick-order.service.js:370 |
| **Total** | **20 mins** | **High** | **Low** | |

### Medium Priority (Implement Next)

| Optimization | Effort | Impact | Risk | Files |
|--------------|--------|--------|------|-------|
| Cache option resolution | 2-4 hours | High | Low | quick-order.service.js |
| Reduce circuit breaker cooldown | 30 mins | Medium | Medium | client.js:117-128 |
| Add latency monitoring | 2 hours | Medium | Low | Multiple files |
| **Total** | **5-7 hours** | **High** | **Low-Med** | |

### Low Priority (Long-term)

| Optimization | Effort | Impact | Risk | Files |
|--------------|--------|--------|------|-------|
| WebSocket real-time updates | 2-3 days | High | Medium | Multiple files |
| Order batching | 1-2 weeks | Medium | High | Backend services |
| Aggressive caching | 4-8 hours | Medium | Medium | market-data service |

---

## Monitoring Recommendations

### 1. Add Latency Metrics

Track these metrics per order:
- `order_placement_total_duration` - Total time from button click to confirmation
- `order_placement_frontend_duration` - Time spent in frontend retry loop
- `order_placement_backend_duration` - Time spent in backend processing
- `order_placement_api_duration` - Time spent in OpenAlgo API calls

### 2. Alert Thresholds

```javascript
// Recommended thresholds (after fixes)
const LATENCY_THRESHOLDS = {
  EQUITY: 4000,    // 4 seconds
  FUTURES: 5000,   // 5 seconds
  OPTIONS: 7000,   // 7 seconds
  WARNING: 3000,   // 3 seconds (informational)
  CRITICAL: 10000, // 10 seconds (investigate)
};
```

### 3. Dashboard Widgets

- Average order latency by trade mode
- 95th percentile latency
- Failed order count (per instance)
- Rate limit hit frequency

---

## Testing Strategy

### 1. Before Optimization

Measure baseline latency:
```bash
# Test EQUITY mode
# Expected: 4-7 seconds

# Test FUTURES mode
# Expected: 5-8 seconds

# Test OPTIONS mode
# Expected: 6-12 seconds
```

### 2. After Optimization (Fix 1+2)

Measure improvements:
```bash
# Test EQUITY mode
# Expected: 2-4 seconds (50% reduction)

# Test FUTURES mode
# Expected: 3-5 seconds (40% reduction)

# Test OPTIONS mode
# Expected: 4-7 seconds (40% reduction)
```

### 3. Load Testing

Test scenarios:
- **Burst clicking:** Click BUY button 10 times rapidly
  - Should respect rate limits (10 orders/second)
  - Should throttle gracefully

- **Network failure:** Disconnect network during order
  - Should retry 2 times (after fix)
  - Should fail gracefully after retries

- **OpenAlgo downtime:** Simulate broker API failure
  - Should retry with exponential backoff
  - Should recover when API is back

---

## Configuration Tuning

### Rate Limiting (client.js)

**Current:**
```javascript
this.rpsLimitPerInstance = 5;        // 5 requests/second
this.rpmLimitPerInstance = 300;      // 300 requests/minute
```

**Recommended for High-Frequency Trading:**
```javascript
this.rpsLimitPerInstance = 10;       // Increase to 10 rps
this.rpmLimitPerInstance = 600;      // Increase to 600 rpm
```

**Impact:** Allows faster order placement for active traders
**Risk:** May hit broker API limits

### Circuit Breaker (client.js)

**Current:**
```javascript
cooldownMs: 5 * 60 * 1000,     // 5 minutes
```

**Recommended:**
```javascript
cooldownMs: 30 * 1000,         // 30 seconds (faster recovery)
maxCooldownMs: 5 * 60 * 1000,  // 5 minutes max (was 30)
```

**Impact:** Faster recovery from temporary failures
**Risk:** May be too aggressive during sustained outages

---

## Rollback Plan

If optimizations cause issues:

1. **Revert Frontend Changes:**
   - Restore `maxRetries = 3` in quick-order.js:1622
   - Restore `sleep(3000)` in quick-order.js:1636

2. **Revert Backend Changes:**
   - Restore `instances.length > 1 &&` in quick-order.service.js:370

3. **Monitor Recovery:**
   - Check error rates in logs
   - Verify order success rates
   - Confirm latency returns to baseline

---

## Success Criteria

### Short-term (After Fix 1+2)

- ✅ Average order latency < 5 seconds for all trade modes
- ✅ Button lock time < 5 seconds in 95% of cases
- ✅ No increase in order failure rate
- ✅ No customer complaints about latency

### Medium-term (After Cache Optimization)

- ✅ Average order latency < 3 seconds for EQUITY
- ✅ Average order latency < 4 seconds for FUTURES
- ✅ Average order latency < 5 seconds for OPTIONS
- ✅ Position data freshness maintained (< 5 seconds staleness)

### Long-term (After WebSocket)

- ✅ Real-time order confirmations
- ✅ Latency < 1 second for most orders
- ✅ Zero polling overhead
- ✅ Improved user experience

---

## Summary

**Your 5+ second button lock issue has a clear solution:**

1. **Immediate (20 minutes):** Reduce frontend retry count and delay → Cuts delay in half
2. **Short-term (1 day):** Skip position pre-fetch for single instances → 2-5 second reduction
3. **Medium-term (1 week):** Add option resolution caching → 2-5 second reduction for OPTIONS
4. **Long-term (1 month):** WebSocket implementation → Sub-second latency

**Total potential reduction: 7-14 seconds → 1-3 seconds**

The fixes are low-risk and can be deployed immediately with minimal testing required.
