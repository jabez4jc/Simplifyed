import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The indicator config decides what settings the engine's `chart.addIndicator` is called with. A
 * bad value here is silent - an out-of-range length yields an empty series, so the indicator
 * simply does not appear and looks like it was never switched on. The bounds are therefore
 * pinned.
 *
 * These are browser modules that assign onto DashboardApp.prototype, so they are evaluated
 * against a stub rather than imported. `window.OAC` stands in for the real openalgo-charts
 * bridge - `getIndicator` returns full descriptor objects (with a real `inputs` array, the same
 * shape `hasIndicator`/`indicatorDefaults`/`indicatorStyleInputs` all key off in the real
 * library), not bare strings, because dashboard-chart-panes.js now reads `descriptor.inputs`
 * directly (for labels, the settings panel, and validation bounds) rather than a flat settings
 * object - a mock returning something shallower would hide exactly the kind of mismatch this
 * suite exists to catch (see the RSI/MACD field names below, taken from the real descriptors).
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (file) => fs.readFileSync(path.join(dir, '../../public/js', file), 'utf8');

const DESCRIPTORS = {
  sma: {
    id: 'sma',
    inputs: [
      { key: 'length', type: 'number', label: 'Length', default: 20, min: 1, max: 1000, step: 1 },
      { key: 'source', type: 'source', label: 'Source', default: 'close' },
      { key: 'color', type: 'color', label: 'Color', default: '#4f8cff' },
    ],
  },
  ema: {
    id: 'ema',
    inputs: [
      { key: 'length', type: 'number', label: 'Length', default: 20, min: 1, max: 1000, step: 1 },
      { key: 'source', type: 'source', label: 'Source', default: 'close' },
      { key: 'color', type: 'color', label: 'Color', default: '#f5a623' },
    ],
  },
  vwap: {
    id: 'vwap',
    inputs: [
      { key: 'anchor', type: 'select', label: 'Anchor', default: 'session', options: [
        { label: 'Session (IST day)', value: 'session' }, { label: 'Continuous', value: 'continuous' },
      ] },
      { key: 'source', type: 'source', label: 'Source', default: 'hlc3' },
      { key: 'color', type: 'color', label: 'Color', default: '#26c6da' },
    ],
  },
  rsi: {
    id: 'rsi',
    inputs: [
      { key: 'length', type: 'number', label: 'Length', default: 14, min: 1, max: 500, step: 1 },
      { key: 'source', type: 'source', label: 'Source', default: 'close' },
      { key: 'color', type: 'color', label: 'Color', default: '#e0b020' },
      { key: 'overbought', type: 'number', label: 'Overbought', default: 70, min: 50, max: 100, step: 1 },
      { key: 'oversold', type: 'number', label: 'Oversold', default: 30, min: 0, max: 50, step: 1 },
    ],
  },
  macd: {
    id: 'macd',
    inputs: [
      { key: 'fastPeriod', type: 'number', label: 'Fast', default: 12, min: 1, max: 500, step: 1 },
      { key: 'slowPeriod', type: 'number', label: 'Slow', default: 26, min: 1, max: 500, step: 1 },
      { key: 'signalPeriod', type: 'number', label: 'Signal', default: 9, min: 1, max: 500, step: 1 },
      { key: 'source', type: 'source', label: 'Source', default: 'close' },
      { key: 'macdColor', type: 'color', label: 'MACD', default: '#2962ff' },
      { key: 'signalColor', type: 'color', label: 'Signal', default: '#ff6d00' },
    ],
  },
};

