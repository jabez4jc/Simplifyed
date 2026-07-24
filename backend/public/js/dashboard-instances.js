/**
 * Simplifyed Admin V2 - Dashboard: Instances view + modals/bulk actions.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Instances View
   */
  async renderInstancesView() {
    const contentArea = document.getElementById('content-area');

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

    // This view intentionally does NOT write to the shared this.instances (which
    // ensureInstancesLoaded()/_buildPanelInstances() elsewhere treat as "active instances only,
    // already loaded, skip refetch") - the admin table needs to show and manage inactive
    // instances too, so it keeps its own local list instead of clobbering the shared cache.
    // (Previously this did `this.instances = instancesRes.data` here, which silently poisoned
    // the shared active-only cache with inactive instances for the rest of the session as soon
    // as an admin visited this page - causing Orders/Trades, which merge against this.instances,
    // to show inactive instances too.)
    let allInstances = instancesRes.data;
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
    allInstances = allInstances.map(instance => ({
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

    const searchValue = (this.instanceSearchQuery || '').toLowerCase();
    const filteredInstances = allInstances.filter(instance => {
      const haystack = [
        instance.name,
        instance.broker,
        instance.host_url,
        instance.market_data_role,
      ].join(' ').toLowerCase();
      return haystack.includes(searchValue);
    });

    contentArea.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">All Instances</h3>
          <button class="btn btn-buy" onclick="app.showAddInstanceModal()">
            + Add Instance
          </button>
        </div>
        <div class="p-4 flex items-center gap-3">
          <input
            type="text"
            class="form-input w-full max-w-md"
            placeholder="Search instances by name, broker, URL, or role..."
            value="${Utils.escapeHTML(this.instanceSearchQuery || '')}"
            oninput="app.handleInstanceSearch(this.value)"
          />
          <button class="btn btn-outline btn-sm" onclick="app.renderInstancesView()">Reset</button>
        </div>

        <!-- Bulk Actions Bar -->
        <div id="bulk-actions-bar" class="p-4 bulk-actions-bg border-b border-neutral-200" style="display: none;">
          <div class="flex items-center gap-4">
            <span id="selected-count" class="text-sm font-medium">0 selected</span>
            <div class="flex gap-2">
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.bulkSetActive(true)">
                Set Active
              </button>
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.bulkSetActive(false)">
                Set Inactive
              </button>
              <button class="btn btn-buy btn-sm" onclick="app.bulkSetAnalyzerMode(false)">
                Set Live Mode
              </button>
              <button class="btn btn-warning btn-sm" onclick="app.bulkSetAnalyzerMode(true)">
                Set Analyzer Mode
              </button>
            </div>
          </div>
        </div>

        <div class="table-container">
          ${this.renderInstancesTable(filteredInstances, true)}
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

    // Fixed widths for consistent alignment (12 cols without bulk checkbox)
    // [Name, Broker, Multiplier, Status, Health, Mode, Limits, P&L, Balance, Session Limits, Cutoff Reason, Actions]
    const baseColWidths = ['190px', '120px', '90px', '90px', '90px', '100px', '100px', '140px', '110px', '190px', '120px', '140px'];
    const colWidths = showBulkActions ? ['40px', ...baseColWidths] : baseColWidths;

    return `
      <table class="table instances-table">
        <colgroup>
          ${colWidths.map(w => `<col style="width:${w};">`).join('')}
        </colgroup>
        <thead>
            <tr>
              ${showBulkActions ? '<th><input type="checkbox" id="select-all-instances" onchange="app.toggleSelectAllInstances(this.checked)"></th>' : ''}
              <th>Name</th>
              <th>Broker</th>
              <th class="text-right">Multiplier</th>
              <th>Status</th>
              <th>Health</th>
              <th>Mode</th>
              <th>Limits</th>
              <th class="text-right">P&L</th>
              <th class="text-right">Balance</th>
              <th>Session Limits</th>
              <th>Cutoff Reason</th>
              <th>Actions</th>
            </tr>
        </thead>
        <tbody>
          ${instances.map(instance => `
            <tr>
              ${showBulkActions ? `<td><input type="checkbox" class="instances-bulk-checkbox" data-instance-id="${instance.id}" onchange="app.updateBulkActionsState()"></td>` : ''}
              <td class="font-medium">${Utils.escapeHTML(instance.name)}</td>
              <td>${Utils.escapeHTML(instance.broker || 'N/A')}</td>
              <td class="text-right">${instance.multiplier != null ? Utils.formatNumber(instance.multiplier, 0) : '1'}</td>
              <td>
                ${instance.is_active
        ? '<span class="badge badge-success">Active</span>'
        : '<span class="badge badge-neutral">Inactive</span>'}
              </td>
              <td>${Utils.getStatusBadge(instance.health_status || 'unknown')}</td>
              <td>
                ${instance.is_analyzer_mode
        ? '<span class="badge badge-warning">A</span>'
        : '<span class="badge badge-success">L</span>'}
              </td>
              <td>${this.renderLimitBadge(instance.limit_metrics)}</td>
              <td class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <span class="${Utils.getPnLColorClass(instance.total_pnl)}">
                    ${Utils.formatCurrency(instance.total_pnl || 0)}
                  </span>
                  ${instance.is_analyzer_mode
        ? '<span class="badge badge-warning">A</span>'
        : '<span class="badge badge-success">L</span>'}
                </div>
              </td>
              <td class="text-right">
                ${instance.available_balance != null
        ? Utils.formatCurrency(instance.available_balance)
        : '<span class="text-neutral-400">-</span>'}
              </td>
              <td>
                <div class="text-sm">
                  <div><span class="text-neutral-500">Target:</span> ${instance.session_target_profit != null ? Utils.formatCurrency(instance.session_target_profit) : '—'}</div>
                  <div><span class="text-neutral-500">Max Loss:</span> ${instance.session_max_loss != null ? Utils.formatCurrency(instance.session_max_loss) : '—'}</div>
                </div>
              </td>
              <td>
                ${instance.session_cutoff_reason
        ? `<div class="text-[11px] text-neutral-500 mt-1">${Utils.escapeHTML(instance.session_cutoff_reason.replace(/_/g, ' '))}</div>`
        : '<span class="text-neutral-400">—</span>'}
              </td>
              <td>
                <div class="flex gap-2">
                  <button class="btn btn-neutral btn-outline btn-sm"
                          onclick="app.refreshInstance(${instance.id})"
                          title="Refresh">
                    🔄
                  </button>
                  <button class="btn btn-neutral btn-outline btn-sm"
                          onclick="app.showEditInstanceModal(${instance.id})">
                    Edit
                  </button>
                  <button class="btn btn-${instance.is_analyzer_mode ? 'success' : 'warning'} btn-sm"
                          onclick="app.toggleAnalyzerMode(${instance.id}, ${!instance.is_analyzer_mode})">
                    ${instance.is_analyzer_mode ? 'Go Live' : 'Analyzer'}
                  </button>
                  <button class="btn btn-exit btn-sm"
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
   * Show add instance modal
   */
  showAddInstanceModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay instance-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Instance</h3>
        </div>
        <div class="modal-body">
          <form id="add-instance-form" class="instance-form-grid">
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
              <div class="form-label-row">
                <label class="form-label">Broker (auto-detected)</label>
                <button type="button" class="info-button"
                        title="Auto-detected from the OpenAlgo ping response."
                        aria-label="Broker auto-detected info">i</button>
              </div>
              <div class="form-inline-row">
                <input type="text" name="broker" id="instance-broker" class="form-input" readonly
                       placeholder="Click 'Test Connection' to detect">
                <button type="button" class="btn btn-neutral btn-outline btn-sm"
                        onclick="app.testInstanceConnection()">
                  Test Connection
                </button>
              </div>
              <small id="connection-status" class="form-help"></small>
            </div>

            <div class="form-group form-span-2">
              <label class="form-label">Verify API Key</label>
              <button type="button" class="btn btn-neutral btn-outline btn-sm" style="width: 100%;"
                      onclick="app.testInstanceApiKey()">
                Test API Key with Funds Endpoint
              </button>
              <small id="apikey-status" class="form-help"></small>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Market Data</label>
                <button type="button" class="info-button"
                        title="Enabled instances will be pooled and load-balanced for quotes/LTP/depth."
                        aria-label="Market data info">i</button>
              </div>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="market_data_enabled" class="form-checkbox">
                <span>Use this instance for market data</span>
              </label>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Broker WebSocket Quotes</label>
                <button type="button" class="info-button"
                        title="Enable only if the broker/OpenAlgo instance provides WS quotes; otherwise leave off to stay on REST polling."
                        aria-label="Broker WebSocket quotes info">i</button>
              </div>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="use_ws_quotes" class="form-checkbox" checked>
                <span>Use broker WebSocket for quotes/LTP (only if this instance supports it)</span>
              </label>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">MultiQuotes (optional)</label>
                <button type="button" class="info-button"
                        title="When enabled, watchlist polling uses batched requests (max 1 every 5 seconds) instead of one call per symbol."
                        aria-label="MultiQuotes info">i</button>
              </div>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="supports_multiquotes" class="form-checkbox">
                <span>Instance supports <a href="https://docs.openalgo.in/api-documentation/v1/data-api/multiquotes" target="_blank" rel="noopener">OpenAlgo MultiQuotes</a></span>
              </label>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Option Chain API (optional)</label>
                <button type="button" class="info-button"
                        title="When enabled, options resolution fetches up to 15 strikes with live quotes directly from the broker."
                        aria-label="Option chain info">i</button>
              </div>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="supports_option_chain" class="form-checkbox">
                <span>Instance supports OpenAlgo Option Chain endpoint (limited strikes with LTP)</span>
              </label>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Order Placement</label>
                <button type="button" class="info-button"
                        title="Disable to block order placement for this instance (still visible for monitoring)."
                        aria-label="Order placement info">i</button>
              </div>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="order_placement_enabled" class="form-checkbox" checked>
                <span>Allow order placement</span>
              </label>
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Instance Multiplier</label>
                <button type="button" class="info-button"
                        title="Scales order quantities for this instance (1-999)."
                        aria-label="Instance multiplier info">i</button>
              </div>
              <input type="number" name="multiplier" class="form-input" min="1" max="999" step="1" value="1">
            </div>

            <div class="form-group">
              <label class="form-label">Strategy Tag</label>
              <input type="text" name="strategy_tag" class="form-input" value="default">
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Session Target Profit</label>
                <button type="button" class="info-button"
                        title="Auto-switch to Analyze when this profit is reached within a session."
                        aria-label="Session target profit info">i</button>
              </div>
              <input type="number" name="session_target_profit" class="form-input" step="0.01" placeholder="5000">
            </div>

            <div class="form-group">
              <div class="form-label-row">
                <label class="form-label">Session Max Loss</label>
                <button type="button" class="info-button"
                        title="Auto-switch to Analyze when this loss is hit within a session."
                        aria-label="Session max loss info">i</button>
              </div>
              <input type="number" name="session_max_loss" class="form-input" step="0.01" placeholder="2000">
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.submitAddInstance()">
            Add Instance
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  /**
   * Submit add instance form
   */
  async submitAddInstance() {
    const form = document.getElementById('add-instance-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    data.market_data_enabled = form.querySelector('input[name="market_data_enabled"]').checked;
    data.use_ws_quotes = form.querySelector('input[name="use_ws_quotes"]').checked;
    data.supports_multiquotes = form.querySelector('input[name="supports_multiquotes"]').checked;
    data.supports_option_chain = form.querySelector('input[name="supports_option_chain"]').checked;
    data.order_placement_enabled = form.querySelector('input[name="order_placement_enabled"]').checked;

    try {
      await api.createInstance(data);
      Utils.showToast('Instance added successfully', 'success');

      // Close modal (no dirty-check - the save just succeeded)
      Utils.closeModal(document.querySelector('.modal-overlay'), { checkDirty: false });

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
              <label class="form-label">Type</label>
              <div class="flex flex-col gap-2">
                <label class="form-radio">
                  <input type="radio" name="type" value="standard" checked>
                  <span>Standard (symbols + quick orders)</span>
                </label>
                <label class="form-radio">
                  <input type="radio" name="type" value="broadcast">
                  <span>Broadcast (TradingView webhook fan-out; no symbols)</span>
                </label>
                <label class="form-radio">
                  <input type="radio" name="type" value="strategy">
                  <span>Strategy (multi-leg strategies, manual or TradingView webhook)</span>
                </label>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea name="description" class="form-input" rows="3"></textarea>
            </div>

            <div class="form-group">
              <label class="form-label">TradingView buffer (%)</label>
              <input type="number" name="limit_buffer_pct" class="form-input" step="0.01" min="0" placeholder="e.g., 0.5">
              <p class="text-xs text-neutral-500 mt-1">Used only for TradingView MARKET alerts on this watchlist.</p>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.submitAddWatchlist()">
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
    data.type = data.type || 'standard';
    if (data.limit_buffer_pct === '') {
      delete data.limit_buffer_pct;
    }

    try {
      await api.createWatchlist(data);
      Utils.showToast('Watchlist added successfully', 'success');

      // Close modal (no dirty-check - the save just succeeded)
      Utils.closeModal(document.querySelector('.modal-overlay'), { checkDirty: false });

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
  handleInstanceSearch(value) {
    this.instanceSearchQuery = value || '';
    this.renderInstancesView();
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
      modal.className = 'modal-overlay instance-modal';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>Edit Instance: ${Utils.escapeHTML(instance.name)}</h3>
          </div>
          <div class="modal-body">
            <form id="edit-instance-form" class="instance-form-grid">
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
                <div class="form-label-row">
                  <label class="form-label">API Key *</label>
                  <button type="button" class="info-button"
                          title="Update API key if credentials have changed."
                          aria-label="API key info">i</button>
                </div>
                <input type="text" name="api_key" id="edit-instance-api-key" class="form-input"
                       value="${Utils.escapeHTML(instance.api_key)}" required>
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Broker (auto-detected, read-only)</label>
                  <button type="button" class="info-button"
                          title="Broker is auto-detected from the OpenAlgo ping response."
                          aria-label="Broker auto-detected info">i</button>
                </div>
                <div class="form-inline-row">
                  <input type="text" name="broker" id="edit-instance-broker" class="form-input" readonly
                        value="${Utils.escapeHTML(instance.broker || 'N/A')}"
                        style="background-color: var(--color-neutral-100); cursor: not-allowed;">
                  <button type="button" class="btn btn-neutral btn-outline btn-sm"
                          onclick="app.testEditInstanceConnection()">
                    Test Connection
                  </button>
                </div>
                <small id="edit-connection-status" class="form-help"></small>
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Market Data</label>
                  <button type="button" class="info-button"
                          title="Enabled instances are pooled and load-balanced for quotes/LTP/depth."
                          aria-label="Market data info">i</button>
                </div>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="market_data_enabled" class="form-checkbox"
                         ${instance.market_data_enabled ? 'checked' : ''}>
                  <span>Use this instance for market data</span>
                </label>
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Broker WebSocket Quotes</label>
                  <button type="button" class="info-button"
                          title="Turn on only if the broker/OpenAlgo instance exposes WS quotes. Otherwise keep disabled."
                          aria-label="Broker WebSocket quotes info">i</button>
                </div>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="use_ws_quotes" class="form-checkbox"
                         ${instance.use_ws_quotes ? 'checked' : ''}>
                  <span>Use broker WebSocket for quotes/LTP (only if supported)</span>
                </label>
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">MultiQuotes (optional)</label>
                  <button type="button" class="info-button"
                          title="When enabled, watchlist polling uses batched requests (max 1 every 5 seconds) instead of one call per symbol."
                          aria-label="MultiQuotes info">i</button>
                </div>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="supports_multiquotes" class="form-checkbox"
                         ${instance.supports_multiquotes ? 'checked' : ''}>
                  <span>Instance supports <a href="https://docs.openalgo.in/api-documentation/v1/data-api/multiquotes" target="_blank" rel="noopener">OpenAlgo MultiQuotes</a></span>
                </label>
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Option Chain API (optional)</label>
                  <button type="button" class="info-button"
                          title="When enabled, options resolution fetches up to 15 strikes with live quotes directly from the broker."
                          aria-label="Option chain info">i</button>
                </div>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="supports_option_chain" class="form-checkbox"
                         ${instance.supports_option_chain ? 'checked' : ''}>
                  <span>Instance supports OpenAlgo Option Chain endpoint (limited strikes with LTP)</span>
                </label>
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Instance Multiplier</label>
                  <button type="button" class="info-button"
                          title="Scales order quantities for this instance (1-999)."
                          aria-label="Instance multiplier info">i</button>
                </div>
                <input type="number" name="multiplier" class="form-input" min="1" max="999" step="1"
                       value="${instance.multiplier ?? 1}">
              </div>

              <div class="form-group">
                <label class="form-label">Strategy Tag</label>
                <input type="text" name="strategy_tag" class="form-input"
                       value="${Utils.escapeHTML(instance.strategy_tag || 'default')}">
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Session Target Profit</label>
                  <button type="button" class="info-button"
                          title="Auto-switch to Analyze when this profit is reached within a session."
                          aria-label="Session target profit info">i</button>
                </div>
                <input type="number" name="session_target_profit" class="form-input" step="0.01"
                       value="${instance.session_target_profit ?? ''}">
              </div>

              <div class="form-group">
                <div class="form-label-row">
                  <label class="form-label">Session Max Loss</label>
                  <button type="button" class="info-button"
                          title="Auto-switch to Analyze when this loss is hit within a session."
                          aria-label="Session max loss info">i</button>
                </div>
                <input type="number" name="session_max_loss" class="form-input" step="0.01"
                       value="${instance.session_max_loss ?? ''}">
              </div>

              <div class="form-group form-span-2">
                <div class="form-label-row">
                  <label class="form-label">Order Placement</label>
                  <button type="button" class="info-button"
                          title="Disable to block order placement for this instance (still visible for monitoring)."
                          aria-label="Order placement info">i</button>
                </div>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="order_placement_enabled"
                         ${instance.order_placement_enabled ? 'checked' : ''}>
                  <span>Allow order placement</span>
                </label>
              </div>

              <div class="form-group form-span-2">
                <div class="form-label-row">
                  <label class="form-label">Active Instance</label>
                  <button type="button" class="info-button"
                          title="Inactive instances won't be polled or used for trading."
                          aria-label="Active instance info">i</button>
                </div>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="is_active"
                         ${instance.is_active ? 'checked' : ''}>
                  <span>Enabled</span>
                </label>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">
              Cancel
            </button>
            <button class="btn btn-buy" onclick="app.submitEditInstance()">
              Update Instance
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
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
    data.use_ws_quotes = form.querySelector('input[name="use_ws_quotes"]').checked;
    data.supports_multiquotes = form.querySelector('input[name="supports_multiquotes"]').checked;
    data.supports_option_chain = form.querySelector('input[name="supports_option_chain"]').checked;
    data.order_placement_enabled = form.querySelector('input[name="order_placement_enabled"]').checked;

    try {
      await api.updateInstance(instanceId, data);
      Utils.showToast('Instance updated successfully', 'success');

      // Close modal (no dirty-check - the save just succeeded)
      Utils.closeModal(document.querySelector('.modal-overlay'), { checkDirty: false });

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }
}.prototype));
