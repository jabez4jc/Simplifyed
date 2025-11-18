/**
 * Simplifyed Admin V2 - Dashboard Application
 * Main application logic
 */

class DashboardApp {
  constructor() {
    this.currentView = 'dashboard';
    this.currentUser = null;
    this.instances = [];
    this.watchlists = [];
    this.pollingInterval = null;
    // Track watchlist quote polling intervals
    this.watchlistPollers = new Map();
    // Track positions polling interval (10 seconds)
    this.positionsPollingInterval = null;
    // Cache for quote data to prevent unnecessary DOM updates
    // Structure: { watchlistId_symbolId: { ltp, changePercent, volume } }
    this.quoteCache = new Map();
    // Track latest quote snapshot timestamp per watchlist
    this.watchlistQuoteSnapshots = new Map();
    this.isSidebarCollapsed = false;
    this.quickOrder = window.quickOrder || null;
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      this.loadSidebarState();
      this.applySidebarState();
      this.quickOrder = window.quickOrder || null;

      // Load current user
      await this.loadCurrentUser();

      // Setup navigation
      this.setupNavigation();

      // Load initial view
      await this.loadView('dashboard');

      // Note: Auto-refresh disabled to prevent page flicker
      // Individual polling mechanisms (quotes, positions) handle their own updates
      // this.startAutoRefresh();

      console.log('✅ Dashboard initialized');
    } catch (error) {
      console.error('Failed to initialize dashboard:', error);
      Utils.showToast('Failed to initialize dashboard', 'error');
    }
  }

  loadSidebarState() {
    const stored = localStorage.getItem('sidebarCollapsed');
    this.isSidebarCollapsed = stored === 'true';
  }

  applySidebarState() {
    document.body.classList.toggle('sidebar-collapsed', this.isSidebarCollapsed);
    const drawerRoot = document.querySelector('.drawer');
    if (drawerRoot) {
      drawerRoot.classList.toggle('sidebar-collapsed', this.isSidebarCollapsed);
    }

    const toggleBtn = document.getElementById('sidebar-collapse-btn');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', this.isSidebarCollapsed);
      toggleBtn.setAttribute(
        'title',
        this.isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
      );
    }
  }

  toggleSidebarCollapse() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    this.applySidebarState();
    localStorage.setItem('sidebarCollapsed', this.isSidebarCollapsed ? 'true' : 'false');
  }

  /**
   * Load current user
   */
  async loadCurrentUser() {
    try {
      const response = await api.getCurrentUser();
      this.currentUser = response.data;

      // Update UI
      const emailElement = document.getElementById('current-user-email');
      if (emailElement) {
        emailElement.textContent = this.currentUser.email;
      }

      // Update avatar
      const avatarElement = document.getElementById('user-avatar');
      if (avatarElement) {
        avatarElement.textContent = this.currentUser.email.charAt(0).toUpperCase();
      }
    } catch (error) {
      console.error('Failed to load user:', error);
    }
  }

  /**
   * Setup navigation
   */
  setupNavigation() {
    const navItems = document.querySelectorAll('[data-view]');

    navItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();

        const view = item.dataset.view;
        this.switchView(view);
      });
    });
  }

  /**
   * Switch view
   */
  switchView(viewName) {
    // Update active state
    const navItems = document.querySelectorAll('[data-view]');
    navItems.forEach((item) => {
      if (item.dataset.view === viewName) {
        item.classList.add('active', 'bg-primary', 'text-primary-content');
        item.classList.remove('hover:bg-base-200');
      } else {
        item.classList.remove('active', 'bg-primary', 'text-primary-content');
        item.classList.add('hover:bg-base-200');
      }
    });

    // Close drawer on mobile
    const drawerToggle = document.getElementById('drawer-toggle');
    if (drawerToggle) {
      drawerToggle.checked = false;
    }

    // Load view
    this.loadView(viewName);
  }

  /**
   * Load view
   */
  async loadView(viewName) {
    // Clean up watchlist pollers when leaving watchlists view
    if (this.currentView === 'watchlists' && viewName !== 'watchlists') {
      this.stopAllWatchlistPolling();
      this.stopPositionsPolling();
      if (window.quickOrder && typeof window.quickOrder.stopAllOptionPreviewPolling === 'function') {
        window.quickOrder.stopAllOptionPreviewPolling();
      }
    }

    this.currentView = viewName;

    // Update title
    const titles = {
      dashboard: 'Dashboard',
      instances: 'Instances',
      watchlists: 'Watchlists',
      orders: 'Orders',
      positions: 'Positions',
      settings: 'Settings',
    };

    document.getElementById('view-title').textContent =
      titles[viewName] || viewName;

    // Show loading
    const contentArea = document.getElementById('content-area');
    Utils.showLoading(contentArea);

    // Load view content
    try {
      switch (viewName) {
        case 'dashboard':
          await this.renderDashboardView();
          break;
        case 'instances':
          await this.renderInstancesView();
          break;
        case 'watchlists':
          await this.renderWatchlistsView();
          break;
        case 'orders':
          await this.renderOrdersView();
          break;
        case 'positions':
          await this.renderPositionsView();
          break;
        case 'settings':
          await settings.renderSettingsView();
          break;
        default:
          contentArea.innerHTML = '<p>View not found</p>';
      }
    } catch (error) {
      console.error(`Failed to load ${viewName} view:`, error);
      contentArea.innerHTML = `
        <div class="card">
          <p class="text-loss">Failed to load ${viewName}: ${error.message}</p>
        </div>
      `;
    }
  }

  /**
   * Render Dashboard View
   */
  async renderDashboardView() {
    const contentArea = document.getElementById('content-area');

    // Fetch data
    const [instancesRes, metricsRes] = await Promise.all([
      api.getInstances({ is_active: true }),
      api.getDashboardMetrics().catch(() => ({
        data: {
          live: {
            instances: [],
            total_available_balance: 0,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_pnl: 0,
          },
          analyzer: {
            instances: [],
            total_available_balance: 0,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_pnl: 0,
          },
        },
      })),
    ]);

    this.instances = instancesRes.data;
    const metrics = metricsRes.data;

    // Merge fund balance data into instances
    const allMetricsInstances = [...metrics.live.instances, ...metrics.analyzer.instances];
    const fundsMap = new Map();
    allMetricsInstances.forEach(mi => {
      fundsMap.set(mi.instance_id, {
        available_balance: mi.available_balance,
        realized_pnl: mi.realized_pnl,
        unrealized_pnl: mi.unrealized_pnl,
        total_pnl: mi.total_pnl,
      });
    });

    // Add fund data to instances
    this.instances = this.instances.map(instance => ({
      ...instance,
      ...(fundsMap.get(instance.id) || {
        available_balance: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        total_pnl: 0,
      }),
    }));

    // Render
    contentArea.innerHTML = `
      <!-- Live Mode Stats (Primary) -->
      <div class="mb-4">
        <div class="flex items-center mb-2">
          <h2 class="text-xl font-semibold">Live Trading</h2>
          <span class="ml-2 px-2 py-1 text-xs font-semibold bg-green-100 text-green-800 rounded">LIVE</span>
        </div>
        <div class="stats-grid">
          <div class="stat-card pnl-card ${Utils.getPnLBgClass(metrics.live.total_pnl)}">
            <div class="stat-label">Total P&L</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_pnl)}">
              ${Utils.formatCurrency(metrics.live.total_pnl)}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Realized P&L</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_realized_pnl)}">
              ${Utils.formatCurrency(metrics.live.total_realized_pnl)}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Unrealized P&L</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_unrealized_pnl)}">
              ${Utils.formatCurrency(metrics.live.total_unrealized_pnl)}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Available Balance</div>
            <div class="stat-value">
              ${Utils.formatCurrency(metrics.live.total_available_balance)}
            </div>
          </div>
        </div>
      </div>

      <!-- Analyzer Mode Stats (Secondary) -->
      ${metrics.analyzer.instances.length > 0 ? `
        <div class="mb-6">
          <div class="flex items-center mb-2">
            <h2 class="text-xl font-semibold text-neutral-600">Analyzer Mode</h2>
            <span class="ml-2 px-2 py-1 text-xs font-semibold bg-gray-200 text-gray-700 rounded">SIMULATION</span>
          </div>
          <div class="stats-grid opacity-75">
            <div class="stat-card bg-gray-50">
              <div class="stat-label">Total P&L</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_pnl)}">
                ${Utils.formatCurrency(metrics.analyzer.total_pnl)}
              </div>
            </div>

            <div class="stat-card bg-gray-50">
              <div class="stat-label">Realized P&L</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_realized_pnl)}">
                ${Utils.formatCurrency(metrics.analyzer.total_realized_pnl)}
              </div>
            </div>

            <div class="stat-card bg-gray-50">
              <div class="stat-label">Unrealized P&L</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_unrealized_pnl)}">
                ${Utils.formatCurrency(metrics.analyzer.total_unrealized_pnl)}
              </div>
            </div>

            <div class="stat-card bg-gray-50">
              <div class="stat-label">Available Balance</div>
              <div class="stat-value">
                ${Utils.formatCurrency(metrics.analyzer.total_available_balance)}
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Instances Table -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Active Instances</h3>
          <button class="btn btn-primary btn-sm" onclick="app.showAddInstanceModal()">
            + Add Instance
          </button>
        </div>
        <div class="table-container">
          ${this.renderInstancesTable(this.instances)}
        </div>
      </div>
    `;
  }

  /**
   * Render Instances View
   */
  async renderInstancesView() {
    const contentArea = document.getElementById('content-area');

    // Fetch instances and metrics
    const [instancesRes, metricsRes] = await Promise.all([
      api.getInstances(),
      api.getDashboardMetrics().catch(() => ({
        data: {
          live: { instances: [] },
          analyzer: { instances: [] },
        },
      })),
    ]);

    this.instances = instancesRes.data;
    const metrics = metricsRes.data;

    // Merge fund balance data into active instances only
    const allMetricsInstances = [...metrics.live.instances, ...metrics.analyzer.instances];
    const fundsMap = new Map();
    allMetricsInstances.forEach(mi => {
      fundsMap.set(mi.instance_id, {
        available_balance: mi.available_balance,
        realized_pnl: mi.realized_pnl,
        unrealized_pnl: mi.unrealized_pnl,
        total_pnl: mi.total_pnl,
      });
    });

    // Add fund data to active instances
    this.instances = this.instances.map(instance => ({
      ...instance,
      ...(instance.is_active && fundsMap.has(instance.id)
        ? fundsMap.get(instance.id)
        : {
            available_balance: null, // null indicates no data for inactive instances
            realized_pnl: instance.realized_pnl || 0,
            unrealized_pnl: instance.unrealized_pnl || 0,
            total_pnl: instance.total_pnl || 0,
          }),
    }));

    contentArea.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">All Instances</h3>
          <button class="btn btn-primary" onclick="app.showAddInstanceModal()">
            + Add Instance
          </button>
        </div>

        <!-- Bulk Actions Bar -->
        <div id="bulk-actions-bar" class="p-4 bg-neutral-50 border-b border-neutral-200" style="display: none;">
          <div class="flex items-center gap-4">
            <span id="selected-count" class="text-sm font-medium">0 selected</span>
            <div class="flex gap-2">
              <button class="btn btn-secondary btn-sm" onclick="app.bulkSetActive(true)">
                Set Active
              </button>
              <button class="btn btn-secondary btn-sm" onclick="app.bulkSetActive(false)">
                Set Inactive
              </button>
              <button class="btn btn-success btn-sm" onclick="app.bulkSetAnalyzerMode(false)">
                Set Live Mode
              </button>
              <button class="btn btn-warning btn-sm" onclick="app.bulkSetAnalyzerMode(true)">
                Set Analyzer Mode
              </button>
            </div>
          </div>
        </div>

        <div class="table-container">
          ${this.renderInstancesTable(this.instances, true)}
        </div>
      </div>
    `;
  }

  /**
   * Render instances table
   */
  renderInstancesTable(instances, showBulkActions = false) {
    if (instances.length === 0) {
      return '<p class="text-center text-neutral-600">No instances found</p>';
    }

    return `
      <table class="table">
        <thead>
          <tr>
            ${showBulkActions ? '<th><input type="checkbox" id="select-all-instances" onchange="app.toggleSelectAllInstances(this.checked)"></th>' : ''}
            <th>Name</th>
            <th>Broker</th>
            <th>Status</th>
            <th>Health</th>
            <th>Mode</th>
            <th class="text-right">Balance</th>
            <th class="text-right">Total P&L</th>
            <th class="text-right">Realized</th>
            <th class="text-right">Unrealized</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${instances.map(instance => `
            <tr>
              ${showBulkActions ? `<td><input type="checkbox" class="instances-bulk-checkbox" data-instance-id="${instance.id}" onchange="app.updateBulkActionsState()"></td>` : ''}
              <td class="font-medium">${Utils.escapeHTML(instance.name)}</td>
              <td>${Utils.escapeHTML(instance.broker || 'N/A')}</td>
              <td>
                ${instance.is_active
                  ? '<span class="badge badge-success">Active</span>'
                  : '<span class="badge badge-neutral">Inactive</span>'}
              </td>
              <td>${Utils.getStatusBadge(instance.health_status || 'unknown')}</td>
              <td>
                ${instance.is_analyzer_mode
                  ? '<span class="badge badge-warning">Analyzer</span>'
                  : '<span class="badge badge-success">Live</span>'}
              </td>
              <td class="text-right">
                ${instance.available_balance != null
                  ? Utils.formatCurrency(instance.available_balance)
                  : '<span class="text-neutral-400">-</span>'}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.total_pnl)}">
                ${Utils.formatCurrency(instance.total_pnl || 0)}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.realized_pnl)}">
                ${Utils.formatCurrency(instance.realized_pnl || 0)}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.unrealized_pnl)}">
                ${Utils.formatCurrency(instance.unrealized_pnl || 0)}
              </td>
              <td>
                <div class="flex gap-2">
                  <button class="btn btn-secondary btn-sm"
                          onclick="app.refreshInstance(${instance.id})"
                          title="Refresh">
                    🔄
                  </button>
                  <button class="btn btn-secondary btn-sm"
                          onclick="app.showEditInstanceModal(${instance.id})">
                    Edit
                  </button>
                  <button class="btn btn-${instance.is_analyzer_mode ? 'success' : 'warning'} btn-sm"
                          onclick="app.toggleAnalyzerMode(${instance.id}, ${!instance.is_analyzer_mode})">
                    ${instance.is_analyzer_mode ? 'Go Live' : 'Analyzer'}
                  </button>
                  <button class="btn btn-error btn-sm"
                          onclick="app.deleteInstance(${instance.id})">
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  /**
   * Render Watchlists View (Accordion Style)
   */
  async renderWatchlistsView() {
    const contentArea = document.getElementById('content-area');

    if (window.quickOrder && typeof window.quickOrder.stopAllOptionPreviewPolling === 'function') {
      window.quickOrder.stopAllOptionPreviewPolling();
    }

    // Fetch watchlists
    const response = await api.getWatchlists();
    this.watchlists = response.data;
    this.expandedWatchlists = this.expandedWatchlists || new Set();

    // Fetch instances for quote polling
    const instancesRes = await api.getInstances();
    this.instances = instancesRes.data;

    contentArea.innerHTML = `
      <section class="watchlists-page">
        <div class="card">
          <div class="watchlists-toolbar">
            <div class="flex items-center gap-2">
              <h3>Watchlists</h3>
              <button class="field-help" title="Create collections of symbols, assign instances, and access quick orders per instrument.">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <circle cx="12" cy="16" r="0.5"></circle>
                </svg>
              </button>
            </div>
            <div class="toolbar-actions">
              <button class="btn btn-outline btn-sm" onclick="app.renderWatchlistsView()">
                Refresh data
              </button>
              <button class="btn btn-primary" onclick="app.showAddWatchlistModal()">
                + Add Watchlist
              </button>
            </div>
          </div>
        </div>

        <div id="watchlists-container" class="watchlists-grid">
          ${await this.renderWatchlistsAccordion(this.watchlists, true)}
        </div>

        <div class="card">
          <div class="card-header" style="border-bottom: 1px solid var(--color-neutral-200);">
            <div class="tabs" id="positions-orders-tabs">
              <button class="tab-button active" data-tab="positions" onclick="app.switchTab('positions')">
                💼 Positions
              </button>
              <button class="tab-button" data-tab="orders" onclick="app.switchTab('orders')">
                📝 Orders
              </button>
            </div>
          </div>
          <div class="tab-content">
            <div id="tab-positions" class="tab-panel active">
              <div class="p-4">Loading positions...</div>
            </div>
            <div id="tab-orders" class="tab-panel hidden">
              <div class="p-4">Loading orders...</div>
            </div>
          </div>
        </div>
      </section>
    `;

    // Load positions by default and start auto-refresh
    this.startPositionsPolling();
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
          <button class="btn btn-primary btn-sm mt-2" onclick="app.showAddWatchlistModal()">
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

  /**
   * Render individual watchlist card with accordion
   */
  async renderWatchlistCard(wl, isExpanded) {
    const statusColor = wl.is_active ? 'success' : 'neutral';

    return `
      <article class="watchlist-card" data-watchlist-id="${wl.id}">
        <div class="watchlist-card__header">
          <button
            id="watchlist-toggle-${wl.id}"
            class="watchlist-card__toggle ${isExpanded ? 'is-open' : ''}"
            aria-expanded="${isExpanded}"
            onclick="app.toggleWatchlist(${wl.id})"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div class="watchlist-card__info">
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h4>${Utils.escapeHTML(wl.name)}</h4>
                <p>${Utils.escapeHTML(wl.description || 'No description provided')}</p>
              </div>
              <span class="watchlist-card__status ${statusColor}">
                ${wl.is_active ? 'Active' : 'Paused'}
              </span>
            </div>
            <div class="watchlist-card__meta">
              <span>${wl.symbol_count || 0} symbols</span>
              <span>•</span>
              <span>${wl.instance_count || 0} instances</span>
            </div>
            <div class="watchlist-card__actions">
              <button class="watchlist-actions__button" onclick="app.showAddSymbolModal(${wl.id})">
                + Add Symbol
              </button>
              <button class="watchlist-actions__button" onclick="app.showEditWatchlistModal(${wl.id})">
                ✏️ Edit Watchlist
              </button>
              <button class="watchlist-actions__button" onclick="app.manageWatchlistInstances(${wl.id})">
                🔗 Manage Instances
              </button>
              <button class="watchlist-actions__button danger" onclick="app.deleteWatchlist(${wl.id})">
                🗑️ Delete
              </button>
            </div>
          </div>
        </div>

        <div id="watchlist-content-${wl.id}" class="watchlist-card__body ${isExpanded ? 'is-visible' : ''}">
          <div id="watchlist-symbols-${wl.id}">
            ${isExpanded ? await this.renderWatchlistSymbols(wl.id) : '<p class="text-neutral-600">Loading...</p>'}
          </div>
        </div>
      </article>
    `;
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

      // Start polling after DOM is ready
      this.startWatchlistPolling(watchlistId);
    }
  }

  /**
   * Render symbols for a watchlist
   */
  async renderWatchlistSymbols(watchlistId) {
    try {
      const response = await api.getWatchlistSymbols(watchlistId);
      const symbols = response.data;

      if (symbols.length === 0) {
        return '<p class="text-neutral-600 text-sm">No symbols added yet</p>';
      }

      return `
        <div class="watchlist-feed-meta" data-watchlist-meta="${watchlistId}">
          <span class="text-xs text-neutral-500">Quotes auto-refresh via the shared market data feed.</span>
          <span class="text-xs text-neutral-500" data-watchlist-last-update="${watchlistId}">Last update: waiting for feed…</span>
          <span class="text-xs text-neutral-500" data-watchlist-feed-source="${watchlistId}">Source: —</span>
          <span class="text-xs text-neutral-500" data-watchlist-feed-coverage="${watchlistId}"></span>
        </div>
        <table class="table watchlist-table" id="watchlist-table-${watchlistId}">
          <thead>
            <tr>
              <th style="width: 40px;"></th>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Type</th>
              <th>Expiry</th>
              <th>Strike</th>
              <th>Lot Size</th>
              <th>LTP</th>
              <th>Change %</th>
              <th>Volume</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${symbols.map(sym => `
              <tr class="symbol-row"
                  data-symbol-id="${sym.id}"
                  data-symbol="${sym.symbol}"
                  data-exchange="${sym.exchange}"
                  data-symbol-type="${sym.symbol_type || 'UNKNOWN'}"
                  data-tradable-equity="${sym.tradable_equity ? 1 : 0}"
                  data-tradable-futures="${sym.tradable_futures ? 1 : 0}"
                  data-tradable-options="${sym.tradable_options ? 1 : 0}"
                  data-underlying="${Utils.escapeHTML(sym.underlying_symbol || sym.symbol)}">
                <td>
                  <button
                    class="btn-toggle-expansion"
                    data-watchlist-id="${watchlistId}"
                    data-symbol-id="${sym.id}"
                    data-toggle-symbol="${sym.id}"
                    type="button"
                    title="Expand trading controls">
                    ▼
                  </button>
                </td>
                <td class="font-medium">${Utils.escapeHTML(sym.symbol)}</td>
                <td>${Utils.escapeHTML(sym.exchange)}</td>
                <td>
                  <span class="badge ${this.getSymbolTypeBadgeClass(sym.symbol_type || 'UNKNOWN')}">
                    ${sym.symbol_type || 'UNKNOWN'}
                  </span>
                </td>
                <td class="text-sm">${sym.expiry ? Utils.escapeHTML(sym.expiry) : '-'}</td>
                <td class="text-sm">${sym.strike ? sym.strike : '-'}</td>
                <td>${sym.lot_size || 1}</td>
                <td class="ltp-cell" data-symbol-id="${sym.id}">
                  <span class="text-neutral-500">-</span>
                </td>
                <td class="change-cell" data-symbol-id="${sym.id}">
                  <span class="text-neutral-500">-</span>
                </td>
                <td class="volume-cell" data-symbol-id="${sym.id}">
                  <span class="text-neutral-500">-</span>
                </td>
                <td>
                  <button class="btn btn-error btn-sm" onclick="app.removeSymbol(${watchlistId}, ${sym.id})">
                    Remove
                  </button>
                </td>
              </tr>
              <tr id="expansion-row-${sym.id}" class="expansion-row" style="display: none;">
                <td colspan="11" class="expansion-cell">
                  <div id="expansion-content-${sym.id}" class="expansion-content" data-loaded="false">
                    <p class="text-neutral-500 text-sm">Loading...</p>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (error) {
      return `<p class="text-error">Failed to load symbols: ${error.message}</p>`;
    }
  }

  /**
   * Get badge class for symbol type
   */
  getSymbolTypeBadgeClass(type) {
    const classes = {
      INDEX: 'badge-primary',    // Indices - cannot be traded directly
      EQUITY: 'badge-info',       // Equity stocks
      FUTURES: 'badge-warning',   // Futures contracts
      OPTIONS: 'badge-success',   // Options contracts
      UNKNOWN: 'badge-neutral',   // Unknown/unclassified
    };
    return classes[type] || 'badge-neutral';
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
      const button = event.target.closest('.btn-toggle-expansion');
      if (button) {
        const wlId = parseInt(button.dataset.watchlistId);
        const symId = parseInt(button.dataset.symbolId);
        console.log('[Watchlist] Expansion toggle clicked', { watchlistId: wlId, symbolId: symId });
        this.handleSymbolToggle(wlId, symId);
      }
    };

    table.addEventListener('click', table._expansionListener);
  }

  handleSymbolToggle(watchlistId, symbolId) {
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
    // Stop existing poller if any
    this.stopWatchlistPolling(watchlistId);

    // Fetch quotes immediately
    await this.updateWatchlistQuotes(watchlistId, { force: true });

    // Start 10-second polling
    const intervalId = setInterval(async () => {
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

  startPositionsPolling() {
    this.stopPositionsPolling();
    this.refreshWatchlistPositions({ showLoader: true });
    this.positionsPollingInterval = setInterval(() => {
      this.refreshWatchlistPositions();
    }, 10000);
  }

  stopPositionsPolling() {
    if (this.positionsPollingInterval) {
      clearInterval(this.positionsPollingInterval);
      this.positionsPollingInterval = null;
    }
  }

  async updateWatchlistQuotes(watchlistId, { force = false } = {}) {
    try {
      // Check if watchlist table exists in DOM (view might be re-rendering)
      const table = document.getElementById(`watchlist-table-${watchlistId}`);
      if (!table) {
        console.log(`Watchlist table ${watchlistId} not found in DOM, skipping quote update`);
        return;
      }

      // Get watchlist symbols
      const response = await api.getWatchlistSymbols(watchlistId);
      const symbols = response.data;

      if (symbols.length === 0) {
        this.updateWatchlistQuoteMeta(watchlistId, { statusText: 'No symbols configured' });
        return;
      }

      // Get the designated market data instance (primary with failover to secondary)
      // This instance does not need to be mapped to the watchlist
      let marketDataInstance;
      try {
        const mdResponse = await api.getMarketDataInstance();
        marketDataInstance = mdResponse.data;
        console.log(`Using market data instance: ${marketDataInstance.name} (${marketDataInstance.market_data_role})`);
      } catch (error) {
        console.warn('No healthy market data instance available for quotes:', error.message);
        this.updateWatchlistQuoteMeta(watchlistId, {
          statusText: 'Market data feed unavailable',
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

      // Fetch quotes from the market data instance
      const quotesResponse = await api.getQuotes(symbolsForQuotes, marketDataInstance.id);
      const quotes = quotesResponse.data || [];
      const snapshotTimestamp = quotesResponse.cachedAt || Date.now();

      this.updateWatchlistQuoteMeta(watchlistId, {
        timestamp: snapshotTimestamp,
        source: quotesResponse.source || 'live',
        total: symbols.length,
        filled: quotes.length,
      });

      const lastSnapshotTs = this.watchlistQuoteSnapshots.get(watchlistId);
      if (!force && lastSnapshotTs && snapshotTimestamp && snapshotTimestamp <= lastSnapshotTs) {
        return;
      }

      this.watchlistQuoteSnapshots.set(watchlistId, snapshotTimestamp);

      // Update UI for each symbol
      quotes.forEach(quote => {
        const symbol = symbols.find(s =>
          s.exchange === quote.exchange && s.symbol === quote.symbol
        );

        if (symbol) {
          this.updateSymbolQuote(watchlistId, symbol.id, quote);
        }
      });
    } catch (error) {
      console.error('Failed to update watchlist quotes', error);
      this.updateWatchlistQuoteMeta(watchlistId, {
        statusText: 'Quote refresh failed',
      });
    }
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

    // Calculate change percent
    let changePercent = null;
    if (quote.ltp !== undefined && quote.prev_close !== undefined && quote.prev_close > 0) {
      changePercent = ((quote.ltp - quote.prev_close) / quote.prev_close) * 100;
    }

    // Helper to check if cell has placeholder or is empty
    const hasPlaceholder = (cell) => {
      const text = cell.textContent.trim();
      return text === '-' || text === '';
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

    // Update LTP if changed OR cell is empty/placeholder
    if (quote.ltp !== undefined && (cached.ltp !== quote.ltp || hasPlaceholder(ltpCell))) {
      const valueChanged = cached.ltp !== quote.ltp && !hasPlaceholder(ltpCell);
      const span = getOrCreateSpan(ltpCell, 'font-medium');
      span.textContent = `₹${Utils.formatNumber(quote.ltp)}`;

      // Add highlight animation if value actually changed
      if (valueChanged) {
        addHighlight(ltpCell, 'value-updated');
      }

      cached.ltp = quote.ltp;
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
   * Render Orders View
   */
  async renderOrdersView() {
    const contentArea = document.getElementById('content-area');

    // Fetch orders
    const response = await api.getOrders();
    const orders = response.data;

    contentArea.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Orders</h3>
          <div class="flex gap-2">
            <select class="form-select" onchange="app.filterOrders(this.value)">
              <option value="">All Status</option>
              <option value="pending">Pending</option>
              <option value="open">Open</option>
              <option value="complete">Complete</option>
              <option value="cancelled">Cancelled</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>
        <div class="table-container">
          ${this.renderOrdersTable(orders)}
        </div>
      </div>
    `;
  }

  /**
   * Render orders table
   */
  renderOrdersTable(orders) {
    if (orders.length === 0) {
      return '<p class="text-center text-neutral-600">No orders found</p>';
    }

    return `
      <table class="table">
        <thead>
          <tr>
            <th>Instance</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Quantity</th>
            <th>Type</th>
            <th>Status</th>
            <th>Placed At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${orders.slice(0, 100).map(order => `
            <tr>
              <td class="font-medium">${Utils.escapeHTML(order.instance_name || 'N/A')}</td>
              <td>${Utils.escapeHTML(order.symbol)}</td>
              <td>
                <span class="badge ${order.side === 'BUY' ? 'badge-success' : 'badge-error'}">
                  ${order.side}
                </span>
              </td>
              <td>${order.quantity}</td>
              <td>${order.order_type}</td>
              <td>${Utils.getStatusBadge(order.status)}</td>
              <td>${Utils.formatRelativeTime(order.placed_at)}</td>
              <td>
                ${order.status === 'pending' || order.status === 'open' ? `
                  <button class="btn btn-error btn-sm"
                          onclick="app.cancelOrder(${order.id})">
                    Cancel
                  </button>
                ` : '-'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  /**
   * Render Positions View
   */
  async renderPositionsView() {
    const contentArea = document.getElementById('content-area');

    try {
      // Fetch ALL positions from all active instances (including closed)
      const response = await api.getAllPositions(false); // onlyOpen = false
      const data = response.data;

      if (data.instances.length === 0) {
        contentArea.innerHTML = `
          <div class="card">
            <p class="text-center text-neutral-600">No active instances found</p>
          </div>
        `;
        return;
      }

      contentArea.innerHTML = `
        <!-- Overall Summary Card -->
        <div class="card mb-6">
          <div class="card-header">
            <h3 class="card-title">All Positions Summary</h3>
          </div>
          <div class="p-4">
            <div class="grid grid-cols-3 gap-4">
              <div class="text-center">
                <div class="text-sm text-neutral-600 mb-1">Open Positions</div>
                <div class="text-2xl font-semibold">${data.overall_open_positions}</div>
              </div>
              <div class="text-center">
                <div class="text-sm text-neutral-600 mb-1">Closed Positions</div>
                <div class="text-2xl font-semibold">${data.overall_closed_positions}</div>
              </div>
              <div class="text-center">
                <div class="text-sm text-neutral-600 mb-1">Overall P&L</div>
                <div class="text-2xl font-semibold ${Utils.getPnLColorClass(data.overall_total_pnl)}">
                  ${Utils.formatCurrency(data.overall_total_pnl)}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Instance Positions -->
        ${data.instances.map(inst => `
          <div class="card mb-6">
            <div class="card-header">
              <div>
                <h3 class="card-title">${Utils.escapeHTML(inst.instance_name)}</h3>
                <div class="flex gap-4 mt-1 text-sm text-neutral-600">
                  <span>Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
                  <span>Open: <span class="font-medium">${inst.open_positions_count}</span></span>
                  <span>Closed: <span class="font-medium">${inst.closed_positions_count}</span></span>
                  <span>P&L: <span class="font-medium ${Utils.getPnLColorClass(inst.total_pnl)}">${Utils.formatCurrency(inst.total_pnl)}</span></span>
                </div>
              </div>
              <button class="btn btn-error btn-sm"
                      onclick="app.closeAllPositions(${inst.instance_id})">
                Close All Positions
              </button>
            </div>
            <div class="table-container">
              ${inst.error ?
                `<p class="text-center text-error-600 p-4">${Utils.escapeHTML(inst.error)}</p>` :
                (inst.positions.length > 0 ?
                  this.renderPositionsTable(inst.positions) :
                  '<p class="text-center text-neutral-600 p-4">No positions</p>')
              }
            </div>
          </div>
        `).join('')}
      `;
    } catch (error) {
      contentArea.innerHTML = `
        <div class="card">
          <p class="text-center text-error-600">Failed to load positions: ${error.message}</p>
        </div>
      `;
    }
  }

  /**
   * Render positions table
   */
  renderPositionsTable(positions) {
    return `
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Quantity</th>
            <th>Product</th>
            <th class="text-right">Avg Price</th>
            <th class="text-right">LTP</th>
            <th class="text-right">P&L</th>
          </tr>
        </thead>
        <tbody>
          ${positions.map(pos => {
            const pnl = parseFloat(pos.pnl || pos.unrealized_pnl || pos.mtm || 0);
            return `
              <tr>
                <td class="font-medium">${Utils.escapeHTML(pos.symbol || pos.tradingsymbol)}</td>
                <td>${pos.quantity || pos.netqty || pos.net_quantity || 0}</td>
                <td>${pos.product || pos.product_type || '-'}</td>
                <td class="text-right">${Utils.formatCurrency(pos.average_price || pos.avg_price || 0)}</td>
                <td class="text-right">${Utils.formatCurrency(pos.ltp || pos.last_price || 0)}</td>
                <td class="text-right ${Utils.getPnLColorClass(pnl)}">
                  ${Utils.formatCurrency(pnl)}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  /**
   * Show add instance modal
   */
  showAddInstanceModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay symbol-search-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Instance</h3>
        </div>
        <div class="modal-body">
          <form id="add-instance-form">
            <div class="form-group">
              <label class="form-label">Instance Name *</label>
              <input type="text" name="name" class="form-input" required>
            </div>

            <div class="form-group">
              <label class="form-label">Host URL *</label>
              <input type="url" name="host_url" id="instance-host-url" class="form-input"
                     placeholder="http://localhost:5000" required>
            </div>

            <div class="form-group">
              <label class="form-label">API Key *</label>
              <input type="text" name="api_key" id="instance-api-key" class="form-input" required>
            </div>

            <div class="form-group">
              <label class="form-label">Broker (auto-detected)</label>
              <div style="display: flex; gap: 0.5rem; align-items: center;">
                <input type="text" name="broker" id="instance-broker" class="form-input" readonly
                       placeholder="Click 'Test Connection' to detect">
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="app.testInstanceConnection()">
                  Test Connection
                </button>
              </div>
              <small id="connection-status" class="form-help" style="display: block; margin-top: 0.25rem;"></small>
            </div>

            <div class="form-group">
              <label class="form-label">Verify API Key</label>
              <button type="button" class="btn btn-secondary btn-sm" style="width: 100%;"
                      onclick="app.testInstanceApiKey()">
                Test API Key with Funds Endpoint
              </button>
              <small id="apikey-status" class="form-help" style="display: block; margin-top: 0.25rem;"></small>
            </div>

            <div class="form-group">
              <label class="form-label">Market Data Role</label>
              <select name="market_data_role" class="form-select">
                <option value="none">None - Don't use for market data</option>
                <option value="primary">Primary - Use first for market data calls</option>
                <option value="secondary">Secondary - Fallback for market data calls</option>
              </select>
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Only Primary/Secondary instances will be used for fetching market data (quotes, depth, etc.)
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Strategy Tag</label>
              <input type="text" name="strategy_tag" class="form-input" value="default">
            </div>

            <div class="form-group">
              <label class="form-label">Target Profit</label>
              <input type="number" name="target_profit" class="form-input" step="0.01" placeholder="5000">
            </div>

            <div class="form-group">
              <label class="form-label">Target Loss</label>
              <input type="number" name="target_loss" class="form-input" step="0.01" placeholder="2000">
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-primary" onclick="app.submitAddInstance()">
            Add Instance
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
  }

  /**
   * Submit add instance form
   */
  async submitAddInstance() {
    const form = document.getElementById('add-instance-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Check if broker was detected
    const brokerField = document.getElementById('instance-broker');
    if (!brokerField.value) {
      Utils.showToast('Please test connection to detect broker before adding instance', 'warning');
      return;
    }

    try {
      await api.createInstance(data);
      Utils.showToast('Instance added successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Test connection to OpenAlgo instance
   */
  async testInstanceConnection() {
    const hostUrl = document.getElementById('instance-host-url').value;
    const apiKey = document.getElementById('instance-api-key').value;
    const statusEl = document.getElementById('connection-status');
    const brokerField = document.getElementById('instance-broker');

    if (!hostUrl || !apiKey) {
      statusEl.textContent = '⚠️ Please enter Host URL and API Key first';
      statusEl.style.color = 'var(--color-warning)';
      return;
    }

    statusEl.textContent = '⏳ Testing connection...';
    statusEl.style.color = 'var(--color-info)';

    try {
      const response = await api.testConnection(hostUrl, apiKey);

      if (response.status === 'success' && response.data?.broker) {
        brokerField.value = response.data.broker;
        statusEl.textContent = `✅ Connection successful! Broker: ${response.data.broker}`;
        statusEl.style.color = 'var(--color-profit)';
        Utils.showToast(`Connected successfully to ${response.data.broker}`, 'success');
      } else {
        statusEl.textContent = '❌ ' + (response.message || 'Connection failed');
        statusEl.style.color = 'var(--color-loss)';
        Utils.showToast(response.message || 'Connection test failed', 'error');
      }
    } catch (error) {
      statusEl.textContent = '❌ ' + error.message;
      statusEl.style.color = 'var(--color-loss)';
      Utils.showToast('Connection test failed: ' + error.message, 'error');
    }
  }

  /**
   * Test connection in edit modal
   */
  async testEditInstanceConnection() {
    const hostUrlInput = document.getElementById('edit-instance-host-url');
    const apiKeyInput = document.getElementById('edit-instance-api-key');
    const statusEl = document.getElementById('edit-connection-status');
    const brokerField = document.getElementById('edit-instance-broker');

    if (!hostUrlInput || !apiKeyInput || !statusEl || !brokerField) {
      console.warn('Edit instance connection fields missing');
      return;
    }

    const hostUrl = hostUrlInput.value;
    const apiKey = apiKeyInput.value;

    if (!hostUrl || !apiKey) {
      statusEl.textContent = '⚠️ Please enter Host URL and API Key first';
      statusEl.style.color = 'var(--color-warning)';
      return;
    }

    statusEl.textContent = '⏳ Testing connection...';
    statusEl.style.color = 'var(--color-info)';

    try {
      const response = await api.testConnection(hostUrl, apiKey);

      if (response.status === 'success' && response.data?.broker) {
        brokerField.value = response.data.broker;
        statusEl.textContent = `✅ Connection successful! Broker: ${response.data.broker}`;
        statusEl.style.color = 'var(--color-profit)';
        Utils.showToast(`Connected successfully to ${response.data.broker}`, 'success');
      } else {
        statusEl.textContent = '❌ ' + (response.message || 'Connection failed');
        statusEl.style.color = 'var(--color-loss)';
        Utils.showToast(response.message || 'Connection test failed', 'error');
      }
    } catch (error) {
      statusEl.textContent = '❌ ' + error.message;
      statusEl.style.color = 'var(--color-loss)';
      Utils.showToast('Connection test failed: ' + error.message, 'error');
    }
  }

  /**
   * Test API key validity with funds endpoint
   */
  async testInstanceApiKey() {
    const hostUrl = document.getElementById('instance-host-url').value;
    const apiKey = document.getElementById('instance-api-key').value;
    const statusEl = document.getElementById('apikey-status');

    if (!hostUrl || !apiKey) {
      statusEl.textContent = '⚠️ Please enter Host URL and API Key first';
      statusEl.style.color = 'var(--color-warning)';
      return;
    }

    statusEl.textContent = '⏳ Validating API key with funds endpoint...';
    statusEl.style.color = 'var(--color-info)';

    try {
      const response = await api.testApiKey(hostUrl, apiKey);

      if (response.status === 'success') {
        const funds = response.data?.funds;
        const cash = funds?.availablecash || 'N/A';
        statusEl.textContent = `✅ API Key valid! Available Cash: ₹${cash}`;
        statusEl.style.color = 'var(--color-profit)';
        Utils.showToast('API key validated successfully', 'success');
      } else {
        statusEl.textContent = '❌ ' + (response.message || 'Invalid API key');
        statusEl.style.color = 'var(--color-loss)';
        Utils.showToast(response.message || 'API key validation failed', 'error');
      }
    } catch (error) {
      statusEl.textContent = '❌ ' + error.message;
      statusEl.style.color = 'var(--color-loss)';
      Utils.showToast('API key validation failed: ' + error.message, 'error');
    }
  }

  /**
   * Show add watchlist modal
   */
  showAddWatchlistModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay symbol-search-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Watchlist</h3>
        </div>
        <div class="modal-body">
          <form id="add-watchlist-form">
            <div class="form-group">
              <label class="form-label">Watchlist Name *</label>
              <input type="text" name="name" class="form-input" required>
            </div>

            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea name="description" class="form-input" rows="3"></textarea>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-primary" onclick="app.submitAddWatchlist()">
            Add Watchlist
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  /**
   * Submit add watchlist form
   */
  async submitAddWatchlist() {
    const form = document.getElementById('add-watchlist-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    try {
      await api.createWatchlist(data);
      Utils.showToast('Watchlist added successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Refresh instance
   */
  async refreshInstance(instanceId) {
    try {
      Utils.showToast('Refreshing instance...', 'info', 2000);
      await api.refreshInstance(instanceId);
      Utils.showToast('Instance refreshed', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Toggle analyzer mode
   */
  async toggleAnalyzerMode(instanceId, mode) {
    const confirmed = await Utils.confirm(
      `Are you sure you want to ${mode ? 'enable' : 'disable'} analyzer mode?`,
      'Confirm Analyzer Mode Toggle'
    );

    if (!confirmed) return;

    try {
      Utils.showToast('Toggling analyzer mode...', 'info', 2000);
      await api.toggleAnalyzer(instanceId, mode);
      Utils.showToast(`Analyzer mode ${mode ? 'enabled' : 'disabled'}`, 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Delete instance
   */
  async deleteInstance(instanceId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to delete this instance? This action cannot be undone.',
      'Confirm Delete'
    );

    if (!confirmed) return;

    try {
      await api.deleteInstance(instanceId);
      Utils.showToast('Instance deleted', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Toggle select all instances checkbox
   */
  toggleSelectAllInstances(checked) {
    const checkboxes = document.querySelectorAll('.instances-bulk-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = checked;
    });
    this.updateBulkActionsState();
  }

  /**
   * Update bulk actions bar visibility and count
   */
  updateBulkActionsState() {
    const checkboxes = document.querySelectorAll('.instances-bulk-checkbox:checked');
    const count = checkboxes.length;
    const bulkActionsBar = document.getElementById('bulk-actions-bar');
    const selectedCount = document.getElementById('selected-count');

    if (bulkActionsBar && selectedCount) {
      if (count > 0) {
        bulkActionsBar.style.display = 'block';
        selectedCount.textContent = `${count} selected`;
      } else {
        bulkActionsBar.style.display = 'none';
      }
    }

    // Update select-all checkbox state
    const selectAllCheckbox = document.getElementById('select-all-instances');
    const allCheckboxes = document.querySelectorAll('.instances-bulk-checkbox');
    if (selectAllCheckbox && allCheckboxes.length > 0) {
      selectAllCheckbox.checked = checkboxes.length === allCheckboxes.length;
      selectAllCheckbox.indeterminate = checkboxes.length > 0 && checkboxes.length < allCheckboxes.length;
    }
  }

  /**
   * Get selected instance IDs
   */
  getSelectedInstanceIds() {
    const checkboxes = document.querySelectorAll('.instances-bulk-checkbox:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.dataset.instanceId));
  }

  /**
   * Bulk set active/inactive status
   */
  async bulkSetActive(isActive) {
    const instanceIds = this.getSelectedInstanceIds();
    if (instanceIds.length === 0) {
      Utils.showToast('No instances selected', 'warning');
      return;
    }

    const action = isActive ? 'activate' : 'deactivate';
    const confirmed = await Utils.confirm(
      `Are you sure you want to ${action} ${instanceIds.length} instance(s)?`,
      `Confirm ${action.charAt(0).toUpperCase() + action.slice(1)}`
    );

    if (!confirmed) return;

    try {
      await api.bulkUpdateInstances({
        instance_ids: instanceIds,
        is_active: isActive,
      });
      Utils.showToast(`${instanceIds.length} instance(s) ${isActive ? 'activated' : 'deactivated'}`, 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Bulk set analyzer mode
   */
  async bulkSetAnalyzerMode(isAnalyzerMode) {
    const instanceIds = this.getSelectedInstanceIds();
    if (instanceIds.length === 0) {
      Utils.showToast('No instances selected', 'warning');
      return;
    }

    const mode = isAnalyzerMode ? 'Analyzer' : 'Live';
    const confirmed = await Utils.confirm(
      `Are you sure you want to set ${instanceIds.length} instance(s) to ${mode} mode?`,
      `Confirm Set ${mode} Mode`
    );

    if (!confirmed) return;

    try {
      await api.bulkUpdateInstances({
        instance_ids: instanceIds,
        is_analyzer_mode: isAnalyzerMode,
      });
      Utils.showToast(`${instanceIds.length} instance(s) set to ${mode} mode`, 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Show add symbol modal with search
   */
  async showAddSymbolModal(watchlistId) {
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
          <button class="btn btn-secondary" onclick="app.closeSymbolSearchModal()">
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

      resultsContainer.innerHTML = `
        <div class="space-y-2">
          <p class="text-sm text-neutral-700 font-semibold">${results.length} results found:</p>
          <div class="max-h-96 overflow-y-auto space-y-2">
              ${results.map(sym => `
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

  showSymbolConfigModal(symbolData) {
    const defaults = this.getSymbolTradableDefaults(symbolData);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 560px;">
        <div class="modal-header">
          <h3>Configure Symbol</h3>
        </div>
        <div class="modal-body">
          <p class="text-sm text-neutral-600 mb-4">
            Choose which trade modes should be enabled for <strong>${Utils.escapeHTML(symbolData.tradingsymbol || symbolData.symbol)}</strong>.
          </p>
          <form id="symbol-config-form" class="space-y-4">
            <div class="p-3 border rounded-lg bg-neutral-50">
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
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_equity" ${defaults.equity ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Direct (Equity) Trading</p>
                  <p class="text-sm text-neutral-600">Use BUY/SELL/EXIT buttons for spot positions.</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_futures" ${defaults.futures ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Futures Trading</p>
                  <p class="text-sm text-neutral-600">Route BUY/SELL/EXIT to futures contracts.</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_options" ${defaults.options ? 'checked' : ''}>
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
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="app.cancelSymbolConfig()">
            Cancel
          </button>
          <button class="btn btn-primary" onclick="app.confirmAddSymbol()">
            Add Symbol
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.symbolConfigModal = modal;
  }

  cancelSymbolConfig() {
    if (this.symbolConfigModal) {
      this.symbolConfigModal.remove();
      this.symbolConfigModal = null;
    }
    this.pendingSymbolData = null;
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
      this.pendingSymbolData.tradingsymbol ||
      this.pendingSymbolData.symbol;

    try {
      Utils.showToast('Adding symbol...', 'info');
      await api.addSymbol(this.currentWatchlistId, {
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
      });

      Utils.showToast('Symbol added successfully', 'success');

      if (this.symbolConfigModal) {
        this.symbolConfigModal.remove();
        this.symbolConfigModal = null;
      }
      this.pendingSymbolData = null;

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
              <label class="flex items-center gap-3 p-2 border rounded hover:bg-neutral-50 cursor-pointer">
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
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-primary" onclick="app.submitInstanceAssignments(${watchlistId})">
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

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to cancel this order?',
      'Confirm Cancel'
    );

    if (!confirmed) return;

    try {
      await api.cancelOrder(orderId);
      Utils.showToast('Order cancelled', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Close all positions
   */
  async closeAllPositions(instanceId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to close ALL positions for this instance?',
      'Confirm Close All'
    );

    if (!confirmed) return;

    try {
      await api.closePositions(instanceId);
      Utils.showToast('Close positions request sent', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Refresh current view
   */
  async refreshCurrentView() {
    await this.loadView(this.currentView);
  }

  /**
   * Start auto-refresh
   * Note: Does not refresh watchlists view to avoid conflicts with watchlist polling
   */
  startAutoRefresh() {
    // Clear existing interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Refresh every 15 seconds, but skip watchlists view
    // to avoid conflicts with independent watchlist polling
    this.pollingInterval = setInterval(() => {
      // Only refresh if not on watchlists view
      // Watchlists view has its own polling mechanism
      if (this.currentView !== 'watchlists') {
        this.refreshCurrentView();
      }
    }, 15000);
  }

  /**
   * Switch between Positions and Orders tabs
   */
  async switchTab(tabName) {
    // Update tab buttons
    const tabs = document.querySelectorAll('.tab-button');
    tabs.forEach(tab => {
      if (tab.dataset.tab === tabName) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Update tab panels
    const panels = document.querySelectorAll('.tab-panel');
    panels.forEach(panel => {
      panel.classList.add('hidden');
    });

    const activePanel = document.getElementById(`tab-${tabName}`);
    if (activePanel) {
      activePanel.classList.remove('hidden');
    }

    // Load content and manage polling
    if (tabName === 'positions') {
      // Start positions auto-refresh (10 seconds)
      this.startPositionsPolling();
    } else if (tabName === 'orders') {
      // Stop positions polling when switching away
      this.stopPositionsPolling();
      await this.loadOrdersTab();
    }
  }

  async refreshWatchlistPositions({ showLoader = false } = {}) {
    const positionsPanel = document.getElementById('tab-positions');
    if (!positionsPanel) return;

    if (showLoader) {
      positionsPanel.innerHTML = '<div class="p-4"><p class="text-center text-neutral-600">Loading positions…</p></div>';
    }

    try {
      const response = await api.getAllPositions(false);
      const normalized = this.prepareWatchlistPositions(response.data);
      positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(normalized);
    } catch (error) {
      positionsPanel.innerHTML = `<div class="p-4"><p class="text-center text-error-600">Failed to load positions: ${error.message}</p></div>`;
    }
  }

  prepareWatchlistPositions(data) {
    const instances = (data.instances || []).map(inst => {
      const openPositions = (inst.positions || []).filter(
        pos => this.getNormalizedPositionQty(pos) !== 0
      );
      return {
        ...inst,
        positions: openPositions,
        open_positions_count: openPositions.length,
      };
    });

    const liveInstances = instances
      .filter(inst => !inst.is_analyzer_mode && inst.open_positions_count > 0);

    const analyzerInstances = instances
      .filter(inst => inst.is_analyzer_mode && inst.open_positions_count > 0);

    const totalOpen = instances.reduce(
      (sum, inst) => sum + inst.open_positions_count,
      0
    );

    return {
      overallOpen: totalOpen,
      overallPnl: data.overall_total_pnl,
      liveInstances,
      analyzerInstances,
    };
  }

  renderWatchlistPositionsMarkup({ overallOpen, overallPnl, liveInstances, analyzerInstances }) {
    if (liveInstances.length === 0 && analyzerInstances.length === 0) {
      return '<div class="p-4"><p class="text-center text-neutral-600">No open positions across any instance.</p></div>';
    }

    return `
      <div class="space-y-6">
        ${this.renderPositionsSummary(overallOpen, overallPnl)}
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

  renderPositionsSummary(openCount, pnl) {
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Open Positions Summary</h3>
        </div>
        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div class="text-sm text-neutral-600">Total open positions</div>
            <div class="text-2xl font-semibold">${openCount}</div>
          </div>
          <div>
            <div class="text-sm text-neutral-600">Overall P&L</div>
            <div class="text-2xl font-semibold ${Utils.getPnLColorClass(pnl)}">
              ${Utils.formatCurrency(pnl)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderPositionsSection(title, subtitle, instances) {
    if (!instances || instances.length === 0) {
      return `
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">${title}</h3>
              <p class="text-sm text-neutral-600">${subtitle}</p>
            </div>
            <span class="badge">0</span>
          </div>
          <div class="p-4">
            <p class="text-sm text-neutral-500">No open positions in this category.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="text-sm text-neutral-600">${subtitle}</p>
          </div>
          <span class="badge">${instances.length}</span>
        </div>
        <div class="p-4 space-y-4">
          ${instances.map(inst => this.renderPositionsInstanceCard(inst)).join('')}
        </div>
      </div>
    `;
  }

  renderPositionsInstanceCard(inst) {
    const positions = inst.positions || [];
    return `
      <div class="rounded-lg border border-base-200 p-4">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h4 class="font-semibold text-lg">${Utils.escapeHTML(inst.instance_name)}</h4>
            <div class="flex gap-4 mt-1 text-sm text-neutral-600 flex-wrap">
              <span>Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
              <span>Open positions: <span class="font-medium">${inst.open_positions_count}</span></span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="font-semibold ${Utils.getPnLColorClass(inst.total_pnl)}">
              ${Utils.formatCurrency(inst.total_pnl)}
            </span>
            <button class="btn btn-error btn-sm" onclick="app.closeAllPositions(${inst.instance_id})">
              Close All
            </button>
          </div>
        </div>
        <div class="mt-4">
          ${positions.length > 0
            ? this.renderPositionsTable(positions)
            : '<p class="text-sm text-neutral-500">No open positions for this instance.</p>'}
        </div>
      </div>
    `;
  }

  renderPositionsTable(positions) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Quantity</th>
              <th>Product</th>
              <th class="text-right">Avg Price</th>
              <th class="text-right">LTP</th>
              <th class="text-right">P&L</th>
            </tr>
          </thead>
          <tbody>
            ${positions.map(pos => {
              const qty = this.getNormalizedPositionQty(pos);
              const pnl = parseFloat(pos.pnl || pos.unrealized_pnl || pos.mtm || 0);
              return `
                <tr>
                  <td class="font-medium">${Utils.escapeHTML(pos.symbol || pos.tradingsymbol || '-')}</td>
                  <td>${qty}</td>
                  <td>${Utils.escapeHTML(pos.product || pos.product_type || '-')}</td>
                  <td class="text-right">${Utils.formatCurrency(pos.average_price || pos.avg_price || 0)}</td>
                  <td class="text-right">${Utils.formatCurrency(pos.ltp || pos.last_price || 0)}</td>
                  <td class="text-right ${Utils.getPnLColorClass(pnl)}">${Utils.formatCurrency(pnl)}</td>
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
   * Load orders content into tab
   */
  async loadOrdersTab() {
    const ordersPanel = document.getElementById('tab-orders');
    if (!ordersPanel) return;

    try {
      // Fetch orders
      const response = await api.getOrders();
      const orders = response.data;

      ordersPanel.innerHTML = `
        <div class="p-4">
          <div class="flex justify-between items-center mb-4">
            <div class="flex gap-2">
              <select class="form-select" onchange="app.filterOrders(this.value)">
                <option value="">All Status</option>
                <option value="pending">Pending</option>
                <option value="open">Open</option>
                <option value="complete">Complete</option>
                <option value="cancelled">Cancelled</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
          ${this.renderOrdersTable(orders)}
        </div>
      `;
    } catch (error) {
      ordersPanel.innerHTML = `<div class="p-4"><p class="text-center text-error-600">Failed to load orders: ${error.message}</p></div>`;
    }
  }

  /**
   * Logout
   */
  async logout() {
    const confirmed = await Utils.confirm('Are you sure you want to logout?');

    if (confirmed) {
      await api.logout();
      window.location.href = '/';
    }
  }

  // Placeholder methods
  /**
   * Show edit instance modal
   */
  async showEditInstanceModal(id) {
    try {
      // Fetch instance data
      const response = await api.getInstanceById(id);
      const instance = response.data;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>Edit Instance: ${Utils.escapeHTML(instance.name)}</h3>
          </div>
          <div class="modal-body">
            <form id="edit-instance-form">
              <input type="hidden" name="instance_id" value="${instance.id}">

              <div class="form-group">
                <label class="form-label">Instance Name *</label>
                <input type="text" name="name" class="form-input"
                       value="${Utils.escapeHTML(instance.name)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">Host URL *</label>
                <input type="url" name="host_url" id="edit-instance-host-url" class="form-input"
                       value="${Utils.escapeHTML(instance.host_url)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">API Key *</label>
                <input type="text" name="api_key" id="edit-instance-api-key" class="form-input"
                       value="${Utils.escapeHTML(instance.api_key)}" required>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Update API key if credentials have changed
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Broker (auto-detected, read-only)</label>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                  <input type="text" name="broker" id="edit-instance-broker" class="form-input" readonly
                        value="${Utils.escapeHTML(instance.broker || 'N/A')}"
                        style="background-color: var(--color-neutral-100); cursor: not-allowed;">
                  <button type="button" class="btn btn-secondary btn-sm"
                          onclick="app.testEditInstanceConnection()">
                    Test Connection
                  </button>
                </div>
                <small id="edit-connection-status" class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Broker is auto-detected from the OpenAlgo ping response
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Market Data Role</label>
                <select name="market_data_role" class="form-select">
                  <option value="none" ${instance.market_data_role === 'none' ? 'selected' : ''}>
                    None - Don't use for market data
                  </option>
                  <option value="primary" ${instance.market_data_role === 'primary' ? 'selected' : ''}>
                    Primary - Use first for market data calls
                  </option>
                  <option value="secondary" ${instance.market_data_role === 'secondary' ? 'selected' : ''}>
                    Secondary - Fallback for market data calls
                  </option>
                </select>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Only Primary/Secondary instances will be used for fetching market data
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Strategy Tag</label>
                <input type="text" name="strategy_tag" class="form-input"
                       value="${Utils.escapeHTML(instance.strategy_tag || 'default')}">
              </div>

              <div class="form-group">
                <label class="form-label">Target Profit</label>
                <input type="number" name="target_profit" class="form-input" step="0.01"
                       value="${instance.target_profit || 5000}">
              </div>

              <div class="form-group">
                <label class="form-label">Target Loss</label>
                <input type="number" name="target_loss" class="form-input" step="0.01"
                       value="${instance.target_loss || 2000}">
              </div>

              <div class="form-group">
                <label class="form-label">
                  <input type="checkbox" name="is_active"
                         ${instance.is_active ? 'checked' : ''}>
                  Active Instance
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Inactive instances won't be polled or used for trading
                </small>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
              Cancel
            </button>
            <button class="btn btn-primary" onclick="app.submitEditInstance()">
              Update Instance
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
      Utils.showToast('Failed to load instance: ' + error.message, 'error');
    }
  }

  /**
   * Submit edit instance form
   */
  async submitEditInstance() {
    const form = document.getElementById('edit-instance-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Extract instance ID
    const instanceId = parseInt(data.instance_id);
    delete data.instance_id;

    // Convert checkbox to boolean
    data.is_active = form.querySelector('input[name="is_active"]').checked;

    // Remove broker field - it's immutable
    delete data.broker;

    try {
      await api.updateInstance(instanceId, data);
      Utils.showToast('Instance updated successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Show edit watchlist modal
   */
  async showEditWatchlistModal(id) {
    try {
      // Fetch watchlist data
      const response = await api.getWatchlistById(id);
      const watchlist = response.data;

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
                <label class="form-label">Description</label>
                <textarea name="description" class="form-input" rows="3">${Utils.escapeHTML(watchlist.description || '')}</textarea>
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
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
              Cancel
            </button>
            <button class="btn btn-primary" onclick="app.submitEditWatchlist()">
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
                  <span class="text-neutral-600">Total Symbols:</span>
                  <strong>${symbols.length}</strong>
                </div>
                <div>
                  <span class="text-neutral-600">Created:</span>
                  ${Utils.formatRelativeTime(watchlist.created_at)}
                </div>
                <div>
                  <span class="text-neutral-600">Last Updated:</span>
                  ${Utils.formatRelativeTime(watchlist.updated_at)}
                </div>
              </div>
            </div>

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
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">
              Close
            </button>
            <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove(); app.showEditWatchlistModal(${id})">
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

  /**
   * Filter orders by status
   */
  async filterOrders(status) {
    try {
      // Store current filter
      this.currentOrderFilter = status;

      // Fetch filtered orders
      const filters = status ? { status } : {};
      const response = await api.getOrders(filters);
      const orders = response.data;

      // Update the table
      const tableContainer = document.querySelector('.table-container');
      if (tableContainer) {
        tableContainer.innerHTML = this.renderOrdersTable(orders);
      }

      // Update UI feedback
      const selectElement = document.querySelector('select.form-select[onchange*="filterOrders"]');
      if (selectElement) {
        selectElement.value = status || '';
      }

      Utils.showToast(
        status
          ? `Showing ${orders.length} ${status} orders`
          : `Showing all ${orders.length} orders`,
        'info'
      );
    } catch (error) {
      Utils.showToast('Failed to filter orders: ' + error.message, 'error');
    }
  }
}

// Initialize app when DOM is ready and expose globally for inline handlers
window.app = new DashboardApp();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.app.init());
} else {
  window.app.init();
}
