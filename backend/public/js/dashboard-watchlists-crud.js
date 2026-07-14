/**
 * Simplifyed Admin V2 - Dashboard: Watchlists - add/edit/search symbol CRUD modals, instance
 * assignment, delete watchlist.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Show add symbol modal with search
   */
  async showAddSymbolModal(watchlistId) {
    const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
    if (this.isBroadcastWatchlist(watchlist)) {
      Utils.showToast('Broadcast watchlists do not support symbols. Assign instances and use the webhook.', 'warning');
      return;
    }

    this.currentWatchlistId = watchlistId;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay symbol-search-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 700px;">
        <div class="modal-header">
          <h3>Add Symbol to Watchlist</h3>
        </div>
        <div class="modal-body">
          <!-- Symbol Search -->
          <div class="form-group">
            <label class="form-label">Search Symbol</label>
            <input type="text" id="symbol-search-input" class="form-input"
                   placeholder="Type symbol name (e.g., RELIANCE, NIFTY, BANKNIFTY)"
                   oninput="app.debounceSymbolSearch(this.value)">
          </div>

          <!-- Search Results -->
          <div id="symbol-search-results" class="mt-4"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="app.closeSymbolSearchModal()">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.symbolSearchModal = modal;
    document.getElementById('symbol-search-input').focus();
  }

  closeSymbolSearchModal() {
    const modal = this.symbolSearchModal || document.querySelector('.symbol-search-modal');
    if (modal) {
      modal.remove();
    }
    this.symbolSearchModal = null;
  }

  /**
   * Debounce symbol search
   */
  debounceSymbolSearch(query) {
    clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.searchSymbols(query), 300);
  }

  /**
   * Search symbols with classification
   */
  async searchSymbols(query) {
    if (!query || query.length < 2) {
      document.getElementById('symbol-search-results').innerHTML = '';
      return;
    }

    const resultsContainer = document.getElementById('symbol-search-results');
    resultsContainer.innerHTML = '<p class="text-neutral-600">Searching...</p>';

    try {
      const response = await api.searchSymbols(query);
      const results = response.data;

      if (results.length === 0) {
        resultsContainer.innerHTML = '<p class="text-neutral-600">No results found</p>';
        return;
      }

      const enrichedResults = results.map(sym => ({
        ...sym,
        underlying_symbol: sym.underlying_symbol || sym.name || sym.symbol,
      }));

      resultsContainer.innerHTML = `
        <div class="space-y-2">
          <p class="text-sm text-neutral-700 font-semibold">${results.length} results found:</p>
          <div class="max-h-96 overflow-y-auto space-y-2">
              ${enrichedResults.map(sym => `
              <div class="p-3 border rounded cursor-pointer hover:bg-neutral-100"
                   data-symbol="${encodeURIComponent(JSON.stringify(sym))}"
                   onclick="app.selectSymbol(this.dataset.symbol)">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="font-semibold">${Utils.escapeHTML(sym.tradingsymbol || sym.symbol)}</span>
                    <span class="text-sm text-neutral-600 ml-2">${Utils.escapeHTML(sym.exchange)}</span>
                  </div>
                  <span class="badge ${this.getSymbolTypeBadgeClass(sym.symbol_type)}">
                    ${sym.symbol_type}
                  </span>
                </div>
                ${sym.name ? `<p class="text-sm text-neutral-600 mt-1">${Utils.escapeHTML(sym.name)}</p>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    } catch (error) {
      resultsContainer.innerHTML = `<p class="text-error">Search failed: ${error.message}</p>`;
    }
  }

  /**
   * Select symbol from search results and open configuration
   */
  selectSymbol(encodedSymbol) {
    let symbolData;
    try {
      symbolData = JSON.parse(decodeURIComponent(encodedSymbol));
    } catch (error) {
      console.error('Failed to decode symbol', error);
      Utils.showToast('Failed to parse selected symbol', 'error');
      return;
    }

    symbolData.underlying_symbol = symbolData.underlying_symbol || symbolData.name || symbolData.symbol;

    this.pendingSymbolData = symbolData;
    this.closeSymbolSearchModal();
    this.showSymbolConfigModal(symbolData);
  }

  getSymbolTradableDefaults(symbolData) {
    const type = (symbolData.symbol_type || '').toUpperCase();
    return {
      equity:
        symbolData.tradable_equity === true ||
        type === 'EQUITY' ||
        type === 'EQUITY_FNO' ||
        type === 'UNKNOWN',
      futures:
        symbolData.tradable_futures === true ||
        type === 'FUTURES' ||
        type === 'EQUITY_FNO' ||
        type === 'INDEX',
      options:
        symbolData.tradable_options === true ||
        type === 'OPTIONS' ||
        type === 'INDEX',
    };
  }

  showSymbolConfigModal(symbolData, options = {}) {
    const defaults = this.getSymbolTradableDefaults(symbolData);
    const mode = options.mode || 'add';
    const watchlistId = options.watchlistId || this.currentWatchlistId;
    const symbolId = options.symbolId || symbolData.id || null;
    this.symbolConfigContext = { mode, watchlistId, symbolId };
    this.pendingSymbolData = symbolData;

    const tradableEquityChecked =
      symbolData.tradable_equity !== undefined
        ? Boolean(symbolData.tradable_equity)
        : defaults.equity;
    const tradableFuturesChecked =
      symbolData.tradable_futures !== undefined
        ? Boolean(symbolData.tradable_futures)
        : defaults.futures;
    const tradableOptionsChecked =
      symbolData.tradable_options !== undefined
        ? Boolean(symbolData.tradable_options)
        : defaults.options;

    const autoExitValue = (field) => {
      const value = symbolData[field];
      return value !== undefined && value !== null ? value : '';
    };
    const formatAutoExitValue = (field) => {
      const raw = autoExitValue(field);
      if (raw === '') return '';
      return Utils.escapeHTML(String(raw));
    };
    const limitBufferRaw = symbolData.limit_buffer_points;
    const limitBufferValue =
      limitBufferRaw !== undefined && limitBufferRaw !== null
        ? Utils.escapeHTML(String(limitBufferRaw))
        : '';

    const autoExitFieldsHtml = this.autoExitModes
      .map((modeConfig) => `
        <div class="border rounded-lg p-3 modal-sub-panel shadow-sm">
          <div class="text-sm font-semibold mb-2">${modeConfig.label} auto exits</div>
        <div class="grid gap-2 sm:grid-cols-4">
          <div class="form-group">
            <label class="form-label">Target (points)</label>
            <input type="number" name="target_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`target_points_${modeConfig.key}`)}"
                   placeholder="e.g., 20">
          </div>
          <div class="form-group">
            <label class="form-label">Stop loss (points)</label>
            <input type="number" name="stoploss_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`stoploss_points_${modeConfig.key}`)}"
                   placeholder="e.g., 15">
          </div>
          <div class="form-group">
            <label class="form-label">Trailing SL (points)</label>
            <input type="number" name="trailing_stoploss_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`trailing_stoploss_points_${modeConfig.key}`)}"
                   placeholder="e.g., 10">
          </div>
          <div class="form-group">
            <label class="form-label">Trail activation (points)</label>
            <input type="number" name="trailing_activation_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`trailing_activation_points_${modeConfig.key}`)}"
                   placeholder="e.g., 0">
          </div>
        </div>
        </div>
      `)
      .join('');
    const modalTitle = mode === 'edit' ? 'Edit Symbol Configuration' : 'Configure Symbol';
    const saveLabel = mode === 'edit' ? 'Save Changes' : 'Add Symbol';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 560px;">
        <div class="modal-header">
          <h3>${modalTitle}</h3>
        </div>
        <div class="modal-body">
          <p class="text-sm text-neutral-600 mb-4">
            Choose which trade modes should be enabled for <strong>${Utils.escapeHTML(symbolData.tradingsymbol || symbolData.symbol)}</strong>.
          </p>
          <form id="symbol-config-form" class="space-y-4">
            <div class="p-3 border rounded-lg modal-section-bg">
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-semibold">${Utils.escapeHTML(symbolData.tradingsymbol || symbolData.symbol)}</p>
                  <p class="text-sm text-neutral-600">${Utils.escapeHTML(symbolData.exchange || '')}</p>
                </div>
                <span class="badge ${this.getSymbolTypeBadgeClass(symbolData.symbol_type || 'UNKNOWN')}">
                  ${(symbolData.symbol_type || 'UNKNOWN').toUpperCase()}
                </span>
              </div>
            </div>

            <div class="space-y-3">
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer modal-selectable-item">
                <input type="checkbox" name="tradable_equity" ${tradableEquityChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Direct Trading</p>
                  <p class="text-sm text-neutral-600">Use BUY/SELL/EXIT buttons directly for this symbol (spot, futures, or options).</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer modal-selectable-item">
                <input type="checkbox" name="tradable_futures" ${tradableFuturesChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Futures Trading</p>
                  <p class="text-sm text-neutral-600">Route BUY/SELL/EXIT to futures contracts.</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer modal-selectable-item">
                <input type="checkbox" name="tradable_options" ${tradableOptionsChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Options Trading</p>
                  <p class="text-sm text-neutral-600">Show the documented Options workflow.</p>
                </div>
              </label>
            </div>

            <div class="form-group">
              <label class="form-label">Underlying Symbol (for derivatives)</label>
              <input type="text" name="underlying_symbol" class="form-input"
                     value="${Utils.escapeHTML(symbolData.underlying_symbol || symbolData.symbol || '')}"
                     placeholder="e.g., NIFTY, BANKNIFTY">
              <p class="text-xs text-neutral-500 mt-1">
                Used to resolve futures/options via the instruments cache or option-chain API.
              </p>
            </div>
            <div class="form-group">
              <label class="form-label">Limit buffer (points)</label>
              <input type="number" name="limit_buffer_points" class="form-input"
                     step="0.01" min="0" value="${limitBufferValue}"
                     placeholder="e.g., 1.5">
              <p class="text-xs text-neutral-500 mt-1">
                Added/subtracted from bid/ask or LTP when placing LIMIT orders.
              </p>
            </div>
            <div class="border rounded-lg modal-section-bg p-4 space-y-3">
              <p class="text-sm font-semibold text-neutral-600">
                Optional auto-exit thresholds (points)
              </p>
              <div class="space-y-3">
                ${autoExitFieldsHtml}
              </div>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="app.cancelSymbolConfig()">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.confirmAddSymbol()">
            ${saveLabel}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.symbolConfigModal = modal;
  }

  async showEditSymbolModal(watchlistId, symbolId) {
    try {
      const response = await api.getWatchlistSymbols(watchlistId);
      const symbol = response.data.find((row) => row.id === symbolId);
      if (!symbol) {
        throw new Error('Symbol not found in this watchlist');
      }
      this.currentWatchlistId = watchlistId;
      this.pendingSymbolData = symbol;
      this.showSymbolConfigModal(symbol, {
        mode: 'edit',
        watchlistId,
        symbolId,
      });
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  cancelSymbolConfig() {
    if (this.symbolConfigModal) {
      this.symbolConfigModal.remove();
      this.symbolConfigModal = null;
    }
    this.pendingSymbolData = null;
    this.symbolConfigContext = null;
  }

  async confirmAddSymbol() {
    const form = document.getElementById('symbol-config-form');
    if (!form || !this.pendingSymbolData) {
      Utils.showToast('No symbol selected', 'error');
      return;
    }

    const tradableEquity = form.tradable_equity.checked;
    const tradableFutures = form.tradable_futures.checked;
    const tradableOptions = form.tradable_options.checked;
    const underlyingSymbol =
      form.underlying_symbol.value.trim() ||
      this.pendingSymbolData.underlying_symbol ||
      this.pendingSymbolData.name ||
      this.pendingSymbolData.tradingsymbol ||
      this.pendingSymbolData.symbol;

    const readAutoExitValue = (fieldName) => {
      if (!form[fieldName]) {
        return null;
      }
      const value = form[fieldName].value.trim();
      if (!value) {
        return null;
      }
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const limitBufferRaw = form.limit_buffer_points?.value.trim();
    const limitBufferPoints = limitBufferRaw ? parseFloat(limitBufferRaw) : 0;

    const autoExitData = {};
    this.autoExitModes.forEach((mode) => {
      autoExitData[`target_points_${mode.key}`] = readAutoExitValue(`target_points_${mode.key}`);
      autoExitData[`stoploss_points_${mode.key}`] = readAutoExitValue(`stoploss_points_${mode.key}`);
      autoExitData[`trailing_stoploss_points_${mode.key}`] =
        readAutoExitValue(`trailing_stoploss_points_${mode.key}`);
      autoExitData[`trailing_activation_points_${mode.key}`] =
        readAutoExitValue(`trailing_activation_points_${mode.key}`);
    });

    const context = this.symbolConfigContext || {};
    const targetWatchlistId = context.watchlistId || this.currentWatchlistId;

    try {
      Utils.showToast(
        context.mode === 'edit' ? 'Saving changes...' : 'Adding symbol...',
        'info'
      );
      const payload = {
        symbol: this.pendingSymbolData.tradingsymbol || this.pendingSymbolData.symbol,
        exchange: this.pendingSymbolData.exchange,
        token: this.pendingSymbolData.token,
        lotsize: this.pendingSymbolData.lotsize || this.pendingSymbolData.lot_size || 1,
        symbol_type: this.pendingSymbolData.symbol_type,
        expiry: this.pendingSymbolData.expiry || null,
        strike: this.pendingSymbolData.strike || null,
        option_type: this.pendingSymbolData.option_type || null,
        instrumenttype: this.pendingSymbolData.instrumenttype || null,
        name: this.pendingSymbolData.name || null,
        tick_size: this.pendingSymbolData.tick_size || this.pendingSymbolData.tickSize || null,
        brsymbol: this.pendingSymbolData.brsymbol || null,
        brexchange: this.pendingSymbolData.brexchange || null,
        tradable_equity: tradableEquity,
        tradable_futures: tradableFutures,
        tradable_options: tradableOptions,
        underlying_symbol: underlyingSymbol,
        limit_buffer_points: Number.isFinite(limitBufferPoints) ? limitBufferPoints : 0,
        ...autoExitData,
      };

      if (context.mode === 'edit' && context.symbolId) {
        await api.updateSymbol(targetWatchlistId, context.symbolId, payload);
        Utils.showToast('Symbol updated successfully', 'success');
      } else {
        await api.addSymbol(targetWatchlistId, payload);
        Utils.showToast('Symbol added successfully', 'success');
      }

      if (this.symbolConfigModal) {
        this.symbolConfigModal.remove();
        this.symbolConfigModal = null;
      }
      this.pendingSymbolData = null;
      this.symbolConfigContext = null;

      await this.renderWatchlistsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Remove symbol from watchlist
   */
  async removeSymbol(watchlistId, symbolId) {
    const confirmed = await Utils.confirm(
      'Remove this symbol from the watchlist?',
      'Confirm Remove'
    );

    if (!confirmed) return;

    try {
      await api.removeSymbol(watchlistId, symbolId);
      // Clear quote cache for this symbol
      const cacheKey = `${watchlistId}_${symbolId}`;
      this.quoteCache.delete(cacheKey);
      Utils.showToast('Symbol removed', 'success');
      await this.renderWatchlistsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Manage watchlist instances
   */
  async manageWatchlistInstances(watchlistId) {
    // Fetch watchlist and all instances
    const [watchlistResponse, instancesResponse] = await Promise.all([
      api.getWatchlistById(watchlistId),
      api.getInstances(),
    ]);

    const watchlist = watchlistResponse.data;
    const allInstances = instancesResponse.data;
    const assignedIds = new Set((watchlist.instances || []).map(i => i.id));

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Manage Instances - ${Utils.escapeHTML(watchlist.name)}</h3>
        </div>
        <div class="modal-body">
          <p class="text-sm text-neutral-700 mb-4">
            Select instances to assign to this watchlist:
          </p>
          <div class="space-y-2" id="instance-checkboxes">
            ${allInstances.map(inst => `
              <label class="flex items-center gap-3 p-2 border rounded modal-selectable-item cursor-pointer">
                <input type="checkbox"
                       class="instance-checkbox"
                       data-instance-id="${inst.id}"
                       ${assignedIds.has(inst.id) ? 'checked' : ''}>
                <div class="flex-1">
                  <span class="font-semibold">${Utils.escapeHTML(inst.name)}</span>
                  <span class="text-sm text-neutral-600 ml-2">(${Utils.escapeHTML(inst.broker || 'N/A')})</span>
                </div>
                <span class="badge badge-${inst.health_status === 'healthy' ? 'success' : 'warning'}">
                  ${inst.health_status || 'unknown'}
                </span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.submitInstanceAssignments(${watchlistId})">
            Save Assignments
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  /**
   * Submit instance assignments
   */
  async submitInstanceAssignments(watchlistId) {
    try {
      const checkboxes = document.querySelectorAll('.instance-checkbox');
      const selectedIds = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.instanceId));

      // Fetch current assignments
      const watchlistResponse = await api.getWatchlistById(watchlistId);
      const currentIds = new Set((watchlistResponse.data.instances || []).map(i => i.id));

      // Determine adds and removes
      const toAdd = selectedIds.filter(id => !currentIds.has(id));
      const toRemove = Array.from(currentIds).filter(id => !selectedIds.includes(id));

      // Execute assignments
      for (const instanceId of toAdd) {
        await api.assignInstance(watchlistId, instanceId);
      }

      for (const instanceId of toRemove) {
        await api.unassignInstance(watchlistId, instanceId);
      }

      Utils.showToast('Instance assignments updated', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.renderWatchlistsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Delete watchlist
   */
  async deleteWatchlist(watchlistId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to delete this watchlist?',
      'Confirm Delete'
    );

    if (!confirmed) return;

    try {
      await api.deleteWatchlist(watchlistId);
      Utils.showToast('Watchlist deleted', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

}.prototype));
