/**
 * Schema-driven Settings rendering.
 *
 * The Settings screen used to decide what to show from a hardcoded list in settings-core.js
 * (`allowedCategories` / `allowedSettings`) and label it from a second hardcoded map
 * (`categoryMeta`). Both drifted from the database: the list named
 * `polling.health_check_interval_ms`, which does not exist, while hiding
 * `polling.market_data_interval_ms`, which does; and its `streaming` entry could never render
 * because `streaming` was absent from the category list it was filtered against.
 *
 * Everything here now comes from GET /api/v1/settings/schema, which is generated from
 * src/config/settings-registry.js - the same module the API consults before accepting a write.
 * A setting appears in this UI if and only if it can actually be saved.
 *
 * Grouping is by task ("Market Data", "Broker Connection") rather than by the internal category
 * column, because a category like `market_data_feed` mixes quote freshness, position cadence and
 * order-pricing guardrails, which are three unrelated decisions for whoever is tuning them.
 */

Object.assign(SettingsHandler.prototype, {
  /** Fetch the registry + current values. Stored for the save path to diff against. */
  async fetchSchema() {
    const response = await this.authFetch('/api/v1/settings/schema');
    if (!response.ok) throw new Error(`Failed to load settings schema (${response.status})`);
    const { data } = await response.json();
    this.schema = data;

    // Mirror into this.settings so handleSettingChange/saveSettings keep working unchanged -
    // they key off category, which the schema carries per field via the key prefix.
    this.settings = this.settings || {};
    for (const group of data.groups) {
      for (const section of group.sections) {
        for (const field of section.fields) {
          const category = this.getSettingCategory(field.key);
          if (!this.settings[category]) this.settings[category] = {};
          this.settings[category][field.key] = {
            ...(this.settings[category][field.key] || {}),
            value: field.value,
            rawValue: field.dataType === 'json' ? JSON.stringify(field.value) : String(field.value),
            dataType: field.dataType,
            isSensitive: false,
          };
        }
      }
    }
    const advanced = data.groups.filter((g) => g.advanced);
    if (!this.activeGroup || !advanced.some((g) => g.id === this.activeGroup)) {
      this.activeGroup = advanced[0]?.id || null;
    }
    return data;
  },

  /**
   * Human-readable hint for a millisecond value. Operators think in seconds and minutes; the
   * raw input stays in ms so it round-trips exactly, but every field shows what it means.
   */
  humanizeMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1000) return `${n} ms`;
    const secs = n / 1000;
    if (secs < 90) return `${Number.isInteger(secs) ? secs : secs.toFixed(1)} seconds`;
    const mins = secs / 60;
    if (mins < 90) return `${Number.isInteger(mins) ? mins : mins.toFixed(1)} minutes`;
    return `${(mins / 60).toFixed(1)} hours`;
  },

  /** Default shown next to every value; a spread also shows what the typed decimal means. */
  fieldHint(field, value = field.value) {
    const def = field.default;
    const hasDef = def !== undefined && def !== '' && !field.editor;
    if (field.unit === 'percent') {
      const pct = (v) => `${parseFloat((Number(v) * 100).toFixed(4))}%`;
      const now = Number.isFinite(Number(value)) ? `= ${pct(value)} of price` : '';
      return [now, hasDef ? `Default: ${pct(def)}` : ''].filter(Boolean).join(' · ');
    }
    if (!hasDef) return '';
    if (field.unit === 'ms') return `Default: ${this.humanizeMs(def)}`;
    if (field.unit === 'currency') return `Default: ₹${def} per trade`;
    return `Default: ${def}`;
  },

  renderSchemaNav() {
    const groups = (this.schema?.groups || []).filter((g) => g.advanced);
    if (!groups.length) return '';
    return `
      <nav class="settings-group-nav" aria-label="Advanced settings sections">
        ${groups.map((g) => `
          <button type="button"
                  class="settings-group-tab ${g.id === this.activeGroup ? 'active' : ''}"
                  data-group="${g.id}"
                  aria-current="${g.id === this.activeGroup ? 'true' : 'false'}"
                  onclick="settings.switchGroup('${g.id}')">
            <span class="settings-group-tab-label">${Utils.escapeHTML(g.label)}</span>
            <span class="settings-group-tab-count">${g.sections.reduce((n, s) => n + s.fields.length, 0)}</span>
          </button>
        `).join('')}
      </nav>
    `;
  },

  renderSchemaField(field) {
    const id = `setting-${field.key.replace(/[.]/g, '-')}`;
    const hint = this.fieldHint(field);
    const bounds = [];
    if (field.min !== undefined) bounds.push(`min="${field.min}"`);
    if (field.max !== undefined) bounds.push(`max="${field.max}"`);
    if (field.unit === 'percent') bounds.push('step="0.001"');

    let control;
    if (field.editor === 'sessions') {
      control = this.renderTradingSessionsField(field.key, field.value);
    } else if (field.editor === 'broker-map') {
      control = this.renderBrokerageTable(field.key, field.value);
    } else if (field.editor === 'broker-flags') {
      control = this.renderMarketOrderSupportTable(field.key, field.value);
    } else if (field.unit === 'time') {
      // A native time input beats a free-text box: it validates HH:MM for us and opens the
      // platform time picker. The server re-checks the format regardless.
      control = `<input type="time" id="${id}" data-key="${field.key}" data-type="string"
                        class="form-input settings-time-input" value="${Utils.escapeHTML(String(field.value))}" />`;
    } else if (field.unit === 'ms') {
      // Stored in ms so it round-trips exactly; edited in seconds, which is how people think.
      const secs = (v) => (v === undefined ? undefined : Number(v) / 1000);
      control = `
        <div class="settings-input-wrapper">
          <input type="number" id="${id}" data-key="${field.key}" data-type="number" data-scale="1000"
                 class="form-input settings-number-input" value="${secs(field.value)}" step="any"
                 ${field.min !== undefined ? `min="${secs(field.min)}"` : ''}
                 ${field.max !== undefined ? `max="${secs(field.max)}"` : ''} />
          <span class="settings-input-suffix">seconds</span>
        </div>`;
    } else if (field.dataType === 'number') {
      control = `
        <div class="settings-input-wrapper">
          <input type="number" id="${id}" data-key="${field.key}" data-type="number"
                 class="form-input settings-number-input" value="${Utils.escapeHTML(String(field.value))}"
                 ${bounds.join(' ')} />
          ${field.unit === 'currency' ? '<span class="settings-input-suffix">₹</span>' : ''}
        </div>`;
    } else {
      control = `<input type="text" id="${id}" data-key="${field.key}" data-type="${field.dataType}"
                        class="form-input" value="${Utils.escapeHTML(String(field.value))}" />`;
    }

    const wide = field.editor ? ' settings-field-wide' : '';
    return `
      <div class="settings-field${wide}" data-field-key="${field.key}">
        <label class="settings-field-label" for="${id}">
          ${Utils.escapeHTML(field.label)}
          ${field.pairLabel ? `<span class="settings-field-qualifier">${Utils.escapeHTML(field.pairLabel)}</span>` : ''}
        </label>
        <p class="settings-field-help">${Utils.escapeHTML(field.help || '')}</p>
        ${control}
        <p class="settings-field-hint" data-hint-for="${field.key}">${Utils.escapeHTML(hint)}</p>
      </div>
    `;
  },

  renderSchemaSection(section) {
    // Paired fields (idle vs active, retries vs delay) sit on one row so the relationship is
    // visible instead of implied by two similarly-named entries in a long list.
    const rows = [];
    const consumed = new Set();
    for (const field of section.fields) {
      if (consumed.has(field.key)) continue;
      if (field.pair) {
        const pair = section.fields.filter((f) => f.pair === field.pair);
        pair.forEach((f) => consumed.add(f.key));
        rows.push(`<div class="settings-field-pair">${pair.map((f) => this.renderSchemaField(f)).join('')}</div>`);
      } else {
        consumed.add(field.key);
        rows.push(this.renderSchemaField(field));
      }
    }

    return `
      <section class="settings-section">
        <h4 class="settings-section-title">${Utils.escapeHTML(section.label)}</h4>
        ${section.note ? `<p class="settings-section-note">${Utils.escapeHTML(section.note)}</p>` : ''}
        <div class="settings-section-body">${rows.join('')}</div>
      </section>
    `;
  },

  renderSchemaGroup(group = this.schema?.groups?.find((g) => g.id === this.activeGroup)) {
    if (!group) return '<p class="text-neutral-500">No settings available.</p>';
    return `
      <div class="settings-group-body">
        <header class="settings-group-header">
          <h3 class="settings-group-title">${Utils.escapeHTML(group.label)}</h3>
          <p class="settings-group-description">${Utils.escapeHTML(group.description || '')}</p>
        </header>
        ${group.sections.map((s) => this.renderSchemaSection(s)).join('')}
      </div>
    `;
  },

  switchGroup(groupId) {
    this.activeGroup = groupId;
    const host = document.getElementById('settings-advanced-body');
    if (host) host.innerHTML = this.renderAdvancedBody();
  },

  renderAdvancedBody() {
    return `${this.renderSchemaNav()}${this.renderSchemaGroup()}`;
  },

  /**
   * Everyday groups render up front. Timing, rate and retry values live in a collapsed
   * Advanced panel: their defaults suit almost everyone and a wrong value can get an
   * instance rate-limited.
   */
  renderSchemaShell() {
    const groups = this.schema?.groups || [];
    const simple = groups.filter((g) => !g.advanced);
    const hasAdvanced = groups.some((g) => g.advanced);
    return `
      ${simple.map((g) => this.renderSchemaGroup(g)).join('')}
      ${hasAdvanced ? `
        <details class="settings-advanced" ${this.advancedOpen ? 'open' : ''}
                 ontoggle="settings.advancedOpen = this.open">
          <summary class="settings-advanced-summary">
            Advanced - for troubleshooting
            <span class="settings-advanced-note">How often data refreshes, broker request limits,
              timeouts and retries. The defaults work for almost everyone.</span>
          </summary>
          <div id="settings-advanced-body">${this.renderAdvancedBody()}</div>
          <button type="button" class="btn btn-neutral btn-outline btn-sm mt-3"
                  onclick="settings.resetSettings()">Restore advanced defaults</button>
        </details>` : ''}
    `;
  },

  /**
   * Single delegated listener rather than inline oninput on every control - the JSON editors
   * re-render their own subtrees, which would drop directly-attached handlers.
   */
  bindSchemaInputs() {
    const host = document.getElementById('settings-schema-host');
    if (!host || host.dataset.bound === 'true') return;
    host.dataset.bound = 'true';
    host.addEventListener('input', (e) => {
      const input = e.target.closest('[data-key]');
      if (!input || !host.contains(input)) return;
      if (input.dataset.index !== undefined) return; // handled by the JSON editors
      this.handleSettingChange(input);
      this.updateFieldHint(input);
      this.updateSaveButton();
    });
    host.addEventListener('change', (e) => {
      const input = e.target.closest('[data-key]');
      if (!input || input.dataset.index !== undefined) return;
      this.handleSettingChange(input);
      this.updateFieldHint(input);
      this.updateSaveButton();
    });
  },

  /** Keep the "= 12 seconds" hint truthful as the operator types. */
  updateFieldHint(input) {
    const key = input.dataset.key;
    const hintEl = document.querySelector(`[data-hint-for="${CSS.escape(key)}"]`);
    if (!hintEl) return;
    const field = this.findSchemaField(key);
    if (!field) return;
    hintEl.textContent = this.fieldHint(field, input.value);
  },

  findSchemaField(key) {
    for (const g of this.schema?.groups || []) {
      for (const s of g.sections) {
        const f = s.fields.find((x) => x.key === key);
        if (f) return f;
      }
    }
    return null;
  },
});
