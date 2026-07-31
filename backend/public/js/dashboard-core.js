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
    this.validViews = ['dashboard', 'instances', 'watchlists', 'chart', 'strategies', 'orders', 'trades', 'positions', 'daily-pnl-snapshots', 'settings', 'notifications', 'audit', 'api-playground'];
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
    // Feed status pill (navbar) - see updateFeedStatus()
    this.lastDataAt = 0;          // epoch ms of the most recent successful quote refresh
    this.feedStatusInterval = null;
    this.feedStaleAfterMs = 30000; // no fresh quote for this long => warn the operator
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
    this.wsTopics = ['quotes:update', 'positions:update', 'funds:update', 'order_update'];
    this.useWsGateway = this.loadWsPreference();
    this.ws = null;
    this.wsConnected = false;
    this.wsLastSeq = 0;
    this.wsReconnectDelay = 500;
    this.wsReconnectTimer = null;
    // Recent order_update events (bounded ring buffer) + pending fuzzy-match waiters - see
    // waitForOrderUpdateMatch(), used by quick-order-place.js to confirm an ambiguous
    // order-placement response from the broker's push feed instead of a REST round-trip.
    this.recentOrderUpdates = [];
    this.orderUpdateWaiters = [];
    // Each debounced refresh is scheduled while its view is on screen, but the view can change
    // before the timer fires 0.8-1.2s later - switching to the chart right after a positions/funds
    // tick schedules exactly that. Without a re-check here, the timer fires anyway and overwrites
    // whatever is now showing (e.g. the chart) with a stale view's re-render, silently detaching
    // that view's canvas/series from the DOM even though its own data keeps updating underneath.
    this.wsRefreshDashboard = Utils.debounce(() => {
      if (this.currentView === 'dashboard') this.renderDashboardView();
    }, 1200);
    this.wsRefreshPositions = Utils.debounce(() => {
      if (this.currentView === 'positions') this.renderPositionsView();
    }, 1200);
    this.wsRefreshWatchlists = Utils.debounce(() => {
      if (this.currentView === 'watchlists') this._throttledWatchlistRefresh({ showLoader: false });
    }, 800);
    // Theme (light-only)
    this.theme = 'light';
    this.viewPermissions = {
      dashboard: 'pages.dashboard.view',
      instances: 'pages.instances.view',
      watchlists: 'pages.watchlists.view',
      strategies: 'pages.watchlists.view',
      // Charting reuses the watchlist permission rather than introducing a new key: the chart
      // draws watchlist symbols, so anyone who may see them may chart them. Avoids an RBAC
      // migration and means every existing role works unchanged.
      chart: 'pages.watchlists.view',
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
      this.startFeedStatus();

      // Note: Auto-refresh disabled to prevent page flicker
      // Individual polling mechanisms (quotes, positions) handle their own updates
      this.startAutoRefresh();
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
    this.updateFeedStatus(); // reflect immediately rather than on the next 1s tick
    if (this.isPaused) {
      Utils.showToast('Paused all background data fetching', 'info');
      this.stopAllWatchlistPolling();
      this.stopTradesPolling();
    }

    // Dispose the chart when navigating away; createChart attaches a ResizeObserver and canvas
    // that survive the innerHTML swap otherwise.
    if (this.currentView === 'chart' && viewName !== 'chart') {
      if (typeof this.destroyChart === 'function') this.destroyChart();
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
      this.resumeBackgroundData();
    }
  }

  /**
   * Record that fresh market data arrived. Called from the quote-meta choke point in
   * dashboard-watchlists-quotes.js so every feed path (WS push or REST poll) counts.
   */
  markDataReceived(timestamp = Date.now()) {
    const ts = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
    if (Number.isNaN(ts)) return;
    // Never let a stale cached timestamp drag the freshness clock backwards.
    if (ts > this.lastDataAt) this.lastDataAt = ts;
  }

  startFeedStatus() {
    if (this.feedStatusInterval) return;
    this.updateFeedStatus();
    // 1s tick: the stale countdown is the whole point, so it has to advance in real time.
    this.feedStatusInterval = setInterval(() => this.updateFeedStatus(), 1000);
  }

  stopFeedStatus() {
    if (!this.feedStatusInterval) return;
    clearInterval(this.feedStatusInterval);
    this.feedStatusInterval = null;
  }

  /**
   * Resolve the feed into one of six mutually exclusive states. Ordering matters: an explicit
   * user pause outranks connection state, and "no data ever" is reported as Connecting rather
   * than as a huge stale age.
   */
  resolveFeedState() {
    if (this.isPaused) {
      return { state: 'paused', label: 'Paused', title: 'Background data fetching is paused. Press play to resume.' };
    }

    const age = this.lastDataAt ? Date.now() - this.lastDataAt : null;

    if (this.wsGatewayEnabled && this.useWsGateway && !this.wsConnected) {
      return { state: 'down', label: 'Disconnected', title: 'Live stream is down. Reconnecting…' };
    }

    if (age === null) {
      return { state: 'connecting', label: 'Connecting', title: 'Waiting for the first quote from the feed.' };
    }

    if (age > this.feedStaleAfterMs) {
      const secs = Math.floor(age / 1000);
      const pretty = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`;
      return {
        state: 'stale',
        label: `Stale ${pretty}`,
        title: `No fresh quote for ${pretty}. Prices on screen may be out of date.`,
      };
    }

    return this.wsConnected
      ? { state: 'live', label: 'Live', title: 'Streaming live over the WebSocket gateway.' }
      : { state: 'polling', label: 'Polling', title: 'Receiving quotes via REST polling.' };
  }

  updateFeedStatus() {
    const el = document.getElementById('feed-status');
    const labelEl = document.getElementById('feed-status-label');
    if (!el || !labelEl) return;

    const { state, label, title } = this.resolveFeedState();
    const cls = `feed-status is-${state}`;
    if (el.className !== cls) el.className = cls;
    if (labelEl.textContent !== label) labelEl.textContent = label;
    if (el.title !== title) el.title = title;
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
    } catch (err) {
      this.wsGatewayEnabled = false;
    }

    // Separate call: webhook-config requires settings.manage, so a non-admin user 403ing here
    // must not affect the public config loaded above.
    try {
      const webhookRes = await api.getWebhookConfig();
      const webhookToken = webhookRes?.data?.webhookToken;
      if (webhookToken) {
        window.WEBHOOK_TOKEN = webhookToken;
        window.appConfig = { ...(window.appConfig || {}), webhookToken };
      }
    } catch (err) {
      // Expected for non-admin users - webhook token just won't be shown in the UI.
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
    this.applyNavGroupVisibility();
  }

  /**
   * Hide a sidebar group heading once every destination under it has been permission-hidden,
   * so a restricted user never sees an "Administration" label with nothing beneath it.
   */
  applyNavGroupVisibility() {
    document.querySelectorAll('[data-nav-group]').forEach((title) => {
      const group = title.dataset.navGroup;
      const items = document.querySelectorAll(`[data-nav-group-item="${group}"]`);
      const anyVisible = Array.from(items).some((li) => {
        // The permission attribute sits on the <a>; the wrapping <li> may carry one too.
        const target = li.querySelector('[data-permission]') || li;
        return target.style.display !== 'none' && li.style.display !== 'none';
      });
      title.style.display = anyVisible ? '' : 'none';
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
      // The token travels in the query string because a WebSocket upgrade cannot carry a
      // custom Authorization header - the browser's WebSocket constructor has no API for it.
      // The gateway used to expect a session cookie instead, which nothing in this app ever
      // issues, so this connection was rejected every single time regardless of retries.
      const token = encodeURIComponent(localStorage.getItem('auth_token') || '');
      const url = `${protocol}://${window.location.host}${this.wsGatewayPath}?topics=${this.wsTopics.join(',')}&last_seq=${this.wsLastSeq || 0}&token=${token}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.wsReconnectDelay = 500;
        this.wsConnected = true;
        this.updateFeedStatus();
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
        this.updateFeedStatus(); // surface the disconnect without waiting for the tick
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

    // The navbar pill answers one question - "is the feed alive" - and that has nothing to do
    // with which view happens to be open. It used to be marked from inside the watchlists-view
    // rendering path only (updateWatchlistQuoteMeta), on the theory that every quote funnelled
    // through there; the dispatch below grew view-specific branches (chart folds ticks itself,
    // dashboard/positions refresh their own widgets) that never went near it, so the pill sat on
    // "Connecting" - lastDataAt never set - for as long as the user stayed off Watchlists, which
    // in practice is most of the time. Any of these three topics arriving IS the feed working,
    // regardless of what's rendered as a result, so the clock is marked here instead.
    if (msg.topic === 'quotes:update' || msg.topic === 'positions:update' || msg.topic === 'funds:update') {
      this.markDataReceived();
    }

    switch (msg.topic) {
      case 'quotes:update': {
        if (this.currentView === 'watchlists') {
          this.handleQuoteStreamPayload(msg.payload || {});
        } else if (this.currentView === 'chart') {
          // Fold ticks straight into the live bar - see dashboard-chart-live.js. The watchlist
          // caches are kept warm at the same time so switching back is not a cold start.
          const quotes = Array.isArray(msg.payload?.data) ? msg.payload.data : [];
          const ts = Date.now();
          for (const quote of quotes) this.applyChartQuote(this.hydrateQuoteWithLtp(quote, ts), true);
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
      case 'order_update': {
        this._recordOrderUpdate(msg.payload || {});
        break;
      }
      default:
        break;
    }
  }

  _recordOrderUpdate(payload) {
    const entry = { ...payload, receivedAt: Date.now() };
    this.recentOrderUpdates.push(entry);
    if (this.recentOrderUpdates.length > 200) {
      this.recentOrderUpdates.shift();
    }
    this.orderUpdateWaiters = this.orderUpdateWaiters.filter((waiter) => {
      if (!this._orderUpdateMatches(entry, waiter.criteria)) return true;
      clearTimeout(waiter.timer);
      waiter.resolve(entry);
      return false;
    });
  }

  _orderUpdateMatches(entry, criteria) {
    const order = entry?.order || {};
    if ((order.order_status || '').toLowerCase() !== 'complete') return false;
    if ((order.symbol || '').toUpperCase() !== (criteria.symbol || '').toUpperCase()) return false;
    if (criteria.exchange && (order.exchange || '').toUpperCase() !== criteria.exchange.toUpperCase()) return false;
    if (criteria.side && (order.action || '').toUpperCase() !== criteria.side.toUpperCase()) return false;
    const filledQty = Number(order.filled_quantity) || 0;
    if (criteria.quantity && filledQty < Number(criteria.quantity)) return false;
    return true;
  }

  /**
   * Advisory-only fuzzy match against the order-update push stream: symbol + exchange + side +
   * quantity, NOT an exact order-id match (we don't have one - this exists for the case where we
   * never learned the orderid because the placement response itself was lost). A false miss just
   * means the caller falls back to its own safe path (e.g. the idempotent REST retry in
   * quick-order-place.js) - never treat a match here as a substitute for that fallback's
   * guarantees, only as a faster way to skip it when the broker feed already answered.
   * Resolves null immediately if the WS gateway isn't connected - nothing to check against.
   */
  waitForOrderUpdateMatch(criteria, timeoutMs = 1500) {
    if (!this.wsConnected) return Promise.resolve(null);

    const already = this.recentOrderUpdates.find(
      (entry) => Date.now() - entry.receivedAt < timeoutMs && this._orderUpdateMatches(entry, criteria)
    );
    if (already) return Promise.resolve(already);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.orderUpdateWaiters = this.orderUpdateWaiters.filter((w) => w.timer !== timer);
        resolve(null);
      }, timeoutMs);
      this.orderUpdateWaiters.push({ criteria, resolve, timer });
    });
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
      chart: 'Chart',
      strategies: 'Strategies',
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
        case 'strategies':
          await this.renderStrategiesOverviewView();
          break;
        case 'orders':
          await this.renderOrdersView();
          break;
        case 'trades':
          await this.renderTradesView();
          break;
        case 'chart':
          await this.renderChartView();
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
  /**
   * Re-render the current view from scratch. This is a user-initiated action (a Refresh button,
   * an explicit force) - it is NOT what the background tick does. See startAutoRefresh.
   */
  async refreshCurrentView(force = false) {
    if (this.isPaused && !force) return;
    await this.loadView(this.currentView, { force });
  }

  /**
   * Bring background data back after a pause or a tab switch.
   *
   * Deliberately NOT a full re-render. Returning to the tab used to call
   * refreshCurrentView(true), which rebuilt the whole view - so stepping away from the chart and
   * back destroyed the candles, the option panes and every indicator sub-chart. Resuming should
   * be invisible: restart the pollers, refresh in place, leave the DOM alone.
   */
  resumeBackgroundData() {
    this.startAutoRefresh();

    const inPlace = RESUME_IN_PLACE[this.currentView];
    if (inPlace) {
      Promise.resolve(inPlace(this)).catch((error) =>
        console.error(`Resume refresh failed for ${this.currentView}:`, error));
      return;
    }
    // These views start their pollers as part of rendering, so for them resuming does mean a
    // re-render. Everything else is either handled above or holds state a rebuild would lose.
    if (RESUME_BY_RERENDER.has(this.currentView)) {
      this.loadView(this.currentView, { force: true }).catch(() => { /* reported by loadView */ });
    }
  }

  startAutoRefresh() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    if (this.isPaused) return;

    this.pollingInterval = setInterval(() => {
      const refresh = AUTO_REFRESH_VIEWS[this.currentView];
      if (!refresh || this.isPaused) return;
      Promise.resolve(refresh(this)).catch((error) =>
        console.error(`Auto-refresh failed for ${this.currentView}:`, error));
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

/**
 * What the 15-second background tick is allowed to touch, and how.
 *
 * It used to re-render whichever view was open, wholesale, every 15 seconds. That predates
 * every view growing its own updating mechanism, so by now it is redundant everywhere and
 * actively destructive in places: the chart tears down its candles, option panes and indicator
 * sub-charts mid-interaction (leaving "Trade options" ticked with nothing under it), the API
 * playground loses whatever was typed, and settings loses an unsaved edit. It also read as the
 * whole page reloading every few seconds, because visually that is what it was.
 *
 * Views absent from this map are not stale - they keep themselves current by other means:
 *
 *   watchlists   own adaptive poller (startPositionsPolling)
 *   positions    WebSocket pushes (wsRefreshPositions) plus a 60s snapshot resync
 *   dashboard    own metrics and telemetry intervals
 *   trades       own 5s poller
 *   chart        own candle refresh and live feed
 *   strategies, audit, daily-pnl-snapshots   static until acted on
 *   settings, api-playground                 hold unsaved input; re-rendering destroys it
 *
 * Anything added here must update data in place. A full re-render is a page refresh in
 * everything but name.
 */
const AUTO_REFRESH_VIEWS = {
  instances: (app) => app.renderInstancesView(),
  notifications: (app) => app.renderNotificationsView(),
  // Data-only: keeps the active filter, the scroll position and any expanded row.
  orders: (app) => app.loadOrders(app.currentOrderFilter || '', { ensureView: false }),
};

/**
 * How each view comes back after a pause or a tab switch.
 *
 * Resuming used to call refreshCurrentView(true) - a full rebuild of whatever was open - so
 * stepping away from the chart and back destroyed the candles, the option panes and every
 * indicator sub-chart, while leaving "Trade options" ticked with nothing beneath it.
 *
 * In-place first. Falling back to a re-render is only for views whose pollers are started by
 * their own render, where not re-rendering would leave them silently frozen.
 */
const RESUME_IN_PLACE = {
  ...AUTO_REFRESH_VIEWS,
  // Fresh candles after being away, without tearing the chart down.
  chart: (app) => app.loadChartData(),
};

const RESUME_BY_RERENDER = new Set(['watchlists', 'positions', 'trades', 'dashboard']);

window.DashboardApp = DashboardApp;
