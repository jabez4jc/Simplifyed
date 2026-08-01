/**
 * Simplifyed Admin V2 - Dashboard: Watchlists - symbol quote render, polling/streaming, and
 * the positions-polling trio (kept here since it's entangled with the quote-refresh cycle).
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render symbols for a watchlist
   */
  async renderWatchlistSymbols(watchlistId) {
    try {
      const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
      if (this.isBroadcastWatchlist(watchlist)) {
        return await this.renderBroadcastWatchlist(watchlistId);
      }
      if (this.isStrategyWatchlist(watchlist)) {
        // No symbols/quotes to show here - the Strategies section (a sibling wrapper in
        // renderWatchlistCard) is this watchlist type's entire content.
        return '';
      }

      const response = await api.getWatchlistSymbols(watchlistId);
      const symbols = response.data;
      this.registerWatchlistSymbols(watchlistId, symbols);

      if (symbols.length === 0) {
        return '<p class="text-neutral-600 text-sm">No symbols added yet</p>';
      }

      return `
        <div class="watchlist-feed-meta-compact" data-watchlist-meta="${watchlistId}">
          <span class="text-xs text-neutral-500">Quotes auto-refresh</span>
          <span class="text-xs text-neutral-500" data-watchlist-last-update="${watchlistId}">waiting…</span>
          <span class="text-xs text-neutral-500" data-watchlist-feed-source="${watchlistId}">—</span>
          <span class="text-xs text-neutral-500" data-watchlist-feed-coverage="${watchlistId}"></span>
        </div>
        <div class="watchlist-table-wrapper">
          <table class="watchlist-table-compact" id="watchlist-table-${watchlistId}">
            <thead>
              <tr>
                <th class="col-expand"></th>
                <th class="col-symbol">Symbol</th>
                <th class="col-exchange">Exch</th>
                <th class="col-type">Type</th>
                <th class="col-expiry">Expiry</th>
                <th class="col-strike">Strike</th>
                <th class="col-lot">Lot</th>
                <th class="col-ltp">LTP</th>
                <th class="col-change">Change</th>
                <th class="col-volume">Vol</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${Utils.renderCappedRows(symbols.map(sym => `
                <tr class="symbol-row-compact"
                    data-symbol-id="${sym.id}"
                    data-symbol="${Utils.escapeHTML(sym.symbol)}"
                    data-exchange="${Utils.escapeHTML(sym.exchange)}"
                    data-symbol-type="${Utils.escapeHTML(sym.symbol_type || 'UNKNOWN')}"
                    data-trading-symbol="${Utils.escapeHTML(sym.trading_symbol || sym.tradingsymbol || '')}"
                    data-tradable-equity="${sym.tradable_equity ? 1 : 0}"
                    data-tradable-futures="${sym.tradable_futures ? 1 : 0}"
                    data-tradable-options="${sym.tradable_options ? 1 : 0}"
                    data-underlying="${Utils.escapeHTML(sym.underlying_symbol || sym.name || sym.symbol)}">
                  <td class="col-expand">
                    <button
                      class="btn-expand-compact"
                      data-watchlist-id="${watchlistId}"
                      data-symbol-id="${sym.id}"
                      data-toggle-symbol="${sym.id}"
                      type="button"
                      title="Expand trading controls">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </td>
                  <td class="col-symbol">${Utils.escapeHTML(sym.symbol)}</td>
                  <td class="col-exchange">${Utils.escapeHTML(sym.exchange)}</td>
                  <td class="col-type">
                    <span class="badge-compact ${this.getSymbolTypeBadgeClass(sym.symbol_type || 'UNKNOWN')}">
                      ${sym.symbol_type || 'UNKNOWN'}
                    </span>
                  </td>
                  <td class="col-expiry">${sym.expiry ? Utils.escapeHTML(sym.expiry) : '-'}</td>
                  <td class="col-strike">${sym.strike ? sym.strike : '-'}</td>
                  <td class="col-lot">${sym.lot_size || sym.lotsize || 1}</td>
                  <td class="col-ltp ltp-cell" data-symbol-id="${sym.id}">
                    <span class="text-neutral-500">-</span>
                  </td>
                  <td class="col-change change-cell" data-symbol-id="${sym.id}">
                    <span class="text-neutral-500">-</span>
                  </td>
                  <td class="col-volume volume-cell" data-symbol-id="${sym.id}">
                    <span class="text-neutral-500">-</span>
                  </td>
                  <td class="col-actions">
                    <div class="actions-group">
                      <button class="btn-icon-table" onclick="app.showEditSymbolModal(${watchlistId}, ${sym.id})" title="Edit">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button class="btn-icon-table danger" onclick="app.removeSymbol(${watchlistId}, ${sym.id})" title="Remove">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
                <tr id="expansion-row-${sym.id}" class="expansion-row-compact" style="display: none;">
                  <td colspan="11" class="expansion-cell-compact">
                    <div id="expansion-content-${sym.id}" class="expansion-content" data-loaded="false">
                      <p class="text-neutral-500 text-sm">Loading...</p>
                    </div>
                  </td>
                </tr>
              `), { pageSize: 100, colspan: 11 })}
            </tbody>
          </table>
        </div>
      `;
    } catch (error) {
      const message = Utils.escapeHTML(error?.message || 'Unknown error');
      return `<p class="text-error">Failed to load symbols: ${message}</p>`;
    }
  }

  async showWsSubscriptions() {
    try {
      const res = await api.request('/telemetry/ws-subscriptions');
      const subs = res?.data || [];
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      const content = subs.map((s) => `
        <details class="border border-base-200 rounded-lg p-3 bg-base-100">
          <summary class="flex items-center justify-between gap-2 cursor-pointer">
            <div>
              <div class="font-semibold">${Utils.escapeHTML(s.instanceName || `Instance ${s.instanceId}`)}</div>
              <div class="text-xs text-neutral-500">${Utils.escapeHTML(s.websocketUrl || 'ws unavailable')}</div>
            </div>
            <div class="text-xs text-neutral-500">${s.subscriptionCount || 0} symbols · ${s.connected ? 'Connected' : 'Disconnected'}</div>
          </summary>
          ${s.symbols && s.symbols.length ? `
            <div class="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              ${s.symbols.slice(0, 200).map(sym => `<span class="badge badge-neutral">${Utils.escapeHTML(sym.exchange || '')}:${Utils.escapeHTML(sym.symbol || '')}</span>`).join('')}
            </div>
            ${s.symbols.length > 200 ? `<p class="text-xs text-neutral-500 mt-2">+${s.symbols.length - 200} more…</p>` : ''}
          ` : '<p class="text-xs text-neutral-500 mt-2">No symbols subscribed</p>'}
        </details>
      `).join('');

      modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
          <div class="modal-header">
            <h3>WebSocket Subscriptions</h3>
          </div>
          <div class="modal-body space-y-3" style="max-height: 70vh; overflow-y: auto;">
            ${content || '<p class="text-neutral-600 text-sm">No WebSocket subscriptions found.</p>'}
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">Close</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
    } catch (err) {
      Utils.showToast(err?.message || 'Failed to load WS subscriptions', 'error');
    }
  }

  async renderBroadcastWatchlist(watchlistId) {
    const { data: watchlist } = await api.getWatchlistById(watchlistId);
    const instances = watchlist.instances || [];
    const token = (window.WEBHOOK_TOKEN || '') || (window.appConfig?.webhookToken || '');
    const baseUrl = window.location.origin.replace(/\/$/, '');
    const cleanUrl = watchlist.webhook_url || `${baseUrl}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;
    const webhookUrl = token ? `${cleanUrl}?token=${encodeURIComponent(token)}` : cleanUrl;

    const instanceList = instances.length
      ? `
        <ul class="list">
          ${instances.map((inst) => `
            <li class="list-item">
              <div>
                <div class="font-medium">${Utils.escapeHTML(inst.name || inst.host_url)}</div>
                <div class="text-xs text-neutral-500">${Utils.escapeHTML(inst.host_url)}</div>
              </div>
              <span class="badge ${inst.is_active ? 'badge-success' : 'badge-neutral'}">
                ${inst.is_active ? 'Active' : 'Paused'}
              </span>
            </li>
          `).join('')}
        </ul>
      `
      : '<p class="text-neutral-600 text-sm">No instances assigned yet.</p>';

    const samplePayload = `{
  "strategy": "tv-broadcast",
  "exchange": "NFO",
  "symbol": "NIFTY23DEC2525900CE",
  "action": "BUY",
  "position_size": 1,
  "quantity": 1
}`;

    return `
      <div class="card p-4 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm text-neutral-500">TradingView Broadcast Webhook</p>
            <h4 class="text-lg font-semibold">Fan-out to ${instances.length} instance${instances.length === 1 ? '' : 's'}</h4>
         </div>
         <span class="badge badge-info">Broadcast</span>
        </div>

        <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs text-neutral-500">Webhook URL${token ? ' (token included via query)' : ''}</p>
              <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
            </div>
            <button class="btn btn-neutral btn-sm" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs text-neutral-500">Watchlist Slug</p>
              <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
            </div>
            ${watchlist.webhook_slug ? `<button class="btn btn-neutral btn-sm" onclick="Utils.copyToClipboard('${watchlist.webhook_slug}')">Copy Slug</button>` : ''}
          </div>
          <p class="text-xs text-neutral-500">Send TradingView alerts to this URL${token ? ' (token query included)' : ' and include header X-Webhook-Token'}.</p>
        </div>

        <div class="grid md:grid-cols-2 gap-4">
          <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
            <div class="flex items-center justify-between">
              <h5 class="font-semibold">Assigned Instances</h5>
              <button class="btn btn-outline btn-sm" onclick="app.manageWatchlistInstances(${watchlistId})">Manage</button>
            </div>
            ${instanceList}
          </div>
          <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
            <div class="flex items-center justify-between">
              <h5 class="font-semibold">Sample Payload</h5>
              <button class="btn btn-neutral btn-sm" onclick="Utils.copyToClipboard('${samplePayload.replace(/\n/g, '\\n').replace(/\"/g, '\\\"')}')">Copy JSON</button>
            </div>
            <pre class="code-block" style="white-space: pre-wrap;">${samplePayload}</pre>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Get badge class for symbol type with pastel highlights
   */
  getSymbolTypeBadgeClass(type) {
    const classes = {
      INDEX: 'badge badge-info',       // Indices - light blue pastel
      EQUITY: 'badge badge-buy',        // Equity stocks - light green pastel
      FUTURES: 'badge badge-sell',      // Futures contracts - light orange pastel
      OPTIONS: 'badge badge-neutral',   // Options contracts - light purple/neutral pastel
      UNKNOWN: 'badge badge-neutral',   // Unknown/unclassified
    };
    return classes[type] || 'badge badge-neutral';
  }

  /**
   * Setup event listeners for watchlist expansion toggles
   */
  setupExpansionToggleListeners(watchlistId) {
    // Use event delegation on the table for better performance
    const table = document.getElementById(`watchlist-table-${watchlistId}`);
    if (!table) return;

    // Remove existing listener if present to avoid duplicates
    if (table._expansionListener) {
      table.removeEventListener('click', table._expansionListener);
    }

    table._expansionListener = (event) => {
      const button = event.target.closest('.btn-toggle-expansion, .btn-expand-compact');
      if (button) {
        const wlId = parseInt(button.dataset.watchlistId);
        const symId = parseInt(button.dataset.symbolId);
        // debug removed
        this.handleSymbolToggle(wlId, symId);
      }
    };

    table.addEventListener('click', table._expansionListener);
  }

  handleSymbolToggle(watchlistId, symbolId) {
    // Best-effort cache warmup for quotes/positions to reduce first-click latency
    try {
      const row = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      const symbol = row?.dataset?.symbol;
      const exchange = row?.dataset?.exchange;
      if (symbol && exchange && window.api && typeof api.getMarketData === 'function') {
        api.getMarketData(exchange, symbol).catch(() => { });
      }
    } catch (_) {
      // non-blocking
    }

    const handler = window.quickOrder;
    if (!handler || typeof handler.toggleRowExpansion !== 'function') {
      console.error('[Watchlist] quickOrder handler not ready', { watchlistId, symbolId });
      if (window.Utils && typeof Utils.showToast === 'function') {
        Utils.showToast('Trading controls not ready yet. Please reload the page.', 'error');
      }
      return;
    }

    try {
      handler.toggleRowExpansion(watchlistId, symbolId);
    } catch (error) {
      console.error('Failed to toggle symbol expansion', { watchlistId, symbolId, error });
      if (window.Utils && typeof Utils.showToast === 'function') {
        Utils.showToast(`Failed to open trading controls: ${Utils.escapeHTML(error.message)}`, 'error');
      }
    }
  }

  /**
   * Start polling quotes for a watchlist
   */
  async startWatchlistPolling(watchlistId) {
    const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
    if (this.isBroadcastWatchlist(watchlist) || this.isStrategyWatchlist(watchlist)) return;
    if (this.isPaused) return;
    // Stop existing poller if any
    this.stopWatchlistPolling(watchlistId);
    if (this.isWsStreamingActive()) {
      this.updateWatchlistQuoteMeta(watchlistId, { statusText: 'Streaming active' });
      return;
    }

    // Fetch quotes immediately
    await this.updateWatchlistQuotes(watchlistId, { force: true });

    // Start 10-second polling
    const intervalId = setInterval(async () => {
      if (this.isPaused) return;
      await this.updateWatchlistQuotes(watchlistId);
    }, 10000);

    this.watchlistPollers.set(watchlistId, intervalId);
  }

  /**
   * Stop polling quotes for a watchlist
   */
  stopWatchlistPolling(watchlistId) {
    if (this.watchlistPollers.has(watchlistId)) {
      clearInterval(this.watchlistPollers.get(watchlistId));
      this.watchlistPollers.delete(watchlistId);
    }
    // Clear quote cache for this watchlist
    this.clearWatchlistQuoteCache(watchlistId);
    this.watchlistQuoteSnapshots.delete(watchlistId);
    this.updateWatchlistQuoteMeta(watchlistId, { statusText: 'Quotes paused' });
  }

  /**
   * Stop all watchlist polling intervals
   */
  stopAllWatchlistPolling() {
    this.watchlistPollers.forEach((intervalId, watchlistId) => {
      clearInterval(intervalId);
    });
    this.watchlistPollers.clear();
    // Clear all quote caches
    this.quoteCache.clear();
  }

  /**
   * Clear quote cache for a specific watchlist
   */
  clearWatchlistQuoteCache(watchlistId) {
    // Remove all cache entries for this watchlist
    const keysToDelete = [];
    for (const key of this.quoteCache.keys()) {
      if (key.startsWith(`${watchlistId}_`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.quoteCache.delete(key));
  }

  startPositionsPolling({ immediate = false } = {}) {
    if (this.positionsPollingInterval) return;
    if (immediate) {
      this.requestWatchlistRefresh({ showLoader: true, force: true });
    }
    this.positionsPollingInterval = setInterval(() => {
      this.requestWatchlistRefresh();
    }, this.positionsPollingMs);
  }

  stopPositionsPolling() {
    if (this.positionsPollingInterval) {
      clearInterval(this.positionsPollingInterval);
      this.positionsPollingInterval = null;
    }
  }

  _updatePositionsPollingInterval(hasOpenPositions) {
    const desiredInterval = hasOpenPositions ? this.positionsPollingActiveMs : this.positionsPollingIdleMs;
    const desiredLtpTtl = hasOpenPositions ? this.ltpCacheTtlActiveMs : this.ltpCacheTtlIdleMs;

    this.ltpCacheTtlMs = desiredLtpTtl;

    if (this.positionsPollingMs === desiredInterval) {
      return;
    }
    this.positionsPollingMs = desiredInterval;

    if (this.positionsPollingInterval) {
      clearInterval(this.positionsPollingInterval);
      this.positionsPollingInterval = setInterval(() => {
        this.requestWatchlistRefresh();
      }, this.positionsPollingMs);
    }
  }

  requestWatchlistRefresh({ showLoader = false, force = false } = {}) {
    if (this.isPaused && !force) {
      return;
    }
    if (force) {
      this.refreshWatchlistPositions({ showLoader, force: true });
      return;
    }

    this._throttledWatchlistRefresh({ showLoader, force: false });
  }

  async updateWatchlistQuotes(watchlistId, { force = false } = {}) {
    if (this.isPaused && !force) return;
    if (this.isWsStreamingActive()) {
      return;
    }
    try {
      // Check if watchlist table exists in DOM (view might be re-rendering)
      const table = document.getElementById(`watchlist-table-${watchlistId}`);
      if (!table) {
        // debug removed
        return;
      }

      // Get watchlist symbols
      const response = await api.getWatchlistSymbols(watchlistId);
      const symbols = response.data;

      if (symbols.length === 0) {
        this.updateWatchlistQuoteMeta(watchlistId, { statusText: 'No symbols configured' });
        return;
      }

      // Get pooled market data instances (global, not watchlist bound)
      const mdResp = await api.getAllMarketDataInstances();
      const mdInstances = (mdResp.data || []).filter(inst => inst.is_active);
      if (mdInstances.length === 0) {
        this.updateWatchlistQuoteMeta(watchlistId, {
          statusText: 'No market data instances available',
          source: null,
          total: symbols.length,
          filled: 0,
        });
        return;
      }

      // Prepare symbols array for quotes API
      const symbolsForQuotes = symbols.map(s => ({
        exchange: s.exchange,
        symbol: s.symbol
      }));

      // Batch and distribute across instances (3–5 per request, round-robin)
      const batchSize = Math.max(3, Math.min(5, Math.ceil(symbolsForQuotes.length / mdInstances.length)));
      const chunks = this.chunkArray(symbolsForQuotes, batchSize);
      let allQuotes = [];
      for (let i = 0; i < chunks.length; i++) {
        const inst = mdInstances[i % mdInstances.length];
        try {
          const resp = await api.getQuotes(chunks[i], inst.id);
          if (resp?.data?.length) {
            allQuotes = allQuotes.concat(resp.data);
          }
        } catch (err) {
          console.warn('Quote batch failed for instance', inst.name, err.message);
        }
      }

      const snapshotTimestamp = Date.now();

      this.updateWatchlistQuoteMeta(watchlistId, {
        timestamp: snapshotTimestamp,
        source: 'live',
        total: symbols.length,
        filled: allQuotes.length,
      });

      const lastSnapshotTs = this.watchlistQuoteSnapshots.get(watchlistId);
      if (!force && lastSnapshotTs && snapshotTimestamp && snapshotTimestamp <= lastSnapshotTs) {
        return;
      }

      this.watchlistQuoteSnapshots.set(watchlistId, snapshotTimestamp);

      // Update UI for each symbol
      allQuotes.forEach(quote => {
        const hydratedQuote = this.hydrateQuoteWithLtp(quote, snapshotTimestamp);
        const normalizedQuoteSymbol = this.normalizeQuoteSymbol(hydratedQuote.symbol);
        const symbol = symbols.find(s => {
          const exactMatch = s.exchange === hydratedQuote.exchange;
          const normalizedMatch =
            this.normalizeExchange(s.exchange) === this.normalizeExchange(hydratedQuote.exchange);

          return (exactMatch || normalizedMatch) && s.symbol === normalizedQuoteSymbol;
        });

        if (symbol) {
          this.updateSymbolQuote(watchlistId, symbol.id, hydratedQuote);
        }
      });
    } catch (error) {
      console.error('Failed to update watchlist quotes', error);
      this.updateWatchlistQuoteMeta(watchlistId, {
        statusText: 'Quote refresh failed',
      });
    }
  }

  normalizeExchange(exchange = '') {
    const normalized = (exchange || '').trim().toUpperCase();
    if (!normalized) return '';
    if (normalized.endsWith('_INDEX')) {
      return normalized.replace('_INDEX', '');
    }
    return normalized;
  }

  normalizeQuoteSymbol(symbol = '') {
    if (!symbol) return '';
    const normalized = symbol.toUpperCase();
    if (normalized.includes(':')) {
      return normalized.split(':').pop();
    }
    return normalized;
  }

  buildWatchlistSymbolKey(exchange, symbol) {
    const segmentMap = {
      1: 'NSE',
      2: 'NFO',
      3: 'BSE',
      4: 'BFO',
      5: 'MCX',
    };
    let exchInput = exchange;
    if (typeof exchInput === 'number') {
      exchInput = segmentMap[exchInput] || String(exchInput);
    }
    const exch = this.normalizeExchange(exchInput);
    const sym = this.normalizeQuoteSymbol(symbol);
    if (!exch || !sym) return null;
    return `${exch}|${sym}`;
  }

  extractQuoteKeys(quote = {}) {
    const exchange = quote.exchange || quote.exch || quote.exchange_segment || quote.exchangeSegment;
    const candidateSymbols = [
      quote.symbol,
      quote.trading_symbol,
      quote.tradingSymbol,
      quote.tradingsymbol,
    ];
    const keys = new Set();
    candidateSymbols.forEach((sym) => {
      const key = this.buildWatchlistSymbolKey(exchange, sym);
      if (key) keys.add(key);
    });
    return Array.from(keys);
  }

  cacheQuoteLtp(keys = [], ltp, ts = Date.now()) {
    if (typeof ltp !== 'number' || Number.isNaN(ltp)) return;
    keys.forEach((key) => {
      this.latestLtpByKey.set(key, { ltp, ts });
    });
  }

  resolveFreshLtp(keys = [], now = Date.now()) {
    for (const key of keys) {
      const entry = this.latestLtpByKey.get(key);
      if (!entry) continue;
      const isNumber = typeof entry.ltp === 'number' && !Number.isNaN(entry.ltp);
      const isFresh = entry.ts && now - entry.ts <= this.ltpCacheTtlMs;
      if (isNumber && isFresh) {
        return entry;
      }
      if (!isFresh) {
        this.latestLtpByKey.delete(key);
      }
    }
    return null;
  }

  hydrateQuoteWithLtp(quote = {}, receivedAt = Date.now()) {
    const hydrated = { ...quote };
    const keys = this.extractQuoteKeys(quote);
    if (!keys.length) return hydrated;

    const ltpCandidates = [
      hydrated.ltp,
      hydrated.last_price,
      hydrated.lastPrice,
      hydrated.last_traded_price,
      hydrated.lastTradedPrice,
    ];
    let ltpValue = null;
    for (const candidate of ltpCandidates) {
      if (typeof candidate === 'number' && !Number.isNaN(candidate)) {
        ltpValue = candidate;
        break;
      }
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        const parsed = parseFloat(candidate);
        if (!Number.isNaN(parsed)) {
          ltpValue = parsed;
          break;
        }
      }
    }

    if (typeof ltpValue === 'number' && !Number.isNaN(ltpValue)) {
      hydrated.ltp = ltpValue;
      this.cacheQuoteLtp(keys, ltpValue, receivedAt);
      hydrated.ltpTs = receivedAt;
      return hydrated;
    }

    const fallback = this.resolveFreshLtp(keys, receivedAt);
    if (fallback) {
      hydrated.ltp = fallback.ltp;
      hydrated.ltpTs = fallback.ts;
    }
    return hydrated;
  }

  resetWatchlistSymbolIndex() {
    this.watchlistSymbolIndex = new Map();
    this.watchlistSymbolIndexByWatchlist = new Map();
  }

  registerWatchlistSymbols(watchlistId, symbols = []) {
    if (!watchlistId) return;
    const previousEntries = this.watchlistSymbolIndexByWatchlist.get(watchlistId) || [];
    previousEntries.forEach(({ key, symbolId }) => {
      const list = this.watchlistSymbolIndex.get(key);
      if (!list) return;
      const filtered = list.filter((entry) => entry.watchlistId !== watchlistId || entry.symbolId !== symbolId);
      if (filtered.length) {
        this.watchlistSymbolIndex.set(key, filtered);
      } else {
        this.watchlistSymbolIndex.delete(key);
      }
    });

    const newEntries = [];
    symbols.forEach((sym) => {
      const candidates = [
        this.buildWatchlistSymbolKey(sym.exchange, sym.symbol),
        this.buildWatchlistSymbolKey(sym.exchange, sym.trading_symbol || sym.tradingsymbol),
      ].filter(Boolean);

      candidates.forEach((key) => {
        const existing = this.watchlistSymbolIndex.get(key) || [];
        if (!existing.find((e) => e.watchlistId === watchlistId && e.symbolId === sym.id)) {
          existing.push({ watchlistId, symbolId: sym.id });
          this.watchlistSymbolIndex.set(key, existing);
          newEntries.push({ key, symbolId: sym.id });
        }
      });
    });

    this.watchlistSymbolIndexByWatchlist.set(watchlistId, newEntries);
  }

  chunkArray(arr = [], size = 5) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Update quote display for a specific symbol
   * Uses caching to prevent unnecessary DOM updates and adds visual highlights on changes
   */
  updateSymbolQuote(watchlistId, symbolId, quote) {
    // Find the table cells for this symbol
    const ltpCell = document.querySelector(
      `#watchlist-table-${watchlistId} .ltp-cell[data-symbol-id="${symbolId}"]`
    );
    const changeCell = document.querySelector(
      `#watchlist-table-${watchlistId} .change-cell[data-symbol-id="${symbolId}"]`
    );
    const volumeCell = document.querySelector(
      `#watchlist-table-${watchlistId} .volume-cell[data-symbol-id="${symbolId}"]`
    );

    if (!ltpCell || !changeCell || !volumeCell) return;

    // Create cache key
    const cacheKey = `${watchlistId}_${symbolId}`;
    const cached = this.quoteCache.get(cacheKey) || {};
    const now = Date.now();

    // Calculate change percent
    let changePercent = null;
    if (quote.ltp !== undefined && quote.prev_close !== undefined && quote.prev_close > 0) {
      changePercent = ((quote.ltp - quote.prev_close) / quote.prev_close) * 100;
    }

    // Helper to check if cell has placeholder or is empty
    const hasPlaceholder = (cell) => {
      const text = cell.textContent.trim();
      return text === '-' || text === '' || text === '—';
    };

    // Helper to add highlight animation
    const addHighlight = (cell, animationClass) => {
      cell.classList.remove('value-updated', 'value-profit-updated', 'value-loss-updated');
      // Force reflow to restart animation
      void cell.offsetWidth;
      cell.classList.add(animationClass);
    };

    // Helper to get or create span element
    const getOrCreateSpan = (cell, className = '') => {
      let span = cell.querySelector('span');
      if (!span) {
        span = document.createElement('span');
        if (className) span.className = className;
        cell.innerHTML = '';
        cell.appendChild(span);
      }
      return span;
    };

    const ltpIsNumber = typeof quote.ltp === 'number' && !Number.isNaN(quote.ltp);
    let resolvedLtp = ltpIsNumber ? quote.ltp : null;
    let resolvedLtpTs = typeof quote.ltpTs === 'number' ? quote.ltpTs : now;

    if (resolvedLtp === null) {
      const cachedFresh = cached.ltpTs && now - cached.ltpTs <= this.ltpCacheTtlMs;
      const cachedIsNumber = typeof cached.ltp === 'number' && !Number.isNaN(cached.ltp);
      if (cachedFresh && cachedIsNumber) {
        resolvedLtp = cached.ltp;
        resolvedLtpTs = cached.ltpTs;
      } else if (cached.ltpTs && now - cached.ltpTs > this.ltpCacheTtlMs) {
        cached.ltp = undefined;
        cached.ltpTs = undefined;
      }
    }

    // Update LTP if changed OR cell is empty/placeholder
    if (resolvedLtp !== null && resolvedLtp !== undefined && (cached.ltp !== resolvedLtp || hasPlaceholder(ltpCell))) {
      const valueChanged = cached.ltp !== resolvedLtp && !hasPlaceholder(ltpCell);
      const span = getOrCreateSpan(ltpCell, 'font-medium');
      span.textContent = `₹${Utils.formatNumber(resolvedLtp)}`;

      // Add highlight animation if value actually changed
      if (valueChanged) {
        addHighlight(ltpCell, 'value-updated');
      }

      cached.ltp = resolvedLtp;
      cached.ltpTs = resolvedLtpTs;
    } else if (resolvedLtp === null || resolvedLtp === undefined) {
      ltpCell.textContent = '-';
      cached.ltp = undefined;
      cached.ltpTs = undefined;
    }

    // Update % change if changed OR cell is empty/placeholder
    if (changePercent !== null && (cached.changePercent !== changePercent || hasPlaceholder(changeCell))) {
      const valueChanged = cached.changePercent !== changePercent && !hasPlaceholder(changeCell);
      const changeClass = changePercent >= 0 ? 'text-profit' : 'text-loss';
      const changeSymbol = changePercent >= 0 ? '+' : '';
      const span = getOrCreateSpan(changeCell, `${changeClass} font-medium`);
      span.className = `${changeClass} font-medium`; // Update class for color change
      span.textContent = `${changeSymbol}${changePercent.toFixed(2)}%`;

      // Add color-coded highlight animation if value actually changed
      if (valueChanged) {
        const animClass = changePercent >= 0 ? 'value-profit-updated' : 'value-loss-updated';
        addHighlight(changeCell, animClass);
      }

      cached.changePercent = changePercent;
    }

    // Update volume if changed OR cell is empty/placeholder
    if (quote.volume !== undefined && (cached.volume !== quote.volume || hasPlaceholder(volumeCell))) {
      const valueChanged = cached.volume !== quote.volume && !hasPlaceholder(volumeCell);
      const span = getOrCreateSpan(volumeCell);
      span.textContent = Utils.formatNumber(quote.volume);

      // Add highlight animation if value actually changed
      if (valueChanged) {
        addHighlight(volumeCell, 'value-updated');
      }

      cached.volume = quote.volume;
    }

    // Update cache
    this.quoteCache.set(cacheKey, cached);
  }

  handleQuoteStreamPayload(payload = {}) {
    const quotes = Array.isArray(payload.data) ? payload.data : [];
    if (!quotes.length) return;

    const updatedWatchlists = new Set();
    const ts = Date.now();

    quotes.forEach((quote) => {
      const hydratedQuote = this.hydrateQuoteWithLtp(quote, ts);
      const exchange = hydratedQuote.exchange || hydratedQuote.exch || hydratedQuote.exchange_segment || hydratedQuote.exchangeSegment;
      const candidateSymbols = [
        hydratedQuote.symbol,
        hydratedQuote.trading_symbol,
        hydratedQuote.tradingSymbol,
        hydratedQuote.tradingsymbol,
      ];

      const keys = new Set();
      candidateSymbols.forEach((sym) => {
        const key = this.buildWatchlistSymbolKey(exchange, sym);
        if (key) keys.add(key);
      });

      keys.forEach((key) => {
        const mappings = this.watchlistSymbolIndex.get(key);
        if (!mappings || !mappings.length) return;
        mappings.forEach(({ watchlistId, symbolId }) => {
          this.updateSymbolQuote(watchlistId, symbolId, hydratedQuote);
          updatedWatchlists.add(watchlistId);
        });
      });

      if (this.quickOrder && typeof this.quickOrder.applyQuoteUpdate === 'function') {
        this.quickOrder.applyQuoteUpdate(hydratedQuote);
      }
    });

    updatedWatchlists.forEach((watchlistId) => {
      this.updateWatchlistQuoteMeta(watchlistId, {
        timestamp: ts,
        source: 'stream',
      });
    });
  }

  updateWatchlistQuoteMeta(
    watchlistId,
    {
      timestamp = null,
      source = null,
      total = null,
      filled = null,
      statusText = null,
    } = {}
  ) {
    const lastUpdateEl = document.querySelector(
      `[data-watchlist-last-update="${watchlistId}"]`
    );
    const sourceEl = document.querySelector(
      `[data-watchlist-feed-source="${watchlistId}"]`
    );
    const coverageEl = document.querySelector(
      `[data-watchlist-feed-coverage="${watchlistId}"]`
    );

    // Feed the navbar freshness clock from here too - the REST poll path calls this
    // unconditionally, regardless of which view is open, so it's a correct source for it. The
    // WS push path used to be marked ONLY from here, on the assumption every quote funnelled
    // through this function - untrue once the WS dispatcher (dashboard-core.js:handleWsMessage)
    // grew view-specific branches (chart, dashboard) that never call it. That dispatcher now
    // marks the clock directly for every quotes/positions/funds message, so this call is
    // redundant for WS traffic and only load-bearing for the REST fallback.
    if (!statusText && timestamp) {
      this.markDataReceived(timestamp);
    }

    if (lastUpdateEl) {
      if (statusText) {
        lastUpdateEl.textContent = statusText;
        lastUpdateEl.removeAttribute('title');
      } else if (timestamp) {
        const parsedTs = typeof timestamp === 'number'
          ? timestamp
          : Date.parse(timestamp);
        if (!Number.isNaN(parsedTs)) {
          const iso = new Date(parsedTs).toISOString();
          lastUpdateEl.textContent = `Last update: ${Utils.formatRelativeTime(iso)}`;
          lastUpdateEl.title = `Cached at ${Utils.formatDateTime(iso, true)}`;
        } else {
          lastUpdateEl.textContent = 'Last update: waiting for feed…';
          lastUpdateEl.removeAttribute('title');
        }
      } else {
        lastUpdateEl.textContent = 'Last update: waiting for feed…';
        lastUpdateEl.removeAttribute('title');
      }
    }

    if (sourceEl) {
      if (statusText) {
        sourceEl.textContent = 'Source: —';
      } else if (source === 'cache') {
        sourceEl.textContent = 'Source: Shared feed cache';
      } else if (source) {
        sourceEl.textContent = 'Source: Live broker fallback';
      } else {
        sourceEl.textContent = 'Source: —';
      }
    }

    if (coverageEl) {
      if (statusText && statusText.toLowerCase().includes('paused')) {
        coverageEl.textContent = '';
      } else if (typeof total === 'number') {
        const updatedCount = typeof filled === 'number' ? filled : 0;
        coverageEl.textContent = `Symbols updated: ${updatedCount}/${total}`;
      } else {
        coverageEl.textContent = '';
      }
    }
  }
}.prototype));
