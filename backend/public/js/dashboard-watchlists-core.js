/**
 * Simplifyed Admin V2 - Dashboard: Watchlists - accordion/card render core, snapshot resync,
 * toggle expand/collapse. Part of the dashboard-watchlists-*.js sub-split (see project notes).
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
      // Note: this used to also fetch api.getInstances() (unfiltered) here and store it on
      // this.instances "to warm the cache" - but nothing in the watchlists views actually reads
      // this.instances, and writing an unfiltered instance list there silently poisoned the
      // shared "active instances only" cache that Orders/Trades/Positions-fallback trust via
      // ensureInstancesLoaded(), causing inactive instances to leak into those views as soon as
      // a user visited Watchlists. Removed - see the same fix in dashboard-instances.js.
      const watchlistsRes = await api.getWatchlists();
      this.watchlists = watchlistsRes.data;
      this.resetWatchlistSymbolIndex();
      // Default to collapsed watchlists; user opt-in to load quotes/expansions
      this.expandedWatchlists = new Set();
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
}.prototype));
