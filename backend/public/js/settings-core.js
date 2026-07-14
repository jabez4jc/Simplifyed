/**
 * Simplifyed Admin V2 - Settings: core class declaration + constructor state, auth/
 * permission helpers, tab router, isAdmin (cross-cutting, used by General/RBAC tabs and
 * the router), and shared formatting helpers used by 2+ tabs.
 * Sibling modules (settings-*.js) each add their methods onto SettingsHandler.prototype
 * via Object.defineProperties(...Object.getOwnPropertyDescriptors(class {...}.prototype))
 * - see settings-init.js for the final instantiation (must load after every mixin file).
 */

class SettingsHandler {
  constructor() {
    this.categories = [];
    this.settings = {};
    this.activeCategory = 'server';
    this.activeMainTab = 'general'; // New: Track main tab (general, access, data, status)
    this.isSaving = false;
    this.searchQuery = '';
    this.allowedCategories = null; // show all categories by default
    this.currentUser = null;
    this.roles = [];
    this.users = [];
    this.permissions = [];
    this.instanceHealthTests = null;
    this.activeRoleTab = null;
    this.permissionFilter = '';
    this.userFilter = '';
    this.userRoleFilter = 'all';
    this.allowedCategories = ['polling', 'market_data_feed', 'instance_health', 'instance_health_tests', 'market_hours', 'trading', 'brokerage'];
    this.allowedSettings = {
      polling: [
        'polling.instance_interval_ms',
        'polling.health_check_interval_ms',
      ],
      streaming: [
        'streaming.enabled',
      ],
      market_data_feed: [
        'market_data_feed.quote_ttl_idle_ms',
        'market_data_feed.quote_ttl_active_ms',
        'market_data_feed.position_interval_idle_ms',
        'market_data_feed.position_interval_active_ms',
        'market_data_feed.tradebook_interval_idle_ms',
        'market_data_feed.tradebook_interval_active_ms',
        'market_data_feed.orderbook_interval_ms',
        'market_data_feed.funds_interval_ms',
        'market_data_feed.multiquote_cooldown_idle_ms',
        'market_data_feed.multiquote_cooldown_active_ms',
        'market_data_feed.max_order_spread_pct',
      ],
      instance_health: [
        'instance_health.ping_healthy_interval_ms',
        'instance_health.ping_unhealthy_interval_ms',
        'instance_health.ping_unhealthy_max_attempts',
        'instance_health.analyzer_check_interval_ms',
      ],
      instance_health_tests: [],
      market_hours: [
        'market_hours.quote_blackout_start',
        'market_hours.quote_blackout_end',
        'market_hours.general_blackout_start',
        'market_hours.general_blackout_end',
      ],
      trading: [
        'trading_sessions',
      ],
      brokerage: [
        'brokerage.default',
        'brokerage.by_broker',
        'brokerage.market_order_support',
      ],
    };
    this.displaySettings = {};
    this.displayCategories = [];

    // Category metadata with icons and descriptions
    this.categoryMeta = {
      'server': {
        icon: '🖥️',
        description: 'Server configuration and environment settings'
      },
      'polling': {
        icon: '🔄',
        description: 'Polling intervals for data refresh'
      },
      'streaming': {
        icon: '📡',
        description: 'WebSocket streaming for live data updates'
      },
      'openalgo': {
        icon: '📡',
        description: 'OpenAlgo API connection and retry settings'
      },
      'database': {
        icon: '💾',
        description: 'Database storage configuration'
      },
      'session': {
        icon: '🔐',
        description: 'User session and authentication settings'
      },
      'cors': {
        icon: '🌐',
        description: 'Cross-origin resource sharing policies'
      },
      'logging': {
        icon: '📝',
        description: 'Application logging configuration'
      },
      'rate_limit': {
        icon: '⚡',
        description: 'API rate limiting and throttling'
      },
      'rate_limits': {
        icon: '⚡',
        description: 'API rate limiting, throttling, and circuit breaker settings'
      },
      'oauth': {
        icon: '🔑',
        description: 'OAuth authentication providers'
      },
      'test': {
        icon: '🧪',
        description: 'Test mode and debugging options'
      },
      'proxy': {
        icon: '🔀',
        description: 'Proxy server configuration'
      },
      'options': {
        icon: '📊',
        description: 'Options trading default settings'
      },
      'market_data_feed': {
        icon: '📈',
        description: 'Market data caching and TTL settings'
      },
      'instance_health': {
        icon: '🫀',
        description: 'Instance health checks, pings, and analyzer cadence'
      },
      'instance_health_tests': {
        icon: '🧪',
        description: 'Symbols used for endpoint capability tests'
      },
      'market_hours': {
        icon: '🕒',
        description: 'Blackout windows for OpenAlgo endpoints'
      },
      'trading': {
        icon: '🗓️',
        description: 'Session windows used for intraday risk resets'
      },
      'brokerage': {
        icon: '💸',
        description: 'Brokerage per trade for P&L calculations'
      }
    };
  }
}

