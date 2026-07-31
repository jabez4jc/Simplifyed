/**
 * Chart view - read-only historical candles.
 *
 * Phase 1 of the chart-based trading interface: it displays data and places no orders. The
 * trade surface comes later and will post to the existing /api/v1/quickorders endpoint, which
 * fans out to a watchlist's instances - hence the symbol picker is sourced from
 * watchlist_symbols rather than free text. A symbol you can chart is a symbol you will be able
 * to trade with all the existing per-symbol guardrails (sizing, product, risk/auto-exit) intact.
 *
 * Rendering uses openalgo-charts (Apache-2.0, MIT-adjacent original code by marketcalls),
 * installed as a real npm dependency and synced into public/vendor by
 * scripts/sync-vendor-charts.js on every install. It ships as native ES modules with no bundler
 * needed - see js/openalgo-charts-bridge.js, which loads the tiers this app uses and exposes
 * them as `window.OAC` for these classic (non-module) scripts to call into.
 *
 * TIME AXIS: the engine renders its time axis in IST natively from raw UTC seconds (broker
 * candles are true UTC epoch seconds - verified: BSE first candle of the day is 03:45Z =
 * 09:15 IST) - unlike the previous TradingView Lightweight Charts build, no manual IST-offset
 * shift is applied to values handed to the chart. `IST_OFFSET_SECONDS` is still declared here and
 * used by dashboard-chart-live.js for bucket-boundary math (which bar a tick belongs to in IST
 * wall-clock time) - a different job from the display shift this file no longer needs.
 */

const IST_OFFSET_SECONDS = 5.5 * 3600;

/**
 * Every timeframe `candle.service.js`'s TIMEFRAME_SECONDS already validates end-to-end for
 * GET /history - kept in sync with that list by hand (small, rarely-changed set) rather than a
 * runtime fetch, since it never has a reason to differ per-request. `W`/`M` are deliberately left
 * out - this is an intraday-focused trading chart, not a long-range analysis tool.
 */
const TIMEFRAME_GROUPS = [
  { label: 'Seconds', values: ['5s', '10s', '15s', '30s', '45s'] },
  { label: 'Minutes', values: ['1m', '2m', '3m', '5m', '10m', '15m', '20m', '30m'] },
  { label: 'Hours', values: ['1h', '2h', '4h'] },
  { label: 'Days', values: ['D'] },
];
const TIMEFRAMES = TIMEFRAME_GROUPS.flatMap((g) => g.values);

/** Gridline visibility presets for the context menu's "Grid" submenu - maps 1:1 to the engine's
 * own `chart.setGridOptions({ vertLines, horzLines })`. */
const GRID_STYLES = [
  { id: 'grid', label: 'Grid', vertLines: true, horzLines: true },
  { id: 'horizontal', label: 'Horizontal', vertLines: false, horzLines: true },
  { id: 'vertical', label: 'Vertical', vertLines: true, horzLines: false },
  { id: 'none', label: 'None', vertLines: false, horzLines: false },
];

