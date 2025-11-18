/**
 * Settings Handler
 * Handles settings view including application settings, Telegram linking, and monitor status
 */

class SettingsHandler {
  constructor() {
    this.telegramStatus = null;
    this.categories = [];
    this.settings = {};
    this.activeCategory = 'server';
    this.isSaving = false;
  }

  /**
   * Render settings view
   */
  async renderSettingsView() {
    const contentArea = document.getElementById('content-area');

    try {
      // Fetch all data
      const [telegramStatus, categories, allSettings] = await Promise.all([
        this.fetchTelegramStatus(),
        this.fetchCategories(),
        this.fetchAllSettings()
      ]);

      this.telegramStatus = telegramStatus;
      this.categories = categories;
      this.settings = allSettings;

      contentArea.innerHTML = `
        <div class="space-y-6">

            <!-- Application Settings Section -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">⚙️ Application Settings</h3>
                <p class="text-sm text-neutral-600 mt-1">
                  Configure application settings. Changes take effect immediately.
                </p>
              </div>
              <div class="p-6">
                ${this.renderApplicationSettings()}
              </div>
            </div>

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

            <!-- Telegram Notifications Section -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">📱 Telegram Notifications</h3>
              </div>
              <div class="p-6">
                ${this.renderTelegramSection()}
              </div>
            </div>

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
    return `
      <div class="settings-container">
        ${this.renderCustomizableValuesLegend()}
        <!-- Category Tabs -->
        <div class="settings-tabs">
          ${this.categories.map(cat => `
            <button
              class="settings-tab ${cat.category === this.activeCategory ? 'active' : ''}"
              data-category="${cat.category}"
              onclick="settings.switchCategory('${cat.category}')"
            >
              ${this.formatCategoryName(cat.category)}
              <span class="settings-tab-count">${cat.count}</span>
            </button>
          `).join('')}
        </div>

        <!-- Settings Form -->
        <div class="settings-content" id="settings-content">
          ${this.renderSettingsForm(this.activeCategory)}
        </div>

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

  /**
   * Render settings form for a category
   */
  renderSettingsForm(category) {
    const categorySettings = this.settings[category] || {};

    const inputs = Object.entries(categorySettings).map(([key, setting]) => {
      const inputId = `setting-${key.replace(/\./g, '-')}`;
      const isSensitive = setting.isSensitive;
      const displayValue = isSensitive ? setting.value : setting.value;
      const inputValue = setting.pendingValue ?? setting.rawValue ?? setting.value;

      return `
        <div class="settings-field">
          <label for="${inputId}" class="settings-field-label">
            <span class="font-medium">${this.formatSettingName(key)}</span>
            ${setting.description ? `<span class="text-sm text-neutral-600 block mt-1">${setting.description}</span>` : ''}
          </label>
          <div class="settings-field-input">
            ${this.renderInputField(inputId, key, setting.dataType, inputValue, isSensitive)}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="space-y-4">
        <h4 class="font-semibold text-lg text-neutral-800 mb-4">
          ${this.formatCategoryName(category)} Settings
        </h4>
        ${inputs}
      </div>
    `;
  }

  /**
   * Render input field based on data type
   */
  renderInputField(id, key, dataType, value, isSensitive) {
    const baseProps = `id="${id}" name="${key}" data-key="${key}" data-type="${dataType}" ${isSensitive ? 'data-sensitive="true"' : ''}`;

    switch (dataType) {
      case 'boolean':
        return `
          <select ${baseProps} class="form-select">
            <option value="true" ${value === 'true' ? 'selected' : ''}>True</option>
            <option value="false" ${value === 'false' ? 'selected' : ''}>False</option>
          </select>
        `;

      case 'number':
        return `
          <input type="number" ${baseProps} class="form-input" value="${value}" />
        `;

      default:
        return `
          <input type="text" ${baseProps} class="form-input" value="${value}" />
        `;
    }
  }

  /**
   * Initialize category tabs
   */
  initCategoryTabs() {
    // Add change event listeners to all inputs
    const inputs = document.querySelectorAll('#settings-content input, #settings-content select');
    inputs.forEach(input => {
      input.addEventListener('change', (e) => {
        this.handleSettingChange(e.target);
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

    this.settings[category][key].pendingValue = input.value;

    console.log(`[Settings] Setting changed: ${key} = ${input.value}`);
  }

  /**
   * Save settings
   */
  async saveSettings() {
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
      const response = await fetch('/api/v1/settings', {
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
    if (!confirm('Are you sure you want to reset all settings to their default values? This action cannot be undone.')) {
      return;
    }

    try {
      const resetKeys = Object.keys(this.settings[this.activeCategory] || {});

      for (const key of resetKeys) {
        await fetch(`/api/v1/settings/${key}/reset`, { method: 'POST' });
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
      const response = await fetch('/api/v1/settings');
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
      const response = await fetch('/api/v1/settings/categories');
      if (!response.ok) throw new Error('Failed to fetch categories');
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('[Settings] Error fetching categories:', error);
      return [];
    }
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

  renderCustomizableValuesLegend() {
    const entries = [];
    Object.keys(this.settings).forEach(category => {
      Object.entries(this.settings[category] || {}).forEach(([key, setting]) => {
        entries.push({
          key,
          label: this.formatSettingName(key),
          description: setting.description || 'No description available',
          value: setting.value,
        });
      });
    });

    if (entries.length === 0) {
      return '';
    }

    return `
      <div class="mb-6">
        <h4 class="font-semibold text-lg text-neutral-800 mb-2">Customizable Values Overview</h4>
        <p class="text-sm text-neutral-600 mb-4">
          Every setting below is editable via the tabs. This section summarizes the key knobs you can adjust and what they control.
        </p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${entries.map(item => `
            <div class="p-3 rounded-lg border border-base-200 bg-base-100 shadow-sm space-y-1">
              <div class="flex items-center justify-between text-xs uppercase tracking-wide text-neutral-500">
                <span>${item.key}</span>
                <span class="font-semibold">${item.value}</span>
              </div>
              <p class="font-medium text-neutral-800">${item.label}</p>
              <p class="text-sm text-neutral-600">${item.description}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render Telegram section
   */
  renderTelegramSection() {
    const isLinked = this.telegramStatus?.is_linked;
    const linkedAt = this.telegramStatus?.linked_at;
    const username = this.telegramStatus?.username;

    if (isLinked) {
      return `
        <div class="space-y-4">
          <div class="flex items-center justify-between p-4 bg-success-50 rounded-lg border border-success-200">
            <div>
              <p class="font-medium text-success-700">✅ Telegram Connected</p>
              <p class="text-sm text-success-600 mt-1">
                @${Utils.escapeHTML(username || 'Unknown')} • Linked ${this.formatDate(linkedAt)}
              </p>
            </div>
            <button class="btn btn-error btn-sm" onclick="settings.unlinkTelegram()">
              Unlink
            </button>
          </div>

          <div class="space-y-3">
            <h4 class="font-semibold text-neutral-700">Notification Preferences</h4>
            <p class="text-sm text-neutral-600">
              You'll receive Telegram alerts when targets and stop losses are hit in your analyzer mode instances.
            </p>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="space-y-4">
          <div class="flex items-center justify-between p-4 bg-neutral-50 rounded-lg border border-neutral-200">
            <div>
              <p class="font-medium text-neutral-700">📱 Telegram Not Connected</p>
              <p class="text-sm text-neutral-600 mt-1">
                Link your Telegram account to receive instant trade alerts
              </p>
            </div>
            <button class="btn btn-primary" onclick="settings.linkTelegram()">
              Link Telegram
            </button>
          </div>

          <div id="telegram-linking-instructions" class="hidden space-y-3">
            <div class="p-4 bg-primary-50 rounded-lg border border-primary-200">
              <h4 class="font-semibold text-primary-900 mb-3">📋 Setup Instructions</h4>
              <ol class="list-decimal list-inside space-y-2 text-sm text-primary-800">
                <li>Copy the command below</li>
                <li>Open Telegram and search for <strong id="bot-username">...</strong></li>
                <li>Send the copied command to the bot</li>
                <li>Wait for confirmation (page will auto-refresh)</li>
              </ol>
            </div>

            <div class="p-4 bg-neutral-100 rounded-lg border border-neutral-300">
              <div class="flex items-center justify-between">
                <code id="telegram-link-command" class="text-sm font-mono text-neutral-800">
                  Loading...
                </code>
                <button class="btn btn-secondary btn-sm" onclick="settings.copyLinkCommand()">
                  📋 Copy
                </button>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button class="btn btn-primary" onclick="settings.openTelegramBot()">
                Open Telegram Bot
              </button>
              <button class="btn btn-secondary" onclick="settings.checkLinkStatus()">
                Check Status
              </button>
            </div>
          </div>
        </div>
      `;
    }
  }

  /**
   * Render monitor status section
   */
  async renderMonitorStatusSection() {
    try {
      const response = await fetch('/api/v1/monitor/status');
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
  async fetchTelegramStatus() {
    try {
      const response = await fetch('/api/v1/telegram/status');
      if (!response.ok) throw new Error('Failed to fetch Telegram status');
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('[Settings] Error fetching Telegram status:', error);
      return { is_linked: false };
    }
  }

  /**
   * Link Telegram account
   */
  async linkTelegram() {
    try {
      // Generate linking code
      const response = await fetch('/api/v1/telegram/link', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to generate linking code');

      const data = await response.json();
      const { linking_code, bot_username, link_url } = data.data;

      // Show instructions
      const instructionsDiv = document.getElementById('telegram-linking-instructions');
      instructionsDiv.classList.remove('hidden');

      // Update command
      document.getElementById('telegram-link-command').textContent = `/start ${linking_code}`;
      document.getElementById('bot-username').textContent = `@${bot_username}`;

      // Store for later use
      this.linkingData = { linking_code, bot_username, link_url };

      Utils.showToast('Linking code generated! Follow the instructions above.', 'success');
    } catch (error) {
      console.error('[Settings] Error linking Telegram:', error);
      Utils.showToast(`Failed to link: ${error.message}`, 'error');
    }
  }

  /**
   * Copy link command
   */
  copyLinkCommand() {
    const command = document.getElementById('telegram-link-command').textContent;
    navigator.clipboard.writeText(command);
    Utils.showToast('Command copied to clipboard!', 'success');
  }

  /**
   * Open Telegram bot
   */
  openTelegramBot() {
    if (this.linkingData?.link_url) {
      window.open(this.linkingData.link_url, '_blank');
    }
  }

  /**
   * Check link status
   */
  async checkLinkStatus() {
    try {
      this.telegramStatus = await this.fetchTelegramStatus();

      if (this.telegramStatus.is_linked) {
        Utils.showToast('✅ Telegram linked successfully!', 'success');
        // Refresh view
        await this.renderSettingsView();
      } else {
        Utils.showToast('Not linked yet. Please send the command to the bot.', 'info');
      }
    } catch (error) {
      Utils.showToast(`Error checking status: ${error.message}`, 'error');
    }
  }

  /**
   * Unlink Telegram account
   */
  async unlinkTelegram() {
    if (!confirm('Are you sure you want to unlink your Telegram account?')) {
      return;
    }

    try {
      const response = await fetch('/api/v1/telegram/unlink', { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to unlink');

      Utils.showToast('Telegram unlinked successfully', 'success');

      // Refresh view
      await this.renderSettingsView();
    } catch (error) {
      console.error('[Settings] Error unlinking Telegram:', error);
      Utils.showToast(`Failed to unlink: ${error.message}`, 'error');
    }
  }

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
      const response = await fetch('/api/v1/instruments/stats');
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
      const response = await fetch('/api/v1/instruments/upload', {
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
      const response = await fetch('/api/v1/instances');
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
      const response = await fetch('/api/v1/instruments/fetch-from-instance', {
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
        const response = await fetch(`/api/v1/instruments/fetch-status/${instanceId}`);

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
}

// Export singleton instance
const settings = new SettingsHandler();
