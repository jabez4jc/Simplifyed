/**
 * Simplifyed Admin V2 - Quick Order: trade-mode/strike/leg selectors and operating-mode/product/
 * expiry selectors (two small selector clusters, combined - both are simple selector-state
 * setters over the shared constructor Maps).
 */

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
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
    // debug: removed noisy log

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
    this.strikeOffsetSnapshots.delete(symbolId);
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
   * Build user-facing label for strike offsets with ATM context
   */
  getStrikeOptionLabel(offset, strikePreview = null) {
    const baseLabels = {
      ITM3: 'ITM 3',
      ITM2: 'ITM 2',
      ITM1: 'ITM 1',
      ATM: 'ATM',
      OTM1: 'OTM 1',
      OTM2: 'OTM 2',
      OTM3: 'OTM 3',
    };

    const base = baseLabels[offset] || offset;
    if (!strikePreview || !strikePreview.offsets || !strikePreview.offsets[offset]) {
      if (offset === 'ATM' && strikePreview?.atmStrike != null) {
        return `${base} - ${this._formatStrikeValue(strikePreview.atmStrike)}`;
      }
      return base;
    }

    const entry = strikePreview.offsets[offset];
    const ceStrike = this._formatStrikeValue(entry.ceStrike);
    const peStrike = this._formatStrikeValue(entry.peStrike);

    if (offset === 'ATM') {
      const atmVal = this._formatStrikeValue(strikePreview.atmStrike ?? entry.ceStrike ?? entry.peStrike);
      return `${base} - ${atmVal}`;
    }

    return `${base} - (CE = ${ceStrike}, PE = ${peStrike})`;
  }

  _formatStrikeValue(value) {
    if (value == null || Number.isNaN(Number(value))) {
      return '-';
    }
    return Utils.formatNumber(value);
  }

  /**
   * Update strike dropdown labels in-place when preview refreshes
   */
  refreshStrikeDropdownLabels(symbolId) {
    const strikePreview = this.strikeOffsetSnapshots.get(symbolId) || null;
    const selectEl = document.querySelector(`select[data-symbol-id="${symbolId}"][data-role="strike-select"]`);
    if (!selectEl) return;

    Array.from(selectEl.options).forEach((opt) => {
      const offset = (opt.value || '').toUpperCase();
      opt.textContent = this.getStrikeOptionLabel(offset, strikePreview);
    });
  }
  /**
   * Select operating mode (BUYER or WRITER)
   */
  selectOperatingMode(symbolId, mode) {
    // debug: removed noisy log
    this.operatingModes.set(symbolId, mode);
    // debug: removed noisy log
    this.reloadExpansionContent(symbolId);
  }

  /**
   * Select strike policy (FLOAT_OFS or ANCHOR_OFS)
   */
  selectStrikePolicy(symbolId, policy) {
    // debug: removed noisy log
    this.strikePolicies.set(symbolId, policy);

    // Clear anchored strikes if switching from ANCHOR_OFS to FLOAT_OFS
    if (policy === 'FLOAT_OFS') {
      // debug: removed noisy log
      // TODO: Clear anchored strikes from database if needed
    }

    this.reloadExpansionContent(symbolId);
  }

  selectProduct(symbolId, product) {
    // debug: removed noisy log
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
    // debug: removed noisy log
    this.stepLots.set(symbolId, validatedValue);
    this.reloadExpansionContent(symbolId);
  }

  /**
   * Select expiry date
   */
  selectExpiry(symbolId, expiry) {
    // Ensure expiry is always stored in YYYY-MM-DD format (API format)
    const normalizedExpiry = this.normalizeExpiryDate(expiry);
    // debug: removed noisy log
    this.selectedExpiries.set(symbolId, normalizedExpiry);
    this.strikeOffsetSnapshots.delete(symbolId);
    this.refreshStrikeDropdownLabels(symbolId);
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

}.prototype));
