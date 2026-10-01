/**
 * Sync-in-layout: keeping the underlying, CE and PE charts in step.
 *
 * Underlying, CE and PE are three separate chart instances of three different instruments, so
 * they are joined with the engine's own link group (`createLinkGroup`, openalgo-charts
 * src/link). It moves everything across a chart boundary as a TIME, never as a bar index: bar
 * N is a different instant on each chart, because an option's history starts later and skips
 * minutes with no trades. That is what makes the lines up:
 *
 *   Crosshair   hovering one chart draws a VERTICAL line on the others at the bar open at that
 *               same instant (the last bar that had opened, never a later one).
 *   Align time  panning or zooming one shows the same wall-clock window on the others - the
 *               right-hand margin included, so the live bars sit at the same place on each.
 *   Interval    all charts share the toolbar timeframe. Off, each option pane picks its own.
 *
 * Before 2026-09-30 this file hand-rolled the sync: the crosshair drew a horizontal price line
 * on the other charts (no vertical line at all), and zoom copied bar spacing only, so each
 * chart kept its own scroll position and the right edges drifted apart.
 *
 * The group follows user gestures ('pan'/'zoom' events). Programmatic changes - a fresh load,
 * a restored view, the live feed pushing the latest bar - do not emit them, so alignFollowers()
 * re-maps the panes onto the underlying's window after each of those.
 */
const SYNC_DEFAULTS = { interval: true, crosshair: true, viewport: true };

