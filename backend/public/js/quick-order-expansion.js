/**
 * Simplifyed Admin V2 - Quick Order: row-expansion / caching.
 */

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
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

        // Best-effort cache warmup for derivatives/expiries to reduce first-click latency
        this.warmExpansionCaches(watchlistId, symbolId).catch(() => {});

        // Load expansion content if not already loaded
        this.loadExpansionContent(watchlistId, symbolId);
      }
    } catch (error) {
      console.error('Failed to toggle watchlist symbol expansion', { watchlistId, symbolId, error });
      if (window.Utils && typeof Utils.showToast === 'function') {
        Utils.showToast(`Failed to show trading controls: ${Utils.escapeHTML(error.message)}`, 'error');
      }
    }
  }

  /**
   * Best-effort warmup of expiry/option/futures data to reduce first-click latency
   */
  async warmExpansionCaches(watchlistId, symbolId) {
    const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
    if (!symbolRow) return;

    const symbol = symbolRow.dataset.symbol;
    const exchange = symbolRow.dataset.exchange;
    const rawUnderlying = symbolRow.dataset.underlying || symbol;
    const underlyingSymbol = this.extractUnderlying(rawUnderlying) || rawUnderlying;

    const capabilities = this.getSymbolCapabilities(symbolRow);
    const symbolType = capabilities.symbolType || (symbolRow.querySelector('.badge')?.textContent.trim() || 'UNKNOWN');
    const derivativeExchange = this.getDerivativeExchange(exchange, symbolType);

    // Warm futures/options expiries cache - skip when the symbol is itself the tradable
    // contract (dated future or perpetual), same as loadExpansionContent below
    const instrumentTypes = [];
    if (capabilities.futures && symbolType !== 'FUTURES') instrumentTypes.push('FUT');
    if (capabilities.options) instrumentTypes.push('CE,PE');

    let expiries = [];
    if (instrumentTypes.length > 0) {
      try {
        const expResp = await api.getExpiry(underlyingSymbol, {
          exchange: derivativeExchange,
          instrumentTypes,
        });
        if (Array.isArray(expResp?.data)) {
          expiries = expResp.data;
          this.availableExpiries.set(symbolId, expiries);
        }
      } catch (_) {
        // best effort only
      }
    }

    // If options supported and an expiry is available, warm option preview cache (ATM)
    if (capabilities.options && expiries.length > 0) {
      const firstExpiry = this.normalizeExpiryDate(expiries[0]);
      try {
        await api.getQuickOrderOptionsPreview({
          symbolId,
          expiry: firstExpiry,
          optionsLeg: 'ATM',
        });
        // Pre-store selected expiry to avoid re-fetch
        if (!this.selectedExpiries.has(symbolId)) {
          this.selectedExpiries.set(symbolId, firstExpiry);
        }
      } catch (_) {
        // best effort only
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
    const isMcx = (exchange || '').toUpperCase() === 'MCX';

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

      if (tradeMode === 'FUTURES' && symbolType === 'FUTURES') {
        // The watchlist symbol is itself the tradable contract (a dated future or a
        // perpetual like crypto PERPFUT) - there's no separate expiry-dated series to
        // pick from, so skip the expiry lookup entirely.
        this.availableExpiries.set(symbolId, expiries);
      } else if (tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') {
        // Use NFO exchange for derivatives (futures/options)
        // INDEX and EQUITY symbols need to use NFO/BFO for their derivatives
        const derivativeExchange = this.getDerivativeExchange(exchange, symbolType);
        expiries = await this.fetchAvailableExpiries(expiryUnderlying, derivativeExchange, tradeMode, exchange);
        this.availableExpiries.set(symbolId, expiries);
      }

      // Get or set the selected expiry (always store in YYYY-MM-DD format)
      let selectedExpiry = this.selectedExpiries.get(symbolId);
      if (!selectedExpiry && expiries.length > 0) {
        // Use first expiry, ensure it's normalized to YYYY-MM-DD
        selectedExpiry = this.normalizeExpiryDate(expiries[0]);
        this.selectedExpiries.set(symbolId, selectedExpiry);
      }

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
        isMcx,
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
      contentDiv.innerHTML = `<p class="text-error text-sm">Failed to load trading controls: ${Utils.escapeHTML(error.message)}</p>`;
    }
  }
}.prototype));
