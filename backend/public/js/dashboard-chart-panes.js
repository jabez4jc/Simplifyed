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
    const series = chart.addSeries('candlestick');
    this.applySeriesType(chart, series, seriesType);
    chart.timeScale.setRightOffset(RIGHT_OFFSET_BARS);

    this.optionPanes[key] = { chart, series, contract, candles, seriesType };
    // No IST display shift needed - the engine renders IST natively from raw UTC seconds (see
    // the TIME AXIS note in dashboard-chart.js).
    this.renderPaneSeries(key);
    this.frameLatestBars(chart);

    const last = candles[candles.length - 1];
    const lastEl = host.querySelector(`[data-role="${key}-last"]`);
    if (lastEl) {
      const chg = last.open ? ((last.close - last.open) / last.open) * 100 : 0;
      lastEl.textContent = `${Utils.formatNumber(last.close)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`;
      lastEl.className = `chart-pane-last ${chg >= 0 ? 'text-profit' : 'text-loss'}`;
    }

    this.attachOptionPaneOrders(key, bodyEl, chart, contract, candles);
    this.applyIndicatorsTo(chart);
    this.applyPatternsTo(chart, series, candles);
    this.renderPaneTypeBar(key);
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

  /** In place, like the main chart: the pane's studies and lines stay on the same series. */
  setPaneSeriesType(key, type) {
    const pane = this.optionPanes?.[key];
    if (!pane?.chart) return;
    pane.seriesType = type;
    this.savePaneSeriesType(key, type);
    try { this.applySeriesType(pane.chart, pane.series, type); } catch (error) { Utils.showToast(error.message, 'error'); }
    this.renderPaneTypeBar(key);
  },

  /** The pane's real bars; the chart draws them as the pane's type (dashboard-chart-types.js). */
  renderPaneSeries(key) {
    const pane = this.optionPanes?.[key];
    if (!pane?.series) return;
    pane.series.setData(this.seriesBars(pane.candles));
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
 * Indicators, the way openalgo-charts is designed to carry them.
 *
 * The CHART owns the studies: each one is an instance (`chart.addIndicator`) with its own row in
 * the engine-drawn legend - eye, gear and close - and its own settings dialog. The dialog and the
 * picker are the widget tier's (`mountIndicatorSettings`, `mountIndicatorPicker`): the picker is
 * the registry grouped by category with a search box, and the settings dialog is the study's own
 * Inputs and Style tabs, built from its descriptor, previewing every edit live and putting the
 * touched keys back on Cancel. Two EMAs are simply two instances, each with its own dialog.
 *
 * Both dialogs run on a bare chart through `createAlertUi(...).context` - the widget tier's
 * context for a host that brings its own chart rather than a whole `createWidget` shell.
 *
 * This layer only persists what is on each chart (per scope: the main chart, `'ce'` and `'pe'`),
 * puts it back on a rebuilt chart, and draws the toolbar popover. A study that cannot be put back
 * yet - an OpenScript study refuses a chart with no bars (OS6010), or a script that no longer
 * compiles - is held as pending and kept in the saved list, so it is retried rather than lost.
 */
const indicatorStoreKey = (scope) => (scope ? `chart-indicators-${scope}` : 'chart-indicators');

/**
 * The config saved before 2.6.0 was `{ [slotId]: { on, settings } }` over a fixed set of slots.
 * These are the slots whose id was not the descriptor's own; every other slot id was.
 */
const LEGACY_INDICATOR_SLOTS = {
  sma1: 'sma', sma2: 'sma', ema1: 'ema', ema2: 'ema', ema3: 'ema', wma1: 'wma', bollinger1: 'bollinger',
  stochastic1: 'stochastic', adx1: 'adx', atr1: 'atr', cci1: 'cci', mfi1: 'mfi', obv1: 'obv', adl1: 'adl',
  volume1: 'volume', supertrend1: 'supertrend', parabolicsar1: 'parabolic-sar', ichimoku1: 'ichimoku',
  vixfix1: 'williams-vix-fix',
};

const OPENSCRIPT_TEMPLATE = `version 1

study("My script", overlay = true)

length = input(20, "Length")
plot(sma(close, length), "SMA", orange, width = 2)
`;

/** Below this, the price pane and its axis labels stop being usable. */
const MIN_CHART_BUDGET_HEIGHT = 360;

/**
 * Bars of empty space kept to the right of the last candle on a CE/PE pane. Fitting the data
 * edge-to-edge jams the live bar against the price scale. The main chart sets its own right
 * offset independently - see restoreChartView in dashboard-chart.js.
 */
const RIGHT_OFFSET_BARS = 8;

/** What persists of one study: enough for `addIndicator` to bring the same study back. */
function indicatorSnapshot(inst) {
  return { indicatorId: inst.indicatorId, instanceId: inst.id, settings: inst.settings(), visible: inst.visible() };
}

Object.assign(DashboardApp.prototype, {
  /** The chart a scope names: the main chart, or one CE/PE pane's. */
  indicatorChart(scope) {
    return scope ? this.optionPanes?.[scope]?.chart || null : this.chart || null;
  },

  /** Per-scope bookkeeping: which chart the saved list was put on, and what is still pending. */
  indicatorScope(scope) {
    this._indScopes = this._indScopes || {};
    return (this._indScopes[scope || 'main'] = this._indScopes[scope || 'main'] || { chart: null, pending: [], ui: null });
  },

  /** The saved studies for a scope, migrating a pre-2.6 slot config the first time. */
  savedIndicators(scope) {
    try {
      const saved = JSON.parse(localStorage.getItem(indicatorStoreKey(scope)) || 'null');
      if (Array.isArray(saved)) return saved.filter((s) => s && typeof s.indicatorId === 'string');
      const legacy = JSON.parse(localStorage.getItem(scope ? `chart-indicator-config-${scope}` : 'chart-indicator-config') || '{}');
      return Object.entries(legacy)
        .filter(([, v]) => v?.on)
        .map(([slot, v]) => ({ indicatorId: LEGACY_INDICATOR_SLOTS[slot] || slot, settings: v.settings || {}, visible: true }));
    } catch (_) {
      return [];
    }
  },

  /** Live studies plus the pending ones, so a study that could not be put back is not dropped. */
  saveIndicators(scope) {
    const st = this.indicatorScope(scope);
    const chart = this.indicatorChart(scope);
    if (!chart || chart !== st.chart || chart.isDestroyed) return;
    const list = [...chart.indicators().map(indicatorSnapshot), ...st.pending];
    try { localStorage.setItem(indicatorStoreKey(scope), JSON.stringify(list)); } catch (_) { /* private mode */ }
  },

  /**
   * Put `list` on `chart`; returns what it refused, for the caller to keep as pending. OS6010 is
   * an OpenScript study waiting for bars, anything else is logged.
   */
  _addIndicators(chart, list) {
    const taken = new Set(chart.indicators().map((i) => i.id));
    const left = [];
    for (const saved of list) {
      const options = saved.instanceId && !taken.has(saved.instanceId) ? { instanceId: saved.instanceId } : {};
      try {
        let inst;
        try {
          inst = chart.addIndicator(saved.indicatorId, saved.settings || {}, options);
        } catch (error) {
          // A setting a newer descriptor refuses is not worth losing the study over.
          if (!window.OAC.hasIndicator(saved.indicatorId) || String(error?.message).startsWith('OS6010')) throw error;
          inst = chart.addIndicator(saved.indicatorId, {}, options);
        }
        if (saved.visible === false) inst.setVisible(false);
      } catch (error) {
        left.push(saved);
        if (String(error?.message).startsWith('OS6010')) console.warn(`[Chart] ${saved.indicatorId} waits for bars`);
        else console.error(`[Chart] indicator ${saved.indicatorId} could not be restored`, error);
      }
    }
    return left;
  },

  /**
   * Bring a scope's saved studies onto its chart. A chart seen for the first time (a rebuild) gets
   * the saved list and the listeners; a chart already carrying its studies (a symbol switch keeps
   * the chart) only retries what is pending. Called after every history load.
   */
  applyIndicatorsTo(chart) {
    if (!chart || !window.OAC) return;
    const scope = chart === this.chart ? undefined : ['ce', 'pe'].find((k) => this.optionPanes?.[k]?.chart === chart);
    if (scope === undefined && chart !== this.chart) return;
    const st = this.indicatorScope(scope);
    if (st.chart !== chart) {
      st.chart = chart;
      st.pending = this.savedIndicators(scope);
      st.ui = null;
      this._bindIndicatorEvents(scope, chart);
    }
    if (st.pending.length) st.pending = this._addIndicators(chart, st.pending);
    this.renderIndicatorBar(scope);
  },

  ensureIndicators() {
    this.applyIndicatorsTo(this.chart);
    for (const key of ['ce', 'pe']) this.applyIndicatorsTo(this.optionPanes?.[key]?.chart);
  },

  /** Kept as a named call: renderChartView and the timeframe switch still call it. */
  refreshOscillator() {
    this.ensureIndicators();
  },

  /**
   * The engine announces every study change on `objects:change` (add, remove, settings, eye) and
   * asks for a study's settings through its legend gear (`indicatorSettings`).
   */
  _bindIndicatorEvents(scope, chart) {
    let timer = null;
    chart.on('objects:change', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (chart.isDestroyed || this.indicatorChart(scope) !== chart) return;
        this.saveIndicators(scope);
        this.renderIndicatorBar(scope);
        if (!scope) this.updateChartBarChips?.();
      }, 150);
    });
    chart.on('indicatorSettings', ({ instanceId }) => this.openIndicatorSettings(scope, instanceId));
  },

  /**
   * The widget tier's dialog layer for a scope's chart, made on first use. Mounted over the whole
   * chart view, not the chart's own box: a CE/PE pane is too narrow to hold a settings dialog.
   * Dialogs only read `draw` to refuse a pick while a drawing tool is active.
   */
  indicatorUi(scope) {
    const chart = this.indicatorChart(scope);
    const host = document.querySelector('.chart-view');
    if (!chart || !host || !window.OAC?.createAlertUi) return null;
    const st = this.indicatorScope(scope);
    const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    if (!st.ui || st.ui.context.chart !== chart || !st.ui.root.isConnected) {
      st.ui?.destroy();
      st.ui = window.OAC.createAlertUi(host, {
        chart,
        draw: { activeTool: () => (scope ? null : this._draw?.controller?.activeTool?.() ?? null) },
        theme,
      });
    }
    st.ui.setTheme(theme);
    return st.ui;
  },

  /** One study's own settings dialog - the engine's Inputs and Style tabs for that instance. */
  openIndicatorSettings(scope, instanceId, anchor) {
    const ui = this.indicatorUi(scope);
    if (!ui) return;
    window.OAC.mountIndicatorSettings(ui.context, anchor, { instanceId });
  },

  /** The engine's indicator picker; each pick adds an instance and the picker stays up. */
  openIndicatorPicker(scope, anchor) {
    const ui = this.indicatorUi(scope);
    if (!ui) return;
    window.OAC.mountIndicatorPicker(ui.context, anchor, { templates: null });
  },

  removeIndicatorInstance(scope, instanceId) {
    this.indicatorChart(scope)?.removeIndicator(instanceId);
  },

  /** Name plus the study's numeric inputs ("EMA 21", "MACD 12/26/9") for a toolbar chip. */
  indicatorLabel(inst) {
    const s = inst.settings();
    const parts = (window.OAC?.getIndicator?.(inst.indicatorId)?.inputs || [])
      .filter((i) => i.type === 'number' && s[i.key] !== undefined)
      .map((i) => s[i.key]);
    return parts.length ? `${inst.name} ${parts.join('/')}` : inst.name;
  },

  /**
   * Replace the CE/PE panes' studies with the main chart's, settings included. Removed highest
   * pane first, so no removal reindexes a study still waiting to be removed.
   */
  copyMainIndicatorsTo(scopes = ['ce', 'pe']) {
    const main = this.chart ? this.chart.indicators().map(indicatorSnapshot) : [];
    for (const scope of scopes) {
      const chart = this.indicatorChart(scope);
      try { localStorage.setItem(indicatorStoreKey(scope), JSON.stringify(main)); } catch (_) { /* private mode */ }
      if (!chart) continue;
      const live = [...chart.indicators()].sort((a, b) => (b.paneIndex ?? 0) - (a.paneIndex ?? 0));
      for (const inst of live) chart.removeIndicator(inst.id);
      this.indicatorScope(scope).pending = this._addIndicators(chart, main);
      this.saveIndicators(scope);
      this.renderIndicatorBar(scope);
    }
    Utils.showToast(`Main chart indicators copied to ${scopes.length === 2 ? 'both option charts' : `the ${scopes[0].toUpperCase()} chart`}`, 'success');
  },

  /**
   * The toolbar popover for a scope: Add (the engine's picker), one chip per study on the chart -
   * its name opens that study's own settings, × removes it - then OpenScript, Patterns (main chart
   * only: the pattern config is shared) and the copy action.
   */
  renderIndicatorBar(scope) {
    const host = document.getElementById(scope ? `chart-pane-ind-${scope}` : 'chart-indicators-bar');
    if (!host) return;
    const chart = this.indicatorChart(scope);
    const studies = chart && !chart.isDestroyed ? chart.indicators() : [];
    const pending = this.indicatorScope(scope).pending;
    host.innerHTML = `
      ${scope ? '' : '<span class="chart-toolbar-label">Indicators</span>'}
      <button type="button" class="chart-ind-btn" data-action="add" title="Add an indicator">+ Add</button>
      ${studies.map((inst) => `
        <span class="chart-ind-chip ${inst.visible() ? '' : 'is-hidden'}">
          <button type="button" class="chart-ind-btn active" data-settings="${Utils.escapeHTML(inst.id)}"
                  title="${Utils.escapeHTML(`${inst.name} settings`)}">${Utils.escapeHTML(this.indicatorLabel(inst))}</button>
          <button type="button" class="chart-ind-x" data-remove="${Utils.escapeHTML(inst.id)}"
                  aria-label="${Utils.escapeHTML(`Remove ${inst.name}`)}" title="Remove">×</button>
        </span>`).join('')}
      ${pending.length ? `<span class="chart-ind-pending" title="${Utils.escapeHTML(pending.map((p) => p.indicatorId).join(', '))}">${pending.length} waiting</span>` : ''}
      ${scope ? '' : `<button type="button" class="chart-ind-btn ${this.enabledPatterns().length ? 'active' : ''}"
              data-action="patterns">Patterns</button>`}
      <button type="button" class="chart-ind-settings" data-action="script"
              title="Write an indicator or strategy in OpenScript">OpenScript…</button>
      ${scope
        ? `<button type="button" class="chart-ind-settings" data-action="copy-main"
                  title="Replace this chart's indicators with the main chart's, settings included">Copy from main chart</button>`
        : `<button type="button" class="chart-ind-settings" data-action="copy-panes"
                  title="Put these indicators, with their settings, on the CE and PE option charts">Copy to option charts</button>`}`;

    host.querySelector('[data-action="add"]').addEventListener('click', (e) => this.openIndicatorPicker(scope, e.currentTarget));
    host.querySelectorAll('[data-settings]').forEach((b) =>
      b.addEventListener('click', () => this.openIndicatorSettings(scope, b.dataset.settings, b)));
    host.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => this.removeIndicatorInstance(scope, b.dataset.remove)));
    host.querySelector('[data-action="patterns"]')?.addEventListener('click', () => this.togglePatternPicker());
    host.querySelector('[data-action="script"]').addEventListener('click', () => this.openScriptEditor(scope));
    host.querySelector('[data-action="copy-panes"]')?.addEventListener('click', () => this.copyMainIndicatorsTo(['ce', 'pe']));
    host.querySelector('[data-action="copy-main"]')?.addEventListener('click', () => this.copyMainIndicatorsTo([scope]));
  },

  /**
   * OpenScript editor, in the popover under the chips. Apply compiles the script
   * (window.OAC.applyScript), which registers it as an ordinary indicator. Instances of it already
   * on this chart are rebuilt from the new descriptor with their settings; with none, one is added.
   * Either way it then has its own legend row and settings dialog like any built-in.
   */
  openScriptEditor(scope) {
    const panel = document.getElementById(scope ? `chart-pane-ind-pick-${scope}` : 'chart-ind-picker');
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; return; }
    const saved = Object.entries(window.OAC?.savedScripts?.() || {});
    panel.hidden = false;
    panel.innerHTML = `
      <div class="chart-pat-head">
        <span>OpenScript</span>
        <select class="form-input" data-role="saved" aria-label="Saved scripts">
          <option value="">New script</option>
          ${saved.map(([id]) => `<option value="${Utils.escapeHTML(id)}">${Utils.escapeHTML(id.replace(/^oscript-/, ''))}</option>`).join('')}
        </select>
        <button type="button" class="chart-ind-settings" data-action="apply">Apply</button>
        <button type="button" class="chart-ind-settings" data-action="delete">Delete</button>
        <button type="button" class="chart-ind-settings" data-action="close">Close</button>
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
      const chart = this.indicatorChart(scope);
      const st = this.indicatorScope(scope);
      if (chart) {
        const live = chart.indicators().filter((i) => i.indicatorId === descriptor.id).map(indicatorSnapshot);
        for (const inst of live) chart.removeIndicator(inst.instanceId);
        st.pending = [
          ...st.pending.filter((p) => p.indicatorId !== descriptor.id),
          ...this._addIndicators(chart, live.length ? live : [{ indicatorId: descriptor.id, settings: {} }]),
        ];
        this.saveIndicators(scope);
        this.renderIndicatorBar(scope);
      }
      Utils.showToast(`${descriptor.name} applied`, 'success');
      panel.hidden = true;
    });

    panel.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (!pick.value) return;
      const chart = this.indicatorChart(scope);
      for (const inst of chart ? chart.indicators().filter((i) => i.indicatorId === pick.value) : []) chart.removeIndicator(inst.id);
      const st = this.indicatorScope(scope);
      st.pending = st.pending.filter((p) => p.indicatorId !== pick.value);
      this.saveIndicators(scope);
      window.OAC.removeScript(pick.value);
      Utils.showToast('Script deleted; it leaves the indicator list on the next reload', 'success');
      panel.hidden = true;
    });

    panel.querySelector('[data-action="close"]').addEventListener('click', () => { panel.hidden = true; });
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
    // 16px of border breathing room, plus the attribution line below the chart and the flex gap
    // in front of it - leaving those out was the last few pixels of page scroll the fit was
    // supposed to eliminate.
    const bottomPad = 48;
    const available = window.innerHeight - top - bottomPad;
    return Math.max(MIN_CHART_BUDGET_HEIGHT, Math.round(available));
  },

  /**
   * Size the chart element to fit the viewport. The engine shares that height between the price
   * pane and every oscillator pane by their weights, so the whole widget always fits one screen.
   */
  resizeChartForPanes() {
    const container = document.getElementById('chart-container');
    if (!container) return;
    container.style.height = `${this.chartBudgetHeight()}px`;
  },

  /** No-op kept as a named call site (destroyChart): the engine owns oscillator pane heights. */
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
      const at = snapToTick(price, Number(contract.tickSize) || 0.05);

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
