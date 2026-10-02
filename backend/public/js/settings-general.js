/**
 * Simplifyed Admin V2 - Settings: General/Application Settings tab (render, form fields, save/
 * reset). Excludes renderAccessControlTab/renderDataManagementTab/renderSystemStatusTab, which
 * were physically embedded in this range in the original file but semantically belong to the
 * RBAC/Data/Status tabs - moved to their respective files.
 */

Object.defineProperties(SettingsHandler.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render General tab (Application Settings)
   */
  renderGeneralTab(canViewAppSettings) {
    if (!canViewAppSettings) {
      return `
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Application settings</h3>
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
            <h3 class="card-title">Application settings</h3>
          </div>
          <div class="p-6">
            ${this.renderApplicationSettings()}
          </div>
        </div>
      </div>
    `;
  }


  /**
   * Render application settings section
   */
  renderApplicationSettings() {
    // Structure comes from the server registry (see settings-schema.js). This method only owns
    // the surrounding chrome: search, the group host, and the save/reset actions.
    return `
      <div class="settings-container">
        <div class="settings-header">
          <div class="settings-header-info">
            <p class="text-sm text-neutral-600">
              Changes apply as soon as you click Save - no restart needed.
            </p>
          </div>
          <div class="settings-search-wrapper">
            <div class="settings-search">
              <svg class="settings-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clip-rule="evenodd" />
              </svg>
              <input type="text" class="settings-search-input" placeholder="Search settings..."
                     aria-label="Search settings"
                     id="settings-search" value="${this.searchQuery}"
                     oninput="settings.handleSearch(this.value)" />
              ${this.searchQuery ? `
                <button class="settings-search-clear" onclick="settings.clearSearch()" aria-label="Clear search">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>` : ''}
            </div>
          </div>
        </div>

        ${this.searchQuery
          ? this.renderSearchResults()
          : `<div id="settings-schema-host" class="settings-schema-host">${this.renderSchemaShell()}</div>`}

        <div class="settings-actions">
          <button class="btn btn-buy" onclick="settings.saveSettings()" ${this.isSaving ? 'disabled' : ''}>
            ${this.isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    `;
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
  /**
   * Search across the schema rather than the raw settings table, so results are limited to
   * settings that can actually be saved, and each hit carries the same label/help text the
   * grouped view shows.
   */
  renderSearchResults() {
    const q = (this.searchQuery || '').toLowerCase();
    const results = [];
    for (const group of this.schema?.groups || []) {
      for (const section of group.sections) {
        for (const field of section.fields) {
          const haystack = `${field.label} ${field.help || ''} ${field.key} ${group.label} ${section.label}`.toLowerCase();
          if (haystack.includes(q)) results.push({ field, group, section });
        }
      }
    }

    if (results.length === 0) {
      return `
        <div class="settings-search-empty">
          <p class="text-neutral-600">No settings match "<strong>${Utils.escapeHTML(this.searchQuery)}</strong>".</p>
          <p class="text-sm text-neutral-500 mt-2">
            Only settings that take effect without a restart are listed. Secrets, startup values
            and debug flags are configured through the environment.
          </p>
          <button class="btn btn-neutral btn-outline btn-sm mt-3" onclick="settings.clearSearch()">Clear search</button>
        </div>
      `;
    }

    return `
      <div class="settings-search-results" id="settings-schema-host">
        <div class="settings-search-results-header">
          <span class="text-sm text-neutral-600">
            ${results.length} setting${results.length !== 1 ? 's' : ''} found
          </span>
        </div>
        <div class="settings-section-body">
          ${results.map(({ field, group, section }) => `
            <div class="settings-search-hit">
              <span class="settings-field-breadcrumb">
                ${Utils.escapeHTML(group.label)} › ${Utils.escapeHTML(section.label)}
              </span>
              ${this.renderSchemaField(field)}
            </div>
          `).join('')}
        </div>
      </div>
    `;
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
          <input type="time" class="form-input trading-session-input" data-key="${key}" data-index="${idx}" data-field="start" aria-label="Session ${idx + 1} start" value="${Utils.escapeHTML(s.start || '')}">
          <span class="text-neutral-500 text-sm">to</span>
          <input type="time" class="form-input trading-session-input" data-key="${key}" data-index="${idx}" data-field="end" aria-label="Session ${idx + 1} end" value="${Utils.escapeHTML(s.end || '')}">
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
              aria-label="${Utils.escapeHTML(broker)} brokerage per order"
              data-skip-setting-change="true"
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
            <label class="form-label text-xs mb-1" for="brokerage-new-key">Broker key</label>
            <input type="text" class="form-input" id="brokerage-new-key" placeholder="e.g. fivepaisa" data-skip-setting-change="true">
          </div>
          <div class="w-[160px]">
            <label class="form-label text-xs mb-1" for="brokerage-new-rate">Brokerage</label>
            <input type="number" class="form-input" id="brokerage-new-rate" placeholder="20" data-skip-setting-change="true">
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
          Use Add Broker above for a broker that is not listed.
        </div>
      </div>
    `;
  }

  renderMarketOrderSupportTable(key, value) {
    let supportMap = {};
    try {
      supportMap = typeof value === 'string' ? JSON.parse(value) : value;
      if (!supportMap || typeof supportMap !== 'object') supportMap = {};
    } catch (e) {
      supportMap = {};
    }

    // Only crypto brokers are listed: Indian exchanges always get limit orders, whatever this
    // says. Crypto brokers take market orders unless switched off (mirrors CRYPTO_BROKERS in
    // src/utils/broker-type.util.js).
    const rows = ['deltaexchange']
      .map((broker) => {
        const rawSupport = supportMap?.[broker];
        const isSupported = !(rawSupport === false || rawSupport === 'false' || rawSupport === 0);
        return `
          <tr>
            <td class="text-sm font-medium">${Utils.escapeHTML(broker)}</td>
            <td>
              <label class="settings-toggle">
                <input
                  type="checkbox"
                  class="settings-toggle-input"
                  data-key="${key}"
                  data-type="json"
                  data-broker="${Utils.escapeHTML(broker)}"
                  data-skip-setting-change="true"
                  data-toggle-label="yesno"
                  ${isSupported ? 'checked' : ''}
                  onchange="settings.handleMarketOrderSupportChange(this)"
                />
                <span class="settings-toggle-track">
                  <span class="settings-toggle-thumb"></span>
                </span>
                <span class="settings-toggle-label">${isSupported ? 'Yes' : 'No'}</span>
              </label>
            </td>
          </tr>
        `;
      })
      .join('');

    return `
      <div class="settings-brokerage-table">
        <table class="table">
          <thead>
            <tr>
              <th>Broker</th>
              <th>Market orders</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="2" class="text-neutral-500">No brokers configured.</td></tr>'}
          </tbody>
        </table>
        <div class="text-xs text-neutral-500 mt-2">
          Applies to crypto only. Indian exchanges always receive limit orders.
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
      if (input?.dataset?.skipSettingChange === 'true') {
        return;
      }
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
          const mode = e.target.dataset.toggleLabel || '';
          if (mode === 'yesno') {
            label.textContent = e.target.checked ? 'Yes' : 'No';
          } else {
            label.textContent = e.target.checked ? 'Enabled' : 'Disabled';
          }
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
  /**
   * Handle setting change
   */
  handleSettingChange(input) {
    if (input?.dataset?.skipSettingChange === 'true') {
      return;
    }
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
    } else if (input.dataset.scale) {
      // Seconds on screen -> ms in storage (whole numbers); percent on screen -> a fraction.
      const scale = Number(input.dataset.scale);
      const stored = Number(input.value) * scale;
      value = input.value === '' ? '' : String(scale >= 1 ? Math.round(stored) : parseFloat(stored.toPrecision(12)));
    } else {
      value = input.value;
    }

    this.settings[category][key].pendingValue = value;

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

  handleMarketOrderSupportChange(input) {
    const key = input.dataset.key;
    const broker = input.dataset.broker || '';
    const category = this.getSettingCategory(key);
    const setting = this.settings[category]?.[key] || {};

    let supportMap = {};
    try {
      const source = setting.pendingValue ?? setting.rawValue ?? setting.value;
      supportMap = typeof source === 'string' ? JSON.parse(source) : source;
      if (!supportMap || typeof supportMap !== 'object') supportMap = {};
    } catch (e) {
      supportMap = {};
    }

    if (broker) {
      supportMap[broker] = input.checked === true;
    }

    if (!this.settings[category]) {
      this.settings[category] = {};
    }
    if (!this.settings[category][key]) {
      this.settings[category][key] = { dataType: 'json', isSensitive: false };
    }
    this.settings[category][key].pendingValue = JSON.stringify(supportMap);
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

      if (Object.keys(settingsToUpdate).length === 0) {
        Utils.showToast('No changes to save', 'info');
        return;
      }

      if (Object.keys(settingsToUpdate).length > 0) {
        // Send update request
        const data = await api.request('/settings', { method: 'PUT', body: settingsToUpdate });

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
    } catch (error) {
      console.error('[Settings] Error saving settings:', error);
      Utils.showToast(`Failed to save settings: ${error.message}`, 'error');
    } finally {
      this.isSaving = false;
      this.updateSaveButton();
    }
  }

  /**
   * Update save button state
   */
  updateSaveButton() {
    const btn = document.querySelector('[onclick="settings.saveSettings()"]');
    if (btn) {
      btn.textContent = this.isSaving ? 'Saving...' : 'Save Changes';
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

    this.settings = {};
    await this.fetchSchema();

    const host = document.getElementById('settings-schema-host');
    if (host) {
      host.dataset.bound = '';
      host.innerHTML = this.renderSchemaShell();
      this.bindSchemaInputs();
    }
  }

  async fetchCurrentUser() {
    try {
      return (await api.request('/user', { baseURL: '/api' }))?.data || null;
    } catch {
      return null;
    }
  }
}.prototype));
