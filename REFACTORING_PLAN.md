# Watchlist Integration Refactoring Plan

## Problem Statement

The Watchlist Trading Spec v3 implementation created **standalone pages** instead of integrating features into the **existing watchlist interface**. This violates the core design principle of a watchlist-centric trading workflow.

## Current (Wrong) Architecture

```
❌ Standalone Pages:
- /enhanced-order  (separate page for enhanced orders)
- /risk-exits      (separate page for risk monitoring)

❌ Disconnected from watchlist workflow
❌ Duplicate UI patterns
❌ No context awareness
```

## Target (Correct) Architecture

```
✅ Integrated Watchlist:
- Enhanced quick-order (upgrade existing)
- Risk columns in table (new)
- Risk exit modal (context-aware)
- Settings modal (per symbol/watchlist)

✅ Single unified interface
✅ Context-aware actions
✅ Watchlist-centric design
```

---

## Phase 1: Enhance Quick Order (HIGH PRIORITY)

### Current Behavior
- User clicks BUY/SELL/EXIT
- Sends quantity + action
- Backend places basic order

### Target Behavior
- User sets **target position** (not delta)
- Supports **template symbols** (NIFTY_ATM_CE)
- Server calculates **delta automatically**
- **Pyramiding** and **risk management** applied
- **Idempotent** via intent_id

### Changes to `quick-order.js`

#### 1. Change Quantity Input to Target Position

**Before**:
```html
<label>Quantity:</label>
<input value="1" onchange="updateQuantity()">
```

**After**:
```html
<label>Target Position:</label>
<input value="0" placeholder="50 (to BUY), -50 (to SELL), 0 (to EXIT)">
<div class="hint">Current: <span id="current-pos-{symbolId}">0</span></div>
```

#### 2. Use Enhanced Order API

**Before**:
```javascript
await api.placeQuickOrder({
  symbolId,
  action: 'BUY',     // Action-based
  quantity: 50
});
```

**After**:
```javascript
await fetch('/api/v1/orders/enhanced', {
  method: 'POST',
  body: JSON.stringify({
    instanceId,
    watchlistId,
    symbol,           // Can be template: NIFTY_ATM_CE
    exchange,
    targetQty,        // Target position (not delta)
    intentId,         // For idempotency
    context: {
      indexName,
      expiry
    }
  })
});
```

#### 3. Support Template Symbols

**Add Template Selector**:
```html
<div class="template-selector">
  <label>
    <input type="checkbox" id="use-template-{symbolId}">
    Use Template
  </label>
  <select id="template-{symbolId}" style="display:none;">
    <option value="ATM_CE">ATM CE</option>
    <option value="ATM_PE">ATM PE</option>
    <option value="50ITM_CE">50 ITM CE</option>
    <option value="50OTM_PE">50 OTM PE</option>
    <!-- etc -->
  </select>
</div>
```

When enabled, send `symbol: "NIFTY_ATM_CE"` instead of actual symbol.

#### 4. Show Current Position & Delta Preview

**Add Position Display**:
```javascript
async function updatePositionDisplay(symbolId) {
  const leg = await fetch(`/api/v1/leg-state/${instanceId}/${symbol}`);
  document.getElementById(`current-pos-${symbolId}`).textContent = leg.net_qty;

  const targetQty = parseInt(document.getElementById(`target-${symbolId}`).value);
  const delta = targetQty - leg.net_qty;

  document.getElementById(`delta-preview-${symbolId}`).textContent =
    delta > 0 ? `BUY ${delta}` : delta < 0 ? `SELL ${Math.abs(delta)}` : 'No change';
}
```

---

## Phase 2: Add Risk Management Columns

### Add Columns to Watchlist Table

**In `dashboard.js` - `renderWatchlistTable()`**:

