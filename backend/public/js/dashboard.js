/**
 * Simplifyed Admin V2 - Dashboard Application
 * Main application logic
 */

class DashboardApp {
  constructor() {
    this.defaultView = 'dashboard';
    this.currentView = null;
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
    this.validViews = ['dashboard', 'instances', 'watchlists', 'orders', 'trades', 'positions', 'settings'];
    this.suppressHashChange = false;
    this._throttledWatchlistRefresh = Utils.throttle((opts = {}) => {
      this.refreshWatchlistPositions(opts);
    }, 2000);
    this.watchlistPositionsExpanded = new Set();
    this.latestWatchlistPositionsData = null;
    this.currentOrderFilter = '';
    this.autoExitModes = [
      { key: 'direct', label: 'Direct Trading' },
      { key: 'futures', label: 'Futures Trading' },
      { key: 'options', label: 'Options Trading' },
    ];
    this.symbolConfigContext = null;
    this.tradesPollingInterval = null;
    this.tradesLastUpdatedAt = null;
    this.tradesPayload = null;
    this.tradesInstanceStore = new Map();
    this.positionsInstanceStore = new Map();
    // Track expanded instances in positions view; default is collapsed
    this.positionsExpanded = new Set();
    this.isPaused = true; // start paused until user resumes
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

      // Setup navigation and route listeners
      this.setupNavigation();
      window.addEventListener('hashchange', () => this.handleHashChange());

      // Load initial view based on stored state or hash
      const initialView = this.determineInitialView();
      this.switchView(initialView, { updateHash: false, forceReload: true });
      this.updatePauseButtonUI();

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

  togglePause() {
    this.isPaused = !this.isPaused;
    this.updatePauseButtonUI();
    if (!this.isPaused) {
      Utils.showToast('Resumed data fetching', 'success');
      this.refreshCurrentView(true);
    } else {
      Utils.showToast('Paused all background data fetching', 'info');
      this.stopAllWatchlistPolling();
      this.stopTradesPolling();
      this.stopPositionsPolling();
    }
  }

  updatePauseButtonUI() {
    const btn = document.getElementById('pause-toggle-btn');
    const path = document.getElementById('pause-play-path');
    if (!btn || !path) return;
    if (this.isPaused) {
      // show play icon
      path.setAttribute('d', 'M8 5v14l11-7z');
      btn.setAttribute('title', 'Resume data fetching');
      btn.setAttribute('aria-label', 'Resume data fetching');
    } else {
      // show pause icon
      path.setAttribute('d', 'M6 4h4v16H6zM14 4h4v16h-4z');
      btn.setAttribute('title', 'Pause data fetching');
      btn.setAttribute('aria-label', 'Pause data fetching');
    }
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
   * Determine the initial view to render
   */
  determineInitialView() {
    const hashView = this.parseViewFromHash();
    if (hashView) {
      return hashView;
    }

    const storedView = localStorage.getItem('lastView');
    if (this.isValidView(storedView)) {
      return storedView;
    }

    return this.defaultView;
  }

  /**
   * Parse view from the URL hash
   */
  parseViewFromHash() {
    if (!window.location.hash) {
      return null;
    }

    const viewName = window.location.hash.replace('#', '').trim();
    return this.isValidView(viewName) ? viewName : null;
  }

  /**
   * Handle hash change events (browser navigation)
   */
  handleHashChange() {
    if (this.suppressHashChange) {
      this.suppressHashChange = false;
      return;
    }

    const viewFromHash = this.parseViewFromHash();
    if (!viewFromHash) {
      return;
    }

    this.switchView(viewFromHash, { updateHash: false });
  }

  isValidView(viewName) {
    return typeof viewName === 'string' && this.validViews.includes(viewName);
  }

  persistViewState(viewName) {
    localStorage.setItem('lastView', viewName);
  }

  updateHash(viewName) {
    const targetHash = `#${viewName}`;
    if (window.location.hash !== targetHash) {
      this.suppressHashChange = true;
      window.location.hash = viewName;
    }
  }

  /**
   * Switch view
   */
  switchView(viewName, options = {}) {
    const { updateHash = true, forceReload = false } = options;

    if (!this.isValidView(viewName)) {
      return;
    }

    // Avoid duplicate loads unless forced
    if (!forceReload && this.currentView === viewName) {
      if (updateHash) {
        this.updateHash(viewName);
      }
      this.persistViewState(viewName);
      return;
    }

    this.persistViewState(viewName);
    if (updateHash) {
      this.updateHash(viewName);
    }

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
      if (window.quickOrder && typeof window.quickOrder.stopAllFuturesPreviewPolling === 'function') {
        window.quickOrder.stopAllFuturesPreviewPolling();
      }
    }

    if (this.currentView === 'trades' && viewName !== 'trades') {
      this.stopTradesPolling();
    }

    this.currentView = viewName;

    // Update title
    const titles = {
      dashboard: 'Dashboard',
      instances: 'Instances',
      watchlists: 'Watchlists',
      orders: 'Orders',
      trades: 'Trades',
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
        case 'trades':
          await this.renderTradesView();
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
    if (this.isPaused) {
      this.renderPausedPlaceholder('Dashboard');
      return;
    }
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
    if (this.isPaused) {
      this.renderPausedPlaceholder('Instances');
      return;
    }

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
              <th>Limits</th>
              <th class="text-right">Live P&L</th>
              <th class="text-right">Analyzer P&L</th>
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
              <td>${this.renderLimitBadge(instance.limit_metrics)}</td>
              <td class="text-right ${Utils.getPnLColorClass(instance.last_live_total_pnl)}">
                ${instance.last_live_total_pnl != null
                  ? Utils.formatCurrency(instance.last_live_total_pnl)
                  : '<span class="text-neutral-400">-</span>'}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.is_analyzer_mode ? instance.total_pnl : 0)}">
                ${instance.is_analyzer_mode
                  ? Utils.formatCurrency(instance.total_pnl || 0)
                  : '<span class="text-neutral-400">-</span>'}
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

  renderLimitBadge(metrics) {
    if (!metrics) return '<span class="text-neutral-400">-</span>';
    const max404 = 20;
    const maxInvalid = 10;
    const { errors = {}, rate = {} } = metrics;
    const backoffActive = errors.backoffUntil && Date.now() < errors.backoffUntil;
    const near404 = errors.count404 >= max404 - 2;
    const nearInvalid = errors.countInvalid >= maxInvalid - 1;
    const hotRate = rate.rps >= 4 || rate.orders >= 8 || rate.rpm >= 250 || rate.globalRpm >= 280;

    let badgeClass = 'badge badge-success';
    let label = 'OK';
    const parts = [];
    parts.push(`404s: ${errors.count404 ?? 0}/${max404}`);
    parts.push(`Invalid: ${errors.countInvalid ?? 0}/${maxInvalid}`);
    parts.push(`RPS: ${rate.rps ?? 0}/5`);
    parts.push(`Orders/s: ${rate.orders ?? 0}/10`);

    if (backoffActive) {
      badgeClass = 'badge badge-error';
      label = 'Backoff';
    } else if (near404 || nearInvalid || hotRate) {
      badgeClass = 'badge badge-warning';
      label = 'Watch';
    }

    const title = parts.join(' • ');
    return `<span class="${badgeClass}" title="${Utils.escapeHTML(title)}">${label}</span>`;
  }

  /**
   * Render Watchlists View (Accordion Style)
   */
  async renderWatchlistsView() {
    if (this.isPaused) {
      this.renderPausedPlaceholder('Watchlists');
      return;
    }
    const contentArea = document.getElementById('content-area');

    if (window.quickOrder && typeof window.quickOrder.stopAllOptionPreviewPolling === 'function') {
      window.quickOrder.stopAllOptionPreviewPolling();
    }
    if (window.quickOrder && typeof window.quickOrder.stopAllFuturesPreviewPolling === 'function') {
      window.quickOrder.stopAllFuturesPreviewPolling();
    }

    // Fetch watchlists + instances in parallel to reduce latency
    const [watchlistsRes, instancesRes] = await Promise.all([
      api.getWatchlists(),
      api.getInstances(),
    ]);
    this.watchlists = watchlistsRes.data;
    this.expandedWatchlists = this.expandedWatchlists || new Set();
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
          <div class="card-header">
            <div class="header-left">
              <span class="text-xl">💼</span>
              <h3 class="card-title">Open Positions</h3>
            </div>
            <div class="flex items-center justify-center flex-1">
              <div id="positions-summary-inline" class="flex flex-col items-center gap-2">
                <span class="text-xs text-neutral-500 uppercase tracking-wide">Loading positions…</span>
              </div>
            </div>
            <div class="header-actions">
              <button class="btn btn-outline btn-sm" onclick="app.requestWatchlistRefresh({ showLoader: true, force: true })">
                Refresh
              </button>
              <button class="btn btn-error btn-sm" onclick="app.closeAllOpenPositions()">
                Close All
              </button>
            </div>
          </div>
          <div id="watchlist-positions-panel">
            <div class="p-4">Loading positions...</div>
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
              <div class="flex-1">
                <div class="flex items-center gap-3">
                  <h4>${Utils.escapeHTML(wl.name)}</h4>
                  <span class="watchlist-card__meta-inline">
                    <span>${wl.symbol_count || 0} symbols</span>
                    <span>•</span>
                    <span>${wl.instance_count || 0} instances</span>
                  </span>
                </div>
                <p>${Utils.escapeHTML(wl.description || 'No description provided')}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span class="watchlist-card__status ${statusColor}">
                  ${wl.is_active ? 'Active' : 'Paused'}
                </span>
                <div class="watchlist-card__actions">
                  <button class="watchlist-actions__button btn-xs" onclick="app.showAddSymbolModal(${wl.id})" title="Add Symbol">
                    + Add Symbol
                  </button>
                  <button class="watchlist-actions__button btn-xs" onclick="app.showEditWatchlistModal(${wl.id})" title="Edit Watchlist">
                    ✏️
                  </button>
                  <button class="watchlist-actions__button btn-xs" onclick="app.manageWatchlistInstances(${wl.id})" title="Manage Instances">
                    🔗
                  </button>
                  <button class="watchlist-actions__button danger btn-xs" onclick="app.deleteWatchlist(${wl.id})" title="Delete">
                    🗑️
                  </button>
                </div>
              </div>
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
                  data-underlying="${Utils.escapeHTML(sym.underlying_symbol || sym.name || sym.symbol)}">
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
                  <button class="btn btn-outline btn-sm ml-2" onclick="app.showEditSymbolModal(${watchlistId}, ${sym.id})">
                    Edit
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
    if (this.isPaused) return;
    // Stop existing poller if any
    this.stopWatchlistPolling(watchlistId);

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

  startPositionsPolling() {
    this.stopPositionsPolling();
    this.requestWatchlistRefresh({ showLoader: true, force: true });
    this.positionsPollingInterval = setInterval(() => {
      this.requestWatchlistRefresh();
    }, 10000);
  }

  stopPositionsPolling() {
    if (this.positionsPollingInterval) {
      clearInterval(this.positionsPollingInterval);
      this.positionsPollingInterval = null;
    }
  }

  requestWatchlistRefresh({ showLoader = false, force = false } = {}) {
    if (this.isPaused && !force) {
      return;
    }
    if (force) {
      this.refreshWatchlistPositions({ showLoader });
      return;
    }

    this._throttledWatchlistRefresh({ showLoader });
  }

  async updateWatchlistQuotes(watchlistId, { force = false } = {}) {
    if (this.isPaused && !force) return;
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
        const normalizedQuoteSymbol = this.normalizeQuoteSymbol(quote.symbol);
        const symbol = symbols.find(s => {
          const exactMatch = s.exchange === quote.exchange;
          const normalizedMatch =
            this.normalizeExchange(s.exchange) === this.normalizeExchange(quote.exchange);

          return (exactMatch || normalizedMatch) && s.symbol === normalizedQuoteSymbol;
        });

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
    if (this.isPaused) {
      this.renderPausedPlaceholder('Orders');
      return;
    }
    this.currentOrderFilter = this.currentOrderFilter || '';

    contentArea.innerHTML = `
      <div class="space-y-4">
        <div class="card">
          <div class="card-header flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="card-title">Orders</h3>
              <p class="text-sm text-neutral-600">Live view of every OpenAlgo order grouped by instance category.</p>
            </div>
            <div class="flex items-center gap-2">
              <select id="orders-filter" class="form-select" onchange="app.filterOrders(this.value)">
                <option value="">All Status</option>
                <option value="pending">Pending</option>
                <option value="open">Open</option>
                <option value="complete">Complete</option>
                <option value="cancelled">Cancelled</option>
                <option value="rejected">Rejected</option>
              </select>
              <button class="btn btn-outline btn-sm" onclick="app.loadOrders()">
                Refresh
              </button>
            </div>
          </div>
          <div class="p-4" id="orders-panel">
            <div class="text-center text-neutral-500">Loading orders…</div>
          </div>
        </div>
      </div>
    `;

    await this.loadOrders(this.currentOrderFilter);
  }

  async loadOrders(status = '') {
    try {
      const params = {};
      if (status) params.status = status;
      const response = await api.getOrderbook(status);
      const payload = response.data || {};
      this.orderbookPayload = payload;
      this.renderOrdersPanel(payload);
      const select = document.getElementById('orders-filter');
      if (select) select.value = status || '';
    } catch (error) {
      console.error('Failed to load orders:', error);
      const panel = document.getElementById('orders-panel');
      if (panel) {
        panel.innerHTML = `<p class="text-error text-center">${error.message}</p>`;
      }
    }
  }

  renderOrdersPanel(orders = []) {
    const panel = document.getElementById('orders-panel');
    if (!panel) return;

    if (!orders || (!orders.liveInstances?.length && !orders.analyzerInstances?.length)) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No orders found</p>';
      return;
    }

    panel.innerHTML = `
      <div class="space-y-5">
        ${this.renderOrdersSummary(orders)}
        ${this.renderOrdersSection('Live Instances', orders.liveInstances)}
        ${this.renderOrdersSection('Analyzer Mode Instances', orders.analyzerInstances)}
      </div>
    `;
  }

  renderOrdersSummary(payload) {
    const stats = payload.statistics || {};
    const liveOrders = payload.liveInstances?.flatMap(inst => inst.orders || []) || [];
    const analyzerOrders = payload.analyzerInstances?.flatMap(inst => inst.orders || []) || [];
    const allOrders = [...liveOrders, ...analyzerOrders];
    const total = allOrders.length;
    const statusCounts = {};
    allOrders.forEach(order => {
      statusCounts[order.status || 'unknown'] = (statusCounts[order.status || 'unknown'] || 0) + 1;
    });

    const badgeOrder = ['pending', 'open', 'complete', 'cancelled', 'rejected'];
    const badges = badgeOrder
      .filter(status => statusCounts[status])
      .map(status => `
        <span class="badge badge-sm ${status === 'open' ? 'badge-info' : status === 'pending' ? 'badge-warning' : status === 'complete' ? 'badge-success' : 'badge-neutral'}">
          ${status}: ${statusCounts[status]}
        </span>
      `).join(' ');

    return `
      <div class="card border border-base-200 bg-base-100 p-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-neutral-600 uppercase tracking-wide">Total orders</div>
            <div class="text-2xl font-semibold">${total}</div>
          </div>
            <div class="flex flex-wrap gap-2">
              ${badges}
            </div>
        </div>
      </div>
    `;
  }

  renderOrdersSection(title, instances = []) {
    if (!instances.length) {
      return `
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">${title}</h3>
              <p class="text-sm text-neutral-600">No orders in this category.</p>
            </div>
            <span class="badge">0</span>
          </div>
        </div>
      `;
    }

    const totalOrders = instances.reduce((acc, inst) => acc + (inst.orders?.length || 0), 0);

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="text-sm text-neutral-600">Orders executed per instance (live/analyzer)</p>
          </div>
          <span class="badge">${totalOrders}</span>
        </div>
        <div class="p-4 space-y-4">
          ${instances.map(instance => this.renderOrderInstanceCard(instance)).join('')}
        </div>
      </div>
    `;
  }

  renderOrderInstanceCard(instanceEntry) {
    const title = Utils.escapeHTML(instanceEntry.instance_name || `Instance ${instanceEntry.instance_id}`);
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const orders = instanceEntry.orders || [];
    const openOrders = orders.filter(o => ['open', 'pending'].includes(o.status)).length;

    return `
      <details class="rounded-lg border border-base-200 bg-base-100">
        <summary class="flex flex-wrap cursor-pointer items-center justify-between gap-4 px-4 py-4">
          <div>
            <h4 class="font-semibold text-lg">${title}</h4>
            <div class="text-sm text-neutral-600 flex gap-4 flex-wrap">
              <span>Broker: ${broker}</span>
              <span>Total orders: ${orders.length}</span>
              <span>Open/pending: ${openOrders}</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="btn btn-error btn-sm"
              onclick="event.stopPropagation(); app.cancelAllOrders(${instanceEntry.instance_id})"
            >
              Cancel All Open Orders
            </button>
          </div>
        </summary>
        <div class="border-t border-base-200 p-4">
          ${this.renderOrdersTable(orders)}
        </div>
      </details>
    `;
  }

  renderOrdersTable(orders) {
    const rows = orders.map(order => {
      const safeValue = (...keys) => {
        for (const key of keys) {
          const parts = key.split('.');
          let value = order;
          for (const part of parts) {
            if (value && Object.prototype.hasOwnProperty.call(value, part)) {
              value = value[part];
            } else {
              value = undefined;
              break;
            }
          }

          if (value !== undefined && value !== null && value !== '') {
            return value;
          }
        }
        return '-';
      };

      const action = safeValue('action');
      const cancelable = ['pending', 'open'].includes(order.status);
      const orderId = order.id ? order.id.toString().replace(/'/g, "\\'") : '';
      const exchange = Utils.escapeHTML(safeValue('exchange', 'metadata.exchange'));
      const priceValue = safeValue('price', 'metadata.price', 'metadata.average_price');
      const priceDisplay = priceValue !== '-' ? Utils.formatNumber(priceValue) : '-';
      const strategy = Utils.escapeHTML(safeValue('strategy', 'metadata.strategy')) || '-';
      const timestamp = safeValue('timestamp', 'metadata.timestamp', 'metadata.placed_at');
      const placedAt = timestamp && timestamp !== '-' ? Utils.formatDateTime(timestamp, true) : '-';
      const statusValue = (safeValue('status', 'metadata.order_status') || 'unknown').toLowerCase();
      const rejectionReason = safeValue('metadata.rejection_reason', 'metadata.rejectionReason');
      const resolvedSymbol = safeValue('resolved_symbol', 'metadata.resolved_symbol', 'metadata.symbol');
      let statusBadge = Utils.getStatusBadge(statusValue);
      if (statusValue === 'rejected' && rejectionReason) {
        const escapedReason = Utils.escapeHTML(rejectionReason);
        statusBadge = statusBadge.replace('>', ` title="${escapedReason}">`);
      }
      const rejectionLine = statusValue === 'rejected' && rejectionReason
        ? `<div class="text-xs text-neutral-500 mt-1">${Utils.escapeHTML(rejectionReason)}</div>`
        : '';

      return `
        <tr>
          <td>${Utils.escapeHTML(safeValue('symbol', 'metadata.symbol'))}</td>
          <td class="text-xs text-neutral-600">${Utils.escapeHTML(resolvedSymbol)}</td>
          <td>${exchange}</td>
          <td>
            <span class="badge ${action === 'BUY' ? 'badge-success' : 'badge-error'}">
              ${action}
            </span>
          </td>
          <td>${priceDisplay !== '-' ? `₹${priceDisplay}` : priceDisplay}</td>
          <td>${safeValue('quantity', 'metadata.quantity')}</td>
          <td>${Utils.escapeHTML(safeValue('product', 'product_type', 'metadata.product'))}</td>
          <td>${Utils.escapeHTML(safeValue('order_type', 'metadata.pricetype'))}</td>
          <td>${strategy}</td>
          <td>${statusBadge}${rejectionLine}</td>
          <td class="text-right">${placedAt}</td>
          <td class="text-center">
            ${cancelable ? `
              <button class="btn btn-sm btn-outline"
                      onclick="app.cancelOrder('${orderId}')">
                Cancel
              </button>
            ` : '-'}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Resolved</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Type</th>
              <th>Strategy</th>
              <th>Status</th>
              <th class="text-right">Timestamp</th>
              <th class="text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  stopTradesPolling() {
    if (this.tradesPollingInterval) {
      clearInterval(this.tradesPollingInterval);
      this.tradesPollingInterval = null;
    }
  }

  updateTradesLastUpdatedDisplay(timestamp) {
    const label = document.getElementById('trades-last-updated');
    if (!label) return;
    if (!timestamp) {
      label.textContent = 'Waiting for updates…';
      return;
    }
    label.textContent = `Updated ${Utils.formatRelativeTime(new Date(timestamp).toISOString())}`;
  }

  /**
   * Render Trades View
   */
  async renderTradesView() {
    if (this.isPaused) {
      this.renderPausedPlaceholder('Trades');
      return;
    }
    const contentArea = document.getElementById('content-area');
    this.stopTradesPolling();

    contentArea.innerHTML = `
      <div class="space-y-4">
        <div class="card">
          <div class="card-header flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="card-title">Trades</h3>
              <p class="text-sm text-neutral-600">Live tradebook snapshot grouped by instance. Auto-refreshes every 5 seconds.</p>
            </div>
            <div class="flex items-center gap-3 flex-wrap text-sm text-neutral-500">
              <span id="trades-last-updated">Waiting for updates…</span>
              <button class="btn btn-outline btn-sm" onclick="app.loadTrades()">
                Refresh
              </button>
            </div>
          </div>
          <div class="p-4" id="trades-panel">
            <div class="text-center text-neutral-500">Loading trades…</div>
          </div>
        </div>
      </div>
    `;

    await this.loadTrades();
    this.tradesPollingInterval = setInterval(() => this.loadTrades(true), 5000);
  }

  async loadTrades(isAuto = false) {
    try {
      const response = await api.getTradebook();
      this.tradesPayload = response.data || {};
      this.tradesLastUpdatedAt = this.tradesPayload.fetchedAt || Date.now();
      this.renderTradesPanel(this.tradesPayload);
      this.updateTradesLastUpdatedDisplay(this.tradesLastUpdatedAt);
    } catch (error) {
      const panel = document.getElementById('trades-panel');
      if (panel) {
        panel.innerHTML = `<p class="text-center text-error-600">${Utils.escapeHTML(error.message)}</p>`;
      }
      if (!isAuto) {
        Utils.showToast(`Failed to load trades: ${error.message}`, 'error');
      }
    }
  }

  renderTradesPanel(payload = {}) {
    // Ensure caches are always initialized even if constructor did not run as expected
    if (!this.tradesInstanceStore) {
      this.tradesInstanceStore = new Map();
    }
    const panel = document.getElementById('trades-panel');
    if (!panel) return;

    const liveInstances = payload.liveInstances || [];
    const analyzerInstances = payload.analyzerInstances || [];

    if (!liveInstances.length && !analyzerInstances.length) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No trades available.</p>';
      return;
    }

    this.ensureTradesLayout(panel);
    this.updateTradesSummary(payload.statistics);
    this.updateTradesSection('live', liveInstances);
    this.updateTradesSection('analyzer', analyzerInstances);
  }

