/**
 * Chart / series type picker - openalgo-charts' `SeriesType` union (plain display variants) plus
 * its `transform` tier (Heikin Ashi, Renko, Range Bars, Line Break - bar-data transforms that
 * render through the ordinary candlestick renderer, not a display variant of their own).
 *
 * The transforms are genuinely incremental (their own doc comment: "streaming so live ticks
 * extend the series without recomputing history"), so this keeps ONE persisted transform
 * instance per chart and feeds it one bar at a time as real bars close - see
 * feedChartTransformOnClose() in dashboard-chart-live.js. Nothing recomputes the whole series on
 * every tick.
 */

/** Plain `SeriesType` values the price series can render as directly. */
const PLAIN_SERIES_TYPES = [
  { type: 'candlestick', label: 'Candles' },
  { type: 'hollow-candle', label: 'Hollow Candles' },
  { type: 'volume-candle', label: 'Volume Candles' },
  { type: 'bar', label: 'Bars (OHLC)' },
  { type: 'high-low', label: 'High-Low' },
  { type: 'line', label: 'Line' },
  { type: 'line-markers', label: 'Line + Markers' },
  { type: 'step', label: 'Step' },
  { type: 'area', label: 'Area' },
  { type: 'hlc-area', label: 'HLC Area' },
  { type: 'baseline', label: 'Baseline' },
];

/**
 * Bar-transform types. `factory(boxSize)` returns a fresh transform instance - fresh, because a
 * transform carries its own running state (Renko's last brick edge, Line Break's last N lines)
 * that must restart clean on symbol/timeframe/type change, not survive across them.
 */
const TRANSFORM_SERIES_TYPES = {
  'heikin-ashi': { label: 'Heikin Ashi', needsBoxSize: false, factory: () => new window.OAC.HeikinAshiTransform() },
  renko: { label: 'Renko', needsBoxSize: true, factory: (box) => new window.OAC.RenkoTransform({ boxSize: box }) },
  'range-bars': { label: 'Range Bars', needsBoxSize: true, factory: (box) => new window.OAC.RangeBarsTransform({ range: box }) },
  'line-break': { label: 'Line Break', needsBoxSize: false, factory: () => new window.OAC.LineBreakTransform({ lines: 3 }) },
};

/** True when `type` is a bar-transform pattern (Renko etc.), not a plain SeriesType. */
function isTransformSeriesType(type) {
  return Boolean(TRANSFORM_SERIES_TYPES[type]);
}

/**
 * Real OHLCV bars -> whatever the active series type actually wants. Shared by the main chart
 * (via renderChartSeries() below) and every independently-typed CE/PE pane (see
 * setPaneSeriesType()/renderPaneSeries() in dashboard-chart-panes.js) - one implementation, two
 * targets, so a fix here (or a fifth transform type later) never needs a parallel edit.
 * Returns the transform instance used (null for a plain type) so a caller that wants live
 * incremental updates (only the main chart does - CE/PE panes are rebuilt from scratch on every
 * refresh, never live-ticked) can hold onto it.
 */