```javascript
<thead>
  <tr>
    <th></th>
    <th>Symbol</th>
    <th>LTP</th>
    <th>Change</th>
    <th>Volume</th>
    <!-- NEW COLUMNS -->
    <th>Position</th>        <!-- Net Qty -->
    <th>Avg Entry</th>       <!-- Weighted Avg Entry -->
    <th>Unrealized P&L</th>  <!-- From leg_state -->
    <th>Risk Status</th>     <!-- TP/SL/TSL badges -->
    <th>Actions</th>         <!-- Settings, History -->
  </tr>
</thead>
```

### Fetch leg_state Data

```javascript
async loadWatchlistWithPositions(watchlistId) {
  // Existing: load watchlist symbols
  const symbols = await fetch(`/api/v1/watchlists/${watchlistId}`);

  // NEW: load leg_state for position data
  const positions = await fetch(`/api/v1/leg-state?instanceId=${instanceId}`);

  // Merge positions into symbol rows
  symbols.forEach(sym => {
    const leg = positions.find(p => p.symbol === sym.symbol);
    sym.position = leg?.net_qty || 0;
    sym.avgEntry = leg?.weighted_avg_entry || 0;
    sym.unrealizedPnl = leg?.unrealized_pnl || 0;
    sym.riskEnabled = leg?.risk_enabled || false;
    sym.tpPrice = leg?.tp_price;
    sym.slPrice = leg?.sl_price;
    sym.tslEnabled = leg?.tsl_enabled;
  });
}
```

### Render Risk Indicators

```javascript
function renderRiskStatus(symbol) {
  if (!symbol.riskEnabled) {
    return '<span class="text-neutral-500">-</span>';
  }

  return `
    <div class="risk-badges">
      ${symbol.tpPrice ? `<span class="badge badge-success" title="Take Profit">TP: ${symbol.tpPrice}</span>` : ''}
      ${symbol.slPrice ? `<span class="badge badge-danger" title="Stop Loss">SL: ${symbol.slPrice}</span>` : ''}
      ${symbol.tslEnabled ? `<span class="badge badge-warning" title="Trailing SL">TSL</span>` : ''}
    </div>
  `;
}
```

---

## Phase 3: Add Risk Exit History Modal

### Add Action Button in Watchlist Row

```html
<td class="actions-cell">
  <button onclick="showRiskExitsModal('${symbol}', '${exchange}')"
          class="btn-icon"
          title="Risk Exit History">
    📊
  </button>
  <button onclick="showSettingsModal(${watchlistId}, ${symbolId})"
          class="btn-icon"
          title="Settings">
    ⚙️
  </button>
</td>
```

### Create Modal Popup