function freshApp() {
  const store = {};
  const sandbox = {
    DashboardApp: function DashboardApp() {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      documentElement: {},
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Utils: { escapeHTML: (s) => String(s), showToast: () => {} },
    window: {
      ChartPatterns: { PATTERNS: [
        { id: 'hammer', label: 'Hammer', bullish: true },
        { id: 'shootingStar', label: 'Shooting Star', bullish: false },
        { id: 'doji', label: 'Doji', bullish: null },
      ] },
      OAC: {
        hasIndicator: (id) => id in DESCRIPTORS,
        getIndicator: (id) => DESCRIPTORS[id],
        indicatorDefaults: (descriptor) => Object.fromEntries(descriptor.inputs.map((i) => [i.key, i.default])),
        // No style inputs in this mock (opacity/thickness/line-style/plot-type) - covered by the
        // real library's own contract, not this app's logic, and every id here already has at
        // least one 'color' input so the dedup-by-key path in indicatorInputsFor is exercised.
        indicatorStyleInputs: () => [],
      },
    },
  };
  const keys = Object.keys(sandbox);
  new Function(...keys, load('dashboard-chart-panes.js'))(...keys.map((k) => sandbox[k]));
  new Function(...keys, load('dashboard-chart-sync.js'))(...keys.map((k) => sandbox[k]));
  return { app: new sandbox.DashboardApp(), store };
}

test('defaults include two SMAs, three EMAs, VWAP and both oscillators', () => {
  const { app } = freshApp();
  const cfg = app.indicatorConfig();
  assert.deepStrictEqual(
    Object.keys(cfg),
    [
      'sma1', 'sma2', 'ema1', 'ema2', 'ema3', 'vwap', 'rsi', 'macd',
      'wma1', 'bollinger1', 'stochastic1', 'adx1', 'atr1', 'cci1', 'mfi1', 'obv1', 'adl1',
      'volume1', 'supertrend1', 'parabolicsar1', 'ichimoku1', 'vixfix1',
    ]
  );
  const defaultsOf = (id) => Object.fromEntries(DESCRIPTORS[id].inputs.map((i) => [i.key, i.default]));
  assert.deepStrictEqual(cfg.rsi.settings, defaultsOf('rsi'));
  assert.deepStrictEqual(cfg.macd.settings, defaultsOf('macd'));
  assert.strictEqual(cfg.sma1.settings.length, 20);
  assert.strictEqual(cfg.sma2.settings.length, 50);
  assert.strictEqual(cfg.ema1.settings.length, 9);
  assert.strictEqual(cfg.ema2.settings.length, 21);
  assert.strictEqual(cfg.ema3.settings.length, 50);
});

test('RSI and MACD can be on at the same time', () => {
  // The regression this guards: oscillators used to be mutually exclusive, so enabling MACD
  // silently switched RSI off.
  const { app } = freshApp();
  app.renderIndicatorBar = () => {};
  app.ensureIndicators = () => {};
  app.toggleIndicator('rsi');
  app.toggleIndicator('macd');
  assert.strictEqual(app.indicatorConfig().rsi.on, true);
  assert.strictEqual(app.indicatorConfig().macd.on, true);
});

test('out-of-range lengths are rejected and leave the previous value intact', () => {
  // Bounds come from the descriptor's own min/max (1..1000 for sma's length), not a guessed
  // table - 1 is the descriptor's actual floor, so it is a valid value, not a rejected one.
  const { app } = freshApp();
  for (const bad of [0, -5, 1001, 'abc', '']) {
    assert.strictEqual(app.setIndicatorParam('sma1', 'length', bad), false, `${bad} must be rejected`);
  }
  assert.strictEqual(app.indicatorConfig().sma1.settings.length, 20);
  assert.strictEqual(app.setIndicatorParam('sma1', 'length', 1), true, 'the descriptor\'s own floor is valid');
  assert.strictEqual(app.setIndicatorParam('sma1', 'length', 200), true);
  assert.strictEqual(app.indicatorConfig().sma1.settings.length, 200);
});

test('MACD refuses fastPeriod >= slowPeriod', () => {
  // A MACD with fast >= slow draws a plausible-looking line that means nothing.
  const { app } = freshApp();
  assert.strictEqual(app.setIndicatorParam('macd', 'fastPeriod', 26), false);
  assert.strictEqual(app.setIndicatorParam('macd', 'fastPeriod', 30), false);
  assert.strictEqual(app.setIndicatorParam('macd', 'slowPeriod', 12), false);
  assert.strictEqual(app.setIndicatorParam('macd', 'fastPeriod', 8), true);
  assert.strictEqual(app.indicatorConfig().macd.settings.fastPeriod, 8);
  assert.strictEqual(app.indicatorConfig().macd.settings.slowPeriod, 26);
});

test('unknown indicators and settings keys are ignored rather than creating entries', () => {
  const { app } = freshApp();
  assert.strictEqual(app.setIndicatorParam('nope', 'length', 10), false);
  assert.strictEqual(app.setIndicatorParam('rsi', 'fastPeriod', 10), false);
  assert.strictEqual(app.indicatorConfig().nope, undefined);
  assert.strictEqual(app.indicatorConfig().rsi.settings.fastPeriod, undefined);
});

test('saved config survives a reload and merges over new defaults', () => {
  const { app, store } = freshApp();
  app.setIndicatorParam('rsi', 'length', 21);

  // Simulate a release that adds an indicator: the saved blob predates ema3.
  const saved = JSON.parse(store['chart-indicator-config']);
  delete saved.ema3;
  const reopened = freshApp();
  reopened.store['chart-indicator-config'] = JSON.stringify(saved);
  const cfg = reopened.app.indicatorConfig();

  assert.strictEqual(cfg.rsi.settings.length, 21, 'user value must persist');
  assert.strictEqual(cfg.ema3.settings.length, 50, 'a newly added indicator falls back to its default');
});

test('labels reflect the configured lengths, drawn from the descriptor\'s own numeric inputs', () => {
  const { app } = freshApp();
  app.setIndicatorParam('ema1', 'length', 34);
  app.setIndicatorParam('rsi', 'oversold', 25);
  // Real INDICATOR_DEFS entries, not hand-built stubs - indicatorLabel reads `indicatorId` to
  // look up the descriptor's own inputs, which a stub missing that field would hide.
  const defs = {
    ema1: { id: 'ema1', indicatorId: 'ema', label: 'EMA' },
    macd: { id: 'macd', indicatorId: 'macd', label: 'MACD' },
    vwap: { id: 'vwap', indicatorId: 'vwap', label: 'VWAP' },
    rsi: { id: 'rsi', indicatorId: 'rsi', label: 'RSI' },
  };
  assert.strictEqual(app.indicatorLabel(defs.ema1), 'EMA 34');
  assert.strictEqual(app.indicatorLabel(defs.macd), 'MACD 12/26/9');
  assert.strictEqual(app.indicatorLabel(defs.vwap), 'VWAP');
  assert.strictEqual(app.indicatorLabel(defs.rsi), 'RSI 14/70/25');
});

test('RSI refuses an oversold level at or above the overbought level', () => {
  // Inverted bands shade the wrong regions and read as a permanently overbought instrument.
  const { app } = freshApp();
  assert.strictEqual(app.setIndicatorParam('rsi', 'oversold', 70), false, 'equal is not ordered');
  assert.strictEqual(app.setIndicatorParam('rsi', 'oversold', 85), false);
  assert.strictEqual(app.setIndicatorParam('rsi', 'overbought', 30), false);
  assert.strictEqual(app.setIndicatorParam('rsi', 'overbought', 80), true);
  assert.strictEqual(app.setIndicatorParam('rsi', 'oversold', 20), true);
  assert.strictEqual(app.indicatorConfig().rsi.settings.overbought, 80);
  assert.strictEqual(app.indicatorConfig().rsi.settings.oversold, 20);

  // The descriptor's own bounds (50..100 for overbought, 0..50 for oversold) allow the extremes
  // of the RSI's own range - 100 and 0 are valid, only actually out-of-range values are rejected.
  assert.strictEqual(app.setIndicatorParam('rsi', 'overbought', 100), true);
  assert.strictEqual(app.setIndicatorParam('rsi', 'oversold', 0), true);
  assert.strictEqual(app.setIndicatorParam('rsi', 'overbought', 101), false);
  assert.strictEqual(app.setIndicatorParam('rsi', 'oversold', -1), false);
});

test('pattern defaults follow each pattern\'s direction and persist', () => {
  const { app, store } = freshApp();
  const cfg = app.patternConfig();

  assert.strictEqual(cfg.hammer.position, 'belowBar', 'bullish patterns mark below the bar');
  assert.strictEqual(cfg.shootingStar.position, 'aboveBar', 'bearish patterns mark above it');
  assert.strictEqual(cfg.doji.position, 'aboveBar', 'a neutral pattern still needs a placement');
  assert.deepStrictEqual(app.enabledPatterns(), [], 'nothing is drawn until it is asked for');

  cfg.hammer.on = true;
  cfg.doji.on = true;
  cfg.doji.colour = '#123456';
  app.savePatternConfig();
  assert.deepStrictEqual(app.enabledPatterns(), ['hammer', 'doji']);

  const reopened = freshApp();
  reopened.store['chart-patterns'] = store['chart-patterns'];
  assert.deepStrictEqual(reopened.app.enabledPatterns(), ['hammer', 'doji']);
  assert.strictEqual(reopened.app.patternConfig().doji.colour, '#123456');
});

test('sync defaults to all four on, and each toggles independently', () => {
  const { app } = freshApp();
  app.renderSyncBar = () => {};
  app.syncCharts = () => {};
  assert.deepStrictEqual(app.chartSyncConfig(),
    { interval: true, crosshair: true, time: true, range: true, pan: false });

  app.toggleChartSync('crosshair');
  assert.strictEqual(app.chartSyncConfig().crosshair, false);
  assert.strictEqual(app.chartSyncConfig().time, true, 'toggles must not affect each other');

  app.toggleChartSync('bogus');
  assert.strictEqual(app.chartSyncConfig().bogus, undefined);
});

test('paneTimeframe follows the toolbar only while Interval sync is on', () => {
  const { app } = freshApp();
  app.renderSyncBar = () => {};
  app.syncCharts = () => {};
  app.refreshOptionPanes = () => {};
  app.chartState = { timeframe: '15m' };

  assert.strictEqual(app.paneTimeframe('ce'), '15m');

  app.toggleChartSync('interval');
  app.setPaneTimeframe('ce', '1m');
  assert.strictEqual(app.paneTimeframe('ce'), '1m');
  assert.strictEqual(app.paneTimeframe('pe'), '15m', 'an unset pane still falls back to the toolbar');

  // Turning sync back on must re-slave both panes, not keep the override.
  app.toggleChartSync('interval');
  assert.strictEqual(app.paneTimeframe('ce'), '15m');
});
