/**
 * Chart / series type picker - openalgo-charts' `SeriesType` union (plain display variants) plus
 * the six transforms its `transform` tier registers (Heikin Ashi, Renko, range bars, line break,
 * point and figure, Kagi).
 *
 * Since openalgo-charts 2.6.0 the chart applies a transform itself (`chart.setSeriesTransform`):
 * the series keeps taking the real OHLCV bars through `setData`/`update`, and the chart forms the
 * elements - the newest one again on every tick - so a live Renko chart always equals the batch
 * transform of its bars. That replaced a hand-run `runTransform` here that only ever saw closed
 * bars. Both calls below keep the series HANDLE, so the indicators, pattern markers, price lines
 * and trade layer attached to it survive a type switch instead of being orphaned on a removed
 * series.
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
  { type: 'column', label: 'Columns' },
  { type: 'histogram', label: 'Histogram' },
];

/**
 * The registered transforms, by the id the chart knows them by. `sizeKey` names the transform's
 * own size option (`SeriesTransformSpec.options`); left unset the chart sizes it from the loaded
 * history (a fortieth of its range, twice that for range bars and Kagi) on every load.
 */
const TRANSFORM_SERIES_TYPES = {
  'heikin-ashi': { label: 'Heikin Ashi' },
  renko: { label: 'Renko', sizeKey: 'boxSize', boxLabel: 'Box size', sizeModes: true },
  'range-bars': { label: 'Range Bars', sizeKey: 'range', boxLabel: 'Range' },
  'line-break': { label: 'Line Break' },
  'point-figure': { label: 'Point & Figure', sizeKey: 'boxSize', boxLabel: 'Box size', sizeModes: true },
  kagi: { label: 'Kagi', sizeKey: 'reversal', boxLabel: 'Reversal' },
};

/**
 * How Renko and point and figure size a box (since openalgo-charts 2.6.1), each with the option the
 * one size input writes: a fixed price, a percent of price, a multiple of ATR(14), or a percent of
 * ATR(14). Left empty, each takes the chart's default (a size from the history, 1%, 1x).
 */
const BOX_SIZE_MODES = {
  fixed: { label: 'Fixed', key: null },
  percent: { label: '% of price', key: 'percent', inputLabel: 'Percent' },
  atr: { label: 'ATR', key: 'atrMultiplier', inputLabel: 'ATR x' },
  atrPercent: { label: '% of ATR', key: 'percent', inputLabel: 'ATR %' },
};

/**
 * Put `type` on `series`: a transform spec for the six transforms, otherwise no transform and the
 * plain renderer. `boxSize` null leaves the transform's size to the chart; `boxMode` applies only
 * to the types with `sizeModes`. Shared by the main chart and each CE/PE pane.
 */
function applySeriesType(chart, series, type, boxSize = null, boxMode = 'fixed') {
  if (!chart || !series) return;
  const def = TRANSFORM_SERIES_TYPES[type];
  if (def) {
    const mode = def.sizeModes && BOX_SIZE_MODES[boxMode] ? boxMode : 'fixed';
    const key = BOX_SIZE_MODES[mode].key || def.sizeKey;
    const options = { ...(mode !== 'fixed' ? { mode } : {}), ...(key && boxSize > 0 ? { [key]: boxSize } : {}) };
    chart.setSeriesTransform(series, { type, options });
    return;
  }
  chart.setSeriesTransform(series, null);
  chart.setSeriesType(series, PLAIN_SERIES_TYPES.some((t) => t.type === type) ? type : 'candlestick');
}

