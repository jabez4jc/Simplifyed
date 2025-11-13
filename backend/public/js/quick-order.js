/**
 * Quick Order Handler
 * Handles watchlist row expansion and quick order placement
 */

class QuickOrderHandler {
  constructor() {
    this.expandedRows = new Set();
    this.defaultQuantities = new Map(); // symbolId -> quantity
    this.selectedTradeModes = new Map(); // symbolId -> tradeMode
    this.selectedOptionsLegs = new Map(); // symbolId -> optionsLeg
    this.selectedExpiries = new Map(); // symbolId -> expiry
    this.availableExpiries = new Map(); // symbolId -> expiry list
  }

  /**
   * Toggle row expansion for a symbol
   */
  toggleRowExpansion(watchlistId, symbolId) {
    const rowKey = `${watchlistId}_${symbolId}`;
    const expansionRow = document.getElementById(`expansion-row-${symbolId}`);
    const toggleBtn = document.querySelector(`[data-toggle-symbol="${symbolId}"]`);

    if (this.expandedRows.has(rowKey)) {
      // Collapse
      expansionRow.style.display = 'none';
      toggleBtn.textContent = '▼';
      this.expandedRows.delete(rowKey);
    } else {
      // Expand
      expansionRow.style.display = 'table-row';
      toggleBtn.textContent = '▲';
      this.expandedRows.add(rowKey);

      // Load expansion content if not already loaded
      this.loadExpansionContent(watchlistId, symbolId);
    }
  }

  /**
   * Load expansion content with trading controls
   */
  async loadExpansionContent(watchlistId, symbolId) {
    const contentDiv = document.getElementById(`expansion-content-${symbolId}`);

    // Check if already loaded
    if (contentDiv.dataset.loaded === 'true') {
      return;
    }

    try {
      // Get symbol data from the row
      const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      const symbol = symbolRow.dataset.symbol;
      const exchange = symbolRow.dataset.exchange;
      const symbolType = symbolRow.querySelector('.badge').textContent.trim();

      // Get default values
      const tradeMode = this.selectedTradeModes.get(symbolId) || this.getDefaultTradeMode(symbolType);
      const optionsLeg = this.selectedOptionsLegs.get(symbolId) || 'ATM';
      const quantity = this.defaultQuantities.get(symbolId) || 1;

      // Save defaults to Maps if not already set
      if (!this.selectedTradeModes.has(symbolId)) {
        this.selectedTradeModes.set(symbolId, tradeMode);
        console.log('[QuickOrder] Initialized tradeMode to default:', tradeMode);
      }
      if (!this.selectedOptionsLegs.has(symbolId)) {
        this.selectedOptionsLegs.set(symbolId, optionsLeg);
      }
      if (!this.defaultQuantities.has(symbolId)) {
        this.defaultQuantities.set(symbolId, quantity);
      }

      // Fetch available expiries for FUTURES/OPTIONS if needed
      let expiries = [];
      if (tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') {
        // Use NFO exchange for derivatives (futures/options)
        // INDEX and EQUITY symbols need to use NFO/BFO for their derivatives
        const derivativeExchange = this.getDerivativeExchange(exchange, symbolType);
        console.log(`[QuickOrder] Fetching expiries for symbol: ${symbol}, exchange: ${exchange} -> ${derivativeExchange}, mode: ${tradeMode}`);
        expiries = await this.fetchAvailableExpiries(symbol, derivativeExchange);
        console.log(`[QuickOrder] Received ${expiries.length} expiries:`, expiries.slice(0, 5));
        this.availableExpiries.set(symbolId, expiries);
      }

      // Get or set the selected expiry (always store in YYYY-MM-DD format)
      let selectedExpiry = this.selectedExpiries.get(symbolId);
      if (!selectedExpiry && expiries.length > 0) {
        // Use first expiry, ensure it's normalized to YYYY-MM-DD
        selectedExpiry = this.normalizeExpiryDate(expiries[0]);
        this.selectedExpiries.set(symbolId, selectedExpiry);
        console.log(`[QuickOrder] Initial expiry set: raw="${expiries[0]}" normalized="${selectedExpiry}"`);
      }
      console.log(`[QuickOrder] Selected expiry (YYYY-MM-DD format):`, selectedExpiry);

      // Render trading controls
      contentDiv.innerHTML = this.renderTradingControls({
        watchlistId,
        symbolId,
        symbol,
        exchange,
        symbolType,
        tradeMode,
        optionsLeg,
        quantity,
        expiries,
        selectedExpiry,
      });

      contentDiv.dataset.loaded = 'true';
    } catch (error) {
      contentDiv.innerHTML = `<p class="text-error text-sm">Failed to load trading controls: ${error.message}</p>`;
    }
  }

