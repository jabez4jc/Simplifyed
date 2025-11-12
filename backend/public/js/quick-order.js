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
  renderTradingControls({ watchlistId, symbolId, symbol, exchange, symbolType, tradeMode, optionsLeg, quantity }) {
    const availableModes = this.getAvailableTradeModes(symbolType);
    const showOptionsLeg = tradeMode === 'OPTIONS';

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
                  onclick="quickOrder.selectTradeMode(${symbolId}, '${mode}')"
                  ${!this.isModeAvailable(mode, symbolType) ? 'disabled' : ''}
                  title="${this.getTradeModeTooltip(mode, symbolType)}">
                  ${mode}
                </button>
              `).join('')}
            </div>
          </div>

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
          <button class="btn-quick-action btn-exit"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT')">
            EXIT
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
    this.selectedTradeModes.set(symbolId, mode);

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
   * Update quantity
   */
  updateQuantity(symbolId, quantity) {
    this.defaultQuantities.set(symbolId, quantity);
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

      // Validate quantity
      if (!quantity || quantity <= 0) {
        Utils.showToast('Quantity must be greater than 0', 'error');
        return;
      }

      // Build order request
      const orderData = {
        symbol,
        exchange,
        action,
        tradeMode,
        quantity,
      };

      // Add options leg for OPTIONS mode with option actions
      if (tradeMode === 'OPTIONS' && ['BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE'].includes(action)) {
        orderData.optionsLeg = optionsLeg;
      }

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