Object.assign(DashboardApp.prototype, {
  async renderChartView() {
    const contentArea = document.getElementById('content-area');

    if (!window.OAC) {
      contentArea.innerHTML = `
        <div class="card"><div class="p-6">
          <p class="text-error">Charting library failed to load.</p>
          <p class="text-sm text-neutral-500 mt-2">
            Expected /vendor/openalgo-charts/openalgo-charts.mjs (loaded via js/openalgo-charts-bridge.js)
          </p>
        </div></div>`;
      return;
    }

    let symbols = [];
    try {
      const res = await api.request('/history/symbols');
      symbols = res.data || [];
    } catch (error) {
      contentArea.innerHTML = `
        <div class="card"><div class="p-6">
          <p class="text-error">Could not load symbols: ${Utils.escapeHTML(error.message)}</p>
        </div></div>`;
      return;
    }

    if (!symbols.length) {
      contentArea.innerHTML = `
        <div class="card"><div class="p-6">
          <p class="text-neutral-600">No symbols available to chart.</p>
          <p class="text-sm text-neutral-500 mt-2">
            Add a symbol to an active watchlist first - the chart draws from the same symbols you
            trade, so they carry your sizing and risk settings.
          </p>
        </div></div>`;
      return;
    }

    // Restore the last viewed symbol/timeframe so switching views doesn't reset the workspace.
    const saved = this.loadChartPreference();
    const current = symbols.find((s) => String(s.symbolId) === String(saved.symbolId)) || symbols[0];

    const timeframe = TIMEFRAMES.includes(saved.timeframe) ? saved.timeframe : '5m';
    const product = ['MIS', 'CNC', 'NRML'].includes(saved.product) ? saved.product : 'MIS';
    const qty = Number.isInteger(saved.qty) && saved.qty > 0 ? saved.qty : 1;

    contentArea.innerHTML = `
      <div class="chart-view">
        <!--
          ONE toolbar row. This used to be six stacked rows - toolbar, options, instances, mode
          hint, legend, indicators - which pushed the candles halfway down the screen. Everything
          that is not a per-trade decision now lives behind a popover, and the legend moved onto
          the canvas where every charting terminal puts it.
        -->
        <div class="chart-bar">
          <select id="chart-symbol" class="form-input chart-symbol-select" aria-label="Symbol">
            ${symbols.map((s) => `
              <option value="${s.symbolId}" ${s.symbolId === current.symbolId ? 'selected' : ''}>
                ${Utils.escapeHTML(s.symbol)} · ${Utils.escapeHTML(s.exchange)}
              </option>`).join('')}
          </select>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="timeframe" aria-expanded="false">
              ${Utils.escapeHTML(timeframe)}
            </button>
            <div class="chart-pop" data-pop-for="timeframe" hidden>
              <div id="chart-tf-pop-body">${this.timeframePopoverHTML(timeframe, null)}</div>
            </div>
          </div>

          <div class="chart-seg" role="group" aria-label="Product">
            ${['MIS', 'CNC', 'NRML'].map((pr) => `
              <button type="button" class="chart-prod-btn ${pr === product ? 'active' : ''}"
                      data-product="${pr}">${pr}</button>`).join('')}
          </div>

          <label class="chart-lots">
            <span id="chart-lots-label">Qty</span>
            <input id="chart-qty" type="number" class="form-input chart-qty-input"
                   value="${qty}" min="1" step="1" />
          </label>
          <span id="chart-size-hint" class="chart-size-hint"></span>

          <span class="chart-bar-gap"></span>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="options" aria-expanded="false" hidden>
              Options
            </button>
            <div class="chart-pop" data-pop-for="options" hidden>
              <div id="chart-options" class="chart-options" hidden></div>
            </div>
          </div>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="send" aria-expanded="false">
              Send to <b id="chart-send-count">—</b><span id="chart-live-badge" class="chart-live-badge" hidden></span>
            </button>
            <div class="chart-pop" data-pop-for="send" hidden>
              <div id="chart-instances" class="chart-instances" hidden></div>
              <div id="chart-trade" class="chart-trade-host" hidden></div>
            </div>
          </div>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="indicators" aria-expanded="false">
              Indicators <b id="chart-ind-count"></b>
            </button>
            <div class="chart-pop is-wide" data-pop-for="indicators" hidden>
              <div id="chart-indicators-bar" class="chart-ind-bar"></div>
              <div id="chart-ind-config" class="chart-ind-config" hidden></div>
              <div id="chart-pattern-picker" class="chart-pattern-picker" hidden></div>
            </div>
          </div>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="profile" aria-expanded="false">
              Order Flow <b id="chart-profile-count"></b>
            </button>
            <div class="chart-pop" data-pop-for="profile" hidden>
              <div id="chart-profile-bar" class="chart-ind-bar"></div>
            </div>
          </div>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="sync" aria-expanded="false">
              Sync
            </button>
            <div class="chart-pop" data-pop-for="sync" hidden>
              <div id="chart-sync-bar" class="chart-sync-bar" hidden></div>
            </div>
          </div>

          <div class="chart-menu">
            <button type="button" class="chart-bar-btn" data-pop="charttype" aria-expanded="false">
              Chart Type
            </button>
            <div class="chart-pop is-wide" data-pop-for="charttype" hidden>
              <div id="chart-type-bar" class="chart-ind-bar"></div>
            </div>
          </div>

          <button type="button" id="chart-fullscreen-btn" class="chart-bar-btn" title="Fullscreen">⛶</button>

          <span id="chart-status" class="chart-status"></span>
        </div>

        <div id="chart-layout" class="chart-layout">
        <div class="chart-canvas-wrap">
          <!-- Vertical tool rail, to the left of the canvas as on every charting terminal. -->
          <div id="chart-draw-tools" class="chart-draw-rail"></div>
          <div id="chart-draw-flyout" class="chart-draw-flyout" hidden></div>

          <div id="chart-container" class="chart-container"></div>

          <!-- Floating one-click tickets, price-labelled so the operator never has to look
               away from the chart to know what they would be trading at. -->
          <div id="chart-tickets" class="chart-tickets" hidden>
            <button type="button" class="chart-ticket is-sell" data-side="SELL">
              <span class="chart-ticket-price" data-role="sell-price">—</span>
              <span class="chart-ticket-label">SELL</span>
            </button>
            <span class="chart-ticket-qty" data-role="ticket-qty">${qty}</span>
            <button type="button" class="chart-ticket is-buy" data-side="BUY">
              <span class="chart-ticket-price" data-role="buy-price">—</span>
              <span class="chart-ticket-label">BUY</span>
            </button>
          </div>

          <!-- Legend over the canvas, top-left, as on every charting terminal. -->
          <div id="chart-legend" class="chart-legend"></div>

          <div id="chart-ctx" class="chart-ctx" hidden></div>
        </div>

        <!-- CE / PE panes, only while trading options on this underlying -->
        <div id="chart-panes" class="chart-panes" hidden></div>
        </div>

        <div id="chart-oscillator" class="chart-oscillator" hidden></div>

        <div id="chart-levels" class="chart-levels" hidden></div>

        <div id="chart-position" class="chart-position" hidden></div>

        <p class="chart-attribution">
          Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a>
        </p>
      </div>
    `;

    this.chartState = {
      symbolId: current.symbolId,
      exchange: current.exchange,
      symbol: current.symbol,
      timeframe,
      product,
      qty,
      symbols,
    };
    this.saveChartPreference();

    this.attachChartBarMenus();
    this.renderIndicatorBar();
    this.renderSyncBar();
    if (typeof this.loadProfilePrefs === 'function') this.loadProfilePrefs();
    if (typeof this.renderProfileBar === 'function') this.renderProfileBar();
    if (typeof this.loadChartTypePref === 'function') this.loadChartTypePref();
    this.initChart();
    if (typeof this.renderChartTypeBar === 'function') this.renderChartTypeBar();
    if (typeof this.attachOrderLines === 'function') this.attachOrderLines();
    this.attachFullscreenToggle();
    await this.loadChartData();
    this.refreshOscillator();
    await this.loadChartPosition();
    await this.loadChartLevels();
    this.attachLevelDragging();
    await this.loadChartTradePanel();
    // The trade panel restores the "Trade options" checkbox from state; the CE/PE panes have to
    // follow it. Without this a re-render leaves the box ticked with no option charts under it.
    if (this.chartOptionsOn) await this.refreshOptionPanes();
    this.attachDrawingLayer();
    if (typeof this.restoreDrawToolsVisibility === 'function') this.restoreDrawToolsVisibility();
    this.startChartLiveUpdates();

    document.getElementById('chart-symbol').addEventListener('change', (e) => {
      const picked = symbols.find((s) => String(s.symbolId) === e.target.value);
      if (!picked) return;
      Object.assign(this.chartState, {
        symbolId: picked.symbolId, exchange: picked.exchange, symbol: picked.symbol,
      });
      this.saveChartPreference();
      // A WS tick fresh for the OLD symbol says nothing about the new one - without this reset
      // the fallback poller could wrongly trust a stale timestamp and skip polling for the new
      // symbol until CHART_STALE_MS naturally lapses.
      this.lastChartTickAt = 0;
      this.loadChartData();
      this.loadChartPosition().then(() => this.loadChartLevels());
      this.loadChartTradePanel();
      this.refreshSupportedTimeframes();
    });

    contentArea.querySelectorAll('.chart-prod-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        contentArea.querySelectorAll('.chart-prod-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartState.product = btn.dataset.product;
        this.saveChartPreference();
      });
    });

    const qtyInput = document.getElementById('chart-qty');
    qtyInput.addEventListener('input', () => {
      const v = parseInt(qtyInput.value, 10);
      this.chartState.qty = Number.isInteger(v) && v > 0 ? v : 1;
      this.saveChartPreference();
      const badge = document.querySelector('[data-role="ticket-qty"]');
      if (badge) badge.textContent = this.chartState.qty;
      const hint = document.getElementById('chart-size-hint');
      if (hint) hint.textContent = this.sizeHintText(this.chartState.qty);
    });

    this.attachChartContextMenu();
    document.querySelectorAll('.chart-ticket').forEach((btn) => {
      btn.addEventListener('click', () => this.confirmChartOrder({
        side: btn.dataset.side, orderType: 'MARKET',
      }));
    });

    this.bindTimeframeButtons();
    this.refreshSupportedTimeframes();
  },

  loadChartPreference() {
    try {
      return JSON.parse(localStorage.getItem('chart-preference') || '{}');
    } catch (_) {
      return {};
    }
  },

  saveChartPreference() {
    try {
      const { symbolId, timeframe, product, qty } = this.chartState || {};
      localStorage.setItem('chart-preference', JSON.stringify({ symbolId, timeframe, product, qty }));
    } catch (_) {
      // private mode - preference simply won't persist
    }
  },

  /**
   * Grouped timeframe buttons, same markup used both at first render and every re-render after
   * `refreshSupportedTimeframes()` resolves - `supported` null means "not resolved yet, show
   * everything enabled" (matches today's behaviour until the broker call lands, and matches what
   * a failed/unreachable broker call falls back to as well - `source: 'default'` returns the full
   * local list, so there is no separate "unknown" visual state to design for).
   */
  timeframePopoverHTML(timeframe, supported) {
    return TIMEFRAME_GROUPS.map((g) => `
      <p class="chart-toolbar-label">${g.label}</p>
      <div class="chart-tf-grid">
        ${g.values.map((tf) => {
          const enabled = !supported || supported.includes(tf);
          return `
            <button type="button" class="chart-tf-btn ${tf === timeframe ? 'active' : ''}"
                    data-timeframe="${tf}" ${enabled ? '' : 'disabled'}
                    ${enabled ? '' : 'title="Not supported by this instance"'}>${tf}</button>`;
        }).join('')}
      </div>`).join('');
  },

  renderTimeframePopover() {
    const host = document.getElementById('chart-tf-pop-body');
    if (!host) return;
    host.innerHTML = this.timeframePopoverHTML(this.chartState?.timeframe, this.chartState?.supportedTimeframes || null);
    this.bindTimeframeButtons();
  },

  bindTimeframeButtons() {
    document.querySelectorAll('.chart-tf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        document.querySelectorAll('.chart-tf-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartState.timeframe = btn.dataset.timeframe;
        this.saveChartPreference();
        const tfBtn = document.querySelector('[data-pop="timeframe"]');
        if (tfBtn) tfBtn.textContent = btn.dataset.timeframe;
        document.querySelector('[data-pop-for="timeframe"]')?.setAttribute('hidden', '');
        tfBtn?.setAttribute('aria-expanded', 'false');
        this.loadChartData().then(() => {
          this.refreshOscillator();
          if (this.chartOptionsOn) this.refreshOptionPanes();
        });
      });
    });
  },

  /**
   * What the connected broker instance actually serves for this exchange - GET
   * /history/timeframes resolves its own instance server-side and falls back to the full local
   * list (`source: 'default'`) when it can't reach one, so a broker outage degrades to today's
   * "everything enabled" behaviour rather than locking the picker.
   */
  async refreshSupportedTimeframes() {
    const state = this.chartState;
    if (!state) return;
    try {
      const res = await api.request(`/history/timeframes?exchange=${encodeURIComponent(state.exchange)}`);
      state.supportedTimeframes = res.data?.timeframes || null;
    } catch (_) {
      state.supportedTimeframes = null;
    }
    // The current selection went dark (broker no longer serves it) - fall back rather than keep
    // requesting data for a timeframe the picker itself now shows as unsupported.
    if (state.supportedTimeframes && !state.supportedTimeframes.includes(state.timeframe)) {
      const fallback = state.supportedTimeframes.includes('5m')
        ? '5m' : state.supportedTimeframes[0];
      if (fallback) {
        state.timeframe = fallback;
        this.saveChartPreference();
        await this.loadChartData();
        this.refreshOscillator();
      }
    }
    this.renderTimeframePopover();
  },

  initChart() {
    const container = document.getElementById('chart-container');
    if (!container || !window.OAC) return;

    this.destroyChart(); // never leave an orphaned instance behind on re-render

    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const baseTheme = dark ? window.OAC.darkTheme : window.OAC.lightTheme;

    // Profit/loss colours come from the same tokens the P&L columns use, so up/down means the
    // same thing everywhere in the app and stays AA-contrast in both themes.
    const css = getComputedStyle(document.documentElement);
    const up = css.getPropertyValue('--color-profit').trim() || baseTheme.upColor;
    const down = css.getPropertyValue('--color-loss').trim() || baseTheme.downColor;

    const chart = window.OAC.createChart(container, {
      theme: {
        ...baseTheme,
        upColor: up, downColor: down, wickUpColor: up, wickDownColor: down,
      },
      // The engine draws its own per-indicator legend rows at this pane-relative offset. This
      // app draws its OWN OHLC/LTP line (#chart-legend) in the same top-left corner, so the
      // native rows need just enough clearance to sit below it, not overlap it. The trade
      // tickets do NOT factor in here - they were moved to the top-right corner (see
      // .chart-tickets in chart.css) after testing showed this option's effect on them was not
      // reliable enough to depend on for that taller, options-mode layout.
      legendOffset: { top: 26, left: 8 },
    });

    this.chart = chart;
    if (typeof this.applyChartGridStyle === 'function') this.applyChartGridStyle(this.loadChartGridStyle());
    // Fit the viewport immediately, even before any oscillator exists - otherwise a bare
    // candlestick chart falls back to the CSS default, which may be more or less than what
    // actually fits on screen.
    if (typeof this.resizeChartForPanes === 'function') this.resizeChartForPanes();
    this._attachChartResizeListener();
    // Every price line created on this chart, in creation order. clearPriceLines() iterates
    // THIS rather than the per-feature maps: those get reassigned by concurrent draws, and a
    // reassigned map silently orphans the lines it used to hold - they then stay on the chart
    // permanently with no handle left to remove them.
    this._priceLines = [];
    // Transform-based patterns (Renko etc.) still render through the plain candlestick series -
    // only the data feeding it differs. See dashboard-chart-types.js.
    const savedType = this._chartType?.type || 'candlestick';
    const isTransformType = typeof this.isTransformSeriesType === 'function' && this.isTransformSeriesType(savedType);
    this.candleSeries = chart.addSeries(isTransformType ? 'candlestick' : savedType);

    // Hidden overlay scale ('' priceScaleId): the histogram shares the price pane rather than
    // getting one of its own, same as the old volume-pane-margin trick.
    this.volumeSeries = chart.addSeries('histogram', {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    // Pin volume to the bottom fifth so it reads as context, not as a second chart.
    this.volumeSeries.priceScale().setOptions({ marginTop: 0.8, marginBottom: 0 });
  },

  /**
   * Create a price line and register it, so it can always be found again. `scope` is `undefined`
   * for the main chart or `'ce'`/`'pe'` for an option pane - same scoping shape already proven
   * for indicator config (`indicatorConfig(scope)` in dashboard-chart-panes.js), applied here so
   * a pane's own position line never shares state with the main chart's or the other pane's.
   */
  addPriceLine(options, scope) {
    const chart = scope ? this.optionPanes?.[scope]?.chart : this.chart;
    if (!chart) return null;
    const line = chart.addPriceLine(options, 0);
    if (scope) {
      const pane = this.optionPanes[scope];
      (pane.priceLines = pane.priceLines || []).push(line);
    } else {
      (this._priceLines = this._priceLines || []).push(line);
    }
    return line;
  },

  /**
   * Redraw every line on the series from current state.
   *
   * Position and levels share one series, so they cannot each clear independently - whichever
   * ran second would wipe the other's lines. Fetchers update state only; this is the single
   * place that decides what is drawn. Levels (points-from-entry auto-exit) are main-chart-only -
   * they're keyed by a real watchlist `symbolId`, which a dynamically-resolved option contract
   * from `/history/option-legs` doesn't have; a pane's own stop/target instead means a REAL
   * resting order, shown via the trade-tier order lines (dashboard-chart-orders.js), not a line
   * drawn here.
   */
  redrawChartLines(scope) {
    const series = scope ? this.optionPanes?.[scope]?.series : this.candleSeries;
    if (!series) return;
    this.clearPriceLines(scope);
    this.drawPositionLine(scope);
    if (!scope) this.drawLevelLines();
  },

  /**
   * Draw the aggregate entry line from current position state.
   * Called only by redrawChartLines, which has already cleared the series.
   */
  drawPositionLine(scope) {
    const data = scope ? this.optionPanes?.[scope]?.positionData : this.chartPositionData;
    const series = scope ? this.optionPanes?.[scope]?.series : this.candleSeries;
    if (!data || !data.avgEntryPrice || !series) return;

    const css = getComputedStyle(document.documentElement);
    const colour = (data.netQuantity >= 0
      ? css.getPropertyValue('--color-profit')
      : css.getPropertyValue('--color-loss')).trim();

    const line = this.addPriceLine({
      price: data.avgEntryPrice,
      color: colour || '#888',
      lineWidth: 2,
      dashed: true,
      // Says what the line is, not just where it sits - "avg" is the whole point under fan-out.
      leftLabel: `avg entry · net ${data.netQuantity > 0 ? '+' : ''}${data.netQuantity}`,
    }, scope);
    if (scope) this.optionPanes[scope].positionLine = line; else this.positionLine = line;
  },

  /** Remove every registered line. Safe to call repeatedly and after the series is gone. */
  clearPriceLines(scope) {
    const chart = scope ? this.optionPanes?.[scope]?.chart : this.chart;
    const pane0 = chart?.panes?.()[0];
    const lines = scope ? this.optionPanes?.[scope]?.priceLines : this._priceLines;
    for (const line of lines || []) {
      try { pane0?.removePrimitive(line); } catch (_) { /* chart disposed */ }
    }
    if (scope) {
      const p = this.optionPanes?.[scope];
      if (p) { p.priceLines = []; p.positionLine = null; }
    } else {
      this._priceLines = [];
      this.levelLines = null;
      this.positionLine = null;
    }
  },

  /**
   * Toolbar popovers.
   *
   * One open at a time, closed by a click outside or Escape. They hold the controls that used to
   * each occupy a permanent row: the options mode, the instance picker with its blast-radius
   * line, and the whole indicator panel.
   */
  attachChartBarMenus() {
    const bar = document.querySelector('.chart-bar');
    if (!bar) return;

    const closeAll = (except = null) => {
      bar.querySelectorAll('.chart-pop').forEach((pop) => {
        if (pop.dataset.popFor === except) return;
        pop.hidden = true;
        bar.querySelector(`[data-pop="${pop.dataset.popFor}"]`)?.setAttribute('aria-expanded', 'false');
      });
    };

    bar.querySelectorAll('[data-pop]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.pop;
        const pop = bar.querySelector(`[data-pop-for="${name}"]`);
        if (!pop) return;
        const opening = pop.hidden;
        closeAll(opening ? name : null);
        pop.hidden = !opening;
        btn.setAttribute('aria-expanded', String(opening));
      });
    });

    // A click inside a popover must not close it - the panels are interactive.
    bar.querySelectorAll('.chart-pop').forEach((pop) =>
      pop.addEventListener('click', (e) => e.stopPropagation()));

    if (!this._chartBarBound) {
      this._chartBarBound = true;
      document.addEventListener('click', () => {
        if (this.currentView === 'chart') document.querySelectorAll('.chart-bar .chart-pop').forEach((p) => { p.hidden = true; });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.currentView === 'chart') {
          document.querySelectorAll('.chart-bar .chart-pop').forEach((p) => { p.hidden = true; });
        }
      });
    }
    this.updateChartBarChips();
  },

  /**
   * Keep the toolbar buttons carrying what their rows used to say: how many instances an order
   * fans out to, whether any of them are LIVE, how many indicators are on, and whether options
   * mode is engaged. Without this the information does not simply move - it disappears.
   */
  updateChartBarChips() {
    const info = this.chartTradeInfo;
    const count = document.getElementById('chart-send-count');
    if (count) count.textContent = info?.instances?.length ? String(info.instances.length) : '—';

    const badge = document.getElementById('chart-live-badge');
    if (badge) {
      const live = info?.liveCount || 0;
      badge.textContent = live ? `${live} LIVE` : '';
      badge.hidden = !live;
    }

    const sendBtn = document.querySelector('[data-pop="send"]');
    if (sendBtn) sendBtn.classList.toggle('is-blocked', Boolean(this.chartTradeBlocked));

    const ind = document.getElementById('chart-ind-count');
    if (ind && typeof this.indicatorConfig === 'function') {
      const on = Object.values(this.indicatorConfig()).filter((c) => c.on).length;
      ind.textContent = on ? String(on) : '';
    }

    const optBtn = document.querySelector('[data-pop="options"]');
    if (optBtn) {
      optBtn.hidden = typeof this.optionsAvailable === 'function' ? !this.optionsAvailable() : true;
      optBtn.classList.toggle('active', Boolean(this.chartOptionsOn));
      optBtn.textContent = this.chartOptionsOn ? 'Options ON' : 'Options';
    }

    const profCount = document.getElementById('chart-profile-count');
    if (profCount && typeof this.profileState === 'function') {
      const p = this.profileState();
      const on = [p.volumeOn, p.footprintOn, p.cvdOn].filter(Boolean).length;
      profCount.textContent = on ? String(on) : '';
    }
  },

  /**
   * Keep the chart fitted to the viewport as the browser window resizes. Bound once per page -
   * every chart rebuild (symbol/timeframe change, indicator toggle) recreates the container's
   * children but not the window itself, so one listener outlives any number of rebuilds.
   */
  _attachChartResizeListener() {
    if (this._chartResizeBound) return;
    this._chartResizeBound = true;
    let raf = null;
    window.addEventListener('resize', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        if (typeof this.resizeChartForPanes === 'function') this.resizeChartForPanes();
      });
    });
  },

  destroyChart() {
    // Leaving the chart view tears the chart down, so the zoom is captured here too - otherwise
    // navigating away and back reframes everything.
    if (typeof this.rememberChartView === 'function') this.rememberChartView();
    if (typeof this.stopChartLiveUpdates === 'function') this.stopChartLiveUpdates();
    if (typeof this.detachDrawingLayer === 'function') this.detachDrawingLayer();
    if (typeof this.destroyProfile === 'function') this.destroyProfile();
    if (typeof this.detachOrderLines === 'function') this.detachOrderLines();
    if (this.chart) {
      try { this.chart.destroy(); } catch (_) { /* already disposed */ }
    }
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    // The price line lived on the series that just went away; drop the stale handle so
    // clearPositionLine() never calls removePriceLine on a disposed series.
    this.positionLine = null;
    this.levelLines = null;
    this._priceLines = [];
    if (typeof this.destroyOptionPanes === 'function') this.destroyOptionPanes();
    this.unsyncCharts();
    // Heights are read off the chart's own pane separators, so this has to happen before the
    // chart goes away.
    if (typeof this.rememberOscHeights === 'function') this.rememberOscHeights();
    this.oscCharts = [];
  },

  /**
   * Key for the current view geometry. Zoom belongs to an instrument at a timeframe: carrying a
   * 1m zoom onto a daily chart would be meaningless.
   */
  chartViewKey() {
    const s = this.chartState;
    return s ? `${s.exchange}|${s.symbol}|${s.timeframe}` : null;
  },

  /**
   * Remember where the chart is looking.
   *
   * The visible LOGICAL range rather than a visible time range: it is independent of the bar
   * INDEX shifting, so appending live bars or refetching a slightly different window does not
   * move the view - restoring the same logical range re-frames the same bars.
   */
  rememberChartView() {
    // Stored against the key the CURRENT geometry belongs to, not chartViewKey() - by the time
    // this runs on a timeframe switch the state already names the new timeframe, so the old
    // zoom would be filed under the new one.
    const key = this._activeViewKey;
    if (!key || !this.chart || !this.candleSeries) return;
    try {
      // A chart that has not been given data yet is showing defaults, not a view worth keeping.
      // Without this, rebuilding the chart (leaving the view and coming back) overwrote the
      // saved zoom with the empty chart's defaults a moment before restoring from it.
      if (!this.candleSeries.getData().length) return;
      this._chartViews = this._chartViews || new Map();
      this._chartViews.set(key, this.chart.timeScale.visibleRange());
    } catch (_) { /* disposed */ }
  },

  /**
   * Put the view back where it was, or frame the data if this is the first sight of it.
   *
   * This is what stops the zoom resetting. loadChartData used to end in fitContent(), so every
   * refetch - returning to the browser tab, coming back to the chart view, an indicator toggle -
   * threw away whatever the user had zoomed into.
   */
  restoreChartView() {
    if (!this.chart) return;
    const ts = this.chart.timeScale;
    const saved = this._chartViews?.get(this.chartViewKey());

    if (saved && Number.isFinite(saved.from) && Number.isFinite(saved.to)) {
      try {
        ts.setVisibleLogicalRange(saved);
        return;
      } catch (_) { /* fall through to a fresh fit */ }
    }

    // Room to the right of the live bar - see RIGHT_OFFSET_BARS in dashboard-chart-panes.js.
    ts.setRightOffset(8);
    ts.fitContent(120);
  },

  async loadChartData() {
    const state = this.chartState;
    if (!state || !this.candleSeries) return;

    // Hold on to the current view before the data underneath it is replaced.
    this.rememberChartView();

    const statusEl = document.getElementById('chart-status');
    if (statusEl) statusEl.textContent = 'Loading…';

    // Span scales with the timeframe: enough bars to be useful, few enough to stay responsive.
    const spanDays = {
      '5s': 0.5, '10s': 0.5, '15s': 1, '30s': 1, '45s': 1,
      '1m': 3, '2m': 3, '3m': 5, '5m': 10, '10m': 15, '15m': 30, '20m': 30, '30m': 60,
      '1h': 120, '2h': 120, '4h': 180, D: 900,
    }[state.timeframe] || 10;
    const to = Math.floor(Date.now() / 1000);
    const from = to - spanDays * 86400;

    try {
      const res = await api.request(
        `/history?exchange=${encodeURIComponent(state.exchange)}`
        + `&symbol=${encodeURIComponent(state.symbol)}`
        + `&timeframe=${encodeURIComponent(state.timeframe)}&from=${from}&to=${to}`
      );
      const { candles = [], stale, source } = res.data || {};

      if (!candles.length) {
        // Common and legitimate: illiquid or far-dated contracts have no history at this
        // timeframe. Say which, rather than implying the chart is broken.
        if (statusEl) {
          statusEl.textContent = `No ${state.timeframe} history for ${state.symbol} — try a longer timeframe`;
        }
        this.candleSeries.setData([]);
        this.volumeSeries.setData([]);
        // Drop the previous timeframe's bars with them. Left in place, live ticks would fold
        // into 5m bars while the chart shows an empty 15m, and the legend and pattern markers
        // would go on describing data that is no longer on screen.
        this.chartCandles = [];
        this.chartLastBar = null;
        this.renderChartLegend();
        return;
      }

      // Reference price for the tickets, the legend and the context menu's validity rules. Set
      // BEFORE renderChartSeries() - transform box-size defaults read chartTickSize(), which
      // doesn't need this, but keeping candles-then-render in one order avoids re-litigating it.
      this.chartCandles = candles;

      // No display-time shift needed: the engine renders its time axis in IST natively from raw
      // UTC seconds (see the TIME AXIS note at the top of this file). Goes through
      // renderChartSeries() (dashboard-chart-types.js) rather than a direct setData() so the
      // active chart-type/pattern selection (candlestick, Heikin Ashi, Renko, ...) is honoured.
      if (typeof this.renderChartSeries === 'function') {
        this.renderChartSeries();
      } else {
        this.candleSeries.setData(candles.map((c) => ({
          time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close,
        })));
      }

      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue('--color-profit-bg').trim() || 'rgba(52,211,153,0.5)';
      const down = css.getPropertyValue('--color-loss-bg').trim() || 'rgba(248,113,113,0.5)';
      this.volumeSeries.setData(candles.map((c) => ({
        time: c.ts, value: c.volume || 0,
        color: c.close >= c.open ? up : down,
      })));

      this.restoreChartView();
      // From here the geometry on screen belongs to this symbol and timeframe.
      this._activeViewKey = this.chartViewKey();

      this.chartLastBar = candles[candles.length - 1];
      this.chartLastPrice = this.chartLastBar.close;
      this.applyIndicatorsTo(this.chart, this.candleSeries, candles);
      this.applyPatternsTo(this.chart, this.candleSeries, candles);
      // A different symbol or timeframe shares nothing with whatever ticks were accumulated for
      // the last one - reset before Volume Profile (history-derived, recomputes cleanly either
      // way) so Footprint/CVD (tick-accumulated) don't carry a stale instrument's order flow.
      if (typeof this.resetProfileTicks === 'function') this.resetProfileTicks();
      if (typeof this.refreshVolumeProfile === 'function') this.refreshVolumeProfile();
      if (typeof this.refreshOrderLines === 'function') this.refreshOrderLines();
      this.syncCharts();
      this.renderChartLegend();
      this.updateTicketPrices();

      if (statusEl) {
        const last = candles[candles.length - 1];
        const when = Utils.formatDateTime(new Date(last.ts * 1000).toISOString(), true);
        statusEl.textContent = stale
          ? `${candles.length} bars · cached (feed unreachable) · last ${when}`
          : `${candles.length} bars · ${source} · last ${when}`;
        statusEl.title = statusEl.textContent;
        statusEl.classList.toggle('is-stale', Boolean(stale));
      }
    } catch (error) {
      if (statusEl) statusEl.textContent = `Failed: ${error.message}`;
      console.error('[Chart] load failed', error);
    }
  },
});

