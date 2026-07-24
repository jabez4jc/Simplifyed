/**
 * Simplifyed Admin V2 - Dashboard: Dashboard overview view (metrics cards + telemetry).
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Dashboard View
   */
  async renderDashboardView() {
    const contentArea = document.getElementById('content-area');

    // Fetch data
    const [instancesRes, metricsRes, telemetryRateRes, cacheStatusRes] = await Promise.all([
      api.getInstances({ is_active: true }),
      api.getDashboardMetrics().catch(() => ({
        data: {
          live: {
            instances: [],
            total_available_balance: 0,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_pnl: 0,
            total_trade_value: 0,
            total_buy_trades: 0,
            total_sell_trades: 0,
          },
          analyzer: {
            instances: [],
            total_available_balance: 0,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_pnl: 0,
            total_trade_value: 0,
            total_buy_trades: 0,
            total_sell_trades: 0,
          },
        },
      })),
      api.getTelemetryRateLimits().catch(() => ({ data: [] })),
      api.getTelemetryCacheStatus().catch(() => ({ data: { entries: [] } })),
    ]);

    this.instances = instancesRes.data;
    const metrics = metricsRes.data;

    // Merge fund balance data into instances
    const allMetricsInstances = [...metrics.live.instances, ...metrics.analyzer.instances];
    const fundsMap = new Map();
    allMetricsInstances.forEach(mi => {
      fundsMap.set(mi.instance_id, {
        available_balance: mi.available_balance,
        realized_pnl: mi.realized_pnl,
        unrealized_pnl: mi.unrealized_pnl,
        total_pnl: mi.total_pnl,
        total_trade_value: mi.total_trade_value,
        total_buy_trades: mi.total_buy_trades,
        total_sell_trades: mi.total_sell_trades,
      });
    });

    // Add fund data to instances
    this.instances = this.instances.map(instance => ({
      ...instance,
      ...(fundsMap.get(instance.id) || {
        available_balance: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        total_pnl: 0,
        total_trade_value: 0,
        total_buy_trades: 0,
        total_sell_trades: 0,
      }),
    }));

    // Telemetry summary
    const rateEntries = telemetryRateRes?.data || [];
    const cacheEntries = cacheStatusRes?.data?.entries || [];
    const telemetrySnapshot = this.computeTelemetrySnapshot(rateEntries, cacheEntries);
    this.lastTelemetry = {
      circuits: telemetrySnapshot.openCircuits,
      stale: telemetrySnapshot.staleCaches,
    };

    const telemetryHealthy = telemetrySnapshot.openCircuits === 0 && telemetrySnapshot.staleCaches === 0;
    const telemetryCards = `
      <details class="card mb-6" id="telemetry-health-details">
        <summary class="card-header cursor-pointer select-none flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${telemetryHealthy ? 'bg-success' : 'bg-warning'}" id="telemetry-health-dot"></span>
          <h3 class="card-title">System Health</h3>
          <span class="text-xs text-neutral-500 ml-auto" id="telemetry-health-summary">
            ${telemetryHealthy ? 'All feeds nominal' : `${telemetrySnapshot.openCircuits} circuit(s) open, ${telemetrySnapshot.staleCaches} stale cache(s)`}
          </span>
        </summary>
        <div class="flex flex-nowrap gap-3 p-4 overflow-x-auto">
          <div class="stat-card min-w-[240px]" id="telemetry-card-circuits">
            <div class="stat-label">Circuits Open</div>
            <div class="stat-value" id="telemetry-circuits">${telemetrySnapshot.openCircuits}</div>
            <div class="stat-subtext text-xs text-neutral-500">Feeds paused due to failures</div>
          </div>
          <div class="stat-card min-w-[240px]" id="telemetry-card-stale">
            <div class="stat-label">Stale Caches</div>
            <div class="stat-value" id="telemetry-stale">${telemetrySnapshot.staleCaches}</div>
            <div class="stat-subtext text-xs text-neutral-500">Quotes/positions beyond TTL</div>
          </div>
          <div class="stat-card min-w-[240px]">
            <div class="stat-label">Orders/sec Headroom</div>
            <div class="stat-value" id="telemetry-orders-headroom">${telemetrySnapshot.minOrdersRemaining ?? 'n/a'}</div>
            <div class="stat-subtext text-xs text-neutral-500">Lowest remaining across instances</div>
          </div>
          <div class="stat-card min-w-[240px]">
            <div class="stat-label">RPS Headroom</div>
            <div class="stat-value" id="telemetry-rps-headroom">${telemetrySnapshot.minRpsRemaining ?? 'n/a'}</div>
            <div class="stat-subtext text-xs text-neutral-500">Lowest remaining across instances</div>
          </div>
        </div>
      </details>
    `;

    const activeInstances = this.instances.filter(i => i.is_active);
    const liveCount = activeInstances.filter(i => !i.is_analyzer_mode).length;
    const analyzerCount = activeInstances.filter(i => i.is_analyzer_mode).length;
    const instancesSummary = `
      <div class="card mb-6">
        <div class="card-header">
          <h3 class="card-title">Instances</h3>
          <button class="btn btn-neutral btn-outline btn-sm" onclick="app.switchView('instances')">
            Manage Instances →
          </button>
        </div>
        <div class="stats-grid stats-grid-centered">
          <div class="stat-card">
            <div class="stat-label">Active</div>
            <div class="stat-value">${activeInstances.length}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Live</div>
            <div class="stat-value">${liveCount}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Analyzer</div>
            <div class="stat-value">${analyzerCount}</div>
          </div>
        </div>
      </div>
    `;

    // Render — trading KPIs first, infra/account telemetry demoted below
    contentArea.innerHTML = `
      <!-- Live Mode Stats (Primary) -->
      <div class="mb-4">
        <div class="flex items-center mb-2">
          <h2 class="text-xl font-semibold">Live Trading</h2>
          <span class="ml-2 px-2 py-1 text-xs font-semibold badge-v-live rounded">L</span>
          <button class="btn btn-neutral btn-outline btn-sm ml-auto" onclick="app.refreshDashboardMetrics({ force: true, showToast: true })">
            ↻ Refresh Metrics
          </button>
        </div>
      <div class="stats-grid stats-grid-centered">
        <div class="stat-card pnl-card ${Utils.getPnLBgClass(metrics.live.total_pnl)}">
            <div class="stat-label">P&L (net)</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_pnl)}">
              <span id="live-pnl-value">${Utils.formatCurrency(metrics.live.total_pnl)}</span>
              <span class="badge badge-success ml-2">L</span>
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Total Trades</div>
            <div class="stat-value">
              <span id="live-trades-value">
                Buy: ${Utils.formatNumber(metrics.live.total_buy_trades, 0)} / Sell: ${Utils.formatNumber(metrics.live.total_sell_trades, 0)}
              </span>
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Total Turnover</div>
            <div class="stat-value">
              <span id="live-turnover-value">${Utils.formatCurrency(metrics.live.total_trade_value)}</span>
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Available Balance</div>
            <div class="stat-value">
              <span id="live-balance-value">${Utils.formatCurrency(metrics.live.total_available_balance)}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Analyzer Mode Stats (Secondary) -->
      ${metrics.analyzer.instances.length > 0 ? `
        <div class="mb-6">
          <div class="flex items-center mb-2">
            <h2 class="text-xl font-semibold text-neutral-600">Analyzer Mode</h2>
            <span class="ml-2 px-2 py-1 text-xs font-semibold badge-v-analyzer rounded">A</span>
          </div>
          <div class="stats-grid stats-grid-centered opacity-75">
            <div class="stat-card">
              <div class="stat-label">P&L (net)</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_pnl)}">
                <span id="analyzer-pnl-value">${Utils.formatCurrency(metrics.analyzer.total_pnl)}</span>
                <span class="badge badge-warning ml-2">A</span>
              </div>
            </div>

            <div class="stat-card">
              <div class="stat-label">Total Trades</div>
              <div class="stat-value">
                <span id="analyzer-trades-value">
                  Buy: ${Utils.formatNumber(metrics.analyzer.total_buy_trades, 0)} / Sell: ${Utils.formatNumber(metrics.analyzer.total_sell_trades, 0)}
                </span>
              </div>
            </div>

            <div class="stat-card">
              <div class="stat-label">Total Turnover</div>
              <div class="stat-value">
                <span id="analyzer-turnover-value">${Utils.formatCurrency(metrics.analyzer.total_trade_value)}</span>
              </div>
            </div>

            <div class="stat-card">
              <div class="stat-label">Available Balance</div>
              <div class="stat-value">
                <span id="analyzer-balance-value">${Utils.formatCurrency(metrics.analyzer.total_available_balance)}</span>
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      ${instancesSummary}
      ${telemetryCards}
    `;

    this.applyTelemetrySnapshot(telemetrySnapshot);
    this.stopTelemetryRefresh();
    this.startTelemetryRefresh();
    this.stopDashboardMetricsRefresh();
    this.startDashboardMetricsRefresh();
    this.refreshDashboardMetrics({ force: true });
  }

  async refreshDashboardMetrics({ force = false, showToast = false } = {}) {
    try {
      const metricsRes = await api.getDashboardMetrics({ refresh: force });
      const metrics = metricsRes?.data;
      if (!metrics) return;
      this.updateDashboardMetricCards(metrics);
      if (showToast) {
        Utils.showToast('Metrics refreshed', 'success');
      }
    } catch (error) {
      if (showToast) {
        Utils.showToast('Failed to refresh metrics: ' + error.message, 'error');
      }
    }
  }

  updateDashboardMetricCards(metrics) {
    const livePnl = document.getElementById('live-pnl-value');
    if (livePnl) livePnl.textContent = Utils.formatCurrency(metrics.live.total_pnl);
    const liveTrades = document.getElementById('live-trades-value');
    if (liveTrades) {
      liveTrades.textContent = `Buy: ${Utils.formatNumber(metrics.live.total_buy_trades, 0)} / Sell: ${Utils.formatNumber(metrics.live.total_sell_trades, 0)}`;
    }
    const liveTurnover = document.getElementById('live-turnover-value');
    if (liveTurnover) liveTurnover.textContent = Utils.formatCurrency(metrics.live.total_trade_value);
    const liveBalance = document.getElementById('live-balance-value');
    if (liveBalance) liveBalance.textContent = Utils.formatCurrency(metrics.live.total_available_balance);

    const analyzerPnl = document.getElementById('analyzer-pnl-value');
    if (analyzerPnl) analyzerPnl.textContent = Utils.formatCurrency(metrics.analyzer.total_pnl);
    const analyzerTrades = document.getElementById('analyzer-trades-value');
    if (analyzerTrades) {
      analyzerTrades.textContent = `Buy: ${Utils.formatNumber(metrics.analyzer.total_buy_trades, 0)} / Sell: ${Utils.formatNumber(metrics.analyzer.total_sell_trades, 0)}`;
    }
    const analyzerTurnover = document.getElementById('analyzer-turnover-value');
    if (analyzerTurnover) analyzerTurnover.textContent = Utils.formatCurrency(metrics.analyzer.total_trade_value);
    const analyzerBalance = document.getElementById('analyzer-balance-value');
    if (analyzerBalance) analyzerBalance.textContent = Utils.formatCurrency(metrics.analyzer.total_available_balance);
  }

  startDashboardMetricsRefresh() {
    this.stopDashboardMetricsRefresh();
    this.dashboardMetricsInterval = setInterval(() => {
      this.refreshDashboardMetrics({ force: true });
    }, 30 * 1000);
  }

  stopDashboardMetricsRefresh() {
    if (this.dashboardMetricsInterval) {
      clearInterval(this.dashboardMetricsInterval);
      this.dashboardMetricsInterval = null;
    }
  }

  computeTelemetrySnapshot(rateEntries = [], cacheEntries = []) {
    const openCircuits = cacheEntries.filter((e) => e.circuitOpen).length;
    const staleCaches = cacheEntries.filter((e) => e.stale === true).length;
    const ordersRemaining = rateEntries
      .map((e) => e.budget?.remaining?.orders)
      .filter((v) => v !== null && v !== undefined);
    const rpsRemaining = rateEntries
      .map((e) => e.budget?.remaining?.rps)
      .filter((v) => v !== null && v !== undefined);

    return {
      openCircuits,
      staleCaches,
      minOrdersRemaining: ordersRemaining.length ? Math.min(...ordersRemaining) : null,
      minRpsRemaining: rpsRemaining.length ? Math.min(...rpsRemaining) : null,
    };
  }

  applyTelemetrySnapshot(snapshot) {
    const circuitsEl = document.getElementById('telemetry-circuits');
    const staleEl = document.getElementById('telemetry-stale');
    const ordersEl = document.getElementById('telemetry-orders-headroom');
    const rpsEl = document.getElementById('telemetry-rps-headroom');
    const cardCircuits = document.getElementById('telemetry-card-circuits');
    const cardStale = document.getElementById('telemetry-card-stale');

    if (circuitsEl) {
      circuitsEl.textContent = snapshot.openCircuits;
    }
    if (staleEl) {
      staleEl.textContent = snapshot.staleCaches;
    }
    if (ordersEl) {
      ordersEl.textContent =
        snapshot.minOrdersRemaining !== null && snapshot.minOrdersRemaining !== undefined
          ? snapshot.minOrdersRemaining
          : 'n/a';
    }
    if (rpsEl) {
      rpsEl.textContent =
        snapshot.minRpsRemaining !== null && snapshot.minRpsRemaining !== undefined
          ? snapshot.minRpsRemaining
          : 'n/a';
    }

    if (cardCircuits) {
      cardCircuits.classList.toggle('bg-warning/10', snapshot.openCircuits > 0);
      cardCircuits.classList.toggle('border-warning', snapshot.openCircuits > 0);
      cardCircuits.querySelector('.stat-value')?.classList.toggle('text-warning', snapshot.openCircuits > 0);
    }
    if (cardStale) {
      cardStale.classList.toggle('bg-error/10', snapshot.staleCaches > 0);
      cardStale.classList.toggle('border-error', snapshot.staleCaches > 0);
      cardStale.querySelector('.stat-value')?.classList.toggle('text-error', snapshot.staleCaches > 0);
    }

    const healthy = snapshot.openCircuits === 0 && snapshot.staleCaches === 0;
    const healthDot = document.getElementById('telemetry-health-dot');
    if (healthDot) {
      healthDot.classList.toggle('bg-success', healthy);
      healthDot.classList.toggle('bg-warning', !healthy);
    }
    const healthSummary = document.getElementById('telemetry-health-summary');
    if (healthSummary) {
      healthSummary.textContent = healthy
        ? 'All feeds nominal'
        : `${snapshot.openCircuits} circuit(s) open, ${snapshot.staleCaches} stale cache(s)`;
    }
  }

  async refreshTelemetryCards() {
    if (this.currentView !== 'dashboard') {
      return;
    }
    try {
      const [rateRes, cacheRes] = await Promise.all([
        api.getTelemetryRateLimits().catch(() => ({ data: [] })),
        api.getTelemetryCacheStatus().catch(() => ({ data: { entries: [] } })),
      ]);
      const snapshot = this.computeTelemetrySnapshot(rateRes?.data || [], cacheRes?.data?.entries || []);
      this.applyTelemetrySnapshot(snapshot);

      if (snapshot.openCircuits > 0 && this.lastTelemetry.circuits === 0) {
        Utils.showToast(`Feed circuits opened (${snapshot.openCircuits})`, 'warning');
      }
      if (snapshot.staleCaches > 0 && this.lastTelemetry.stale === 0) {
        Utils.showToast(`Stale caches detected (${snapshot.staleCaches})`, 'error');
        // Opportunistic resync if on a data-heavy view
        if (['watchlists', 'positions'].includes(this.currentView)) {
          this.triggerSnapshotResync();
        }
      }
      this.lastTelemetry = {
        circuits: snapshot.openCircuits,
        stale: snapshot.staleCaches,
      };
    } catch (err) {
      console.warn('Telemetry refresh failed', err);
    }
  }

  startTelemetryRefresh() {
    this.stopTelemetryRefresh();
    this.telemetryInterval = setInterval(() => this.refreshTelemetryCards(), 20000);
  }

  stopTelemetryRefresh() {
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }
}.prototype));
