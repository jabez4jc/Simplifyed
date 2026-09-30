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
   *
   * The panes are PINNED to the contracts they show. A rebuild (timeframe, indicators, options
   * toggled back on) keeps them; only an explicit choice moves a pane - a strike or expiry pick
   * (`repin`), "Switch" to the current ATM (`repin`), or a contract picked from the exposure
   * strip (`pin`). Following ATM on every rebuild swapped the contract under an open position or
   * a working order, taking its lines and its exit off the screen.
   */
  async refreshOptionPanes({ repin = false, pin = null } = {}) {
    const wrap = document.getElementById('chart-panes');
    const state = this.chartState;
    if (!wrap || !state) return;

    this.destroyOptionPanes();
    this.renderSyncBar();
    // The expiry the panes show - what an option order must trade (see the order body in
    // dashboard-chart.js). Cleared until this refresh has resolved it.
    this.shownOptionExpiry = null;

    if (!this.chartOptionsOn || !this.chartLastPrice) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      document.getElementById('chart-layout')?.classList.remove('is-split');
      return;
    }

    document.getElementById('chart-layout')?.classList.add('is-split');
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="chart-pane-bar" id="chart-pane-bar" hidden></div>
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

    const held = this.paneContracts?.symbolId === state.symbolId ? this.paneContracts : null;
    const shown = {
      symbolId: state.symbolId,
      ce: pin?.type === 'CE' ? pin : (!repin && held?.ce) || legs.ce,
      pe: pin?.type === 'PE' ? pin : (!repin && held?.pe) || legs.pe,
    };
    this.paneContracts = shown;
    this.atmLegs = { ce: legs.ce, pe: legs.pe, strike: legs.atmStrike };

    this.populateExpiries(legs.expiries);
    this.shownOptionExpiry = shown.pe?.expiry || shown.ce?.expiry || legs.expiry || null;

    this.optionPanes = {};
    await Promise.all([
      this._buildOptionPane('ce', shown.ce, legs),
      this._buildOptionPane('pe', shown.pe, legs),
    ]);
    this.syncCharts();
    this.renderPaneBar();
    this.refreshExposure();
    this.startPaneWatch();
    if (typeof this.loadLevelProjections === 'function') this.loadLevelProjections();
  },

  /**
   * The strip above the panes: "ATM is now 22,700 · Switch" when a pinned pane is no longer the
   * strike the current price would pick, and one chip per contract carrying exposure (a position
   * or a pending order) on this underlying - click to put it on its pane.
   */
  renderPaneBar() {
    const bar = document.getElementById('chart-pane-bar');
    if (!bar) return;
    const shown = this.paneContracts || {};
    const atm = this.atmLegs || {};
    const moved = ['ce', 'pe'].some((k) => atm[k] && shown[k] && atm[k].symbol !== shown[k].symbol);
    const exposure = this.paneExposure || [];
    const onScreen = [shown.ce?.symbol, shown.pe?.symbol];
    const chip = (c) => {
      const qty = c.netQty ? ` · ${c.netQty > 0 ? '+' : ''}${c.netQty}` : '';
      const orders = c.orders ? ` · ${c.orders} order${c.orders === 1 ? '' : 's'}` : '';
      return `<button type="button" class="chart-pane-chip ${onScreen.includes(c.symbol) ? 'is-shown' : ''}"
                data-pin="${Utils.escapeHTML(c.symbol)}" title="${Utils.escapeHTML(`${c.symbol} - show on the ${c.type} chart`)}">
                ${Utils.escapeHTML(`${c.strike} ${c.type}`)}${Utils.escapeHTML(qty)}${Utils.escapeHTML(orders)}</button>`;
    };
    bar.innerHTML = `
      ${moved ? `<button type="button" class="chart-pane-chip is-atm" data-action="to-atm"
                  title="Show the strikes the current price picks">ATM is now ${Utils.escapeHTML(Utils.formatNumber(atm.strike))} · Switch</button>` : ''}
      ${exposure.length ? `<span class="chart-pane-bar-label">Open</span>${exposure.map(chip).join('')}` : ''}`;
    bar.hidden = !moved && !exposure.length;
    bar.querySelector('[data-action="to-atm"]')?.addEventListener('click', () => this.refreshOptionPanes({ repin: true }));
    bar.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', () => {
      const c = exposure.find((x) => x.symbol === b.dataset.pin);
      if (c) this.refreshOptionPanes({ pin: c });
    }));
  },

  /** Contracts on this underlying with a position or a pending order (GET /history/exposure). */
  async refreshExposure() {
    const state = this.chartState;
    if (!state || !this.chartOptionsOn) return;
    // Only the latest answer counts: a slower, older request must not overwrite a newer one.
    const seq = (this._exposureSeq = (this._exposureSeq || 0) + 1);
    let data = [];
    try {
      data = (await api.request(`/history/exposure?symbolId=${encodeURIComponent(state.symbolId)}`)).data || [];
    } catch (_) { /* keep it empty */ }
    if (seq !== this._exposureSeq || this.chartState?.symbolId !== state.symbolId) return;
    this.paneExposure = data;
    this.renderPaneBar();
  },

  /** Where ATM is now, for the "Switch" suggestion - never moves a pane by itself. */
  async checkPaneAtm() {
    const state = this.chartState;
    if (!state || !this.chartOptionsOn || !this.chartLastPrice || !this.paneContracts) return;
    const seq = (this._atmSeq = (this._atmSeq || 0) + 1);
    try {
      const q = new URLSearchParams({ symbolId: state.symbolId, ltp: this.chartLastPrice, leg: state.optionLeg || 'ATM' });
      if (state.optionExpiry) q.set('expiry', state.optionExpiry);
      const legs = (await api.request(`/history/option-legs?${q}`)).data;
      if (seq !== this._atmSeq || this.chartState?.symbolId !== state.symbolId || !legs?.available) return;
      this.atmLegs = { ce: legs.ce, pe: legs.pe, strike: legs.atmStrike };
      this.renderPaneBar();
    } catch (_) { /* next round */ }
  },

  /** One timer for the strip: ATM and exposure every 20s while the option charts are open. */
  startPaneWatch() {
    if (this._paneWatch) return;
    this._paneWatch = setInterval(() => {
      if (this.currentView !== 'chart' || !this.chartOptionsOn) return;
      this.checkPaneAtm();
      this.refreshExposure();
    }, 20000);
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
      <span class="chart-pane-meta">${Utils.escapeHTML(contract.expiry || legs.expiry)} · ${Utils.escapeHTML(String(contract.strike))} · lot ${contract.lotsize}</span>
      <span class="chart-pane-last" data-role="${key}-last">—</span>
      ${this.chartTradeBlocked ? '' : `
        <span class="chart-pane-trade" role="group" aria-label="Trade ${Utils.escapeHTML(contract.symbol)}">
          <button type="button" class="chart-pane-btn is-buy" data-pane-trade="BUY"
                  title="Buy ${Utils.escapeHTML(contract.symbol)} at market">BUY</button>
          <button type="button" class="chart-pane-btn is-sell" data-pane-trade="SELL"
                  title="Sell ${Utils.escapeHTML(contract.symbol)} at market">SELL</button>
          <button type="button" class="chart-pane-btn" data-pane-trade="EXIT"
                  title="Close the open position in ${Utils.escapeHTML(contract.symbol)}">EXIT</button>
        </span>`}
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
          <div id="chart-pane-ind-pick-${key}" class="chart-pattern-picker" hidden></div>
          <div id="chart-pane-ind-cfg-${key}" class="chart-ind-config" hidden></div>
        </div>
      </div>`;

    const tfEl = titleEl.querySelector('[data-pane-tf]');
    if (tfEl) tfEl.addEventListener('change', () => this.setPaneTimeframe(key, tfEl.value));
    this.bindPanePopovers(host);
    // This exact contract, at market - the BUY/SELL CE/PE tickets instead resolve a strike per
    // instance. /orders turns a price-less order into a marketable LIMIT on Indian exchanges.
    titleEl.querySelectorAll('[data-pane-trade]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.paneTrade === 'EXIT') {
        if (this.optionPanes?.[key]?.positionData?.netQuantity) this.closePanePosition(key);
        else Utils.showToast(`No open position in ${contract.symbol}`, 'info');
        return;
      }
      this.confirmChartOrder({ side: b.dataset.paneTrade, orderType: 'MARKET', contract });
    }));

    let candles = [];
    try {
      const to = Math.floor(Date.now() / 1000);
      const paneTf = this.paneTimeframe(key);
      const spanDays = HISTORY_SPAN_DAYS[paneTf] || 10;
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
      // Same engine options as the main chart (see initChart in dashboard-chart.js) - a CE/PE
      // pane that labelled its axis in a different zone, or zoomed from a different anchor,
      // would read as a different instrument sitting next to the one it is an option on.
      timezone: CHART_TIMEZONE,
      renderer: 'auto',
      zoomAnchor: 'right',
      axisChrome: { barCountdown: true },
    });
    // Independent chart type per pane (see setPaneSeriesType() below) - defaults to candlestick
    // like the main chart, not mirrored FROM the main chart, since "independent" starts at zero.
    const seriesType = this.paneSeriesType(key);
    const series = chart.addSeries(this.seriesRenderType(seriesType));
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
    pane.series = pane.chart.addSeries(this.seriesRenderType(type));
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
    // Whole bars, not a projection down to OHLC - see renderChartSeries in
    // dashboard-chart-types.js for why Kagi and P&F need the fields a candle does not read.
    pane.series.setData(bars);
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
 * Presets: the handful of slots this app opinionates about, either because it wants SEVERAL
 * instances of one descriptor (sma1/sma2, ema1/ema2/ema3 - the engine is fine with that, it just
 * does not name them for us) or because it prefers a different starting point from the
 * descriptor's own default. Everything else the engine registers is picked up automatically by
 * indicatorDefs() below, so this list is a set of opinions, not a catalogue.
 *
 * `indicatorId` names the openalgo-charts descriptor (see openalgo-charts/indicators); `id` is
 * ours, and is what the persisted config is keyed by - so these ids must not change.
 *
 * `settings` seeds the preferred starting point; indicatorConfig() merges it over
 * `indicatorDefaults()` rather than restating every key, so an upstream default change (colour,
 * source) still comes through untouched.
 */
const INDICATOR_PRESETS = [
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

let _indicatorDefs = null;
let _indicatorDefsFor = 0;

/**
 * Every indicator slot the app offers: the presets above, plus one slot for each descriptor the
 * engine registers that no preset already covers.
 *
 * openalgo-charts 2.x ships 102 built-ins; a hand-written list offered 22 of them, and every
 * release that added an indicator quietly widened that gap. The registry is the source of truth,
 * so a new built-in is on the chart the moment the library is upgraded, with the engine's own
 * name, category, inputs and defaults behind it.
 *
 * A preset id can never collide with a generated one: a descriptor a preset names is excluded
 * from the generated half, so `vwap` (a preset id that happens to equal its descriptor id) is
 * listed once.
 *
 * Memoized only once the registry actually answers - this can be reached before the bridge
 * module has run, and caching an empty catalogue would leave the chart with no indicators for
 * the life of the page.
 */
function indicatorDefs() {
  const registry = window.OAC?.registeredIndicators?.() || [];
  // Re-derived when the registry grows: an OpenScript study applied after load registers a new
  // descriptor (see openalgo-charts-bridge.js), and it has to show up in the picker.
  if (_indicatorDefs && _indicatorDefsFor === registry.length) return _indicatorDefs;
  if (!registry.length) return INDICATOR_PRESETS;
  _indicatorDefsFor = registry.length;
  const covered = new Set(INDICATOR_PRESETS.map((d) => d.indicatorId));
  const generated = registry
    .filter((d) => !covered.has(d.id))
    .map((d) => ({ id: d.id, indicatorId: d.id, label: d.name, settings: {} }));
  _indicatorDefs = [...INDICATOR_PRESETS, ...generated];
  return _indicatorDefs;
}

const OPENSCRIPT_TEMPLATE = `version 1

study("My script", overlay = true)

length = input(20, "Length")
plot(sma(close, length), "SMA", orange, width = 2)
`;

/** The engine's own grouping for a slot ('Trend', 'Momentum', ...), for the picker's headings. */
function indicatorCategory(def) {
  return window.OAC?.getIndicator?.(def.indicatorId)?.category || 'Other';
}

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
    for (const def of indicatorDefs()) {
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
    const def = indicatorDefs().find((d) => d.id === id);
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

  /**
   * Give the CE/PE panes the main chart's indicators, settings included. The pane's own set is
   * switched off and redrawn first: an indicator already on with other settings would otherwise
   * keep its old parameters, since reconciliation only adds and removes.
   */
  copyMainIndicatorsTo(scopes = ['ce', 'pe']) {
    const main = this.indicatorConfig();
    for (const scope of scopes) {
      const cleared = this.indicatorConfig(scope);
      for (const v of Object.values(cleared)) v.on = false;
      this.saveIndicatorConfig(scope);
      this.ensureIndicators();
      const cfg = this.indicatorConfig(scope);
      for (const [id, v] of Object.entries(main)) cfg[id] = { on: v.on, settings: { ...v.settings } };
      this.saveIndicatorConfig(scope);
      this.renderPaneIndicatorBar(scope);
    }
    this.ensureIndicators();
    Utils.showToast(`Main chart indicators copied to ${scopes.length === 2 ? 'both option charts' : `the ${scopes[0].toUpperCase()} chart`}`, 'success');
  },

  /** The slots currently switched on, in catalogue order - what the toolbar and the settings
   * panel both show. With 100+ indicators available, "everything, always" is not a toolbar. */
  activeIndicatorDefs(scope) {
    const cfg = this.indicatorConfig(scope);
    return indicatorDefs().filter((d) => cfg[d.id]?.on);
  },

  renderIndicatorBar() {
    const host = document.getElementById('chart-indicators-bar');
    if (!host) return;
    const active = this.activeIndicatorDefs();
    host.innerHTML = `
      <span class="chart-toolbar-label">Indicators</span>
      <button type="button" class="chart-ind-btn" data-action="add" title="Add an indicator">+ Add</button>
      ${active.map((d) => `
        <button type="button" class="chart-ind-btn active" data-ind="${d.id}"
                title="Click to remove ${Utils.escapeHTML(d.label)}">${Utils.escapeHTML(this.indicatorLabel(d))}</button>`).join('')}
      <button type="button" class="chart-ind-btn ${this.enabledPatterns().length ? 'active' : ''}"
              data-ind="patterns">Patterns</button>
      <button type="button" class="chart-ind-settings" data-action="settings" title="Indicator settings">Settings</button>
      <button type="button" class="chart-ind-settings" data-action="copy-panes"
              title="Put these indicators, with their settings, on the CE and PE option charts">Copy to option charts</button>`;

    host.querySelector('[data-action="copy-panes"]')
      .addEventListener('click', () => this.copyMainIndicatorsTo(['ce', 'pe']));
    host.querySelectorAll('.chart-ind-btn[data-ind]').forEach((b) => {
      if (b.dataset.ind === 'patterns') { b.addEventListener('click', () => this.togglePatternPicker()); return; }
      b.addEventListener('click', () => this.toggleIndicator(b.dataset.ind));
    });
    host.querySelector('[data-action="add"]')
      .addEventListener('click', () => this.toggleIndicatorPicker());
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
    host.innerHTML = `
      <button type="button" class="chart-ind-btn" data-action="add" title="Add an indicator">+ Add</button>
      ${this.activeIndicatorDefs(scope).map((d) => `
        <button type="button" class="chart-ind-btn active" data-ind="${d.id}"
                title="Click to remove ${Utils.escapeHTML(d.label)}">${Utils.escapeHTML(this.indicatorLabel(d, scope))}</button>`).join('')}
      <button type="button" class="chart-ind-settings" data-action="settings" title="Indicator settings">Settings</button>
      <button type="button" class="chart-ind-settings" data-action="copy-main"
              title="Replace this chart's indicators with the main chart's, settings included">Copy from main chart</button>`;

    host.querySelector('[data-action="copy-main"]')
      .addEventListener('click', () => this.copyMainIndicatorsTo([scope]));
    host.querySelectorAll('.chart-ind-btn[data-ind]').forEach((b) => {
      b.addEventListener('click', () => this.toggleIndicator(b.dataset.ind, scope));
    });
    host.querySelector('[data-action="add"]')
      .addEventListener('click', () => this.toggleIndicatorPicker(scope));
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
    const active = this.activeIndicatorDefs(scope);
    panel.hidden = false;
    panel.innerHTML = `
      <div class="chart-ind-cfg-grid">
        ${active.length ? '' : '<p class="chart-ind-cfg-note">No indicators on this chart yet — add one from “+ Add”.</p>'}
        ${active.map((d) => {
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
   * The indicator catalogue: every descriptor openalgo-charts registers, grouped under the
   * engine's own category ('Trend', 'Momentum', 'Volatility', 'Volume') and filtered by a search
   * box. This replaces the row of buttons that used to hold every indicator at once - workable
   * at 22, not at the 102 the library now ships.
   *
   * Rows are checkboxes over the SAME toggleIndicator() the toolbar chips use, so an indicator
   * switched on here is indistinguishable from one switched on there; nothing about placement,
   * settings or persistence is special-cased to the picker.
   */
  toggleIndicatorPicker(scope) {
    const panel = document.getElementById(scope ? `chart-pane-ind-pick-${scope}` : 'chart-ind-picker');
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }

    const cfg = this.indicatorConfig(scope);
    const groups = new Map();
    for (const def of indicatorDefs()) {
      const cat = indicatorCategory(def);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(def);
    }

    panel.hidden = false;
    panel.innerHTML = `
      <div class="chart-pat-head">
        <span>Indicators</span>
        <input type="search" class="form-input chart-ind-search" data-role="search"
               placeholder="Search ${indicatorDefs().length} indicators" aria-label="Search indicators" />
        <span class="chart-pat-count" data-role="count">${this.activeIndicatorDefs(scope).length} on</span>
        <button type="button" class="chart-ind-settings" data-action="script"
                title="Write an indicator or strategy in OpenScript">OpenScript…</button>
        <button type="button" class="chart-ind-settings" data-action="close">Done</button>
      </div>
      <div class="chart-pat-list">
        ${[...groups.entries()].map(([cat, defs]) => `
          <div class="chart-ind-pick-group" data-group="${Utils.escapeHTML(cat)}">
            <div class="chart-ind-pick-cat">${Utils.escapeHTML(cat)}</div>
            ${defs.map((d) => `
              <label class="chart-pat-row chart-ind-pick-row" data-name="${Utils.escapeHTML(d.label.toLowerCase())}">
                <input type="checkbox" data-pick="${Utils.escapeHTML(d.id)}" ${cfg[d.id]?.on ? 'checked' : ''} />
                <span>${Utils.escapeHTML(d.label)}</span>
              </label>`).join('')}
          </div>`).join('')}
      </div>`;

    panel.querySelectorAll('input[data-pick]').forEach((el) =>
      el.addEventListener('change', () => {
        this.toggleIndicator(el.dataset.pick, scope);
        panel.querySelector('[data-role="count"]').textContent = `${this.activeIndicatorDefs(scope).length} on`;
      }));

    const search = panel.querySelector('[data-role="search"]');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      panel.querySelectorAll('.chart-ind-pick-row').forEach((row) => {
        row.hidden = Boolean(q) && !row.dataset.name.includes(q);
      });
      // A heading with nothing left under it is noise, so it goes with its rows.
      panel.querySelectorAll('.chart-ind-pick-group').forEach((group) => {
        group.hidden = !group.querySelector('.chart-ind-pick-row:not([hidden])');
      });
    });

    panel.querySelector('[data-action="close"]').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('[data-action="script"]').addEventListener('click', () => this.openScriptEditor(scope, panel));
  },

  /**
   * OpenScript editor, drawn in place of the picker it was opened from. Apply compiles the script
   * (window.OAC.applyScript), which registers it as an ordinary indicator; it is then switched on
   * for this chart/pane through the same toggleIndicator() every other indicator uses. Re-applying
   * an edited script that is already on goes off-then-on, so the live instance is rebuilt from the
   * new descriptor instead of keeping the old one's calc.
   */
  openScriptEditor(scope, panel) {
    const saved = Object.entries(window.OAC?.savedScripts?.() || {});
    panel.innerHTML = `
      <div class="chart-pat-head">
        <span>OpenScript</span>
        <select class="form-input" data-role="saved" aria-label="Saved scripts">
          <option value="">New script</option>
          ${saved.map(([id]) => `<option value="${Utils.escapeHTML(id)}">${Utils.escapeHTML(id.replace(/^oscript-/, ''))}</option>`).join('')}
        </select>
        <button type="button" class="chart-ind-settings" data-action="apply">Apply</button>
        <button type="button" class="chart-ind-settings" data-action="delete">Delete</button>
        <button type="button" class="chart-ind-settings" data-action="back">Back</button>
      </div>
      <textarea class="form-input chart-script-src" data-role="src" spellcheck="false" rows="14"
                aria-label="OpenScript source"></textarea>
      <pre class="chart-script-errors" data-role="errors" hidden></pre>
      <p class="chart-ind-cfg-note">
        Language guide: <a href="https://github.com/marketcalls/openscript" target="_blank" rel="noopener">openscript</a>.
        Strategies draw against a simulated venue only; no orders are placed.
      </p>`;

    const src = panel.querySelector('[data-role="src"]');
    const errors = panel.querySelector('[data-role="errors"]');
    const pick = panel.querySelector('[data-role="saved"]');
    const scripts = Object.fromEntries(saved);
    src.value = OPENSCRIPT_TEMPLATE;
    pick.addEventListener('change', () => { src.value = scripts[pick.value] || OPENSCRIPT_TEMPLATE; errors.hidden = true; });

    panel.querySelector('[data-action="apply"]').addEventListener('click', () => {
      let descriptor;
      try {
        descriptor = window.OAC.applyScript(src.value);
      } catch (error) {
        errors.textContent = error.message;
        errors.hidden = false;
        return;
      }
      errors.hidden = true;
      const cfg = this.indicatorConfig(scope);
      if (cfg[descriptor.id]?.on) this.toggleIndicator(descriptor.id, scope);
      this.toggleIndicator(descriptor.id, scope);
      Utils.showToast(`${descriptor.name} applied`, 'success');
      panel.hidden = true;
    });

    panel.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (!pick.value) return;
      if (this.indicatorConfig(scope)[pick.value]?.on) this.toggleIndicator(pick.value, scope);
      window.OAC.removeScript(pick.value);
      Utils.showToast('Script deleted; it leaves the indicator list on the next reload', 'success');
      panel.hidden = true;
    });

    panel.querySelector('[data-action="back"]').addEventListener('click', () => {
      panel.hidden = true;
      this.toggleIndicatorPicker(scope);
    });
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
    const toRemove = indicatorDefs().some((def) => !cfg[def.id].on && store.has(def.id));
    if (toRemove) {
      const live = [...store.entries()].sort((a, b) => (b[1].paneIndex ?? 0) - (a[1].paneIndex ?? 0));
      for (const [id, api] of live) {
        try { chart.removeIndicator(api.id); } catch (error) { console.error(`[Chart] removing indicator ${id} failed`, error); }
        store.delete(id);
      }
    }

    for (const def of indicatorDefs()) {
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
        // An OpenScript study refuses to start on a chart with no bars yet (OS6010). Nothing is
        // stored for it, so the next reconcile after data loads adds it; that is not a failure.
        if (String(error?.message).startsWith('OS6010')) {
          console.warn(`[Chart] ${def.id} waits for bars`);
        } else {
          console.error(`[Chart] indicator ${def.id} failed`, error);
        }
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
 
  rememberOscHeights() {},

  /**
   * Trade the CE/PE contract straight off its own pane.
   *
   * Right-click a price on the leg's chart and it places a resting order on THAT contract, on
   * every selected instance - or at market. Unlike the BUY/SELL CE/PE tickets, which resolve a
   * strike per instance from each one's live price, everything here trades THIS exact contract,
   * so it goes to /orders with the symbol named outright.
   */
  attachOptionPaneOrders(key, bodyEl, chart, contract, candles) {
    if (!bodyEl || !chart || !contract) return;

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
      // The pane updates live, so judge limit/stop validity against its latest price.
      const paneCandles = this.optionPanes?.[key]?.candles || candles;
      const last = paneCandles?.length ? paneCandles[paneCandles.length - 1].close : null;
      if (!Number.isFinite(price)) return;
      const at = Number(price.toFixed(2));

      // Same rules as the underlying's menu: a stop must sit on the far side of the last traded
      // price (above for a buy, below for a sell); a limit is always allowed.
      const below = last !== null && at < last;
      const above = last !== null && at > last;
      const p = Utils.formatNumber(at);
      const items = [
        { side: 'BUY', orderType: 'MARKET', label: 'Buy Market', enabled: true },
        // A limit across the market fills now, capped at its price - see contextMenuItemsFor.
        { side: 'BUY', orderType: 'LIMIT', price: at, label: `Buy Limit @ ${p}${above ? ' (fills now)' : ''}`,
          enabled: true, crosses: above },
        { side: 'BUY', orderType: 'SL-M', price: at, label: `Buy Stop @ ${p}`, enabled: above,
          why: 'a buy stop must sit above the last price' },
        { side: 'SELL', orderType: 'MARKET', label: 'Sell Market', enabled: true },
        { side: 'SELL', orderType: 'LIMIT', price: at, label: `Sell Limit @ ${p}${below ? ' (fills now)' : ''}`,
          enabled: true, crosses: below },
        { side: 'SELL', orderType: 'SL-M', price: at, label: `Sell Stop @ ${p}`, enabled: below,
          why: 'a sell stop must sit below the last price' },
      ].map((it) => ({ ...it, contract, last })); // the option's own last price, for the confirmation

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
        + `<div class="chart-ctx-sep"></div>
          <button type="button" class="chart-ctx-item is-neutral" data-action="max-loss">Max loss ₹… on this contract</button>`
        + (hasPosition ? `
          <div class="chart-ctx-sep"></div>
          <button type="button" class="chart-ctx-item is-neutral" data-action="close-position">
            Close position (${pane.positionData.netQuantity > 0 ? '+' : ''}${pane.positionData.netQuantity})
          </button>` : '');

      this.placeChartMenu(menu, e, items.length + (hasPosition ? 3 : 1) + 2);

      menu.querySelectorAll('.chart-ctx-item[data-i]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          menu.hidden = true;
          this.confirmChartOrder(items[Number(btn.dataset.i)]);
        });
      });
      menu.querySelector('[data-action="max-loss"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        this.openMaxLossDialog(contract);
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
    return this.closeChartPosition(key);
  },

  /**
   * Square off what the chart shows: `scope` undefined is the main chart's own symbol (equity or
   * future), 'ce'/'pe' that pane's contract. Every instance holding a leg, in each product it is
   * held in (the exit path closes every product row), after a confirmation.
   */
  async closeChartPosition(scope) {
    const key = scope;
    const pane = key ? this.optionPanes?.[key] : null;
    const data = key ? pane?.positionData : this.chartPositionData;
    const contract = key
      ? pane?.contract
      : (this.chartState ? { symbol: this.chartState.symbol, exchange: this.chartState.exchange } : null);
    if (!contract || !data?.legs?.length) {
      Utils.showToast('No open position to close', 'info');
      return;
    }
    const tradeMode = key ? 'OPTIONS' : /FUT$/i.test(contract.symbol) ? 'FUTURES' : 'EQUITY';

    const qty = Math.abs(data.netQuantity);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content chart-confirm">
        <div class="modal-header">
          <h3>Close position — ${Utils.escapeHTML(contract.symbol)}</h3>
        </div>
        <div class="modal-body">
          <p class="chart-confirm-lead">
            Closes the ${data.netQuantity > 0 ? 'LONG' : 'SHORT'} <strong>${qty}</strong>
            position on <strong>${Utils.escapeHTML(contract.symbol)}</strong> across
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
            symbol: contract.symbol,
            exchange: contract.exchange,
            tradeMode,
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
      if (key) await this.loadPanePosition(key);
      else await this.loadChartPosition();
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