/**
 * Position overlay (phase 2) - read-only.
 *
 * Under fan-out a single "entry price" line is ambiguous: two instances can hold the same
 * symbol at different average prices. The line drawn here is explicitly the quantity-weighted
 * aggregate, labelled with the net quantity, and the panel beneath lists each instance's leg -
 * so the line always has a stated meaning rather than an assumed one.
 */
Object.assign(DashboardApp.prototype, {
  async loadChartPosition() {
    const state = this.chartState;
    const panel = document.getElementById('chart-position');
    if (!state || !panel || !this.candleSeries) return;

    // Same race as loadChartLevels - see the note there.
    const token = (this._positionToken = (this._positionToken || 0) + 1);
    const stillCurrent = () => token === this._positionToken;

    let data;
    try {
      const res = await api.request(
        `/positions/symbol?exchange=${encodeURIComponent(state.exchange)}`
        + `&symbol=${encodeURIComponent(state.symbol)}`
      );
      if (!stillCurrent()) return;
      data = res.data;
    } catch (error) {
      if (!stillCurrent()) return;
      // Most likely the role lacks pages.positions.view. The chart is still fully usable
      // without the overlay, so degrade silently rather than breaking the view.
      this.chartPositionData = null;
      panel.hidden = true;
      return;
    }

    this.chartPositionData = data;

    if (!data || !data.legs.length) {
      panel.hidden = true;
      return;
    }

    const long = data.netQuantity > 0;

    const money = (v) => Utils.formatCurrency(v);
    const pnlClass = data.totalPnl >= 0 ? 'text-profit' : 'text-loss';

    this.redrawChartLines();

    panel.hidden = false;
    panel.innerHTML = `
      <div class="chart-position-summary">
        <span class="chart-position-side ${long ? 'is-long' : 'is-short'}">
          ${long ? 'LONG' : 'SHORT'} ${Math.abs(data.netQuantity)}
        </span>
        <span class="chart-position-stat">
          Avg entry <strong>${data.avgEntryPrice ? money(data.avgEntryPrice) : '—'}</strong>
        </span>
        <span class="chart-position-stat">
          P&amp;L <strong class="${pnlClass}">${money(data.totalPnl)}</strong>
        </span>
        <span class="chart-position-stat chart-position-muted">
          across ${data.instanceCount} instance${data.instanceCount === 1 ? '' : 's'}
        </span>
      </div>
      <table class="chart-position-legs">
        <thead>
          <tr><th>Instance</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">P&amp;L</th></tr>
        </thead>
        <tbody>
          ${data.legs.map((l) => `
            <tr>
              <td>
                ${Utils.escapeHTML(l.instanceName || `#${l.instanceId}`)}
                ${l.isAnalyzer ? '<span class="chart-leg-badge">analyzer</span>' : ''}
              </td>
              <td class="num">${l.quantity > 0 ? '+' : ''}${l.quantity}</td>
              <td class="num">${l.entryPrice ? money(l.entryPrice) : '—'}</td>
              <td class="num ${l.pnl >= 0 ? 'text-profit' : 'text-loss'}">${money(l.pnl)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  },

  // Kept as a named alias: both features share one series, so clearing either means clearing
  // the registry and redrawing from state (see redrawChartLines).
  clearPositionLine() {
    this.clearPriceLines();
  },

  /**
   * The pane equivalent of loadChartPosition() - fetches the same generic `/positions/symbol`
   * endpoint (already exchange/symbol-generic, no underlying-only assumption), scoped to the
   * pane's own OPTION CONTRACT rather than the underlying. Deliberately does NOT build the DOM
   * legs-table panel loadChartPosition() renders (`#chart-position`) - there's no room for it in
   * a pane, and the aggregate multi-instance panel stays a main-chart-only concept. Just the
   * price line, via the same scoped drawPositionLine()/redrawChartLines().
   */
  async loadPanePosition(key) {
    const pane = this.optionPanes?.[key];
    if (!pane?.contract || !pane.series) return;

    const token = (pane._positionToken = (pane._positionToken || 0) + 1);
    let data;
    try {
      const res = await api.request(
        `/positions/symbol?exchange=${encodeURIComponent(pane.contract.exchange)}`
        + `&symbol=${encodeURIComponent(pane.contract.symbol)}`
      );
      if (token !== pane._positionToken) return; // a newer fetch for this pane won the race
      data = res.data;
    } catch (_) {
      if (token !== pane._positionToken) return;
      data = null; // most likely pages.positions.view is missing - degrade silently
    }

    pane.positionData = data;
    this.redrawChartLines(key);
  },
});

/**
 * Chart trading (phase 3).
 *
 * The reference implementation this was modelled on is a single-instance terminal: one click,
 * one order, one broker. Here a click fans out to every order-enabled instance assigned to the
 * symbol's watchlist, so the confirmation is not a formality - it is the only place the
 * operator learns the blast radius. It therefore states, before anything is sent:
 *
 *   - the exact instances that will receive an order, live and analyzer listed separately
 *   - the resolved quantity
 *   - that partial success is a normal outcome, because it is
 *
 * Orders go to the existing POST /api/v1/quickorders. Nothing about sizing, product, risk or
 * auto-exit is reimplemented here - that is precisely why the symbol picker is restricted to
 * watchlist symbols.
 */
Object.assign(DashboardApp.prototype, {
  async loadChartTradePanel() {
    const state = this.chartState;
    const host = document.getElementById('chart-trade');
    const tickets = document.getElementById('chart-tickets');
    if (!state || !host) return;

    let info;
    try {
      const res = await api.request(`/quickorders/targets?symbolId=${encodeURIComponent(state.symbolId)}`);
      info = res.data;
      // Instance sets differ per watchlist; carrying a selection across symbols would send an
      // order somewhere the operator never chose.
      this.chartSelectedInstanceIds = null;
    } catch (error) {
      // No orders.place permission, most likely. A read-only chart is a valid state.
      host.hidden = true;
      if (tickets) tickets.hidden = true;
      this.chartTradeInfo = null;
      this.chartTradeBlocked = true;
      return;
    }

    this.chartTradeInfo = info;
    const sym = info.symbol;

    // Options need strike and expiry selection, which this chart has no surface for. Rather
    // than guess a contract, point at the screen that does it properly.
    const mode = sym.tradableEquity ? 'EQUITY' : sym.tradableFutures ? 'FUTURES' : null;
    if (!mode) {
      this.chartTradeBlocked = true;
      if (tickets) tickets.hidden = true;
      host.hidden = false;
      host.innerHTML = `
        <p class="chart-trade-note">
          ${sym.tradableOptions
            ? 'This symbol is configured for options. Use Watchlists to pick a strike and expiry.'
            : 'This symbol has no tradable mode configured.'}
        </p>`;
      return;
    }
    this.chartTradeMode = mode;

    const blocked = Boolean(info.unavailable) || info.instances.length === 0;
    this.chartTradeBlocked = blocked;
    if (tickets) tickets.hidden = blocked;
    this.updateTicketPrices();
    this.renderInstancePicker();
    this.renderOptionsPanel();
    this.renderOptionTickets();
    this.applySizingLabel();
    this.updateChartBarChips();

    host.hidden = false;
    host.innerHTML = `
      <div class="chart-trade-controls">
        <span class="chart-trade-target">
          ${blocked
            ? Utils.escapeHTML(info.unavailable || 'No order-enabled instance assigned')
            : `${mode}${this.chartOptionsOn ? ' underlying' : ''} · right-click the chart to place limit or stop orders · every order fans out to `
              + `${info.instances.length} instance${info.instances.length === 1 ? '' : 's'}`
              + (info.liveCount ? ` · <strong class="chart-trade-live">${info.liveCount} LIVE</strong>` : '')}
        </span>
      </div>`;
  },

  /**
   * Blast-radius confirmation. Resolves true only on an explicit click of the action button.
   */
  /**
   * Confirm-modal styling for an action that is not always simply BUY or SELL.
   * REDUCE/INCREASE act on an existing position rather than opening one, and CLOSE_ALL is an
   * exit - none of those are "buy-coloured" or "sell-coloured" in the way a fresh order is.
   */
  optionActionTone(action) {
    if (/^BUY(_|$)/.test(action)) return 'buy';
    if (/^SELL(_|$)/.test(action)) return 'sell';
    if (/^CLOSE_ALL/.test(action) || action === 'EXIT_ALL') return 'close';
    return 'neutral'; // REDUCE_*, INCREASE_*
  },

  confirmChartOrder(intent) {
    const info = this.chartTradeInfo;
    const state = this.chartState;
    const qty = parseInt(document.getElementById('chart-qty')?.value, 10);

    if (!info || !state || this.chartTradeBlocked) return;
    if (!Number.isInteger(qty) || qty <= 0) {
      Utils.showToast('Enter a quantity greater than zero', 'error');
      return;
    }

    const optionAction = intent.optionAction || null;
    const action = optionAction || intent.side;
    // Display only - the server always receives the raw action string above.
    const actionLabel = action.replace(/_/g, ' ');
    const orderType = intent.orderType || 'MARKET';
    const price = intent.price ?? null;
    const legNote = optionAction
      ? `${this.chartState.optionLeg || 'ATM'}${this.chartState.optionExpiry ? ` · ${this.chartState.optionExpiry}` : ' · nearest expiry'}`
      : null;
    const typeLabel = orderType === 'MARKET' ? 'Market'
      : orderType === 'LIMIT' ? `Limit @ ${Utils.formatNumber(price)}`
      : `Stop @ ${Utils.formatNumber(price)}`;

    // A leg order names its contract outright, so it is neither the underlying nor a
    // per-instance resolution - it is one known symbol at one known lot size.
    const contract = intent.contract || null;
    // An option ticket sizes in option lots; so does any order naming an explicit contract
    // directly (a pane's own right-click menu, not routed through optionAction resolution) -
    // anything else sizes as the underlying, even while options mode is on.
    const forOptions = Boolean(optionAction) || Boolean(contract);
    const sizing = this.sizingBreakdown(qty, forOptions, contract?.lotsize || null);
    if (!sizing) {
      Utils.showToast('Enter a valid size', 'error');
      return;
    }
    const unitWord = sizing.unit === 'LOTS'
      ? `${qty} lot${qty === 1 ? '' : 's'}`
      : `${fmtSize(qty)} qty`;

    const byId = new Map(sizing.perInstance.map((i) => [i.id, i]));
    const targets = this.selectedInstances();
    const live = targets.filter((i) => !i.isAnalyzer);
    const analyzer = targets.filter((i) => i.isAnalyzer);
    const row = (i) => {
      const b = byId.get(i.id);
      return `<li>
          <span>${Utils.escapeHTML(i.name)}</span>
          <span class="chart-confirm-size">${Utils.escapeHTML(b ? b.explain : '')}</span>
        </li>`;
    };

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content chart-confirm">
        <div class="modal-header">
          <h3>Confirm ${Utils.escapeHTML(actionLabel)} ${Utils.escapeHTML(typeLabel)} — ${Utils.escapeHTML(contract?.symbol || state.symbol)}</h3>
        </div>
        <div class="modal-body">
          <p class="chart-confirm-lead">
            This places <strong>${targets.length}</strong> separate
            ${Utils.escapeHTML(actionLabel)} ${Utils.escapeHTML(typeLabel)} order${targets.length === 1 ? '' : 's'}
            for <strong>${Utils.escapeHTML(unitWord)}</strong> of
            ${contract
              ? `<strong>${Utils.escapeHTML(contract.symbol)}</strong>`
              : optionAction
              ? `${Utils.escapeHTML(state.symbol)} <strong>${Utils.escapeHTML(legNote)}</strong> options`
              : Utils.escapeHTML(state.symbol)}
            (${Utils.escapeHTML(state.product)}) — one per instance below.
          </p>
          <p class="chart-confirm-lead chart-confirm-sizing">
            ${sizing.unknownLotSize
              ? 'Sized in lots. The contract\'s lot size decides the unit quantity, and is applied '
                + 'when each instance resolves its strike.'
              : sizing.unit === 'LOTS'
              ? `Lot size <strong>${fmtSize(sizing.lotSize)}</strong> — each instance's exact size is shown against its name.`
              : 'Sized in units.'}
          </p>
          ${optionAction ? (
            /^(BUY|SELL)_/.test(action)
              ? `<p class="chart-confirm-lead chart-confirm-sizing">
                   The exact strike is resolved per instance at execution from each one's live
                   price, so instances may end up on different strikes.
                 </p>`
              : `<p class="chart-confirm-lead chart-confirm-sizing">
                   Acts on whatever ${action.includes('CE') ? 'CE' : 'PE'} position is already
                   open per instance - it will not open a new strike.
                 </p>`
          ) : ''}
          ${orderType === 'MARKET' ? '' : `
            <p class="chart-confirm-lead chart-confirm-resting">
              A ${orderType === 'LIMIT' ? 'limit' : 'stop'} order rests at the broker until it
              triggers or you cancel it. Last price is
              ${Utils.formatNumber(this.chartLastPrice)}.
            </p>`}

          ${live.length ? `
            <div class="chart-confirm-group is-live">
              <h4>${live.length} LIVE — real money</h4>
              <ul>${live.map(row).join('')}</ul>
            </div>` : ''}

          ${analyzer.length ? `
            <div class="chart-confirm-group is-analyzer">
              <h4>${analyzer.length} analyzer — simulated</h4>
              <ul>${analyzer.map(row).join('')}</ul>
            </div>` : ''}

          <p class="chart-confirm-note">
            Instances are contacted independently. Some may fill while others fail — the result
            is reported per instance.
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" data-action="cancel">Cancel</button>
          <button class="btn ${{
            buy: 'btn-buy', sell: 'btn-sell', close: 'btn-close-all', neutral: 'btn-neutral',
          }[this.optionActionTone(action)]}" data-action="go">
            ${Utils.escapeHTML(actionLabel)} on ${targets.length}
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-action="go"]').addEventListener('click', async () => {
      close();
      await this.placeChartOrder({ action, typed: qty, orderType, price, optionAction, forOptions, contract });
    });
  },

  async placeChartOrder({
    action, typed, orderType, price,
    optionAction = null, forOptions = Boolean(optionAction), contract = null,
  }) {
    const state = this.chartState;
    const info = this.chartTradeInfo;
    if (!state || !info) return;

    // Convert once, here, to each endpoint's own unit. See the sizing block above.
    const lots = this.typedLots(typed, forOptions);
    const units = this.typedUnits(typed, forOptions, contract?.lotsize || null);
    if (lots === null || units === null) {
      Utils.showToast('Enter a valid size', 'error');
      return;
    }

    const lock = (on) => {
      document.querySelectorAll('.chart-ticket').forEach((b) => { b.disabled = on; });
    };
    lock(true);

    // Shared across the fan-out so a retried submit cannot double the position. Per-instance
    // calls suffix it, because each instance is a distinct order.
    const targets = this.selectedInstances();
    if (!targets.length) {
      Utils.showToast('Select at least one instance', 'error');
      lock(false);
      return;
    }

    const stamp = `chart-${state.symbolId}-${action}-${orderType}-${Date.now()}`;
    const sizeLabel = this.sizingUnit(forOptions) === 'LOTS'
      ? `${typed} lot${typed === 1 ? '' : 's'}`
      : `${fmtSize(typed)} qty`;

    try {
      let ok = 0;
      let failed = 0;
      let firstError = null;

      if (contract) {
        // One named contract, one price the operator chose: straight to /orders, per instance.
        // quick-order cannot express this - it resolves its OWN strike per instance, which is
        // the opposite of what picking a price on this contract's chart means.
        //
        // symbolId is omitted: the contract is not a watchlist row, and watchlist_symbols is
        // where tick size and limit buffer come from. Neither is needed here because the price
        // is explicit. watchlistId comes from the underlying, since watchlist_id is NOT NULL.
        const results = await Promise.allSettled(targets.map((inst) => api.request('/orders', {
          method: 'POST',
          body: {
            instanceId: inst.id,
            watchlistId: this.chartTradeInfo?.symbol?.watchlistId ?? null,
            exchange: contract.exchange,
            symbol: contract.symbol,
            action,
            quantity: units,
            product: state.product,
            pricetype: orderType,
            price: orderType === 'LIMIT' ? price : 0,
            trigger_price: orderType === 'SL-M' ? price : 0,
            request_id: `${stamp}-${inst.id}`,
            trigger_type: 'CHART',
          },
        })));
        ok = results.filter((r) => r.status === 'fulfilled').length;
        failed = results.length - ok;
        firstError = results.find((r) => r.status === 'rejected')?.reason?.message || null;
      } else if (orderType === 'MARKET') {
        // Market orders go through quick-order, which keeps every per-symbol guardrail:
        // margin sizing, product resolution, and auto-exit registration.
        const base = {
          symbolId: state.symbolId,
          action,
          tradeMode: optionAction ? 'OPTIONS' : this.chartTradeMode,
          // Strike offset + expiry are passed through; quick-order resolves the concrete
          // contract per instance via options-resolution.service. operatingMode and
          // strikePolicy travel too - REDUCE_*/INCREASE_* only resolve against the ACTUAL
          // open position (rather than a fresh ATM strike) when strikePolicy is FLOAT_OFS,
          // which is exactly the fix for a same-leg exit landing on a different strike.
          ...(optionAction ? {
            optionsLeg: state.optionLeg || 'ATM',
            ...(state.optionExpiry ? { expiry: state.optionExpiry } : {}),
            operatingMode: state.operatingMode === 'WRITER' ? 'WRITER' : 'BUYER',
            strikePolicy: state.strikePolicy === 'ANCHOR_OFS' ? 'ANCHOR_OFS' : 'FLOAT_OFS',
          } : {}),
          // LOTS: quick-order.service does `baseLots = quantity` then multiplies by lot size.
          quantity: lots,
          trigger_type: 'CHART',
        };

        if (this.isAllInstancesSelected()) {
          // instanceId is OMITTED, not 'ALL': the route validates it as a positive integer and
          // rejects the string, while the service treats absent/falsy as "broadcast to every
          // assigned instance" - one call, which is also one audit entry.
          const res = await api.request('/quickorders', {
            method: 'POST',
            body: { ...base, request_id: stamp },
          });
          const results = res.data?.results || [];
          ok = results.filter((r) => r.success).length;
          failed = results.length - ok;
        } else {
          // Narrowed selection: the endpoint takes one instance or none, so address them
          // individually. Still quick-order, so the guardrails are identical.
          const settled = await Promise.allSettled(targets.map((inst) => api.request('/quickorders', {
            method: 'POST',
            body: { ...base, instanceId: inst.id, request_id: `${stamp}-${inst.id}` },
          })));
          for (const r of settled) {
            const good = r.status === 'fulfilled'
              && (r.value?.data?.results || [{ success: true }]).every((x) => x.success !== false);
            if (good) ok += 1; else failed += 1;
          }
          firstError = settled.find((r) => r.status === 'rejected')?.reason?.message || null;
        }
      } else {
        // Limit and stop carry a price the operator chose, which quick-order cannot express -
        // it derives price type per instance and computes limit prices from live quote+buffer.
        // So fan out explicitly, one manual order per target instance.
        // placesmartorder reconciles to a SIGNED net target, so derive it from the position
        // we already have on screen rather than sending a bare quantity.
        const current = this.chartPositionData?.netQuantity || 0;
        const positionSize = action === 'BUY' ? current + units : current - units;

        const results = await Promise.allSettled(targets.map((inst) => api.request('/orders', {
          method: 'POST',
          body: {
            instanceId: inst.id,
            symbolId: state.symbolId,
            // watchlist_orders.watchlist_id is NOT NULL - omitting it made the insert fail
            // *after* the order had already gone to the broker.
            watchlistId: this.chartTradeInfo?.symbol?.watchlistId ?? null,
            exchange: state.exchange,
            symbol: state.symbol,
            action,
            // UNITS: order.service never multiplies by lot size, only by the instance
            // multiplier - so the lot conversion has to happen here.
            quantity: units,
            product: state.product,
            position_size: positionSize,
            pricetype: orderType,             // LIMIT | SL-M
            price: orderType === 'LIMIT' ? price : 0,
            trigger_price: orderType === 'SL-M' ? price : 0,
            request_id: `${stamp}-${inst.id}`,
            trigger_type: 'CHART',
          },
        })));
        ok = results.filter((r) => r.status === 'fulfilled').length;
        failed = results.length - ok;
        firstError = results.find((r) => r.status === 'rejected')?.reason?.message || null;
      }

      const what = orderType === 'MARKET' ? action : `${action} ${orderType}`;
      Utils.showToast(
        failed
          ? `${what} ${sizeLabel}: ${ok} succeeded, ${failed} failed${firstError ? ` — ${firstError}` : ''}`
          : `${what} ${sizeLabel} placed on ${ok} instance${ok === 1 ? '' : 's'}`,
        failed ? 'warning' : 'success'
      );

      await this.loadChartPosition();
      await this.loadChartLevels();
    } catch (error) {
      Utils.showToast(`Order failed: ${error.message}`, 'error');
    } finally {
      lock(false);
    }
  },
});