  /**
   * Get default trade mode based on symbol type
   */
  getDefaultTradeMode(symbolType) {
    const modeMap = {
      'EQUITY_ONLY': 'EQUITY',
      'EQUITY_FNO': 'EQUITY',
      'FUTURES_ONLY': 'FUTURES',
      'OPTIONS_ONLY': 'OPTIONS',
      'INDEX': 'OPTIONS',
      'UNKNOWN': 'EQUITY',
    };
    return modeMap[symbolType] || 'EQUITY';
  }

  /**
   * Render trading controls UI
   */
  renderTradingControls({ watchlistId, symbolId, symbol, exchange, symbolType, tradeMode, optionsLeg, quantity, expiries, selectedExpiry }) {
    const availableModes = this.getAvailableTradeModes(symbolType);
    const showOptionsLeg = tradeMode === 'OPTIONS';
    const showExpirySelector = (tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') && expiries && expiries.length > 0;

    console.log(`[QuickOrder] Rendering controls:`, {
      tradeMode,
      expiryCount: expiries?.length || 0,
      showExpirySelector,
      selectedExpiry
    });

    return `
      <div class="quick-order-panel">
        <!-- Left: Trade Mode and Options Leg -->
        <div class="quick-order-config">
          <div class="form-group-inline">
            <label class="form-label-sm">Trade Mode:</label>
            <div class="trade-mode-selector">
              ${availableModes.map(mode => `
                <button
                  class="btn-trade-mode ${mode === tradeMode ? 'active' : ''} ${!this.isModeAvailable(mode, symbolType) ? 'disabled' : ''}"
                  data-mode="${mode}"
                  data-symbol-id="${symbolId}"
                  onclick="console.log('[QuickOrder] Button clicked:', ${symbolId}, '${mode}'); quickOrder.selectTradeMode(${symbolId}, '${mode}'); return false;"
                  ${!this.isModeAvailable(mode, symbolType) ? 'disabled' : ''}
                  title="${this.getTradeModeTooltip(mode, symbolType)}">
                  ${mode}
                </button>
              `).join('')}
            </div>
          </div>

          ${showExpirySelector ? `
            <div class="form-group-inline">
              <label class="form-label-sm">Expiry:</label>
              <select
                class="select-expiry"
                data-symbol-id="${symbolId}"
                onchange="quickOrder.selectExpiry(${symbolId}, this.value)">
                ${expiries.map(expiry => `
                  <option value="${expiry}" ${expiry === selectedExpiry ? 'selected' : ''}>
                    ${this.formatExpiryDate(expiry)}
                  </option>
                `).join('')}
              </select>
            </div>
          ` : ''}

          ${showOptionsLeg ? `
            <div class="form-group-inline">
              <label class="form-label-sm">Options Leg:</label>
              <select
                class="select-options-leg"
                data-symbol-id="${symbolId}"
                onchange="quickOrder.selectOptionsLeg(${symbolId}, this.value)">
                <option value="ITM3" ${optionsLeg === 'ITM3' ? 'selected' : ''}>ITM 3</option>
                <option value="ITM2" ${optionsLeg === 'ITM2' ? 'selected' : ''}>ITM 2</option>
                <option value="ITM1" ${optionsLeg === 'ITM1' ? 'selected' : ''}>ITM 1</option>
                <option value="ATM" ${optionsLeg === 'ATM' ? 'selected' : ''}>ATM</option>
                <option value="OTM1" ${optionsLeg === 'OTM1' ? 'selected' : ''}>OTM 1</option>
                <option value="OTM2" ${optionsLeg === 'OTM2' ? 'selected' : ''}>OTM 2</option>
                <option value="OTM3" ${optionsLeg === 'OTM3' ? 'selected' : ''}>OTM 3</option>
              </select>
            </div>
          ` : ''}

          <div class="form-group-inline">
            <label class="form-label-sm">Quantity:</label>
            <input
              type="number"
              class="input-quantity"
              value="${quantity}"
              min="1"
              step="1"
              data-symbol-id="${symbolId}"
              onchange="quickOrder.updateQuantity(${symbolId}, parseInt(this.value))">
          </div>
        </div>

        <!-- Right: Action Buttons -->
        <div class="quick-order-actions">
          ${this.renderActionButtons(watchlistId, symbolId, symbol, exchange, tradeMode)}
        </div>
      </div>
    `;
  }

  /**
   * Render action buttons based on trade mode
   */
  renderActionButtons(watchlistId, symbolId, symbol, exchange, tradeMode) {
    if (tradeMode === 'OPTIONS') {
      return `
        <div class="action-buttons-grid">
          <button class="btn-quick-action btn-buy-ce"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY_CE')">
            BUY CE
          </button>
          <button class="btn-quick-action btn-sell-ce"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL_CE')">
            SELL CE
          </button>
          <button class="btn-quick-action btn-buy-pe"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY_PE')">
            BUY PE
          </button>
          <button class="btn-quick-action btn-sell-pe"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL_PE')">
            SELL PE
          </button>
          <button class="btn-quick-action btn-exit-all"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT_ALL')">
            EXIT ALL
          </button>
        </div>
      `;
    } else {
      // EQUITY or FUTURES mode
      return `
        <div class="action-buttons-grid simple">
          <button class="btn-quick-action btn-buy"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY')">
            BUY
          </button>
          <button class="btn-quick-action btn-sell"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL')">
            SELL
          </button>
          <button class="btn-quick-action btn-exit"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT')">
            EXIT
          </button>
        </div>
      `;
    }
  }

  /**
   * Get available trade modes based on symbol type
   */
  getAvailableTradeModes(symbolType) {
    return ['EQUITY', 'FUTURES', 'OPTIONS'];
  }

  /**
   * Check if trade mode is available for symbol type
   */
  isModeAvailable(mode, symbolType) {
    const availability = {
      'EQUITY_ONLY': ['EQUITY'],
      'EQUITY_FNO': ['EQUITY', 'FUTURES', 'OPTIONS'],
      'FUTURES_ONLY': ['FUTURES', 'OPTIONS'],
      'OPTIONS_ONLY': ['OPTIONS'],
      'INDEX': ['FUTURES', 'OPTIONS'],
      'UNKNOWN': ['EQUITY'],
    };
    return (availability[symbolType] || ['EQUITY']).includes(mode);
  }

  /**
   * Get tooltip for trade mode button
   */
  getTradeModeTooltip(mode, symbolType) {
    if (this.isModeAvailable(mode, symbolType)) {
      return `Trade ${mode.toLowerCase()}`;
    }
    return `${mode} not available for this symbol`;
  }

  /**
   * Select trade mode
   */
  selectTradeMode(symbolId, mode) {
    console.log('[QuickOrder] selectTradeMode called:', { symbolId, mode });
    this.selectedTradeModes.set(symbolId, mode);
    console.log('[QuickOrder] Map after setting:', Array.from(this.selectedTradeModes.entries()));

    // Reload expansion content
    const expansionContent = document.getElementById(`expansion-content-${symbolId}`);
    expansionContent.dataset.loaded = 'false';

    // Find watchlist ID from the row
    const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
    const watchlistId = parseInt(symbolRow.closest('[id^="watchlist-table-"]').id.split('-')[2]);

    this.loadExpansionContent(watchlistId, symbolId);
  }

  /**
   * Select options leg
   */
  selectOptionsLeg(symbolId, leg) {
    this.selectedOptionsLegs.set(symbolId, leg);
  }

  /**
   * Select expiry date
   */
  selectExpiry(symbolId, expiry) {
    // Ensure expiry is always stored in YYYY-MM-DD format (API format)
    const normalizedExpiry = this.normalizeExpiryDate(expiry);
    console.log(`[QuickOrder] selectExpiry: raw="${expiry}" normalized="${normalizedExpiry}"`);
    this.selectedExpiries.set(symbolId, normalizedExpiry);
  }

  /**
   * Update quantity
   */
  updateQuantity(symbolId, quantity) {
    this.defaultQuantities.set(symbolId, quantity);
  }

  /**
   * Fetch available expiries for a symbol
   */
  async fetchAvailableExpiries(symbol, exchange) {
    try {
      // Extract underlying symbol (remove expiry and strike info)
      const underlying = this.extractUnderlying(symbol);
      console.log(`[QuickOrder] fetchAvailableExpiries: underlying=${underlying}, exchange=${exchange}`);

      // Get first active instance to fetch expiries
      // Try without filter first, then filter on client side as fallback
      let instancesResponse = await api.getInstances({ is_active: 1 });
      console.log(`[QuickOrder] Instances response with is_active=1:`, instancesResponse.data?.length || 0, 'instances');

      // Fallback: if no instances found with filter, try getting all and filter manually
      if (!instancesResponse.data || instancesResponse.data.length === 0) {
        console.log(`[QuickOrder] No instances with filter, trying all instances...`);
        instancesResponse = await api.getInstances({});
        if (instancesResponse.data && instancesResponse.data.length > 0) {
          // Filter active instances manually
          const activeInstances = instancesResponse.data.filter(inst =>
            inst.is_active === 1 || inst.is_active === true || inst.is_active === '1'
          );
          console.log(`[QuickOrder] Found ${activeInstances.length} active instances out of ${instancesResponse.data.length} total`);
          if (activeInstances.length === 0) {
            console.warn('No active instances available to fetch expiries (after manual filter)');
            return [];
          }
          instancesResponse.data = activeInstances;
        } else {
          console.warn('No instances available at all to fetch expiries');
          return [];
        }
      }

      const instance = instancesResponse.data[0];
      const instanceId = instance.id;
      console.log(`[QuickOrder] Using instance: ${instance.name} (ID: ${instanceId})`);

      // Fetch expiries from API
      const response = await api.getExpiry(underlying, instanceId, exchange);
      console.log(`[QuickOrder] Expiry API response:`, response);

      if (response.data && Array.isArray(response.data)) {
        const expiries = response.data.map(exp => exp.expiry || exp);
        console.log(`[QuickOrder] Mapped ${expiries.length} expiries:`, expiries.slice(0, 5));
        return expiries;
      }

      console.warn('[QuickOrder] Expiry API returned no data or non-array data');
      return [];
    } catch (error) {
      console.error('[QuickOrder] Failed to fetch expiries:', error);
      return [];
    }
  }

  /**
   * Get the correct exchange for derivatives based on the symbol's cash exchange
   */
  getDerivativeExchange(exchange, symbolType) {
    // Map cash exchanges to their derivative exchanges
    const exchangeMap = {
      'NSE': 'NFO',         // NSE equity -> NSE F&O
      'NSE_INDEX': 'NFO',   // NSE indices -> NSE F&O
      'BSE': 'BFO',         // BSE equity -> BSE F&O
      'BSE_INDEX': 'BFO',   // BSE indices -> BSE F&O
      'NFO': 'NFO',         // Already derivative exchange
      'BFO': 'BFO',         // Already derivative exchange
      'MCX': 'MCX',         // Commodities
      'CDS': 'CDS',         // Currency derivatives
    };

    return exchangeMap[exchange] || 'NFO'; // Default to NFO
  }

  /**
   * Extract underlying symbol from full symbol name
   */
  extractUnderlying(symbol) {
    // Remove common suffixes and extract base symbol
    // Examples: BANKNIFTY25NOV2558000CE -> BANKNIFTY
    //           NIFTY25DEC50FUT -> NIFTY

    // Try to match pattern with numbers/dates
    const match = symbol.match(/^([A-Z]+)/);
    return match ? match[1] : symbol;
  }

  /**
   * Format expiry date for display
   */
  formatExpiryDate(expiry) {
    if (!expiry) return 'N/A';

    // Handle different date formats
    // "2025-11-28" -> "28-NOV-25"
    // "28-NOV-25" -> "28-NOV-25" (already formatted)

    if (expiry.includes('-') && expiry.length === 10) {
      // Convert YYYY-MM-DD to DD-MMM-YY
      const date = new Date(expiry);
      const day = String(date.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames[date.getMonth()];
      const year = String(date.getFullYear()).slice(-2);
      return `${day}-${month}-${year}`;
    }

    return expiry;
  }

  /**
   * Normalize expiry date to YYYY-MM-DD format (API format)
   * Converts "18-NOV-25" -> "2025-11-18"
   * Passes through "2025-11-18" unchanged
   */
  normalizeExpiryDate(expiry) {
    if (!expiry) return null;

    // Already in YYYY-MM-DD format (10 chars, starts with digit, has 2 dashes)
    if (expiry.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return expiry;
    }

    // Convert DD-MMM-YY to YYYY-MM-DD
    if (expiry.length === 9 && /^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
      const [day, monthStr, year] = expiry.split('-');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames.indexOf(monthStr);

      if (month === -1) {
        console.error('[QuickOrder] Invalid month in expiry:', expiry);
        return null;
      }

      // Convert 2-digit year to 4-digit year (assuming 20xx)
      const fullYear = `20${year}`;
      const paddedMonth = String(month + 1).padStart(2, '0');

      return `${fullYear}-${paddedMonth}-${day}`;
    }

    console.warn('[QuickOrder] Unknown expiry format:', expiry);
    return expiry;
  }

  /**
   * Place quick order
   */
  async placeOrder(watchlistId, symbolId, action) {
    try {
      // Get current symbol data
      const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      const symbol = symbolRow.dataset.symbol;
      const exchange = symbolRow.dataset.exchange;

      // Get current settings
      const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
      const optionsLeg = this.selectedOptionsLegs.get(symbolId) || 'ATM';
      const quantity = this.defaultQuantities.get(symbolId) || 1;
      const selectedExpiry = this.selectedExpiries.get(symbolId);

      console.log('[QuickOrder] placeOrder - Settings retrieved:', {
        symbolId,
        action,
        tradeModeFromMap: this.selectedTradeModes.get(symbolId),
        finalTradeMode: tradeMode,
        optionsLeg,
        quantity,
        selectedExpiry,
        mapContents: Array.from(this.selectedTradeModes.entries()),
      });

      // Validate quantity
      if (!quantity || quantity <= 0) {
        Utils.showToast('Quantity must be greater than 0', 'error');
        return;
      }

      // Build order request
      const orderData = {
        symbolId,  // Watchlist symbol database ID (required by backend)
        action,
        tradeMode,
        quantity,
      };

      // Add expiry for FUTURES/OPTIONS mode (ensure YYYY-MM-DD format)
      if ((tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') && selectedExpiry) {
        // Double-check normalization (defensive programming)
        orderData.expiry = this.normalizeExpiryDate(selectedExpiry);
        console.log(`[QuickOrder] Expiry for order: raw="${selectedExpiry}" normalized="${orderData.expiry}"`);
      }

      // Add options leg for OPTIONS mode with option actions
      if (tradeMode === 'OPTIONS' && ['BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE'].includes(action)) {
        orderData.optionsLeg = optionsLeg;
      }

      console.log('[QuickOrder] Final order data being sent:', orderData);

      // Show loading state
      const actionButtons = document.querySelectorAll(`#expansion-content-${symbolId} .btn-quick-action`);
      actionButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.add('loading');
      });

      // Place order
      const response = await api.placeQuickOrder(orderData);

      // Show success message
      if (response.data.summary) {
        const { successful, failed, total } = response.data.summary;
        if (successful > 0) {
          Utils.showToast(
            `Order placed: ${successful}/${total} successful`,
            failed > 0 ? 'warning' : 'success'
          );
        } else {
          Utils.showToast(`All orders failed`, 'error');
        }
      } else {
        Utils.showToast('Order placed successfully', 'success');
      }

      // Log results
      console.log('Quick order results:', response.data);

      // Log detailed error information if any orders failed
      if (response.data.results) {
        response.data.results.forEach((result, index) => {
          if (!result.success) {
            console.error(`[QuickOrder] Order ${index + 1} FAILED:`, {
              message: result.message,
              error: result.error,
              fullResult: result
            });
          } else {
            console.log(`[QuickOrder] Order ${index + 1} SUCCESS:`, result);
          }
        });
      }

    } catch (error) {
      console.error('Quick order failed:', error);
      Utils.showToast(`Order failed: ${error.message}`, 'error');
    } finally {
      // Remove loading state
      const actionButtons = document.querySelectorAll(`#expansion-content-${symbolId} .btn-quick-action`);
      actionButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('loading');
      });
    }
  }
}

// Export singleton instance
const quickOrder = new QuickOrderHandler();