  ensureTradesLayout(panel) {
    if (panel.dataset.initialized === 'true') return;
    panel.innerHTML = `
      <div class="space-y-5">
        <div id="trades-summary"></div>
        <div id="trades-live" class="trades-section"></div>
        <div id="trades-analyzer" class="trades-section"></div>
      </div>
    `;
    panel.dataset.initialized = 'true';
  }

  updateTradesSummary(stats = {}) {
    const totalTrades = stats.total_trades || 0;
    const buyTrades = stats.total_buy_trades || 0;
    const sellTrades = stats.total_sell_trades || 0;
    const notional = stats.total_value || 0;
    const summary = document.getElementById('trades-summary');
    if (!summary) return;
    summary.innerHTML = `
      <div class="card bg-base-100 border border-base-200">
        <div class="card-header">
          <h3 class="card-title">Trades Summary</h3>
        </div>
        <div class="p-6">
          <div class="grid grid-cols-3 gap-4">
            <div class="border border-base-200 rounded-lg p-4 text-center">
              <div class="text-sm text-neutral-600 mb-1">Total Trades</div>
              <div class="text-3xl font-semibold">${totalTrades}</div>
            </div>
            <div class="border border-base-200 rounded-lg p-4 text-center">
              <div class="text-sm text-neutral-600 mb-1">Buy / Sell</div>
              <div class="text-2xl font-semibold">${buyTrades} / ${sellTrades}</div>
            </div>
            <div class="border border-base-200 rounded-lg p-4 text-center">
              <div class="text-sm text-neutral-600 mb-1">Notional Value</div>
              <div class="text-2xl font-semibold">${Utils.formatCurrency(notional)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  updateTradesSection(type, instances = []) {
    const container = document.getElementById(type === 'live' ? 'trades-live' : 'trades-analyzer');
    if (!container) return;
    const title = type === 'live' ? 'Live Instances' : 'Analyzer Mode Instances';
    const existingOpen = new Set(
      Array.from(container.querySelectorAll('details[data-instance-id][open]')).map(el => el.dataset.instanceId)
    );
    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    const totalTrades = sorted.reduce((acc, inst) => acc + (inst.trades?.length || 0), 0);

    const header = `
      <div class="card-header">
        <div>
          <h3 class="card-title">${title}</h3>
          <p class="text-sm text-neutral-600">${totalTrades} trades</p>
        </div>
        <span class="badge badge-outline">${totalTrades}</span>
      </div>
    `;

    const body = sorted.map(inst => {
      this.tradesInstanceStore.set(String(inst.instance_id), inst.trades || []);
      const isOpen = existingOpen.has(String(inst.instance_id));
      return this.buildTradesInstance(inst, isOpen, !isOpen);
    }).join('');
    container.innerHTML = `
      <div class="card">
        ${header}
        <div class="divide-y divide-base-200">
          ${body || `<div class="p-4 text-neutral-500">No trades in this category.</div>`}
        </div>
      </div>
    `;
  }

  buildTradesInstance(instanceEntry, preserveOpen = false, collapseByDefault = false) {
    const trades = instanceEntry.trades || [];
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const latestTrade = trades[0];
    const lastTradeTime = latestTrade
      ? (latestTrade.timestamp_iso
        ? Utils.formatDateTime(latestTrade.timestamp_iso, true)
        : Utils.escapeHTML(latestTrade.timestamp || ''))
      : '-';
    const bodyRows = this.renderTradesRows(trades);

    const shouldOpen = preserveOpen && trades.length && !collapseByDefault;

    return `
      <details class="instance-section" data-instance-id="${instanceEntry.instance_id}" ${shouldOpen ? 'open' : ''}>
        <summary class="flex flex-wrap cursor-pointer items-center justify-between gap-4 px-4 py-4">
          <div>
            <h4 class="font-semibold text-lg">${Utils.escapeHTML(instanceEntry.instance_name)}</h4>
            <div class="text-sm text-neutral-600 flex gap-4 flex-wrap">
              <span>Broker: ${broker}</span>
              <span>Total trades: ${trades.length}</span>
              <span>Last trade: ${lastTradeTime || '-'}</span>
            </div>
          </div>
        </summary>
        <div class="border-t border-base-200 p-4" id="trades-body-${instanceEntry.instance_id}" data-loaded="${shouldOpen || !collapseByDefault}">
          ${trades.length && shouldOpen ? this.renderTradesTableShell(bodyRows) : '<p class="text-neutral-500">Expand to view trades.</p>'}
        </div>
      </details>
    `;
  }

  attachTradesToggles(container) {
    const detailsList = container.querySelectorAll('details.instance-section');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        if (details.open) {
          const body = details.querySelector('[id^="trades-body-"]');
          if (body && body.dataset.loaded !== 'true') {
            const instanceId = details.dataset.instanceId;
            const trades = this.tradesInstanceStore.get(String(instanceId)) || [];
            body.innerHTML = trades.length
              ? this.renderTradesTableShell(this.renderTradesRows(trades))
              : '<p class="text-neutral-500">No trades yet.</p>';
            body.dataset.loaded = 'true';
          }
        }
      });
    });
  }

  renderTradesRows(trades = []) {
    return trades.map(trade => {
      const action = trade.action;
      const badgeClass = action === 'BUY'
        ? 'badge-success'
        : action === 'SELL'
          ? 'badge-error'
          : 'badge-neutral';
      const timestampDisplay = trade.timestamp_iso
        ? Utils.formatDateTime(trade.timestamp_iso, true)
        : Utils.escapeHTML(trade.timestamp || '-');
      const avgPriceDisplay = (trade.average_price ?? null) !== null
        ? Utils.formatNumber(trade.average_price)
        : '-';
      const tradeValueDisplay = (trade.trade_value ?? null) !== null
        ? Utils.formatCurrency(trade.trade_value)
        : '-';

      return `
        <tr>
          <td>${Utils.escapeHTML(trade.symbol || '-')}</td>
          <td>${Utils.escapeHTML(trade.exchange || '-')}</td>
          <td>
            <span class="badge ${badgeClass}">${action || '-'}</span>
          </td>
          <td>${trade.quantity ?? '-'}</td>
          <td>${Utils.escapeHTML(trade.product || '-')}</td>
          <td>${avgPriceDisplay}</td>
          <td>${tradeValueDisplay}</td>
          <td class="text-right">${timestampDisplay}</td>
        </tr>
      `;
    }).join('');
  }

  renderTradesTableShell(rowsHtml) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Avg Price</th>
              <th>Trade Value</th>
              <th class="text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="8" class="text-center text-neutral-500">No trades</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Render Positions View
   */
  async renderPositionsView() {
    const contentArea = document.getElementById('content-area');
    if (this.isPaused) {
      this.renderPausedPlaceholder('Positions');
      return;
    }
    if (!this.positionsInstanceStore) {
      this.positionsInstanceStore = new Map();
    }

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

      if (!contentArea.dataset.positionsInitialized) {
        contentArea.innerHTML = `
          <!-- Overall Summary Card -->
          <div class="card mb-6">
            <div class="card-header">
              <h3 class="card-title">All Positions Summary</h3>
            </div>
            <div class="p-4" id="positions-summary"></div>
          </div>
          <div class="space-y-5" id="positions-layout">
            <div id="positions-live"></div>
            <div id="positions-analyzer"></div>
          </div>
        `;
        contentArea.dataset.positionsInitialized = 'true';
      }

      this.updatePositionsSummary(data);
      const instances = Array.isArray(data.instances) ? data.instances : [];
      const liveInstances = instances.filter(inst => !inst.is_analyzer_mode);
      const analyzerInstances = instances.filter(inst => inst.is_analyzer_mode);
      this.updatePositionsSection('live', liveInstances);
      this.updatePositionsSection('analyzer', analyzerInstances);
    } catch (error) {
      contentArea.innerHTML = `
        <div class="card">
          <p class="text-center text-error-600">Failed to load positions: ${error.message}</p>
        </div>
      `;
    }
  }

  updatePositionsSummary(data) {
    const container = document.getElementById('positions-summary');
    if (!container) return;
    container.innerHTML = `
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
    `;
  }

  updatePositionsSection(type, instances = []) {
    const container = document.getElementById(type === 'live' ? 'positions-live' : 'positions-analyzer');
    if (!container) return;
    const title = type === 'live' ? 'Live Instances' : 'Analyzer Mode Instances';
    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    const totalPositions = sorted.reduce((acc, inst) => {
      const count = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length;
      return acc + count;
    }, 0);

    container.innerHTML = `
      <div class="card">
        <div class="card-header items-center justify-between">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="text-sm text-neutral-600">${totalPositions} open positions</p>
          </div>
          <span class="badge badge-outline">${totalPositions}</span>
        </div>
        <div class="divide-y divide-base-200">
          ${sorted.map(inst => {
            const id = String(inst.instance_id);
            const isOpen = this.positionsExpanded.has(id);
            this.positionsInstanceStore.set(id, inst.positions || []);
            return this.buildPositionsInstance(inst, isOpen);
          }).join('') || `<div class="p-4 text-neutral-500">No positions in this category.</div>`}
        </div>
      </div>
    `;

    this.attachPositionsToggles(container);
  }

  buildPositionsInstance(inst, isOpen) {
    const header = `
      <summary class="card-header flex items-center justify-between gap-3 px-4 py-4">
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
      </summary>
    `;

    const positions = inst.positions || [];

    return `
      <details class="card" data-instance-id="${inst.instance_id}" ${isOpen ? 'open' : ''}>
        ${header}
        <div class="p-4 instance-positions-body" data-loaded="${isOpen}">
          ${isOpen ? this.renderPositionsBody(positions, inst) : '<p class="text-neutral-500">Expand to view positions.</p>'}
        </div>
      </details>
    `;
  }

  renderPositionsBody(positions, inst) {
    if (inst.error) {
      return `<p class="text-center text-error-600 p-4">${Utils.escapeHTML(inst.error)}</p>`;
    }
    if (!positions || positions.length === 0) {
      return '<p class="text-center text-neutral-600 p-4">No positions</p>';
    }
    return this.renderPositionsTable(positions, inst.instance_id);
  }

  attachPositionsToggles(container) {
    const detailsList = container.querySelectorAll('details.card');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        const instanceId = details.dataset.instanceId;
        if (details.open) {
          this.positionsExpanded.add(String(instanceId));
          const body = details.querySelector('.instance-positions-body');
          if (body && body.dataset.loaded !== 'true') {
            const positions = this.positionsInstanceStore.get(String(instanceId)) || [];
            body.innerHTML = this.renderPositionsBody(positions, { instance_id: instanceId });
            body.dataset.loaded = 'true';
          }
        } else {
          this.positionsExpanded.delete(String(instanceId));
        }
      });
    });
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
              <label class="form-label">Market Data</label>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="market_data_enabled" class="form-checkbox">
                <span>Use this instance for market data</span>
              </label>
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Enabled instances will be pooled and load-balanced for quotes/LTP/depth.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Strategy Tag</label>
              <input type="text" name="strategy_tag" class="form-input" value="default">
            </div>

            <div class="form-group">
              <label class="form-label">Session Target Profit</label>
              <input type="number" name="session_target_profit" class="form-input" step="0.01" placeholder="5000">
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Auto-switch to Analyze when this profit is reached within a session.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Session Max Loss</label>
              <input type="number" name="session_max_loss" class="form-input" step="0.01" placeholder="2000">
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Auto-switch to Analyze when this loss is hit within a session.
              </small>
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

    data.market_data_enabled = form.querySelector('input[name="market_data_enabled"]').checked;

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

    const autoExitFieldsHtml = this.autoExitModes
      .map((modeConfig) => `
        <div class="border rounded-lg p-3 bg-white shadow-sm">
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
                <input type="checkbox" name="tradable_equity" ${tradableEquityChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Direct Trading</p>
                  <p class="text-sm text-neutral-600">Use BUY/SELL/EXIT buttons directly for this symbol (spot, futures, or options).</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_futures" ${tradableFuturesChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Futures Trading</p>
                  <p class="text-sm text-neutral-600">Route BUY/SELL/EXIT to futures contracts.</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
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
            <div class="border rounded-lg bg-neutral-50 p-4 space-y-3">
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
          <button class="btn btn-secondary" onclick="app.cancelSymbolConfig()">
            Cancel
          </button>
          <button class="btn btn-primary" onclick="app.confirmAddSymbol()">
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

  async cancelAllOrders(instanceId) {
    const confirmed = await Utils.confirm(
      'Cancel all pending/open orders for this instance?',
      'Confirm Cancel All'
    );

    if (!confirmed) return;

    try {
      await api.cancelAllOrders(instanceId);
      Utils.showToast('Cancel-all request sent', 'success');
      await this.loadOrders(this.currentOrderFilter);
    } catch (error) {
      Utils.showToast('Failed to cancel orders: ' + error.message, 'error');
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

  async refreshWatchlistPositions({ showLoader = false } = {}) {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel) return;

    if (showLoader) {
      positionsPanel.innerHTML = '<div class="p-4"><p class="text-center text-neutral-600">Loading positions…</p></div>';
    }

    try {
      // Fetch the same aggregate payload as the Positions page
      const response = await api.getAllPositions(false);
      const normalized = this.prepareWatchlistPositions(response.data);
      console.debug('[Watchlists] Positions payload', {
        instances: response.data?.instances?.length,
        normalizedLive: normalized.liveInstances.length,
        normalizedAnalyzer: normalized.analyzerInstances.length,
        rawSample: response.data?.instances?.slice?.(0, 2) || [],
      });
      this.latestWatchlistPositionsData = normalized;
      this.updateWatchlistPositionsSummary(normalized);
      positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(normalized);
    } catch (error) {
      console.error('Failed to refresh watchlist positions:', error);
      positionsPanel.innerHTML = `<div class="p-4"><p class="text-center text-error-600">Failed to load positions: ${error.message}</p></div>`;
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
    summaryEl.innerHTML = `
      <div class="flex items-center">
        <div class="flex items-center gap-3">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Total Open:</span>
          <span class="text-sm font-semibold text-neutral-900">${overallOpen}</span>
        </div>
        <div style="width: 4rem;"></div>
        <div class="w-px h-4 bg-neutral-300"></div>
        <div style="width: 4rem;"></div>
        <div class="flex items-center gap-3">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Overall P&L:</span>
          <span class="text-sm font-semibold ${Utils.getPnLColorClass(overallPnl)}">
            ${Utils.formatCurrency(overallPnl)}
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
    } catch (error) {
      Utils.showToast('Failed to close all positions: ' + error.message, 'error');
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

    const totalOpen = typeof data.overall_open_positions === 'number'
      ? data.overall_open_positions
      : instances.reduce(
          (sum, inst) => sum + (inst.open_positions_count ?? inst.positions.length),
          0
        );

    return {
      overallOpen: totalOpen,
      overallPnl: data.overall_total_pnl ?? 0,
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
      <div class="space-y-6">
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
    const openCount = typeof inst.open_positions_count === 'number'
      ? inst.open_positions_count
      : positions.length;
    const isExpanded = this.watchlistPositionsExpanded.has(inst.instance_id);

    return `
      <div class="rounded-lg border border-base-200">
        <div class="flex flex-wrap items-center gap-3 p-3">
          <button
            class="flex flex-1 flex-wrap items-center gap-3 text-left focus:outline-none"
            onclick="app.toggleWatchlistPositionInstance(${inst.instance_id})"
            aria-expanded="${isExpanded}"
            aria-controls="positions-body-${inst.instance_id}"
          >
            <span class="inline-flex items-center justify-center w-6 h-6 rounded-full border border-base-300 text-base-content/70 transform transition-transform ${isExpanded ? 'rotate-90' : ''}">
              ▸
            </span>
            <span class="font-semibold text-base">${Utils.escapeHTML(inst.instance_name)}</span>
            <span class="text-sm text-neutral-500">Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
            <span class="text-sm text-neutral-500">Open: <span class="font-medium">${openCount}</span></span>
            <span class="text-sm text-neutral-500">P&L:
              <span class="font-semibold ${Utils.getPnLColorClass(inst.total_pnl)}">
                ${Utils.formatCurrency(inst.total_pnl)}
              </span>
            </span>
          </button>
          <button class="btn btn-error btn-sm ml-auto" onclick="app.closeAllPositions(${inst.instance_id})">
            Close All
          </button>
        </div>
        <div id="positions-body-${inst.instance_id}" class="${isExpanded ? 'block' : 'hidden'} border-t border-base-200">
          <div class="p-4">
            ${positions.length > 0
              ? this.renderPositionsTable(positions, inst.instance_id)
              : '<p class="text-sm text-neutral-500">No open positions for this instance.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  renderPositionsTable(positions, instanceId = null) {
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
              <th class="text-center">Actions</th>
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
                  <td class="text-center">
                    ${instanceId ? `
                      <button
                        class="btn btn-sm btn-outline"
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
                <label class="form-label">Market Data</label>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="market_data_enabled" class="form-checkbox"
                         ${instance.market_data_enabled ? 'checked' : ''}>
                  <span>Use this instance for market data</span>
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Enabled instances are pooled and load-balanced for quotes/LTP/depth.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Strategy Tag</label>
                <input type="text" name="strategy_tag" class="form-input"
                       value="${Utils.escapeHTML(instance.strategy_tag || 'default')}">
              </div>

              <div class="form-group">
                <label class="form-label">Session Target Profit</label>
                <input type="number" name="session_target_profit" class="form-input" step="0.01"
                       value="${instance.session_target_profit ?? ''}">
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Auto-switch to Analyze when this profit is reached within a session.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Session Max Loss</label>
                <input type="number" name="session_max_loss" class="form-input" step="0.01"
                       value="${instance.session_max_loss ?? ''}">
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Auto-switch to Analyze when this loss is hit within a session.
                </small>
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

    data.market_data_enabled = form.querySelector('input[name="market_data_enabled"]').checked;

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
    this.currentOrderFilter = status || '';
    await this.loadOrders(this.currentOrderFilter);
  }

  renderPausedPlaceholder(viewLabel = 'Dashboard') {
    const contentArea = document.getElementById('content-area');
    if (!contentArea) return;
    contentArea.innerHTML = `
      <div class="card">
        <div class="card-header flex items-center justify-between">
          <div>
            <h3 class="card-title">${Utils.escapeHTML(viewLabel)} (Paused)</h3>
            <p class="text-sm text-neutral-600">Data fetching is paused. Click the play button in the header to resume.</p>
          </div>
        </div>
        <div class="p-6 text-center text-neutral-500">
          <p>Data fetching is currently paused to avoid triggering rate limits after restart.</p>
          <button class="btn btn-primary mt-4" onclick="app.togglePause()">Resume</button>
        </div>
      </div>
    `;
  }
}

// Initialize app when DOM is ready and expose globally for inline handlers
window.app = new DashboardApp();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.app.init());
} else {
  window.app.init();
}
