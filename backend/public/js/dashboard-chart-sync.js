/**
 * Sync-in-layout: keeping the underlying, CE and PE charts in step.
 *
 * openalgo-charts' `panes()` are stacked panes of ONE chart instance (price + RSI + MACD
 * underneath it) - there is no built-in concept of linking SEPARATE chart instances, which is
 * what underlying/CE/PE are (three different instruments, three `createChart()` calls). Every
 * pane is therefore wired manually here, and re-wired whenever the set of live charts changes (a
 * pane rebuilt). Handles are tracked so a rebuild detaches the old subscriptions.
 *
 * Three toggles, not four - Interval, Crosshair, and a single zoom sync (Time/Date range
 * collapsed into one: see the note on mirrorScale for why they were never really separate once
 * oscillators became panes of the price chart instead of charts of their own):
 *
 *   Interval    all panes share the toolbar timeframe. Off, each option pane picks its own -
 *               useful for reading the underlying on 15m while scalping the option on 1m.
 *   Crosshair   hovering one pane marks its own price on the same bar of the others, via a thin
 *               dashed price line (native `chart.addPriceLine`) - the engine has no cross-
 *               instance crosshair primitive to hook into, so a price line is the closest native
 *               equivalent rather than a hand-built overlay primitive.
 *   Zoom        shared bar spacing (how zoomed in each pane is). Never shared SCROLL position:
 *               CE and PE are a different instrument than the underlying, with their own bar
 *               count and their own right-hand padding - matching position by index or by time
 *               scrolled the legs hundreds of bars past their own data (see mirrorScale).
 *
 * `range` is kept as a config key (defaulting on, same as before) so a saved preference blob from
 * before this migration still parses, but Time and Date range now do the same thing - the engine
 * has no separate by-index vs by-time range API to tell them apart the way Lightweight Charts did.
 */
const SYNC_DEFAULTS = { interval: true, crosshair: true, time: true, range: true, pan: false };

