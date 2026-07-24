/**
 * Simplifyed Admin V2 - Dashboard: Positions view.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Positions View
   */
  async renderPositionsView() {
    const contentArea = document.getElementById('content-area');
    if (!this.positionsInstanceStore) {
      this.positionsInstanceStore = new Map();
    }

    try {
      await this.ensureInstancesLoaded();
      // Fetch cached open positions first for faster render
      const response = await api.getAllPositions({ onlyOpen: true, refresh: false });
      let data = response.data;
      let instances = Array.isArray(data?.instances) ? data.instances : [];
      if (!instances.length) {
        data = this._buildEmptyPositionsPayload();
        instances = Array.isArray(data?.instances) ? data.instances : [];
      }
      this.latestAllPositionsData = data;

      if (!instances.length) {
        contentArea.innerHTML = `
          <div class="card">
            <p class="text-center text-neutral-600">No active instances found</p>
          </div>
        `;
        return;
      }

      contentArea.innerHTML = `
        <div class="ops-page positions-page">
          <div class="ops-header">
            <div class="ops-title-wrap">
              <p class="ops-kicker">Risk Monitor</p>
              <h2 class="ops-title">Positions</h2>
              <p class="ops-subtitle">Open positions grouped by instance with live P&L context.</p>
            </div>
            <div class="ops-controls">
              <button class="btn btn-outline btn-sm" onclick="app.renderPositionsView()">
                Refresh
              </button>
              <button class="btn btn-outline btn-sm" onclick="app.toggleSnapshotResync()">
                Auto Resync: ${this.autoSnapshotResyncEnabled ? 'On' : 'Off'}
              </button>
              <button class="btn btn-outline btn-sm" onclick="app.resyncAllPositionsFromSnapshots()">
                Resync snapshots
              </button>
              <button class="btn btn-exit btn-sm" onclick="app.closeAllPositionsGlobal()">
                Close All Positions
              </button>
            </div>
          </div>
          <div class="ops-panel" id="positions-panel">
            <div class="text-center text-neutral-500">Loading positions…</div>
          </div>
        </div>
      `;

      this.renderPositionsPanel(data);
      // Background refresh for fresh data without blocking render
      setTimeout(async () => {
        try {
          const refreshed = await api.getAllPositions({ onlyOpen: true, refresh: true });
          this.latestAllPositionsData = refreshed.data;
          this.renderPositionsPanel(refreshed.data);
        } catch (_) { }
      }, 0);
    } catch (error) {
      contentArea.innerHTML = `
        <div class="card">
          <div class="p-4 text-center space-y-2">
            <p class="text-error">${Utils.escapeHTML(error.message || 'Failed to load positions')}</p>
            <button class="btn btn-neutral btn-outline btn-sm" onclick="app.renderPositionsView()">Retry</button>
          </div>
        </div>
      `;
    }
  }

  renderPositionsPanel(data = {}) {
    const panel = document.getElementById('positions-panel');
    if (!panel) return;
    let instances = Array.isArray(data.instances) ? data.instances : [];
    if (!instances.length) {
      if (!this.instances || this.instances.length === 0) {
        this.ensureInstancesLoaded().then(() => {
          this.renderPositionsPanel(data);
        });
        return;
      }
      data = this._buildEmptyPositionsPayload();
      instances = Array.isArray(data.instances) ? data.instances : [];
    }
    const liveInstances = instances.filter(inst => !inst.is_analyzer_mode);
    const analyzerInstances = instances.filter(inst => inst.is_analyzer_mode);
    const liveOpen = this._countOpenPositions(liveInstances);
    const analyzerOpen = this._countOpenPositions(analyzerInstances);

    panel.innerHTML = `
      <div class="ops-summary-grid">
        ${this.renderPositionsSummary(data)}
      </div>
      <div class="ops-section-grid">
        <section class="ops-section">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Live Exposure</h3>
              <p class="ops-section-subtitle">Open positions in live trading instances.</p>
            </div>
            <span class="ops-count-pill">${liveOpen} open</span>
          </div>
          <div class="instance-grid">
            ${this.renderPositionsSectionList(liveInstances, 'No open positions in Live mode.')}
          </div>
        </section>
        <section class="ops-section">
          <div class="ops-section-header">
            <div>
              <h3 class="ops-section-title">Analyzer Exposure</h3>
              <p class="ops-section-subtitle">Open positions in analyzer mode instances.</p>
            </div>
            <span class="ops-count-pill">${analyzerOpen} open</span>
          </div>
          <div class="instance-grid">
            ${this.renderPositionsSectionList(analyzerInstances, 'No open positions in Analyzer mode.')}
          </div>
        </section>
      </div>
    `;
    this.attachPositionsToggles(panel);
  }

  renderPositionsSummary(data = {}) {
    return `
      <div class="ops-summary-card">
        <div class="ops-summary-title">Open Positions</div>
        <div class="ops-summary-value">${data.overall_open_positions ?? 0}</div>
        <div class="ops-summary-footnote">Across all instances</div>
      </div>
      <div class="ops-summary-card">
        <div class="ops-summary-title">Closed Positions</div>
        <div class="ops-summary-value-sm">${data.overall_closed_positions ?? 0}</div>
        <div class="ops-summary-footnote">Session total</div>
      </div>
      <div class="ops-summary-card">
        <div class="ops-summary-title">Total P&L</div>
        <div class="ops-summary-value-sm ${Utils.getPnLColorClass(data.overall_total_pnl ?? 0)}">
          ${Utils.formatCurrency(data.overall_total_pnl ?? 0)}
        </div>
        <div class="ops-summary-footnote">Live + Analyzer</div>
      </div>
    `;
  }

  renderPositionsSectionList(instances = [], emptyText = '') {
    if (!instances.length) {
      return `<div class="ops-empty">${emptyText}</div>`;
    }

    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    return sorted.map(inst => {
      const id = String(inst.instance_id);
      const isOpen = this.positionsExpanded.has(id);
      this.positionsInstanceStore.set(id, inst.positions || []);
      return this.buildPositionsInstance(inst, isOpen);
    }).join('');
  }

  switchPositionsTab(tab) {
    const tabs = document.querySelectorAll('[data-positions-tab]');
    tabs.forEach((btn) => {
      const isActive = btn.dataset.positionsTab === tab;
      btn.classList.toggle('active', isActive);
    });
    const livePanel = document.getElementById('positions-tab-live');
    const analyzerPanel = document.getElementById('positions-tab-analyzer');
    if (livePanel && analyzerPanel) {
      livePanel.classList.toggle('hidden', tab !== 'live');
      analyzerPanel.classList.toggle('hidden', tab !== 'analyzer');
    }
  }

  _countOpenPositions(instances = []) {
    return instances.reduce((acc, inst) => {
      const count = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length;
      return acc + count;
    }, 0);
  }

  buildPositionsInstance(inst, isOpen) {
    const positions = inst.positions || [];
    const openCount = typeof inst.open_positions_count === 'number'
      ? inst.open_positions_count
      : positions.length;
    const closedCount = typeof inst.closed_positions_count === 'number'
      ? inst.closed_positions_count
      : 0;
    const header = `
      <summary class="instance-card-header">
        <div class="instance-info">
          <div class="instance-title">${Utils.escapeHTML(inst.instance_name)}</div>
          <div class="instance-meta">
            <span>Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
            <span>Open: <span class="font-medium">${openCount}</span></span>
            <span>Closed: <span class="font-medium">${closedCount}</span></span>
            <span>P&L:
              <span class="font-medium ${Utils.getPnLColorClass(inst.total_pnl)}">
                ${Utils.formatCurrency(inst.total_pnl)}
              </span>
            </span>
          </div>
        </div>
        <div class="instance-actions">
          <button class="btn btn-outline btn-sm"
                  onclick="event.stopPropagation(); app.resyncPositionsFromSnapshot(${inst.instance_id})">
            Resync
          </button>
          <button class="btn btn-exit btn-sm"
                  onclick="event.stopPropagation(); app.closeAllPositions(${inst.instance_id})">
            Close All
          </button>
        </div>
      </summary>
    `;

    return `
      <details class="instance-card" data-instance-id="${inst.instance_id}" ${isOpen || positions.length ? 'open' : ''}>
        ${header}
        <div class="instance-card-body instance-positions-body" data-loaded="${isOpen}">
          ${isOpen ? this.renderPositionsBody(positions, inst) : '<div class="ops-empty">Expand to view positions.</div>'}
        </div>
      </details>
    `;
  }

  renderPositionsBody(positions, inst) {
    if (inst.error) {
      return `<p class="text-center text-error-600 p-4">${Utils.escapeHTML(inst.error)}</p>`;
    }
    if (!positions || positions.length === 0) {
      return '<p class="text-center text-neutral-600 p-4">No positions</p>';
    }
    return this.renderPositionsTable(positions, inst.instance_id);
  }

  attachPositionsToggles(container) {
    const detailsList = container.querySelectorAll('details[data-instance-id]');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        const instanceId = details.dataset.instanceId;
        if (details.open) {
          this.positionsExpanded.add(String(instanceId));
          const body = details.querySelector('.instance-positions-body');
          if (body && body.dataset.loaded !== 'true') {
            const positions = this.positionsInstanceStore.get(String(instanceId)) || [];
            body.innerHTML = this.renderPositionsBody(positions, { instance_id: instanceId });
            body.dataset.loaded = 'true';
          }
        } else {
          this.positionsExpanded.delete(String(instanceId));
        }
      });
    });
  }

  async resyncPositionsFromSnapshot(instanceId) {
    try {
      const res = await api.getPositionSnapshot(instanceId, { refresh: true });
      const positions = res?.data?.positions || [];
      this.positionsInstanceStore.set(String(instanceId), positions);
      const body = document.querySelector(
        `details[data-instance-id="${instanceId}"] .instance-positions-body`
      );
      if (body) {
        body.innerHTML = this.renderPositionsBody(positions, { instance_id: instanceId });
        body.dataset.loaded = 'true';
      }
      Utils.showToast(`Positions resynced for instance ${instanceId}`, 'success');
    } catch (error) {
      console.error('Failed to resync positions snapshot', error);
      Utils.showToast('Failed to resync positions snapshot', 'error');
    }
  }

  async resyncAllPositionsFromSnapshots() {
    try {
      const instances = (this.latestAllPositionsData?.instances || []).map((i) => i.instance_id);
      if (!instances.length) {
        await this.renderPositionsView();
        return;
      }
      await Promise.all(
        instances.map((id) => api.getPositionSnapshot(id, { refresh: true }).catch(() => null))
      );
      await this.renderPositionsView();
      Utils.showToast('Positions resynced from snapshots', 'success');
    } catch (error) {
      console.error('Failed to resync all positions snapshots', error);
      Utils.showToast('Failed to resync all positions snapshots', 'error');
    }
  }

  toggleSnapshotResync() {
    this.autoSnapshotResyncEnabled = !this.autoSnapshotResyncEnabled;
    this.persistSnapshotResyncPreference(this.autoSnapshotResyncEnabled);
    Utils.showToast(`Auto snapshot resync ${this.autoSnapshotResyncEnabled ? 'enabled' : 'disabled'}`, 'info');
    // Restart interval if applicable
    if (['watchlists', 'positions'].includes(this.currentView)) {
      this.startSnapshotResync(this.currentView);
    }
    // Refresh UI buttons to reflect state
    if (this.currentView === 'positions') {
      this.renderPositionsView();
    } else if (this.currentView === 'watchlists') {
      this.renderWatchlistsView();
    }
  }
  /**
   * Close all positions
   */
  async closeAllPositions(instanceId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to close ALL positions for this instance?',
      'Confirm Close All'
    );

    if (!confirmed) return;

    try {
      await api.closePositions(instanceId);
      Utils.showToast('Close positions request sent', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }
}.prototype));
