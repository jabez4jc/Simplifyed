/**
 * Simplifyed Admin V2 - Dashboard: Trades view.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  stopTradesPolling() {
    if (this.tradesPollingInterval) {
      clearInterval(this.tradesPollingInterval);
      this.tradesPollingInterval = null;
    }
  }

  updateTradesLastUpdatedDisplay(timestamp) {
    const label = document.getElementById('trades-last-updated');
    if (!label) return;
    if (!timestamp) {
      label.textContent = 'Waiting for updates…';
      return;
    }
    label.textContent = `Updated ${Utils.formatRelativeTime(new Date(timestamp).toISOString())}`;
  }

  /**
   * Render Trades View
   */
  async renderTradesView() {
    const contentArea = document.getElementById('content-area');
    this.stopTradesPolling();

    contentArea.innerHTML = `
      <div class="ops-page trades-page">
        <div class="ops-header">
          <div class="ops-title-wrap">
            <p class="ops-kicker">Tradebook</p>
            <h2 class="ops-title">Trades</h2>
            <p class="ops-subtitle">Live tradebook snapshots grouped by instance with auto-refresh.</p>
          </div>
          <div class="ops-controls">
            <span id="trades-last-updated" class="ops-meta">Waiting for updates…</span>
            <button class="btn btn-outline btn-sm" onclick="app.loadTrades()">
              Refresh
            </button>
          </div>
        </div>
        <div class="ops-panel" id="trades-panel">
          <div class="text-center text-neutral-500">Loading trades…</div>
        </div>
      </div>
    `;

    await this.loadTrades(false, { ensureView: false });
    if (!this.isPaused) {
      this.tradesPollingInterval = setInterval(() => this.loadTrades(true), 5000);
    }
  }

  async loadTrades(isAuto = false, options = {}) {
    const { ensureView = true } = options;
    const panel = document.getElementById('trades-panel');
    if (ensureView && !panel) {
      await this.renderTradesView();
      return;
    }

    try {
      const response = await api.getTradebook();
      await this.ensureInstancesLoaded();
      const payload = response.data || {};
      const merged = this._buildPanelInstances(payload, 'trades');
      const normalized = {
        ...payload,
        liveInstances: merged.liveInstances,
        analyzerInstances: merged.analyzerInstances,
      };
      this.tradesPayload = normalized;
      this.tradesLastUpdatedAt = normalized.fetchedAt || Date.now();
      this.renderTradesPanel(normalized);
      this.updateTradesLastUpdatedDisplay(this.tradesLastUpdatedAt);
    } catch (error) {
      const panel = document.getElementById('trades-panel');
      if (panel) {
        panel.innerHTML = `<p class="text-center text-error-600">${Utils.escapeHTML(error.message)}</p>`;
      }
      if (!isAuto) {
        Utils.showToast(`Failed to load trades: ${error.message}`, 'error');
      }
    }
  }

  renderTradesPanel(payload = {}) {
    if (!this.tradesInstanceStore) {
      this.tradesInstanceStore = new Map();
    }
    const panel = document.getElementById('trades-panel');
    if (!panel) return;

    let liveInstances = payload.liveInstances || [];
    let analyzerInstances = payload.analyzerInstances || [];

    if (!liveInstances.length && !analyzerInstances.length) {
      if (!this.instances || this.instances.length === 0) {
        this.ensureInstancesLoaded().then(() => {
          this.renderTradesPanel(payload);
        });
        return;
      }
      const merged = this._buildPanelInstances(payload, 'trades');
      liveInstances = merged.liveInstances;
      analyzerInstances = merged.analyzerInstances;
    }

    if (!liveInstances.length && !analyzerInstances.length) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No trades available.</p>';
      return;
    }

    const liveCount = liveInstances.reduce((acc, inst) => acc + (inst.trades?.length || 0), 0);
    const analyzerCount = analyzerInstances.reduce((acc, inst) => acc + (inst.trades?.length || 0), 0);

    panel.innerHTML = `
      <div class="ops-summary-grid">
        ${this.renderTradesSummary(payload.statistics || {})}
      </div>
      <div class="ops-section-grid">
        <section class="ops-section">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Live Execution</h3>
              <p class="ops-section-subtitle">Tradebook entries from live instances.</p>
            </div>
            <span class="ops-count-pill">${liveCount} trades</span>
          </div>
          <div class="instance-grid">
            ${this.renderTradesSectionList(liveInstances, 'No live trades yet.')}
          </div>
        </section>
        <section class="ops-section">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Analyzer Mode</h3>
              <p class="ops-section-subtitle">Simulation trades grouped by analyzer instances.</p>
            </div>
            <span class="ops-count-pill">${analyzerCount} trades</span>
          </div>
          <div class="instance-grid">
            ${this.renderTradesSectionList(analyzerInstances, 'No analyzer trades yet.')}
          </div>
        </section>
      </div>
    `;
  }

  renderTradesSummary(stats = {}) {
    const totalTrades = stats.total_trades || 0;
    const buyTrades = stats.total_buy_trades || 0;
    const sellTrades = stats.total_sell_trades || 0;
    const notional = stats.total_value || 0;

    return `
      <div class="ops-summary-card">
        <div class="ops-summary-title">Total Trades</div>
        <div class="ops-summary-value">${totalTrades}</div>
        <div class="ops-summary-footnote">Live + Analyzer</div>
      </div>
      <div class="ops-summary-card">
        <div class="ops-summary-title">Buy / Sell</div>
        <div class="ops-summary-metric">
          <div>
            <span class="ops-summary-label">BUY</span>
            <span class="ops-summary-value-sm">${buyTrades}</span>
          </div>
          <div>
            <span class="ops-summary-label">SELL</span>
            <span class="ops-summary-value-sm">${sellTrades}</span>
          </div>
        </div>
      </div>
      <div class="ops-summary-card">
        <div class="ops-summary-title">Notional Value</div>
        <div class="ops-summary-value-sm">${Utils.formatCurrency(notional)}</div>
        <div class="ops-summary-footnote">Aggregated across instances</div>
      </div>
    `;
  }

  renderTradesSectionList(instances = [], emptyText = '') {
    if (!instances.length) {
      return `<div class="ops-empty">${emptyText}</div>`;
    }

    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    return sorted.map(inst => {
      this.tradesInstanceStore.set(String(inst.instance_id), inst.trades || []);
      const isOpen = this.tradesExpanded.has(String(inst.instance_id));
      return this.buildTradesInstance(inst, isOpen);
    }).join('');
  }

  ensureTradesLayout(panel) {
    if (panel.dataset.initialized === 'true') return;
    panel.innerHTML = `
      <div class="space-y-3">
        <div id="trades-summary"></div>
        <div class="card">
          <div class="tabs">
            <button class="tab-button active" data-trades-tab="live" onclick="app.switchTradesTab('live')">
              Live
            </button>
            <button class="tab-button" data-trades-tab="analyzer" onclick="app.switchTradesTab('analyzer')">
              Analyzer
            </button>
          </div>
          <div class="tab-content">
            <div id="trades-tab-live" class="tab-panel"></div>
            <div id="trades-tab-analyzer" class="tab-panel hidden"></div>
          </div>
        </div>
      </div>
    `;
    panel.dataset.initialized = 'true';
  }

  updateTradesSummary(stats = {}) {
    const totalTrades = stats.total_trades || 0;
    const buyTrades = stats.total_buy_trades || 0;
    const sellTrades = stats.total_sell_trades || 0;
    const notional = stats.total_value || 0;
    const summary = document.getElementById('trades-summary');
    if (!summary) return;
    summary.innerHTML = `
      <div class="card bg-base-100 border border-base-200">
        <div class="p-3">
          <div class="grid grid-cols-3 gap-2">
            <div class="border border-base-200 rounded-lg p-2 text-center">
              <div class="text-sm text-neutral-600 mb-1">Total Trades</div>
              <div class="text-3xl font-semibold">${totalTrades}</div>
            </div>
            <div class="border border-base-200 rounded-lg p-2 text-center">
              <div class="text-sm text-neutral-600 mb-1">Buy / Sell</div>
              <div class="text-2xl font-semibold">${buyTrades} / ${sellTrades}</div>
            </div>
            <div class="border border-base-200 rounded-lg p-2 text-center">
              <div class="text-sm text-neutral-600 mb-1">Notional Value</div>
              <div class="text-2xl font-semibold">${Utils.formatCurrency(notional)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  updateTradesSection(type, instances = []) {
    const container = document.getElementById(type === 'live' ? 'trades-tab-live' : 'trades-tab-analyzer');
    if (!container) return;
    const title = type === 'live' ? 'Live Instances' : 'Analyzer Mode Instances';
    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    const totalTrades = sorted.reduce((acc, inst) => acc + (inst.trades?.length || 0), 0);

    const tabButton = document.querySelector(`[data-trades-tab="${type}"]`);
    if (tabButton) {
      tabButton.textContent = `${type === 'live' ? 'Live' : 'Analyzer'} (${totalTrades})`;
    }

    const body = sorted.map(inst => {
      this.tradesInstanceStore.set(String(inst.instance_id), inst.trades || []);
      const isOpen = this.tradesExpanded.has(String(inst.instance_id));
      return this.buildTradesInstance(inst, isOpen);
    }).join('');
    container.innerHTML = `
      <div class="divide-y divide-base-200">
        ${body || `<div class="p-3 text-sm text-neutral-500">No trades in this category.</div>`}
      </div>
    `;

    this.attachTradesToggles(container);
  }

  buildTradesInstance(instanceEntry, preserveOpen = false) {
    const trades = instanceEntry.trades || [];
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const latestTrade = trades[0];
    const lastTradeTime = latestTrade
      ? (latestTrade.timestamp_iso
        ? Utils.formatDateTime(latestTrade.timestamp_iso, true)
        : Utils.escapeHTML(latestTrade.timestamp || ''))
      : '-';
    const bodyRows = this.renderTradesRows(trades);
    const shouldOpen = preserveOpen || trades.length > 0;

    return `
      <details class="instance-card" data-instance-id="${instanceEntry.instance_id}" ${shouldOpen ? 'open' : ''}>
        <summary class="instance-card-header">
          <div class="instance-info">
            <div class="instance-title">${Utils.escapeHTML(instanceEntry.instance_name)}</div>
            <div class="instance-meta">
              <span>Broker: ${broker}</span>
              <span>Total trades: ${trades.length}</span>
              <span>Last trade: ${lastTradeTime || '-'}</span>
            </div>
          </div>
          <div class="instance-actions">
            <span class="instance-pill">${trades.length} trades</span>
          </div>
        </summary>
        <div class="instance-card-body" id="trades-body-${instanceEntry.instance_id}">
          ${trades.length ? this.renderTradesTableShell(bodyRows) : '<div class="ops-empty">No trades yet.</div>'}
        </div>
      </details>
    `;
  }

  switchTradesTab(tab) {
    const tabs = document.querySelectorAll('[data-trades-tab]');
    tabs.forEach((btn) => {
      const isActive = btn.dataset.tradesTab === tab;
      btn.classList.toggle('active', isActive);
    });
    const livePanel = document.getElementById('trades-tab-live');
    const analyzerPanel = document.getElementById('trades-tab-analyzer');
    if (livePanel && analyzerPanel) {
      livePanel.classList.toggle('hidden', tab !== 'live');
      analyzerPanel.classList.toggle('hidden', tab !== 'analyzer');
    }
  }

  attachTradesToggles(container) {
    const detailsList = container.querySelectorAll('details.instance-section');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        const instanceId = details.dataset.instanceId;
        if (!instanceId) return;
        if (details.open) {
          this.tradesExpanded.add(String(instanceId));
        } else {
          this.tradesExpanded.delete(String(instanceId));
        }
      });
    });
  }

  renderTradesRows(trades = []) {
    return trades.map(trade => {
      const action = trade.action;
      const badgeClass = action === 'BUY'
        ? 'badge-success'
        : action === 'SELL'
          ? 'badge-error'
          : 'badge-neutral';
      const timestampDisplay = trade.timestamp_iso
        ? Utils.formatDateTime(trade.timestamp_iso, true)
        : Utils.escapeHTML(trade.timestamp || '-');
      const avgPriceDisplay = (trade.average_price ?? null) !== null
        ? Utils.formatNumber(trade.average_price)
        : '-';
      const tradeValueDisplay = (trade.trade_value ?? null) !== null
        ? Utils.formatCurrency(trade.trade_value)
        : '-';

      return `
        <tr>
          <td>${Utils.escapeHTML(trade.symbol || '-')}</td>
          <td>${Utils.escapeHTML(trade.exchange || '-')}</td>
          <td>
            <span class="badge ${badgeClass}">${action || '-'}</span>
          </td>
          <td>${trade.quantity ?? '-'}</td>
          <td>${Utils.escapeHTML(trade.product || '-')}</td>
          <td>${avgPriceDisplay}</td>
          <td>${tradeValueDisplay}</td>
          <td class="text-right">${timestampDisplay}</td>
        </tr>
      `;
    }).join('');
  }

  renderTradesTableShell(rowsHtml) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Avg Price</th>
              <th>Trade Value</th>
              <th class="text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="8" class="text-center text-neutral-500">No trades</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

}.prototype));
