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
            <p class="ops-subtitle">Today's fills at each broker. Click an instance to see its trades.</p>
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
    this.tradesPollingInterval = setInterval(() => this.loadTrades(true), 5000);
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
      this.tradesLastUpdatedAt = normalized.fetchedAt || Date.now();
      this.renderTradesPanel(normalized);
      this.updateTradesLastUpdatedDisplay(this.tradesLastUpdatedAt);
    } catch (error) {
      if (!isAuto) {
        // Manual load/refresh: no prior data on screen to protect, show a retry card.
        if (panel) {
          panel.innerHTML = `
            <div class="text-center space-y-2 py-4">
              <p class="text-error">${Utils.escapeHTML(error.message || 'Failed to load trades')}</p>
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.loadTrades()">Retry</button>
            </div>
          `;
        }
      } else {
        // Background poll failure: leave the last-good trades table on screen, just toast.
        Utils.showToast(`Failed to refresh trades: ${error.message}`, 'error');
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
              <p class="ops-section-subtitle">Instances trading real money.</p>
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
              <p class="ops-section-subtitle">Instances in analyzer (paper-trading) mode - no real money.</p>
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
    // Collapsed by default: thousands of analyzer fills made this page 20,000px tall.
    const shouldOpen = preserveOpen;

    return `
      <details class="instance-card" data-instance-id="${instanceEntry.instance_id}" ${shouldOpen ? 'open' : ''}>
        <summary class="instance-card-header">
        ${Utils.chevron()}
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
            <span class="badge ${badgeClass}">${Utils.escapeHTML(action || '-')}</span>
          </td>
          <td>${trade.quantity ?? '-'}</td>
          <td>${Utils.escapeHTML(trade.product || '-')}</td>
          <td>${avgPriceDisplay}</td>
          <td>${tradeValueDisplay}</td>
          <td class="text-right">${timestampDisplay}</td>
        </tr>
      `;
    });
  }

  renderTradesTableShell(rowsHtml) {
    const tbody = rowsHtml.length
      ? Utils.renderCappedRows(rowsHtml, { colspan: 8, pageSize: 20 })
      : '<tr><td colspan="8" class="text-center text-neutral-500">No trades</td></tr>';
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
            ${tbody}
          </tbody>
        </table>
      </div>
    `;
  }

}.prototype));
