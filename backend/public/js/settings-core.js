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
    this.settings = {};
    this.activeMainTab = 'general'; // New: Track main tab (general, access, data, status)
    this.isSaving = false;
    this.searchQuery = '';
    this.currentUser = null;
    this.roles = [];
    this.users = [];
    this.permissions = [];
    this.activeRoleTab = null;
    this.permissionFilter = '';
    this.userFilter = '';
    this.userRoleFilter = 'all';
    // allowedCategories/allowedSettings used to live here as a hardcoded mirror of what the
    // UI would show. It drifted from the database (it listed a polling key that doesn't exist
    // and hid one that does), and being client-side it filtered display only - the API still
    // accepted writes to every other key. Both concerns now live in
    // src/config/settings-registry.js, served via GET /api/v1/settings/schema.
    this.schema = null;
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

      this.settings = {};

      // The schema is what the UI renders from (the editable subset, already grouped and
      // labelled); fetchSchema also fills this.settings for the save path to diff against.
      if (canViewAppSettings) {
        await this.fetchSchema();
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
      this.bindSchemaInputs();
      this.initMainTabListeners();
    } catch (error) {
      contentArea.innerHTML = `
        <div class="p-4">
          <p class="text-error">Failed to load settings: ${Utils.escapeHTML(error.message)}</p>
        </div>
      `;
      console.error('[Settings] Error rendering settings view:', error);
    }
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

}.prototype));

window.SettingsHandler = SettingsHandler;
