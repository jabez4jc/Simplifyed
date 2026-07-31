/**
 * Option scalping layout: underlying + resolved CE + resolved PE, side by side.
 *
 * Shown ONLY while "Trade options on this underlying" is on, because that is the only time the
 * CE/PE panes correspond to what a click would actually trade. Off, the chart stays a single
 * pane on the underlying.
 *
 * The CE/PE contracts come from GET /api/v1/history/option-legs, which resolves the strike from
 * the instruments master against the underlying's live price. That is a DISPLAY resolution: the
 * strike each instance finally trades is resolved independently at execution and may differ if
 * the underlying moves, which the order confirmation already states. The panes are there to show
 * the shape of the contracts you are about to trade, not to promise an exact one.
 *
 * Each pane is its own `createChart()` instance - openalgo-charts' `panes()` are stacked panes of
 * ONE instrument (price + RSI + MACD underneath it), not a multi-symbol grid, and there is no
 * built-in concept of linking separate chart instances together. Three instruments side by side
 * therefore still means three chart instances, each fully on the new engine (own candles, own
 * volume, own `chart.addIndicator()` instances, own pattern markers), hand-synced for zoom by
 * dashboard-chart-sync.js - see the note there for why. Separate instances also keep one pane's
 * failure (an illiquid strike with no history) from blanking the others.
 */
