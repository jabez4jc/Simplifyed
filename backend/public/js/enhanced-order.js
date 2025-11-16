/**
 * Enhanced Order Module
 * Handles template symbol support and target-based positioning
 */

const EnhancedOrder = {
  /**
   * Render enhanced order form
   */
  renderForm(containerId = 'content-area') {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
      <div class="card">
        <h3>Enhanced Order Placement</h3>
        <p class="text-neutral-600">Place orders with template symbols and target positioning</p>
      </div>

      <div class="card">
        <form id="enhanced-order-form">
          <!-- Instance Selection -->
          <div class="form-group">
            <label for="eo-instance">Instance *</label>
            <select id="eo-instance" class="form-control" required>
              <option value="">Select instance...</option>
            </select>
          </div>

          <!-- Watchlist Selection (Optional) -->
          <div class="form-group">
            <label for="eo-watchlist">Watchlist (Optional)</label>
            <select id="eo-watchlist" class="form-control">
              <option value="">None</option>
            </select>
          </div>

          <!-- Symbol Input with Template Support -->
          <div class="form-group">
            <label for="eo-symbol">Symbol *</label>
            <input
              type="text"
              id="eo-symbol"
              class="form-control"
              placeholder="NIFTY_ATM_CE or NIFTY24NOV24400CE"
              required
            >
            <div class="form-help">
              <strong>Template Examples:</strong><br>
              • NIFTY_ATM_CE - At the money call<br>
              • NIFTY_100ITM_PE - 100 points in the money put<br>
              • BANKNIFTY_50OTM_CE - 50 points out of the money call<br>
              • Or use actual symbol: NIFTY24NOV24400CE
            </div>
          </div>

          <!-- Exchange -->
          <div class="form-group">
            <label for="eo-exchange">Exchange *</label>
            <select id="eo-exchange" class="form-control" required>
              <option value="NFO">NFO</option>
              <option value="NSE">NSE</option>
              <option value="BSE">BSE</option>
              <option value="MCX">MCX</option>
            </select>
          </div>

          <!-- Target Quantity -->
          <div class="form-group">
            <label for="eo-target-qty">Target Position Quantity *</label>
            <input
              type="number"
              id="eo-target-qty"
              class="form-control"
              placeholder="50"
              min="0"
              step="1"
              required
            >
            <div class="form-help">
              Enter target position (not delta). Server calculates order quantity automatically.
            </div>
          </div>

          <!-- Index Name (for templates) -->
          <div class="form-group">
            <label for="eo-index">Index Name (for templates)</label>
            <select id="eo-index" class="form-control">
              <option value="">Auto-detect from symbol</option>
              <option value="NIFTY">NIFTY</option>
              <option value="BANKNIFTY">BANKNIFTY</option>
              <option value="FINNIFTY">FINNIFTY</option>
              <option value="MIDCPNIFTY">MIDCPNIFTY</option>
              <option value="SENSEX">SENSEX</option>
            </select>
          </div>

          <!-- Expiry (optional) -->
          <div class="form-group">
            <label for="eo-expiry">Expiry (YYYY-MM-DD, optional)</label>
            <input
              type="date"
              id="eo-expiry"
              class="form-control"
              placeholder="Leave empty for nearest expiry"
            >
          </div>

          <!-- Current Position Display -->
          <div id="eo-position-info" class="alert alert-info" style="display: none;">
            <strong>Current Position:</strong> <span id="eo-current-position">0</span> lots<br>
            <strong>Calculated Delta:</strong> <span id="eo-calculated-delta">0</span> lots
          </div>

          <!-- Submit Button -->
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="eo-submit-btn">
              Place Order
            </button>
            <button type="button" class="btn btn-secondary" onclick="EnhancedOrder.previewOrder()">
              Preview Delta
            </button>
            <button type="button" class="btn btn-secondary" onclick="app.switchView('watchlists')">
              Cancel
            </button>
          </div>
        </form>
      </div>

      <!-- Order Result -->
      <div id="eo-result" style="display: none;"></div>

      <!-- Recent Trade Intents -->
      <div class="card">
        <h3>Recent Trade Intents</h3>
        <div id="eo-recent-intents">
          <p class="text-neutral-600">Loading...</p>
        </div>
      </div>
    `;

    // Load instances and watchlists
    this.loadInstances();
    this.loadWatchlists();
    this.loadRecentIntents();

    // Setup form handler
    document.getElementById('enhanced-order-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitOrder();
    });

    // Auto-detect index from symbol
    document.getElementById('eo-symbol').addEventListener('input', (e) => {
      const symbol = e.target.value.toUpperCase();
      const indexSelect = document.getElementById('eo-index');

      if (symbol.startsWith('NIFTY')) {
        if (symbol.startsWith('BANKNIFTY')) {
          indexSelect.value = 'BANKNIFTY';
        } else if (symbol.startsWith('FINNIFTY')) {
          indexSelect.value = 'FINNIFTY';
        } else if (symbol.startsWith('MIDCPNIFTY')) {
          indexSelect.value = 'MIDCPNIFTY';
        } else {
          indexSelect.value = 'NIFTY';
        }
      } else if (symbol.startsWith('SENSEX')) {
        indexSelect.value = 'SENSEX';
      }
    });
  },

  /**
   * Load instances
   */
  async loadInstances() {
    try {
      const response = await fetch('/api/v1/instances');
      const data = await response.json();

      const select = document.getElementById('eo-instance');
      select.innerHTML = '<option value="">Select instance...</option>';

      if (data.data && data.data.length > 0) {
        data.data.forEach(instance => {
          if (instance.is_active && !instance.is_analyzer_mode) {
            const option = document.createElement('option');
            option.value = instance.id;
            option.textContent = `${instance.name} (${instance.broker})`;
            select.appendChild(option);
          }
        });
      }
    } catch (error) {
      console.error('Failed to load instances:', error);
      showToast('Failed to load instances', 'error');
    }
  },

  /**
   * Load watchlists
   */
  async loadWatchlists() {
    try {
      const response = await fetch('/api/v1/watchlists');
      const data = await response.json();

      const select = document.getElementById('eo-watchlist');
      select.innerHTML = '<option value="">None</option>';

      if (data.data && data.data.length > 0) {
        data.data.forEach(watchlist => {
          const option = document.createElement('option');
          option.value = watchlist.id;
          option.textContent = watchlist.name;
          select.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to load watchlists:', error);
    }
  },

  /**
   * Preview order delta
   */
  async previewOrder() {
    const instanceId = document.getElementById('eo-instance').value;
    const symbol = document.getElementById('eo-symbol').value;
    const targetQty = parseInt(document.getElementById('eo-target-qty').value, 10);

    if (!instanceId || !symbol || isNaN(targetQty)) {
      showToast('Please fill in instance, symbol, and target quantity', 'error');
      return;
    }

    showToast('Preview feature coming soon - will show current position and calculated delta', 'info');

    // TODO: Call API to get current position and calculate delta
    // For now, just show the info div
    document.getElementById('eo-position-info').style.display = 'block';
    document.getElementById('eo-current-position').textContent = '0';
    document.getElementById('eo-calculated-delta').textContent = targetQty;
  },

  /**
   * Submit enhanced order
   */
  async submitOrder() {
    const submitBtn = document.getElementById('eo-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Placing Order...';

    try {
      const formData = {
        instanceId: parseInt(document.getElementById('eo-instance').value, 10),
        symbol: document.getElementById('eo-symbol').value.trim(),
        exchange: document.getElementById('eo-exchange').value,
        targetQty: parseInt(document.getElementById('eo-target-qty').value, 10),
        context: {}
      };

      // Add optional fields
      const watchlistId = document.getElementById('eo-watchlist').value;
      if (watchlistId) {
        formData.watchlistId = parseInt(watchlistId, 10);
      }

      const indexName = document.getElementById('eo-index').value;
      if (indexName) {
        formData.context.indexName = indexName;
      }

      const expiry = document.getElementById('eo-expiry').value;
      if (expiry) {
        formData.context.expiry = expiry;
      }

      console.log('Placing enhanced order:', formData);

      const response = await fetch('/api/v1/orders/enhanced', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(formData)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Order placement failed');
      }

      // Show result
      this.showOrderResult(result);

      // Reload recent intents
      this.loadRecentIntents();

      showToast(result.message || 'Order placed successfully', 'success');

      // Reset form
      document.getElementById('enhanced-order-form').reset();
      document.getElementById('eo-position-info').style.display = 'none';

    } catch (error) {
      console.error('Order placement failed:', error);
      showToast(error.message || 'Failed to place order', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Place Order';
    }
  },

  /**
   * Show order result
   */
  showOrderResult(result) {
    const container = document.getElementById('eo-result');
    container.style.display = 'block';

    const data = result.data || {};

    if (data.delta === 0) {
      container.innerHTML = `
        <div class="alert alert-info">
          <h4>No Order Needed</h4>
          <p>${data.message || 'Already at target position'}</p>
        </div>
      `;
      return;
    }

    const action = data.delta > 0 ? 'BUY' : 'SELL';
    const actionClass = data.delta > 0 ? 'success' : 'danger';

    container.innerHTML = `
      <div class="alert alert-${actionClass}">
        <h4>Order Placed Successfully</h4>
        <table class="table">
          <tr>
            <td><strong>Intent ID:</strong></td>
            <td><code>${data.intent_id || 'N/A'}</code></td>
          </tr>
          <tr>
            <td><strong>Resolved Symbol:</strong></td>
            <td><strong>${data.resolved_symbol || 'N/A'}</strong></td>
          </tr>
          <tr>
            <td><strong>Action:</strong></td>
            <td><span class="badge badge-${actionClass}">${action} ${Math.abs(data.delta)} lots</span></td>
          </tr>
          ${data.order ? `
          <tr>
            <td><strong>Order ID:</strong></td>
            <td>${data.order.id}</td>
          </tr>
          <tr>
            <td><strong>Status:</strong></td>
            <td>${data.order.status}</td>
          </tr>
          ` : ''}
        </table>
      </div>
    `;

    // Scroll to result
    container.scrollIntoView({ behavior: 'smooth' });
  },

  /**
   * Load recent trade intents
   */
  async loadRecentIntents() {
    try {
      const response = await fetch('/api/v1/orders/intents?status=pending&limit=10');
      const data = await response.json();

      const container = document.getElementById('eo-recent-intents');

      if (!data.data || data.data.length === 0) {
        container.innerHTML = '<p class="text-neutral-600">No recent trade intents</p>';
        return;
      }

      let html = '<div class="table-responsive"><table class="table"><thead><tr>';
      html += '<th>Intent ID</th>';
      html += '<th>Symbol</th>';
      html += '<th>Action</th>';
      html += '<th>Target Qty</th>';
      html += '<th>Status</th>';
      html += '<th>Created</th>';
      html += '<th>Actions</th>';
      html += '</tr></thead><tbody>';

      data.data.forEach(intent => {
        const actionClass = intent.action === 'BUY' ? 'success' : 'danger';
        const statusClass = intent.status === 'completed' ? 'success' :
                          intent.status === 'failed' ? 'danger' : 'warning';

        html += '<tr>';
        html += `<td><code class="text-xs">${intent.intent_id.substring(0, 8)}...</code></td>`;
        html += `<td>${intent.symbol}</td>`;
        html += `<td><span class="badge badge-${actionClass}">${intent.action}</span></td>`;
        html += `<td>${intent.target_qty}</td>`;
        html += `<td><span class="badge badge-${statusClass}">${intent.status}</span></td>`;
        html += `<td>${new Date(intent.created_at).toLocaleString()}</td>`;
        html += `<td>`;
        if (intent.status === 'failed') {
          html += `<button class="btn btn-sm btn-secondary" onclick="EnhancedOrder.retryIntent('${intent.intent_id}')">Retry</button>`;
        }
        html += `</td>`;
        html += '</tr>';
      });

      html += '</tbody></table></div>';
      container.innerHTML = html;

    } catch (error) {
      console.error('Failed to load trade intents:', error);
      document.getElementById('eo-recent-intents').innerHTML =
        '<p class="text-danger">Failed to load trade intents</p>';
    }
  },

  /**
   * Retry failed intent
   */
  async retryIntent(intentId) {
    if (!confirm('Retry this failed trade intent?')) {
      return;
    }

    try {
      const response = await fetch(`/api/v1/orders/intents/${intentId}/retry`, {
        method: 'POST'
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Retry failed');
      }

      showToast('Intent reset for retry', 'success');
      this.loadRecentIntents();

    } catch (error) {
      console.error('Retry failed:', error);
      showToast(error.message || 'Failed to retry intent', 'error');
    }
  }
};

// Make available globally
window.EnhancedOrder = EnhancedOrder;
