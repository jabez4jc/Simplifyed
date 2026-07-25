/**
 * Simplifyed Admin V2 - Quick Order: trading-controls rendering + action buttons.
 */

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
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
  renderTradingControls({ watchlistId, symbolId, symbol, exchange, symbolType, tradeMode, capabilities = {}, availableModes = [], optionsLeg, quantity, expiries, selectedExpiry, selectedProduct, operatingMode, strikePolicy, writerGuard, isMcx = false }) {
    const showOptionsLeg = tradeMode === 'OPTIONS' && capabilities.options;
    // A watchlist symbol that's already itself the tradable contract (a dated future or a
    // crypto perpetual) has no separate expiry-dated series to pick - the anchor symbol IS
    // the contract, so there's nothing to show here.
    const showExpirySelector =
      (tradeMode === 'FUTURES' && capabilities.futures && symbolType !== 'FUTURES') ||
      (tradeMode === 'OPTIONS' && capabilities.options);
    const showOperatingMode = tradeMode === 'OPTIONS' && capabilities.options;
    const showStrikePolicy = tradeMode === 'OPTIONS' && capabilities.options;

    // debug removed

    const renderField = (label, help, controlHtml, fullWidth = false) => `
      <div class="compact-field ${fullWidth ? 'compact-field-full' : ''}">
        <label class="compact-field-label">
          ${label}
          ${help ? `
            <button type="button" class="field-help-compact" title="${help}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <circle cx="12" cy="16" r="0.5"></circle>
              </svg>
            </button>
          ` : ''}
        </label>
        <div class="compact-field-control">
          ${controlHtml}
        </div>
      </div>
    `;

    const tradeModeField = renderField(
      'Mode',
      'Choose whether this quick order fires direct equity orders, futures contracts, or managed options legs.',
      `<div class="trade-mode-selector-compact">
        ${availableModes.map(mode => `
          <button
            class="btn-mode-compact ${mode === tradeMode ? 'active' : ''} ${!this.isModeAvailable(mode, symbolType, capabilities) ? 'disabled' : ''}"
            data-mode="${mode}"
            data-symbol-id="${symbolId}"
            onclick="quickOrder.selectTradeMode(${symbolId}, '${mode}')"
            ${!this.isModeAvailable(mode, symbolType, capabilities) ? 'disabled' : ''}
            title="${this.getTradeModeTooltip(mode, symbolType, capabilities)}">
            ${this.getTradeModeLabel(mode)}
          </button>
        `).join('')}
      </div>`,
      true
    );

    const expiryField = showExpirySelector
      ? renderField(
          'Expiry',
          'Pick the contract month you want to trade.',
          expiries && expiries.length > 0
            ? `<select
                class="select-compact"
                data-symbol-id="${symbolId}"
                onchange="quickOrder.selectExpiry(${symbolId}, this.value)">
                ${expiries.map(expiry => `
                  <option value="${expiry}" ${expiry === selectedExpiry ? 'selected' : ''}>
                    ${this.formatExpiryDate(expiry)}
                  </option>
                `).join('')}
              </select>`
            : `<p class="text-xs text-warning">No expiries available</p>`
        )
      : '';

    const strikePreview = this.strikeOffsetSnapshots.get(symbolId) || null;

    const optionsLegField = showOptionsLeg
      ? renderField(
          'Strike',
          'Shift the strike relative to ATM.',
          `<div class="leg-chain-row">
            <select
            class="select-compact"
            data-role="strike-select"
            data-symbol-id="${symbolId}"
            onchange="quickOrder.selectOptionsLeg(${symbolId}, this.value)">
            <option value="ITM3" ${optionsLeg === 'ITM3' ? 'selected' : ''}>${this.getStrikeOptionLabel('ITM3', strikePreview)}</option>
            <option value="ITM2" ${optionsLeg === 'ITM2' ? 'selected' : ''}>${this.getStrikeOptionLabel('ITM2', strikePreview)}</option>
            <option value="ITM1" ${optionsLeg === 'ITM1' ? 'selected' : ''}>${this.getStrikeOptionLabel('ITM1', strikePreview)}</option>
            <option value="ATM" ${optionsLeg === 'ATM' ? 'selected' : ''}>${this.getStrikeOptionLabel('ATM', strikePreview)}</option>
            <option value="OTM1" ${optionsLeg === 'OTM1' ? 'selected' : ''}>${this.getStrikeOptionLabel('OTM1', strikePreview)}</option>
            <option value="OTM2" ${optionsLeg === 'OTM2' ? 'selected' : ''}>${this.getStrikeOptionLabel('OTM2', strikePreview)}</option>
            <option value="OTM3" ${optionsLeg === 'OTM3' ? 'selected' : ''}>${this.getStrikeOptionLabel('OTM3', strikePreview)}</option>
            </select>
            <button class="btn-compact-secondary ${isMcx ? 'disabled' : ''}"
              ${isMcx ? 'disabled' : ''}
              title="${isMcx ? 'Option chain not available for MCX' : 'View live option chain'}"
              onclick="${isMcx ? 'return false;' : `quickOrder.showOptionChainModal(${symbolId})`}">
              Chain
            </button>
          </div>`
        )
      : '';

    const operatingModeField = showOperatingMode
      ? renderField(
          'Flow',
          'Buyer (long premium) or Writer (short premium).',
          `<div class="operating-mode-compact" role="group">
            <button
              class="btn-operating ${operatingMode === 'BUYER' ? 'active' : ''}"
              data-mode="BUYER"
              data-symbol-id="${symbolId}"
              onclick="quickOrder.selectOperatingMode(${symbolId}, 'BUYER')"
              title="Buyer Mode: BUY/REDUCE buttons">
              Buyer
            </button>
            <button
              class="btn-operating ${operatingMode === 'WRITER' ? 'active' : ''}"
              data-mode="WRITER"
              data-symbol-id="${symbolId}"
              onclick="quickOrder.selectOperatingMode(${symbolId}, 'WRITER')"
              title="Writer Mode: SELL/INCREASE buttons">
              Writer
            </button>
          </div>`
        )
      : '';

    const strikePolicyHint = strikePolicy === 'ANCHOR_OFS'
      ? 'Anchors the selected strike after the first order.'
      : 'Strikes float with ATM as it moves.';

    const strikePolicyField = showStrikePolicy
      ? renderField(
          'Policy',
          'How strikes migrate as ATM moves.',
          `<div class="flex flex-col gap-1">
            <select
              class="select-compact"
              data-symbol-id="${symbolId}"
              onchange="quickOrder.selectStrikePolicy(${symbolId}, this.value)">
              <option value="FLOAT_OFS" ${strikePolicy === 'FLOAT_OFS' ? 'selected' : ''}>
                FLOAT_OFS
              </option>
              <option value="ANCHOR_OFS" ${strikePolicy === 'ANCHOR_OFS' ? 'selected' : ''}>
                ANCHOR_OFS
              </option>
            </select>
            <span class="text-xs text-neutral-500">${strikePolicyHint}</span>
          </div>`
        )
      : '';

    const quantityField = renderField(
      'Qty',
      'Lots/contracts dispatched per click.',
      `<input
        type="number"
        class="input-compact"
        value="${quantity}"
        min="1"
        step="1"
        data-symbol-id="${symbolId}"
        onchange="quickOrder.updateQuantity(${symbolId}, parseInt(this.value))"
        title="Number of lots per order">`
    );

    const isDerivativeMode = tradeMode === 'FUTURES' || tradeMode === 'OPTIONS' || (symbolType === 'FUTURES' || symbolType === 'OPTIONS');
    const productField = renderField(
      'Product',
      isDerivativeMode ? 'Futures/Options use NRML.' : 'Product type for all instances.',
      isDerivativeMode
        ? `<select class="select-compact" disabled>
             <option value="NRML" selected>NRML</option>
           </select>`
        : `<select class="select-compact"
                data-symbol-id="${symbolId}"
                onchange="quickOrder.selectProduct(${symbolId}, this.value)">
             <option value="MIS" ${selectedProduct === 'MIS' ? 'selected' : ''}>MIS</option>
             <option value="NRML" ${selectedProduct === 'NRML' ? 'selected' : ''}>NRML</option>
             <option value="CNC" ${selectedProduct === 'CNC' ? 'selected' : ''}>CNC</option>
           </select>`
    );

    const futuresPreviewBlock = tradeMode === 'FUTURES' && capabilities.futures
      ? `
        <div
          class="preview-card-compact"
          id="futures-preview-${symbolId}"
          aria-live="polite">
          <p class="text-xs text-neutral-500">Select an expiry to view futures quote.</p>
        </div>
      `
      : '';

    const optionPreviewBlock = tradeMode === 'OPTIONS' && capabilities.options
      ? `
        <div
          class="preview-card-compact"
          id="option-preview-${symbolId}"
          aria-live="polite">
          <p class="text-xs text-neutral-500">Resolving option strikes…</p>
        </div>
      `
      : '';

    return `
      <div class="quick-order-panel-compact">
        <div class="quick-order-config-wrapper">
          <div class="quick-order-left-column">
            <div class="quick-order-config-compact">
              ${tradeModeField}
              ${expiryField}
              ${optionsLegField}
              ${operatingModeField}
              ${strikePolicyField}
              ${quantityField}
              ${productField}
            </div>
            <div class="quick-order-preview">
              ${futuresPreviewBlock}
              ${optionPreviewBlock}
            </div>
          </div>
          <div class="quick-order-actions-compact">
            ${this.renderActionButtons(watchlistId, symbolId, symbol, exchange, tradeMode, operatingMode, strikePolicy, quantity, selectedExpiry, optionsLeg)}
          </div>
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
      // CE Column - all CE buttons stacked
      let ceButtons = '';
      if (operatingMode === 'BUYER') {
        ceButtons = `
          <button class="btn-action-compact btn-buy-ce btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Add CE longs at ${optionsLeg} strike">
            BUY CE
          </button>
          <button class="btn-action-compact btn-reduce-ce btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'REDUCE_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Reduce CE longs">
            REDUCE CE
          </button>
          <button class="btn-action-compact btn-close-all-ce btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'CLOSE_ALL_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Close all CE positions">
            CLOSE CE
          </button>
        `;
      } else {
        ceButtons = `
          <button class="btn-action-compact btn-sell-ce btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Open CE shorts at ${optionsLeg} strike">
            SELL CE
          </button>
          <button class="btn-action-compact btn-increase-ce btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'INCREASE_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Cover CE shorts">
            INCREASE CE
          </button>
          <button class="btn-action-compact btn-close-all-ce btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'CLOSE_ALL_CE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Close all CE positions">
            CLOSE CE
          </button>
        `;
      }

      // PE Column - all PE buttons stacked
      let peButtons = '';
      if (operatingMode === 'BUYER') {
        peButtons = `
          <button class="btn-action-compact btn-buy-pe btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Add PE longs at ${optionsLeg} strike">
            BUY PE
          </button>
          <button class="btn-action-compact btn-reduce-pe btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'REDUCE_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Reduce PE longs">
            REDUCE PE
          </button>
          <button class="btn-action-compact btn-close-all-pe btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'CLOSE_ALL_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Close all PE positions">
            CLOSE PE
          </button>
        `;
      } else {
        peButtons = `
          <button class="btn-action-compact btn-sell-pe btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Open PE shorts at ${optionsLeg} strike">
            SELL PE
          </button>
          <button class="btn-action-compact btn-increase-pe btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'INCREASE_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Cover PE shorts">
            INCREASE PE
          </button>
          <button class="btn-action-compact btn-close-all-pe btn-outline"
                  onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'CLOSE_ALL_PE')"
                  ${!isConfigured ? 'disabled' : ''}
                  title="Close all PE positions">
            CLOSE PE
          </button>
        `;
      }

      return `
        <div class="action-buttons-3col">
          <div class="action-column">
            <div class="action-column-label">CALL</div>
            ${ceButtons}
          </div>
          <div class="action-column">
            <div class="action-column-label">PUT</div>
            ${peButtons}
          </div>
          <div class="action-column-exit">
            <button class="btn-action-exit btn-exit-all btn-outline"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT_ALL')"
                    ${!isConfigured ? 'disabled' : ''}
                    title="Exit all positions (CE & PE)">
              EXIT ALL
            </button>
          </div>
        </div>
      `;
    } else {
      // EQUITY or FUTURES mode - 3 column layout
      return `
        <div class="action-buttons-3col">
          <div class="action-column">
            <div class="action-column-label">LONG</div>
            <button class="btn-action-compact btn-buy btn-outline"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'BUY')">
              BUY
            </button>
            <button class="btn-action-compact btn-sell btn-outline"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SELL')">
              SELL
            </button>
          </div>
          <div class="action-column">
            <div class="action-column-label">SHORT</div>
            <button class="btn-action-compact btn-short btn-outline"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'SHORT')">
              SHORT
            </button>
            <button class="btn-action-compact btn-cover btn-outline"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'COVER')">
              COVER
            </button>
          </div>
          <div class="action-column-exit">
            <button class="btn-action-exit btn-exit btn-outline"
                    onclick="quickOrder.placeOrder(${watchlistId}, ${symbolId}, 'EXIT')">
              EXIT
            </button>
          </div>
        </div>
      `;
    }
  }
}.prototype));
