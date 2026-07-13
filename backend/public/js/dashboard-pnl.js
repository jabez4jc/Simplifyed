/**
 * Simplifyed Admin V2 - Dashboard: Daily P&L Snapshots view.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  async renderDailyPnlSnapshotsView() {
    const contentArea = document.getElementById('content-area');
    const today = this._formatDateInputValue(new Date());

    contentArea.innerHTML = `
      <div class="card mb-4">
        <div class="card-header">
          <h3 class="card-title">Daily P&L Snapshots</h3>
        </div>
        <div class="card-body">
          <div class="flex flex-wrap items-end gap-3">
            <div>
              <label class="form-label text-xs mb-1">Start Date (IST)</label>
              <input type="date" id="pnl-snapshots-start" class="form-input" value="${today}">
            </div>
            <div>
              <label class="form-label text-xs mb-1">End Date (IST)</label>
              <input type="date" id="pnl-snapshots-end" class="form-input" value="${today}">
            </div>
            <button class="btn btn-neutral btn-outline btn-sm" onclick="app.loadDailyPnlSnapshots()">
              Apply
            </button>
            <button class="btn btn-neutral btn-outline btn-sm" onclick="app.downloadDailyPnlSnapshots()">
              Download CSV
            </button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Snapshot Results</h3>
        </div>
        <div class="card-body" id="pnl-snapshots-table">
          <p class="text-sm text-neutral-500">Select a date range to load snapshots.</p>
        </div>
      </div>
    `;

    await this.loadDailyPnlSnapshots();
  }

  _formatDateInputValue(date) {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async loadDailyPnlSnapshots() {
    const startInput = document.getElementById('pnl-snapshots-start');
    const endInput = document.getElementById('pnl-snapshots-end');
    const tableContainer = document.getElementById('pnl-snapshots-table');
    if (!startInput || !endInput || !tableContainer) return;

    const start = startInput.value;
    const end = endInput.value;
    if (!start || !end) {
      tableContainer.innerHTML = '<p class="text-sm text-neutral-500">Start and end dates are required.</p>';
      return;
    }

    tableContainer.innerHTML = '<p class="text-sm text-neutral-500">Loading...</p>';

    try {
      const response = await api.getDailyPnlSnapshots({ start, end });
      const rows = response?.data || [];
      if (rows.length === 0) {
        tableContainer.innerHTML = '<p class="text-sm text-neutral-500">No snapshots found for this range.</p>';
        return;
      }

      tableContainer.innerHTML = `
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Instance</th>
                <th>Broker</th>
                <th class="text-right">P&L</th>
                <th class="text-right">Buy Trades</th>
                <th class="text-right">Sell Trades</th>
                <th class="text-right">Buy Value</th>
                <th class="text-right">Sell Value</th>
                <th class="text-right">Webhook Buy</th>
                <th class="text-right">Webhook Sell</th>
                <th class="text-right">Manual Buy</th>
                <th class="text-right">Manual Sell</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td>${Utils.escapeHTML(row.snapshot_date)}</td>
                  <td class="font-medium">${Utils.escapeHTML(row.instance_name)}</td>
                  <td>${Utils.escapeHTML(row.broker || '—')}</td>
                  <td class="text-right ${Utils.getPnLColorClass(row.total_pnl)}">${Utils.formatCurrency(row.total_pnl)}</td>
                  <td class="text-right">${Utils.formatNumber(row.buy_trades, 0)}</td>
                  <td class="text-right">${Utils.formatNumber(row.sell_trades, 0)}</td>
                  <td class="text-right">${Utils.formatCurrency(row.buy_value)}</td>
                  <td class="text-right">${Utils.formatCurrency(row.sell_value)}</td>
                  <td class="text-right">${Utils.formatNumber(row.webhook_buy_signals, 0)}</td>
                  <td class="text-right">${Utils.formatNumber(row.webhook_sell_signals, 0)}</td>
                  <td class="text-right">${Utils.formatNumber(row.manual_buy_signals, 0)}</td>
                  <td class="text-right">${Utils.formatNumber(row.manual_sell_signals, 0)}</td>
                  <td>${Utils.escapeHTML(row.updated_at || '')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (error) {
      tableContainer.innerHTML = `<p class="text-sm text-loss">Failed to load snapshots: ${Utils.escapeHTML(error.message)}</p>`;
    }
  }

  downloadDailyPnlSnapshots() {
    const startInput = document.getElementById('pnl-snapshots-start');
    const endInput = document.getElementById('pnl-snapshots-end');
    if (!startInput || !endInput) return;
    const start = startInput.value;
    const end = endInput.value;
    if (!start || !end) {
      Utils.showToast('Start and end dates are required', 'warning');
      return;
    }
    const params = new URLSearchParams({ start, end });
    window.location.href = `/api/v1/pnl-snapshots/export?${params.toString()}`;
  }
}.prototype));
