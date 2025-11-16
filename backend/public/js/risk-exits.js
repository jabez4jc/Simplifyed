/**
 * Risk Exits Module
 * Monitors and displays automated risk exits (TP/SL/TSL)
 */

const RiskExits = {
  refreshInterval: null,
  autoRefresh: true,

  /**
   * Render risk exits dashboard
   */
  renderDashboard(containerId = 'content-area') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
      <!-- Stats Cards -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Exits (7d)</div>
          <div class="stat-value" id="re-total-exits">-</div>
          <div class="stat-change">Loading...</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">TP Exits</div>
          <div class="stat-value text-success" id="re-tp-exits">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">SL Exits</div>
          <div class="stat-value text-danger" id="re-sl-exits">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">TSL Exits</div>
          <div class="stat-value text-warning" id="re-tsl-exits">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total P&L (7d)</div>
          <div class="stat-value" id="re-total-pnl">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg P&L per Exit</div>
          <div class="stat-value" id="re-avg-pnl">-</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="card">
        <div class="flex items-center gap-4">
          <div class="form-group mb-0" style="flex: 1;">
            <label for="re-filter-status">Status</label>
            <select id="re-filter-status" class="form-control">
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="executing">Executing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <div class="form-group mb-0" style="flex: 1;">
            <label for="re-filter-instance">Instance</label>
            <select id="re-filter-instance" class="form-control">
              <option value="">All Instances</option>
            </select>
          </div>
          <div class="form-group mb-0" style="flex: 1;">
            <label for="re-filter-limit">Limit</label>
            <select id="re-filter-limit" class="form-control">
              <option value="25">25</option>
              <option value="50" selected>50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
          <div style="padding-top: 1.5rem;">
            <button class="btn btn-primary" onclick="RiskExits.loadExits()">
              Apply Filters
            </button>
          </div>
        </div>
      </div>

      <!-- Risk Exits Table -->
      <div class="card">
        <div class="flex items-center justify-between mb-4">
          <h3>Risk Exits</h3>
          <div>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                id="re-auto-refresh"
                checked
                onchange="RiskExits.toggleAutoRefresh(this.checked)"
              >
              <span>Auto-refresh (5s)</span>
            </label>
          </div>
        </div>

        <div id="re-exits-container">
          <p class="text-neutral-600">Loading risk exits...</p>
        </div>
      </div>
    `;

    // Load instances for filter
    RiskExits.loadInstancesFilter();

    // Load data
    RiskExits.loadStats();
    RiskExits.loadExits();

    // Setup auto-refresh
    if (RiskExits.autoRefresh) {
      RiskExits.startAutoRefresh();
    }
  },

  /**
   * Load instances for filter
   */
  async loadInstancesFilter() {
    try {
      const response = await fetch('/api/v1/instances');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      const select = document.getElementById('re-filter-instance');
      if (!select) return;

      select.innerHTML = '<option value="">All Instances</option>';

      if (data.data && data.data.length > 0) {
        data.data.forEach(instance => {
          const option = document.createElement('option');
          option.value = instance.id;
          option.textContent = instance.name;
          select.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to load instances:', error);
    }
  },

  /**
   * Load statistics
   */
  async loadStats() {
    try {
      const response = await fetch('/api/v1/risk-exits/stats/summary?days=7');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === 'success' && data.data) {
        const stats = data.data;

        document.getElementById('re-total-exits').textContent = stats.total_exits || 0;
        document.getElementById('re-tp-exits').textContent = stats.tp_exits || 0;
        document.getElementById('re-sl-exits').textContent = stats.sl_exits || 0;
        document.getElementById('re-tsl-exits').textContent = stats.tsl_exits || 0;

        const totalPnl = stats.total_pnl || 0;
        const totalPnlClass = totalPnl >= 0 ? 'text-success' : 'text-danger';
        document.getElementById('re-total-pnl').textContent = formatCurrency(totalPnl);
        document.getElementById('re-total-pnl').className = `stat-value ${totalPnlClass}`;

        const avgPnl = stats.avg_pnl || 0;
        const avgPnlClass = avgPnl >= 0 ? 'text-success' : 'text-danger';
        document.getElementById('re-avg-pnl').textContent = formatCurrency(avgPnl);
        document.getElementById('re-avg-pnl').className = `stat-value ${avgPnlClass}`;

        // Update first stat card with executor info
        const statChange = document.querySelector('.stat-card .stat-change');
        if (statChange) {
          if (stats.executor && stats.executor.is_running) {
            statChange.textContent = `Executor running (${stats.executor.active_executions || 0} active)`;
            statChange.className = 'stat-change text-success';
          } else {
            statChange.textContent = 'Executor stopped';
            statChange.className = 'stat-change text-danger';
          }
        }
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
      if (typeof showToast === 'function') {
        showToast('Failed to load statistics', 'error');
      }
    }
  },

  /**
   * Load risk exits
   */
  async loadExits() {
    try {
      const status = document.getElementById('re-filter-status')?.value || '';
      const instanceId = document.getElementById('re-filter-instance')?.value || '';
      const limit = document.getElementById('re-filter-limit')?.value || 50;

      let url = `/api/v1/risk-exits?limit=${limit}`;
      if (status) url += `&status=${status}`;
      if (instanceId) url += `&instanceId=${instanceId}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      const container = document.getElementById('re-exits-container');
      if (!container) return;

      if (!data.data || data.data.length === 0) {
        container.innerHTML = '<p class="text-neutral-600">No risk exits found</p>';
        return;
      }

      let html = '<div class="table-responsive"><table class="table"><thead><tr>';
      html += '<th>Trigger ID</th>';
      html += '<th>Symbol</th>';
      html += '<th>Instance</th>';
      html += '<th>Type</th>';
      html += '<th>Qty</th>';
      html += '<th>Entry</th>';
      html += '<th>Trigger Price</th>';
      html += '<th>P&L per Unit</th>';
      html += '<th>Total P&L</th>';
      html += '<th>Status</th>';
      html += '<th>Triggered At</th>';
      html += '</tr></thead><tbody>';

      data.data.forEach(exit => {
        const statusClass = exit.status === 'completed' ? 'success' :
                          exit.status === 'failed' ? 'danger' :
                          exit.status === 'executing' ? 'warning' : 'secondary';

        const triggerClass = exit.trigger_type === 'TP_HIT' ? 'success' :
                           exit.trigger_type === 'SL_HIT' ? 'danger' : 'warning';

        const pnlClass = exit.pnl_per_unit >= 0 ? 'text-success' : 'text-danger';
        const totalPnlClass = exit.total_pnl >= 0 ? 'text-success' : 'text-danger';

        html += '<tr>';
        html += `<td><code class="text-xs">${exit.risk_trigger_id.substring(0, 8)}...</code></td>`;
        html += `<td><strong>${exit.symbol}</strong></td>`;
        html += `<td>${exit.instance_name || 'N/A'}</td>`;
        html += `<td><span class="badge badge-${triggerClass}">${exit.trigger_type}</span></td>`;
        html += `<td>${Math.abs(exit.qty_at_trigger)}</td>`;
        html += `<td>${formatPrice(exit.entry_at_trigger)}</td>`;
        html += `<td>${formatPrice(exit.trigger_price)}</td>`;
        html += `<td class="${pnlClass}"><strong>${formatPrice(exit.pnl_per_unit)}</strong></td>`;
        html += `<td class="${totalPnlClass}"><strong>${formatCurrency(exit.total_pnl)}</strong></td>`;
        html += `<td><span class="badge badge-${statusClass}">${exit.status}</span></td>`;
        html += `<td>${formatDateTime(exit.triggered_at)}</td>`;
        html += '</tr>';
      });

      html += '</tbody></table></div>';
      container.innerHTML = html;

    } catch (error) {
      console.error('Failed to load risk exits:', error);
      const container = document.getElementById('re-exits-container');
      if (container) {
        container.innerHTML = '<p class="text-danger">Failed to load risk exits</p>';
      }
      if (typeof showToast === 'function') {
        showToast('Failed to load risk exits', 'error');
      }
    }
  },

  /**
   * Start auto-refresh
   */
  startAutoRefresh() {
    if (RiskExits.refreshInterval) {
      clearInterval(RiskExits.refreshInterval);
    }

    RiskExits.refreshInterval = setInterval(() => {
      if (RiskExits.autoRefresh) {
        RiskExits.loadStats();
        RiskExits.loadExits();
      }
    }, 5000); // 5 second refresh
  },

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh() {
    if (RiskExits.refreshInterval) {
      clearInterval(RiskExits.refreshInterval);
      RiskExits.refreshInterval = null;
    }
  },

  /**
   * Toggle auto-refresh
   */
  toggleAutoRefresh(enabled) {
    RiskExits.autoRefresh = enabled;
    if (enabled) {
      RiskExits.startAutoRefresh();
    } else {
      RiskExits.stopAutoRefresh();
    }
  }
};

// Utility functions
function formatPrice(value) {
  if (!value && value !== 0) return '-';
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return '-';
  return numValue.toFixed(2);
}

function formatCurrency(value) {
  if (!value && value !== 0) return '₹0.00';
  const numValue = parseFloat(value);
  if (isNaN(numValue)) return '₹0.00';
  const formatted = Math.abs(numValue).toFixed(2);
  return numValue >= 0 ? `₹${formatted}` : `-₹${formatted}`;
}

function formatDateTime(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-IN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Make available globally
window.RiskExits = RiskExits;
