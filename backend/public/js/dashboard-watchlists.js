/**
 * Simplifyed Admin V2 - Dashboard: Watchlists view (render/accordion, quote+polling/streaming,
 * CRUD modals, and the linked positions panel). This is the last big unsplit view cluster -
 * deliberately deferred as its own follow-up pass (see project notes) rather than being
 * further broken up in the same pass as the other views.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Watchlists View (Compact Redesigned Layout)
   */
  async renderWatchlistsView() {
    const contentArea = document.getElementById('content-area');

    if (window.quickOrder && typeof window.quickOrder.stopAllOptionPreviewPolling === 'function') {
      window.quickOrder.stopAllOptionPreviewPolling();
    }
    if (window.quickOrder && typeof window.quickOrder.stopAllFuturesPreviewPolling === 'function') {
      window.quickOrder.stopAllFuturesPreviewPolling();
    }

    this.stopPositionsPolling();

    try {
      // Fetch watchlists + instances in parallel to reduce latency
      const [watchlistsRes, instancesRes] = await Promise.all([
        api.getWatchlists(),
        api.getInstances(),
      ]);
      this.watchlists = watchlistsRes.data;
      this.resetWatchlistSymbolIndex();
      // Default to collapsed watchlists; user opt-in to load quotes/expansions
      this.expandedWatchlists = new Set();
      this.instances = instancesRes.data;
    } catch (error) {
      console.error('Failed to load watchlists view:', error);
      contentArea.innerHTML = `
        <div class="card">
          <div class="p-4 space-y-2">
            <h3 class="text-lg font-semibold text-loss">Unable to load watchlists</h3>
            <p class="text-sm text-neutral-600">${Utils.escapeHTML(error?.message || 'Network error')}</p>
            <button class="btn btn-buy btn-sm" onclick="app.renderWatchlistsView()">Retry</button>
          </div>
        </div>
      `;
      return;
    }

    contentArea.innerHTML = `
      <section class="watchlists-page-compact">
        <!-- Compact Toolbar -->
        <div class="watchlists-compact-toolbar">
          <div class="watchlists-toolbar-left">
            <h2 class="watchlists-title">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Watchlists
            </h2>
            <span class="watchlists-count">${this.watchlists.length} lists</span>
          </div>
          <div class="watchlists-toolbar-right">
            <button class="btn-icon" onclick="app.resyncQuotesFromSnapshots()" title="Resync quotes (snapshot)">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.5 12A7.5 7.5 0 116 6.75M6 6.75V3m0 3.75h3.75" />
              </svg>
            </button>
            <button class="btn btn-neutral btn-sm" onclick="app.showWsSubscriptions()" title="View WebSocket subscriptions">
              WS Subs
            </button>
            <button class="btn btn-outline btn-sm" onclick="app.toggleSnapshotResync()" title="Toggle auto snapshot resync">
              Auto Resync: ${this.autoSnapshotResyncEnabled ? 'On' : 'Off'}
            </button>
            <button class="btn-icon" onclick="app.renderWatchlistsView()" title="Refresh data">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h4M20 20v-5h-4M5 9a7 7 0 0112-4M19 15a7 7 0 01-12 4" />
              </svg>
            </button>
            <button class="btn-icon" onclick="app.togglePositionsPanel()" title="Toggle positions panel" id="toggle-positions-btn">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2-2v2m8 0V6a2 2 0 012 2v6a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2h8z" />
              </svg>
            </button>
            <button class="btn btn-buy btn-compact" onclick="app.showAddWatchlistModal()">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              Add Watchlist
            </button>
          </div>
        </div>

        <!-- Collapsible Positions Panel -->
        <div id="positions-panel-compact" class="positions-panel-compact collapsed">
          <div class="positions-panel-header" onclick="app.togglePositionsPanel()">
            <div class="positions-panel-title">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2-2v2m8 0V6a2 2 0 012 2v6a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2h8z" />
              </svg>
              Open Positions
            </div>
            <div id="positions-summary-inline" class="positions-summary-compact">
              <span class="text-neutral-500 text-xs">Loading…</span>
            </div>
            <div class="positions-panel-actions">
              <button class="btn-icon btn-sm" onclick="event.stopPropagation(); app.requestWatchlistRefresh({ showLoader: true, force: true })" title="Refresh">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h4M20 20v-5h-4M5 9a7 7 0 0112-4M19 15a7 7 0 01-12 4" />
                </svg>
              </button>
              <button class="btn btn-exit btn-sm btn-icon-only" onclick="event.stopPropagation(); app.closeAllOpenPositions()" title="Close All">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div id="watchlist-positions-panel" class="positions-panel-content">
            <div class="p-3 text-center text-neutral-500 text-sm">Loading positions...</div>
          </div>
        </div>

        <!-- Watchlists Grid -->
        <div id="watchlists-container" class="watchlists-grid-compact">
          ${await this.renderWatchlistsAccordion(this.watchlists, true)}
        </div>
      </section>
    `;

    const toggleBtn = document.getElementById('toggle-positions-btn');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.setAttribute('aria-controls', 'positions-panel-compact');
    }

    // Populate positions summary once so the inline panel is not empty
    this.refreshWatchlistPositions({ showLoader: false, force: false });
    // Warm snapshots in the background for fresh data without blocking render
    setTimeout(() => {
      this.requestWatchlistRefresh({ showLoader: false, force: true });
    }, 0);
    // Begin polling when the user expands the panel
  }

  /**
   * Render watchlists as accordion cards
   */
  async renderWatchlistsAccordion(watchlists, setupListeners = false) {
    if (watchlists.length === 0) {
      return `
        <div class="watchlists-empty">
          <h4 class="text-lg font-semibold">No watchlists yet</h4>
          <p>Create your first watchlist to start tracking instruments.</p>
          <button class="btn btn-buy btn-sm mt-2" onclick="app.showAddWatchlistModal()">
            + Create Watchlist
          </button>
        </div>
      `;
    }

    const cardsHTML = [];
    for (const wl of watchlists) {
      const isExpanded = this.expandedWatchlists.has(wl.id);
      cardsHTML.push(await this.renderWatchlistCard(wl, isExpanded));
    }

    const html = cardsHTML.join('');

    // If requested, setup listeners for expanded watchlists
    if (setupListeners) {
      setTimeout(() => {
        watchlists.forEach(wl => {
          if (this.expandedWatchlists.has(wl.id)) {
            this.setupExpansionToggleListeners(wl.id);
          }
        });
      }, 100);
    }

    return html;
  }

  isBroadcastWatchlist(watchlist) {
    if (!watchlist) return false;
    const type = (watchlist.type || '').toLowerCase();
    return Boolean(watchlist.is_broadcast || type === 'broadcast');
  }

  /**
   * Render individual watchlist card with compact layout
   */
  async renderWatchlistCard(wl, isExpanded) {
    const statusColor = wl.is_active ? 'success' : 'neutral';
    const isBroadcast = this.isBroadcastWatchlist(wl);
    const typeBadge = isBroadcast ? '<span class="watchlist-card-compact__badge info">Broadcast</span>' : '';
    const metaText = isBroadcast
      ? `${wl.instance_count || 0} instances • TradingView webhook`
      : `${wl.symbol_count || 0} symbols • ${wl.instance_count || 0} instances`;

    return `
      <article class="watchlist-card-compact" data-watchlist-id="${wl.id}">
        <div class="watchlist-card-compact__header">
          <button
            id="watchlist-toggle-${wl.id}"
            class="watchlist-card-compact__toggle ${isExpanded ? 'is-open' : ''}"
            aria-expanded="${isExpanded}"
            onclick="app.toggleWatchlist(${wl.id})"
            title="Expand/Collapse"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div class="watchlist-card-compact__info">
            <div class="watchlist-card-compact__title-row">
              <h4 class="watchlist-card-compact__name">${Utils.escapeHTML(wl.name)}</h4>
              <span class="watchlist-card-compact__badge ${statusColor}">
                ${wl.is_active ? 'Active' : 'Paused'}
              </span>
              ${typeBadge}
              <span class="watchlist-card-compact__meta">
                ${metaText}
              </span>
            </div>
            ${wl.description ? `<p class="watchlist-card-compact__desc">${Utils.escapeHTML(wl.description)}</p>` : ''}
          </div>
          <div class="watchlist-card-compact__actions">
            ${isBroadcast ? '' : `
              <button class="btn-icon-compact" onclick="app.showAddSymbolModal(${wl.id})" title="Add Symbol">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            `}
            <button class="btn-icon-compact" onclick="app.showEditWatchlistModal(${wl.id})" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="btn-icon-compact" onclick="app.manageWatchlistInstances(${wl.id})" title="Instances">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </button>
            <button class="btn-icon-compact danger" onclick="app.deleteWatchlist(${wl.id})" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>

        <div id="watchlist-content-${wl.id}" class="watchlist-card-compact__body ${isExpanded ? 'is-visible' : ''}">
          <div id="watchlist-symbols-${wl.id}">
            ${isExpanded ? await this.renderWatchlistSymbols(wl.id) : '<p class="text-neutral-600 text-sm p-3">Loading...</p>'}
          </div>
          ${isBroadcast ? '' : `
            <div id="watchlist-strategies-wrapper-${wl.id}">
              ${isExpanded ? await strategyBuilder.renderStrategiesSection(wl.id) : ''}
            </div>
          `}
        </div>
      </article>
    `;
  }

  /**
   * Toggle positions panel visibility
   */
  togglePositionsPanel() {
    const panel = document.getElementById('positions-panel-compact');
    const btn = document.getElementById('toggle-positions-btn');
    if (panel) {
      const isCollapsed = panel.classList.toggle('collapsed');
      if (btn) {
        btn.classList.toggle('active', !isCollapsed);
        btn.setAttribute('aria-expanded', String(!isCollapsed));
        btn.setAttribute('aria-controls', 'positions-panel-compact');
      }
      if (!isCollapsed) {
        this.startPositionsPolling({ immediate: true });
      } else {
        this.stopPositionsPolling();
      }
    }
  }

  async resyncQuotesFromSnapshots() {
    try {
      await api.getQuoteSnapshots({ refresh: true });
      const expandedIds = Array.from(this.expandedWatchlists || []);
      for (const wlId of expandedIds) {
        await this.updateWatchlistQuotes(wlId, { force: true });
      }
      Utils.showToast('Quotes resynced from snapshots', 'success');
    } catch (error) {
      console.error('Failed to resync quotes', error);
      Utils.showToast('Failed to resync quotes', 'error');
    }
  }

  async triggerSnapshotResync() {
    if (this.isSnapshotResyncing) return;
    this.isSnapshotResyncing = true;
    try {
      if (this.currentView === 'watchlists') {
        await this.resyncQuotesFromSnapshots();
      } else if (this.currentView === 'positions') {
        await this.resyncAllPositionsFromSnapshots();
      }
      this.lastSnapshotResyncAt = Date.now();
    } finally {
      this.isSnapshotResyncing = false;
    }
  }

  startSnapshotResync(viewName) {
    this.stopSnapshotResync();
    // Only start for targeted views
    if (!['watchlists', 'positions'].includes(viewName)) return;
    if (!this.autoSnapshotResyncEnabled) return;
    const intervalMs = 60000; // 60s gentle resync
    this.snapshotResyncInterval = setInterval(() => {
      // Avoid hammering while paused or busy
      if (this.isPaused || this.isSnapshotResyncing) return;
      this.triggerSnapshotResync();
    }, intervalMs);
  }

  stopSnapshotResync() {
    if (this.snapshotResyncInterval) {
      clearInterval(this.snapshotResyncInterval);
      this.snapshotResyncInterval = null;
    }
  }

  /**
   * Toggle watchlist expansion
   */
  async toggleWatchlist(watchlistId) {
    const contentDiv = document.getElementById(`watchlist-content-${watchlistId}`);
    const symbolsDiv = document.getElementById(`watchlist-symbols-${watchlistId}`);
    const toggleButton = document.getElementById(`watchlist-toggle-${watchlistId}`);

    if (!contentDiv || !toggleButton) return;

    if (this.expandedWatchlists.has(watchlistId)) {
      // Collapse
      this.expandedWatchlists.delete(watchlistId);
      contentDiv.classList.remove('is-visible');
      toggleButton.classList.remove('is-open');
      toggleButton.setAttribute('aria-expanded', 'false');

      // Stop polling for this watchlist
      this.stopWatchlistPolling(watchlistId);
    } else {
      // Expand
      this.expandedWatchlists.add(watchlistId);
      contentDiv.classList.add('is-visible');
      toggleButton.classList.add('is-open');
      toggleButton.setAttribute('aria-expanded', 'true');

      // Render symbols if not already rendered
      if (symbolsDiv && symbolsDiv.innerHTML.includes('Loading...')) {
        symbolsDiv.innerHTML = await this.renderWatchlistSymbols(watchlistId);
        // Setup event listeners for expansion toggles after symbols are rendered
        this.setupExpansionToggleListeners(watchlistId);
      }

      // Render strategies section on first expansion (non-broadcast watchlists only)
      const strategiesWrapper = document.getElementById(`watchlist-strategies-wrapper-${watchlistId}`);
      if (strategiesWrapper && !strategiesWrapper.innerHTML.trim()) {
        strategiesWrapper.innerHTML = await strategyBuilder.renderStrategiesSection(watchlistId);
      }

      // Start polling after DOM is ready
      if (!this.isBroadcastWatchlist((this.watchlists || []).find((w) => w.id === watchlistId))) {
        this.startWatchlistPolling(watchlistId);
      }
    }
  }

  /**
   * Render symbols for a watchlist
   */
  async renderWatchlistSymbols(watchlistId) {
    try {
      const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
      if (this.isBroadcastWatchlist(watchlist)) {
        return await this.renderBroadcastWatchlist(watchlistId);
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
              ${symbols.map(sym => `
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
              `).join('')}
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
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">Close</button>
          </div>
        </div>
      `;

      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });
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
        Utils.showToast(`Failed to open trading controls: ${error.message}`, 'error');
      }
    }
  }

  /**
   * Start polling quotes for a watchlist
   */
  async startWatchlistPolling(watchlistId) {
    const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
    if (this.isBroadcastWatchlist(watchlist)) return;
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

  async refreshWatchlistPositions({ showLoader = false, force = false } = {}) {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel) return;

    if (showLoader) {
      positionsPanel.innerHTML = '<div class="p-4"><p class="text-center text-neutral-600">Loading positions…</p></div>';
    }

    try {
      // Fetch cached open positions; refresh live only when forced
      const response = await api.getAllPositions({ onlyOpen: true, refresh: force });
      const normalized = this.prepareWatchlistPositions(response.data);
      console.debug('[Watchlists] Positions payload', {
        instances: response.data?.instances?.length,
        normalizedLive: normalized.liveInstances.length,
        normalizedAnalyzer: normalized.analyzerInstances.length,
        rawSample: response.data?.instances?.slice?.(0, 2) || [],
      });
      this._updatePositionsPollingInterval(normalized.overallOpen > 0);
      this.latestWatchlistPositionsData = normalized;
      this.updateWatchlistPositionsSummary(normalized);
      positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(normalized);
    } catch (error) {
      console.error('Failed to refresh watchlist positions:', error);
      const message = Utils.escapeHTML(error?.message || 'Unknown error');
      positionsPanel.innerHTML = `<div class="p-4"><p class="text-center text-error-600">Failed to load positions: ${message}</p></div>`;
    }
  }

  renderWatchlistPositionsPanel() {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel || !this.latestWatchlistPositionsData) return;
    positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(this.latestWatchlistPositionsData);
  }

  toggleWatchlistPositionInstance(instanceId) {
    if (this.watchlistPositionsExpanded.has(instanceId)) {
      this.watchlistPositionsExpanded.delete(instanceId);
    } else {
      this.watchlistPositionsExpanded.add(instanceId);
    }
    this.renderWatchlistPositionsPanel();
  }

  updateWatchlistPositionsSummary({ overallOpen, overallPnl, refreshedAt }) {
    const summaryEl = document.getElementById('positions-summary-inline');
    if (!summaryEl) return;

    const relativeText = refreshedAt ? `Updated ${Utils.formatRelativeTime(refreshedAt)}` : 'Updated just now';
    const liveOpen = this.latestWatchlistPositionsData?.liveOpen ?? 0;
    const analyzerOpen = this.latestWatchlistPositionsData?.analyzerOpen ?? 0;
    const livePnl = this.latestWatchlistPositionsData?.livePnl ?? 0;
    const analyzerPnl = this.latestWatchlistPositionsData?.analyzerPnl ?? 0;
    summaryEl.innerHTML = `
      <div class="flex items-center gap-4 flex-wrap">
        <div class="positions-summary-group">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Live Open:</span>
          <span class="text-sm font-semibold text-neutral-900">${liveOpen}</span>
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Live P&amp;L:</span>
          <span class="text-sm font-semibold ${Utils.getPnLColorClass(livePnl)}">
            ${Utils.formatCurrency(livePnl)}
          </span>
        </div>
        <span class="positions-summary-divider"></span>
        <div class="positions-summary-group">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Analyzer Open:</span>
          <span class="text-sm font-semibold text-neutral-900">${analyzerOpen}</span>
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Analyzer P&amp;L:</span>
          <span class="text-sm font-semibold ${Utils.getPnLColorClass(analyzerPnl)}">
            ${Utils.formatCurrency(analyzerPnl)}
          </span>
        </div>
      </div>
      <span class="text-xs text-neutral-400 whitespace-nowrap">${relativeText}</span>
    `;
  }

  async closeAllOpenPositions() {
    if (!this.latestWatchlistPositionsData) {
      Utils.showToast('Positions not loaded yet', 'warning');
      return;
    }

    const instances = (this.latestWatchlistPositionsData.allInstances || []).filter(
      inst => (inst.positions && inst.positions.length > 0) ||
        (typeof inst.open_positions_count === 'number' && inst.open_positions_count > 0)
    );

    if (instances.length === 0) {
      Utils.showToast('No open positions to close', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Are you sure you want to close all open positions across ${instances.length} instance(s)?`,
      'Confirm Global Close'
    );
    if (!confirmed) return;

    try {
      const responses = await Promise.allSettled(
        instances.map(inst => api.closePositions(inst.instance_id))
      );

      const successes = responses.filter(r => r.status === 'fulfilled').length;
      const failures = responses
        .map((result, idx) => (result.status === 'rejected'
          ? { name: instances[idx].instance_name, error: result.reason?.message || 'Failed' }
          : null))
        .filter(Boolean);

      if (failures.length > 0) {
        Utils.showToast(
          `Closed ${successes} instance(s); ${failures.length} failed (e.g., ${failures[0].name})`,
          'warning',
          5000
        );
      } else {
        Utils.showToast(`Close-all request sent to ${successes} instance(s)`, 'success');
      }
      this.requestWatchlistRefresh({ showLoader: true, force: true });
    } catch (error) {
      Utils.showToast('Failed to close all positions: ' + error.message, 'error');
    }
  }

  async closeAllPositionsGlobal() {
    const data = this.latestAllPositionsData;
    if (!data || !Array.isArray(data.instances)) {
      Utils.showToast('Positions not loaded yet', 'warning');
      return;
    }

    const instances = data.instances.filter(inst => {
      const openCount = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length;
      return openCount > 0;
    });

    if (instances.length === 0) {
      Utils.showToast('No open positions to close', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Close all open positions across ${instances.length} instance(s)?`,
      'Confirm Global Close All'
    );
    if (!confirmed) return;

    try {
      const responses = await Promise.allSettled(
        instances.map(inst => api.closePositions(inst.instance_id))
      );
      const failures = responses.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        Utils.showToast(`Some instances failed to close positions: ${failures.length}`, 'warning');
      } else {
        Utils.showToast('Close-all sent for all instances', 'success');
      }
      await this.renderPositionsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async closePosition(instanceId, encodedSymbol, encodedExchange, encodedProduct) {
    const symbol = decodeURIComponent(encodedSymbol || '');
    const exchange = decodeURIComponent(encodedExchange || '');
    const product = decodeURIComponent(encodedProduct || 'MIS');

    if (!symbol || !exchange) {
      Utils.showToast('Unable to determine symbol/exchange for closing position', 'error');
      return;
    }

    const tradeMode = this.getTradeModeFromSymbol(symbol);
    const confirmed = await Utils.confirm(
      `Close position for ${symbol} on instance ${instanceId}?`,
      'Confirm Close'
    );
    if (!confirmed) return;

    try {
      await api.closePosition(instanceId, {
        symbol,
        exchange,
        tradeMode,
        product,
      });
      Utils.showToast(`Close request submitted for ${symbol}`, 'success');
      await this.refreshWatchlistPositions({ showLoader: false });
    } catch (error) {
      Utils.showToast(`Failed to close ${symbol}: ${error.message}`, 'error');
    }
  }

  getTradeModeFromSymbol(symbol) {
    const normalized = (symbol || '').toUpperCase();
    if (normalized.includes('CE') || normalized.includes('PE')) {
      return 'OPTIONS';
    }
    if (normalized.includes('FUT')) {
      return 'FUTURES';
    }
    return 'EQUITY';
  }

  prepareWatchlistPositions(data = {}) {
    const instances = (data.instances || []).map(inst => {
      const rawPositions = Array.isArray(inst.positions) ? inst.positions : [];
      let openPositions = rawPositions.filter(pos => this.getNormalizedPositionQty(pos) !== 0);

      const serverReportedOpen = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : openPositions.length;

      if (openPositions.length === 0 && serverReportedOpen > 0) {
        openPositions = rawPositions;
      }

      return {
        ...inst,
        positions: openPositions,
        open_positions_count: serverReportedOpen,
      };
    });

    const liveInstances = instances
      .filter(inst => !inst.is_analyzer_mode && inst.positions.length > 0);

    const analyzerInstances = instances
      .filter(inst => inst.is_analyzer_mode && inst.positions.length > 0);

    const sumOpen = (list) => list.reduce(
      (sum, inst) => sum + (typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length),
      0
    );
    const sumPnl = (list) => list.reduce(
      (sum, inst) => sum + (typeof inst.total_pnl === 'number' ? inst.total_pnl : 0),
      0
    );

    const liveOpen = sumOpen(liveInstances);
    const analyzerOpen = sumOpen(analyzerInstances);
    const livePnl = sumPnl(liveInstances);
    const analyzerPnl = sumPnl(analyzerInstances);

    const totalOpen = typeof data.overall_open_positions === 'number'
      ? data.overall_open_positions
      : instances.reduce(
        (sum, inst) => sum + (inst.open_positions_count ?? inst.positions.length),
        0
      );

    return {
      overallOpen: totalOpen,
      overallPnl: data.overall_total_pnl ?? 0,
      liveOpen,
      analyzerOpen,
      livePnl,
      analyzerPnl,
      liveInstances,
      analyzerInstances,
      refreshedAt: data.refreshed_at || new Date().toISOString(),
      allInstances: instances,
    };
  }

  renderWatchlistPositionsMarkup({ overallOpen, overallPnl, liveInstances, analyzerInstances, refreshedAt }) {
    if (liveInstances.length === 0 && analyzerInstances.length === 0) {
      return '<div class="p-4"><p class="text-center text-neutral-600">No open positions across any instance.</p></div>';
    }

    return `
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${this.renderPositionsSection(
      'Live Market Instances',
      'Instances actively executing trades',
      liveInstances
    )}
        ${this.renderPositionsSection(
      'Analyzer Mode Instances',
      'Instances running in analyzer/paper mode',
      analyzerInstances
    )}
      </div>
    `;
  }

  renderPositionsSection(title, subtitle, instances) {
    if (!instances || instances.length === 0) {
      return `
        <div class="card">
          <div class="card-header-compact">
            <div>
              <h3 class="card-title-compact">${title}</h3>
              <p style="font-size: 0.688rem;" class="text-neutral-600">${subtitle}</p>
            </div>
            <span class="badge-count-compact">0</span>
          </div>
          <div style="padding: 0.5rem;">
            <p style="font-size: 0.688rem;" class="text-neutral-500">No open positions in this category.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header-compact">
          <div>
            <h3 class="card-title-compact">${title}</h3>
            <p style="font-size: 0.688rem;" class="text-neutral-600">${subtitle}</p>
          </div>
          <span class="badge-count-compact">${instances.length}</span>
        </div>
        <div style="padding: 0.375rem; display: flex; flex-direction: column; gap: 0.375rem;">
          ${instances.map(inst => this.renderPositionsInstanceCard(inst)).join('')}
        </div>
      </div>
    `;
  }

  renderPositionsInstanceCard(inst) {
    const positions = inst.positions || [];
    const openCount = typeof inst.open_positions_count === 'number'
      ? inst.open_positions_count
      : positions.length;
    const isExpanded = this.watchlistPositionsExpanded.has(inst.instance_id);

    return `
      <div class="position-instance-card-compact">
        <div class="position-instance-header-compact">
          <button
            class="position-instance-toggle"
            onclick="app.toggleWatchlistPositionInstance(${inst.instance_id})"
            aria-expanded="${isExpanded}"
            aria-controls="positions-body-${inst.instance_id}"
          >
            <span class="toggle-icon ${isExpanded ? 'rotate-90' : ''}">▸</span>
            <span class="instance-name">${Utils.escapeHTML(inst.instance_name)}</span>
            <span class="instance-meta">Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
            <span class="instance-meta">Open: <span class="font-medium">${openCount}</span></span>
            <span class="instance-meta">P&L:
              <span class="font-semibold ${Utils.getPnLColorClass(inst.total_pnl)}">
                ${Utils.formatCurrency(inst.total_pnl)}
              </span>
            </span>
          </button>
          <button class="btn-close-all-compact" onclick="app.closeAllPositions(${inst.instance_id})">
            Close All
          </button>
        </div>
        <div id="positions-body-${inst.instance_id}" class="${isExpanded ? 'block' : 'hidden'} border-t border-base-200">
          <div style="padding: 0.25rem;">
            ${positions.length > 0
        ? this.renderPositionsTable(positions, inst.instance_id)
        : '<p style="font-size: 0.688rem;" class="text-neutral-500">No open positions for this instance.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  renderPositionsTable(positions, instanceId = null) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="positions-table-compact" style="table-layout: fixed; width: 100%;">
          <colgroup>
            <col style="width: 24%;">
            <col style="width: 12%;">
            <col style="width: 12%;">
            <col style="width: 14%;">
            <col style="width: 14%;">
            <col style="width: 12%;">
            <col style="width: 12%;">
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Quantity</th>
              <th>Product</th>
              <th class="text-left">Entry</th>
              <th class="text-left">LTP</th>
              <th class="text-left">P&L</th>
              <th class="text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${positions.map(pos => {
      const qty = this.getNormalizedPositionQty(pos);
      const entry = Number(
        pos.entry_price ??
        pos.average_price ??
        pos.avg_price ??
        pos.net_avg_price ??
        0
      ) || 0;
      const entrySourceRaw = pos.entry_price_source || pos.entryPriceSource || null;
      const entrySourceLabel = (() => {
        if (!entrySourceRaw) return (pos.average_price || pos.avg_price) ? 'BROKER' : '-';
        const base = entrySourceRaw.split(':')[0];
        const map = {
          broker_avg: 'BROKER',
          fallback_cache: 'FALLBACK (ORDER)',
          positionbook_fallback: 'POSITIONBOOK Fallback',
          median_ltp: 'Median LTP',
        };
        return map[base] || base.replace(/_/g, ' ').toUpperCase();
      })();

      const ltp = Number(
        pos.ltp_resolved ??
        pos.ltp ??
        pos.last_price ??
        pos.lastprice ??
        0
      ) || 0;
      const pnl = pos.pnl_derived != null
        ? pos.pnl_derived
        : (() => {
          if (entry && ltp && qty !== 0) {
            return qty > 0 ? (ltp - entry) * qty : (entry - ltp) * Math.abs(qty);
          }
          return parseFloat(pos.pnl || pos.unrealized_pnl || pos.mtm || 0);
        })();
      return `
                <tr>
                  <td class="font-medium">${Utils.escapeHTML(pos.symbol || pos.tradingsymbol || '-')}</td>
                  <td>${qty}</td>
                  <td>${Utils.escapeHTML(pos.product || pos.product_type || '-')}</td>
                  <td class="text-left">
                    ${Utils.formatCurrency(entry)}
                    <div class="text-2xs text-neutral-500">Source: ${Utils.escapeHTML(entrySourceLabel)}</div>
                  </td>
                  <td class="text-left">${Utils.formatCurrency(ltp)}</td>
                  <td class="text-left ${Utils.getPnLColorClass(pnl)}">${Utils.formatCurrency(pnl)}</td>
                  <td class="text-left">
                    ${instanceId ? `
                      <button
                        class="btn-close-position-compact"
                        onclick="app.closePosition(${instanceId}, '${encodeURIComponent(pos.symbol || '')}', '${encodeURIComponent(pos.exchange || '')}', '${encodeURIComponent(pos.product || 'MIS')}')"
                      >
                        Close
                      </button>
                    ` : '-'}
                  </td>
                </tr>
              `;
    }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  getNormalizedPositionQty(pos) {
    if (!pos) return 0;
    const rawQty =
      pos.quantity ??
      pos.netqty ??
      pos.net_quantity ??
      pos.netQty ??
      pos.net ??
      0;
    const parsed = parseInt(rawQty, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  /**
   * Show edit watchlist modal
   */
  async showEditWatchlistModal(id) {
    try {
      // Fetch watchlist data
      const response = await api.getWatchlistById(id);
      const watchlist = response.data;
      const isBroadcast = this.isBroadcastWatchlist(watchlist);
      const webhookUrl = watchlist.webhook_url || `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>Edit Watchlist: ${Utils.escapeHTML(watchlist.name)}</h3>
          </div>
          <div class="modal-body">
            <form id="edit-watchlist-form">
              <input type="hidden" name="watchlist_id" value="${watchlist.id}">

              <div class="form-group">
                <label class="form-label">Watchlist Name *</label>
                <input type="text" name="name" class="form-input"
                       value="${Utils.escapeHTML(watchlist.name)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">Type</label>
                <div class="flex flex-col gap-2">
                  <label class="form-radio">
                    <input type="radio" name="type" value="standard" ${isBroadcast ? '' : 'checked'}>
                    <span>Standard (symbols + quick orders)</span>
                  </label>
                  <label class="form-radio">
                    <input type="radio" name="type" value="broadcast" ${isBroadcast ? 'checked' : ''}>
                    <span>Broadcast (TradingView webhook fan-out)</span>
                  </label>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Description</label>
                <textarea name="description" class="form-input" rows="3">${Utils.escapeHTML(watchlist.description || '')}</textarea>
              </div>

              <div class="form-group">
                <label class="form-label">TradingView buffer (%)</label>
                <input type="number" name="limit_buffer_pct" class="form-input" step="0.01" min="0"
                       value="${watchlist.limit_buffer_pct ?? ''}">
                <p class="text-xs text-neutral-500 mt-1">Used only for TradingView MARKET alerts on this watchlist.</p>
              </div>

              <div class="form-group">
                <label class="form-label">
                  <input type="checkbox" name="is_active"
                         ${watchlist.is_active ? 'checked' : ''}>
                  Active Watchlist
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem;">
                  Inactive watchlists won't be used for trading
                </small>
              </div>

              ${isBroadcast ? `
                <div class="form-group">
                  <label class="form-label">Webhook</label>
                  <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-xs text-neutral-500">Slug</p>
                        <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
                      </div>
                      ${watchlist.webhook_slug ? `<button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${watchlist.webhook_slug}')">Copy</button>` : ''}
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-xs text-neutral-500">Webhook URL</p>
                        <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
                      </div>
                      <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
                    </div>
                    <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. Targets are the instances assigned to this watchlist.</p>
                  </div>
                </div>
              ` : ''}
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Cancel
            </button>
            <button class="btn btn-buy" onclick="app.submitEditWatchlist()">
              Update Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load watchlist: ' + error.message, 'error');
    }
  }

  /**
   * Submit edit watchlist form
   */
  async submitEditWatchlist() {
    const form = document.getElementById('edit-watchlist-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Extract watchlist ID
    const watchlistId = parseInt(data.watchlist_id);
    delete data.watchlist_id;

    // Convert checkbox to boolean
    data.is_active = form.querySelector('input[name="is_active"]').checked;
    data.type = form.querySelector('input[name="type"]:checked')?.value || 'standard';
    if (data.limit_buffer_pct === '') {
      data.limit_buffer_pct = null;
    }

    try {
      await api.updateWatchlist(watchlistId, data);
      Utils.showToast('Watchlist updated successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * View watchlist details with symbols
   */
  async viewWatchlistDetails(id) {
    try {
      // Fetch watchlist and its symbols
      const [watchlistResponse, symbolsResponse] = await Promise.all([
        api.getWatchlistById(id),
        api.getWatchlistSymbols(id)
      ]);

      const watchlist = watchlistResponse.data;
      const symbols = symbolsResponse.data || [];
      const isBroadcast = this.isBroadcastWatchlist(watchlist);
      const webhookUrl = watchlist.webhook_url || `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
          <div class="modal-header">
            <div>
              <h3>Watchlist Details: ${Utils.escapeHTML(watchlist.name)}</h3>
              <p style="margin-top: 0.5rem; color: var(--color-neutral-600); font-size: 0.875rem;">
                ${Utils.escapeHTML(watchlist.description || 'No description')}
              </p>
            </div>
          </div>
          <div class="modal-body">
            <div class="mb-4">
              <h4 class="font-semibold mb-2">Watchlist Information</h4>
              <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
                <div>
                  <span class="text-neutral-600">Status:</span>
                  ${Utils.getStatusBadge(watchlist.is_active ? 'active' : 'inactive')}
                </div>
                <div>
                  <span class="text-neutral-600">Type:</span>
                  <strong>${isBroadcast ? 'Broadcast' : 'Standard'}</strong>
                </div>
                <div>
                  <span class="text-neutral-600">Created:</span>
                  ${Utils.formatRelativeTime(watchlist.created_at)}
                </div>
                <div>
                  <span class="text-neutral-600">Last Updated:</span>
                  ${Utils.formatRelativeTime(watchlist.updated_at)}
                </div>
                ${isBroadcast ? `
                  <div>
                    <span class="text-neutral-600">Instances:</span>
                    <strong>${(watchlist.instances || []).length}</strong>
                  </div>
                  <div>
                    <span class="text-neutral-600">Slug:</span>
                    <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
                  </div>
                ` : `
                  <div>
                    <span class="text-neutral-600">Total Symbols:</span>
                    <strong>${symbols.length}</strong>
                  </div>
                  <div></div>
                `}
              </div>
            </div>

            ${isBroadcast ? `
              <div class="mb-4">
                <h4 class="font-semibold mb-2">TradingView Webhook</h4>
                <div class="broadcast-card compact">
                  <div class="broadcast-card__row">
                    <div>
                      <p class="text-xs text-neutral-500">Webhook URL</p>
                      <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
                    </div>
                    <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
                  </div>
                  <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. Targets are the active instances assigned to this watchlist.</p>
                </div>
              </div>
              <div class="mb-4">
                <h4 class="font-semibold mb-2">Assigned Instances (${(watchlist.instances || []).length})</h4>
                ${(watchlist.instances || []).length === 0 ? '<p class="text-neutral-600 text-sm">No instances assigned.</p>' : `
                  <ul class="list">
                    ${(watchlist.instances || []).map(inst => `
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
                `}
              </div>
            ` : `
              <div class="mb-4">
                <h4 class="font-semibold mb-2">Symbols (${symbols.length})</h4>
                ${symbols.length === 0 ? `
                  <p class="text-center text-neutral-600" style="padding: 2rem;">
                    No symbols in this watchlist
                  </p>
                ` : `
                  <div class="table-container" style="max-height: 400px; overflow-y: auto;">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Exchange</th>
                          <th>Symbol</th>
                          <th>Quantity Type</th>
                          <th>Quantity</th>
                          <th>Product</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${symbols.map(s => `
                          <tr>
                            <td><span class="badge badge-neutral">${Utils.escapeHTML(s.exchange)}</span></td>
                            <td class="font-medium">${Utils.escapeHTML(s.symbol)}</td>
                            <td>${Utils.escapeHTML(s.qty_type || 'FIXED')}</td>
                            <td>${s.qty_value || 1}</td>
                            <td><span class="badge badge-info">${Utils.escapeHTML(s.product_type || 'MIS')}</span></td>
                            <td>${s.is_enabled ?
          '<span class="badge badge-success">Enabled</span>' :
          '<span class="badge badge-neutral">Disabled</span>'
        }</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `}
              </div>
            `}
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Close
            </button>
            <button class="btn btn-buy" onclick="this.closest('.modal-overlay').remove(); app.showEditWatchlistModal(${id})">
              Edit Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load watchlist details: ' + error.message, 'error');
    }
  }
  renderPausedPlaceholder() { }
}.prototype));