Object.assign(DashboardApp.prototype, {
  chartSyncConfig() {
    if (!this._syncCfg) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('chart-sync') || '{}'); } catch (_) { /* corrupt */ }
      this._syncCfg = { ...SYNC_DEFAULTS, ...saved };
    }
    return this._syncCfg;
  },

  toggleChartSync(key) {
    const cfg = this.chartSyncConfig();
    if (cfg[key] === undefined) return;
    cfg[key] = !cfg[key];
    try { localStorage.setItem('chart-sync', JSON.stringify(cfg)); } catch (_) { /* private mode */ }
    this.renderSyncBar();
    // Interval changes what each pane fetches, so it needs a rebuild rather than a re-wire.
    if (key === 'interval' && this.chartOptionsOn) this.refreshOptionPanes();
    else this.syncCharts();
  },

  /**
   * The sync bar is only meaningful with more than one pane, so it rides with the option panes -
   * its own toolbar button (`data-pop="sync"`), not just the popover body, is hidden with it, so
   * there is no dead "Sync" button sitting in the toolbar with an empty popover behind it.
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
    const items = [
      ['interval', 'Interval'], ['crosshair', 'Crosshair'], ['time', 'Zoom'], ['pan', 'Pan range'],
    ];
    host.hidden = false;
    host.innerHTML = `
      <span class="chart-toolbar-label">Sync in layout</span>
      ${items.map(([k, label]) => `
        <label class="chart-sync-item">
          <input type="checkbox" data-sync="${k}" ${cfg[k] ? 'checked' : ''} />
          <span>${label}</span>
        </label>`).join('')}
      <p class="chart-sync-note">
        Pan range aligns each pane's visible time window to the one you scroll, mapped onto its
        OWN candles by timestamp - never a shared bar count, since CE/PE have different history
        than the underlying. Off by default.
      </p>`;

    host.querySelectorAll('input[data-sync]').forEach((el) =>
      el.addEventListener('change', () => this.toggleChartSync(el.dataset.sync)));
  },

  /**
   * Every live chart, with the candles it was built from (for crosshair price lookup) and the
   * element the pointer enters (for "only the pane you are touching drives the others").
   */
  chartSyncTargets() {
    const out = [];
    if (this.chart && this.candleSeries) {
      out.push({
        chart: this.chart, series: this.candleSeries, candles: this.chartCandles,
        el: document.getElementById('chart-container'),
      });
    }
    for (const key of ['ce', 'pe']) {
      const pane = this.optionPanes?.[key];
      if (pane?.chart && pane.series) {
        out.push({
          chart: pane.chart,
          series: pane.series,
          candles: pane.candles,
          el: document.querySelector(`.chart-pane[data-pane="${key}"] .chart-pane-body`),
        });
      }
    }
    return out;
  },

  /** Detach every sync subscription. Safe to call against charts that are already disposed. */
  unsyncCharts() {
    // Left as the price chart rather than null: null means "anything may drive", which lets a
    // rebuilding sub-chart clobber the price chart's range.
    this._activeSyncChart = this.chart || null;
    for (const detach of this._syncHandles || []) {
      try { detach(); } catch (_) { /* chart already removed */ }
    }
    this._syncHandles = [];
    if (this._syncRaf) { cancelAnimationFrame(this._syncRaf); this._syncRaf = null; }
  },

  /**
   * Copy the driver's zoom (bar spacing) onto every other pane - never the scroll position. CE
   * and PE are always a DIFFERENT instrument than the underlying: different bar count, history
   * frequently ending earlier, and their own right-hand padding. Matching position - by bar
   * index or by time - scrolled the legs hundreds of bars past their own data and dragged the
   * underlying's own padding to nothing whenever a leg was the pane being zoomed (measured on
   * the previous engine; the fix - bar spacing only, never position - carries over unchanged).
   */
  mirrorScale(source, targets) {
    let barSpacing;
    try { barSpacing = source.chart.timeScale.barSpacing; } catch (_) { return; }
    if (!Number.isFinite(barSpacing)) return;
    for (const target of targets) {
      if (target === source) continue;
      try { target.chart.timeScale.setBarSpacing(barSpacing); } catch (_) { /* disposed */ }
    }
  },

  /**
   * "Pan range" - unlike mirrorScale (bar spacing only), this DOES move scroll position, but
   * safely: never a shared bar index/LogicalRange (that's what scrolled legs hundreds of bars
   * off their own data before). Instead, read the driver's visible TIME window, then for each
   * target find where those same two timestamps fall in THAT target's own candle array and set
   * ITS OWN LogicalRange from those - every pane aligns by calendar time, not by shared index,
   * so CE/PE (shorter history, different range) never get dragged past their own data. Off by
   * default (`pan` in SYNC_DEFAULTS) - an explicit opt-in, unlike the other three.
   */
  mirrorPanRange(source, targets) {
    let range;
    try { range = source.chart.timeScale.getVisibleLogicalRange(); } catch (_) { return; }
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
    const srcCandles = source.candles || [];
    if (!srcCandles.length) return;
    const fromTime = srcCandles[Math.min(srcCandles.length - 1, Math.max(0, Math.round(range.from)))]?.ts;
    const toTime = srcCandles[Math.min(srcCandles.length - 1, Math.max(0, Math.round(range.to)))]?.ts;
    if (fromTime === undefined || toTime === undefined) return;

    const nearestIndex = (candles, ts) => {
      let lo = 0;
      let hi = candles.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (candles[mid].ts < ts) lo = mid + 1; else hi = mid;
      }
      return lo;
    };

    for (const target of targets) {
      if (target === source) continue;
      const candles = target.candles || [];
      if (!candles.length) continue;
      const from = nearestIndex(candles, fromTime);
      const to = nearestIndex(candles, toTime);
      if (from >= to) continue;
      try { target.chart.timeScale.setVisibleLogicalRange({ from, to }); } catch (_) { /* disposed */ }
    }
  },

  syncCharts() {
    this.unsyncCharts();

    const cfg = this.chartSyncConfig();
    const targets = this.chartSyncTargets();
    // The price chart drives until the pointer says otherwise. Without a default owner, the
    // very first zoom relay tick would have nothing to mirror from.
    this._activeSyncChart = this.chart || null;
    if (targets.length < 2) return;

    for (const target of targets) {
      if (!target.el) continue;
      const claim = () => { this._activeSyncChart = target.chart; };
      target.el.addEventListener('pointerenter', claim);
      target.el.addEventListener('pointerdown', claim);
      this._syncHandles.push(() => {
        target.el.removeEventListener('pointerenter', claim);
        target.el.removeEventListener('pointerdown', claim);
      });
    }

    if (cfg.time || cfg.range || cfg.pan) {
      // Seed immediately so panes open already aligned, not just after the first zoom gesture.
      const initial = targets.find((t) => t.chart === this.chart) || targets[0];
      if (cfg.time || cfg.range) this.mirrorScale(initial, targets);
      if (cfg.pan) this.mirrorPanRange(initial, targets);

      // openalgo-charts has no public "visible range changed" event to subscribe to (the
      // previous, Lightweight Charts based engine did) - polling the driver's own bar spacing /
      // visible range once per animation frame is the substitute: a couple of number
      // comparisons, at the engine's own render cadence, so it costs nothing when nothing is
      // actually being zoomed or scrolled.
      let lastSpacing = null;
      let lastRangeFrom = null;
      let lastRangeTo = null;
      const tick = () => {
        const live = this.chartSyncTargets();
        const driver = live.find((t) => t.chart === this._activeSyncChart) || live[0];
        if (driver) {
          const liveCfg = this.chartSyncConfig();
          if (liveCfg.time || liveCfg.range) {
            let spacing;
            try { spacing = driver.chart.timeScale.barSpacing; } catch (_) { spacing = null; }
            if (spacing !== null && spacing !== lastSpacing) {
              lastSpacing = spacing;
              this.mirrorScale(driver, live);
            }
          }
          if (liveCfg.pan) {
            let range;
            try { range = driver.chart.timeScale.getVisibleLogicalRange(); } catch (_) { range = null; }
            if (range && (range.from !== lastRangeFrom || range.to !== lastRangeTo)) {
              lastRangeFrom = range.from;
              lastRangeTo = range.to;
              this.mirrorPanRange(driver, live);
            }
          }
        }
        this._syncRaf = requestAnimationFrame(tick);
      };
      this._syncRaf = requestAnimationFrame(tick);
      this._syncHandles.push(() => {
        if (this._syncRaf) cancelAnimationFrame(this._syncRaf);
        this._syncRaf = null;
      });
    }

    if (cfg.crosshair) {
      for (const target of targets) {
        // subscribeCrosshairMove has no unsubscribe in this engine, so each chart is bound at
        // most once (flagged on the chart object itself) rather than on every syncCharts() call
        // - resolving targets and the config fresh INSIDE the handler is what keeps a single
        // long-lived subscription correct across pane rebuilds and toggles, the same trick the
        // zoom relay above uses.
        if (target.chart._crosshairSyncBound) continue;
        target.chart._crosshairSyncBound = true;
        target.chart.subscribeCrosshairMove((e) => {
          if (!this.chartSyncConfig().crosshair) return;
          if (this._activeSyncChart && this._activeSyncChart !== target.chart) return;
          const live = this.chartSyncTargets();
          for (const other of live) {
            if (other.chart === target.chart) continue;
            const bar = e.time === null ? null : (other.candles || []).find((c) => c.ts === e.time);
            if (bar) this.showSyncMarker(other, bar.close);
            else this.clearSyncMarker(other);
          }
        });
      }
    }
  },

  /** A thin dashed price line stands in for a cross-instrument crosshair marker - see the sync
   * toggle doc comment above for why there is nothing more native to reach for here. */
  showSyncMarker(target, price) {
    this.clearSyncMarker(target);
    try {
      target.chart._syncMarker = target.chart.addPriceLine({
        price, color: 'rgba(148,163,184,0.9)', lineWidth: 1, dashed: true,
      }, 0);
    } catch (_) { /* disposed */ }
  },

  clearSyncMarker(target) {
    const line = target.chart._syncMarker;
    if (!line) return;
    try { target.chart.panes()[0]?.removePrimitive(line); } catch (_) { /* disposed */ }
    target.chart._syncMarker = null;
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
