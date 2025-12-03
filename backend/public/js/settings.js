/**
 * Settings Handler
 * Handles settings view including application settings, Telegram linking, and monitor status
 */

class SettingsHandler {
  constructor() {
    this.categories = [];
    this.settings = {};
    this.activeCategory = 'server';
    this.isSaving = false;
    this.searchQuery = '';
    this.allowedCategories = null; // show all categories by default
    this.currentUser = null;
    this.roles = [];
    this.users = [];
    this.permissions = [];
    this.instanceHealthTests = null;

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
    return this.isAdmin() || this.hasPermission('settings.manage');
  }

  /**
   * Render settings view
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

      contentArea.innerHTML = `
        <div class="space-y-6">

            <!-- Application Settings Section -->
            ${canViewAppSettings ? `
              <div class="card">
                <div class="card-header">
                  <h3 class="card-title">⚙️ Application Settings</h3>
                </div>
                <div class="p-6">
                  ${this.renderApplicationSettings()}
                </div>
              </div>
            ` : `
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
            `}

            ${this.isAdmin() ? `
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">🔐 Role &amp; User Access</h3>
                <p class="text-sm text-neutral-600 mt-1">Manage roles and assign users</p>
              </div>
              <div class="p-6">
                ${this.renderRbacSection()}
              </div>
            </div>` : ''}

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
            </div>` : ''}

            ${this.isAdmin() ? `
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
            </div>` : ''}

            <!-- Monitor Status Section -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">📊 Order Monitor Status</h3>
              </div>
              <div class="p-6">
                ${await this.renderMonitorStatusSection()}
              </div>
            </div>

            ${this.isAdmin() ? `
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">🩺 Instance Health Tests</h3>
                <p class="text-sm text-neutral-600 mt-1">
                  Configure test symbols for quotes, multiquotes, and option chains. Cron runs every 3h from 08:00 IST.
                </p>
              </div>
              <div class="p-6 space-y-4">
                ${this.renderInstanceHealthTests()}
              </div>
            </div>` : ''}

        </div>
      `;

      if (this.isAdmin()) {
        this.initRbacListeners();
      }

      // Initialize category tabs
      this.initCategoryTabs();
    } catch (error) {
      contentArea.innerHTML = `
        <div class="p-4">
          <p class="text-error">Failed to load settings: ${error.message}</p>
        </div>
      `;
      console.error('[Settings] Error rendering settings view:', error);
    }
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
                ${this.categories.map(cat => {
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
            class="btn btn-primary"
            onclick="settings.saveSettings()"
            ${this.isSaving ? 'disabled' : ''}
          >
            ${this.isSaving ? '💾 Saving...' : '💾 Save Changes'}
          </button>
          <button
            class="btn btn-secondary"
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
        <button class="btn btn-primary" onclick="settings.saveInstanceHealthTests()">Save Tests</button>
        <button class="btn" onclick="settings.renderSettingsView()">Cancel</button>
      </div>
    `;
  }

  async saveInstanceHealthTests() {
    try {
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

    Object.entries(this.settings).forEach(([category, categorySettings]) => {
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
          <button class="btn btn-secondary btn-sm mt-3" onclick="settings.clearSearch()">Clear Search</button>
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
    const categorySettings = this.settings[category] || {};

    const inputs = Object.entries(categorySettings).map(([key, setting]) => {
      const inputId = `setting-${key.replace(/\./g, '-')}`;
      const isSensitive = setting.isSensitive;
      const inputValue = setting.pendingValue ?? setting.rawValue ?? setting.value;

      return `
        <div class="settings-field ${isSensitive ? 'settings-field-sensitive' : ''}">
          <label for="${inputId}" class="settings-field-label">
            <div class="settings-field-title">
              <span class="font-medium text-neutral-800">${this.formatSettingName(key)}</span>
              ${isSensitive ? '<span class="settings-sensitive-badge">🔒 Sensitive</span>' : ''}
            </div>
            ${setting.description ? `<span class="text-sm text-neutral-500 block mt-1">${setting.description}</span>` : ''}
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

  /**
   * Render input field based on data type
   */
  renderInputField(id, key, dataType, value, isSensitive) {
    const baseProps = `id="${id}" name="${key}" data-key="${key}" data-type="${dataType}" ${isSensitive ? 'data-sensitive="true"' : ''}`;

    if (key === 'trading_sessions') {
      return this.renderTradingSessionsField(key, value);
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

  /**
   * Save settings
   */
  async saveSettings() {
    if (!this.canViewApplicationSettings()) {
      Utils.showToast('You do not have permission to modify application settings', 'error');
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

      if (Object.keys(settingsToUpdate).length === 0) {
        Utils.showToast('No changes to save', 'info');
        return;
      }

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
    } catch (error) {
      console.error('[Settings] Error saving settings:', error);
      Utils.showToast(`Failed to save settings: ${error.message}`, 'error');
    } finally {
      this.isSaving = false;
      this.updateSaveButton();
    }
  }

  /**
   * Reset settings to defaults
   */
  async resetSettings() {
    if (!this.canViewApplicationSettings()) {
      Utils.showToast('You do not have permission to modify application settings', 'error');
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
      btn.disabled = this.isSaving;
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
    const roleOptions = this.roles.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
    const userRows = this.users.map(u => {
      const options = this.roles.map(r => `<option value="${r.name}" ${r.name === u.role ? 'selected' : ''}>${r.name}</option>`).join('');
      return `
      <tr>
        <td class="py-2 px-2">${u.email}</td>
        <td class="py-2 px-2">${u.role || '—'}</td>
        <td class="py-2 px-2">
          <select data-user-id="${u.id}" class="select select-sm rbac-role-select">
            ${options}
          </select>
        </td>
      </tr>`;
    }).join('');

    const permissionGrid = this.roles.map(role => {
      const currentPerms = new Set(role.permissions || []);
      const checkboxes = this.permissions.map(p => `
        <label class="flex items-center gap-2 text-xs">
          <input type="checkbox" class="checkbox checkbox-xs rbac-perm-checkbox"
            data-role="${role.name}" data-perm="${p.key}"
            ${currentPerms.has(p.key) ? 'checked' : ''}>
          <span>${p.key}</span>
        </label>
      `).join('');
      return `
        <div class="border rounded p-3 space-y-2">
          <div class="flex items-center justify-between">
            <div class="font-semibold">${role.name}</div>
            <button class="btn btn-xs btn-primary rbac-save-perms" data-role="${role.name}">Save</button>
          </div>
          <div class="text-xs text-neutral-600">Assign permissions for ${role.name}</div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-auto">
            ${checkboxes}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>Email</th>
              <th>Current Role</th>
              <th>Assign Role</th>
            </tr>
          </thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
      <div class="mt-4">
        <h4 class="font-semibold mb-2">Permissions by Role</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${permissionGrid}
        </div>
      </div>
    `;
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
      'market_data_feed': 'Market Data Feed'
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
    };

    if (overrides[key]) {
      return overrides[key];
    }

    return key.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
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
          <div class="grid grid-cols-3 gap-4">
            <div class="p-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <p class="text-sm text-neutral-600">Monitoring Status</p>
              <p class="text-lg font-semibold ${status.is_monitoring ? 'text-success-600' : 'text-neutral-500'}">
                ${status.is_monitoring ? '✅ Active' : '⏸️ Inactive'}
              </p>
            </div>
            <div class="p-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <p class="text-sm text-neutral-600">Check Interval</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.interval_ms / 1000}s
              </p>
            </div>
            <div class="p-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <p class="text-sm text-neutral-600">Analyzer Instances</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.analyzer_instances_count || 0}
              </p>
            </div>
          </div>

          <div class="p-4 bg-info-50 rounded-lg border border-info-200">
            <p class="text-sm text-info-800">
              ℹ️ The order monitor checks analyzer mode positions every ${status.interval_ms / 1000} seconds.
              Configure targets on watchlist symbols to enable monitoring.
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
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
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
          <div class="bg-white rounded-lg border border-neutral-200 p-5">
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
              <div class="bg-neutral-50 rounded-lg p-4">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Total Instruments</p>
                <p class="text-2xl font-bold text-neutral-900 mt-2">
                  ${(stats.total || 0).toLocaleString()}
                </p>
              </div>
              <div class="bg-neutral-50 rounded-lg p-4">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Last Refresh</p>
                <p class="text-lg font-semibold text-neutral-900 mt-2">
                  ${stats.last_refresh ? this.formatDate(stats.last_refresh.completed_at) : 'Never'}
                </p>
              </div>
              <div class="bg-neutral-50 rounded-lg p-4">
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
          <div class="bg-white rounded-lg border border-neutral-200 p-5">
            <h3 class="text-lg font-semibold text-neutral-900 mb-4">💾 Import Methods</h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <!-- CSV Upload Card -->
              <div class="bg-primary-50 rounded-lg border border-primary-200 p-4">
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
                        <div class="bg-white rounded border border-primary-300 p-2">
                          <p class="text-xs text-primary-800 font-medium" id="upload-status">Processing...</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Fetch from Instance Card -->
              <div class="bg-success-50 rounded-lg border border-success-200 p-4">
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
                        <div class="bg-white rounded border border-success-300 p-2">
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
          <button class="btn btn-primary btn-sm" onclick="settings.exportInstancesCsv()" id="btn-export-instances">
            Export Instances CSV
          </button>
          <span class="text-xs text-neutral-500">Exports all instance fields (excluding timestamps) to CSV.</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="file" accept=".csv,text/csv" id="instances-csv-file" class="input input-sm" />
          <button class="btn btn-secondary btn-sm" onclick="settings.importInstancesCsv()" id="btn-import-instances">
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
          <button class="btn btn-primary btn-sm" onclick="settings.exportWatchlistsCsv()" id="btn-export-watchlists">
            Export Watchlists CSV
          </button>
          <span class="text-xs text-neutral-500">Exports watchlists, symbols, and instance mappings as a text bundle.</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="file" accept=".txt,.csv,text/plain" id="watchlists-csv-file" class="input input-sm" />
          <button class="btn btn-secondary btn-sm" onclick="settings.importWatchlistsCsv()" id="btn-import-watchlists">
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
const settings = new SettingsHandler();