Object.assign(DashboardApp.prototype, {
  chartSyncConfig() {
    if (!this._syncCfg) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('chart-sync') || '{}'); } catch (_) { /* corrupt */ }
      // Older saved blobs have time/range/pan instead of viewport; they fall back to the default.
      this._syncCfg = {
        interval: saved.interval ?? SYNC_DEFAULTS.interval,
        crosshair: saved.crosshair ?? SYNC_DEFAULTS.crosshair,
        viewport: saved.viewport ?? SYNC_DEFAULTS.viewport,
      };
    }
    return this._syncCfg;
  },

  toggleChartSync(key) {
    const cfg = this.chartSyncConfig();
    if (cfg[key] === undefined) return;
    cfg[key] = !cfg[key];
    try { localStorage.setItem('chart-sync', JSON.stringify(cfg)); } catch (_) { /* private mode */ }
    this.renderSyncBar();
    // Interval changes what each pane fetches, so it needs a rebuild rather than a re-link.
    if (key === 'interval' && this.chartOptionsOn) this.refreshOptionPanes();
    else this.syncCharts();
  },

  /**
   * The sync bar only means something with more than one chart, so it rides with the option
   * panes - its toolbar button is hidden with it, not left as a dead button.
   */
  renderSyncBar() {
    const host = document.getElementById('chart-sync-bar');
    const btn = document.querySelector('[data-pop="sync"]');
    if (!host) return;
    if (!this.chartOptionsOn) {
      host.hidden = true;
      host.innerHTML = '';
      if (btn) btn.closest('.chart-menu').hidden = true;
      return;
    }
    if (btn) btn.closest('.chart-menu').hidden = false;

    const cfg = this.chartSyncConfig();
    const items = [['crosshair', 'Crosshair'], ['viewport', 'Align time'], ['interval', 'Interval']];
    host.hidden = false;
    host.innerHTML = `
      <span class="chart-toolbar-label">Sync in layout</span>
      ${items.map(([k, label]) => `
        <label class="chart-sync-item">
          <input type="checkbox" data-sync="${k}" ${cfg[k] ? 'checked' : ''} />
          <span>${label}</span>
        </label>`).join('')}
      <p class="chart-sync-note">
        Crosshair marks the same moment on every chart. Align time shows the same time window on
        every chart when you scroll or zoom, so the latest bars line up. Both match charts by
        time, never by bar count - an option trades less often than its underlying.
      </p>`;

    host.querySelectorAll('input[data-sync]').forEach((el) =>
      el.addEventListener('change', () => this.toggleChartSync(el.dataset.sync)));
  },

  /** Every live chart: the underlying first, then whichever option panes exist. */
  chartSyncTargets() {
    const out = [];
    if (this.chart) out.push(this.chart);
    for (const key of ['ce', 'pe']) {
      const pane = this.optionPanes?.[key];
      if (pane?.chart) out.push(pane.chart);
    }
    return out;
  },

  /** Unlink every chart. Safe against charts that are already destroyed. */
  unsyncCharts() {
    try { this._linkGroup?.destroy(); } catch (_) { /* already gone */ }
    this._linkGroup = null;
    clearInterval(this._alignTimer);
    this._alignedKey = null;
    this._alignedPanes = null;
  },

  syncCharts() {
    this.unsyncCharts();
    const charts = this.chartSyncTargets();
    if (charts.length < 2 || typeof window.OAC?.createLinkGroup !== 'function') return;

    const cfg = this.chartSyncConfig();
    this._linkGroup = window.OAC.createLinkGroup({
      crosshair: cfg.crosshair,
      viewport: cfg.viewport,
      whenMissing: 'nearest',
    });
    for (const chart of charts) this._linkGroup.add(chart);
    this.alignFollowers();
    // Nothing tells the group when the underlying's view moves on its own - the layout settling
    // after the panes open re-anchors it a moment later (seen 1 Oct 2026: the panes stayed on
    // the window it had at the first read, ~2000 bars off, an empty grid). So the panes are
    // re-aligned whenever the underlying's range differs from the one they were aligned to.
    this._alignTimer = setInterval(() => {
      let r;
      try { r = this.chart?.getVisibleLogicalRange(); } catch (_) { return; }
      if (!r) return;
      const key = `${r.from.toFixed(2)}|${r.to.toFixed(2)}|${this.chartCandles?.length}`;
      // ...or when a pane has been moved off the window it was given (a pane's own new bar did
      // that by ~650 bars).
      const drifted = ['ce', 'pe'].some((k) => {
        const set = this._alignedPanes?.[k];
        let now;
        try { now = this.optionPanes?.[k]?.chart?.getVisibleLogicalRange(); } catch (_) { return false; }
        return set && now && Math.abs(now.to - set.to) > 1;
      });
      if (key !== this._alignedKey || drifted) this.alignFollowers();
    }, 400);
  },

  /**
   * Put each option pane on the underlying's time window. The group only reacts to gestures,
   * so this runs after anything that moves the underlying's view on its own.
   */
  alignFollowers() {
    if (!this._linkGroup || !this.chartSyncConfig().viewport || !this.chart) return;
    let range;
    try { range = this.chart.getVisibleLogicalRange(); } catch (_) { return; }
    if (!range) return;
    this._alignedKey = `${range.from.toFixed(2)}|${range.to.toFixed(2)}|${this.chartCandles?.length}`;
    const mainCount = this.chartCandles?.length || 0;
    const mainLast = this.chartCandles?.[mainCount - 1]?.ts;
    const seconds = timeframeSeconds(this.chartState?.timeframe || '5m');
    for (const key of ['ce', 'pe']) {
      const pane = this.optionPanes?.[key];
      if (!pane?.chart) continue;
      try {
        let mapped;
        const last = pane.candles?.[pane.candles.length - 1]?.ts;
        if (mainCount && last && range.to > mainCount - 1 && this.paneTimeframe(key) === this.chartState.timeframe) {
          // The right-hand margin is the engine's guess at future bars, and it guesses differently
          // per chart: the same time came back ~600 bars off on one pane and ~2000 on another, an
          // empty grid either way. Past the live edge the margin is counted in bars instead,
          // from where this pane's own data ends.
          const lag = Math.round((mainLast - last) / seconds);
          const to = pane.candles.length - 1 + (range.to - (mainCount - 1)) - lag;
          mapped = { from: to - (range.to - range.from), to };
        } else {
          mapped = window.OAC.followerRange(this.chart.dataLayer, pane.chart.dataLayer, range);
        }
        if (mapped) {
          pane.chart.setVisibleLogicalRange(mapped);
          this._alignedPanes = { ...this._alignedPanes, [key]: pane.chart.getVisibleLogicalRange() };
        }
      } catch (_) { /* destroyed mid-rebuild */ }
    }
  },

  /** The timeframe a given pane should load: the shared one, or its own override. */
  paneTimeframe(key) {
    const state = this.chartState;
    if (!state) return '5m';
    if (this.chartSyncConfig().interval) return state.timeframe;
    return state.paneTimeframes?.[key] || state.timeframe;
  },

  setPaneTimeframe(key, timeframe) {
    if (!this.chartState) return;
    this.chartState.paneTimeframes = { ...(this.chartState.paneTimeframes || {}), [key]: timeframe };
    this.refreshOptionPanes();
  },
});
