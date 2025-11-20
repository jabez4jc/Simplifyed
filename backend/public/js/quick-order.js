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
    this.selectedProducts = new Map(); // symbolId -> product

    // Buyer/Writer options mode settings (for OPTIONS trade mode only)
    this.operatingModes = new Map(); // symbolId -> 'BUYER' | 'WRITER'
    this.strikePolicies = new Map(); // symbolId -> 'FLOAT_OFS' | 'ANCHOR_OFS'
    this.stepLots = new Map(); // symbolId -> number (contracts per click)
    this.writerGuards = new Map(); // symbolId -> boolean (enable writer guard)
    this.optionPreviewTimers = new Map(); // symbolId -> interval id
    this.optionPreviewRequestIds = new Map(); // symbolId -> latest request token
    this.futuresPreviewTimers = new Map();
    this.futuresPreviewRequestIds = new Map();
  }

  /**
   * Toggle row expansion for a symbol
   */
  toggleRowExpansion(watchlistId, symbolId) {
    try {
      const rowKey = `${watchlistId}_${symbolId}`;
      const expansionRow = document.getElementById(`expansion-row-${symbolId}`);
      const toggleBtn = document.querySelector(`[data-toggle-symbol="${symbolId}"]`);

      if (!expansionRow) {
        throw new Error('Expansion row not found in DOM');
      }

      if (this.expandedRows.has(rowKey)) {
        // Collapse
        expansionRow.style.display = 'none';
        if (toggleBtn) {
          toggleBtn.textContent = '▼';
          toggleBtn.classList.remove('rotated');
        }
        this.expandedRows.delete(rowKey);
        this.stopOptionPreviewPolling(symbolId);
        this.stopFuturesPreviewPolling(symbolId);
      } else {
        // Expand
        expansionRow.style.display = 'table-row';
        if (toggleBtn) {
          toggleBtn.textContent = '▲';
          toggleBtn.classList.add('rotated');
        }
        this.expandedRows.add(rowKey);

        // Load expansion content if not already loaded
        this.loadExpansionContent(watchlistId, symbolId);
      }
    } catch (error) {
      console.error('Failed to toggle watchlist symbol expansion', { watchlistId, symbolId, error });
      if (window.Utils && typeof Utils.showToast === 'function') {
        Utils.showToast(`Failed to show trading controls: ${error.message}`, 'error');
      }
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
      if (!symbolRow) {
        throw new Error('Symbol row not found in DOM');
      }

      const symbol = symbolRow.dataset.symbol;
      const exchange = symbolRow.dataset.exchange;
      const rawUnderlying = symbolRow.dataset.underlying || symbol;
      const underlyingSymbol = this.extractUnderlying(rawUnderlying) || rawUnderlying;

    let capabilities = { equity: true, futures: true, options: true, symbolType: 'UNKNOWN' };
    try {
      capabilities = this.getSymbolCapabilities(symbolRow);
    } catch (error) {
      console.warn('Failed to derive symbol capabilities, falling back to defaults', error);
    }

    const symbolType =
      capabilities.symbolType ||
      (symbolRow.querySelector('.badge')?.textContent.trim() || 'UNKNOWN');

    // Get default values
    const availableModes = this.getAvailableTradeModes(symbolType, capabilities);
    let tradeMode = this.selectedTradeModes.get(symbolId) || this.getDefaultTradeMode(symbolType, capabilities);
    if (!availableModes.includes(tradeMode)) {
      tradeMode = availableModes[0];
      this.selectedTradeModes.set(symbolId, tradeMode);
    }
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

      if (!this.selectedProducts.has(symbolId)) {
        this.selectedProducts.set(symbolId, 'MIS');
      }

      // Initialize Buyer/Writer options mode settings (for OPTIONS trade mode)
      if (!this.operatingModes.has(symbolId)) {
        this.operatingModes.set(symbolId, 'BUYER');  // Default to Buyer mode
      }
      if (!this.strikePolicies.has(symbolId)) {
        this.strikePolicies.set(symbolId, 'FLOAT_OFS');  // Default to FLOAT_OFS
      }
      if (!this.writerGuards.has(symbolId)) {
        this.writerGuards.set(symbolId, true);  // Default to writer guard enabled
      }

      // Fetch available expiries for FUTURES/OPTIONS if needed
      let expiries = [];
      let expiryUnderlying = underlyingSymbol;
      const normalizedExchange = (exchange || '').toUpperCase();
      if ((symbolType === 'INDEX' || normalizedExchange.endsWith('_INDEX')) && symbol) {
        expiryUnderlying = symbol;
      }

      if (tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') {
        // Use NFO exchange for derivatives (futures/options)
        // INDEX and EQUITY symbols need to use NFO/BFO for their derivatives
        const derivativeExchange = this.getDerivativeExchange(exchange, symbolType);
        console.log(`[QuickOrder] Fetching expiries for symbol: ${symbol}, exchange: ${exchange} -> ${derivativeExchange}, mode: ${tradeMode}`);
        expiries = await this.fetchAvailableExpiries(expiryUnderlying, derivativeExchange, tradeMode, exchange);
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

      const selectedProduct = this.selectedProducts.get(symbolId) || 'MIS';

      // Render trading controls
      contentDiv.innerHTML = this.renderTradingControls({
        watchlistId,
        symbolId,
        symbol,
        exchange,
        symbolType,
        tradeMode,
        capabilities,
        availableModes,
        optionsLeg,
        quantity,
        expiries,
        selectedExpiry,
        selectedProduct,
        // Buyer/Writer options mode settings
        operatingMode: this.operatingModes.get(symbolId),
        strikePolicy: this.strikePolicies.get(symbolId),
        writerGuard: this.writerGuards.get(symbolId),
      });

      if (tradeMode === 'OPTIONS' && capabilities.options) {
        this.startOptionPreviewPolling(symbolId);
      } else {
        this.stopOptionPreviewPolling(symbolId);
      }
      if (tradeMode === 'FUTURES' && capabilities.futures) {
        this.startFuturesPreviewPolling(symbolId);
      } else {
        this.stopFuturesPreviewPolling(symbolId);
      }

      contentDiv.dataset.loaded = 'true';
    } catch (error) {
      contentDiv.innerHTML = `<p class="text-error text-sm">Failed to load trading controls: ${error.message}</p>`;
    }
  }

  /**
   * Get default trade mode based on symbol type
   */
  getDefaultTradeMode(symbolType, capabilities = {}) {
    if (capabilities.options) return 'OPTIONS';
    if (capabilities.futures) return 'FUTURES';
    if (capabilities.equity !== false) return 'EQUITY';

    const fallback = {
      INDEX: 'OPTIONS',
    };
    return fallback[symbolType] || 'EQUITY';
  }

  /**
   * Render trading controls UI
   */
  renderTradingControls({ watchlistId, symbolId, symbol, exchange, symbolType, tradeMode, capabilities = {}, availableModes = [], optionsLeg, quantity, expiries, selectedExpiry, selectedProduct, operatingMode, strikePolicy, writerGuard }) {
    const showOptionsLeg = tradeMode === 'OPTIONS' && capabilities.options;
    const showExpirySelector =
      (tradeMode === 'FUTURES' && capabilities.futures) ||
      (tradeMode === 'OPTIONS' && capabilities.options);
    const showOperatingMode = tradeMode === 'OPTIONS' && capabilities.options;
    const showStrikePolicy = tradeMode === 'OPTIONS' && capabilities.options;

    console.log(`[QuickOrder] Rendering controls:`, {
      tradeMode,
      expiryCount: expiries?.length || 0,
      showExpirySelector,
      selectedExpiry,
      operatingMode,
      strikePolicy,
      quantity
    });

    const renderField = (label, help, controlHtml) => `
      <div class="form-field-row">
        <div class="form-label-stack">
          <div class="form-label-line">
            <span class="form-label-sm">${label}</span>
            ${help ? `
              <button type="button" class="field-help" title="${help}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <circle cx="12" cy="16" r="0.5"></circle>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="field-control">
          ${controlHtml}
        </div>
      </div>
    `;

    const tradeModeField = renderField(
      'Trade Mode',
      'Choose whether this quick order fires direct equity orders, futures contracts, or managed options legs.',
      `<div class="trade-mode-selector">
        ${availableModes.map(mode => `
          <button
            class="btn-trade-mode ${mode === tradeMode ? 'active' : ''} ${!this.isModeAvailable(mode, symbolType, capabilities) ? 'disabled' : ''}"
            data-mode="${mode}"
            data-symbol-id="${symbolId}"
            onclick="console.log('[QuickOrder] Button clicked:', ${symbolId}, '${mode}'); quickOrder.selectTradeMode(${symbolId}, '${mode}'); return false;"
            ${!this.isModeAvailable(mode, symbolType, capabilities) ? 'disabled' : ''}
            title="${this.getTradeModeTooltip(mode, symbolType, capabilities)}">
            ${this.getTradeModeLabel(mode)}
          </button>
        `).join('')}
      </div>`
    );

    const expiryField = showExpirySelector
      ? renderField(
          'Expiry',
          'Pick the contract month you want to trade. Futures and options require an expiry.',
          expiries && expiries.length > 0
            ? `<select
                class="select-expiry"
                data-symbol-id="${symbolId}"
                onchange="quickOrder.selectExpiry(${symbolId}, this.value)">
                ${expiries.map(expiry => `
                  <option value="${expiry}" ${expiry === selectedExpiry ? 'selected' : ''}>
                    ${this.formatExpiryDate(expiry)}
                  </option>
                `).join('')}
              </select>`
            : `<p class="text-sm text-warning">No expiries available for this symbol. Verify the instruments cache.</p>`
        )
      : '';

    const optionsLegField = showOptionsLeg
      ? renderField(
          'Options Leg',
          'Shift the strike relative to ATM before firing CE/PE actions.',
          `<select
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
          </select>`
        )
      : '';

    const operatingModeField = showOperatingMode
      ? renderField(
          'Operating Mode',
          'Toggle between Buyer (long premium) and Writer (short premium) flows.',
          `<div class="operating-mode-toggle" role="group" aria-label="Buyer or Writer mode">
            <button
              class="${operatingMode === 'BUYER' ? 'is-active' : ''}"
              data-mode="BUYER"
              data-symbol-id="${symbolId}"
              onclick="quickOrder.selectOperatingMode(${symbolId}, 'BUYER')"
              title="Buyer Mode: go long premium (BUY/REDUCE buttons)">
              Buyer
            </button>
            <button
              class="${operatingMode === 'WRITER' ? 'is-active' : ''}"
              data-mode="WRITER"
              data-symbol-id="${symbolId}"
              onclick="quickOrder.selectOperatingMode(${symbolId}, 'WRITER')"
              title="Writer Mode: short premium (SELL/INCREASE buttons)">
              Writer
            </button>
          </div>`
        )
      : '';

    const strikePolicyField = showStrikePolicy
      ? renderField(
          'Strike Policy',
          'Controls how strikes migrate as ATM moves during FLOAT/ANCHOR offsets.',
          `<select
            class="select-strike-policy"
            data-symbol-id="${symbolId}"
            onchange="quickOrder.selectStrikePolicy(${symbolId}, this.value)">
            <option value="FLOAT_OFS" ${strikePolicy === 'FLOAT_OFS' ? 'selected' : ''}>
              FLOAT_OFS (Follow ATM)
            </option>
            <option value="ANCHOR_OFS" ${strikePolicy === 'ANCHOR_OFS' ? 'selected' : ''}>
              ANCHOR_OFS (Lock first strike)
            </option>
          </select>`
        )
      : '';

    const quantityField = renderField(
      'Quantity',
      'Lots/contracts dispatched per click. Uses instrument lot size for totals.',
      `<input
        type="number"
        class="input-quantity"
        value="${quantity}"
        min="1"
        step="1"
        data-symbol-id="${symbolId}"
        onchange="quickOrder.updateQuantity(${symbolId}, parseInt(this.value))"
        title="Number of lots per order. Controls both position step size and order size. Example: 2 lots × 25 lot size = 50 contracts">`
    );

    const isDerivativeMode = tradeMode === 'FUTURES' || tradeMode === 'OPTIONS' || (symbolType === 'FUTURES' || symbolType === 'OPTIONS');
    const productField = renderField(
      'Product',
      isDerivativeMode
        ? 'Futures/Options must use NRML.'
        : 'Choose the product type to send for all instances.',
      isDerivativeMode
        ? `<select class="form-select" disabled>
             <option value="NRML" selected>NRML (Derivatives)</option>
           </select>`
        : `<select class="form-select"
                data-symbol-id="${symbolId}"
                onchange="quickOrder.selectProduct(${symbolId}, this.value)">
             <option value="MIS" ${selectedProduct === 'MIS' ? 'selected' : ''}>MIS (Intraday)</option>
             <option value="NRML" ${selectedProduct === 'NRML' ? 'selected' : ''}>NRML (Derivatives)</option>
             <option value="CNC" ${selectedProduct === 'CNC' ? 'selected' : ''}>CNC (Delivery)</option>
           </select>`
    );

    const futuresPreviewBlock = tradeMode === 'FUTURES' && capabilities.futures
      ? `
        <div
          class="futures-preview-card border border-base-300 rounded-xl p-3 bg-base-100/80 space-y-1"
          id="futures-preview-${symbolId}"
          aria-live="polite">
          <p class="text-sm text-neutral-500">Select an expiry to view futures quote.</p>
        </div>
      `
      : '';

    const optionPreviewBlock = tradeMode === 'OPTIONS' && capabilities.options
      ? `
        <div
          class="option-preview-card border border-base-300 rounded-xl p-3 bg-base-200/60 space-y-3"
          id="option-preview-${symbolId}"
          aria-live="polite">
          <p class="text-sm text-neutral-500">Resolving option strikes…</p>
        </div>
      `
      : '';

    return `
      <div class="quick-order-panel">
        <div class="quick-order-config">
          ${tradeModeField}
          ${expiryField}
          ${productField}
          ${optionsLegField}
          ${operatingModeField}
          ${strikePolicyField}
          ${quantityField}
        </div>
        ${futuresPreviewBlock}
        ${optionPreviewBlock}
        <div class="quick-order-actions">
          ${this.renderActionButtons(watchlistId, symbolId, symbol, exchange, tradeMode, operatingMode, strikePolicy, quantity, selectedExpiry, optionsLeg)}
        </div>
      </div>
    `;
  }

  /**
   * Check if options mode is fully configured
   */
  isOptionsModeConfigured(symbolId) {
    const tradeMode = this.selectedTradeModes.get(symbolId);
    const expiry = this.selectedExpiries.get(symbolId);
    const operatingMode = this.operatingModes.get(symbolId);
    const strikePolicy = this.strikePolicies.get(symbolId);
    const quantity = this.defaultQuantities.get(symbolId);

    // For OPTIONS mode, all settings must be present
    if (tradeMode === 'OPTIONS') {
      return !!(expiry && operatingMode && strikePolicy && quantity && quantity > 0);
    }

    // For other modes, only basic settings needed
    return true;
  }

  /**
   * Render action buttons based on trade mode and operating mode
   */
  renderActionButtons(watchlistId, symbolId, symbol, exchange, tradeMode, operatingMode = 'BUYER', strikePolicy = 'FLOAT_OFS', quantity = 1, selectedExpiry = null, optionsLeg = 'ATM') {
    // Disable buttons until all required settings are configured
    const isConfigured = this.isOptionsModeConfigured(symbolId);

    if (tradeMode === 'OPTIONS') {
      // CE Row
      let ceButtons = '';
      if (operatingMode === 'BUYER') {
        ceButtons = `
          <button class="btn-quick-action btn-buy-ce"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Add CE longs at ${optionsLeg} strike">
            BUY CE
          </button>
          <button class="btn-quick-action btn-reduce-ce"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'REDUCE_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Reduce CE longs (sell to close)">
            REDUCE CE
          </button>
        `;
      } else {
        ceButtons = `
          <button class="btn-quick-action btn-sell-ce"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Open CE shorts at ${optionsLeg} strike">
            SELL CE
          </button>
          <button class="btn-quick-action btn-increase-ce"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'INCREASE_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Cover CE shorts (buy back)">
            INCREASE CE
          </button>
        `;
      }

      // PE Row
      let peButtons = '';
      if (operatingMode === 'BUYER') {
        peButtons = `
          <button class="btn-quick-action btn-buy-pe"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Add PE longs at ${optionsLeg} strike">
            BUY PE
          </button>
          <button class="btn-quick-action btn-reduce-pe"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'REDUCE_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Reduce PE longs (sell to close)">
            REDUCE PE
          </button>
        `;
      } else {
        peButtons = `
          <button class="btn-quick-action btn-sell-pe"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Open PE shorts at ${optionsLeg} strike">
            SELL PE
          </button>
          <button class="btn-quick-action btn-increase-pe"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'INCREASE_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Cover PE shorts (buy back)">
            INCREASE PE
          </button>
        `;
      }

      // Exit Row
      const exitButtons = `
        <button class="btn-quick-action btn-close-all-ce"
                onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'CLOSE_ALL_CE')"
                ${!isConfigured ? 'disabled' : ''}
                title="Close all CE positions">
          CLOSE ALL CE
        </button>
        <button class="btn-quick-action btn-close-all-pe"
                onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'CLOSE_ALL_PE')"
                ${!isConfigured ? 'disabled' : ''}
                title="Close all PE positions">
          CLOSE ALL PE
        </button>
        <button class="btn-quick-action btn-exit-all"
                onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT_ALL')"
                ${!isConfigured ? 'disabled' : ''}
                title="Exit all positions (CE & PE)">
          EXIT ALL
        </button>
      `;

      return `
        <div class="options-action-buttons">
          <div class="options-button-row">
            <div class="button-row-label">CE Options</div>
            <div class="button-group">
              ${ceButtons}
            </div>
          </div>
          <div class="options-button-row">
            <div class="button-row-label">PE Options</div>
            <div class="button-group">
              ${peButtons}
            </div>
          </div>
          <div class="options-button-row exit-row">
            <div class="button-row-label">Exit Positions</div>
            <div class="button-group">
              ${exitButtons}
            </div>
          </div>
        </div>
      `;
    } else {
      // EQUITY or FUTURES mode
      return `
        <div class="direct-actions">
          <div class="direct-actions-grid">
            <button class="btn-quick-action btn-buy"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY')">
              BUY
            </button>
            <button class="btn-quick-action btn-sell"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL')">
              SELL
            </button>
            <button class="btn-quick-action btn-short"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SHORT')">
              SHORT
            </button>
            <button class="btn-quick-action btn-cover"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'COVER')">
              COVER
            </button>
            <button class="btn-quick-action btn-exit"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT')">
              EXIT
            </button>
          </div>
        </div>
      `;
    }
  }

  /**
   * Get display label for trade mode
   */
  getTradeModeLabel(mode) {
    const labels = {
      'EQUITY': 'DIRECT',
      'FUTURES': 'FUTURES',
      'OPTIONS': 'OPTIONS',
    };
    return labels[mode] || mode;
  }

  /**
   * Get available trade modes based on symbol type
   */
  getAvailableTradeModes(symbolType, capabilities = {}) {
    const modes = [];
    if (capabilities.equity !== false) {
      modes.push('EQUITY');
    }
    if (capabilities.futures) {
      modes.push('FUTURES');
    }
    if (capabilities.options) {
      modes.push('OPTIONS');
    }

    if (modes.length === 0) {
      if (symbolType === 'INDEX') {
        modes.push('OPTIONS');
      } else {
        modes.push('EQUITY');
      }
    }
    return modes;
  }

  /**
   * Check if trade mode is available for symbol type
   */
  isModeAvailable(mode, symbolType, capabilities = {}) {
    if (mode === 'OPTIONS') return !!capabilities.options;
    if (mode === 'FUTURES') return !!capabilities.futures;
    if (mode === 'EQUITY') return capabilities.equity !== false;
    const availability = {
      INDEX: ['FUTURES', 'OPTIONS'],
    };
    return (availability[symbolType] || ['EQUITY']).includes(mode);
  }

  /**
   * Get tooltip for trade mode button
   */
  getTradeModeTooltip(mode, symbolType, capabilities = {}) {
    if (this.isModeAvailable(mode, symbolType, capabilities)) {
      const label = this.getTradeModeLabel(mode).toLowerCase();
      return `Trade ${label}`;
    }
    return `${this.getTradeModeLabel(mode)} not available for this symbol`;
  }

  /**
   * Select trade mode
   */
  selectTradeMode(symbolId, mode) {
    console.log('[QuickOrder] selectTradeMode called:', { symbolId, mode });

    const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
    if (symbolRow) {
      const capabilities = this.getSymbolCapabilities(symbolRow);
      const symbolType = capabilities.symbolType || (symbolRow.querySelector('.badge')?.textContent.trim() || 'UNKNOWN');
      const availableModes = this.getAvailableTradeModes(symbolType, capabilities);
      if (!availableModes.includes(mode)) {
        Utils.showToast(`${this.getTradeModeLabel(mode)} trading is disabled for this symbol.`, 'warning');
        return;
      }
    }

    this.selectedTradeModes.set(symbolId, mode);
    // Force NRML for derivatives
    if (mode === 'FUTURES' || mode === 'OPTIONS') {
      this.selectedProducts.set(symbolId, 'NRML');
    }
    this.selectedExpiries.delete(symbolId);
    this.availableExpiries.delete(symbolId);
    this.reloadExpansionContent(symbolId);
  }

  /**
   * Select options leg
   */
  selectOptionsLeg(symbolId, leg) {
    this.selectedOptionsLegs.set(symbolId, leg);
    this.triggerOptionPreviewRefresh(symbolId);
  }

  /**
   * Select operating mode (BUYER or WRITER)
   */
  selectOperatingMode(symbolId, mode) {
    console.log('[QuickOrder] selectOperatingMode called:', { symbolId, mode });
    this.operatingModes.set(symbolId, mode);
    console.log('[QuickOrder] Operating mode updated:', this.operatingModes.get(symbolId));
    this.reloadExpansionContent(symbolId);
  }

  /**
   * Select strike policy (FLOAT_OFS or ANCHOR_OFS)
   */
  selectStrikePolicy(symbolId, policy) {
    console.log('[QuickOrder] selectStrikePolicy called:', { symbolId, policy });
    this.strikePolicies.set(symbolId, policy);

    // Clear anchored strikes if switching from ANCHOR_OFS to FLOAT_OFS
    if (policy === 'FLOAT_OFS') {
      console.log('[QuickOrder] Clearing anchored strikes for FLOAT_OFS mode');
      // TODO: Clear anchored strikes from database if needed
    }

    this.reloadExpansionContent(symbolId);
  }

  selectProduct(symbolId, product) {
    console.log('[QuickOrder] selectProduct called:', { symbolId, product });
    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    if ((tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') && product !== 'NRML') {
      this.selectedProducts.set(symbolId, 'NRML');
      return;
    }
    this.selectedProducts.set(symbolId, product);
  }

  /**
   * Update step lots
   */
  updateStepLots(symbolId, value) {
    const validatedValue = Math.max(1, parseInt(value) || 1);
    console.log('[QuickOrder] updateStepLots called:', { symbolId, value: validatedValue });
    this.stepLots.set(symbolId, validatedValue);
    this.reloadExpansionContent(symbolId);
  }

  /**
   * Select expiry date
   */
  selectExpiry(symbolId, expiry) {
    // Ensure expiry is always stored in YYYY-MM-DD format (API format)
    const normalizedExpiry = this.normalizeExpiryDate(expiry);
    console.log(`[QuickOrder] selectExpiry: raw="${expiry}" normalized="${normalizedExpiry}"`);
    this.selectedExpiries.set(symbolId, normalizedExpiry);
    this.triggerOptionPreviewRefresh(symbolId);
    this.triggerFuturesPreviewRefresh(symbolId);
  }

  /**
   * Update quantity
   */
  updateQuantity(symbolId, quantity) {
    this.defaultQuantities.set(symbolId, quantity);
  }

  /**
   * Reload expansion content when configuration changes
   */
  reloadExpansionContent(symbolId) {
    const expansionContent = document.getElementById(`expansion-content-${symbolId}`);
    if (!expansionContent) {
      console.warn('[QuickOrder] Expansion content not found when reloading', { symbolId });
      return;
    }

    expansionContent.dataset.loaded = 'false';
    expansionContent.innerHTML = '<p class="text-neutral-500 text-sm">Loading...</p>';

    const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
    if (!symbolRow) {
      console.warn('[QuickOrder] Symbol row not found when reloading expansion', { symbolId });
      return;
    }

    const tableEl = symbolRow.closest('[id^="watchlist-table-"]');
    if (!tableEl) {
      console.warn('[QuickOrder] Watchlist table not found when reloading expansion', { symbolId });
      return;
    }

    const watchlistId = parseInt(tableEl.id.split('-')[2], 10);
    if (Number.isNaN(watchlistId)) {
      console.warn('[QuickOrder] Unable to derive watchlist ID for expansion reload', { symbolId, tableId: tableEl.id });
      return;
    }

    this.loadExpansionContent(watchlistId, symbolId);
  }

  triggerOptionPreviewRefresh(symbolId) {
    const container = document.getElementById(`option-preview-${symbolId}`);
    if (!container) {
      return;
    }

    // Kick off a refresh without waiting for the next scheduled tick
    this.refreshOptionPreview(symbolId);
  }

  startOptionPreviewPolling(symbolId) {
    this.stopOptionPreviewPolling(symbolId);

    const execute = () => this.refreshOptionPreview(symbolId);
    execute();
    const intervalId = setInterval(execute, 20000);
    this.optionPreviewTimers.set(symbolId, intervalId);
  }

  stopOptionPreviewPolling(symbolId) {
    if (this.optionPreviewTimers.has(symbolId)) {
      clearInterval(this.optionPreviewTimers.get(symbolId));
      this.optionPreviewTimers.delete(symbolId);
    }
    this.optionPreviewRequestIds.delete(symbolId);
  }

  stopAllOptionPreviewPolling() {
    this.optionPreviewTimers.forEach(intervalId => clearInterval(intervalId));
    this.optionPreviewTimers.clear();
    this.optionPreviewRequestIds.clear();
  }

  refreshPositionsAfterOrder() {
    if (window.app && window.app.currentView === 'watchlists' && typeof window.app.loadPositionsTab === 'function') {
      window.app.loadPositionsTab();
    }
  }

  async refreshOptionPreview(symbolId) {
    const container = document.getElementById(`option-preview-${symbolId}`);
    if (!container) {
      return;
    }

    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    if (tradeMode !== 'OPTIONS') {
      container.innerHTML = '<p class="text-sm text-neutral-500">Switch to Options mode to view CE/PE quotes.</p>';
      this.stopOptionPreviewPolling(symbolId);
      return;
    }

    const expiry = this.selectedExpiries.get(symbolId);
    if (!expiry) {
      container.innerHTML = '<p class="text-sm text-warning">Select an expiry to view CE/PE quotes.</p>';
      return;
    }

    const optionsLeg = this.selectedOptionsLegs.get(symbolId) || 'ATM';
    const requestId = (this.optionPreviewRequestIds.get(symbolId) || 0) + 1;
    this.optionPreviewRequestIds.set(symbolId, requestId);

    if (!container.dataset.loaded) {
      container.innerHTML = '<p class="text-sm text-neutral-500">Loading option quotes…</p>';
    }

    try {
      const response = await api.getQuickOrderOptionsPreview({
        symbolId,
        expiry,
        optionsLeg,
      });

      if (this.optionPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }

      const preview = response?.data || response;
      this.renderOptionPreview(symbolId, preview);
      container.dataset.loaded = 'true';
    } catch (error) {
      if (this.optionPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }
      const message = error?.message || 'Failed to load option quotes';
      container.innerHTML = `<p class="text-sm text-error">${Utils.escapeHTML(message)}</p>`;
    }
  }

  renderOptionPreview(symbolId, preview) {
    const container = document.getElementById(`option-preview-${symbolId}`);
    if (!container) {
      return;
    }

    if (!preview) {
      container.innerHTML = '<p class="text-sm text-error">Option preview unavailable.</p>';
      return;
    }

    const expiryLabel = preview.expiry ? this.formatExpiryDate(preview.expiry) : 'N/A';
    const underlyingSymbol = preview.underlying?.symbol || '';
    const underlyingLtp = preview.underlying?.ltp != null
      ? `₹${Utils.formatNumber(preview.underlying.ltp)}`
      : '—';
    const updatedAt = preview.updatedAt ? new Date(preview.updatedAt) : null;
    const updatedLabel = updatedAt
      ? `Refreshed ${updatedAt.toLocaleTimeString()}`
      : 'Refreshed moments ago';

    container.innerHTML = `
      <div class="flex items-center justify-between gap-4 flex-wrap text-xs text-neutral-600">
        <div>
          <p class="font-semibold text-base-content">Option Symbols (${preview.strikeOffset})</p>
          <p>Exp ${expiryLabel} • ${Utils.escapeHTML(underlyingSymbol)} ${underlyingLtp}</p>
        </div>
        <span>${updatedLabel}</span>
      </div>
      <div class="option-preview-grid grid grid-cols-1 md:grid-cols-2 gap-3">
        ${this.renderOptionPreviewLeg('CALL', preview.ce)}
        ${this.renderOptionPreviewLeg('PUT', preview.pe)}
      </div>
    `;
  }

  renderOptionPreviewLeg(label, leg) {
    if (!leg) {
      return `
        <div class="option-leg-card border border-dashed rounded-lg p-3 text-sm text-neutral-500">
          No ${label} leg available
        </div>
      `;
    }

    const ltpDefined = typeof leg.ltp === 'number' && !Number.isNaN(leg.ltp);
    const ltpText = ltpDefined ? `₹${Utils.formatNumber(leg.ltp)}` : '—';
    const changeDefined = typeof leg.changePercent === 'number' && !Number.isNaN(leg.changePercent);
    const changeText = changeDefined
      ? `${leg.changePercent >= 0 ? '+' : ''}${leg.changePercent.toFixed(2)}%`
      : '—';
    const changeClass = changeDefined
      ? (leg.changePercent > 0 ? 'text-profit' : (leg.changePercent < 0 ? 'text-loss' : 'text-neutral-500'))
      : 'text-neutral-500';

    return `
      <div class="option-leg-card border border-base-200 rounded-lg p-3 bg-base-100/80 space-y-1">
        <div class="text-xs uppercase tracking-wide text-neutral-500">${label}</div>
        <div class="font-mono text-sm break-all">${Utils.escapeHTML(leg.symbol || '')}</div>
        <div class="text-xs text-neutral-600">Strike ${leg.strike ?? '—'} • Lot ${leg.lotSize ?? '—'}</div>
        <div class="flex items-baseline gap-2">
          <span class="text-lg font-semibold">${ltpText}</span>
          <span class="${changeClass} text-xs">${changeText}</span>
        </div>
      </div>
    `;
  }

  triggerFuturesPreviewRefresh(symbolId) {
    const container = document.getElementById(`futures-preview-${symbolId}`);
    if (!container) {
      return;
    }
    this.refreshFuturesPreview(symbolId);
  }

  startFuturesPreviewPolling(symbolId) {
    this.stopFuturesPreviewPolling(symbolId);
    const execute = () => this.refreshFuturesPreview(symbolId);
    execute();
    const intervalId = setInterval(execute, 20000);
    this.futuresPreviewTimers.set(symbolId, intervalId);
  }

  stopFuturesPreviewPolling(symbolId) {
    if (this.futuresPreviewTimers.has(symbolId)) {
      clearInterval(this.futuresPreviewTimers.get(symbolId));
      this.futuresPreviewTimers.delete(symbolId);
    }
    this.futuresPreviewRequestIds.delete(symbolId);
  }

  stopAllFuturesPreviewPolling() {
    this.futuresPreviewTimers.forEach(intervalId => clearInterval(intervalId));
    this.futuresPreviewTimers.clear();
    this.futuresPreviewRequestIds.clear();
  }

  async refreshFuturesPreview(symbolId) {
    const container = document.getElementById(`futures-preview-${symbolId}`);
    if (!container) return;

    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    if (tradeMode !== 'FUTURES') {
      container.innerHTML = '<p class="text-sm text-neutral-500">Switch to Futures mode to view the contract quote.</p>';
      this.stopFuturesPreviewPolling(symbolId);
      return;
    }

    const expiry = this.selectedExpiries.get(symbolId);
    if (!expiry) {
      container.innerHTML = '<p class="text-sm text-warning">Select an expiry to view the futures quote.</p>';
      return;
    }

    const requestId = (this.futuresPreviewRequestIds.get(symbolId) || 0) + 1;
    this.futuresPreviewRequestIds.set(symbolId, requestId);

    if (!container.dataset.loaded) {
      container.innerHTML = '<p class="text-sm text-neutral-500">Loading futures quote…</p>';
    }

    try {
      const response = await api.getQuickOrderFuturesPreview({ symbolId, expiry });
      if (this.futuresPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }

      const preview = response?.data || response;
      this.renderFuturesPreview(symbolId, preview);
      container.dataset.loaded = 'true';
    } catch (error) {
      if (this.futuresPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }
      const message = error?.message || 'Failed to load futures quote';
      container.innerHTML = `<p class="text-sm text-error">${Utils.escapeHTML(message)}</p>`;
    }
  }

  renderFuturesPreview(symbolId, preview) {
    const container = document.getElementById(`futures-preview-${symbolId}`);
    if (!container) {
      return;
    }

    if (!preview) {
      container.innerHTML = '<p class="text-sm text-error">Futures quote unavailable.</p>';
      return;
    }

    const expiryLabel = preview.expiry ? this.formatExpiryDate(preview.expiry) : 'N/A';
    const ltp = preview.quote?.ltp != null ? `₹${Utils.formatNumber(preview.quote.ltp)}` : '—';
    const changePercent = preview.quote?.changePercent;
    const changeText = typeof changePercent === 'number'
      ? `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`
      : '—';
    const changeClass = typeof changePercent === 'number'
      ? (changePercent > 0 ? 'text-profit' : (changePercent < 0 ? 'text-loss' : 'text-neutral-500'))
      : 'text-neutral-500';

    container.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p class="text-xs uppercase tracking-wide text-neutral-500">Contract</p>
          <p class="font-semibold text-base-content">${Utils.escapeHTML(preview.tradingSymbol || preview.futuresSymbol)}</p>
          <p class="text-xs text-neutral-500">Expiry ${expiryLabel}</p>
        </div>
        <div class="text-right">
          <p class="text-xs uppercase tracking-wide text-neutral-500">LTP</p>
          <p class="text-2xl font-semibold ${changeClass}">${ltp}</p>
          <p class="text-xs ${changeClass}">${changeText}</p>
        </div>
      </div>
    `;
  }

  /**
   * Fetch available expiries for a symbol
   */
  async fetchAvailableExpiries(underlyingSymbol, exchange, tradeMode, baseExchange) {
    const cleanedInput = (underlyingSymbol || '').trim();
    const normalizedUnderlying = this.extractUnderlying(cleanedInput) || cleanedInput;
    const derivativeExchange = this.getDerivativeExchange(exchange);
    const shouldUseSymbolMatch = ['NSE_INDEX', 'BSE_INDEX'].includes((baseExchange || '').toUpperCase());
    const primaryMatchField = shouldUseSymbolMatch ? 'symbol' : 'name';
    const instrumentTypes = this.getInstrumentTypesForMode(tradeMode);
    console.log(`[QuickOrder] fetchAvailableExpiries: underlying=${normalizedUnderlying}, exchange=${exchange}, derivative=${derivativeExchange}, instruments=${instrumentTypes.join('/') || 'any'}`);

    const fetchWithField = async (field, options = {}) => {
      const response = await api.getExpiry(normalizedUnderlying, {
        exchange: derivativeExchange,
        instrumentTypes,
        matchField: field,
        ...options,
      });
      if (response?.data && Array.isArray(response.data)) {
        return response.data.map(exp => exp.expiry || exp);
      }
      return [];
    };

    try {
      // Fast path: rely on instruments cache (no instanceId required)
      let cachedExpiries = await fetchWithField(primaryMatchField);

      if (cachedExpiries.length === 0) {
        const fallbackField = primaryMatchField === 'symbol' ? 'name' : 'symbol';
        if (fallbackField !== primaryMatchField) {
          cachedExpiries = await fetchWithField(fallbackField);
        }
      }

      if (cachedExpiries.length > 0) {
        console.log(`[QuickOrder] Expiries resolved via instruments cache (${cachedExpiries.length} items)`);
        return cachedExpiries;
      }

      console.log('[QuickOrder] No cached expiries available, falling back to broker instance fetch');

      // Fallback: find an active instance to refresh expiries from broker
      let instancesResponse = await api.getInstances({ is_active: 1 });
      let activeInstances = instancesResponse.data || [];
      if (activeInstances.length === 0) {
        instancesResponse = await api.getInstances({});
        activeInstances = (instancesResponse.data || []).filter(inst =>
          inst.is_active === 1 || inst.is_active === true || inst.is_active === '1'
        );
      }

      if (activeInstances.length === 0) {
        console.warn('[QuickOrder] No active instances available to refresh expiries');
        return [];
      }

      const fallbackInstance = activeInstances[0];
      console.log(`[QuickOrder] Using instance ${fallbackInstance.name} (ID: ${fallbackInstance.id}) for expiry refresh`);
      let refreshedExpiries = await fetchWithField(primaryMatchField, { instanceId: fallbackInstance.id });
      if (refreshedExpiries.length === 0) {
        const fallbackField = primaryMatchField === 'symbol' ? 'name' : 'symbol';
        if (fallbackField !== primaryMatchField) {
          refreshedExpiries = await fetchWithField(fallbackField, { instanceId: fallbackInstance.id });
        }
      }
      console.log(`[QuickOrder] Refreshed ${refreshedExpiries.length} expiries from broker`);
      return refreshedExpiries;
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
    if (!symbol) return symbol;
    const upper = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!upper) return symbol;
    return upper.replace(/\d+$/, '');
  }

  getInstrumentTypesForMode(tradeMode) {
    if (tradeMode === 'FUTURES') {
      return ['FUT'];
    }
    if (tradeMode === 'OPTIONS') {
      return ['CE', 'PE'];
    }
    return [];
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
      const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      if (!symbolRow) {
        throw new Error('Symbol row not found in DOM');
      }

      const symbol = symbolRow.dataset.symbol;
      const exchange = symbolRow.dataset.exchange;

    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    const optionsLeg = this.selectedOptionsLegs.get(symbolId) || 'ATM';
    const quantity = this.defaultQuantities.get(symbolId) || 1;
    const selectedExpiry = this.selectedExpiries.get(symbolId);
    const operatingMode = this.operatingModes.get(symbolId) || 'BUYER';
    const strikePolicy = this.strikePolicies.get(symbolId) || 'FLOAT_OFS';
    const stepLots = this.stepLots.get(symbolId) || quantity;
    const selectedProduct = this.selectedProducts.get(symbolId) || 'MIS';

      console.log('[QuickOrder] placeOrder - Settings retrieved:', {
        symbolId,
        action,
        tradeModeFromMap: this.selectedTradeModes.get(symbolId),
        finalTradeMode: tradeMode,
        optionsLeg,
        quantity,
        selectedExpiry,
        operatingMode,
        strikePolicy,
        stepLots,
        mapContents: Array.from(this.selectedTradeModes.entries()),
      });

      if (!quantity || quantity <= 0) {
        Utils.showToast('Quantity must be greater than 0', 'error');
        return;
      }

      const orderData = {
        symbolId,
        action,
        tradeMode,
        quantity,
        product: selectedProduct,
      };

      if ((tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') && selectedExpiry) {
        orderData.expiry = this.normalizeExpiryDate(selectedExpiry);
        console.log(`[QuickOrder] Expiry for order: raw="${selectedExpiry}" normalized="${orderData.expiry}"`);
      }

      const optionActions = [
        'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE',
        'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE',
        'CLOSE_ALL_CE', 'CLOSE_ALL_PE'
      ];
      if (tradeMode === 'OPTIONS' && optionActions.includes(action)) {
        orderData.optionsLeg = optionsLeg;
      }

      if (tradeMode === 'OPTIONS') {
        orderData.operatingMode = operatingMode;
        orderData.strikePolicy = strikePolicy;
        orderData.stepLots = stepLots;
        console.log('[QuickOrder] Added Buyer/Writer settings:', {
          operatingMode,
          strikePolicy,
          stepLots,
        });
      }

      console.log('[QuickOrder] Final order data being sent to backend:', {
        payload: orderData,
        symbol,
        exchange,
      });

      const actionButtons = document.querySelectorAll(`#expansion-content-${symbolId} .btn-quick-action`);
      actionButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.add('loading');
      });

      const response = await api.placeQuickOrder(orderData);

      if (response.data.summary) {
        const { successful, failed, total } = response.data.summary;
        if (successful > 0) {
          Utils.showToast(
            `Order placed: ${successful}/${total} successful`,
            failed > 0 ? 'warning' : 'success'
          );
        } else {
          Utils.showToast('All orders failed', 'error');
        }
      } else {
        Utils.showToast('Order placed successfully', 'success');
      }

      console.log('Quick order results:', response.data);

      if (response.data.results) {
        response.data.results.forEach((result, index) => {
          if (!result.success) {
            console.error(`[QuickOrder] Order ${index + 1} FAILED:`, {
              message: result.message,
              error: result.error,
              fullResult: result,
            });
          } else {
            console.log(`[QuickOrder] Order ${index + 1} SUCCESS:`, {
              ...result,
              backend_resolved_symbol: result.symbol || result.resolved_symbol,
            });
          }
        });
      }
    } catch (error) {
      console.error('Quick order failed:', error);
      Utils.showToast(`Order failed: ${error.message}`, 'error');
    } finally {
      const actionButtons = document.querySelectorAll(`#expansion-content-${symbolId} .btn-quick-action`);
      actionButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('loading');
      });
      this.refreshPositionsAfterOrder();
    }
  }

  /**
   * Derive trade capabilities from DOM row
   */
  getSymbolCapabilities(row) {
    const dataset = row?.dataset || {};
    const symbolType = (dataset.symbolType || '').toUpperCase();
    const parse = (value, fallback) => {
      if (value === undefined) return fallback;
      return value === '1' || value === 'true';
    };

    const defaults = {
      equity: true,
      futures: ['INDEX', 'EQUITY_FNO', 'FUTURES'].includes(symbolType),
      options: ['INDEX', 'EQUITY_FNO', 'OPTIONS'].includes(symbolType),
    };

    return {
      symbolType,
      equity: parse(dataset.tradableEquity, defaults.equity),
      futures: parse(dataset.tradableFutures, defaults.futures),
      options: parse(dataset.tradableOptions, defaults.options),
    };
  }
}

// Export singleton instance globally for inline handlers
if (window.quickOrder) {
  console.warn('[QuickOrder] Existing handler detected, reusing global instance');
} else {
  window.quickOrder = new QuickOrderHandler();
  console.log('[QuickOrder] Handler initialized', window.quickOrder);
}