Object.assign(DashboardApp.prototype, {
  /** Tear down the CE/PE panes and any oscillator, leaving the main chart untouched. */
  destroyOptionPanes() {
    this.unsyncCharts();
    for (const key of ['ce', 'pe']) {
      if (typeof this.detachPaneOrderLines === 'function') this.detachPaneOrderLines(key);
      const p = this.optionPanes?.[key];
      if (p?.chart) { try { p.chart.destroy(); } catch (_) { /* already gone */ } }
    }
    this.optionPanes = null;
  },

  /**
   * Build or refresh the CE/PE panes for the current underlying, leg and expiry.
   * Safe to call repeatedly; it rebuilds from scratch rather than diffing.
   */
  async refreshOptionPanes() {
    const wrap = document.getElementById('chart-panes');
    const state = this.chartState;
    if (!wrap || !state) return;

    this.destroyOptionPanes();
    this.renderSyncBar();

    if (!this.chartOptionsOn || !this.chartLastPrice) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      document.getElementById('chart-layout')?.classList.remove('is-split');
      return;
    }

    document.getElementById('chart-layout')?.classList.add('is-split');
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="chart-pane" data-pane="ce"><div class="chart-pane-title">Loading CE…</div><div class="chart-pane-body"></div></div>
      <div class="chart-pane" data-pane="pe"><div class="chart-pane-title">Loading PE…</div><div class="chart-pane-body"></div></div>`;

    let legs;
    try {
      const q = new URLSearchParams({
        symbolId: state.symbolId,
        ltp: this.chartLastPrice,
        leg: state.optionLeg || 'ATM',
      });
      if (state.optionExpiry) q.set('expiry', state.optionExpiry);
      const res = await api.request(`/history/option-legs?${q}`);
      legs = res.data;
    } catch (error) {
      wrap.innerHTML = `<p class="chart-pane-empty">Could not resolve option contracts: ${Utils.escapeHTML(error.message)}</p>`;
      return;
    }

    if (!legs?.available) {
      wrap.innerHTML = `<p class="chart-pane-empty">No option contracts found for this underlying${legs?.reason ? ` (${Utils.escapeHTML(legs.reason)})` : ''}.</p>`;
      return;
    }

    this.populateExpiries(legs.expiries);

    this.optionPanes = {};
    await Promise.all([
      this._buildOptionPane('ce', legs.ce, legs),
      this._buildOptionPane('pe', legs.pe, legs),
    ]);
    this.syncCharts();
  },

  async _buildOptionPane(key, contract, legs) {
    const host = document.querySelector(`.chart-pane[data-pane="${key}"]`);
    if (!host) return;
    const titleEl = host.querySelector('.chart-pane-title');
    const bodyEl = host.querySelector('.chart-pane-body');

    if (!contract) {
      titleEl.textContent = `${key.toUpperCase()} — not found`;
      return;
    }

    titleEl.innerHTML = `
      <span class="chart-pane-sym">${Utils.escapeHTML(contract.symbol)}</span>
      <span class="chart-pane-meta">${Utils.escapeHTML(legs.expiry)} · ${Utils.escapeHTML(String(contract.strike))} · lot ${contract.lotsize}</span>
      <span class="chart-pane-last" data-role="${key}-last">—</span>
      ${this.chartSyncConfig().interval ? '' : `
        <select class="chart-pane-tf" data-pane-tf="${key}" aria-label="${key.toUpperCase()} timeframe">
          ${['1m', '5m', '15m', '30m', '1h', 'D'].map((tf) =>
            `<option value="${tf}" ${tf === this.paneTimeframe(key) ? 'selected' : ''}>${tf}</option>`).join('')}
        </select>`}
      <div class="chart-pane-menu">
        <button type="button" class="chart-pane-btn" data-pane-pop="type-${key}">Type</button>
        <div class="chart-pane-pop" data-pane-pop-for="type-${key}" hidden>
          <div id="chart-pane-type-${key}" class="chart-ind-bar"></div>
        </div>
      </div>
      <div class="chart-pane-menu">
        <button type="button" class="chart-pane-btn" data-pane-pop="ind-${key}">Ind</button>
        <div class="chart-pane-pop is-wide" data-pane-pop-for="ind-${key}" hidden>
          <div id="chart-pane-ind-${key}" class="chart-ind-bar"></div>
          <div id="chart-pane-ind-cfg-${key}" class="chart-ind-config" hidden></div>
        </div>
      </div>`;

    const tfEl = titleEl.querySelector('[data-pane-tf]');
    if (tfEl) tfEl.addEventListener('change', () => this.setPaneTimeframe(key, tfEl.value));
    this.bindPanePopovers(host);

    let candles = [];
    try {
      const to = Math.floor(Date.now() / 1000);
      const paneTf = this.paneTimeframe(key);
      const spanDays = { '1m': 3, '5m': 10, '15m': 30, '30m': 60, '1h': 120, D: 900 }[paneTf] || 10;
      const res = await api.request(
        `/history?exchange=${encodeURIComponent(contract.exchange)}`
        + `&symbol=${encodeURIComponent(contract.symbol)}`
        + `&timeframe=${encodeURIComponent(paneTf)}`
        + `&from=${to - spanDays * 86400}&to=${to}`
      );
      candles = res.data?.candles || [];
    } catch (_) {
      candles = [];
    }

    if (!candles.length) {
      // Common and legitimate for a far strike - say so rather than showing an empty grid.
      bodyEl.innerHTML = '<p class="chart-pane-empty">No history for this contract at this timeframe.</p>';
      return;
    }

    if (!window.OAC) return;
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const baseTheme = dark ? window.OAC.darkTheme : window.OAC.lightTheme;
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue('--color-profit').trim() || baseTheme.upColor;
    const down = css.getPropertyValue('--color-loss').trim() || baseTheme.downColor;

    const chart = window.OAC.createChart(bodyEl, {
      theme: { ...baseTheme, upColor: up, downColor: down, wickUpColor: up, wickDownColor: down },
    });
    // Independent chart type per pane (see setPaneSeriesType() below) - defaults to candlestick
    // like the main chart, not mirrored FROM the main chart, since "independent" starts at zero.
    const seriesType = this.paneSeriesType(key);
    const series = chart.addSeries(this.isTransformSeriesType(seriesType) ? 'candlestick' : seriesType);
    chart.timeScale.setRightOffset(RIGHT_OFFSET_BARS);

    this.optionPanes[key] = { chart, series, contract, candles, seriesType };
    // No IST display shift needed - the engine renders IST natively from raw UTC seconds (see
    // the TIME AXIS note in dashboard-chart.js).
    this.renderPaneSeries(key);
    chart.timeScale.fitContent(120);

    const last = candles[candles.length - 1];
    const lastEl = host.querySelector(`[data-role="${key}-last"]`);
    if (lastEl) {
      const chg = last.open ? ((last.close - last.open) / last.open) * 100 : 0;
      lastEl.textContent = `${Utils.formatNumber(last.close)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`;
      lastEl.className = `chart-pane-last ${chg >= 0 ? 'text-profit' : 'text-loss'}`;
    }

    this.attachOptionPaneOrders(key, bodyEl, chart, contract, candles);
    this.applyIndicatorsTo(chart, series, candles);
    this.applyPatternsTo(chart, series, candles);
    this.renderPaneTypeBar(key);
    this.renderPaneIndicatorBar(key);
    if (typeof this.loadPanePosition === 'function') this.loadPanePosition(key);
    if (typeof this.attachPaneOrderLines === 'function') this.attachPaneOrderLines(key);
  },

  /**
   * One-time (per pane-rebuild) click wiring for the Type/Ind popovers on a pane's title bar -
   * same open-one-at-a-time/close-on-outside-click shape as attachChartBarMenus() for the main
   * toolbar, but scoped to this pane's own header since it lives outside `.chart-bar`.
   */
  bindPanePopovers(host) {
    const closeAll = (except = null) => {
      host.querySelectorAll('.chart-pane-pop').forEach((pop) => {
        if (pop.dataset.panePopFor === except) return;
        pop.hidden = true;
      });
    };
    host.querySelectorAll('[data-pane-pop]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.panePop;
        const pop = host.querySelector(`[data-pane-pop-for="${name}"]`);
        if (!pop) return;
        const opening = pop.hidden;
        closeAll(opening ? name : null);
        pop.hidden = !opening;
        if (opening) {
          // `position: fixed`, so this has to be computed on open, not left to CSS - see the
          // note on .chart-pane-pop for why fixed (not absolute) is required here at all.
          const rect = btn.getBoundingClientRect();
          const left = Math.min(rect.left, window.innerWidth - 270);
          pop.style.left = `${Math.max(4, left)}px`;
          pop.style.top = `${rect.bottom + 4}px`;
        }
      });
    });
    host.querySelectorAll('.chart-pane-pop').forEach((pop) => pop.addEventListener('click', (e) => e.stopPropagation()));
    if (!this._panePopBound) {
      this._panePopBound = true;
      document.addEventListener('click', () => {
        document.querySelectorAll('.chart-pane-pop').forEach((p) => { p.hidden = true; });
      });
    }
  },

  /** Persisted by pane ROLE (CE/PE), not by contract symbol - a trader thinks "my CE pane always
   * shows Renko", and the contract behind that role changes on every strike/expiry roll. */
  paneSeriesType(key) {
    try { return localStorage.getItem(`chart-pane-type-${key}`) || 'candlestick'; } catch (_) { return 'candlestick'; }
  },

  savePaneSeriesType(key, type) {
    try { localStorage.setItem(`chart-pane-type-${key}`, type); } catch (_) { /* private mode */ }
  },

  setPaneSeriesType(key, type) {
    const pane = this.optionPanes?.[key];
    if (!pane?.chart) return;
    pane.seriesType = type;
    this.savePaneSeriesType(key, type);
    try { pane.series?.remove(); } catch (_) { /* disposed */ }
    pane.series = pane.chart.addSeries(this.isTransformSeriesType(type) ? 'candlestick' : type);
    this.renderPaneSeries(key);
    this.renderPaneTypeBar(key);
  },

  /** Pane equivalent of renderChartSeries() (dashboard-chart-types.js) - same shared
   * computeSeriesBars() helper, retargeted at one pane's own series/candles/box-size. Panes are
   * rebuilt from scratch on every refreshOptionPanes(), never live-ticked, so unlike the main
   * chart there is no incremental transform state to persist between calls. */
  renderPaneSeries(key) {
    const pane = this.optionPanes?.[key];
    if (!pane?.series) return;
    const lastClose = pane.candles?.[pane.candles.length - 1]?.close || 100;
    const box = lastClose >= 10000 ? 5 : lastClose >= 1000 ? 1 : lastClose >= 100 ? 0.5 : 0.1;
    const { bars } = this.computeSeriesBars(pane.candles, pane.seriesType || 'candlestick', box);
    pane.series.setData(bars.map((b) => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
  },

  renderPaneTypeBar(key) {
    const host = document.getElementById(`chart-pane-type-${key}`);
    if (!host) return;
    const pane = this.optionPanes?.[key];
    const current = pane?.seriesType || 'candlestick';
    host.innerHTML = `
      ${PLAIN_SERIES_TYPES.map((t) => `
        <button type="button" class="chart-ind-btn ${current === t.type ? 'active' : ''}" data-pane-charttype="${t.type}">
          ${t.label}
        </button>`).join('')}
      ${Object.entries(TRANSFORM_SERIES_TYPES).map(([type, def]) => `
        <button type="button" class="chart-ind-btn ${current === type ? 'active' : ''}" data-pane-charttype="${type}">
          ${def.label}
        </button>`).join('')}
    `;
    host.querySelectorAll('[data-pane-charttype]').forEach((btn) => {
      btn.addEventListener('click', () => this.setPaneSeriesType(key, btn.dataset.paneCharttype));
    });
  },
});

/**
 * Indicators.
 *
 * The engine (openalgo-charts) owns the maths, series creation and pane placement for every
 * indicator instance - see ensureIndicators() below. This layer is only the config (on/off,
 * per-instance settings) and the toolbar UI on top of it.
 */
/**
 * `indicatorId` names the openalgo-charts descriptor (see openalgo-charts/indicators); `id` is
 * ours, and exists only so two instances of the same descriptor (sma1/sma2, ema1/ema2/ema3) can
 * each carry their own on/off state and settings - the engine itself is fine with several
 * instances of one descriptor coexisting, it just does not name them for us.
 *
 * `settings` seeds this app's preferred starting point where it differs from the descriptor's
 * own default (a second SMA at 50, three EMAs instead of one); indicatorConfig() merges it over
 * `indicatorDefaults()` rather than restating every key, so an upstream default change (colour,
 * source) still comes through untouched.
 */
const INDICATOR_DEFS = [
  { id: 'sma1', indicatorId: 'sma', label: 'SMA', settings: { length: 20 } },
  { id: 'sma2', indicatorId: 'sma', label: 'SMA', settings: { length: 50 } },
  { id: 'ema1', indicatorId: 'ema', label: 'EMA', settings: { length: 9 } },
  { id: 'ema2', indicatorId: 'ema', label: 'EMA', settings: { length: 21 } },
  { id: 'ema3', indicatorId: 'ema', label: 'EMA', settings: { length: 50 } },
  { id: 'vwap', indicatorId: 'vwap', label: 'VWAP', settings: {} },
  { id: 'rsi', indicatorId: 'rsi', label: 'RSI', settings: { length: 14 } },
  { id: 'macd', indicatorId: 'macd', label: 'MACD', settings: {} },
  { id: 'wma1', indicatorId: 'wma', label: 'WMA', settings: {} },
  { id: 'bollinger1', indicatorId: 'bollinger', label: 'Bollinger Bands', settings: {} },
  { id: 'stochastic1', indicatorId: 'stochastic', label: 'Stochastic', settings: {} },
  { id: 'adx1', indicatorId: 'adx', label: 'ADX / DMI', settings: {} },
  { id: 'atr1', indicatorId: 'atr', label: 'ATR', settings: {} },
  { id: 'cci1', indicatorId: 'cci', label: 'CCI', settings: {} },
  { id: 'mfi1', indicatorId: 'mfi', label: 'MFI', settings: {} },
  { id: 'obv1', indicatorId: 'obv', label: 'OBV', settings: {} },
  { id: 'adl1', indicatorId: 'adl', label: 'ADL', settings: {} },
  { id: 'volume1', indicatorId: 'volume', label: 'Volume', settings: {} },
  { id: 'supertrend1', indicatorId: 'supertrend', label: 'Supertrend', settings: {} },
  { id: 'parabolicsar1', indicatorId: 'parabolic-sar', label: 'Parabolic SAR', settings: {} },
  { id: 'ichimoku1', indicatorId: 'ichimoku', label: 'Ichimoku Cloud', settings: {} },
  { id: 'vixfix1', indicatorId: 'williams-vix-fix', label: 'Williams VIX Fix', settings: {} },
];

/** Below this, the price pane and its axis labels stop being usable. */
const MIN_CHART_BUDGET_HEIGHT = 360;

/**
 * Bars of empty space kept to the right of the last candle on a CE/PE pane. Fitting the data
 * edge-to-edge jams the live bar against the price scale. The main chart sets its own right
 * offset independently - see restoreChartView in dashboard-chart.js.
 */
const RIGHT_OFFSET_BARS = 8;

/**
 * The descriptor's OWN default settings, keyed by ITS field names (`length`, `fastPeriod`, not a
 * guessed `period`/`fast` - guessing those instead of reading them from `indicatorDefaults` got
 * two of five wrong on the first pass). Covers BOTH the descriptor's tunable `inputs` (length,
 * source, overbought/oversold...) and its derived per-plot style inputs (`ma:opacity`,
 * `histogram:lineStyle`...) from `indicatorStyleInputs` - `indicatorDefaults` alone only covers
 * the former, and the settings panel below needs both to actually show every knob the engine
 * exposes for an indicator, not just the "core" ones. Falls back to `{}` before the bridge module
 * has populated `window.OAC` - indicatorConfig() re-derives once it has, since nothing here is
 * cached across a missing descriptor.
 */
function nativeDefaults(indicatorId) {
  if (!window.OAC?.hasIndicator?.(indicatorId)) return {};
  const descriptor = window.OAC.getIndicator(indicatorId);
  const defaults = { ...window.OAC.indicatorDefaults(descriptor) };
  for (const input of window.OAC.indicatorStyleInputs(descriptor)) {
    if (!(input.key in defaults)) defaults[input.key] = input.default;
  }
  return defaults;
}

/**
 * Every settings-panel field for one indicator: the descriptor's own `inputs` (length, source,
 * overbought/oversold, colour...) plus its derived style inputs (per-plot opacity, thickness,
 * line style, plot type), deduped by key - a handful of single-plot indicators (SMA, EMA, VWAP,
 * RSI) declare `color` in both lists, and `inputs` wins since it is the one `calc`/the plot's
 * `colorKey` actually reads first.
 */
function indicatorInputsFor(indicatorId) {
  if (!window.OAC?.hasIndicator?.(indicatorId)) return [];
  const descriptor = window.OAC.getIndicator(indicatorId);
  const own = descriptor.inputs || [];
  const seen = new Set(own.map((i) => i.key));
  const style = window.OAC.indicatorStyleInputs(descriptor).filter((i) => !seen.has(i.key));
  return [...own, ...style];
}

Object.assign(DashboardApp.prototype, {
  /**
   * Indicator state: `{ [id]: { on, settings } }`, persisted so a workspace survives a reload.
   * `settings` starts from the descriptor's own defaults, merged with this app's preferred
   * starting point (a second EMA at 21, RSI at 14...) and then whatever was saved - so a
   * settings key the library adds or renames later is picked up automatically rather than a
   * saved config silently going stale.
   *
   * `scope` is `undefined` for the main chart, or `'ce'`/`'pe'` for an option pane - each gets
   * its OWN storage key and cache slot, so a CE pane's indicator selection never leaks onto the
   * main chart or the PE pane. A pane that has never been customized starts from the SAME
   * defaults as the main chart (nothing on) rather than mirroring whatever the main chart
   * currently has on - "independent" means independent from the start, not a one-time copy.
   */
  indicatorConfig(scope) {
    const storageKey = scope ? `chart-indicator-config-${scope}` : 'chart-indicator-config';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) {}
    const cfg = {};
    for (const def of INDICATOR_DEFS) {
      const s = saved[def.id] || {};
      cfg[def.id] = {
        on: Boolean(s.on),
        settings: { ...nativeDefaults(def.indicatorId), ...def.settings, ...(s.settings || {}) },
      };
    }
    // Preserve any live indicator handle across a config re-read; ensureIndicators() diffs
    // against this - the same object identity would otherwise be lost every call.
    this._indCfgByScope = this._indCfgByScope || {};
    this._indCfgByScope[scope || 'main'] = cfg;
    return cfg;
  },

  saveIndicatorConfig(scope) {
    const storageKey = scope ? `chart-indicator-config-${scope}` : 'chart-indicator-config';
    const src = this._indCfgByScope?.[scope || 'main'];
    try {
      const plain = {};
      for (const [id, v] of Object.entries(src || {})) plain[id] = { on: v.on, settings: v.settings };
      localStorage.setItem(storageKey, JSON.stringify(plain));
    } catch (_) { /* private mode */ }
  },

  /** Numeric CORE inputs only (length, fastPeriod/slowPeriod/signalPeriod, overbought/oversold)
   * - the descriptor's own declared inputs, in its own declaration order, not the derived style
   * inputs (opacity/thickness/...), which say nothing useful in a compact button label. */
  indicatorLabel(def, scope) {
    const s = this.indicatorConfig(scope)[def.id].settings;
    const parts = (window.OAC?.getIndicator?.(def.indicatorId)?.inputs || [])
      .filter((i) => i.type === 'number')
      .map((i) => s[i.key]);
    return parts.length ? `${def.label} ${parts.join('/')}` : def.label;
  },

  toggleIndicator(id, scope) {
    const cfg = this.indicatorConfig(scope);
    if (!cfg[id]) return;
    cfg[id].on = !cfg[id].on;
    this.saveIndicatorConfig(scope);
    if (scope) {
      this.renderPaneIndicatorBar(scope);
    } else {
      this.renderIndicatorBar();
      this.updateChartBarChips?.();
    }
    this.ensureIndicators();
  },

  /**
   * Validate and store one settings field, typed against the descriptor's OWN input schema -
   * `type: 'number'` reads bounds from the input's own `min`/`max` rather than a guessed table,
   * `'boolean'` coerces to a real boolean, everything else (`color`/`text`/`select`/`source`)
   * passes through as a string. An out-of-range length yields an empty series and a blank pane,
   * hence the bounds check; the two cross-field checks below are real trading-correctness rules
   * this app adds on top of the engine's own (which does not know one field's value should
   * constrain another).
   */
  setIndicatorParam(id, key, raw, scope) {
    const cfg = this.indicatorConfig(scope)[id];
    const def = INDICATOR_DEFS.find((d) => d.id === id);
    if (!cfg || !def || cfg.settings[key] === undefined) return false;
    const input = indicatorInputsFor(def.indicatorId).find((i) => i.key === key);

    let value;
    if (input?.type === 'number') {
      const n = Number(raw);
      const lo = input.min ?? -Infinity;
      const hi = input.max ?? Infinity;
      if (!Number.isFinite(n) || n < lo || n > hi) return false;
      value = input.step && input.step < 1 ? Math.round(n / input.step) * input.step : Math.round(n);
    } else if (input?.type === 'boolean') {
      value = Boolean(raw);
    } else {
      value = String(raw);
    }

    // MACD is meaningless unless fast < slow; silently accepting the inverse draws a line that
    // looks plausible and means nothing.
    if (id === 'macd' && (key === 'fastPeriod' || key === 'slowPeriod')) {
      const next = { ...cfg.settings, [key]: value };
      if (next.fastPeriod >= next.slowPeriod) return false;
    }
    if (id === 'rsi' && (key === 'overbought' || key === 'oversold')) {
      const next = { ...cfg.settings, [key]: value };
      if (next.oversold >= next.overbought) return false;
    }
    cfg.settings[key] = value;
    this.saveIndicatorConfig(scope);
    return true;
  },

  renderIndicatorBar() {
    const host = document.getElementById('chart-indicators-bar');
    if (!host) return;
    const cfg = this.indicatorConfig();
    host.innerHTML = `
      <span class="chart-toolbar-label">Indicators</span>
      ${INDICATOR_DEFS.map((d) => `
        <button type="button" class="chart-ind-btn ${cfg[d.id].on ? 'active' : ''}"
                data-ind="${d.id}">${Utils.escapeHTML(this.indicatorLabel(d))}</button>`).join('')}
      <button type="button" class="chart-ind-btn ${this.enabledPatterns().length ? 'active' : ''}"
              data-ind="patterns">Patterns</button>
      <button type="button" class="chart-ind-settings" data-action="settings" title="Indicator settings">Settings</button>`;

    host.querySelectorAll('.chart-ind-btn[data-ind]').forEach((b) => {
      if (b.dataset.ind === 'patterns') { b.addEventListener('click', () => this.togglePatternPicker()); return; }
      b.addEventListener('click', () => this.toggleIndicator(b.dataset.ind));
    });
    host.querySelector('[data-action="settings"]')
      .addEventListener('click', () => this.toggleIndicatorSettings());
  },

  /**
   * The CE/PE pane equivalent of renderIndicatorBar() - same markup and behaviour, scoped to one
   * pane's own indicator selection. Rebuilt each time a pane popover opens/updates, same as the
   * pane itself is rebuilt from scratch on every refreshOptionPanes() call.
   */
  renderPaneIndicatorBar(scope) {
    const host = document.getElementById(`chart-pane-ind-${scope}`);
    if (!host) return;
    const cfg = this.indicatorConfig(scope);
    host.innerHTML = `
      ${INDICATOR_DEFS.map((d) => `
        <button type="button" class="chart-ind-btn ${cfg[d.id].on ? 'active' : ''}"
                data-ind="${d.id}">${Utils.escapeHTML(this.indicatorLabel(d, scope))}</button>`).join('')}
      <button type="button" class="chart-ind-settings" data-action="settings" title="Indicator settings">Settings</button>`;

    host.querySelectorAll('.chart-ind-btn[data-ind]').forEach((b) => {
      b.addEventListener('click', () => this.toggleIndicator(b.dataset.ind, scope));
    });
    host.querySelector('[data-action="settings"]')
      .addEventListener('click', () => this.togglePaneIndicatorSettings(scope));
  },

  /**
   * The openalgo-charts settings panel: every field the engine itself declares for each
   * indicator (indicatorInputsFor - the descriptor's own `inputs` plus its derived per-plot
   * style inputs), not a hand-curated subset. A number gets its bounds from the descriptor's own
   * `min`/`max`; a colour gets a colour swatch; `select`/`source` get the descriptor's own option
   * list (line style, plot type, price source...) instead of a free-text box.
   */
  _indicatorFieldControl(defId, input, value) {
    const common = `data-ind="${defId}" data-key="${Utils.escapeHTML(input.key)}"`;
    if (input.type === 'number') {
      return `<input type="number" ${common} value="${value}"
                     min="${input.min ?? ''}" max="${input.max ?? ''}" step="${input.step ?? 1}" />`;
    }
    if (input.type === 'boolean') {
      return `<input type="checkbox" ${common} ${value ? 'checked' : ''} />`;
    }
    if (input.type === 'color') {
      return `<input type="color" ${common} value="${value}" />`;
    }
    if (input.type === 'select' || input.type === 'source') {
      const options = input.type === 'source' ? (window.OAC?.INDICATOR_SOURCES || []) : (input.options || []);
      return `<select ${common}>
        ${options.map((o) => `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${Utils.escapeHTML(o.label)}</option>`).join('')}
      </select>`;
    }
    return `<input type="text" ${common} value="${Utils.escapeHTML(String(value ?? ''))}" />`;
  },

  /**
   * The settings panel, scoped to the main chart (no `scope`) or one CE/PE pane. Patterns stay
   * main-chart-only - `applyPatternsTo` draws markers from the same shared pattern config
   * regardless of pane, so a per-pane "Choose patterns…" row would edit the same thing twice
   * under two different UIs; only offered here, not on pane panels.
   */
  toggleIndicatorSettings(scope) {
    const panel = document.getElementById(scope ? `chart-pane-ind-cfg-${scope}` : 'chart-ind-config');
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }

    const cfg = this.indicatorConfig(scope);
    panel.hidden = false;
    panel.innerHTML = `
      <div class="chart-ind-cfg-grid">
        ${INDICATOR_DEFS.map((d) => {
          const inputs = indicatorInputsFor(d.indicatorId);
          const settings = cfg[d.id].settings;
          return `
          <div class="chart-ind-cfg-row">
            <span class="chart-ind-cfg-name">${Utils.escapeHTML(d.label)}</span>
            ${inputs.length
              ? inputs.map((inp) => `
                  <label class="chart-ind-cfg-field" title="${Utils.escapeHTML(inp.group ? `${inp.group} · ${inp.label}` : inp.label)}">
                    <span>${Utils.escapeHTML(inp.label)}</span>
                    ${this._indicatorFieldControl(d.id, inp, settings[inp.key])}
                  </label>`).join('')
              : '<span class="chart-ind-cfg-none">no settings</span>'}
          </div>`;
        }).join('')}
        ${scope ? '' : `
        <div class="chart-ind-cfg-row">
          <span class="chart-ind-cfg-name">Patterns</span>
          <button type="button" class="chart-ind-settings" data-action="patterns">Choose patterns…</button>
        </div>`}
      </div>
      <p class="chart-ind-cfg-note">
        Changes apply immediately. MACD requires fast &lt; slow; RSI requires oversold &lt; overbought.
      </p>`;

    panel.querySelector('[data-action="patterns"]')
      ?.addEventListener('click', () => this.togglePatternPicker());

    panel.querySelectorAll('[data-ind][data-key]').forEach((field) => {
      field.addEventListener('change', () => {
        const raw = field.type === 'checkbox' ? field.checked : field.value;
        const ok = this.setIndicatorParam(field.dataset.ind, field.dataset.key, raw, scope);
        if (!ok) {
          // Snap back rather than leaving an invalid figure sitting in the box.
          const prev = this.indicatorConfig(scope)[field.dataset.ind].settings[field.dataset.key];
          if (field.type === 'checkbox') field.checked = Boolean(prev); else field.value = prev;
          Utils.showToast('Value out of range for this indicator', 'error');
          return;
        }
        if (scope) this.renderPaneIndicatorBar(scope); else this.renderIndicatorBar();
        this.ensureIndicators();
      });
    });
  },

  togglePaneIndicatorSettings(scope) {
    this.toggleIndicatorSettings(scope);
  },

  /**
   * Reconcile the chart's live indicator instances against `indicatorConfig()`.
   *
   * The engine owns series creation, pane placement (RSI/MACD get their own pane
   * automatically), recompute-on-data-change, and teardown for each instance - which is what
   * let this replace the ~250 lines of hand-rolled pane-height/stretch-factor/live-recompute
   * bookkeeping the previous (Lightweight Charts based) implementation needed. Diffed rather
   * than rebuilt from scratch each call, so toggling one indicator does not flicker the rest.
   */
  ensureIndicators() {
    this._liveIndicators = this._liveIndicators || new Map(); // our id -> IndicatorApi
    this._reconcileIndicators(this.chart, this._liveIndicators, this.indicatorConfig());
    // Each CE/PE pane reconciles against its OWN indicator config, not the main chart's - see
    // indicatorConfig(scope). Independent selection per pane, not a shared one applied 3x.
    for (const key of ['ce', 'pe']) {
      const pane = this.optionPanes?.[key];
      if (!pane?.chart) continue;
      pane.liveIndicators = pane.liveIndicators || new Map();
      this._reconcileIndicators(pane.chart, pane.liveIndicators, this.indicatorConfig(key));
    }
  },

  /**
   * The actual reconciliation, generic over WHICH chart AND which config - the main chart and
   * each CE/PE pane carry their own indicator set against their own `cfg`/`store` pair (a plain
   * id -> IndicatorApi map), so switching on RSI on the PE pane never touches the main chart or
   * the CE pane.
   */
  _reconcileIndicators(chart, store, cfg) {
    if (!chart || !window.OAC || !store || !cfg) return;

    /**
     * chart.removeIndicator(id), not live.remove(): the empty-pane cleanup (an oscillator's pane
     * disappearing once its last indicator leaves it) lives specifically in the chart's
     * removeIndicator, one level above the instance's own remove(). Calling remove() directly
     * detaches the series but leaves the now-empty pane sitting there permanently.
     *
     * There is a real bug in that same removeIndicator, though: removing one indicator's pane
     * reindexes every indicator ABOVE it (shiftPane(-1), pane 2 becomes pane 1) - but a survivor
     * from an EARLIER, already-returned reconcile call does not have that shift reflected in
     * whatever internal reference removeIndicator's own series lookup holds for it, so removing
     * IT next throws reading a property of undefined. This is not just an ordering-within-one-
     * call problem (sorting a single removal batch by pane index does not help): toggling RSI
     * off, then in a SEPARATE later click toggling MACD off, hits it too, since MACD survived
     * RSI's removal as a "live" instance whose pane the engine already silently shifted under it.
     *
     * The reliable fix - verified against the vendored engine directly, not just inferred - is to
     * never call removeIndicator on a survivor of a PRIOR reconcile at all: whenever anything
     * needs removing, drop every currently-live instance in this store (highest pane first, all
     * still fresh - none of them has survived a removal yet at that point) and re-add whichever
     * ones are still wanted. A few indicators recomputing from scratch is cheap; a permanently
     * stuck blank pane is the alternative.
     */
    const toRemove = INDICATOR_DEFS.some((def) => !cfg[def.id].on && store.has(def.id));
    if (toRemove) {
      const live = [...store.entries()].sort((a, b) => (b[1].paneIndex ?? 0) - (a[1].paneIndex ?? 0));
      for (const [id, api] of live) {
        try { chart.removeIndicator(api.id); } catch (error) { console.error(`[Chart] removing indicator ${id} failed`, error); }
        store.delete(id);
      }
    }

    for (const def of INDICATOR_DEFS) {
      const want = cfg[def.id];
      if (!want.on) continue;
      const live = store.get(def.id);
      if (live) {
        let ok = true;
        try { live.setSettings(want.settings); } catch (_) { ok = false; /* disposed; recreate below */ }
        if (ok) continue;
        store.delete(def.id);
      }
      try {
        store.set(def.id, chart.addIndicator(def.indicatorId, want.settings));
      } catch (error) {
        console.error(`[Chart] indicator ${def.id} failed`, error);
      }
    }
  },

  /**
   * Overlays and oscillators alike now come from ensureIndicators()/`_reconcileIndicators`; kept
   * as an alias so the existing call sites (loadChartData, the timeframe/symbol switch handlers,
   * and `_buildOptionPane` for each CE/PE pane) need no changes beyond passing their own chart.
   */
  applyIndicatorsTo(chart) {
    if (!chart) return;
    if (chart === this.chart) { this.ensureIndicators(); return; }
    for (const key of ['ce', 'pe']) {
      const pane = this.optionPanes?.[key];
      if (pane?.chart !== chart) continue;
      pane.liveIndicators = pane.liveIndicators || new Map();
      this._reconcileIndicators(chart, pane.liveIndicators, this.indicatorConfig(key));
      return;
    }
  },

  /**
   * Advance every indicator to the live bar.
   *
   * A no-op by design: `chart.addIndicator` instances recompute themselves when the source
   * series changes, which `applyChartQuote`'s `candleSeries.update()` call already is. Kept as
   * a named call (rather than removing the call site in dashboard-chart-live.js) so a future
   * indicator that needs an explicit nudge has one place to add it.
   */
  refreshLiveIndicators() {},

  /** Kept as an alias: oscillator panes are now indicator instances, not separate sub-charts. */
  refreshOscillator() {
    this.ensureIndicators();
  },

  /**
   * How much vertical room the whole chart widget - price pane plus every oscillator - may use
   * without pushing the page into a scroll.
   *
   * Measured from the container's actual position rather than assumed: the toolbar above it is
   * one row now, but the popover-based redesign means that could change again, and hardcoding a
   * chrome estimate would silently drift out of sync with it. `getBoundingClientRect().top`
   * always reflects the real current layout.
   */
  chartBudgetHeight() {
    const container = document.getElementById('chart-container');
    if (!container) return MIN_CHART_BUDGET_HEIGHT;
    const top = container.getBoundingClientRect().top;
    // 16px of border breathing room, plus the attribution line below the chart (the Apache-2.0
    // notice required by Lightweight Charts) and the flex gap in front of it - leaving those out
    // was the last few pixels of page scroll the fit was supposed to eliminate.
    const bottomPad = 48;
    const available = window.innerHeight - top - bottomPad;
    return Math.max(MIN_CHART_BUDGET_HEIGHT, Math.round(available));
  },

  /**
   * Size the chart element to hold the price pane plus every oscillator.
   *
   * The container used to be set to the literal SUM of every pane's preferred height, which
   * overflowed the viewport the moment two or three oscillators were on - RSI and MACD both
   * ended up below the fold, reachable only by scrolling the whole page. Stretch factors (see
   * refreshOscillator) allocate space as RATIOS, not pixels, so the actual container height can
   * be whatever fits the screen; the proportions - and a user's own dragged sizes - are
   * preserved regardless. The container is capped to `chartBudgetHeight()` instead of the raw
   * sum, so the full widget always fits in one viewport.
   */
  resizeChartForPanes() {
    const container = document.getElementById('chart-container');
    if (!container) return;
    container.style.height = `${this.chartBudgetHeight()}px`;
  },

  /**
   * No-ops kept as named call sites (destroyChart calls rememberOscHeights;
   * chartBudgetHeight/resizeChartForPanes still size the container). Oscillators are now
   * `chart.addIndicator` instances the engine tears down with the chart itself in one
   * `chart.destroy()` - there is no separate pane bookkeeping left to do here.
   */
  destroyOscillatorPanes() {
    this.oscCharts = [];
  },

  rememberOscHeights() {},

  /**
   * Trade the CE/PE contract straight off its own pane.
   *
   * Right-click a price on the leg's chart and it places a resting order on THAT contract, on
   * every selected instance. Deliberately limited to LIMIT and SL-M: a market order on options
   * belongs to the BUY/SELL CE/PE tickets, which resolve a strike per instance from each one's
   * live price. Picking a price on this pane means the opposite - this exact contract - so it
   * goes to /orders with the symbol named outright.
   */
  attachOptionPaneOrders(key, bodyEl, chart, contract, candles) {
    if (!bodyEl || !chart || !contract) return;
    const last = candles?.length ? candles[candles.length - 1].close : null;

    bodyEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = document.getElementById('chart-ctx');
      if (!menu) return;

      if (!this.chartTradeInfo || this.chartTradeBlocked) {
        Utils.showToast('No order-enabled instance assigned to this symbol', 'error');
        return;
      }

      const rect = bodyEl.getBoundingClientRect();
      const price = chart.coordinateToPrice(e.clientY - rect.top, 0);
      if (!Number.isFinite(price)) return;
      const at = Number(price.toFixed(2));

      // Same validity rules as the underlying's menu: a buy limit sits below the last traded
      // price, a buy stop above it, and the reverse for a sell.
      const below = last !== null && at < last;
      const above = last !== null && at > last;
      const p = Utils.formatNumber(at);
      const items = [
        { side: 'BUY', orderType: 'LIMIT', price: at, label: `Buy Limit @ ${p}`, enabled: below,
          why: 'a buy limit must sit below the last price' },
        { side: 'BUY', orderType: 'SL-M', price: at, label: `Buy Stop @ ${p}`, enabled: above,
          why: 'a buy stop must sit above the last price' },
        { side: 'SELL', orderType: 'LIMIT', price: at, label: `Sell Limit @ ${p}`, enabled: above,
          why: 'a sell limit must sit above the last price' },
        { side: 'SELL', orderType: 'SL-M', price: at, label: `Sell Stop @ ${p}`, enabled: below,
          why: 'a sell stop must sit below the last price' },
      ].map((it) => ({ ...it, contract }));

      // Closing is a distinct action, not an order on this contract at this price - it fans out
      // to the position-close endpoint (see closePanePosition), not /orders, so it is rendered
      // and bound separately from the priced items above rather than folded into `items`.
      const pane = this.optionPanes?.[key];
      const hasPosition = Boolean(pane?.positionData?.netQuantity);

      menu.innerHTML = `<div class="chart-ctx-head">${Utils.escapeHTML(contract.symbol)} · lot ${contract.lotsize}</div>`
        + items.map((it, i) => `
          <button type="button" class="chart-ctx-item ${it.side === 'BUY' ? 'is-buy' : 'is-sell'}"
                  data-i="${i}" ${it.enabled ? '' : 'disabled'}
                  ${it.enabled ? '' : `title="Not valid here — ${Utils.escapeHTML(it.why)}"`}>
            ${Utils.escapeHTML(it.label)}
          </button>`).join('')
        + (hasPosition ? `
          <div class="chart-ctx-sep"></div>
          <button type="button" class="chart-ctx-item is-neutral" data-action="close-position">
            Close position (${pane.positionData.netQuantity > 0 ? '+' : ''}${pane.positionData.netQuantity})
          </button>` : '');

      // The menu lives in the main chart's wrapper, so it is positioned against that.
      const host = document.getElementById('chart-container')?.getBoundingClientRect();
      if (host) {
        menu.style.left = `${Math.max(0, Math.min(e.clientX - host.left, host.width - 210))}px`;
        menu.style.top = `${Math.max(0, Math.min(e.clientY - host.top, host.height - 40))}px`;
      }
      menu.hidden = false;

      menu.querySelectorAll('.chart-ctx-item[data-i]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          menu.hidden = true;
          this.confirmChartOrder(items[Number(btn.dataset.i)]);
        });
      });
      menu.querySelector('[data-action="close-position"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        this.closePanePosition(key);
      });
    });
  },

  /**
   * Fans out a real position close, per instance actually holding a leg (from the same
   * `/positions/symbol` legs this pane's own position line is drawn from) - NOT routed through
   * confirmChartOrder/placeChartOrder, whose `contract` branch posts a named order straight to
   * /orders (a specific side+price+qty), which has no "flatten whatever is open" concept the way
   * /quickorders' EXIT_ALL does. POST /positions/:instanceId/close/position is the endpoint the
   * Positions page's own per-symbol close already uses for exactly this.
   */
  async closePanePosition(key) {
    const pane = this.optionPanes?.[key];
    const data = pane?.positionData;
    if (!pane?.contract || !data?.legs?.length) return;

    const qty = Math.abs(data.netQuantity);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content chart-confirm">
        <div class="modal-header">
          <h3>Close position — ${Utils.escapeHTML(pane.contract.symbol)}</h3>
        </div>
        <div class="modal-body">
          <p class="chart-confirm-lead">
            Closes the ${data.netQuantity > 0 ? 'LONG' : 'SHORT'} <strong>${qty}</strong>
            position on <strong>${Utils.escapeHTML(pane.contract.symbol)}</strong> across
            <strong>${data.legs.length}</strong> instance${data.legs.length === 1 ? '' : 's'} at market.
          </p>
          <p class="chart-confirm-note">
            Instances are contacted independently. Some may fill while others fail — the result
            is reported per instance.
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" data-action="cancel">Cancel</button>
          <button class="btn btn-close-all" data-action="go">Close on ${data.legs.length}</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-action="go"]').addEventListener('click', async () => {
      close();
      const results = await Promise.allSettled(data.legs.map((leg) => api.request(
        `/positions/${leg.instanceId}/close/position`,
        {
          method: 'POST',
          body: {
            symbol: pane.contract.symbol,
            exchange: pane.contract.exchange,
            tradeMode: 'OPTIONS',
            product: this.chartState?.product || 'MIS',
          },
        },
      )));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      Utils.showToast(
        failed ? `Closed on ${ok}, failed on ${failed}` : `Position closed on ${ok} instance${ok === 1 ? '' : 's'}`,
        failed ? 'error' : 'success',
      );
      await this.loadPanePosition(key);
    });
  },

  /**
   * Per-pattern state: `{ [id]: { on, colour, position } }`, persisted like the indicator config
   * and merged over defaults so a new pattern in a later release just appears, switched off.
   *
   * Colour and position default from the pattern's own direction - bullish below the bar in
   * green, bearish above it in red - which is the convention the markers are read with.
   */
  patternConfig() {
    if (!this._patCfg) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('chart-patterns') || '{}'); } catch (_) { /* corrupt */ }
      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue('--color-profit').trim() || '#34D399';
      const down = css.getPropertyValue('--color-loss').trim() || '#F87171';

      this._patCfg = {};
      for (const def of (window.ChartPatterns?.PATTERNS || [])) {
        const s2 = saved[def.id] || {};
        this._patCfg[def.id] = {
          on: Boolean(s2.on),
          colour: s2.colour || (def.bullish === true ? up : def.bullish === false ? down : '#9CA3AF'),
          position: s2.position || (def.bullish === true ? 'belowBar' : 'aboveBar'),
        };
      }
    }
    return this._patCfg;
  },

  savePatternConfig() {
    try { localStorage.setItem('chart-patterns', JSON.stringify(this._patCfg)); } catch (_) { /* private mode */ }
  },

  /** Ids currently switched on. Empty means nothing is drawn even if the layer is enabled. */
  enabledPatterns() {
    return Object.entries(this.patternConfig()).filter(([, v]) => v.on).map(([id]) => id);
  },

  /**
   * Draw pattern markers on a candle series.
   *
   * Markers are attached per series, so the underlying and each option pane get their own - a
   * Hammer on the underlying says nothing about the option's own bars.
   */
  applyPatternsTo(chart, series, candles) {
    const holder = this._patternMarkers || (this._patternMarkers = new Map());
    let markerLayer = holder.get(series);
    if (markerLayer) { try { markerLayer.setMarkers([]); } catch (_) { /* series gone */ } }

    const enabled = this.enabledPatterns();
    if (!series || !candles?.length || !window.ChartPatterns || !enabled.length) return;

    const cfg = this.patternConfig();
    // Pattern detection needs a `.time` field; candles from the history API carry `.ts` -
    // no IST shift here (see the TIME AXIS note in dashboard-chart.js).
    const withTime = candles.map((c) => ({ ...c, time: c.ts ?? c.time }));
    const markers = window.ChartPatterns.detect(withTime, enabled).map((hit) => ({
      time: hit.time,
      position: cfg[hit.id].position,
      color: cfg[hit.id].colour,
      shape: cfg[hit.id].position === 'belowBar' ? 'arrowUp' : 'arrowDown',
      // The code, not the name: at any real bar density "Bearish Engulfing" is wider than a
      // dozen candles and the labels overrun each other. The key is in the pattern picker.
      text: hit.short || hit.label,
    }));
    if (!markers.length) return;

    // Markers require ascending time; detect() emits several hits per bar, so the array is
    // bar-ordered but not strictly sorted across patterns on the same bar.
    markers.sort((a, b) => a.time - b.time);
    if (!markerLayer) { markerLayer = series.createMarkers(); holder.set(series, markerLayer); }
    markerLayer.setMarkers(markers);
  },

  /**
   * The pattern list: one row per pattern with an enable box, a marker colour and a placement.
   * Long by nature (over forty patterns), so it scrolls in place rather than pushing the chart
   * off the screen.
   */
  togglePatternPicker() {
    const panel = document.getElementById('chart-pattern-picker');
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }

    const defs = window.ChartPatterns?.PATTERNS || [];
    const cfg = this.patternConfig();
    panel.hidden = false;
    panel.innerHTML = `
      <div class="chart-pat-head">
        <span>Candlestick patterns</span>
        <span class="chart-pat-key">markers show the code</span>
        <span class="chart-pat-count" data-role="count">${this.enabledPatterns().length} on</span>
        <button type="button" class="chart-ind-settings" data-action="none">Clear all</button>
        <button type="button" class="chart-ind-settings" data-action="close">Done</button>
      </div>
      <div class="chart-pat-list">
        ${defs.map((d) => `
          <div class="chart-pat-row">
            <label class="chart-pat-name" title="Drawn on the chart as ${Utils.escapeHTML(d.short)}">
              <input type="checkbox" data-pat="${d.id}" ${cfg[d.id].on ? 'checked' : ''} />
              <code class="chart-pat-code">${Utils.escapeHTML(d.short)}</code>
              <span>${Utils.escapeHTML(d.label)}</span>
            </label>
            <input type="color" data-pat-colour="${d.id}" value="${cfg[d.id].colour}"
                   aria-label="${Utils.escapeHTML(d.label)} marker colour" />
            <select data-pat-pos="${d.id}" aria-label="${Utils.escapeHTML(d.label)} marker position">
              <option value="belowBar" ${cfg[d.id].position === 'belowBar' ? 'selected' : ''}>Below bar</option>
              <option value="aboveBar" ${cfg[d.id].position === 'aboveBar' ? 'selected' : ''}>Above bar</option>
            </select>
          </div>`).join('')}
      </div>`;

    const redraw = () => {
      this.savePatternConfig();
      panel.querySelector('[data-role="count"]').textContent = `${this.enabledPatterns().length} on`;
      this.reapplyIndicators();
    };
    panel.querySelectorAll('input[data-pat]').forEach((el) =>
      el.addEventListener('change', () => { cfg[el.dataset.pat].on = el.checked; redraw(); }));
    panel.querySelectorAll('input[data-pat-colour]').forEach((el) =>
      el.addEventListener('change', () => { cfg[el.dataset.patColour].colour = el.value; redraw(); }));
    panel.querySelectorAll('select[data-pat-pos]').forEach((el) =>
      el.addEventListener('change', () => { cfg[el.dataset.patPos].position = el.value; redraw(); }));

    panel.querySelector('[data-action="none"]').addEventListener('click', () => {
      for (const v of Object.values(cfg)) v.on = false;
      panel.querySelectorAll('input[data-pat]').forEach((el) => { el.checked = false; });
      redraw();
    });
    panel.querySelector('[data-action="close"]').addEventListener('click', () => { panel.hidden = true; });
  },

  reapplyIndicators() {
    // Overlays live on the series, so the cleanest rebuild is a full redraw of the main chart.
    this.loadChartData().then(() => {
      this.refreshOscillator();
      if (this.chartOptionsOn) this.refreshOptionPanes();
    });
  },
});
