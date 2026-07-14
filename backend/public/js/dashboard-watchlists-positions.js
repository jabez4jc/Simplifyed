/**
 * Simplifyed Admin V2 - Dashboard: Watchlists - linked positions panel (refresh/render/close-all).
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  async refreshWatchlistPositions({ showLoader = false, force = false } = {}) {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel) return;

    if (showLoader) {
      positionsPanel.innerHTML = '<div class="p-4"><p class="text-center text-neutral-600">Loading positions…</p></div>';
    }

    try {
      // Fetch cached open positions; refresh live only when forced
      const response = await api.getAllPositions({ onlyOpen: true, refresh: force });
      const normalized = this.prepareWatchlistPositions(response.data);
      console.debug('[Watchlists] Positions payload', {
        instances: response.data?.instances?.length,
        normalizedLive: normalized.liveInstances.length,
        normalizedAnalyzer: normalized.analyzerInstances.length,
        rawSample: response.data?.instances?.slice?.(0, 2) || [],
      });
      this._updatePositionsPollingInterval(normalized.overallOpen > 0);
      this.latestWatchlistPositionsData = normalized;
      this.updateWatchlistPositionsSummary(normalized);
      positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(normalized);
    } catch (error) {
      console.error('Failed to refresh watchlist positions:', error);
      const message = Utils.escapeHTML(error?.message || 'Unknown error');
      positionsPanel.innerHTML = `<div class="p-4"><p class="text-center text-error-600">Failed to load positions: ${message}</p></div>`;
    }
  }

  renderWatchlistPositionsPanel() {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel || !this.latestWatchlistPositionsData) return;
    positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(this.latestWatchlistPositionsData);
  }

  toggleWatchlistPositionInstance(instanceId) {
    if (this.watchlistPositionsExpanded.has(instanceId)) {
      this.watchlistPositionsExpanded.delete(instanceId);
    } else {
      this.watchlistPositionsExpanded.add(instanceId);
    }
    this.renderWatchlistPositionsPanel();
  }

  updateWatchlistPositionsSummary({ overallOpen, overallPnl, refreshedAt }) {
    const summaryEl = document.getElementById('positions-summary-inline');
    if (!summaryEl) return;

    const relativeText = refreshedAt ? `Updated ${Utils.formatRelativeTime(refreshedAt)}` : 'Updated just now';
    const liveOpen = this.latestWatchlistPositionsData?.liveOpen ?? 0;
    const analyzerOpen = this.latestWatchlistPositionsData?.analyzerOpen ?? 0;
    const livePnl = this.latestWatchlistPositionsData?.livePnl ?? 0;
    const analyzerPnl = this.latestWatchlistPositionsData?.analyzerPnl ?? 0;
    summaryEl.innerHTML = `
      <div class="flex items-center gap-4 flex-wrap">
        <div class="positions-summary-group">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Live Open:</span>
          <span class="text-sm font-semibold text-neutral-900">${liveOpen}</span>
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Live P&amp;L:</span>
          <span class="text-sm font-semibold ${Utils.getPnLColorClass(livePnl)}">
            ${Utils.formatCurrency(livePnl)}
          </span>
        </div>
        <span class="positions-summary-divider"></span>
        <div class="positions-summary-group">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Analyzer Open:</span>
          <span class="text-sm font-semibold text-neutral-900">${analyzerOpen}</span>
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Analyzer P&amp;L:</span>
          <span class="text-sm font-semibold ${Utils.getPnLColorClass(analyzerPnl)}">
            ${Utils.formatCurrency(analyzerPnl)}
          </span>
        </div>
      </div>
      <span class="text-xs text-neutral-400 whitespace-nowrap">${relativeText}</span>
    `;
  }

  async closeAllOpenPositions() {
    if (!this.latestWatchlistPositionsData) {
      Utils.showToast('Positions not loaded yet', 'warning');
      return;
    }

    const instances = (this.latestWatchlistPositionsData.allInstances || []).filter(
      inst => (inst.positions && inst.positions.length > 0) ||
        (typeof inst.open_positions_count === 'number' && inst.open_positions_count > 0)
    );

    if (instances.length === 0) {
      Utils.showToast('No open positions to close', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Are you sure you want to close all open positions across ${instances.length} instance(s)?`,
      'Confirm Global Close'
    );
    if (!confirmed) return;

    try {
      const responses = await Promise.allSettled(
        instances.map(inst => api.closePositions(inst.instance_id))
      );

      const successes = responses.filter(r => r.status === 'fulfilled').length;
      const failures = responses
        .map((result, idx) => (result.status === 'rejected'
          ? { name: instances[idx].instance_name, error: result.reason?.message || 'Failed' }
          : null))
        .filter(Boolean);

      if (failures.length > 0) {
        Utils.showToast(
          `Closed ${successes} instance(s); ${failures.length} failed (e.g., ${failures[0].name})`,
          'warning',
          5000
        );
      } else {
        Utils.showToast(`Close-all request sent to ${successes} instance(s)`, 'success');
      }
      this.requestWatchlistRefresh({ showLoader: true, force: true });
    } catch (error) {
      Utils.showToast('Failed to close all positions: ' + error.message, 'error');
    }
  }

  async closeAllPositionsGlobal() {
    const data = this.latestAllPositionsData;
    if (!data || !Array.isArray(data.instances)) {
      Utils.showToast('Positions not loaded yet', 'warning');
      return;
    }

    const instances = data.instances.filter(inst => {
      const openCount = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length;
      return openCount > 0;
    });

    if (instances.length === 0) {
      Utils.showToast('No open positions to close', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Close all open positions across ${instances.length} instance(s)?`,
      'Confirm Global Close All'
    );
    if (!confirmed) return;

    try {
      const responses = await Promise.allSettled(
        instances.map(inst => api.closePositions(inst.instance_id))
      );
      const failures = responses.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        Utils.showToast(`Some instances failed to close positions: ${failures.length}`, 'warning');
      } else {
        Utils.showToast('Close-all sent for all instances', 'success');
      }
      await this.renderPositionsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async closePosition(instanceId, encodedSymbol, encodedExchange, encodedProduct) {
    const symbol = decodeURIComponent(encodedSymbol || '');
    const exchange = decodeURIComponent(encodedExchange || '');
    const product = decodeURIComponent(encodedProduct || 'MIS');

    if (!symbol || !exchange) {
      Utils.showToast('Unable to determine symbol/exchange for closing position', 'error');
      return;
    }

    const tradeMode = this.getTradeModeFromSymbol(symbol);
    const confirmed = await Utils.confirm(
      `Close position for ${symbol} on instance ${instanceId}?`,
      'Confirm Close'
    );
    if (!confirmed) return;

    try {
      await api.closePosition(instanceId, {
        symbol,
        exchange,
        tradeMode,
        product,
      });
      Utils.showToast(`Close request submitted for ${symbol}`, 'success');
      await this.refreshWatchlistPositions({ showLoader: false });
    } catch (error) {
      Utils.showToast(`Failed to close ${symbol}: ${error.message}`, 'error');
    }
  }

  getTradeModeFromSymbol(symbol) {
    const normalized = (symbol || '').toUpperCase();
    if (normalized.includes('CE') || normalized.includes('PE')) {
      return 'OPTIONS';
    }
    if (normalized.includes('FUT')) {
      return 'FUTURES';
    }
    return 'EQUITY';
  }

  prepareWatchlistPositions(data = {}) {
    const instances = (data.instances || []).map(inst => {
      const rawPositions = Array.isArray(inst.positions) ? inst.positions : [];
      let openPositions = rawPositions.filter(pos => this.getNormalizedPositionQty(pos) !== 0);

      const serverReportedOpen = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : openPositions.length;

      if (openPositions.length === 0 && serverReportedOpen > 0) {
        openPositions = rawPositions;
      }

      return {
        ...inst,
        positions: openPositions,
        open_positions_count: serverReportedOpen,
      };
    });

    const liveInstances = instances
      .filter(inst => !inst.is_analyzer_mode && inst.positions.length > 0);

    const analyzerInstances = instances
      .filter(inst => inst.is_analyzer_mode && inst.positions.length > 0);

    const sumOpen = (list) => list.reduce(
      (sum, inst) => sum + (typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length),
      0
    );
    const sumPnl = (list) => list.reduce(
      (sum, inst) => sum + (typeof inst.total_pnl === 'number' ? inst.total_pnl : 0),
      0
    );

    const liveOpen = sumOpen(liveInstances);
    const analyzerOpen = sumOpen(analyzerInstances);
    const livePnl = sumPnl(liveInstances);
    const analyzerPnl = sumPnl(analyzerInstances);

    const totalOpen = typeof data.overall_open_positions === 'number'
      ? data.overall_open_positions
      : instances.reduce(
        (sum, inst) => sum + (inst.open_positions_count ?? inst.positions.length),
        0
      );

    return {
      overallOpen: totalOpen,
      overallPnl: data.overall_total_pnl ?? 0,
      liveOpen,
      analyzerOpen,
      livePnl,
      analyzerPnl,
      liveInstances,
      analyzerInstances,
      refreshedAt: data.refreshed_at || new Date().toISOString(),
      allInstances: instances,
    };
  }

  renderWatchlistPositionsMarkup({ overallOpen, overallPnl, liveInstances, analyzerInstances, refreshedAt }) {
    if (liveInstances.length === 0 && analyzerInstances.length === 0) {
      return '<div class="p-4"><p class="text-center text-neutral-600">No open positions across any instance.</p></div>';
    }

    return `
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${this.renderPositionsSection(
      'Live Market Instances',
      'Instances actively executing trades',
      liveInstances
    )}
        ${this.renderPositionsSection(
      'Analyzer Mode Instances',
      'Instances running in analyzer/paper mode',
      analyzerInstances
    )}
      </div>
    `;
  }

  renderPositionsSection(title, subtitle, instances) {
    if (!instances || instances.length === 0) {
      return `
        <div class="card">
          <div class="card-header-compact">
            <div>
              <h3 class="card-title-compact">${title}</h3>
              <p style="font-size: 0.688rem;" class="text-neutral-600">${subtitle}</p>
            </div>
            <span class="badge-count-compact">0</span>
          </div>
          <div style="padding: 0.5rem;">
            <p style="font-size: 0.688rem;" class="text-neutral-500">No open positions in this category.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header-compact">
          <div>
            <h3 class="card-title-compact">${title}</h3>
            <p style="font-size: 0.688rem;" class="text-neutral-600">${subtitle}</p>
          </div>
          <span class="badge-count-compact">${instances.length}</span>
        </div>
        <div style="padding: 0.375rem; display: flex; flex-direction: column; gap: 0.375rem;">
          ${instances.map(inst => this.renderPositionsInstanceCard(inst)).join('')}
        </div>
      </div>
    `;
  }

  renderPositionsInstanceCard(inst) {
    const positions = inst.positions || [];
    const openCount = typeof inst.open_positions_count === 'number'
      ? inst.open_positions_count
      : positions.length;
    const isExpanded = this.watchlistPositionsExpanded.has(inst.instance_id);

    return `
      <div class="position-instance-card-compact">
        <div class="position-instance-header-compact">
          <button
            class="position-instance-toggle"
            onclick="app.toggleWatchlistPositionInstance(${inst.instance_id})"
            aria-expanded="${isExpanded}"
            aria-controls="positions-body-${inst.instance_id}"
          >
            <span class="toggle-icon ${isExpanded ? 'rotate-90' : ''}">▸</span>
            <span class="instance-name">${Utils.escapeHTML(inst.instance_name)}</span>
            <span class="instance-meta">Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
            <span class="instance-meta">Open: <span class="font-medium">${openCount}</span></span>
            <span class="instance-meta">P&L:
              <span class="font-semibold ${Utils.getPnLColorClass(inst.total_pnl)}">
                ${Utils.formatCurrency(inst.total_pnl)}
              </span>
            </span>
          </button>
          <button class="btn-close-all-compact" onclick="app.closeAllPositions(${inst.instance_id})">
            Close All
          </button>
        </div>
        <div id="positions-body-${inst.instance_id}" class="${isExpanded ? 'block' : 'hidden'} border-t border-base-200">
          <div style="padding: 0.25rem;">
            ${positions.length > 0
        ? this.renderPositionsTable(positions, inst.instance_id)
        : '<p style="font-size: 0.688rem;" class="text-neutral-500">No open positions for this instance.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  renderPositionsTable(positions, instanceId = null) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="positions-table-compact" style="table-layout: fixed; width: 100%;">
          <colgroup>
            <col style="width: 24%;">
            <col style="width: 12%;">
            <col style="width: 12%;">
            <col style="width: 14%;">
            <col style="width: 14%;">
            <col style="width: 12%;">
            <col style="width: 12%;">
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Quantity</th>
              <th>Product</th>
              <th class="text-left">Entry</th>
              <th class="text-left">LTP</th>
              <th class="text-left">P&L</th>
              <th class="text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${positions.map(pos => {
      const qty = this.getNormalizedPositionQty(pos);
      const entry = Number(
        pos.entry_price ??
        pos.average_price ??
        pos.avg_price ??
        pos.net_avg_price ??
        0
      ) || 0;
      const entrySourceRaw = pos.entry_price_source || pos.entryPriceSource || null;
      const entrySourceLabel = (() => {
        if (!entrySourceRaw) return (pos.average_price || pos.avg_price) ? 'BROKER' : '-';
        const base = entrySourceRaw.split(':')[0];
        const map = {
          broker_avg: 'BROKER',
          fallback_cache: 'FALLBACK (ORDER)',
          positionbook_fallback: 'POSITIONBOOK Fallback',
          median_ltp: 'Median LTP',
        };
        return map[base] || base.replace(/_/g, ' ').toUpperCase();
      })();

      const ltp = Number(
        pos.ltp_resolved ??
        pos.ltp ??
        pos.last_price ??
        pos.lastprice ??
        0
      ) || 0;
      const pnl = pos.pnl_derived != null
        ? pos.pnl_derived
        : (() => {
          if (entry && ltp && qty !== 0) {
            return qty > 0 ? (ltp - entry) * qty : (entry - ltp) * Math.abs(qty);
          }
          return parseFloat(pos.pnl || pos.unrealized_pnl || pos.mtm || 0);
        })();
      return `
                <tr>
                  <td class="font-medium">${Utils.escapeHTML(pos.symbol || pos.tradingsymbol || '-')}</td>
                  <td>${qty}</td>
                  <td>${Utils.escapeHTML(pos.product || pos.product_type || '-')}</td>
                  <td class="text-left">
                    ${Utils.formatCurrency(entry)}
                    <div class="text-2xs text-neutral-500">Source: ${Utils.escapeHTML(entrySourceLabel)}</div>
                  </td>
                  <td class="text-left">${Utils.formatCurrency(ltp)}</td>
                  <td class="text-left ${Utils.getPnLColorClass(pnl)}">${Utils.formatCurrency(pnl)}</td>
                  <td class="text-left">
                    ${instanceId ? `
                      <button
                        class="btn-close-position-compact"
                        onclick="app.closePosition(${instanceId}, '${encodeURIComponent(pos.symbol || '')}', '${encodeURIComponent(pos.exchange || '')}', '${encodeURIComponent(pos.product || 'MIS')}')"
                      >
                        Close
                      </button>
                    ` : '-'}
                  </td>
                </tr>
              `;
    }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  getNormalizedPositionQty(pos) {
    if (!pos) return 0;
    const rawQty =
      pos.quantity ??
      pos.netqty ??
      pos.net_quantity ??
      pos.netQty ??
      pos.net ??
      0;
    const parsed = parseInt(rawQty, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
}.prototype));