function computeSeriesBars(candles, type, boxSize) {
  const bars = (candles || []).map((c) => ({
    time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
  const transformDef = TRANSFORM_SERIES_TYPES[type];
  if (!transformDef || !window.OAC?.runTransform) {
    return { bars, transform: null };
  }
  const transform = transformDef.factory(boxSize);
  return { bars: window.OAC.runTransform(transform, bars), transform };
}

Object.assign(DashboardApp.prototype, {
  isTransformSeriesType,
  computeSeriesBars,

  chartTypeState() {
    if (!this._chartType) {
      this._chartType = { type: 'candlestick', boxSize: null, transform: null };
    }
    return this._chartType;
  },

  loadChartTypePref() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('chart-series-type') || '{}'); } catch (_) { /* corrupt */ }
    const s = this.chartTypeState();
    const known = PLAIN_SERIES_TYPES.some((t) => t.type === saved.type) || TRANSFORM_SERIES_TYPES[saved.type];
    s.type = known ? saved.type : 'candlestick';
    s.boxSize = Number.isFinite(saved.boxSize) && saved.boxSize > 0 ? saved.boxSize : null;
  },

  saveChartTypePref() {
    const s = this.chartTypeState();
    try {
      localStorage.setItem('chart-series-type', JSON.stringify({ type: s.type, boxSize: s.boxSize }));
    } catch (_) { /* private mode */ }
  },

  renderChartTypeBar() {
    const host = document.getElementById('chart-type-bar');
    if (!host) return;
    const s = this.chartTypeState();
    const transformDef = TRANSFORM_SERIES_TYPES[s.type];
    const boxSize = s.boxSize ?? (this.chartTickSize ? this.chartTickSize() * 10 : 1);

    host.innerHTML = `
      <span class="chart-toolbar-label">Series</span>
      ${PLAIN_SERIES_TYPES.map((t) => `
        <button type="button" class="chart-ind-btn ${s.type === t.type ? 'active' : ''}" data-charttype="${t.type}">
          ${t.label}
        </button>`).join('')}
      <span class="chart-toolbar-label">Patterns</span>
      ${Object.entries(TRANSFORM_SERIES_TYPES).map(([type, def]) => `
        <button type="button" class="chart-ind-btn ${s.type === type ? 'active' : ''}" data-charttype="${type}">
          ${def.label}
        </button>`).join('')}
      ${transformDef?.needsBoxSize ? `
        <label class="chart-lots">
          <span>Box size</span>
          <input id="chart-type-box-size" type="number" class="form-input chart-qty-input"
                 value="${boxSize}" min="0.01" step="0.01" />
        </label>` : ''}
    `;

    host.querySelectorAll('[data-charttype]').forEach((btn) => {
      btn.addEventListener('click', () => this.setChartSeriesType(btn.dataset.charttype));
    });
    const boxInput = document.getElementById('chart-type-box-size');
    boxInput?.addEventListener('change', () => {
      const v = parseFloat(boxInput.value);
      if (Number.isFinite(v) && v > 0) {
        s.boxSize = v;
        this.saveChartTypePref();
        this.renderChartSeries();
      }
    });
  },

  /** Swap the price series to a new type/pattern and redraw from the currently loaded history. */
  setChartSeriesType(type) {
    if (!this.chart) return;
    const s = this.chartTypeState();
    s.type = type;
    this.saveChartTypePref();
    try { this.candleSeries?.remove(); } catch (_) { /* disposed */ }
    // Transform types (Renko etc.) render through the plain candlestick renderer - only the DATA
    // feeding it differs, not the series type itself.
    this.candleSeries = this.chart.addSeries(isTransformSeriesType(type) ? 'candlestick' : type);
    this.renderChartSeries();
    this.renderChartTypeBar();
    if (typeof this.restoreChartView === 'function') this.restoreChartView();
  },

  /**
   * Central place that turns `this.chartCandles` (real OHLCV) into whatever the active series
   * type actually wants, and pushes it in. Called after every history load AND on every type
   * switch - loadChartData() no longer calls candleSeries.setData() directly for this reason.
   */
  renderChartSeries() {
    if (!this.candleSeries) return;
    const s = this.chartTypeState();
    const box = s.boxSize ?? (this.chartTickSize ? this.chartTickSize() * 10 : 1);
    const { bars, transform } = computeSeriesBars(this.chartCandles, s.type, box);
    s.transform = transform;
    this.candleSeries.setData(bars.map((b) => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
  },

  /**
   * Feed one just-CLOSED real bar into the active transform, if any, and paint whatever new
   * derived elements it produces. Called from applyChartQuote in dashboard-chart-live.js right
   * as a bar closes - never per-tick, since Renko/Range Bars/Line Break are built from discrete
   * completed price movements, not intrabar noise; the forming bar is intentionally left out
   * until it closes.
   */
  feedChartTransformOnClose(closedBar) {
    const s = this.chartTypeState();
    if (!s.transform || !this.candleSeries) return;
    try {
      const elements = s.transform.push({
        time: closedBar.ts, open: closedBar.open, high: closedBar.high,
        low: closedBar.low, close: closedBar.close, volume: closedBar.volume,
      });
      for (const el of elements) {
        this.candleSeries.update({ time: el.time, open: el.open, high: el.high, low: el.low, close: el.close });
      }
    } catch (_) { /* series disposed */ }
  },
});
