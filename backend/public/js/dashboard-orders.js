/**
 * Simplifyed Admin V2 - Dashboard: Orders view.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Orders View
   */
  async renderOrdersView() {
    const contentArea = document.getElementById('content-area');
    this.currentOrderFilter = this.currentOrderFilter || '';

    contentArea.innerHTML = `
      <div class="ops-page orders-page">
        <div class="ops-header">
          <div class="ops-title-wrap">
            <p class="ops-kicker">Order Flow</p>
            <h2 class="ops-title">Orders</h2>
            <p class="ops-subtitle">Realtime orderbook with broker rollups and instance health context.</p>
          </div>
          <div class="ops-controls">
            <select id="orders-filter" class="form-select" onchange="app.filterOrders(this.value)">
              <option value="">All Status</option>
              <option value="pending">Pending</option>
              <option value="open">Open</option>
              <option value="complete">Complete</option>
              <option value="cancelled">Cancelled</option>
              <option value="rejected">Rejected</option>
            </select>
            <button class="btn btn-outline btn-sm" onclick="app.loadOrders()">
              Refresh
            </button>
            <button class="btn btn-exit btn-sm" onclick="app.cancelAllOpenOrdersGlobal()">
              Cancel All Open
            </button>
          </div>
        </div>

        <div class="ops-panel" id="orders-panel">
          <div class="text-center text-neutral-500">Loading orders…</div>
        </div>

        <div class="ops-panel">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Order History</h3>
              <p class="ops-section-subtitle">Stored watchlist orders with provenance fields.</p>
            </div>
            <div class="ops-inline-actions">
              <input id="order-history-instance" class="input input-bordered input-sm" placeholder="Instance ID" />
              <input id="order-history-status" class="input input-bordered input-sm" placeholder="Status" />
              <button class="btn btn-outline btn-sm" onclick="app.loadOrderHistory()">Refresh</button>
            </div>
          </div>
          <div class="ops-panel-body" id="order-history-panel">
            <div class="text-center text-neutral-500">Loading order history…</div>
          </div>
        </div>

        <div class="ops-panel">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Quick Orders</h3>
              <p class="ops-section-subtitle">Quick order ledger with provenance and broker sync status.</p>
            </div>
            <div class="ops-inline-actions">
              <input id="quick-orders-instance" class="input input-bordered input-sm" placeholder="Instance ID" />
              <input id="quick-orders-days" class="input input-bordered input-sm" placeholder="Days" value="7" />
              <button class="btn btn-outline btn-sm" onclick="app.loadQuickOrdersHistory()">Refresh</button>
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.syncQuickOrdersHistory()">Sync Broker Status</button>
            </div>
          </div>
          <div class="ops-panel-body" id="quick-orders-panel">
            <div class="text-center text-neutral-500">Loading quick orders…</div>
          </div>
        </div>
      </div>
    `;

    await this.loadOrders(this.currentOrderFilter, { ensureView: false, refresh: true });
    await this.loadOrderHistory();
    await this.loadQuickOrdersHistory();
  }

  async loadOrders(status = '', options = {}) {
    const { ensureView = true, refresh = false } = options;
    const panel = document.getElementById('orders-panel');
    if (ensureView && !panel) {
      await this.renderOrdersView();
      return;
    }

    try {
      const params = {};
      if (status) params.status = status;
      const response = await api.getOrderbook(status, { refresh });
      await this.ensureInstancesLoaded();
      const payload = response.data || {};
      const merged = this._buildPanelInstances(payload, 'orders');
      const normalized = {
        ...payload,
        liveInstances: merged.liveInstances,
        analyzerInstances: merged.analyzerInstances,
      };
      this.orderbookPayload = normalized;
      this.renderOrdersPanel(normalized);
      const select = document.getElementById('orders-filter');
      if (select) select.value = status || '';
    } catch (error) {
      console.error('Failed to load orders:', error);
      const panel = document.getElementById('orders-panel');
      if (panel) {
        panel.innerHTML = `<p class="text-error text-center">${error.message}</p>`;
      }
    }
  }

  async loadOrderHistory() {
    const panel = document.getElementById('order-history-panel');
    if (!panel) return;
    try {
      const instanceInput = document.getElementById('order-history-instance');
      const statusInput = document.getElementById('order-history-status');
      const filters = {};
      if (instanceInput?.value) filters.instanceId = instanceInput.value.trim();
      if (statusInput?.value) filters.status = statusInput.value.trim();
      const response = await api.getOrders(filters);
      this.renderOrderHistoryTable(response.data || []);
    } catch (error) {
      panel.innerHTML = `<p class="text-error text-center">${error.message}</p>`;
    }
  }

  renderOrderHistoryTable(orders = []) {
    const panel = document.getElementById('order-history-panel');
    if (!panel) return;
    if (!orders.length) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No order history found.</p>';
      return;
    }

    const rows = orders.map((order) => `
      <tr>
        <td>${Utils.escapeHTML(order.symbol || '-')}</td>
        <td>${Utils.escapeHTML(order.exchange || '-')}</td>
        <td>${Utils.escapeHTML(order.side || '-')}</td>
        <td>${order.quantity ?? '-'}</td>
        <td>${Utils.escapeHTML(order.status || '-')}</td>
        <td>${Utils.escapeHTML(order.instance_name || order.instance_id || '-')}</td>
        <td>${Utils.escapeHTML(order.watchlist_name || order.watchlist_id || '-')}</td>
        <td>${Utils.escapeHTML(order.source || '-')}</td>
        <td>${Utils.escapeHTML(order.trigger_type || '-')}</td>
        <td class="text-xs">${Utils.escapeHTML(order.request_id || '-')}</td>
        <td class="text-xs">${Utils.escapeHTML(order.correlation_id || '-')}</td>
        <td>${Utils.escapeHTML(order.user_id || '-')}</td>
        <td class="text-right">${Utils.formatDateTime(order.placed_at, true)}</td>
      </tr>
    `).join('');

    panel.innerHTML = `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Status</th>
              <th>Instance</th>
              <th>Watchlist</th>
              <th>Source</th>
              <th>Trigger</th>
              <th>Request ID</th>
              <th>Correlation</th>
              <th>User ID</th>
              <th class="text-right">Placed</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async loadQuickOrdersHistory() {
    const panel = document.getElementById('quick-orders-panel');
    if (!panel) return;
    try {
      const instanceInput = document.getElementById('quick-orders-instance');
      const filters = { limit: 200 };
      if (instanceInput?.value) filters.instanceId = instanceInput.value.trim();
      const response = await api.getQuickOrders(filters);
      this.renderQuickOrdersTable(response.data || []);
    } catch (error) {
      panel.innerHTML = `<p class="text-error text-center">${error.message}</p>`;
    }
  }

  renderQuickOrdersTable(orders = []) {
    const panel = document.getElementById('quick-orders-panel');
    if (!panel) return;
    if (!orders.length) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No quick orders found.</p>';
      return;
    }

    const rows = orders.map((order) => `
      <tr>
        <td>${Utils.escapeHTML(order.underlying || '-')}</td>
        <td>${Utils.escapeHTML(order.symbol || '-')}</td>
        <td>${Utils.escapeHTML(order.exchange || '-')}</td>
        <td>${Utils.escapeHTML(order.action || '-')}</td>
        <td>${Utils.escapeHTML(order.trade_mode || '-')}</td>
        <td>${order.quantity ?? '-'}</td>
        <td>${Utils.escapeHTML(order.status || '-')}</td>
        <td>${Utils.escapeHTML(order.broker_status || '-')}</td>
        <td>${Utils.escapeHTML(order.source || '-')}</td>
        <td>${Utils.escapeHTML(order.trigger_type || '-')}</td>
        <td class="text-xs">${Utils.escapeHTML(order.request_id || '-')}</td>
        <td class="text-xs">${Utils.escapeHTML(order.correlation_id || '-')}</td>
        <td>${Utils.escapeHTML(order.user_id || '-')}</td>
        <td class="text-right">${Utils.formatDateTime(order.created_at, true)}</td>
        <td class="text-right">${order.last_sync_at ? Utils.formatDateTime(order.last_sync_at, true) : '-'}</td>
      </tr>
    `).join('');

    panel.innerHTML = `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Underlying</th>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Action</th>
              <th>Mode</th>
              <th>Qty</th>
              <th>Status</th>
              <th>Broker Status</th>
              <th>Source</th>
              <th>Trigger</th>
              <th>Request ID</th>
              <th>Correlation</th>
              <th>User ID</th>
              <th class="text-right">Created</th>
              <th class="text-right">Last Sync</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async syncQuickOrdersHistory() {
    try {
      const instanceInput = document.getElementById('quick-orders-instance');
      const daysInput = document.getElementById('quick-orders-days');
      const instanceId = instanceInput?.value ? parseInt(instanceInput.value, 10) : null;
      if (!instanceId || Number.isNaN(instanceId)) {
        Utils.showToast('Enter a valid Instance ID to sync', 'error');
        return;
      }
      const days = daysInput?.value ? parseInt(daysInput.value, 10) : 7;
      await api.syncQuickOrders(instanceId, days);
      Utils.showToast('Quick orders synced', 'success');
      await this.loadQuickOrdersHistory();
    } catch (error) {
      Utils.showToast(`Failed to sync quick orders: ${error.message}`, 'error');
    }
  }

  renderOrdersPanel(orders = []) {
    const panel = document.getElementById('orders-panel');
    if (!panel) return;

    if (!orders || (!orders.liveInstances?.length && !orders.analyzerInstances?.length)) {
      if (!this.instances || this.instances.length === 0) {
        this.ensureInstancesLoaded().then(() => {
          this.renderOrdersPanel(orders);
        });
        return;
      }
      const merged = this._buildPanelInstances(orders, 'orders');
      orders = {
        ...orders,
        liveInstances: merged.liveInstances,
        analyzerInstances: merged.analyzerInstances,
      };
    }

    const liveInstances = orders.liveInstances || [];
    const analyzerInstances = orders.analyzerInstances || [];
    const liveCount = liveInstances.reduce((acc, inst) => acc + (inst.orders?.length || 0), 0);
    const analyzerCount = analyzerInstances.reduce((acc, inst) => acc + (inst.orders?.length || 0), 0);

    panel.innerHTML = `
      <div class="ops-summary-grid">
        ${this.renderOrdersSummary(orders)}
      </div>
      <div class="ops-section-grid">
        <section class="ops-section">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Live Execution</h3>
              <p class="ops-section-subtitle">Active broker instances running in live mode.</p>
            </div>
            <span class="ops-count-pill">${liveCount} orders</span>
          </div>
          <div class="instance-grid">
            ${this.renderOrdersSectionList(liveInstances, 'No orders in Live mode.')}
          </div>
        </section>
        <section class="ops-section">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Analyzer Mode</h3>
              <p class="ops-section-subtitle">Paper-trading instances with full orderbook visibility.</p>
            </div>
            <span class="ops-count-pill">${analyzerCount} orders</span>
          </div>
          <div class="instance-grid">
            ${this.renderOrdersSectionList(analyzerInstances, 'No orders in Analyzer mode.')}
          </div>
        </section>
      </div>
    `;

    this.attachOrdersToggles(panel);
  }

  renderOrdersSummary(payload) {
    const stats = payload.statistics || {};
    const liveOrders = payload.liveInstances?.flatMap(inst => inst.orders || []) || [];
    const analyzerOrders = payload.analyzerInstances?.flatMap(inst => inst.orders || []) || [];
    const allOrders = [...liveOrders, ...analyzerOrders];
    const total = allOrders.length;
    const statusCounts = {};
    allOrders.forEach(order => {
      statusCounts[order.status || 'unknown'] = (statusCounts[order.status || 'unknown'] || 0) + 1;
    });

    const badgeOrder = ['pending', 'open', 'complete', 'cancelled', 'rejected'];
    const badges = badgeOrder
      .map(status => `
        <span class="ops-chip ${status}">
          <span class="ops-chip-label">${status}</span>
          <span class="ops-chip-value">${statusCounts[status] || 0}</span>
        </span>
      `).join('');

    return `
      <div class="ops-summary-card">
        <div class="ops-summary-title">Total orders</div>
        <div class="ops-summary-value">${total}</div>
        <div class="ops-chip-row">
          ${badges}
        </div>
      </div>
      <div class="ops-summary-card">
        <div class="ops-summary-title">Buy vs Sell</div>
        <div class="ops-summary-metric">
          <div>
            <span class="ops-summary-label">BUY</span>
            <span class="ops-summary-value-sm">${stats.total_buy_orders || 0}</span>
          </div>
          <div>
            <span class="ops-summary-label">SELL</span>
            <span class="ops-summary-value-sm">${stats.total_sell_orders || 0}</span>
          </div>
        </div>
        <div class="ops-summary-footnote">Includes Live + Analyzer instances</div>
      </div>
      <div class="ops-summary-card">
        <div class="ops-summary-title">Open Exposure</div>
        <div class="ops-summary-metric">
          <div>
            <span class="ops-summary-label">Open/Pending</span>
            <span class="ops-summary-value-sm">${stats.total_open_orders || 0}</span>
          </div>
          <div>
            <span class="ops-summary-label">Rejected</span>
            <span class="ops-summary-value-sm">${stats.total_rejected_orders || 0}</span>
          </div>
        </div>
        <div class="ops-summary-footnote">Snapshot based on OpenAlgo orderbook</div>
      </div>
    `;
  }

  renderOrdersSectionList(instances = [], emptyText = 'No orders available.') {
    if (!instances.length) {
      return `<div class="ops-empty">${emptyText}</div>`;
    }

    return instances.map(instance => this.renderOrderInstanceCard(
      instance,
      this.ordersExpanded.has(String(instance.instance_id))
    )).join('');
  }

  switchOrdersTab(tab) {
    const tabs = document.querySelectorAll('[data-orders-tab]');
    tabs.forEach((btn) => {
      const isActive = btn.dataset.ordersTab === tab;
      btn.classList.toggle('active', isActive);
    });
    const livePanel = document.getElementById('orders-tab-live');
    const analyzerPanel = document.getElementById('orders-tab-analyzer');
    if (livePanel && analyzerPanel) {
      livePanel.classList.toggle('hidden', tab !== 'live');
      analyzerPanel.classList.toggle('hidden', tab !== 'analyzer');
    }
  }

  renderOrderInstanceCard(instanceEntry, isOpen = false) {
    const title = Utils.escapeHTML(instanceEntry.instance_name || `Instance ${instanceEntry.instance_id}`);
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const orders = instanceEntry.orders || [];
    const openOrders = orders.filter(o => ['open', 'pending'].includes(o.status)).length;

    return `
      <details class="instance-card" data-instance-id="${instanceEntry.instance_id}" ${isOpen || orders.length ? 'open' : ''}>
        <summary class="instance-card-header">
          <div class="instance-info">
            <div class="instance-title">${title}</div>
            <div class="instance-meta">
              <span>Broker: ${broker}</span>
              <span>Total: ${orders.length}</span>
              <span>Open/Pending: ${openOrders}</span>
            </div>
          </div>
          <div class="instance-actions">
            <span class="instance-pill">${orders.length} orders</span>
            <button
              type="button"
              class="btn btn-exit btn-sm"
              onclick="event.stopPropagation(); app.cancelAllOrders(${instanceEntry.instance_id})"
            >
              Cancel All Open
            </button>
          </div>
        </summary>
        <div class="instance-card-body">
          ${orders.length ? this.renderOrdersTable(orders) : '<div class="ops-empty">No orders for this instance.</div>'}
        </div>
      </details>
    `;
  }

  attachOrdersToggles(panel) {
    const detailsList = panel.querySelectorAll('details[data-instance-id]');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        const id = details.dataset.instanceId;
        if (!id) return;
        if (details.open) {
          this.ordersExpanded.add(String(id));
        } else {
          this.ordersExpanded.delete(String(id));
        }
      });
    });
  }

  renderOrdersTable(orders) {
    const rows = orders.map(order => {
      const safeValue = (...keys) => {
        for (const key of keys) {
          const parts = key.split('.');
          let value = order;
          for (const part of parts) {
            if (value && Object.prototype.hasOwnProperty.call(value, part)) {
              value = value[part];
            } else {
              value = undefined;
              break;
            }
          }

          if (value !== undefined && value !== null && value !== '') {
            return value;
          }
        }
        return '-';
      };

      const action = safeValue('action');
      const cancelable = ['pending', 'open'].includes(order.status);
      const orderId = order.id ? order.id.toString().replace(/'/g, "\\'") : '';
      const exchange = Utils.escapeHTML(safeValue('exchange', 'metadata.exchange'));
      const priceValue = safeValue('price', 'metadata.price', 'metadata.average_price');
      const priceDisplay = priceValue !== '-' ? Utils.formatNumber(priceValue) : '-';
      const strategy = Utils.escapeHTML(safeValue('strategy', 'metadata.strategy')) || '-';
      const timestamp = safeValue('timestamp', 'metadata.timestamp', 'metadata.placed_at');
      const placedAt = timestamp && timestamp !== '-' ? Utils.formatDateTime(timestamp, true) : '-';
      const statusValue = (safeValue('status', 'metadata.order_status') || 'unknown').toLowerCase();
      const rejectionReason = safeValue('metadata.rejection_reason', 'metadata.rejectionReason');
      const resolvedSymbol = safeValue('resolved_symbol', 'metadata.resolved_symbol', 'metadata.symbol');
      let statusBadge = Utils.getStatusBadge(statusValue);
      if (statusValue === 'rejected' && rejectionReason) {
        const escapedReason = Utils.escapeHTML(rejectionReason);
        statusBadge = statusBadge.replace('>', ` title="${escapedReason}">`);
      }
      const rejectionLine = statusValue === 'rejected' && rejectionReason
        ? `<div class="text-xs text-neutral-500 mt-1">${Utils.escapeHTML(rejectionReason)}</div>`
        : '';

      return `
        <tr>
          <td>${Utils.escapeHTML(safeValue('symbol', 'metadata.symbol'))}</td>
          <td class="text-xs text-neutral-600">${Utils.escapeHTML(resolvedSymbol)}</td>
          <td>${exchange}</td>
          <td>
            <span class="badge ${action === 'BUY' ? 'badge-success' : 'badge-error'}">
              ${action}
            </span>
          </td>
          <td>${priceDisplay !== '-' ? `₹${priceDisplay}` : priceDisplay}</td>
          <td>${safeValue('quantity', 'metadata.quantity')}</td>
          <td>${Utils.escapeHTML(safeValue('product', 'product_type', 'metadata.product'))}</td>
          <td>${Utils.escapeHTML(safeValue('order_type', 'metadata.pricetype'))}</td>
          <td>${strategy}</td>
          <td>${statusBadge}${rejectionLine}</td>
          <td class="text-right">${placedAt}</td>
          <td class="text-center">
            ${cancelable ? `
              <button class="btn btn-sm btn-outline"
                      onclick="app.cancelOrder('${orderId}')">
                Cancel
              </button>
            ` : '-'}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Resolved</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Type</th>
              <th>Strategy</th>
              <th>Status</th>
              <th class="text-right">Timestamp</th>
              <th class="text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to cancel this order?',
      'Confirm Cancel'
    );

    if (!confirmed) return;

    try {
      await api.cancelOrder(orderId);
      Utils.showToast('Order cancelled', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async cancelAllOrders(instanceId) {
    const confirmed = await Utils.confirm(
      'Cancel all pending/open orders for this instance?',
      'Confirm Cancel All'
    );

    if (!confirmed) return;

    try {
      await api.cancelAllOrders(instanceId);
      Utils.showToast('Cancel-all request sent', 'success');
      await this.loadOrders(this.currentOrderFilter);
    } catch (error) {
      Utils.showToast('Failed to cancel orders: ' + error.message, 'error');
    }
  }

  async cancelAllOpenOrdersGlobal() {
    const payload = this.orderbookPayload;
    const allInstances = [
      ...(payload?.liveInstances || []),
      ...(payload?.analyzerInstances || []),
    ];
    const instancesWithOpen = allInstances
      .filter(inst => (inst.orders || []).some(order => {
        const status = (order.status || '').toLowerCase();
        return status === 'pending' || status === 'open';
      }));

    if (instancesWithOpen.length === 0) {
      Utils.showToast('No open/pending orders to cancel.', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Cancel open/pending orders across ${instancesWithOpen.length} instance(s)?`,
      'Confirm Global Cancel All'
    );
    if (!confirmed) return;

    try {
      const results = await Promise.allSettled(
        instancesWithOpen.map(inst => api.cancelAllOrders(inst.instance_id))
      );
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        Utils.showToast(`Some instances failed to cancel orders: ${failures.length}`, 'warning');
      } else {
        Utils.showToast('Cancel-all sent for all instances', 'success');
      }
      await this.loadOrders(this.currentOrderFilter);
    } catch (error) {
      Utils.showToast('Failed to cancel orders: ' + error.message, 'error');
    }
  }

  /**
   * Filter orders by status
   */
  async filterOrders(status) {
    this.currentOrderFilter = status || '';
    await this.loadOrders(this.currentOrderFilter);
  }

}.prototype));