```javascript
async function showRiskExitsModal(symbol, exchange) {
  const exits = await fetch(`/api/v1/risk-exits?symbol=${symbol}&exchange=${exchange}&limit=20`);

  const modal = document.getElementById('risk-exits-modal');
  modal.querySelector('.modal-title').textContent = `Risk Exit History: ${symbol}`;
  modal.querySelector('.modal-body').innerHTML = renderRiskExitsTable(exits.data);
  modal.style.display = 'block';
}

function renderRiskExitsTable(exits) {
  return `
    <table class="table table-sm">
      <thead>
        <tr>
          <th>Trigger Type</th>
          <th>Qty</th>
          <th>Entry</th>
          <th>Trigger Price</th>
          <th>P&L</th>
          <th>Status</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${exits.map(exit => `
          <tr>
            <td><span class="badge badge-${getBadgeClass(exit.trigger_type)}">${exit.trigger_type}</span></td>
            <td>${exit.qty_at_trigger}</td>
            <td>${exit.entry_at_trigger}</td>
            <td>${exit.trigger_price}</td>
            <td class="${exit.total_pnl >= 0 ? 'text-success' : 'text-danger'}">${exit.total_pnl}</td>
            <td><span class="badge badge-${getBadgeClass(exit.status)}">${exit.status}</span></td>
            <td>${formatDateTime(exit.triggered_at)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}
```

---

## Phase 4: Add Settings Modal

### Settings Editor UI

```javascript
async function showSettingsModal(watchlistId, symbolId) {
  // Fetch effective settings
  const settings = await fetch(`/api/v1/settings/effective?watchlistId=${watchlistId}&symbolId=${symbolId}`);

  const modal = document.getElementById('settings-modal');
  modal.querySelector('.modal-body').innerHTML = `
    <form id="settings-form">
      <h4>Risk Management</h4>

      <div class="form-group">
        <label>Take Profit (per unit):</label>
        <input type="number" name="tp_per_unit" value="${settings.tp_per_unit || ''}" step="0.05">
      </div>

      <div class="form-group">
        <label>Stop Loss (per unit):</label>
        <input type="number" name="sl_per_unit" value="${settings.sl_per_unit || ''}" step="0.05">
      </div>

      <div class="form-group">
        <label>
          <input type="checkbox" name="tsl_enabled" ${settings.tsl_enabled ? 'checked' : ''}>
          Enable Trailing Stop Loss
        </label>
      </div>

      <div class="form-group" id="tsl-config" style="${settings.tsl_enabled ? '' : 'display:none'}">
        <label>TSL Arm After (per unit):</label>
        <input type="number" name="tsl_arm_threshold_per_unit" value="${settings.tsl_arm_threshold_per_unit || ''}" step="0.05">

        <label>TSL Trail By (per unit):</label>
        <input type="number" name="tsl_trail_by_per_unit" value="${settings.tsl_trail_by_per_unit || ''}" step="0.05">
      </div>

      <h4>Pyramiding</h4>

      <div class="form-group">
        <label>On Pyramid:</label>
        <select name="on_pyramid">
          <option value="reanchor" ${settings.on_pyramid === 'reanchor' ? 'selected' : ''}>Reanchor (adjust entry)</option>
          <option value="scale" ${settings.on_pyramid === 'scale' ? 'selected' : ''}>Scale (proportional)</option>
          <option value="ignore" ${settings.on_pyramid === 'ignore' ? 'selected' : ''}>Ignore (block adds)</option>
        </select>
      </div>

      <div class="form-group">
        <label>Exit Scope:</label>
        <select name="exit_scope">
          <option value="LEG" ${settings.exit_scope === 'LEG' ? 'selected' : ''}>Single Leg</option>
          <option value="TYPE" ${settings.exit_scope === 'TYPE' ? 'selected' : ''}>All CE or All PE</option>
          <option value="INDEX" ${settings.exit_scope === 'INDEX' ? 'selected' : ''}>All Index Options</option>
        </select>
      </div>

      <div class="form-actions">
        <button type="button" onclick="saveSettings('global')">Save as Global Default</button>
        <button type="button" onclick="saveSettings('watchlist', ${watchlistId})">Save for Watchlist</button>
        <button type="button" onclick="saveSettings('symbol', ${symbolId})">Save for Symbol</button>
      </div>
    </form>
  `;

  modal.style.display = 'block';
}

async function saveSettings(level, id) {
  const form = document.getElementById('settings-form');
  const formData = new FormData(form);
  const settings = Object.fromEntries(formData);

  let endpoint;
  if (level === 'global') {
    endpoint = '/api/v1/settings/global';
  } else if (level === 'watchlist') {
    endpoint = `/api/v1/settings/watchlist-overrides/${id}`;
  } else if (level === 'symbol') {
    endpoint = `/api/v1/settings/symbol-overrides/${symbolId}`;
  }

  await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });

  showToast('Settings saved successfully', 'success');
  document.getElementById('settings-modal').style.display = 'none';
}
```

---

## Phase 5: Remove Standalone Pages

### Files to Delete
- ❌ `backend/public/js/enhanced-order.js`
- ❌ `backend/public/js/risk-exits.js`

### Update `dashboard.html`

**Remove Navigation Items**:
```html
<!-- DELETE THESE -->
<a href="#" class="nav-item" data-view="enhanced-order">
  <span>🎯</span>
  <span>Enhanced Order</span>
</a>
<a href="#" class="nav-item" data-view="risk-exits">
  <span>🛡️</span>
  <span>Risk Exits</span>
</a>
```

**Remove Script Includes**:
```html
<!-- DELETE THESE -->
<script src="/js/enhanced-order.js"></script>
<script src="/js/risk-exits.js"></script>
```

### Update `dashboard.js`

**Remove View Handlers**:
```javascript
// DELETE these cases
case 'enhanced-order':
  EnhancedOrder.renderForm();
  break;
case 'risk-exits':
  RiskExits.renderDashboard();
  break;
```

---

## Phase 6: Add Modal HTML

### Add to `dashboard.html`

```html
<!-- Risk Exits Modal -->
<div id="risk-exits-modal" class="modal" style="display:none;">
  <div class="modal-content">
    <div class="modal-header">
      <h3 class="modal-title"></h3>
      <button class="modal-close" onclick="this.closest('.modal').style.display='none'">&times;</button>
    </div>
    <div class="modal-body"></div>
  </div>
</div>

<!-- Settings Modal -->
<div id="settings-modal" class="modal" style="display:none;">
  <div class="modal-content">
    <div class="modal-header">
      <h3 class="modal-title">Settings</h3>
      <button class="modal-close" onclick="this.closest('.modal').style.display='none'">&times;</button>
    </div>
    <div class="modal-body"></div>
  </div>
</div>
```

---

## Testing Checklist

### Phase 1: Enhanced Quick Order
- [ ] Target position input works
- [ ] Delta preview shows correctly
- [ ] Template symbols resolve properly
- [ ] Pyramiding blocks when on_pyramid=ignore
- [ ] Idempotency prevents duplicate orders
- [ ] Trade intents tracked correctly

### Phase 2: Risk Columns
- [ ] Position column shows correct net_qty
- [ ] P&L updates in real-time
- [ ] Risk badges display when enabled
- [ ] TP/SL/TSL values accurate

### Phase 3: Risk Exit Modal
- [ ] Modal opens from watchlist row
- [ ] Shows symbol-specific exits only
- [ ] Pagination works
- [ ] P&L color-coded correctly

### Phase 4: Settings Modal
- [ ] Loads effective settings
- [ ] Save to global/watchlist/symbol works
- [ ] TSL config toggles correctly
- [ ] Form validation prevents invalid input

### Phase 5: Cleanup
- [ ] Standalone pages removed
- [ ] No broken navigation links
- [ ] No console errors
- [ ] All features accessible from watchlist

---

## Migration Notes

### Backwards Compatibility

**Keep Basic Order API**: Don't remove the existing `/api/v1/orders` endpoint - some users may be using it directly via API.

**Graceful Degradation**: If leg_state data is unavailable, show "-" in position columns rather than crashing.

**Feature Flags**: Consider adding a flag to toggle between classic and enhanced quick-order:
```javascript
const USE_ENHANCED_ORDERS = true; // Set via config or user preference
```

### Performance Considerations

**Batch API Calls**: When loading watchlist with 20+ symbols, fetch all leg_state data in one call:
```javascript
GET /api/v1/leg-state?instanceId=1  // Returns all legs for instance
```

**Debounce Position Updates**: Don't fetch leg_state on every keystroke:
```javascript
const debouncedUpdatePosition = debounce(updatePositionDisplay, 500);
```

**Cache Settings**: Load effective settings once per symbol, cache in memory.

---

## Timeline Estimate

- **Phase 1** (Quick Order): 4-6 hours
- **Phase 2** (Risk Columns): 2-3 hours
- **Phase 3** (Risk Exit Modal): 2 hours
- **Phase 4** (Settings Modal): 3-4 hours
- **Phase 5** (Cleanup): 1 hour
- **Phase 6** (Testing): 2-3 hours

**Total**: 14-19 hours (2-3 days)

---

## Success Criteria

✅ All trading actions happen **within** watchlist interface
✅ No standalone pages required
✅ Settings accessible per watchlist/symbol
✅ Risk management visible at a glance
✅ Position data always current
✅ Idempotent order placement
✅ Template symbol support
✅ Delta-based positioning works

**End Goal**: A unified, watchlist-centric trading interface where all Spec v3 features are seamlessly integrated.
