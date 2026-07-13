/**
 * Simplifyed Admin V2 - Dashboard Application (core)
 * Cross-cutting shell: constructor state, router (switchView/loadView), auth/permissions,
 * theme, sidebar, WebSocket gateway lifecycle, and shared cross-view helpers.
 * View-specific rendering lives in sibling dashboard-*.js files, each adding its methods onto
 * DashboardApp.prototype via Object.assign - see dashboard-init.js for the final instantiation
 * (must load after every dashboard-*.js mixin file).
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
    // Track positions polling interval (dynamic based on open positions)
    this.positionsPollingInterval = null;
    this.positionsPollingMs = 30000;
    this.positionsPollingIdleMs = 30000;
    this.positionsPollingActiveMs = 8000;
    this.ltpCacheTtlIdleMs = 15000;
    this.ltpCacheTtlActiveMs = 10000;
    // Cache for quote data to prevent unnecessary DOM updates
    // Structure: { watchlistId_symbolId: { ltp, changePercent, volume } }
    this.quoteCache = new Map();
    // Shared LTP cache (exchange|symbol -> { ltp, ts })
    this.latestLtpByKey = new Map();
    this.ltpCacheTtlMs = 15000;
    // Track latest quote snapshot timestamp per watchlist
    this.watchlistQuoteSnapshots = new Map();
    this.isSidebarCollapsed = false;
    this.quickOrder = window.quickOrder || null;
    this.validViews = ['dashboard', 'instances', 'watchlists', 'orders', 'trades', 'positions', 'daily-pnl-snapshots', 'settings', 'notifications', 'audit', 'api-playground'];
    this.suppressHashChange = false;
    this._throttledWatchlistRefresh = Utils.throttle((opts = {}) => {
      this.refreshWatchlistPositions(opts);
    }, 2000);
    this.watchlistPositionsExpanded = new Set();
    this.latestWatchlistPositionsData = null;
    this.currentOrderFilter = '';
    this.instanceSearchQuery = '';
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
    this.tradesExpanded = new Set();
    this.ordersExpanded = new Set();
    this.positionsInstanceStore = new Map();
    // Track expanded instances in positions view; default is collapsed
    this.positionsExpanded = new Set();
    this.expandedWatchlists = new Set();
    this.isPaused = false; // default running; user can pause manually
    // Telemetry auto-refresh
    this.telemetryInterval = null;
    this.lastTelemetry = { circuits: 0, stale: 0 };
    // Snapshot auto-resync
    this.snapshotResyncInterval = null;
    this.lastSnapshotResyncAt = 0;
    this.isSnapshotResyncing = false;
    this.autoSnapshotResyncEnabled = this.loadSnapshotResyncPreference();
    // Symbol lookup for streaming updates
    this.watchlistSymbolIndex = new Map(); // exchange|symbol -> [{ watchlistId, symbolId }]
    this.watchlistSymbolIndexByWatchlist = new Map(); // watchlistId -> [{ key, symbolId }]
    // WebSocket streaming (optional)
    this.wsGatewayEnabled = false;
    this.wsGatewayPath = '/stream';
    this.wsTopics = ['quotes:update', 'positions:update', 'funds:update'];
    this.useWsGateway = this.loadWsPreference();
    this.ws = null;
    this.wsConnected = false;
    this.wsLastSeq = 0;
    this.wsReconnectDelay = 500;
    this.wsReconnectTimer = null;
    this.wsRefreshDashboard = Utils.debounce(() => this.renderDashboardView(), 1200);
    this.wsRefreshPositions = Utils.debounce(() => this.renderPositionsView(), 1200);
    this.wsRefreshWatchlists = Utils.debounce(() => this._throttledWatchlistRefresh({ showLoader: false }), 800);
    // Theme (light-only)
    this.theme = 'light';
    this.viewPermissions = {
      dashboard: 'pages.dashboard.view',
      instances: 'pages.instances.view',
      watchlists: 'pages.watchlists.view',
      orders: 'pages.orders.view',
      trades: 'pages.trades.view',
      positions: 'pages.positions.view',
      'daily-pnl-snapshots': 'pages.daily_pnl.view',
      settings: 'pages.settings.view',
      notifications: 'pages.notifications.view',
      audit: 'pages.audit.view',
      'api-playground': 'pages.api_playground.view',
    };
  }
  async ensureInstancesLoaded() {
    if (Array.isArray(this.instances) && this.instances.length > 0) {
      return;
    }
    try {
      const instancesRes = await api.getInstances({ is_active: true });
      this.instances = Array.isArray(instancesRes?.data) ? instancesRes.data : [];
    } catch (error) {
      console.warn('Failed to load instances for panel rendering', error);
    }
  }

  _buildPanelInstances(payload = {}, itemKey = 'orders') {
    const liveFromPayload = Array.isArray(payload.liveInstances) ? payload.liveInstances : [];
    const analyzerFromPayload = Array.isArray(payload.analyzerInstances) ? payload.analyzerInstances : [];

    const entryMap = new Map();
    [...liveFromPayload, ...analyzerFromPayload].forEach((entry) => {
      entryMap.set(String(entry.instance_id), entry);
    });

    if (!Array.isArray(this.instances) || this.instances.length === 0) {
      return { liveInstances: liveFromPayload, analyzerInstances: analyzerFromPayload };
    }

    const liveInstances = [];
    const analyzerInstances = [];
    this.instances.forEach((inst) => {
      const id = String(inst.id);
      const existing = entryMap.get(id) || {};
      const merged = {
        instance_id: inst.id,
        instance_name: inst.name || existing.instance_name,
        broker: inst.broker || existing.broker,
        is_analyzer_mode: !!inst.is_analyzer_mode,
        market_data_role: inst.market_data_role || existing.market_data_role,
        [itemKey]: Array.isArray(existing[itemKey]) ? existing[itemKey] : [],
        fetchedAt: existing.fetchedAt || null,
      };
      if (merged.is_analyzer_mode) {
        analyzerInstances.push(merged);
      } else {
        liveInstances.push(merged);
      }
    });

    return { liveInstances, analyzerInstances };
  }

  _buildEmptyPositionsPayload() {
    if (!Array.isArray(this.instances) || this.instances.length === 0) {
      return {
        instances: [],
        overall_total_pnl: 0,
        overall_open_positions: 0,
        overall_closed_positions: 0,
      };
    }

    return {
      instances: this.instances.map((inst) => ({
        instance_id: inst.id,
        instance_name: inst.name,
        broker: inst.broker,
        is_analyzer_mode: !!inst.is_analyzer_mode,
        positions: [],
        total_pnl: 0,
        open_positions_count: 0,
        closed_positions_count: 0,
        error: null,
      })),
      overall_total_pnl: 0,
      overall_open_positions: 0,
      overall_closed_positions: 0,
    };
  }
  async init() {
    try {
      this.loadSidebarState();
      this.applySidebarState();
      this.loadTheme();
      this.applyTheme();
      this.quickOrder = window.quickOrder || null;

      // Load current user
      await this.loadCurrentUser();
      await this.loadPublicConfig();

      if (this.useWsGateway) {
        if (this.wsGatewayEnabled) {
          this.startWsStream();
        } else {
          Utils.showToast('Live streaming is required. Polling is disabled.', 'warning');
        }
      }

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

      // debug removed
    } catch (error) {
      console.error('Failed to initialize dashboard:', error);
      Utils.showToast('Failed to initialize dashboard', 'error');
    }
  }

  loadSidebarState() {
    const stored = localStorage.getItem('sidebarCollapsed');
    this.isSidebarCollapsed = stored === 'true';
  }

  loadTheme() {
    const stored = localStorage.getItem('dashboard-theme');
    this.theme = stored || 'dark';
  }

  applyTheme() {
    const theme = this.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeButtonUI();
    localStorage.setItem('dashboard-theme', theme);
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    this.applyTheme();
  }

  updateThemeButtonUI() {
    const sunIcon = document.querySelector('#theme-toggle-icon .sun-icon');
    const moonIcon = document.querySelector('#theme-toggle-icon .moon-icon');
    if (!sunIcon || !moonIcon) return;

    if (this.theme === 'dark') {
      sunIcon.classList.remove('hidden');
      moonIcon.classList.add('hidden');
    } else {
      sunIcon.classList.add('hidden');
      moonIcon.classList.remove('hidden');
    }
  }

  loadWsPreference() {
    try {
      const stored = localStorage.getItem('useWsGateway');
      if (stored === null) {
        return true;
      }
      return stored === 'true';
    } catch (_) {
      return true;
    }
  }

  saveWsPreference(enabled) {
    try {
      localStorage.setItem('useWsGateway', enabled ? 'true' : 'false');
    } catch (_) {
      // ignore
    }
  }

  loadSnapshotResyncPreference() {
    try {
      const stored = localStorage.getItem('autoSnapshotResyncEnabled');
      if (stored === 'false') return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  persistSnapshotResyncPreference(enabled) {
    try {
      localStorage.setItem('autoSnapshotResyncEnabled', enabled ? 'true' : 'false');
    } catch (_) {
      // ignore
    }
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
    if (this.isPaused) {
      Utils.showToast('Paused all background data fetching', 'info');
      this.stopAllWatchlistPolling();
      this.stopTradesPolling();
      this.stopPositionsPolling();
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }
      // Stop backend polling
      api.stopPolling().catch(() => { });
      api.stopMarketDataPolling().catch(() => { });
    } else {
      Utils.showToast('Resumed data fetching', 'success');
      // Resume backend polling
      api.startPolling().catch(() => { });
      this.refreshCurrentView(true);
      this.startAutoRefresh();
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
      if (!response || !response.data) {
        // API client may have redirected for pending access
        throw new Error('ACCESS_PENDING');
      }
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

      this.applyAdminVisibility();
      this.applyPermissionVisibility();

      // If no role assigned, show message and halt further loading
      if (!this.currentUser.role && !this.currentUser.is_admin) {
        Utils.showToast('No role assigned. An admin will review your access.', 'warning');
        const contentArea = document.getElementById('content-area');
        if (contentArea) {
          contentArea.innerHTML = `
            <div class="p-6">
              <div class="alert alert-warning">
                <div>
                  <h3 class="font-semibold">Access pending</h3>
                  <p>Your account has been created but no role is assigned yet. An admin will review your request and grant access.</p>
                </div>
              </div>
            </div>
          `;
        }
        throw new Error('NO_ROLE_ASSIGNED');
      }
    } catch (error) {
      console.error('Failed to load user:', error);
      if (error.message === 'NO_ROLE_ASSIGNED') {
        throw error;
      }
      if (error.statusCode === 403 || error.message === 'ACCESS_PENDING') {
        window.location.href = '/access-pending.html';
        return;
      }
    }
  }

  async loadPublicConfig() {
    try {
      const res = await api.getPublicConfig();
      const cfg = res?.data || {};
      this.wsGatewayEnabled = Boolean(cfg.wsGatewayEnabled);
      this.wsGatewayPath = cfg.wsGatewayPath || '/stream';
      this.applyMarketDataConfig(cfg.marketData || {});
      if (cfg.webhookToken) {
        window.WEBHOOK_TOKEN = cfg.webhookToken;
        window.appConfig = { ...(window.appConfig || {}), webhookToken: cfg.webhookToken };
      }
    } catch (err) {
      this.wsGatewayEnabled = false;
    }
  }

  applyMarketDataConfig(md = {}) {
    if (typeof md.positionsPollIdleMs === 'number') {
      this.positionsPollingIdleMs = md.positionsPollIdleMs;
    }
    if (typeof md.positionsPollActiveMs === 'number') {
      this.positionsPollingActiveMs = md.positionsPollActiveMs;
    }
    if (typeof md.ltpCacheIdleMs === 'number') {
      this.ltpCacheTtlIdleMs = md.ltpCacheIdleMs;
    }
    if (typeof md.ltpCacheActiveMs === 'number') {
      this.ltpCacheTtlActiveMs = md.ltpCacheActiveMs;
    }

    const hasOpenPositions = (this.latestWatchlistPositionsData?.overallOpen || 0) > 0;
    this._updatePositionsPollingInterval(hasOpenPositions);
  }

  isWsStreamingActive() {
    return Boolean(this.useWsGateway && this.wsGatewayEnabled && this.wsConnected);
  }

  isAdmin() {
    return (this.currentUser?.role || '').toUpperCase() === 'ADMIN' || this.currentUser?.is_admin === true;
  }

  hasPermission(permissionKey) {
    if (this.isAdmin()) return true;
    const perms = this.currentUser?.permissions || [];
    return perms.includes(permissionKey);
  }

  applyAdminVisibility() {
    const adminOnly = document.querySelectorAll('[data-admin-only="true"]');
    const show = this.isAdmin();
    adminOnly.forEach((el) => {
      el.style.display = show ? '' : 'none';
    });
  }

  applyPermissionVisibility() {
    const permissionEls = document.querySelectorAll('[data-permission]');
    permissionEls.forEach((el) => {
      const key = el.dataset.permission;
      const show = this.hasPermission(key);
      el.style.display = show ? '' : 'none';
    });
  }

  startWsStream() {
    if (!this.wsGatewayEnabled) return;
    this.useWsGateway = true;
    this.saveWsPreference(true);
    this.wsReconnectDelay = 500;
    if (!this.ws) {
      this.connectWsStream();
    }
  }

  stopWsStream(reason = '') {
    this.useWsGateway = false;
    this.saveWsPreference(false);
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) { }
      this.ws = null;
    }
    this.wsConnected = false;
    if (reason === 'user') {
      Utils.showToast('Live streaming turned off. Using polling only.', 'info');
    }
  }

  scheduleWsReconnect() {
    if (!this.useWsGateway || !this.wsGatewayEnabled) return;
    const delay = Math.min(this.wsReconnectDelay, 8000);
    this.wsReconnectDelay = Math.min(delay * 2, 8000);
    this.wsReconnectTimer = setTimeout(() => this.connectWsStream(), delay);
  }

  connectWsStream() {
    if (!this.useWsGateway || !this.wsGatewayEnabled) return;
    if (this.ws) return;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${window.location.host}${this.wsGatewayPath}?topics=${this.wsTopics.join(',')}&last_seq=${this.wsLastSeq || 0}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.wsReconnectDelay = 500;
        this.wsConnected = true;
        this.stopAllWatchlistPolling();
        if (window.quickOrder && typeof window.quickOrder.syncPreviewPollingWithStreaming === 'function') {
          window.quickOrder.syncPreviewPollingWithStreaming();
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleWsMessage(message);
        } catch (err) {
          console.warn('WS message parse failed', err);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        this.ws = null;
        this.wsConnected = false;
        this._resumePollingIfWsInactive();
        this.scheduleWsReconnect();
      };
    } catch (err) {
      console.warn('WS connect failed', err);
      this.scheduleWsReconnect();
    }
  }

  handleWsMessage(msg) {
    if (!msg) return;
    if (typeof msg.seq === 'number') {
      if (this.wsLastSeq > 0 && msg.seq > this.wsLastSeq + 1) {
        this.triggerSnapshotResync();
      }
      this.wsLastSeq = Math.max(this.wsLastSeq, msg.seq);
    }

    switch (msg.topic) {
      case 'quotes:update': {
        if (this.currentView === 'watchlists') {
          this.handleQuoteStreamPayload(msg.payload || {});
        } else {
          this.wsRefreshWatchlists();
        }
        break;
      }
      case 'positions:update': {
        if (this.currentView === 'positions') {
          this.wsRefreshPositions();
        }
        if (this.currentView === 'dashboard') {
          this.wsRefreshDashboard();
        }
        break;
      }
      case 'funds:update': {
        if (this.currentView === 'dashboard') {
          this.wsRefreshDashboard();
        }
        break;
      }
      default:
        break;
    }
  }

  toggleStreamPreference() {
    this.useWsGateway = true;
    this.saveWsPreference(true);
    if (this.wsGatewayEnabled) {
      this.startWsStream();
      Utils.showToast('Live streaming locked on', 'success');
    } else {
      Utils.showToast('Server streaming is disabled. Polling is not available.', 'warning');
    }
  }

  getStreamPreference() {
    return this.useWsGateway;
  }

  _resumePollingIfWsInactive() {
    if (this.isWsStreamingActive()) {
      return;
    }
    const expandedIds = Array.from(this.expandedWatchlists || []);
    expandedIds.forEach((wlId) => {
      this.startWatchlistPolling(wlId);
    });
    if (window.quickOrder && typeof window.quickOrder.syncPreviewPollingWithStreaming === 'function') {
      window.quickOrder.syncPreviewPollingWithStreaming();
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

    const requiredPerm = this.viewPermissions[viewName];
    if (requiredPerm && !this.hasPermission(requiredPerm)) {
      Utils.showToast('You do not have access to this page.', 'warning');
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
  async loadView(viewName, { force = false } = {}) {
    if (this.isPaused && !force) return;
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

    if (this.currentView === 'dashboard' && viewName !== 'dashboard') {
      this.stopTelemetryRefresh();
      this.stopDashboardMetricsRefresh();
    }

    if (['watchlists', 'positions'].includes(this.currentView) && !['watchlists', 'positions'].includes(viewName)) {
      this.stopSnapshotResync();
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
      notifications: 'Notifications',
      'api-playground': 'API Playground',
      'daily-pnl-snapshots': 'Daily P&L Snapshots',
    };

    document.getElementById('view-title').textContent =
      titles[viewName] || viewName;

    // Show loading
    const contentArea = document.getElementById('content-area');
    Utils.showLoading(contentArea);
    this.updateThemeButtonUI();

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
          this.startSnapshotResync('watchlists');
          break;
        case 'orders':
          await this.renderOrdersView();
          break;
        case 'trades':
          await this.renderTradesView();
          break;
        case 'positions':
          await this.renderPositionsView();
          this.startSnapshotResync('positions');
          break;
        case 'daily-pnl-snapshots':
          await this.renderDailyPnlSnapshotsView();
          break;
        case 'settings':
          await settings.renderSettingsView();
          break;
        case 'notifications':
          await this.renderNotificationsView();
          break;
        case 'audit':
          await this.renderAuditView();
          break;
        case 'api-playground':
          await this.renderApiPlaygroundView();
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
  async refreshCurrentView(force = false) {
    if (this.isPaused && !force) return;
    await this.loadView(this.currentView, { force });
  }
  startAutoRefresh() {
    // Clear existing interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    if (this.isPaused) return;

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

  async logout() {
    const confirmed = await Utils.confirm('Are you sure you want to logout?');

    if (confirmed) {
      this.stopWsStream();
      await api.logout();
      window.location.href = '/login.html';
    }
  }
}

window.DashboardApp = DashboardApp;
