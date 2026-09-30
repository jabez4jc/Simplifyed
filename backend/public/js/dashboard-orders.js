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
    await this.ensureInstancesLoaded();

    contentArea.innerHTML = `
      <div class="ops-page orders-page">
        <div class="ops-header">
          <div class="ops-title-wrap">
            <p class="ops-kicker">Order Flow</p>
            <h2 class="ops-title">Orders</h2>
            <p class="ops-subtitle">Today's orders at each broker. Instances with open orders are expanded; click any other to see its orders.</p>
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
              <h3 class="ops-section-title">Order history</h3>
              <p class="ops-section-subtitle">Every order this app sent - from watchlists, strategies and webhooks - newest first.</p>
            </div>
            <div class="ops-inline-actions">
              <select id="order-history-instance" class="form-select" onchange="app.loadOrderHistory()">
                <option value="">All instances</option>
                ${(this.instances || []).map((i) => `<option value="${i.id}">${Utils.escapeHTML(i.name)}</option>`).join('')}
              </select>
              <select id="order-history-status" class="form-select" onchange="app.loadOrderHistory()">
                <option value="">Any status</option>
                <option value="complete">Filled</option>
                <option value="open">Open</option>
                <option value="rejected">Rejected / failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <button class="btn btn-outline btn-sm" onclick="app.loadOrderHistory()">Refresh</button>
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.syncQuickOrdersHistory()"
                      title="Ask the broker for the latest status of recent orders">Update from broker</button>
            </div>
          </div>
          <div class="ops-panel-body" id="order-history-panel">
            <div class="text-center text-neutral-500">Loading order history…</div>
          </div>
        </div>
      </div>
    `;

    // Side by side: the history is local and instant, and must not wait on every broker's book.
    await Promise.all([
      this.loadOrders(this.currentOrderFilter, { ensureView: false, refresh: true }),
      this.loadOrderHistory(),
    ]);
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
        panel.innerHTML = `
          <div class="text-center space-y-2 py-4">
            <p class="text-error">${Utils.escapeHTML(error.message || 'Failed to load orders')}</p>
            <button class="btn btn-neutral btn-outline btn-sm" onclick="app.loadOrders(app.currentOrderFilter, { refresh: true })">Retry</button>
          </div>
        `;
      }
    }
  }

  async loadOrderHistory() {
    const panel = document.getElementById('order-history-panel');
    if (!panel) return;
    try {
      const instanceId = document.getElementById('order-history-instance')?.value || '';
      const status = document.getElementById('order-history-status')?.value || '';
      const filters = instanceId ? { instanceId } : {};
      // Two ledgers record orders: broker orders (watchlist_orders) and the click that caused
      // them (quick_orders). Show one list: broker rows win, clicks that never reached the
      // broker (refused, failed) are added so nothing goes missing.
      const [placed, quick] = await Promise.all([
        api.getOrders(filters).then((r) => r.data || []),
        api.getQuickOrders({ ...filters, limit: 500 }).then((r) => r.data || []).catch(() => []),
      ]);
      const names = new Map((this.instances || []).map((i) => [String(i.id), i.name]));
      const seen = new Set(placed.map((o) => String(o.order_id || '')).filter(Boolean));
      const rows = [
        ...placed.map((o) => ({
          at: o.placed_at, instance: o.instance_name || names.get(String(o.instance_id)),
          symbol: o.symbol, exchange: o.exchange, side: o.side, quantity: o.quantity,
          product: o.product_type, status: o.status, message: o.message, source: o.source,
        })),
        ...quick.filter((q) => !q.order_id || !seen.has(String(q.order_id))).map((q) => ({
          at: q.created_at, instance: names.get(String(q.instance_id)),
          symbol: q.resolved_symbol || q.symbol, exchange: q.exchange, side: q.action,
          quantity: q.quantity, product: q.product, status: q.broker_status || q.status,
          message: q.reason || q.message, source: q.source,
        })),
      ];
      const wanted = (row) => {
        if (!status) return true;
        const st = String(row.status || '').toLowerCase();
        if (status === 'rejected') return st === 'rejected' || st === 'failed' || st === 'error';
        if (status === 'open') return st === 'open' || st === 'pending' || st === 'trigger pending';
        return st === status || (status === 'complete' && st === 'success');
      };
      this.renderOrderHistoryTable(
        rows.filter(wanted).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      );
    } catch (error) {
      panel.innerHTML = `
        <div class="text-center space-y-2 py-4">
          <p class="text-error">${Utils.escapeHTML(error.message || 'Failed to load order history')}</p>
          <button class="btn btn-neutral btn-outline btn-sm" onclick="app.loadOrderHistory()">Retry</button>
        </div>
      `;
    }
  }

  renderOrderHistoryTable(orders = []) {
    const panel = document.getElementById('order-history-panel');
    if (!panel) return;
    if (!orders.length) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No orders yet.</p>';
      return;
    }
    const sourceLabel = (src) => ({
      quickorder: 'Watchlist', watchlist_quick_action: 'Watchlist', manual_batch: 'Watchlist',
      strategy_manual: 'Strategy', strategy_webhook: 'Webhook', webhook: 'Webhook',
      manual: 'Manual', auto_exit: 'Auto-exit', live_test: 'Test', live_test_cleanup: 'Test',
    })[src] || (src ? String(src).replace(/_/g, ' ') : '-');

    const rowsHtml = orders.map((o) => `
      <tr>
        <td class="text-xs">${Utils.formatDateTime(o.at, true)}</td>
        <td>${Utils.escapeHTML(o.instance || '-')}</td>
        <td>${Utils.escapeHTML(o.symbol || '-')} <span class="text-xs text-neutral-500">${Utils.escapeHTML(o.exchange || '')}</span></td>
        <td>${Utils.escapeHTML(o.side || '-')}</td>
        <td>${o.quantity ?? '-'}</td>
        <td>${Utils.escapeHTML(o.product || '-')}</td>
        <td>${Utils.escapeHTML(o.status || '-')}</td>
        <td>${Utils.escapeHTML(sourceLabel(o.source))}</td>
        <td class="text-xs">${Utils.escapeHTML(o.message || '')}</td>
      </tr>
    `);

    panel.innerHTML = `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Instance</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Status</th>
              <th>From</th>
              <th>Broker message</th>
            </tr>
          </thead>
          <tbody>${Utils.renderCappedRows(rowsHtml, { colspan: 9 })}</tbody>
        </table>
      </div>
    `;
  }

  async syncQuickOrdersHistory() {
    const selected = document.getElementById('order-history-instance')?.value;
    const ids = selected
      ? [selected]
      : (this.instances || []).filter((i) => i.is_active).map((i) => i.id);
    const results = await Promise.allSettled(ids.map((id) => api.syncQuickOrders(id, 7)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    Utils.showToast(
      failed ? `Updated from broker (${failed} instance${failed > 1 ? 's' : ''} failed)` : 'Updated from broker',
      failed ? 'warning' : 'success'
    );
    await this.loadOrderHistory();
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
              <p class="ops-section-subtitle">Instances trading real money.</p>
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
              <p class="ops-section-subtitle">Instances in analyzer (paper-trading) mode - no real money.</p>
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
        <div class="ops-summary-footnote">From each broker's order book</div>
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


  renderOrderInstanceCard(instanceEntry, isOpen = false) {
    const title = Utils.escapeHTML(instanceEntry.instance_name || `Instance ${instanceEntry.instance_id}`);
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const orders = instanceEntry.orders || [];
    const openOrders = orders.filter(o => ['open', 'pending'].includes(o.status)).length;

    return `
      <details class="instance-card" data-instance-id="${instanceEntry.instance_id}" ${isOpen || openOrders ? 'open' : ''}>
        <summary class="instance-card-header">
        ${Utils.chevron()}
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
    const rowsHtml = orders.map(order => {
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
    });

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
            ${Utils.renderCappedRows(rowsHtml, { colspan: 12, pageSize: 20 })}
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
