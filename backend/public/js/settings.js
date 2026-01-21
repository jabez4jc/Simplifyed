/**
 * Settings Handler
 * Handles settings view including application settings, Telegram linking, and monitor status
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
    this.allowedCategories = ['polling', 'market_data_feed', 'instance_health', 'instance_health_tests', 'market_hours', 'trading', 'brokerage', 'system'];
    this.allowedSettings = {
      polling: [
        'polling.instance_interval_ms',
        'polling.market_data_interval_ms',
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
      ],
      system: [
        'settings.cache_duration_ms',
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
      'system': {
        icon: '🧠',
        description: 'Runtime cache and internal configuration'
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

  /**
   * Render General tab (Application Settings)
   */
  renderGeneralTab(canViewAppSettings) {
    if (!canViewAppSettings) {
      return `
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">⚙️ Application Settings</h3>
          </div>
          <div class="p-6">
            <p class="text-neutral-600 text-sm">
              You don't have permission to view application settings. Contact an admin if you need access.
            </p>
          </div>
        </div>
      `;
    }

    return `
      <div class="space-y-4">
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">⚙️ Application Settings</h3>
          </div>
          <div class="p-6">
            ${this.renderApplicationSettings()}
          </div>
        </div>
      </div>
    `;
  }

  renderStreamingPreferenceCard() {
    const enabled = typeof window !== 'undefined' && window.app ? window.app.getStreamPreference() : false;
    const serverEnabled = typeof window !== 'undefined' && window.app ? window.app.wsGatewayEnabled : false;
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">📡 Live Streaming (beta)</h3>
          <p class="text-sm text-neutral-600 mt-1">
            Use WebSocket streaming for quotes/positions/funds when available. Falls back to polling automatically.
          </p>
        </div>
        <div class="p-6 flex items-center justify-between gap-4">
          <div>
            <p class="font-semibold">${enabled && serverEnabled ? 'Enabled' : 'Disabled'}</p>
            <p class="text-sm text-neutral-600">
              ${serverEnabled ? 'Session-authenticated stream; respects per-instance websocket capability.' : 'Server streaming disabled. Polling only.'}
            </p>
          </div>
          <button class="btn ${enabled ? 'btn-neutral' : 'btn-primary'}" onclick="app.toggleStreamPreference()">
            ${enabled ? 'Disable Streaming' : 'Enable Streaming'}
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Render Access Control tab (RBAC)
   */
  renderAccessControlTab() {
    if (!this.isAdmin()) {
      return `
        <div class="card">
          <div class="p-6">
            <p class="text-neutral-600 text-sm">
              You don't have permission to access this section. Admin access required.
            </p>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">🔐 Role & User Access</h3>
          <p class="text-sm text-neutral-600 mt-1">Assign role permissions and control user access.</p>
        </div>
        <div class="p-6" id="rbac-root">
          ${this.renderRbacSection()}
        </div>
      </div>
    `;
  }

  /**
   * Render Data Management tab (Instruments Cache + Import/Export)
   */
  async renderDataManagementTab() {
    return `
      <div class="space-y-6">
        <!-- Instruments Cache Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">📊 Instruments Cache</h3>
            <p class="text-sm text-neutral-600 mt-1">
              Manage broker instruments cache. Upload CSV file or refresh from broker API.
            </p>
          </div>
          <div class="p-6">
            ${await this.renderInstrumentsCacheSection()}
          </div>
        </div>

        ${this.isAdmin() ? `
        <!-- Instances Import / Export Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">🗂️ Instances Import / Export</h3>
            <p class="text-sm text-neutral-600 mt-1">
              Admin-only: export all instances to CSV or import/update from CSV (upsert by host_url).
            </p>
          </div>
          <div class="p-6 space-y-3">
            ${this.renderInstanceCsvSection()}
          </div>
        </div>

        <!-- Watchlists Import / Export Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">🗂️ Watchlists Import / Export</h3>
            <p class="text-sm text-neutral-600 mt-1">
              Admin-only: export all watchlists, symbols, and instance mappings, or import/update from CSV.
            </p>
          </div>
          <div class="p-6 space-y-3">
            ${this.renderWatchlistCsvSection()}
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render System Status tab (Monitor Status + Health Tests)
   */
  async renderSystemStatusTab() {
    return `
      <div class="space-y-6">
        <!-- Monitor Status Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">📊 Order Monitor Status</h3>
          </div>
          <div class="p-6">
            ${await this.renderMonitorStatusSection()}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render application settings section
   */
  renderApplicationSettings() {
    const activeMeta = this.categoryMeta[this.activeCategory] || { icon: '⚙️', description: '' };

    return `
      <div class="settings-container">
        <!-- Header with Search -->
        <div class="settings-header">
          <div class="settings-header-info">
            <p class="text-sm text-neutral-600">
              Configure application settings. Changes are saved when you click "Save Changes".
            </p>
          </div>
          <div class="settings-search-wrapper">
            <div class="settings-search">
              <svg class="settings-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
              </svg>
              <input
                type="text"
                class="settings-search-input"
                placeholder="Search settings..."
                id="settings-search"
                value="${this.searchQuery}"
                oninput="settings.handleSearch(this.value)"
              />
              ${this.searchQuery ? `
                <button class="settings-search-clear" onclick="settings.clearSearch()">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              ` : ''}
            </div>
          </div>
        </div>

        ${this.searchQuery ? this.renderSearchResults() : `
          <!-- Category Sidebar + Content Layout -->
          <div class="settings-layout">
            <!-- Category Sidebar -->
            <div class="settings-sidebar">
              <div class="settings-sidebar-header">
                <span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">Categories</span>
              </div>
              <nav class="settings-nav">
                ${this.displayCategories.map(cat => {
      const meta = this.categoryMeta[cat.category] || { icon: '⚙️', description: '' };
      return `
                    <button
                      class="settings-nav-item ${cat.category === this.activeCategory ? 'active' : ''}"
                      data-category="${cat.category}"
                      onclick="settings.switchCategory('${cat.category}')"
                    >
                      <span class="settings-nav-icon">${meta.icon}</span>
                      <span class="settings-nav-label">${this.formatCategoryName(cat.category)}</span>
                      <span class="settings-nav-count">${cat.count}</span>
                    </button>
                  `;
    }).join('')}
              </nav>
            </div>

            <!-- Settings Content -->
            <div class="settings-main">
              <!-- Category Header -->
              <div class="settings-category-header">
                <div class="settings-category-title">
                  <span class="settings-category-icon">${activeMeta.icon}</span>
                  <div>
                    <h3 class="text-lg font-semibold text-neutral-900">${this.formatCategoryName(this.activeCategory)}</h3>
                    <p class="text-sm text-neutral-600">${activeMeta.description}</p>
                  </div>
                </div>
              </div>

              <!-- Settings Form -->
              <div class="settings-content" id="settings-content">
                ${this.renderSettingsForm(this.activeCategory)}
              </div>
            </div>
          </div>
        `}

        <!-- Save Button -->
        <div class="settings-actions">
          <button
            class="btn btn-buy"
            onclick="settings.saveSettings()"
            ${this.isSaving ? 'disabled' : ''}
          >
            ${this.isSaving ? '💾 Saving...' : '💾 Save Changes'}
          </button>
          <button
            class="btn btn-neutral btn-outline"
            onclick="settings.resetSettings()"
            ${this.isSaving ? 'disabled' : ''}
          >
            🔄 Reset to Defaults
          </button>
        </div>
      </div>
    `;
  }

  renderInstanceHealthTests() {
    if (!this.isAdmin()) {
      return `
        <div class="settings-empty">
          <p class="text-neutral-500">Admin access required to edit instance health tests.</p>
        </div>
      `;
    }
    const cfg = this.instanceHealthTests || {};
    const quotes = cfg.quotes || [];
    const multiquotes = cfg.multiquotes || [];
    const optionchain = cfg.optionchain || [];

    const toTextarea = (arr) => JSON.stringify(arr, null, 2);

    return `
      <div class="grid gap-4 md:grid-cols-2">
        <div>
          <h4 class="font-semibold mb-2">Quotes Tests</h4>
          <p class="text-xs text-neutral-500 mb-2">Array of { symbol, exchange }</p>
          <textarea id="health-quotes" class="textarea textarea-bordered w-full h-32 font-mono text-xs">${toTextarea(quotes)}</textarea>
        </div>
        <div>
          <h4 class="font-semibold mb-2">MultiQuotes Tests</h4>
          <p class="text-xs text-neutral-500 mb-2">Array of { symbol, exchange }</p>
          <textarea id="health-multiquotes" class="textarea textarea-bordered w-full h-32 font-mono text-xs">${toTextarea(multiquotes)}</textarea>
        </div>
      </div>
      <div class="mt-4">
        <h4 class="font-semibold mb-2">Option Chain Tests</h4>
        <p class="text-xs text-neutral-500 mb-2">Array of { underlying, exchange, expiry_date, strike_count }</p>
        <textarea id="health-optionchain" class="textarea textarea-bordered w-full h-32 font-mono text-xs">${toTextarea(optionchain)}</textarea>
      </div>
      <div class="mt-4 flex gap-3">
        <button class="btn btn-buy" onclick="settings.saveInstanceHealthTests()">Save Tests</button>
        <button class="btn" onclick="settings.renderSettingsView()">Cancel</button>
      </div>
    `;
  }

  async saveInstanceHealthTests() {
    try {
      if (!this.canEditApplicationSettings()) {
        Utils.showToast('You do not have permission to edit settings.', 'error');
        return;
      }
      const quotesVal = document.getElementById('health-quotes').value;
      const multiVal = document.getElementById('health-multiquotes').value;
      const ocVal = document.getElementById('health-optionchain').value;
      const payload = {
        quotes: JSON.parse(quotesVal || '[]'),
        multiquotes: JSON.parse(multiVal || '[]'),
        optionchain: JSON.parse(ocVal || '[]'),
      };
      await api.updateInstanceHealthTests(payload);
      Utils.showToast('Instance health tests updated', 'success');
      await this.renderSettingsView();
    } catch (err) {
      console.error(err);
      Utils.showToast(`Failed to save tests: ${err.message}`, 'error');
    }
  }

  /**
   * Handle search input
   */
  handleSearch(query) {
    this.searchQuery = query.toLowerCase().trim();

    // Re-render the settings section
    const settingsContainer = document.querySelector('.settings-container');
    if (settingsContainer) {
      settingsContainer.innerHTML = this.renderApplicationSettings().replace(/<div class="settings-container">/, '').replace(/<\/div>\s*$/, '');
      // Actually need to re-render properly
    }

    // Just update the content area
    this.refreshApplicationSettings();
  }

  /**
   * Clear search
   */
  clearSearch() {
    this.searchQuery = '';
    this.refreshApplicationSettings();
  }

  /**
   * Refresh application settings display
   */
  refreshApplicationSettings() {
    const card = document.querySelector('.card .p-6');
    if (card) {
      card.innerHTML = this.renderApplicationSettings();
      this.initCategoryTabs();
    }
  }

  /**
   * Render search results
   */
  renderSearchResults() {
    const results = [];

    Object.entries(this.displaySettings).forEach(([category, categorySettings]) => {
      Object.entries(categorySettings).forEach(([key, setting]) => {
        const settingName = this.formatSettingName(key).toLowerCase();
        const description = (setting.description || '').toLowerCase();
        const keyLower = key.toLowerCase();

        if (settingName.includes(this.searchQuery) ||
          description.includes(this.searchQuery) ||
          keyLower.includes(this.searchQuery)) {
          results.push({
            key,
            category,
            setting,
            name: this.formatSettingName(key),
            categoryName: this.formatCategoryName(category)
          });
        }
      });
    });

    if (results.length === 0) {
      return `
        <div class="settings-search-empty">
          <div class="settings-search-empty-icon">🔍</div>
          <p class="text-neutral-600">No settings found matching "<strong>${Utils.escapeHTML(this.searchQuery)}</strong>"</p>
          <button class="btn btn-neutral btn-outline btn-sm mt-3" onclick="settings.clearSearch()">Clear Search</button>
        </div>
      `;
    }

    return `
      <div class="settings-search-results">
        <div class="settings-search-results-header">
          <span class="text-sm text-neutral-600">Found ${results.length} setting${results.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="settings-content">
          ${results.map(result => {
      const inputId = `setting-${result.key.replace(/\./g, '-')}`;
      const inputValue = result.setting.pendingValue ?? result.setting.rawValue ?? result.setting.value;
      const meta = this.categoryMeta[result.category] || { icon: '⚙️' };
      const helpText = this.getSettingHelpText(result.key);

      return `
              <div class="settings-field settings-field-search">
                <label for="${inputId}" class="settings-field-label">
                  <div class="settings-field-title">
                    <span class="font-medium">${result.name}</span>
                    ${result.setting.isSensitive ? '<span class="settings-sensitive-badge">Sensitive</span>' : ''}
                  </div>
                  <span class="settings-field-category">
                    <span>${meta.icon}</span>
                    <span>${result.categoryName}</span>
                  </span>
                  ${result.setting.description ? `<span class="text-sm text-neutral-500 block mt-1">${result.setting.description}</span>` : ''}
                  ${helpText ? `<span class="text-xs text-neutral-500 block mt-1">${helpText}</span>` : ''}
                </label>
                <div class="settings-field-input">
                  ${this.renderInputField(inputId, result.key, result.setting.dataType, inputValue, result.setting.isSensitive)}
                </div>
              </div>
            `;
    }).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render settings form for a category
   */
  renderSettingsForm(category) {
    if (category === 'instance_health_tests') {
      return this.renderInstanceHealthTests();
    }
    if (category === 'market_hours') {
      return this.renderMarketHoursForm();
    }
    const categorySettings = this.displaySettings[category] || {};

    const inputs = Object.entries(categorySettings).map(([key, setting]) => {
      const inputId = `setting-${key.replace(/\./g, '-')}`;
      const isSensitive = setting.isSensitive;
      const inputValue = setting.pendingValue ?? setting.rawValue ?? setting.value;
      const helpText = this.getSettingHelpText(key);

      return `
        <div class="settings-field ${isSensitive ? 'settings-field-sensitive' : ''}">
          <label for="${inputId}" class="settings-field-label">
            <div class="settings-field-title">
              <span class="font-medium text-neutral-800">${this.formatSettingName(key)}</span>
              ${isSensitive ? '<span class="settings-sensitive-badge">🔒 Sensitive</span>' : ''}
            </div>
            ${setting.description ? `<span class="text-sm text-neutral-500 block mt-1">${setting.description}</span>` : ''}
            ${helpText ? `<span class="text-xs text-neutral-500 block mt-1">${helpText}</span>` : ''}
            <span class="settings-field-key">${key}</span>
          </label>
          <div class="settings-field-input">
            ${this.renderInputField(inputId, key, setting.dataType, inputValue, isSensitive)}
          </div>
        </div>
      `;
    }).join('');

    if (Object.keys(categorySettings).length === 0) {
      return `
        <div class="settings-empty">
          <p class="text-neutral-500">No settings available in this category.</p>
        </div>
      `;
    }

    return `<div class="settings-fields">${inputs}</div>`;
  }

  renderMarketHoursForm() {
    const categorySettings = this.displaySettings.market_hours || {};
    const resolveSetting = (key) => categorySettings[key] || {};
    const resolveValue = (setting) => setting.pendingValue ?? setting.rawValue ?? setting.value ?? '';

    const renderRow = (label, startKey, endKey) => {
      const startSetting = resolveSetting(startKey);
      const endSetting = resolveSetting(endKey);
      const startId = `setting-${startKey.replace(/\./g, '-')}`;
      const endId = `setting-${endKey.replace(/\./g, '-')}`;
      const startValue = resolveValue(startSetting);
      const endValue = resolveValue(endSetting);
      const startHelp = this.getSettingHelpText(startKey);
      const endHelp = this.getSettingHelpText(endKey);

      return `
        <div class="settings-field settings-field-row market-hours">
          <label class="settings-field-label" for="${startId}">
            <div class="settings-field-title">
              <span class="font-medium text-neutral-800">${label}</span>
            </div>
            ${startHelp ? `<span class="text-xs text-neutral-500">Start: ${startHelp}</span>` : ''}
            ${endHelp ? `<span class="text-xs text-neutral-500">End: ${endHelp}</span>` : ''}
            <span class="settings-field-key">${startKey} → ${endKey}</span>
          </label>
          <div class="settings-field-input settings-field-inline">
            <div class="settings-time-pair">
              <div class="settings-time-item">
                <label class="settings-time-label" for="${startId}">Start</label>
                ${this.renderInputField(startId, startKey, startSetting.dataType, startValue, startSetting.isSensitive)}
              </div>
              <div class="settings-time-item">
                <label class="settings-time-label" for="${endId}">End</label>
                ${this.renderInputField(endId, endKey, endSetting.dataType, endValue, endSetting.isSensitive)}
              </div>
            </div>
          </div>
        </div>
      `;
    };

    const rows = [
      renderRow(
        'Quotes blackout (IST)',
        'market_hours.quote_blackout_start',
        'market_hours.quote_blackout_end'
      ),
      renderRow(
        'General blackout (IST)',
        'market_hours.general_blackout_start',
        'market_hours.general_blackout_end'
      ),
    ].join('');

    return `<div class="settings-fields">${rows}</div>`;
  }

  /**
   * Render input field based on data type
   */
  renderInputField(id, key, dataType, value, isSensitive) {
    const baseProps = `id="${id}" name="${key}" data-key="${key}" data-type="${dataType}" ${isSensitive ? 'data-sensitive="true"' : ''}`;

    if (key === 'trading_sessions') {
      return this.renderTradingSessionsField(key, value);
    }
    if (key === 'brokerage.by_broker') {
      return this.renderBrokerageTable(key, value);
    }

    switch (dataType) {
      case 'boolean':
        const isChecked = value === 'true' || value === true;
        return `
          <label class="settings-toggle">
            <input type="checkbox" ${baseProps} class="settings-toggle-input" ${isChecked ? 'checked' : ''} />
            <span class="settings-toggle-track">
              <span class="settings-toggle-thumb"></span>
            </span>
            <span class="settings-toggle-label">${isChecked ? 'Enabled' : 'Disabled'}</span>
          </label>
        `;

      case 'number':
        return `
          <div class="settings-input-wrapper">
            <input type="number" ${baseProps} class="form-input settings-number-input" value="${value}" />
            ${this.getUnitSuffix(key) ? `<span class="settings-input-suffix">${this.getUnitSuffix(key)}</span>` : ''}
          </div>
        `;

      default:
        const inputType = isSensitive ? 'password' : 'text';
        return `
          <div class="settings-input-wrapper">
            <input type="${inputType}" ${baseProps} class="form-input" value="${Utils.escapeHTML(String(value))}" ${isSensitive ? 'autocomplete="off"' : ''} />
            ${isSensitive ? `
              <button type="button" class="settings-toggle-visibility" onclick="settings.togglePasswordVisibility('${id}')">
                <svg class="eye-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
                  <path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
                </svg>
              </button>
            ` : ''}
          </div>
        `;
    }
  }

  /**
   * Get unit suffix for number fields
   */
  getUnitSuffix(key) {
    if (key.includes('_ms') || key.endsWith('_ms')) return 'ms';
    if (key.includes('port')) return '';
    if (key.includes('retries') || key.includes('max_')) return '';
    if (key.includes('_ttl')) return 'ms';
    return '';
  }

  /**
   * Toggle password visibility
   */
  togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
    }
  }

  renderTradingSessionsField(key, value) {
    let sessions = [];
    try {
      sessions = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(sessions)) {
        sessions = [];
      }
    } catch (e) {
      sessions = [];
    }
    if (sessions.length === 0) {
      sessions = [
        { label: 'Session 1', start: '09:00', end: '11:30' },
        { label: 'Session 2', start: '12:30', end: '15:10' },
        { label: 'Session 3', start: '15:45', end: '19:00' },
        { label: 'Session 4', start: '20:30', end: '22:45' },
      ];
    }

    const rows = sessions.map((s, idx) => `
      <div class="trading-session-row flex flex-wrap items-center gap-3" data-index="${idx}">
        <div class="w-24 text-sm font-semibold text-neutral-600">Session ${idx + 1}</div>
        <div class="flex items-center gap-2 flex-1 min-w-[220px]">
          <input type="time" class="form-input trading-session-input" data-key="${key}" data-index="${idx}" data-field="start" value="${Utils.escapeHTML(s.start || '')}">
          <span class="text-neutral-500 text-sm">to</span>
          <input type="time" class="form-input trading-session-input" data-key="${key}" data-index="${idx}" data-field="end" value="${Utils.escapeHTML(s.end || '')}">
        </div>
      </div>
    `).join('');

    return `
      <div class="space-y-3" data-session-key="${key}">
        ${rows}
        <small class="text-neutral-500 block">Configure up to 4 session windows in IST. These control auto cutoffs.</small>
      </div>
    `;
  }

  renderBrokerageTable(key, value) {
    let brokers = {};
    try {
      brokers = typeof value === 'string' ? JSON.parse(value) : value;
      if (!brokers || typeof brokers !== 'object') brokers = {};
    } catch (e) {
      brokers = {};
    }

    const rows = Object.entries(brokers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([broker, rate]) => `
        <tr>
          <td class="text-sm font-medium">${Utils.escapeHTML(broker)}</td>
          <td>
            <input
              type="number"
              class="form-input settings-number-input"
              data-key="${key}"
              data-type="json"
              data-broker="${Utils.escapeHTML(broker)}"
              value="${rate}"
              oninput="settings.handleBrokerageChange(this)"
            />
          </td>
        </tr>
      `)
      .join('');

    return `
      <div class="settings-brokerage-table">
        <div class="flex flex-wrap gap-2 items-end mb-3">
          <div class="flex-1 min-w-[180px]">
            <label class="form-label text-xs mb-1">Broker key</label>
            <input type="text" class="form-input" id="brokerage-new-key" placeholder="e.g. fivepaisa">
          </div>
          <div class="w-[160px]">
            <label class="form-label text-xs mb-1">Brokerage</label>
            <input type="number" class="form-input" id="brokerage-new-rate" placeholder="20">
          </div>
          <button type="button" class="btn btn-neutral btn-outline btn-sm" onclick="settings.addBrokerageEntry()">
            Add Broker
          </button>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Broker</th>
              <th>Brokerage (per trade)</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="2" class="text-neutral-500">No brokers configured.</td></tr>'}
          </tbody>
        </table>
        <div class="text-xs text-neutral-500 mt-2">
          Add new brokers by editing JSON in this setting via the API if needed.
        </div>
      </div>
    `;
  }

  /**
   * Initialize category tabs
   */
  initCategoryTabs() {
    // Add change event listeners to all inputs
    const inputs = document.querySelectorAll('#settings-content input, #settings-content select, .settings-search-results input');
    inputs.forEach(input => {
      input.addEventListener('change', (e) => {
        this.handleSettingChange(e.target);
      });
    });

    // Handle toggle label updates for boolean switches
    const toggleInputs = document.querySelectorAll('.settings-toggle-input');
    toggleInputs.forEach(input => {
      input.addEventListener('change', (e) => {
        const label = e.target.closest('.settings-toggle').querySelector('.settings-toggle-label');
        if (label) {
          label.textContent = e.target.checked ? 'Enabled' : 'Disabled';
        }
      });
    });

    // Trading session inputs
    const sessionInputs = document.querySelectorAll('.trading-session-input');
    sessionInputs.forEach(input => {
      input.addEventListener('change', (e) => {
        this.handleTradingSessionChange(e.target);
      });
    });
  }

  /**
   * Switch category tab
   */
  switchCategory(category) {
    this.activeCategory = category;

    // Update active tab
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.classList.remove('active');
    });
    document.querySelector(`[data-category="${category}"]`).classList.add('active');

    const meta = this.categoryMeta[category] || { icon: '⚙️', description: '' };
    const headerTitle = document.querySelector('.settings-category-title h3');
    const headerDesc = document.querySelector('.settings-category-title p');
    const headerIcon = document.querySelector('.settings-category-icon');
    if (headerTitle) {
      headerTitle.textContent = this.formatCategoryName(category);
    }
    if (headerDesc) {
      headerDesc.textContent = meta.description || '';
    }
    if (headerIcon) {
      headerIcon.textContent = meta.icon || '⚙️';
    }

    // Update content
    document.getElementById('settings-content').innerHTML = this.renderSettingsForm(category);

    // Re-initialize event listeners
    this.initCategoryTabs();
  }

  /**
   * Handle setting change
   */
  handleSettingChange(input) {
    const key = input.dataset.key;
    const dataType = input.dataset.type;
    const category = this.getSettingCategory(key);

    // Update the settings object
    if (!this.settings[category]) {
      this.settings[category] = {};
    }

    if (!this.settings[category][key]) {
      this.settings[category][key] = { dataType, isSensitive: false };
    }

    // Handle checkbox (boolean) values
    let value;
    if (input.type === 'checkbox') {
      value = input.checked ? 'true' : 'false';
    } else {
      value = input.value;
    }

    this.settings[category][key].pendingValue = value;

    // console.log(`[Settings] Setting changed: ${key} = ${value}`);
  }

  handleTradingSessionChange(input) {
    const key = input.dataset.key;
    const idx = parseInt(input.dataset.index, 10);
    const field = input.dataset.field;
    const category = this.getSettingCategory(key);
    const setting = this.settings[category]?.[key] || {};

    let sessions = [];
    try {
      const source = setting.pendingValue ?? setting.rawValue ?? setting.value;
      sessions = typeof source === 'string' ? JSON.parse(source) : source;
      if (!Array.isArray(sessions)) sessions = [];
    } catch (e) {
      sessions = [];
    }
    while (sessions.length <= idx) {
      sessions.push({ label: `Session ${sessions.length + 1}`, start: '', end: '' });
    }
    sessions[idx] = {
      ...sessions[idx],
      [field]: input.value,
    };

    if (!this.settings[category]) {
      this.settings[category] = {};
    }
    if (!this.settings[category][key]) {
      this.settings[category][key] = { dataType: 'json', isSensitive: false };
    }
    this.settings[category][key].pendingValue = JSON.stringify(sessions);
    // console.log('[Settings] trading_sessions updated', sessions);
  }

  handleBrokerageChange(input) {
    const key = input.dataset.key;
    const broker = input.dataset.broker || '';
    const category = this.getSettingCategory(key);
    const setting = this.settings[category]?.[key] || {};
    let brokers = {};
    try {
      const source = setting.pendingValue ?? setting.rawValue ?? setting.value;
      brokers = typeof source === 'string' ? JSON.parse(source) : source;
      if (!brokers || typeof brokers !== 'object') brokers = {};
    } catch (e) {
      brokers = {};
    }

    const parsed = input.value === '' ? null : Number(input.value);
    if (broker) {
      if (Number.isFinite(parsed)) {
        brokers[broker] = parsed;
      }
    }

    if (!this.settings[category]) {
      this.settings[category] = {};
    }
    if (!this.settings[category][key]) {
      this.settings[category][key] = { dataType: 'json', isSensitive: false };
    }
    this.settings[category][key].pendingValue = JSON.stringify(brokers);
  }

  addBrokerageEntry() {
    const key = 'brokerage.by_broker';
    const category = this.getSettingCategory(key);
    const nameInput = document.getElementById('brokerage-new-key');
    const rateInput = document.getElementById('brokerage-new-rate');
    if (!nameInput || !rateInput) return;

    const rawName = nameInput.value.trim();
    const rawRate = rateInput.value.trim();
    if (!rawName) {
      Utils.showToast('Broker key is required', 'error');
      return;
    }
    const parsedRate = Number(rawRate);
    if (!Number.isFinite(parsedRate)) {
      Utils.showToast('Brokerage must be a number', 'error');
      return;
    }

    let brokers = {};
    const setting = this.settings[category]?.[key] || {};
    try {
      const source = setting.pendingValue ?? setting.rawValue ?? setting.value;
      brokers = typeof source === 'string' ? JSON.parse(source) : source;
      if (!brokers || typeof brokers !== 'object') brokers = {};
    } catch (e) {
      brokers = {};
    }

    const normalizedKey = rawName
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '');

    if (!normalizedKey) {
      Utils.showToast('Broker key must contain letters or numbers', 'error');
      return;
    }

    brokers[normalizedKey] = parsedRate;

    if (!this.settings[category]) {
      this.settings[category] = {};
    }
    if (!this.settings[category][key]) {
      this.settings[category][key] = { dataType: 'json', isSensitive: false };
    }
    this.settings[category][key].pendingValue = JSON.stringify(brokers);

    nameInput.value = '';
    rateInput.value = '';
    this.refreshApplicationSettings();
    Utils.showToast(`Added broker ${normalizedKey}`, 'success');
  }

  /**
   * Save settings
   */
  async saveSettings() {
    if (!this.canEditApplicationSettings()) {
      Utils.showToast('You do not have permission to edit settings.', 'error');
      return;
    }

    if (this.isSaving) return;

    this.isSaving = true;
    this.updateSaveButton();

    try {
      // Collect all changed settings
      const settingsToUpdate = {};

      Object.entries(this.settings).forEach(([category, categorySettings]) => {
        Object.entries(categorySettings).forEach(([key, setting]) => {
          if (setting.pendingValue !== undefined && setting.pendingValue !== (setting.rawValue || setting.value)) {
            settingsToUpdate[key] = this.parseValue(setting.pendingValue, setting.dataType);
          }
        });
      });

      let streamingChange = null;
      if (Object.prototype.hasOwnProperty.call(settingsToUpdate, 'streaming.enabled')) {
        streamingChange = settingsToUpdate['streaming.enabled'];
        delete settingsToUpdate['streaming.enabled'];
      }

      if (Object.keys(settingsToUpdate).length === 0 && streamingChange === null) {
        Utils.showToast('No changes to save', 'info');
        return;
      }

      if (Object.keys(settingsToUpdate).length > 0) {
        // Send update request
        const response = await this.authFetch('/api/v1/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(settingsToUpdate),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Failed to update settings');
        }

        // Show success message
        const summary = data.data.summary;
        Utils.showToast(
          `Successfully updated ${summary.successful} of ${summary.total} settings`,
          'success'
        );

        // Log errors if any
        if (data.data.errors && data.data.errors.length > 0) {
          console.error('[Settings] Some settings failed to update:', data.data.errors);
        }

        // Refresh the view to get updated values
        await this.refreshSettings();

        if (window.app && typeof window.app.loadPublicConfig === 'function') {
          await window.app.loadPublicConfig();
        }
      }

      if (streamingChange !== null) {
        this.applyStreamingPreference(Boolean(streamingChange));
        Utils.showToast('Streaming preference updated', 'success');
      }
    } catch (error) {
      console.error('[Settings] Error saving settings:', error);
      Utils.showToast(`Failed to save settings: ${error.message}`, 'error');
    } finally {
      this.isSaving = false;
      this.updateSaveButton();
    }
  }

  applyStreamingPreference(enabled) {
    if (typeof window === 'undefined' || !window.app) {
      return;
    }

    const current = typeof window.app.getStreamPreference === 'function'
      ? window.app.getStreamPreference()
      : false;
    if (enabled === current) {
      this.applySettingsFilter();
      return;
    }

    if (enabled) {
      window.app.useWsGateway = true;
      if (typeof window.app.saveWsPreference === 'function') {
        window.app.saveWsPreference(true);
      }
      if (typeof window.app.startWsStream === 'function') {
        window.app.startWsStream();
      }
    } else if (typeof window.app.stopWsStream === 'function') {
      window.app.stopWsStream('user');
    } else if (typeof window.app.saveWsPreference === 'function') {
      window.app.saveWsPreference(false);
    }

    if (this.settings?.streaming?.['streaming.enabled']) {
      this.settings.streaming['streaming.enabled'].value = enabled;
      this.settings.streaming['streaming.enabled'].rawValue = enabled ? 'true' : 'false';
      delete this.settings.streaming['streaming.enabled'].pendingValue;
    }
    this.applySettingsFilter();
  }

  /**
   * Reset settings to defaults
   */
  async resetSettings() {
    if (!this.canEditApplicationSettings()) {
      Utils.showToast('You do not have permission to edit settings.', 'error');
      return;
    }

    if (this.activeCategory === 'streaming') {
      this.applyStreamingPreference(false);
      Utils.showToast('Streaming preference reset', 'success');
      await this.refreshSettings();
      return;
    }

    if (!confirm('Are you sure you want to reset all settings to their default values? This action cannot be undone.')) {
      return;
    }

    try {
      const resetKeys = Object.keys(this.settings[this.activeCategory] || {});

      for (const key of resetKeys) {
        await this.authFetch(`/api/v1/settings/${key}/reset`, { method: 'POST' });
      }

      Utils.showToast('Settings reset to defaults', 'success');
      await this.refreshSettings();
    } catch (error) {
      console.error('[Settings] Error resetting settings:', error);
      Utils.showToast(`Failed to reset settings: ${error.message}`, 'error');
    }
  }

  /**
   * Update save button state
   */
  updateSaveButton() {
    const btn = document.querySelector('[onclick="settings.saveSettings()"]');
    if (btn) {
      btn.textContent = this.isSaving ? '💾 Saving...' : '💾 Save Changes';
      btn.disabled = this.isSaving || !this.canEditApplicationSettings();
    }
  }

  /**
   * Refresh settings data
   */
  async refreshSettings() {
    if (!this.canViewApplicationSettings()) {
      return;
    }

    this.categories = await this.fetchCategories();
    this.settings = await this.fetchAllSettings();
    this.applySettingsFilter();

    // Re-render the current category
    document.getElementById('settings-content').innerHTML = this.renderSettingsForm(this.activeCategory);
    this.initCategoryTabs();
  }

  /**
   * Fetch all settings
   */
  async fetchAllSettings() {
    try {
      const response = await this.authFetch('/api/v1/settings');
      if (!response.ok) throw new Error('Failed to fetch settings');
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('[Settings] Error fetching settings:', error);
      throw error;
    }
  }

  /**
   * Fetch categories
   */
  async fetchCategories() {
    try {
      const response = await this.authFetch('/api/v1/settings/categories');
      if (!response.ok) throw new Error('Failed to fetch categories');
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('[Settings] Error fetching categories:', error);
      return [];
    }
  }

  async fetchCurrentUser() {
    const res = await this.authFetch('/api/user');
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data || null;
  }

  isAdmin() {
    return (this.currentUser?.role || '').toUpperCase() === 'ADMIN' || this.currentUser?.is_admin;
  }

  async fetchRbacData() {
    try {
      const [rolesRes, usersRes, permsRes] = await Promise.all([
        this.authFetch('/api/v1/rbac/roles'),
        this.authFetch('/api/v1/rbac/users'),
        this.authFetch('/api/v1/rbac/permissions'),
      ]);
      const rolesJson = await rolesRes.json();
      const usersJson = await usersRes.json();
      const permsJson = await permsRes.json();
      this.roles = rolesJson?.data || [];
      this.users = usersJson?.data || [];
      this.permissions = permsJson?.data || [];
    } catch (e) {
      console.error('Failed to load RBAC data', e);
    }
  }

  renderRbacSection() {
    if (!this.roles || !this.users) {
      return '<p class="text-sm text-neutral-600">Loading...</p>';
    }
    if (!this.activeRoleTab && this.roles.length > 0) {
      this.activeRoleTab = this.roles[0].name;
    }
    const roleOptions = this.roles.map(r => `<option value="${r.name}" ${r.name === this.activeRoleTab ? 'selected' : ''}>${r.name}</option>`).join('');
    const activeRolePanel = this.renderRolePermissionsPanel(this.activeRoleTab);

    return `
      <div class="space-y-3">
        <div class="grid lg:grid-cols-3 gap-3">
          <div class="lg:col-span-2 card border border-base-200 bg-base-100">
            <div class="card-header flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <h4 class="font-semibold">Role Permissions</h4>
                <p class="text-xs text-neutral-500">Select a role and adjust permissions.</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <div class="flex items-center gap-2 bg-base-200 rounded-full px-2 py-1 rbac-pill-row">
                  <span class="text-[11px] uppercase tracking-wide text-neutral-500">Role</span>
                  <select class="select select-xs border-0 bg-transparent focus:outline-none rbac-role-select-pill" onchange="settings.switchRoleTab(this.value)">
                    ${roleOptions}
                  </select>
                </div>
                <label class="flex items-center gap-2 bg-base-200 rounded-full px-2 py-1 rbac-pill-row">
                  <span class="text-[11px] uppercase tracking-wide text-neutral-500">Filter</span>
                  <input
                    type="text"
                    class="input input-xs border-0 bg-transparent focus:outline-none w-36 rbac-filter-pill"
                    placeholder="permissions"
                    value="${Utils.escapeHTML(this.permissionFilter || '')}"
                    oninput="settings.handlePermissionFilter(this.value)"
                  />
                </label>
              </div>
            </div>
            <div class="p-3" id="rbac-role-panel">
              ${activeRolePanel}
            </div>
          </div>
          <div class="lg:col-span-1 card border border-base-200 bg-base-100">
            <div class="card-header py-3">
              <h4 class="font-semibold">Users & Roles</h4>
              <p class="text-xs text-neutral-500">Assign access by role.</p>
            </div>
            <div class="p-3">
              ${this.renderUserAssignments()}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderUserAssignments() {
    const roleFilterOptions = ['all', ...this.roles.map(r => r.name)];
    const roleFilterHtml = roleFilterOptions.map((role) => `
      <option value="${role}" ${role === this.userRoleFilter ? 'selected' : ''}>${role === 'all' ? 'All roles' : role}</option>
    `).join('');

    const filteredUsers = this.users.filter((u) => {
      const email = (u.email || '').toLowerCase();
      const role = (u.role || '').toLowerCase();
      const filter = (this.userFilter || '').toLowerCase();
      const roleFilter = this.userRoleFilter;
      const matchesRole = roleFilter === 'all' || role === roleFilter.toLowerCase();
      const matchesSearch = !filter || email.includes(filter) || role.includes(filter);
      return matchesRole && matchesSearch;
    });

    const rows = filteredUsers.map(u => {
      const options = this.roles.map(r => `<option value="${r.name}" ${r.name === u.role ? 'selected' : ''}>${r.name}</option>`).join('');
      return `
        <tr>
          <td class="py-2 px-2">${Utils.escapeHTML(u.email)}</td>
          <td class="py-2 px-2">${Utils.escapeHTML(u.role || '—')}</td>
          <td class="py-2 px-2">
            <select data-user-id="${u.id}" class="select select-sm rbac-role-select">
              ${options}
            </select>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="space-y-2">
        <div class="grid grid-cols-1 gap-2">
          <input
            type="text"
            class="input input-bordered input-xs"
            placeholder="Search users"
            value="${Utils.escapeHTML(this.userFilter || '')}"
            oninput="settings.handleUserFilter(this.value)"
          />
          <select class="select select-xs" onchange="settings.handleUserRoleFilter(this.value)">
            ${roleFilterHtml}
          </select>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Email</th>
                <th>Current Role</th>
                <th>Assign Role</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="3" class="text-center text-neutral-500">No users found.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  renderRolePermissionsPanel(roleName) {
    const role = this.roles.find(r => r.name === roleName);
    if (!role) {
      return '<p class="text-sm text-neutral-600">Select a role to manage permissions.</p>';
    }
    const currentPerms = new Set(role.permissions || []);
    const filter = (this.permissionFilter || '').toLowerCase();
    const permissions = this.permissions.filter(p => !filter || p.key.toLowerCase().includes(filter));
    const grouped = permissions.reduce((acc, perm) => {
      const group = perm.key.split('.')[0];
      acc[group] = acc[group] || [];
      acc[group].push(perm);
      return acc;
    }, {});

    const groupLabels = {
      pages: 'Pages',
      orders: 'Orders',
      positions: 'Positions',
      watchlists: 'Watchlists',
      instances: 'Instances',
      settings: 'Settings',
      rbac: 'RBAC',
      marketdata: 'Market Data',
      monitor: 'Monitoring',
    };

    const allPerms = role.permissions || [];
    const viewCount = allPerms.filter((p) => p.endsWith('.view')).length;
    const editCount = allPerms.filter((p) => p.endsWith('.edit') || p.endsWith('.manage') || p.endsWith('.place') || p.endsWith('.cancel')).length;

    const groupBlocks = Object.keys(grouped).sort().map((group) => {
      const label = groupLabels[group] || group.toUpperCase();
      const checks = grouped[group].map(p => {
        const checked = currentPerms.has(p.key);
        const pillClass = checked ? 'btn-primary' : 'btn-outline';
        return `
        <label class="btn btn-xs ${pillClass} rounded-full rbac-pill px-2">
          <input type="checkbox" class="rbac-perm-checkbox hidden"
            data-role="${role.name}" data-perm="${p.key}"
            ${checked ? 'checked' : ''}>
          <span class="text-xs">${Utils.escapeHTML(p.key)}</span>
        </label>
        `;
      }).join('');
      const checkedCount = grouped[group].filter(p => currentPerms.has(p.key)).length;
      return `
        <details class="border rounded-lg rbac-group">
          <summary class="cursor-pointer select-none flex items-center justify-between gap-2 px-2 py-2 text-xs rbac-accordion-strip">
            <span class="font-semibold">${Utils.escapeHTML(label)}</span>
            <span class="text-xs text-neutral-500">${checkedCount}/${grouped[group].length}</span>
          </summary>
          <div class="px-2 pb-2">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-1">
              ${checks}
            </div>
          </div>
        </details>
      `;
    }).join('');

    return `
      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="font-semibold text-base">${Utils.escapeHTML(role.name)}</div>
            <div class="text-xs text-neutral-500">Total: ${allPerms.length} · View: ${viewCount} · Edit: ${editCount}</div>
          </div>
          <div class="flex gap-1 flex-wrap">
            <button class="btn btn-xs btn-outline" onclick="settings.togglePermissionGroups(true)">Expand all</button>
            <button class="btn btn-xs btn-outline" onclick="settings.togglePermissionGroups(false)">Collapse all</button>
            <button class="btn btn-xs btn-primary rbac-save-perms" data-role="${role.name}">Save</button>
          </div>
        </div>
        <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3 max-h-[24rem] overflow-auto">
          ${groupBlocks || '<p class="text-sm text-neutral-500">No permissions match the filter.</p>'}
        </div>
      </div>
    `;
  }

  handlePermissionFilter(value) {
    this.permissionFilter = value || '';
    this.refreshRbacSection();
  }

  handleUserFilter(value) {
    this.userFilter = value || '';
    this.refreshRbacSection();
  }

  handleUserRoleFilter(value) {
    this.userRoleFilter = value || 'all';
    this.refreshRbacSection();
  }

  toggleRolePermissions(roleName, enabled) {
    const checks = document.querySelectorAll(`.rbac-perm-checkbox[data-role="${roleName}"]`);
    checks.forEach((checkbox) => {
      checkbox.checked = enabled;
      const pill = checkbox.closest('.rbac-pill');
      if (pill) {
        pill.classList.toggle('btn-primary', enabled);
        pill.classList.toggle('btn-outline', !enabled);
      }
    });
  }

  togglePermissionGroups(expand) {
    const groups = document.querySelectorAll('#rbac-role-panel details');
    groups.forEach((group) => {
      if (expand) {
        group.setAttribute('open', '');
      } else {
        group.removeAttribute('open');
      }
    });
  }

  refreshRbacSection() {
    const root = document.getElementById('rbac-root');
    if (!root) return;
    root.innerHTML = this.renderRbacSection();
    this.initRbacListeners();
  }

  switchRoleTab(roleName) {
    this.activeRoleTab = roleName;
    const panel = document.getElementById('rbac-role-panel');
    if (panel) {
      panel.innerHTML = this.renderRolePermissionsPanel(roleName);
    }
    document.querySelectorAll('.rbac-role-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-role') === roleName);
    });
    this.initRbacListeners();
  }

  initRbacListeners() {
    document.querySelectorAll('.rbac-role-select').forEach((select) => {
      select.addEventListener('change', async (e) => {
        const userId = e.target.getAttribute('data-user-id');
        const role = e.target.value;
        try {
          const res = await this.authFetch(`/api/v1/rbac/users/${userId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role }),
          });
          if (!res.ok) {
            throw new Error('Failed to assign role');
          }
        } catch (err) {
          alert('Failed to assign role: ' + err.message);
          console.error(err);
        }
      });
    });

    document.querySelectorAll('.rbac-perm-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const pill = checkbox.closest('.rbac-pill');
        if (!pill) return;
        pill.classList.toggle('btn-primary', checkbox.checked);
        pill.classList.toggle('btn-outline', !checkbox.checked);
      });
    });

    document.querySelectorAll('.rbac-save-perms').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const role = btn.getAttribute('data-role');
        const checks = document.querySelectorAll(`.rbac-perm-checkbox[data-role="${role}"]`);
        const selected = Array.from(checks)
          .filter(c => c.checked)
          .map(c => c.getAttribute('data-perm'));
        try {
          const res = await this.authFetch(`/api/v1/rbac/roles/${encodeURIComponent(role)}/permissions`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permissions: selected }),
          });
          if (!res.ok) throw new Error('Failed to update permissions');
          this.fetchRbacData(); // refresh silently
          Utils.showToast(`Permissions updated for ${role}`, 'success');
        } catch (err) {
          alert('Failed to update permissions: ' + err.message);
          console.error(err);
        }
      });
    });
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
      'polling.market_data_interval_ms': 'Market Data Poll Interval (ms)',
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
      'polling.market_data_interval_ms': 'Market Data Interval (ms)',
      'streaming.enabled': 'Live Streaming (WebSocket)',
    };

    if (overrides[key]) {
      return overrides[key];
    }

    return key.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  getSettingHelpText(key) {
    const help = {
      'polling.instance_interval_ms': 'Controls how often instance P&L is refreshed. Lower values increase load.',
      'polling.market_data_interval_ms': 'Used for non-streaming market data refresh cadence.',
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
      'settings.cache_duration_ms': 'Cache duration for settings reads in config (ms).',
    };

    return help[key] || '';
  }

  /**
   * Render monitor status section
   */
  async renderMonitorStatusSection() {
    try {
      const response = await this.authFetch('/api/v1/monitor/status');
      const data = await response.json();
      const status = data.data;

      return `
        <div class="space-y-4">
          <div class="settings-stat-box p-4 border border-neutral-200">
            <p class="text-sm text-neutral-700">
              The Order Monitor tracks targets for live and analyzer instances when they have open positions. It checks on a fixed
              interval and uses the latest position/quote data to evaluate targets. Live instances emit alerts; analyzer instances simulate exits.
            </p>
          </div>
          <div class="grid grid-cols-3 gap-4">
            <div class="settings-stat-box p-4 border border-neutral-200">
              <p class="text-sm text-neutral-600">Monitoring Status</p>
              <p class="text-lg font-semibold ${status.is_monitoring ? 'text-success-600' : 'text-neutral-500'}">
                ${status.is_monitoring ? '✅ Active' : '⏸️ Inactive'}
              </p>
            </div>
            <div class="settings-stat-box p-4 border border-neutral-200">
              <p class="text-sm text-neutral-600">Check Interval</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.interval_ms / 1000}s
              </p>
            </div>
            <div class="settings-stat-box p-4 border border-neutral-200">
              <p class="text-sm text-neutral-600">Active Instances</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.eligible_instances_count ?? status.analyzer_instances_count ?? 0}
              </p>
            </div>
          </div>

          <div class="settings-method-card method-info p-4">
            <p class="text-sm text-info-800">
              ℹ️ The order monitor checks live and analyzer positions every ${status.interval_ms / 1000} seconds,
              but only evaluates instances that have open positions.
            </p>
          </div>
        </div>
      `;
    } catch (error) {
      return `<p class="text-error text-sm">Failed to load monitor status: ${error.message}</p>`;
    }
  }

  /**
   * Fetch Telegram link status
   */
  /**
   * Format date for display
   */
  formatDate(dateString) {
    if (!dateString) return 'recently';
    // Prefer relative display for recent events, otherwise show IST date/time
    const rel = Utils.formatRelativeTime(dateString);
    if (rel && rel !== '-') return rel;
    return Utils.formatDateTime(dateString, true);
  }

  /**
   * Render instruments cache section
   */
  async renderInstrumentsCacheSection() {
    try {
      const response = await this.authFetch('/api/v1/instruments/stats');
      const data = await response.json();
      const stats = data.data;

      const html = `
        <div class="space-y-6">
          <!-- Cache Stats Header -->
          <div class="settings-sub-panel">
            <div class="flex items-center justify-between mb-4">
              <div>
                <h3 class="text-lg font-semibold text-neutral-900">📊 Instruments Cache Overview</h3>
                <p class="text-sm text-neutral-600 mt-1">
                  Local cache of broker instruments for fast symbol search
                </p>
              </div>
              <div class="flex items-center gap-2">
                <div class="px-3 py-1.5 rounded-full text-sm font-medium ${(stats.total || 0) > 0 ? 'bg-success-100 text-success-700' : 'bg-neutral-100 text-neutral-600'}">
                  ${(stats.total || 0) > 0 ? '✅ Loaded' : '⏸️ Empty'}
                </div>
              </div>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-3 gap-4">
              <div class="settings-stat-box">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Total Instruments</p>
                <p class="text-2xl font-bold text-neutral-900 mt-2">
                  ${(stats.total || 0).toLocaleString()}
                </p>
              </div>
              <div class="settings-stat-box">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Last Refresh</p>
                <p class="text-lg font-semibold text-neutral-900 mt-2">
                  ${stats.last_refresh ? this.formatDate(stats.last_refresh.completed_at) : 'Never'}
                </p>
              </div>
              <div class="settings-stat-box">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Exchanges</p>
                <p class="text-lg font-semibold text-neutral-900 mt-2">
                  9 Exchanges
                </p>
                <p class="text-xs text-neutral-600 mt-1">
                  NSE, BSE, NFO, BFO, BCD, CDS, MCX, NSE_INDEX, BSE_INDEX
                </p>
              </div>
            </div>
          </div>

          <!-- Data Import Methods -->
          <div class="settings-sub-panel">
            <h3 class="text-lg font-semibold text-neutral-900 mb-4">💾 Import Methods</h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <!-- CSV Upload Card -->
              <div class="settings-method-card method-primary">
                <div class="flex items-start gap-3">
                  <div class="text-2xl">📁</div>
                  <div class="flex-1">
                    <h4 class="font-semibold text-primary-900 mb-2">Upload CSV File</h4>
                    <p class="text-xs text-primary-800 mb-3">
                      Import instruments from a pre-downloaded CSV file. Best for bulk imports.
                    </p>
                    <div class="space-y-3">
                      <input
                        type="file"
                        id="instruments-csv-file"
                        accept=".csv"
                        class="form-input w-full text-sm"
                      />
                      <button
                        class="btn btn-primary w-full"
                        onclick="settings.uploadInstrumentsCSV()"
                        id="upload-csv-btn"
                      >
                        📤 Upload & Import
                      </button>
                      <div id="upload-progress" class="hidden">
                        <div class="settings-status-box">
                          <p class="text-xs text-primary-800 font-medium" id="upload-status">Processing...</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Fetch from Instance Card -->
              <div class="settings-method-card method-success">
                <div class="flex items-start gap-3">
                  <div class="text-2xl">🔄</div>
                  <div class="flex-1">
                    <h4 class="font-semibold text-success-900 mb-2">Fetch from Instance</h4>
                    <p class="text-xs text-success-800 mb-3">
                      Download instruments directly from an OpenAlgo instance. Fetches all 9 exchanges.
                    </p>
                    <div class="space-y-3">
                      <select id="instance-select" class="form-select w-full text-sm">
                        <option value="">-- Select an instance --</option>
                      </select>
                      <button
                        class="btn btn-success w-full"
                        onclick="settings.fetchFromInstance()"
                        id="fetch-instance-btn"
                      >
                        🚀 Start Fetch
                      </button>
                      <div id="fetch-progress" class="hidden">
                        <div class="settings-status-box">
                          <p class="text-xs text-success-800 font-medium" id="fetch-status">Initializing...</p>
                          <p class="text-xs text-success-700 mt-1">⏱️ This may take several minutes</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Additional Options -->
          <div class="bg-info-50 rounded-lg border border-info-200 p-4">
            <div class="flex items-start gap-3">
              <div class="text-xl">💡</div>
              <div>
                <h4 class="font-semibold text-info-900 mb-1">Additional Options</h4>
                <p class="text-sm text-info-800">
                  You can also refresh instruments from the broker API via the main dashboard.
                  The cache automatically refreshes daily on first login.
                </p>
              </div>
            </div>
          </div>
        </div>
      `;

      // Load instances after the DOM is ready
      setTimeout(() => {
        this.loadInstances();
      }, 100);

      return html;
    } catch (error) {
      return `<p class="text-error text-sm">Failed to load instruments cache stats: ${error.message}</p>`;
    }
  }

  /**
   * Upload instruments CSV file
   */
  async uploadInstrumentsCSV() {
    const fileInput = document.getElementById('instruments-csv-file');
    const uploadBtn = document.getElementById('upload-csv-btn');
    const progressDiv = document.getElementById('upload-progress');
    const statusText = document.getElementById('upload-status');

    if (!fileInput.files || fileInput.files.length === 0) {
      Utils.showToast('Please select a CSV file to upload', 'warning');
      return;
    }

    const file = fileInput.files[0];

    if (!file.name.endsWith('.csv')) {
      Utils.showToast('Please select a CSV file', 'error');
      return;
    }

    try {
      // Show progress
      progressDiv.classList.remove('hidden');
      statusText.textContent = 'Uploading file...';
      uploadBtn.disabled = true;
      uploadBtn.textContent = '⏳ Uploading...';

      // Create form data
      const formData = new FormData();
      formData.append('file', file);

      // Upload file
      const response = await this.authFetch('/api/v1/instruments/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Upload failed');
      }

      // Show success
      const result = data.data;
      statusText.textContent = `✅ Success! Imported ${result.finalCount.toLocaleString()} instruments in ${result.duration}`;

      Utils.showToast(
        `Successfully imported ${result.finalCount.toLocaleString()} instruments`,
        'success'
      );

      // Clear file input
      fileInput.value = '';

      // Refresh the settings view after 2 seconds
      setTimeout(() => {
        this.renderSettingsView();
      }, 2000);
    } catch (error) {
      console.error('[Settings] CSV upload error:', error);
      statusText.textContent = `❌ Error: ${error.message}`;
      Utils.showToast(`Upload failed: ${error.message}`, 'error');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📤 Upload CSV';
    }
  }

  /**
   * Load instances into the selector dropdown
   */
  async loadInstances() {
    try {
      const response = await this.authFetch('/api/v1/instances');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to load instances');
      }

      const instances = data.data || [];
      const select = document.getElementById('instance-select');

      if (!select) {
        console.error('[Settings] Instance select element not found');
        return;
      }

      // Clear existing options (keep the first placeholder option)
      select.innerHTML = '<option value="">-- Select an instance --</option>';

      // Add instances to dropdown
      instances.forEach(instance => {
        const option = document.createElement('option');
        option.value = instance.id;
        option.textContent = `${instance.name} (${instance.host})`;
        select.appendChild(option);
      });

      if (instances.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '-- No instances found --';
        option.disabled = true;
        select.appendChild(option);
      }
    } catch (error) {
      console.error('[Settings] Error loading instances:', error);
      const select = document.getElementById('instance-select');
      if (select) {
        select.innerHTML = '<option value="">-- Error loading instances --</option>';
      }
    }
  }

  /**
   * Fetch instruments from selected instance
   */
  async fetchFromInstance() {
    const select = document.getElementById('instance-select');
    const fetchBtn = document.getElementById('fetch-instance-btn');
    const progressDiv = document.getElementById('fetch-progress');
    const statusText = document.getElementById('fetch-status');

    if (!select) {
      Utils.showToast('Instance selector not found', 'error');
      return;
    }

    const instanceId = select.value;

    if (!instanceId) {
      Utils.showToast('Please select an OpenAlgo instance', 'warning');
      return;
    }

    try {
      // Show progress
      progressDiv.classList.remove('hidden');
      statusText.textContent = 'Starting fetch from instance...';
      fetchBtn.disabled = true;
      fetchBtn.textContent = '⏳ Fetching...';

      // Call the API
      const response = await this.authFetch('/api/v1/instruments/fetch-from-instance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instanceId: parseInt(instanceId, 10)
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Fetch failed');
      }

      // Poll for status updates
      this.pollFetchStatus(instanceId, statusText, fetchBtn, progressDiv);
    } catch (error) {
      console.error('[Settings] Fetch from instance error:', error);
      statusText.textContent = `❌ Error: ${error.message}`;
      statusText.classList.add('text-error');
      Utils.showToast(`Fetch failed: ${error.message}`, 'error');
      fetchBtn.disabled = false;
      fetchBtn.textContent = '🔄 Fetch from Instance';
    }
  }

  /**
   * Poll for fetch status updates
   */
  async pollFetchStatus(instanceId, statusText, fetchBtn, progressDiv) {
    const pollInterval = 2000; // Poll every 2 seconds
    const maxDuration = 5 * 60 * 1000; // 5 minutes max
    const startTime = Date.now();

    const poll = async () => {
      try {
        const response = await this.authFetch(`/api/v1/instruments/fetch-status/${instanceId}`);

        if (response.ok) {
          const data = await response.json();
          const status = data.data;

          // Update status display
          statusText.textContent = `⏳ ${status.message}`;
          statusText.classList.remove('text-error', 'text-success');
          statusText.classList.add('text-info');

          // If completed, show success and stop polling
          if (status.status === 'completed') {
            statusText.textContent = `✅ ${status.message} (Total: ${status.totalInstruments.toLocaleString()} instruments)`;
            statusText.classList.remove('text-info');
            statusText.classList.add('text-success');

            Utils.showToast(
              `Successfully fetched ${status.totalInstruments.toLocaleString()} instruments!`,
              'success'
            );

            fetchBtn.disabled = false;
            fetchBtn.textContent = '🔄 Fetch from Instance';

            // Refresh settings view after completion
            setTimeout(() => {
              this.renderSettingsView();
            }, 3000);

            return; // Stop polling
          }

          // If error, show error and stop polling
          if (status.status === 'error') {
            statusText.textContent = `❌ ${status.message}`;
            statusText.classList.remove('text-info');
            statusText.classList.add('text-error');

            Utils.showToast(`Fetch failed: ${status.message}`, 'error');

            fetchBtn.disabled = false;
            fetchBtn.textContent = '🔄 Fetch from Instance';
            return; // Stop polling
          }
        } else if (response.status === 404) {
          // Fetch completed (no longer in activeFetches)
          statusText.textContent = '✅ Fetch completed!';
          statusText.classList.remove('text-info');
          statusText.classList.add('text-success');

          fetchBtn.disabled = false;
          fetchBtn.textContent = '🔄 Fetch from Instance';

          setTimeout(() => {
            this.renderSettingsView();
          }, 3000);

          return; // Stop polling
        }

        // Continue polling if still active
        if (Date.now() - startTime < maxDuration) {
          setTimeout(poll, pollInterval);
        } else {
          statusText.textContent = '⚠️ Fetch timeout (still running in background)';
          statusText.classList.remove('text-info');
          statusText.classList.add('text-warning');
          fetchBtn.disabled = false;
          fetchBtn.textContent = '🔄 Fetch from Instance';
        }
      } catch (error) {
        console.error('[Settings] Error polling fetch status:', error);
        // Continue polling on error
        if (Date.now() - startTime < maxDuration) {
          setTimeout(poll, pollInterval);
        }
      }
    };

    // Start polling
    poll();
  }

  renderInstanceCsvSection() {
    return `
      <div class="flex flex-col gap-3">
        <div class="flex gap-2 items-center flex-wrap">
          <button class="btn btn-buy btn-sm" onclick="settings.exportInstancesCsv()" id="btn-export-instances">
            Export Instances CSV
          </button>
          <span class="text-xs text-neutral-500">Exports all instance fields (excluding timestamps) to CSV.</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="file" accept=".csv,text/csv" id="instances-csv-file" class="input input-sm" />
          <button class="btn btn-neutral btn-outline btn-sm" onclick="settings.importInstancesCsv()" id="btn-import-instances">
            Import Instances CSV
          </button>
          <span class="text-xs text-neutral-500">Upserts by host_url. Blank cells are ignored.</span>
        </div>
      </div>
    `;
  }

  async exportInstancesCsv() {
    const btn = document.getElementById('btn-export-instances');
    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/instances/export/csv', { method: 'GET' });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'instances-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      Utils.showToast('Instances exported', 'success');
    } catch (err) {
      Utils.showToast(err.message || 'Export failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
    }
  }

  async importInstancesCsv() {
    const input = document.getElementById('instances-csv-file');
    const btn = document.getElementById('btn-import-instances');
    if (!input || !input.files || !input.files.length) {
      Utils.showToast('Select a CSV file first', 'warning');
      return;
    }
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/instances/import/csv', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Import failed');
      }
      Utils.showToast(data.message || 'Import completed', 'success');
      await this.renderSettingsView();
    } catch (err) {
      Utils.showToast(err.message || 'Import failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
      if (input) input.value = '';
    }
  }

  renderWatchlistCsvSection() {
    return `
      <div class="flex flex-col gap-3">
        <div class="flex gap-2 items-center flex-wrap">
          <button class="btn btn-buy btn-sm" onclick="settings.exportWatchlistsCsv()" id="btn-export-watchlists">
            Export Watchlists CSV
          </button>
          <span class="text-xs text-neutral-500">Exports watchlists, symbols, and instance mappings as a text bundle.</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="file" accept=".txt,.csv,text/plain" id="watchlists-csv-file" class="input input-sm" />
          <button class="btn btn-neutral btn-outline btn-sm" onclick="settings.importWatchlistsCsv()" id="btn-import-watchlists">
            Import Watchlists CSV
          </button>
          <span class="text-xs text-neutral-500">Upserts by watchlist name; symbols by (watchlist_id, symbol, exchange); mappings by (watchlist_id, instance_id).</span>
        </div>
      </div>
    `;
  }

  async exportWatchlistsCsv() {
    const btn = document.getElementById('btn-export-watchlists');
    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/watchlists/export/csv', { method: 'GET' });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'watchlists-export.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      Utils.showToast('Watchlists exported', 'success');
    } catch (err) {
      Utils.showToast(err.message || 'Export failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
    }
  }

  async importWatchlistsCsv() {
    const input = document.getElementById('watchlists-csv-file');
    const btn = document.getElementById('btn-import-watchlists');
    if (!input || !input.files || !input.files.length) {
      Utils.showToast('Select a CSV/text file first', 'warning');
      return;
    }
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/watchlists/import/csv', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Import failed');
      }
      Utils.showToast(data.message || 'Import completed', 'success');
      await this.renderSettingsView();
    } catch (err) {
      Utils.showToast(err.message || 'Import failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
      if (input) input.value = '';
    }
  }
}

// Export singleton instance
var settings = new SettingsHandler();
if (typeof window !== 'undefined') {
  window.settings = settings;
}