/**
 * Risk levels on the chart (phase 4).
 *
 * These lines are the symbol's target / stoploss / trailing config — the same rows
 * auto-exit.service monitors through risk-controls.service. They are NOT broker-side resting
 * orders, and dragging one does not place anything with a broker; it edits the rule the
 * monitoring loop already applies.
 *
 * Stored as POINTS relative to entry. risk-controls converts them:
 *     targetPrice = entry + direction * targetPoints
 *     stopPrice   = entry - direction * stoplossPoints
 * so this applies the exact inverse. Keeping the same formula on both sides is the whole point —
 * a line that renders somewhere the monitor wouldn't act is worse than no line.
 *
 * Lines only appear when a position is open, because target and stop are defined relative to an
 * entry price. Without a position there is no entry, so there is nothing truthful to draw.
 *
 * IMPORTANT: this config is symbol-level. Changing it changes the rule for every future position
 * on the symbol, not just the open one — the confirmation says so explicitly.
 */
Object.assign(DashboardApp.prototype, {
  async loadChartLevels() {
    const state = this.chartState;
    if (!state || !this.candleSeries) return;

    // renderChartView and the symbol-change handler can both be in flight at once. Without a
    // token the slower response draws its symbol's levels over the newer one - which is exactly
    // how the default symbol's 10/1 option levels ended up pinned on a SENSEX chart.
    const token = (this._levelsToken = (this._levelsToken || 0) + 1);
    const stillCurrent = () => token === this._levelsToken;

    // No entry price => target/stop are undefined. Phase 2 populated this.
    const pos = this.chartPositionData;
    if (!pos || !pos.legs.length || !pos.avgEntryPrice) {
      this.chartLevels = null;
      this.redrawChartLines();
      this.renderLevelsPanel();
      return;
    }

    try {
      const res = await api.request(`/history/levels?symbolId=${encodeURIComponent(state.symbolId)}`);
      if (!stillCurrent()) return; // a newer symbol won while this was in flight
      this.chartLevels = res.data;
    } catch (error) {
      if (!stillCurrent()) return;
      this.chartLevels = null;
      this.redrawChartLines();
      this.renderLevelsPanel();
      return;
    }

    this.redrawChartLines();
    this.renderLevelsPanel();
  },

  /** direction: +1 for a long book, -1 for a short one. Mirrors risk-controls. */
  _levelDirection() {
    return (this.chartPositionData?.netQuantity || 0) >= 0 ? 1 : -1;
  },

  pointsToPrice(kind, points) {
    const entry = this.chartPositionData?.avgEntryPrice;
    if (!entry || !points) return null;
    const d = this._levelDirection();
    return kind === 'target' ? entry + d * points : entry - d * points;
  },

  priceToPoints(kind, price) {
    const entry = this.chartPositionData?.avgEntryPrice;
    if (!entry || !price) return null;
    const d = this._levelDirection();
    const pts = kind === 'target' ? (price - entry) * d : (entry - price) * d;
    // A target below entry (or a stop above it) is not a level, it is a mistake.
    return pts > 0 ? Number(pts.toFixed(2)) : null;
  },

  drawLevelLines() {
    const lv = this.chartLevels;
    if (!lv || !this.candleSeries) return;
    const css = getComputedStyle(document.documentElement);

    const specs = [
      { kind: 'target', points: lv.points.target,
        colour: css.getPropertyValue('--color-profit').trim() || '#34D399', label: 'target' },
      { kind: 'stoploss', points: lv.points.stoploss,
        colour: css.getPropertyValue('--color-loss').trim() || '#F87171', label: 'stop' },
    ];

    this.levelLines = {};
    for (const spec of specs) {
      const price = this.pointsToPrice(spec.kind, spec.points);
      if (!price) continue;
      this.levelLines[spec.kind] = this.addPriceLine({
        price,
        color: spec.colour,
        lineWidth: 2,
        dashed: true,
        leftLabel: `${spec.label} · ${spec.points} pts`,
      });
    }
  },

  clearLevelLines() {
    this.clearPriceLines();
  },

  renderLevelsPanel() {
    const host = document.getElementById('chart-levels');
    if (!host) return;

    const lv = this.chartLevels;
    const pos = this.chartPositionData;

    if (!pos || !pos.legs.length) {
      host.hidden = true;
      return;
    }
    if (!lv) { host.hidden = true; return; }

    const row = (kind, label, points) => {
      const price = this.pointsToPrice(kind, points);
      return `
        <div class="chart-level-row" data-kind="${kind}">
          <span class="chart-level-name">${label}</span>
          <input type="number" class="form-input chart-level-input" data-kind="${kind}"
                 value="${points ?? ''}" min="0" step="0.05" placeholder="not set" />
          <span class="chart-level-price">${price ? `= ${Utils.formatCurrency(price)}` : '—'}</span>
        </div>`;
    };

    host.hidden = false;
    host.innerHTML = `
      <div class="chart-levels-head">
        <span class="chart-levels-title">Exit levels</span>
        <span class="chart-levels-mode">${Utils.escapeHTML(lv.mode)} · points from entry</span>
      </div>
      ${row('target', 'Target', lv.points.target)}
      ${row('stoploss', 'Stop loss', lv.points.stoploss)}
      <p class="chart-levels-note">
        Monitored by auto-exit, not resting at the broker. Drag a line or edit a value, then
        apply — this changes the rule for <strong>every future position</strong> on
        ${Utils.escapeHTML(lv.symbol)}, not just the open one.
      </p>
      <div class="chart-levels-actions">
        <button type="button" class="btn btn-neutral btn-outline btn-sm" data-action="reset">Reset</button>
        <button type="button" class="btn btn-buy btn-sm" data-action="apply" disabled>Apply</button>
      </div>`;

    const apply = host.querySelector('[data-action="apply"]');
    host.querySelectorAll('.chart-level-input').forEach((input) => {
      input.addEventListener('input', () => {
        this.previewLevelFromInput(input.dataset.kind, input.value);
        apply.disabled = false;
      });
    });
    host.querySelector('[data-action="reset"]').addEventListener('click', () => this.loadChartLevels());
    apply.addEventListener('click', () => this.confirmLevelChange());
  },

  /** Live-move the line as the number is typed, so the two representations never disagree. */
  previewLevelFromInput(kind, rawValue) {
    const points = rawValue === '' ? null : Number(rawValue);
    const price = this.pointsToPrice(kind, points);
    const host = document.getElementById('chart-levels');
    const priceEl = host?.querySelector(`.chart-level-row[data-kind="${kind}"] .chart-level-price`);
    if (priceEl) priceEl.textContent = price ? `= ${Utils.formatCurrency(price)}` : '—';

    const line = this.levelLines?.[kind];
    if (line && price) {
      line.setPrice(price);
      line.setLeftLabel(`${kind === 'target' ? 'target' : 'stop'} · ${points} pts`);
    }
  },
});

