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
      const isStrategy = this.isStrategyWatchlist(watchlist);
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
                    <input type="radio" name="type" value="standard" ${(isBroadcast || isStrategy) ? '' : 'checked'}>
                    <span>Standard (symbols + quick orders)</span>
                  </label>
                  <label class="form-radio">
                    <input type="radio" name="type" value="broadcast" ${isBroadcast ? 'checked' : ''}>
                    <span>Broadcast (TradingView webhook fan-out)</span>
                  </label>
                  <label class="form-radio">
                    <input type="radio" name="type" value="strategy" ${isStrategy ? 'checked' : ''}>
                    <span>Strategy (multi-leg strategies, manual or TradingView webhook)</span>
                  </label>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Description</label>
                <textarea name="description" class="form-input" rows="3">${Utils.escapeHTML(watchlist.description || '')}</textarea>
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
            <button class="btn btn-neutral btn-outline" onclick="Utils.closeModal(this)">
              Cancel
            </button>
            <button class="btn btn-buy" onclick="app.submitEditWatchlist()">
              Update Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
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

    try {
      await api.updateWatchlist(watchlistId, data);
      Utils.showToast('Watchlist updated successfully', 'success');

      // Close modal (no dirty-check - the save just succeeded)
      Utils.closeModal(document.querySelector('.modal-overlay'), { checkDirty: false });

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

 
}.prototype));