/** The real bars as the series takes them - always OHLCV, whatever the chart draws from them. */
function seriesBars(candles) {
  return (candles || []).map((c) => ({
    time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
}

/**
 * A transform's elements index differently from the bars (several bricks per bar, or one column
 * for many), so a view saved on one does not frame the other - fit instead. Heikin Ashi is one
 * element per bar and keeps the view.
 */
function reframesView(from, to) {
  const moves = (t) => Boolean(TRANSFORM_SERIES_TYPES[t]) && t !== 'heikin-ashi';
  return from !== to && (moves(from) || moves(to));
}

Object.assign(DashboardApp.prototype, {
  applySeriesType,
  seriesBars,

  chartTypeState() {
    if (!this._chartType) this._chartType = { type: 'candlestick', boxSize: null, boxMode: 'fixed' };
    return this._chartType;
  },

  loadChartTypePref() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('chart-series-type') || '{}'); } catch (_) { /* corrupt */ }
    const s = this.chartTypeState();
    const known = PLAIN_SERIES_TYPES.some((t) => t.type === saved.type) || TRANSFORM_SERIES_TYPES[saved.type];
    s.type = known ? saved.type : 'candlestick';
    s.boxSize = Number.isFinite(saved.boxSize) && saved.boxSize > 0 ? saved.boxSize : null;
    s.boxMode = BOX_SIZE_MODES[saved.boxMode] ? saved.boxMode : 'fixed';
  },

  saveChartTypePref() {
    const s = this.chartTypeState();
    try {
      localStorage.setItem('chart-series-type', JSON.stringify({ type: s.type, boxSize: s.boxSize, boxMode: s.boxMode }));
    } catch (_) { /* private mode */ }
  },

  renderChartTypeBar() {
    const host = document.getElementById('chart-type-bar');
    if (!host) return;
    const s = this.chartTypeState();
    const transformDef = TRANSFORM_SERIES_TYPES[s.type];
    const boxMode = transformDef?.sizeModes ? BOX_SIZE_MODES[s.boxMode] : BOX_SIZE_MODES.fixed;

    host.innerHTML = `
      <span class="chart-toolbar-label">Series</span>
      ${PLAIN_SERIES_TYPES.map((t) => `
        <button type="button" class="chart-ind-btn ${s.type === t.type ? 'active' : ''}" data-charttype="${t.type}">
          ${t.label}
        </button>`).join('')}
      <span class="chart-toolbar-label">Transforms</span>
      ${Object.entries(TRANSFORM_SERIES_TYPES).map(([type, def]) => `
        <button type="button" class="chart-ind-btn ${s.type === type ? 'active' : ''}" data-charttype="${type}">
          ${def.label}
        </button>`).join('')}
      ${transformDef?.sizeModes ? `
        <select id="chart-type-box-mode" class="form-input chart-qty-input chart-box-mode" aria-label="Box size from">
          ${Object.entries(BOX_SIZE_MODES).map(([mode, m]) => `
            <option value="${mode}" ${s.boxMode === mode ? 'selected' : ''}>${m.label}</option>`).join('')}
        </select>` : ''}
      ${transformDef?.sizeKey ? `
        <label class="chart-lots" title="Leave empty for the chart's default">
          <span>${boxMode.inputLabel || transformDef.boxLabel}</span>
          <input id="chart-type-box-size" type="number" class="form-input chart-qty-input"
                 value="${s.boxSize ?? ''}" placeholder="Auto" min="0" step="any" />
        </label>` : ''}
    `;

    host.querySelectorAll('[data-charttype]').forEach((btn) => {
      btn.addEventListener('click', () => this.setChartSeriesType(btn.dataset.charttype));
    });
    document.getElementById('chart-type-box-mode')?.addEventListener('change', (e) => {
      // Each mode reads the number differently (a price, a percent, a multiplier) - start it empty.
      s.boxMode = e.target.value;
      s.boxSize = null;
      this.saveChartTypePref();
      this.applyChartSeriesType();
      this.renderChartTypeBar();
    });
    const boxInput = document.getElementById('chart-type-box-size');
    boxInput?.addEventListener('change', () => {
      const v = parseFloat(boxInput.value);
      s.boxSize = Number.isFinite(v) && v > 0 ? v : null;
      this.saveChartTypePref();
      this.applyChartSeriesType();
    });
  },

  /** Put the saved type on the main chart's price series. */
  applyChartSeriesType() {
    const s = this.chartTypeState();
    try {
      applySeriesType(this.chart, this.candleSeries, s.type, s.boxSize, s.boxMode);
    } catch (error) {
      // An option the transform refuses throws before anything changes - say so, keep the chart.
      Utils.showToast(`${TRANSFORM_SERIES_TYPES[s.type]?.label || s.type}: ${error.message}`, 'error');
    }
  },

  /** Switch the price series to a new type or transform, in place. */
  setChartSeriesType(type) {
    if (!this.chart) return;
    const s = this.chartTypeState();
    const from = s.type;
    s.type = type;
    this.saveChartTypePref();
    this.applyChartSeriesType();
    this.renderChartTypeBar();
    if (reframesView(from, type)) this.frameLatestBars(this.chart);
  },

  /** Feed the loaded history to the price series; the chart draws it as the active type. */
  renderChartSeries() {
    if (!this.candleSeries) return;
    this.candleSeries.setData(seriesBars(this.chartCandles));
  },
});