/**
 * Dragging a level line.
 *
 * Lightweight Charts has no draggable price lines, so this is hand-rolled: hit-test the pointer
 * against a line's y-coordinate, then track pointermove and convert back to a price via the
 * series' own coordinate scale.
 *
 * A movement threshold is required before a drag starts, otherwise every click on the chart
 * nudges a level by a pixel. Nothing is persisted on drop - the drag only moves the line and
 * fills the input; committing still goes through the confirmation.
 */
Object.assign(DashboardApp.prototype, {
  attachLevelDragging() {
    const container = document.getElementById('chart-container');
    if (!container || container.dataset.dragBound === 'true') return;
    container.dataset.dragBound = 'true';

    const HIT_TOLERANCE_PX = 6;
    const DRAG_THRESHOLD_PX = 3;
    let candidate = null;
    let startY = 0;
    let dragging = false;

    const lineYFor = (kind) => {
      const points = this.chartLevels?.points?.[kind];
      const price = this.pointsToPrice(kind, points);
      if (!price || !this.candleSeries) return null;
      const y = this.chart.priceToCoordinate(price, 0);
      return Number.isFinite(y) ? y : null;
    };

    container.addEventListener('pointerdown', (e) => {
      if (!this.levelLines) return;
      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;
      for (const kind of Object.keys(this.levelLines)) {
        const ly = lineYFor(kind);
        if (ly !== null && Math.abs(ly - y) <= HIT_TOLERANCE_PX) {
          candidate = kind;
          startY = y;
          break;
        }
      }
    });

    container.addEventListener('pointermove', (e) => {
      if (!candidate) return;
      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;

      if (!dragging) {
        if (Math.abs(y - startY) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        container.setPointerCapture?.(e.pointerId);
        container.classList.add('is-dragging-level');
      }

      const price = this.chart.coordinateToPrice(y, 0);
      if (!Number.isFinite(price)) return;
      const points = this.priceToPoints(candidate, price);
      if (points === null) return; // crossed entry - a stop above entry is not a stop

      const input = document.querySelector(`.chart-level-input[data-kind="${candidate}"]`);
      if (input) input.value = points;
      this.previewLevelFromInput(candidate, String(points));
      const apply = document.querySelector('#chart-levels [data-action="apply"]');
      if (apply) apply.disabled = false;
    });

    const end = (e) => {
      if (dragging) {
        container.releasePointerCapture?.(e.pointerId);
        container.classList.remove('is-dragging-level');
      }
      candidate = null;
      dragging = false;
    };
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
  },

  confirmLevelChange() {
    const lv = this.chartLevels;
    if (!lv) return;

    const read = (kind) => {
      const el = document.querySelector(`.chart-level-input[data-kind="${kind}"]`);
      const v = el?.value;
      return v === '' || v === undefined ? null : Number(v);
    };

    const next = { target: read('target'), stoploss: read('stoploss') };
    const changed = ['target', 'stoploss'].filter((k) => next[k] !== lv.points[k]);
    if (!changed.length) {
      Utils.showToast('No changes to apply', 'info');
      return;
    }

    for (const k of changed) {
      if (next[k] !== null && (!Number.isFinite(next[k]) || next[k] <= 0)) {
        Utils.showToast(`${k} must be a positive number of points`, 'error');
        return;
      }
    }

    const fmt = (pts, kind) => {
      if (pts === null) return 'not set';
      const price = this.pointsToPrice(kind, pts);
      return `${pts} pts${price ? ` (${Utils.formatCurrency(price)})` : ''}`;
    };

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content chart-confirm">
        <div class="modal-header"><h3>Update exit levels — ${Utils.escapeHTML(lv.symbol)}</h3></div>
        <div class="modal-body">
          <table class="chart-level-diff">
            <thead><tr><th>Level</th><th>Current</th><th>New</th></tr></thead>
            <tbody>
              ${changed.map((k) => `
                <tr>
                  <td>${k === 'target' ? 'Target' : 'Stop loss'}</td>
                  <td class="chart-level-old">${fmt(lv.points[k], k)}</td>
                  <td class="chart-level-new">${fmt(next[k], k)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          <p class="chart-confirm-note">
            Saved against the <strong>${Utils.escapeHTML(lv.symbol)}</strong> watchlist symbol
            (${Utils.escapeHTML(lv.mode)} mode). This is the rule auto-exit applies to
            <strong>every future position</strong> on this symbol across all instances — not only
            the one currently open. No order is placed with any broker.
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" data-action="cancel">Cancel</button>
          <button class="btn btn-buy" data-action="go">Save levels</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-action="go"]').addEventListener('click', async () => {
      close();
      await this.saveLevels(next, changed);
    });
  },

  async saveLevels(next, changed) {
    const lv = this.chartLevels;
    if (!lv) return;

    // Column names come from the server response, so the client writes exactly the columns the
    // server resolved for this symbol's mode.
    const payload = {};
    for (const k of changed) payload[lv.columns[k]] = next[k];

    try {
      await api.request(`/watchlists/${lv.watchlistId}/symbols/${lv.symbolId}`, {
        method: 'PUT',
        body: payload,
      });
      Utils.showToast('Exit levels updated', 'success');
      await this.loadChartLevels();
    } catch (error) {
      Utils.showToast(`Could not save levels: ${error.message}`, 'error');
    }
  },
});

/**
 * Chart-native order entry: OHLC legend, floating tickets, right-click context menu.
 *
 * The context menu is the piece that makes a chart a trading surface rather than a picture: you
 * right-click at a PRICE and the menu offers the orders that make sense AT that price.
 *
 * Which ones make sense is not cosmetic - it is what the order types mean:
 *
 *   Buy Limit   below LTP   (buy cheaper than market)
 *   Buy Stop    above LTP   (buy on a breakout upward)
 *   Sell Limit  above LTP   (sell dearer than market)
 *   Sell Stop   below LTP   (protective exit downward)
 *
 * Offering the inverted ones would submit orders every broker rejects, so they are shown
 * disabled with the reason rather than hidden - the operator learns the rule instead of
 * wondering where the option went.
 *
 * Routing differs by order type, and deliberately so:
 *   MARKET      -> POST /api/v1/quickorders  (fans out, keeps every per-symbol guardrail:
 *                  sizing, product resolution, risk/auto-exit registration)
 *   LIMIT/STOP  -> POST /api/v1/orders per instance, because quick-order derives its price type
 *                  from the instance and computes any limit price itself from live quote +
 *                  buffer. There is no path there for a caller-supplied price, and the whole
 *                  point of clicking a price on a chart is that YOU chose it.
 */
Object.assign(DashboardApp.prototype, {
  renderChartLegend() {
    const el = document.getElementById('chart-legend');
    const bar = this.chartLastBar;
    const st = this.chartState;
    if (!el || !bar || !st) return;

    const n = (v) => (v === null || v === undefined ? '—' : Utils.formatNumber(v));
    const change = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    const cls = change >= 0 ? 'text-profit' : 'text-loss';

    el.innerHTML = `
      <span class="chart-legend-sym">${Utils.escapeHTML(st.symbol)}</span>
      <span class="chart-legend-meta">${Utils.escapeHTML(st.timeframe)} · ${Utils.escapeHTML(st.exchange)}</span>
      <span class="chart-legend-ohlc">
        O <b>${n(bar.open)}</b> H <b>${n(bar.high)}</b> L <b>${n(bar.low)}</b> C <b>${n(bar.close)}</b>
      </span>
      <span class="chart-legend-ltp ${cls}">
        LTP <b>${n(this.chartLastPrice)}</b> ${change >= 0 ? '+' : ''}${change.toFixed(2)}%
      </span>`;
  },

  updateTicketPrices() {
    const host = document.getElementById('chart-tickets');
    if (!host) return;
    // Tickets only appear once the symbol is known to be tradeable (loadChartTradePanel decides).
    const price = this.chartLastPrice;
    const set = (role, v) => {
      const el = document.querySelector(`[data-role="${role}"]`);
      if (el) el.textContent = v === null || v === undefined ? '—' : Utils.formatNumber(v);
    };
    set('sell-price', price);
    set('buy-price', price);
    const badge = document.querySelector('[data-role="ticket-qty"]');
    if (badge) badge.textContent = this.chartState?.qty ?? 1;
  },

  /** Order types that are valid at `price` given the last traded price. */
  contextMenuItemsFor(price) {
    const ltp = this.chartLastPrice;
    const qty = this.chartState?.qty ?? 1;
    // false: this menu always trades the underlying, so it is sized as the underlying.
    const u = this.sizingUnit(false) === 'LOTS' ? (qty === 1 ? '1 lot' : `${qty} lots`) : `${qty}`;
    const below = ltp !== null && price < ltp;
    const above = ltp !== null && price > ltp;
    const p = Utils.formatNumber(price);

    return [
      { side: 'BUY', orderType: 'MARKET', label: `Buy ${u} Market`, enabled: true },
      { side: 'BUY', orderType: 'LIMIT', price, label: `Buy ${u} Limit @ ${p}`,
        enabled: below, why: 'a buy limit must sit below the last price' },
      { side: 'BUY', orderType: 'SL-M', price, label: `Buy ${u} Stop @ ${p}`,
        enabled: above, why: 'a buy stop must sit above the last price' },
      { side: 'SELL', orderType: 'MARKET', label: `Sell ${u} Market`, enabled: true },
      { side: 'SELL', orderType: 'LIMIT', price, label: `Sell ${u} Limit @ ${p}`,
        enabled: above, why: 'a sell limit must sit above the last price' },
      { side: 'SELL', orderType: 'SL-M', price, label: `Sell ${u} Stop @ ${p}`,
        enabled: below, why: 'a sell stop must sit below the last price' },
    ];
  },

  /**
   * Fullscreens the whole `.chart-view` (toolbar + canvas + panes), not just the canvas - a
   * fullscreen chart with no way to reach the timeframe/indicator popovers is a worse chart, not
   * a bigger one. Bound once per view render; toggling reflects Esc/external exits via the
   * `fullscreenchange` event so the icon never lies about the actual state.
   */
  attachFullscreenToggle() {
    const btn = document.getElementById('chart-fullscreen-btn');
    const target = document.querySelector('.chart-view');
    if (!btn || !target) return;

    btn.onclick = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        target.requestFullscreen().catch(() => { /* denied - user stays in normal view */ });
      }
    };

    if (!this._fullscreenBound) {
      this._fullscreenBound = true;
      document.addEventListener('fullscreenchange', () => {
        const active = Boolean(document.fullscreenElement);
        document.querySelector('#chart-fullscreen-btn')?.classList.toggle('active', active);
        // The engine doesn't observe its own container resizing - nudge it once the fullscreen
        // transition has actually applied its new layout.
        if (typeof this.resizeChartForPanes === 'function') {
          requestAnimationFrame(() => this.resizeChartForPanes());
        }
      });
    }
  },

  /** Persisted gridline style - read on every `initChart()` so a reload keeps the choice. */
  loadChartGridStyle() {
    try { return localStorage.getItem('chart-grid-style') || 'grid'; } catch (_) { return 'grid'; }
  },

  applyChartGridStyle(id) {
    const style = GRID_STYLES.find((g) => g.id === id) || GRID_STYLES[0];
    try { localStorage.setItem('chart-grid-style', style.id); } catch (_) { /* private mode */ }
    this.chart?.setGridOptions({ vertLines: style.vertLines, horzLines: style.horzLines });
  },

  /**
   * "Reset chart view" - exactly the last 50 candles, not `fitContent`'s "fit everything scaled
   * to roughly N bars wide" (which shows however many bars actually exist, not a fixed count).
   * Shared by the main chart and every pane's own reset-view menu item.
   */
  resetChartToLastBars(chart, candles, count = 50) {
    if (!chart) return;
    const n = (candles || []).length;
    if (!n) return;
    try {
      chart.timeScale.setVisibleLogicalRange({
        from: Math.max(0, n - count),
        to: n - 1 + RIGHT_OFFSET_BARS,
      });
    } catch (_) { /* disposed */ }
  },

  /** Hides/shows the drawing-tool rail and its flyout, persisted across reloads. */
  toggleDrawToolsRail() {
    const rail = document.getElementById('chart-draw-tools');
    if (!rail) return;
    const hidden = !rail.hidden;
    rail.hidden = hidden;
    const flyout = document.getElementById('chart-draw-flyout');
    if (flyout) flyout.hidden = true;
    try { localStorage.setItem('chart-draw-tools-hidden', hidden ? '1' : ''); } catch (_) { /* private mode */ }
  },

  /** Applies the persisted drawing-tool-rail visibility on (re)render. */
  restoreDrawToolsVisibility() {
    let hidden = false;
    try { hidden = localStorage.getItem('chart-draw-tools-hidden') === '1'; } catch (_) { /* private mode */ }
    const rail = document.getElementById('chart-draw-tools');
    if (rail) rail.hidden = hidden;
  },

  attachChartContextMenu() {
    const container = document.getElementById('chart-container');
    const menu = document.getElementById('chart-ctx');
    if (!container || !menu || container.dataset.ctxBound === 'true') return;
    container.dataset.ctxBound = 'true';

    const hide = () => { menu.hidden = true; };
    document.addEventListener('click', hide);
    document.addEventListener('scroll', hide, true);

    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.chart) return;

      const rect = container.getBoundingClientRect();
      const price = this.chart.coordinateToPrice(e.clientY - rect.top, 0);

      // Trade tickets only when the underlying is actually tradeable at a real price on the
      // canvas - the utility items below (reset view / drawing tools / grid) always apply, even
      // on a non-tradeable instrument (an index) where the menu used to not open at all.
      const tradeItems = (this.candleSeries && this.chartTradeInfo && !this.chartTradeBlocked
        && Number.isFinite(price))
        ? this.contextMenuItemsFor(Number(price.toFixed(2)))
        : [];

      const drawHidden = document.getElementById('chart-draw-tools')?.hidden;
      const gridStyle = this.loadChartGridStyle();

      menu.innerHTML = `
        ${tradeItems.map((it, i) => `
          <button type="button" class="chart-ctx-item ${it.side === 'BUY' ? 'is-buy' : 'is-sell'}"
                  data-trade-i="${i}" ${it.enabled ? '' : 'disabled'}
                  ${it.enabled ? '' : `title="Not valid here — ${Utils.escapeHTML(it.why)}"`}>
            ${Utils.escapeHTML(it.label)}
          </button>`).join('')}
        ${tradeItems.length ? '<div class="chart-ctx-sep"></div>' : ''}
        <button type="button" class="chart-ctx-item is-neutral" data-action="reset-view">Reset chart view</button>
        <button type="button" class="chart-ctx-item is-neutral" data-action="toggle-draw">
          ${drawHidden ? 'Show' : 'Hide'} drawing tools
        </button>
        <div class="chart-ctx-submenu">
          <button type="button" class="chart-ctx-item is-neutral" data-action="grid-menu">Grid ›</button>
          <div class="chart-ctx-flyout" data-role="grid-flyout" hidden>
            ${GRID_STYLES.map((g) => `
              <button type="button" class="chart-ctx-item is-neutral" data-grid="${g.id}">
                ${gridStyle === g.id ? '✓ ' : ''}${Utils.escapeHTML(g.label)}
              </button>`).join('')}
          </div>
        </div>
      `;

      // Keep the menu inside the chart rather than letting it overflow the viewport.
      // `rect` is the container, which now starts after the tool rail, so no rail offset here.
      const rowCount = tradeItems.length + (tradeItems.length ? 1 : 0) + 3;
      const x = Math.min(e.clientX - rect.left, rect.width - 210);
      const y = Math.min(e.clientY - rect.top, rect.height - rowCount * 30 - 16);
      menu.style.left = `${Math.max(0, x)}px`;
      menu.style.top = `${Math.max(0, y)}px`;
      menu.hidden = false;

      menu.querySelectorAll('[data-trade-i]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hide();
          this.confirmChartOrder(tradeItems[Number(btn.dataset.tradeI)]);
        });
      });

      menu.querySelector('[data-action="reset-view"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hide();
        this.resetChartToLastBars(this.chart, this.chartCandles);
      });

      menu.querySelector('[data-action="toggle-draw"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hide();
        this.toggleDrawToolsRail();
      });

      const flyout = menu.querySelector('[data-role="grid-flyout"]');
      menu.querySelector('[data-action="grid-menu"]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (flyout) flyout.hidden = !flyout.hidden;
      });
      menu.querySelectorAll('[data-grid]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hide();
          this.applyChartGridStyle(btn.dataset.grid);
        });
      });
    });
  },
});

/**
 * Order sizing.
 *
 * The number in the toolbar means different things by instrument class, because that is how
 * traders think about them:
 *
 *   equity (mode 'direct')      -> QUANTITY, in units
 *   futures / options           -> LOTS, each worth `lotSize` units
 *
 * The two backend paths disagree about their own units, which is the trap this centralises:
 *
 *   POST /quickorders  `quantity` is LOTS   (quick-order.service: baseLots = quantity,
 *                                            then tradeQuantity = tradeLots * lotSize)
 *   POST /orders       `quantity` is UNITS  (order.service applies the instance multiplier
 *                                            only; it never multiplies by lot size)
 *
 * Feeding the same figure to both - which this chart did - meant a market order and a limit
 * order placed from the same box differed by a factor of `lotSize`. On NATGASMINI (250) with an
 * instance on multiplier 5, "1" was 1,250 units as a market order and 5 units as a limit.
 *
 * Everything below converts explicitly at the boundary. No caller should send a raw figure to
 * either endpoint again.
 */
/** Sizes are whole numbers; formatNumber's 2dp default makes a quantity read like a price. */
function fmtSize(n) {
  return Utils.formatNumber(n, 0);
}

Object.assign(DashboardApp.prototype, {
  /** 'LOTS' for futures/options (and always for option orders), 'QTY' for equity. */
  /**
   * How the size box is read.
   *
   * `forOptions` matters because both things are tradeable at once: with options mode on, the
   * CE/PE tickets size in option lots while a right-click on the underlying still trades the
   * underlying, which has its own class and its own lot size. Defaulting to the options mode
   * would silently size a futures order with the option contract's lot size.
   */
  sizingUnit(forOptions = this.chartOptionsOn) {
    if (forOptions) return 'LOTS';
    const mode = this.chartTradeInfo?.symbol?.mode;
    return mode === 'futures' || mode === 'options' ? 'LOTS' : 'QTY';
  },

  /**
   * Lot size of the thing being ordered, or null when it cannot be known yet.
   *
   * For an option order this is deliberately null. The watchlist row for an INDEX carries
   * lot_size 1 - correct, because an index cannot be traded - but the ORDER goes on a derivative
   * whose lot size belongs to the resolved contract: BANKNIFTY 30, SENSEX 20, NIFTY 25 or 65.
   * NIFTY genuinely carries both in this instruments cache, with 25-AUG-26 holding contracts at
   * each, so it is not derivable from underlying or even expiry. quick-order reads
   * `optionSymbol.lot_size` from the contract it resolves per instance, which is right; the
   * chart simply must not invent a units figure it cannot stand behind. Showing "2 lots = 2
   * units" against an order that will be 2 x 30 is worse than showing nothing.
   */
  lotSize(forOptions = this.chartOptionsOn) {
    const sym = this.chartTradeInfo?.symbol;
    if (forOptions) {
      // The option contract's lot size, resolved server-side from instruments.underlying_key
      // (NIFTY 65, BANKNIFTY 30, SENSEX 20...). The watchlist row's lot_size is 1 for an index
      // and would understate an option order by 20-65x. null when the underlying has no single
      // consistent value - then no unit figure is shown at all.
      const o = Number(sym?.optionLotSize);
      return Number.isFinite(o) && o > 0 ? o : null;
    }
    const n = Number(sym?.lotSize);
    return Number.isFinite(n) && n > 0 ? n : 1;
  },

  /** Lots implied by what the operator typed. */
  typedLots(typed, forOptions = this.chartOptionsOn) {
    const n = Number(typed);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (this.sizingUnit(forOptions) === 'LOTS') return n;
    // Equity: they typed units. Convert to whole lots for the lot-based endpoint.
    return Math.max(1, Math.round(n / (this.lotSize(forOptions) || 1)));
  },

  /** Units implied by what the operator typed, or null when the lot size is unknown. */
  typedUnits(typed, forOptions = this.chartOptionsOn, lotSizeOverride = null) {
    const n = Number(typed);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (lotSizeOverride) return n * lotSizeOverride;
    if (this.sizingUnit(forOptions) !== 'LOTS') return n;
    const ls = this.lotSize(forOptions);
    return ls === null ? null : n * ls; // null => option contract not resolved yet
  },

  /**
   * What each instance actually receives. The instance multiplier is applied by both backend
   * paths, so it belongs in the figure shown before confirming - otherwise an instance on
   * multiplier 5 silently trades five times what was typed.
   */
  sizingBreakdown(typed, forOptions = this.chartOptionsOn, lotSizeOverride = null) {
    const lots = this.typedLots(typed, forOptions);
    const baseUnits = this.typedUnits(typed, forOptions, lotSizeOverride);
    if (lots === null) return null;

    // A resolved contract knows its own lot size, so nothing has to be guessed for it.
    const lotSize = lotSizeOverride || this.lotSize(forOptions);
    const unit = lotSizeOverride ? 'LOTS' : this.sizingUnit(forOptions);
    const instances = this.selectedInstances();

    return {
      unit,
      lots,
      lotSize,
      baseUnits,
      unknownLotSize: baseUnits === null,
      perInstance: instances.map((i) => {
        const mult = i.multiplier || 1;
        return {
          ...i,
          multiplier: mult,
          units: baseUnits === null ? null : baseUnits * mult,
          lots: lots * mult,
          // Spelled out so the arithmetic is checkable at a glance, not inferred.
          explain: baseUnits === null
            ? `${lots * mult} lot${lots * mult === 1 ? '' : 's'}`
              + (mult !== 1 ? ` (${lots} × ${mult} multiplier)` : '')
              + ' — units set by the resolved contract'
            : unit === 'LOTS'
            ? `${lots} lot${lots === 1 ? '' : 's'} × ${lotSize}`
              + (mult !== 1 ? ` × ${mult} (multiplier)` : '')
              + ` = ${fmtSize(baseUnits * mult)} units`
            : `${fmtSize(baseUnits)} units`
              + (mult !== 1 ? ` × ${mult} (multiplier) = ${fmtSize(baseUnits * mult)} units` : ''),
        };
      }),
    };
  },
});

Object.assign(DashboardApp.prototype, {
  /**
   * Retitle the size box for the instrument class, and show what it resolves to underneath.
   * The old fixed "Qty" label was wrong for F&O, where the figure has always been lots.
   */
  applySizingLabel() {
    // A dedicated span, not the wrapping <label>. The label now contains the input, so writing
    // textContent to it would delete the field this function is describing.
    const label = document.getElementById('chart-lots-label');
    const hint = document.getElementById('chart-size-hint');
    const input = document.getElementById('chart-qty');
    if (!label || !input) return;

    const unit = this.sizingUnit();
    label.textContent = unit === 'LOTS' ? 'Lots' : 'Qty';
    input.step = unit === 'LOTS' ? 1 : (this.lotSize() || 1);
    input.title = unit === 'LOTS'
      ? `Lots. Lot size ${this.lotSize()} — 1 lot = ${this.lotSize()} units.`
      : 'Quantity in units.';

    if (hint) {
      const full = this.sizeHintText(input.value);
      // The toolbar shows the OUTCOME - the units that would actually reach the brokers -
      // because that is the figure worth checking before clicking. The full arithmetic stays in
      // the tooltip and in the Send-to panel; truncating it with an ellipsis instead would leave
      // a half-read number, which is worse than a short one.
      hint.textContent = this.sizeHintShort(input.value) || full;
      hint.title = full;
    }
  },

  /** "1 lot = 250 units · Jz Fyers ×5 → 1,250" - the arithmetic, before anything is clicked. */
  /** "→ 1,250 units" - the total that would actually be sent, across every selected instance. */
  sizeHintShort(typed) {
    const b = this.sizingBreakdown(typed);
    if (!b) return '';
    if (b.unknownLotSize) return `${b.lots} lot${b.lots === 1 ? '' : 's'} each`;
    const total = b.perInstance.reduce((sum, i) => sum + (i.units || 0), 0);
    if (!total) return '';
    return `→ ${fmtSize(total)} units`;
  },

  sizeHintText(typed) {
    const b = this.sizingBreakdown(typed);
    if (!b) return '';
    if (b.unit === 'QTY' && !b.unknownLotSize && b.perInstance.every((i) => i.multiplier === 1)) return '';

    const head = b.unknownLotSize
      ? `${b.lots} lot${b.lots === 1 ? '' : 's'} per instance — units set by the contract`
      : b.unit === 'LOTS'
      ? `${b.lots} lot${b.lots === 1 ? '' : 's'} = ${fmtSize(b.baseUnits)} units`
      : `${fmtSize(b.baseUnits)} units`;
    const scaled = b.perInstance
      .filter((i) => i.multiplier !== 1)
      .map((i) => `${i.name} ×${i.multiplier} → ${b.unknownLotSize ? `${i.lots} lots` : fmtSize(i.units)}`);
    return scaled.length ? `${head} · ${scaled.join(' · ')}` : head;
  },
});

/**
 * Instance selection.
 *
 * Targets default to every order-enabled instance on the symbol's watchlist - the existing
 * fan-out - but the operator can narrow that per order without leaving the chart. The selection
 * is deliberately NOT persisted across symbols: instance sets differ per watchlist, and a
 * remembered selection silently carried onto a different symbol is how you send an order
 * somewhere you didn't intend.
 *
 * Routing follows the selection:
 *   all selected   -> one /quickorders call with no instanceId (the service broadcasts)
 *   a subset       -> one /quickorders call per selected instance
 * Both keep quick-order's per-symbol guardrails; the subset case just addresses them one at a
 * time, because the endpoint takes a single instance or none.
 */
Object.assign(DashboardApp.prototype, {
  selectedInstances() {
    const all = this.chartTradeInfo?.instances || [];
    const chosen = this.chartSelectedInstanceIds;
    if (!chosen) return all;                       // nothing touched yet => all
    const set = new Set(chosen);
    return all.filter((i) => set.has(i.id));
  },

  isAllInstancesSelected() {
    const all = this.chartTradeInfo?.instances || [];
    return this.selectedInstances().length === all.length && all.length > 0;
  },

  renderInstancePicker() {
    const host = document.getElementById('chart-instances');
    const info = this.chartTradeInfo;
    if (!host) return;

    if (!info || !info.instances.length || this.chartTradeBlocked) {
      host.hidden = true;
      return;
    }

    const selected = new Set(this.selectedInstances().map((i) => i.id));
    host.hidden = false;
    host.innerHTML = `
      <span class="chart-inst-label">Send to</span>
      ${info.instances.map((i) => `
        <label class="chart-inst ${selected.has(i.id) ? 'is-on' : ''} ${i.isAnalyzer ? 'is-analyzer' : 'is-live'}">
          <input type="checkbox" data-instance="${i.id}" ${selected.has(i.id) ? 'checked' : ''} />
          <span class="chart-inst-name">${Utils.escapeHTML(i.name)}</span>
          <span class="chart-inst-tag">${i.isAnalyzer ? 'analyzer' : 'LIVE'}${i.multiplier !== 1 ? ` ×${i.multiplier}` : ''}</span>
        </label>`).join('')}
      <button type="button" class="chart-inst-all" data-action="all">All</button>`;

    host.querySelectorAll('input[data-instance]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const ids = [...host.querySelectorAll('input[data-instance]:checked')]
          .map((x) => Number(x.dataset.instance));
        // Empty selection is meaningless - fall back to all rather than silently arming a
        // button that would send nothing.
        this.chartSelectedInstanceIds = ids.length ? ids : null;
        this.renderInstancePicker();
        this.applySizingLabel();
      });
    });
    host.querySelector('[data-action="all"]').addEventListener('click', () => {
      this.chartSelectedInstanceIds = null;
      this.renderInstancePicker();
      this.applySizingLabel();
    });
  },
});

/**
 * Options on the charted underlying, without opening an option chart.
 *
 * This adds no new order machinery. POST /quickorders already accepts
 * `tradeMode: 'OPTIONS'` with `action: BUY_CE | SELL_CE | BUY_PE | SELL_PE`, an `optionsLeg`
 * strike offset (ITM3…OTM3), an optional `expiry`, and `quantity` in LOTS. Per instance it
 * resolves the concrete strike through options-resolution.service - the same path the watchlist
 * quick-order and the strategy engine use - so sizing, product, ATM hysteresis and auto-exit
 * registration all behave identically to trading the option from a watchlist.
 *
 * The chart only chooses CE/PE, the offset and the expiry, and states what it will do.
 *
 * Market only, deliberately. A limit or stop needs a concrete symbol and price up front, but the
 * strike is resolved per instance at execution time and can legitimately differ between them
 * (different LTP, different ATM). Offering a resting option order here would mean pricing a
 * contract that hasn't been chosen yet.
 */
const OPTION_LEGS = ['ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3'];

Object.assign(DashboardApp.prototype, {
  optionsAvailable() {
    return Boolean(this.chartTradeInfo?.symbol?.tradableOptions) && !this.chartTradeBlocked;
  },

  renderOptionsPanel() {
    const host = document.getElementById('chart-options');
    if (!host) return;

    if (!this.optionsAvailable()) {
      host.hidden = true;
      // Clear the panes too - a symbol with no options must not keep the previous one's.
      if (this.chartOptionsOn) { this.chartOptionsOn = false; this.refreshOptionPanes(); }
      return;
    }

    const st = this.chartState;
    const leg = OPTION_LEGS.includes(st.optionLeg) ? st.optionLeg : 'ATM';
    const on = Boolean(this.chartOptionsOn);

    const operatingMode = st.operatingMode === 'WRITER' ? 'WRITER' : 'BUYER';
    const strikePolicy = st.strikePolicy === 'ANCHOR_OFS' ? 'ANCHOR_OFS' : 'FLOAT_OFS';

    host.hidden = false;
    host.innerHTML = `
      <label class="chart-opt-toggle">
        <input type="checkbox" id="chart-opt-on" ${on ? 'checked' : ''} />
        <span>Trade options on this underlying</span>
      </label>
      <div class="chart-opt-controls" ${on ? '' : 'hidden'}>
        <span class="chart-toolbar-label">Strike</span>
        ${OPTION_LEGS.map((l) => `
          <button type="button" class="chart-opt-leg ${l === leg ? 'active' : ''}" data-leg="${l}">${l}</button>`).join('')}
        <span class="chart-toolbar-label">Expiry</span>
        <select id="chart-opt-expiry" class="form-input chart-opt-expiry">
          <option value="">Nearest</option>
        </select>

        <span class="chart-toolbar-label">Flow</span>
        <div class="operating-mode-compact" role="group" aria-label="Buyer or Writer">
          <button type="button" class="btn-operating ${operatingMode === 'BUYER' ? 'active' : ''}"
                  data-mode="BUYER" title="Buyer mode: BUY opens, REDUCE/CLOSE exit">Buyer</button>
          <button type="button" class="btn-operating ${operatingMode === 'WRITER' ? 'active' : ''}"
                  data-mode="WRITER" title="Writer mode: SELL opens, INCREASE/CLOSE exit">Writer</button>
        </div>

        <span class="chart-toolbar-label">Policy</span>
        <select id="chart-opt-policy" class="form-input chart-opt-policy">
          <option value="FLOAT_OFS" ${strikePolicy === 'FLOAT_OFS' ? 'selected' : ''}>Float (strike follows ATM)</option>
          <option value="ANCHOR_OFS" ${strikePolicy === 'ANCHOR_OFS' ? 'selected' : ''}>Anchor (strike fixed once opened)</option>
        </select>

        <span class="chart-opt-note">
          CE/PE tickets are market only — the strike is resolved per instance at execution.
          Reduce/Increase/Close act on whatever is already open, not a fresh strike.
          Right-clicking the chart still places resting orders on the underlying.
        </span>
      </div>`;

    document.getElementById('chart-opt-on').addEventListener('change', (e) => {
      this.chartOptionsOn = e.target.checked;
      this.updateChartBarChips();
      this.renderOptionsPanel();
      this.renderOptionTickets();
      this.applySizingLabel();
      this.refreshOptionPanes();
    });
    host.querySelectorAll('.chart-opt-leg').forEach((btn) => {
      btn.addEventListener('click', () => {
        host.querySelectorAll('.chart-opt-leg').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.chartState.optionLeg = btn.dataset.leg;
        this.saveChartPreference();
        this.refreshOptionPanes();
      });
    });
    const exp = document.getElementById('chart-opt-expiry');
    if (exp) exp.addEventListener('change', () => {
      this.chartState.optionExpiry = exp.value || null;
      this.refreshOptionPanes();
    });
    host.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.chartState.operatingMode === btn.dataset.mode) return;
        this.chartState.operatingMode = btn.dataset.mode;
        this.renderOptionsPanel();
        this.renderOptionTickets();
      });
    });
    const policySel = document.getElementById('chart-opt-policy');
    if (policySel) policySel.addEventListener('change', () => {
      this.chartState.strikePolicy = policySel.value;
    });
  },

  /**
   * Populate the expiry dropdown from the option-legs response.
   *
   * Deliberately NOT /api/v1/symbols/expiry: that goes to the broker and needs the DERIVATIVES
   * exchange, while the chart only knows the underlying's (NSE_INDEX, BSE_INDEX). Asking with
   * the index exchange is a 400. The instruments cache already holds every expiry, so
   * refreshOptionPanes returns them and this just renders the list.
   */
  populateExpiries(list) {
    const sel = document.getElementById('chart-opt-expiry');
    if (!sel || !Array.isArray(list) || !list.length) return;
    const cur = this.chartState?.optionExpiry || '';
    sel.innerHTML = '<option value="">Nearest</option>'
      + list.map((e) => `<option value="${Utils.escapeHTML(e)}" ${cur === e ? 'selected' : ''}>${Utils.escapeHTML(e)}</option>`).join('');
  },

  /** Swap the two tickets for four when trading options. */
  renderOptionTickets() {
    const host = document.getElementById('chart-tickets');
    if (!host || this.chartTradeBlocked) return;

    if (!this.chartOptionsOn) {
      host.classList.remove('is-options');
      host.innerHTML = `
        <button type="button" class="chart-ticket is-sell" data-side="SELL">
          <span class="chart-ticket-price" data-role="sell-price">—</span>
          <span class="chart-ticket-label">SELL</span>
        </button>
        <span class="chart-ticket-qty" data-role="ticket-qty">${this.chartState?.qty ?? 1}</span>
        <button type="button" class="chart-ticket is-buy" data-side="BUY">
          <span class="chart-ticket-price" data-role="buy-price">—</span>
          <span class="chart-ticket-label">BUY</span>
        </button>`;
      host.querySelectorAll('.chart-ticket').forEach((b) => b.addEventListener('click',
        () => this.confirmChartOrder({ side: b.dataset.side, orderType: 'MARKET' })));
      this.updateTicketPrices();
      return;
    }

    host.classList.add('is-options');
    // Same three-action-per-leg model as the watchlist's Buyer/Writer controls (same CSS
    // classes too - see trading-controls.css), so a strike is only ever opened in BUYER mode
    // (BUY_CE/BUY_PE) or WRITER mode (SELL_CE/SELL_PE); REDUCE/INCREASE/CLOSE act on whatever
    // is ALREADY open rather than resolving a fresh ATM strike. That is what stops a same-leg
    // exit from landing on a different strike than the one that was actually opened - a plain
    // SELL PE always re-resolves ATM, which drifts the moment the underlying ticks.
    const operatingMode = this.chartState?.operatingMode === 'WRITER' ? 'WRITER' : 'BUYER';
    const leg = (type) => (operatingMode === 'BUYER'
      ? [
        { a: `BUY_${type}`, label: `BUY ${type}`, cls: `btn-buy-${type.toLowerCase()}` },
        { a: `REDUCE_${type}`, label: `REDUCE ${type}`, cls: `btn-reduce-${type.toLowerCase()}` },
        { a: `CLOSE_ALL_${type}`, label: `CLOSE ${type}`, cls: `btn-close-all-${type.toLowerCase()}` },
      ]
      : [
        { a: `SELL_${type}`, label: `SELL ${type}`, cls: `btn-sell-${type.toLowerCase()}` },
        { a: `INCREASE_${type}`, label: `INCREASE ${type}`, cls: `btn-increase-${type.toLowerCase()}` },
        { a: `CLOSE_ALL_${type}`, label: `CLOSE ${type}`, cls: `btn-close-all-${type.toLowerCase()}` },
      ]);

    const column = (type) => leg(type).map((x) => `
      <button type="button" class="chart-ticket-opt btn-action-compact btn-outline ${x.cls}" data-option-action="${x.a}">
        ${x.label}
      </button>`).join('');

    host.innerHTML = `
      <div class="chart-ticket-col">
        <span class="chart-ticket-col-label">CALL</span>
        ${column('CE')}
      </div>
      <div class="chart-ticket-col">
        <span class="chart-ticket-col-label">PUT</span>
        ${column('PE')}
      </div>`;
    host.querySelectorAll('[data-option-action]').forEach((b) => b.addEventListener('click',
      () => this.confirmChartOrder({ optionAction: b.dataset.optionAction, orderType: 'MARKET' })));
  },
});
