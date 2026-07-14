/**
 * Simplifyed Admin V2 - Dashboard: Watchlists - edit-watchlist/view-details modals.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Show edit watchlist modal
   */
  async showEditWatchlistModal(id) {
    try {
      // Fetch watchlist data
      const response = await api.getWatchlistById(id);
      const watchlist = response.data;
      const isBroadcast = this.isBroadcastWatchlist(watchlist);
      const webhookUrl = watchlist.webhook_url || `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>Edit Watchlist: ${Utils.escapeHTML(watchlist.name)}</h3>
          </div>
          <div class="modal-body">
            <form id="edit-watchlist-form">
              <input type="hidden" name="watchlist_id" value="${watchlist.id}">

              <div class="form-group">
                <label class="form-label">Watchlist Name *</label>
                <input type="text" name="name" class="form-input"
                       value="${Utils.escapeHTML(watchlist.name)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">Type</label>
                <div class="flex flex-col gap-2">
                  <label class="form-radio">
                    <input type="radio" name="type" value="standard" ${isBroadcast ? '' : 'checked'}>
                    <span>Standard (symbols + quick orders)</span>
                  </label>
                  <label class="form-radio">
                    <input type="radio" name="type" value="broadcast" ${isBroadcast ? 'checked' : ''}>
                    <span>Broadcast (TradingView webhook fan-out)</span>
                  </label>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Description</label>
                <textarea name="description" class="form-input" rows="3">${Utils.escapeHTML(watchlist.description || '')}</textarea>
              </div>

              <div class="form-group">
                <label class="form-label">TradingView buffer (%)</label>
                <input type="number" name="limit_buffer_pct" class="form-input" step="0.01" min="0"
                       value="${watchlist.limit_buffer_pct ?? ''}">
                <p class="text-xs text-neutral-500 mt-1">Used only for TradingView MARKET alerts on this watchlist.</p>
              </div>

              <div class="form-group">
                <label class="form-label">
                  <input type="checkbox" name="is_active"
                         ${watchlist.is_active ? 'checked' : ''}>
                  Active Watchlist
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem;">
                  Inactive watchlists won't be used for trading
                </small>
              </div>

              ${isBroadcast ? `
                <div class="form-group">
                  <label class="form-label">Webhook</label>
                  <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-xs text-neutral-500">Slug</p>
                        <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
                      </div>
                      ${watchlist.webhook_slug ? `<button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${watchlist.webhook_slug}')">Copy</button>` : ''}
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-xs text-neutral-500">Webhook URL</p>
                        <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
                      </div>
                      <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
                    </div>
                    <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. Targets are the instances assigned to this watchlist.</p>
                  </div>
                </div>
              ` : ''}
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Cancel
            </button>
            <button class="btn btn-buy" onclick="app.submitEditWatchlist()">
              Update Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load watchlist: ' + error.message, 'error');
    }
  }

  /**
   * Submit edit watchlist form
   */
  async submitEditWatchlist() {
    const form = document.getElementById('edit-watchlist-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Extract watchlist ID
    const watchlistId = parseInt(data.watchlist_id);
    delete data.watchlist_id;

    // Convert checkbox to boolean
    data.is_active = form.querySelector('input[name="is_active"]').checked;
    data.type = form.querySelector('input[name="type"]:checked')?.value || 'standard';
    if (data.limit_buffer_pct === '') {
      data.limit_buffer_pct = null;
    }

    try {
      await api.updateWatchlist(watchlistId, data);
      Utils.showToast('Watchlist updated successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * View watchlist details with symbols
   */
  async viewWatchlistDetails(id) {
    try {
      // Fetch watchlist and its symbols
      const [watchlistResponse, symbolsResponse] = await Promise.all([
        api.getWatchlistById(id),
        api.getWatchlistSymbols(id)
      ]);

      const watchlist = watchlistResponse.data;
      const symbols = symbolsResponse.data || [];
      const isBroadcast = this.isBroadcastWatchlist(watchlist);
      const webhookUrl = watchlist.webhook_url || `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
          <div class="modal-header">
            <div>
              <h3>Watchlist Details: ${Utils.escapeHTML(watchlist.name)}</h3>
              <p style="margin-top: 0.5rem; color: var(--color-neutral-600); font-size: 0.875rem;">
                ${Utils.escapeHTML(watchlist.description || 'No description')}
              </p>
            </div>
          </div>
          <div class="modal-body">
            <div class="mb-4">
              <h4 class="font-semibold mb-2">Watchlist Information</h4>
              <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
                <div>
                  <span class="text-neutral-600">Status:</span>
                  ${Utils.getStatusBadge(watchlist.is_active ? 'active' : 'inactive')}
                </div>
                <div>
                  <span class="text-neutral-600">Type:</span>
                  <strong>${isBroadcast ? 'Broadcast' : 'Standard'}</strong>
                </div>
                <div>
                  <span class="text-neutral-600">Created:</span>
                  ${Utils.formatRelativeTime(watchlist.created_at)}
                </div>
                <div>
                  <span class="text-neutral-600">Last Updated:</span>
                  ${Utils.formatRelativeTime(watchlist.updated_at)}
                </div>
                ${isBroadcast ? `
                  <div>
                    <span class="text-neutral-600">Instances:</span>
                    <strong>${(watchlist.instances || []).length}</strong>
                  </div>
                  <div>
                    <span class="text-neutral-600">Slug:</span>
                    <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
                  </div>
                ` : `
                  <div>
                    <span class="text-neutral-600">Total Symbols:</span>
                    <strong>${symbols.length}</strong>
                  </div>
                  <div></div>
                `}
              </div>
            </div>

            ${isBroadcast ? `
              <div class="mb-4">
                <h4 class="font-semibold mb-2">TradingView Webhook</h4>
                <div class="broadcast-card compact">
                  <div class="broadcast-card__row">
                    <div>
                      <p class="text-xs text-neutral-500">Webhook URL</p>
                      <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
                    </div>
                    <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
                  </div>
                  <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. Targets are the active instances assigned to this watchlist.</p>
                </div>
              </div>
              <div class="mb-4">
                <h4 class="font-semibold mb-2">Assigned Instances (${(watchlist.instances || []).length})</h4>
                ${(watchlist.instances || []).length === 0 ? '<p class="text-neutral-600 text-sm">No instances assigned.</p>' : `
                  <ul class="list">
                    ${(watchlist.instances || []).map(inst => `
                      <li class="list-item">
                        <div>
                          <div class="font-medium">${Utils.escapeHTML(inst.name || inst.host_url)}</div>
                          <div class="text-xs text-neutral-500">${Utils.escapeHTML(inst.host_url)}</div>
                        </div>
                        <span class="badge ${inst.is_active ? 'badge-success' : 'badge-neutral'}">
                          ${inst.is_active ? 'Active' : 'Paused'}
                        </span>
                      </li>
                    `).join('')}
                  </ul>
                `}
              </div>
            ` : `
              <div class="mb-4">
                <h4 class="font-semibold mb-2">Symbols (${symbols.length})</h4>
                ${symbols.length === 0 ? `
                  <p class="text-center text-neutral-600" style="padding: 2rem;">
                    No symbols in this watchlist
                  </p>
                ` : `
                  <div class="table-container" style="max-height: 400px; overflow-y: auto;">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Exchange</th>
                          <th>Symbol</th>
                          <th>Quantity Type</th>
                          <th>Quantity</th>
                          <th>Product</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${symbols.map(s => `
                          <tr>
                            <td><span class="badge badge-neutral">${Utils.escapeHTML(s.exchange)}</span></td>
                            <td class="font-medium">${Utils.escapeHTML(s.symbol)}</td>
                            <td>${Utils.escapeHTML(s.qty_type || 'FIXED')}</td>
                            <td>${s.qty_value || 1}</td>
                            <td><span class="badge badge-info">${Utils.escapeHTML(s.product_type || 'MIS')}</span></td>
                            <td>${s.is_enabled ?
          '<span class="badge badge-success">Enabled</span>' :
          '<span class="badge badge-neutral">Disabled</span>'
        }</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `}
              </div>
            `}
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Close
            </button>
            <button class="btn btn-buy" onclick="this.closest('.modal-overlay').remove(); app.showEditWatchlistModal(${id})">
              Edit Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load watchlist details: ' + error.message, 'error');
    }
  }
  renderPausedPlaceholder() { }
}.prototype));