Object.defineProperties(SettingsHandler.prototype, Object.getOwnPropertyDescriptors(class {
  getAuthToken() {
    try {
      return localStorage.getItem('auth_token');
    } catch (e) {
      return null;
    }
  }

  getAuthHeaders() {
    const token = this.getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async authFetch(url, options = {}) {
    const headers =
      options.headers instanceof Headers
        ? Object.fromEntries(options.headers.entries())
        : { ...(options.headers || {}) };

    Object.assign(headers, this.getAuthHeaders());

    const config = {
      credentials: 'include',
      ...options,
      headers,
    };

    return fetch(url, config);
  }

  hasPermission(key) {
    const perms = this.currentUser?.permissions || [];
    return perms.includes(key);
  }

  canViewApplicationSettings() {
    return this.isAdmin() || this.hasPermission('pages.settings.view') || this.hasPermission('settings.manage');
  }

  canEditApplicationSettings() {
    return this.isAdmin() || this.hasPermission('settings.manage');
  }
  /**
   * Render settings view with new tab-based layout
   */
  async renderSettingsView() {
    const contentArea = document.getElementById('content-area');

    try {
      // Always fetch user first so we can decide what to load
      this.currentUser = await this.fetchCurrentUser();
      const canViewAppSettings = this.canViewApplicationSettings();

      // Fetch the rest, but only pull settings/categories if allowed
      const [categories, allSettings] = await Promise.all([
        canViewAppSettings ? this.fetchCategories() : Promise.resolve([]),
        canViewAppSettings ? this.fetchAllSettings() : Promise.resolve({})
      ]);

      this.categories = categories;
      this.settings = allSettings;
      this.applySettingsFilter();

      // Load instance health test config
      if (this.isAdmin()) {
        try {
          const cfgRes = await api.getInstanceHealthTests();
          this.instanceHealthTests = cfgRes.data || null;
        } catch (err) {
          console.warn('Failed to load instance health tests config', err);
        }
      }

      if (this.isAdmin()) {
        await this.fetchRbacData();
      }

      // Render the new tab-based layout
      contentArea.innerHTML = `
        <div class="settings-page-container">
          <!-- Main Tab Navigation -->
          ${this.renderMainTabNavigation()}

          <!-- Tab Content -->
          <div class="settings-tab-content">
            ${await this.renderActiveTabContent(canViewAppSettings)}
          </div>
        </div>
      `;

      // Initialize event listeners
      if (this.isAdmin()) {
        this.initRbacListeners();
      }
      this.initCategoryTabs();
      this.initMainTabListeners();
    } catch (error) {
      contentArea.innerHTML = `
        <div class="p-4">
          <p class="text-error">Failed to load settings: ${error.message}</p>
        </div>
      `;
      console.error('[Settings] Error rendering settings view:', error);
    }
  }

  applySettingsFilter() {
    const allowedCategories = Array.isArray(this.allowedCategories)
      ? new Set(this.allowedCategories)
      : null;
    const filteredSettings = {};

    Object.entries(this.settings || {}).forEach(([category, categorySettings]) => {
      if (allowedCategories && !allowedCategories.has(category)) {
        return;
      }

      const allowedKeys = this.allowedSettings?.[category];
      const filteredCategorySettings = {};

      Object.entries(categorySettings || {}).forEach(([key, setting]) => {
        if (Array.isArray(allowedKeys) && !allowedKeys.includes(key)) {
          return;
        }
        filteredCategorySettings[key] = setting;
      });

      if (Object.keys(filteredCategorySettings).length > 0) {
        filteredSettings[category] = filteredCategorySettings;
      }
    });

    if (!allowedCategories || allowedCategories.has('streaming')) {
      const streamingSetting = this.getStreamingSetting();
      if (!this.settings.streaming) {
        this.settings.streaming = {};
      }
      this.settings.streaming['streaming.enabled'] = streamingSetting;
      filteredSettings.streaming = this.settings.streaming;
    }

    if (!allowedCategories || allowedCategories.has('instance_health_tests')) {
      filteredSettings.instance_health_tests = {};
    }

    this.displaySettings = filteredSettings;
    this.displayCategories = Object.keys(filteredSettings).map((category) => ({
      category,
      count: Object.keys(filteredSettings[category] || {}).length,
    }));

    if (Array.isArray(this.allowedCategories)) {
      this.displayCategories.sort(
        (a, b) =>
          this.allowedCategories.indexOf(a.category) -
          this.allowedCategories.indexOf(b.category)
      );
    }

    if (!this.displaySettings[this.activeCategory]) {
      this.activeCategory = this.displayCategories[0]?.category || this.activeCategory;
    }
  }

  getStreamingSetting() {
    const existing = this.settings?.streaming?.['streaming.enabled'];
    const preference = this.getStreamPreference();
    const value = typeof preference === 'boolean' ? preference : false;

    if (existing) {
      if (existing.pendingValue === undefined) {
        existing.value = value;
        existing.rawValue = value ? 'true' : 'false';
      }
      return existing;
    }

    return {
      value,
      rawValue: value ? 'true' : 'false',
      description: 'Use WebSocket streaming for quotes/positions/funds when available.',
      dataType: 'boolean',
      isSensitive: false,
    };
  }

  getStreamPreference() {
    if (typeof window === 'undefined') return false;
    if (!window.app || typeof window.app.getStreamPreference !== 'function') {
      return false;
    }
    return window.app.getStreamPreference();
  }

  /**
   * Render main tab navigation
   */
  renderMainTabNavigation() {
    const tabs = [
      { id: 'general', icon: '⚙️', label: 'General', description: 'Application configuration' },
      { id: 'access', icon: '🔐', label: 'Access Control', description: 'Roles and permissions', adminOnly: true },
      { id: 'data', icon: '📊', label: 'Data Management', description: 'Instruments and imports' },
      { id: 'status', icon: '🩺', label: 'System Status', description: 'Monitor and health' }
    ];

    return `
      <div class="settings-main-tabs">
        <div class="settings-main-tabs-header">
          <h2 class="text-2xl font-bold text-neutral-900">Settings</h2>
          <p class="text-sm text-neutral-600 mt-1">Manage your application configuration and preferences</p>
        </div>
        <div class="settings-main-tabs-nav">
          ${tabs.map(tab => {
      if (tab.adminOnly && !this.isAdmin()) return '';
      const isActive = this.activeMainTab === tab.id;
      return `
              <button
                class="settings-main-tab ${isActive ? 'active' : ''}"
                data-tab="${tab.id}"
                onclick="settings.switchMainTab('${tab.id}')"
              >
                <span class="settings-main-tab-icon">${tab.icon}</span>
                <div class="settings-main-tab-text">
                  <span class="settings-main-tab-label">${tab.label}</span>
                  <span class="settings-main-tab-description">${tab.description}</span>
                </div>
              </button>
            `;
    }).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render active tab content
   */
  async renderActiveTabContent(canViewAppSettings) {
    switch (this.activeMainTab) {
      case 'general':
        return this.renderGeneralTab(canViewAppSettings);
      case 'access':
        return this.renderAccessControlTab();
      case 'data':
        return await this.renderDataManagementTab();
      case 'status':
        return await this.renderSystemStatusTab();
      default:
        return this.renderGeneralTab(canViewAppSettings);
    }
  }

  /**
   * Switch main tab
   */
  switchMainTab(tabId) {
    this.activeMainTab = tabId;
    this.renderSettingsView();
  }

  /**
   * Initialize main tab listeners
   */
  initMainTabListeners() {
    // Tab switching is handled by onclick in the HTML
  }
  isAdmin() {
    return (this.currentUser?.role || '').toUpperCase() === 'ADMIN' || this.currentUser?.is_admin;
  }
  /**
   * Parse value based on data type
   */
  parseValue(value, dataType) {
    switch (dataType) {
      case 'number':
        return parseFloat(value);
      case 'boolean':
        return value === 'true';
      case 'json':
        try {
          return JSON.parse(value);
        } catch (e) {
          return value;
        }
      default:
        return value;
    }
  }

  /**
   * Get setting category from key
   */
  getSettingCategory(key) {
    // Infer category from key (e.g., 'server.port' -> 'server')
    return key.split('.')[0];
  }

  /**
   * Format category name for display
   */
  formatCategoryName(category) {
    const names = {
      'server': 'Server',
      'polling': 'Polling',
      'openalgo': 'OpenAlgo',
      'database': 'Database',
      'session': 'Session',
      'cors': 'CORS',
      'logging': 'Logging',
      'rate_limit': 'Rate Limiting',
      'rate_limits': 'Rate Limits',
      'oauth': 'OAuth',
      'test': 'Test Mode',
      'proxy': 'Proxy',
      'options': 'Options Trading',
      'market_data_feed': 'Market Data Feed',
      'instance_health': 'Instance Health',
      'instance_health_tests': 'Instance Health Tests',
      'market_hours': 'Market Hours',
      'trading': 'Trading Sessions',
      'streaming': 'Streaming',
      'system': 'System'
    };
    return names[category] || category.charAt(0).toUpperCase() + category.slice(1);
  }

  /**
   * Format setting name for display
   */
  formatSettingName(key) {
    const overrides = {
      'server.port': 'Server Port',
      'polling.instance_interval_ms': 'Instance Polling Interval (ms)',
      'openalgo.request_timeout_ms': 'OpenAlgo Request Timeout (ms)',
      'openalgo.critical.max_retries': 'OpenAlgo Critical Retry Count',
      'openalgo.critical.retry_delay_ms': 'OpenAlgo Critical Retry Delay (ms)',
      'openalgo.noncritical.max_retries': 'OpenAlgo Non-Critical Retry Count',
      'openalgo.noncritical.retry_delay_ms': 'OpenAlgo Non-Critical Retry Delay (ms)',
      'session.max_age_ms': 'Session Max Age (ms)',
      'rate_limit.window_ms': 'Rate Limit Window (ms)',
      'rate_limit.max_requests': 'Rate Limit Max Requests',
      'logging.level': 'Logging Level',
      'test_mode.enabled': 'Test Mode Enabled',
      'streaming.enabled': 'Live Streaming (WebSocket)',
      'brokerage.market_order_support': 'Market Order Support (by broker)',
    };

    if (overrides[key]) {
      return overrides[key];
    }

    return key.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  getSettingHelpText(key) {
    const help = {
      'polling.instance_interval_ms': 'Controls how often instance P&L is refreshed. Lower values increase load.',
      'streaming.enabled': 'Streams quotes/positions/funds via WebSocket when supported; stored per browser.',
      'polling.health_check_interval_ms': 'Interval for OpenAlgo endpoint capability/health checks.',
      'instance_health.ping_healthy_interval_ms': 'Ping cadence while instances are healthy.',
      'instance_health.ping_unhealthy_interval_ms': 'Ping cadence while unhealthy; stops after the max attempts.',
      'instance_health.ping_unhealthy_max_attempts': 'After this many failed pings, auto checks pause until manual refresh.',
      'instance_health.analyzer_check_interval_ms': 'How often analyzer mode health is verified.',
      'market_data_feed.quote_ttl_idle_ms': 'Fallback quote cache TTL when no open positions.',
      'market_data_feed.quote_ttl_active_ms': 'Fallback quote cache TTL when open positions exist.',
      'market_data_feed.position_interval_idle_ms': 'Positionbook refresh cadence when idle.',
      'market_data_feed.position_interval_active_ms': 'Positionbook refresh cadence when positions exist.',
      'market_data_feed.tradebook_interval_idle_ms': 'Tradebook refresh cadence when idle.',
      'market_data_feed.tradebook_interval_active_ms': 'Tradebook refresh cadence when positions exist.',
      'market_data_feed.orderbook_interval_ms': 'Orderbook refresh cadence.',
      'market_data_feed.multiquote_cooldown_idle_ms': 'Minimum delay between MultiQuotes calls when idle.',
      'market_data_feed.multiquote_cooldown_active_ms': 'Minimum delay between MultiQuotes calls when positions exist.',
      'market_data_feed.funds_interval_ms': 'Funds refresh cadence.',
      'market_data_feed.max_order_spread_pct': 'Maximum bid/ask spread (decimal) allowed for limit pricing.',
      'market_hours.quote_blackout_start': 'Quotes/MultiQuotes/OptionChain are blocked starting this time (IST).',
      'market_hours.quote_blackout_end': 'Quotes/MultiQuotes/OptionChain resume after this time (IST).',
      'market_hours.general_blackout_start': 'Other OpenAlgo endpoints are blocked starting this time (IST).',
      'market_hours.general_blackout_end': 'Other OpenAlgo endpoints resume after this time (IST).',
      'trading_sessions': 'Defines session windows in IST used for session P&L baselines and auto cutoffs.',
      'brokerage.market_order_support': 'When enabled for a broker, all orders will be sent as MARKET orders.',
    };

    return help[key] || '';
  }
}.prototype));

window.SettingsHandler = SettingsHandler;
