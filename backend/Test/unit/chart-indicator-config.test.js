import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The chart owns its studies (openalgo-charts' design); this app persists what is on each chart
 * and puts it back on a rebuilt one. A study lost here is silent - it simply is not there after a
 * reload - so the round trip, the pre-2.6 migration and the pending list are pinned.
 *
 * These are browser modules that assign onto DashboardApp.prototype, so they are evaluated
 * against a stub rather than imported. `window.OAC` stands in for the real openalgo-charts
 * bridge, with full descriptor objects (a real `inputs` array) since the chip labels read them.
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

/** A chart double with the slice of the engine's study API the persistence layer calls. */
function fakeChart({ refuse = [] } = {}) {
  const studies = [];
  let n = 0;
  return {
    isDestroyed: false,
    indicators: () => studies.slice(),
    addIndicator(indicatorId, settings = {}, options = {}) {
      if (refuse.includes(indicatorId)) throw new Error('OS6010: the study needs bars');
      let shown = true;
      const inst = {
        id: options.instanceId || `ind-${++n}`, indicatorId, name: indicatorId.toUpperCase(),
        settings: () => ({ ...settings }), visible: () => shown, setVisible: (v) => { shown = v; },
      };
      studies.push(inst);
      return inst;
    },
    removeIndicator(id) { const at = studies.findIndex((s) => s.id === id); if (at >= 0) studies.splice(at, 1); },
    on() {},
  };
}

test('a pre-2.6 slot config migrates to one study per switched-on slot', () => {
  const { app, store } = freshApp();
  store['chart-indicator-config'] = JSON.stringify({
    sma1: { on: true, settings: { length: 20 } },
    ema2: { on: true, settings: { length: 21 } },
    rsi: { on: false, settings: { length: 14 } },
    'oscript-mine': { on: true, settings: {} },
  });
  assert.deepStrictEqual(app.savedIndicators(), [
    { indicatorId: 'sma', settings: { length: 20 }, visible: true },
    { indicatorId: 'ema', settings: { length: 21 }, visible: true },
    { indicatorId: 'oscript-mine', settings: {}, visible: true },
  ]);
  // A pane migrates from its own key, never from the main chart's.
  assert.deepStrictEqual(app.savedIndicators('ce'), []);
});

test('saved studies come back on a fresh chart, and one that waits for bars is kept, not dropped', () => {
  const { app, store } = freshApp();
  store['chart-indicators'] = JSON.stringify([
    { indicatorId: 'ema', instanceId: 'a', settings: { length: 9 }, visible: true },
    { indicatorId: 'rsi', instanceId: 'b', settings: { length: 21 }, visible: false },
    { indicatorId: 'oscript-wait', settings: {} },
  ]);
  app.chart = fakeChart({ refuse: ['oscript-wait'] });
  app.applyIndicatorsTo(app.chart);

  const live = app.chart.indicators();
  assert.deepStrictEqual(live.map((i) => [i.id, i.indicatorId, i.settings().length]), [['a', 'ema', 9], ['b', 'rsi', 21]]);
  assert.strictEqual(live[1].visible(), false, 'a study hidden from its legend eye stays hidden');

  app.saveIndicators();
  const saved = JSON.parse(store['chart-indicators']);
  assert.deepStrictEqual(saved.map((s) => s.indicatorId), ['ema', 'rsi', 'oscript-wait']);

  // The same chart again (a symbol switch keeps it): nothing is added twice.
  app.applyIndicatorsTo(app.chart);
  assert.strictEqual(app.chart.indicators().length, 2);
});

test('copying to an option chart replaces its studies with the main chart\'s, settings included', () => {
  const { app, store } = freshApp();
  app.chart = fakeChart();
  app.applyIndicatorsTo(app.chart);
  app.chart.addIndicator('rsi', { length: 9 });
  app.optionPanes = { ce: { chart: fakeChart() } };
  app.applyIndicatorsTo(app.optionPanes.ce.chart);
  app.optionPanes.ce.chart.addIndicator('macd');

  app.copyMainIndicatorsTo(['ce']);
  const ce = app.optionPanes.ce.chart.indicators();
  assert.deepStrictEqual(ce.map((i) => [i.indicatorId, i.settings().length]), [['rsi', 9]]);
  assert.deepStrictEqual(JSON.parse(store['chart-indicators-ce']).map((s) => s.indicatorId), ['rsi']);
});

test('a chip names the study with its numeric inputs, from the descriptor', () => {
  const { app } = freshApp();
  const inst = (indicatorId, settings) => ({ indicatorId, name: indicatorId.toUpperCase(), settings: () => settings });
  assert.strictEqual(app.indicatorLabel(inst('ema', { length: 34, source: 'close' })), 'EMA 34');
  assert.strictEqual(app.indicatorLabel(inst('macd', { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 })), 'MACD 12/26/9');
  assert.strictEqual(app.indicatorLabel(inst('vwap', { anchor: 'session' })), 'VWAP');
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

test('sync defaults to all three on, each toggles independently, and old saved blobs still load', () => {
  const { app } = freshApp();
  app.renderSyncBar = () => {};
  app.syncCharts = () => {};
  assert.deepStrictEqual(app.chartSyncConfig(), { interval: true, crosshair: true, viewport: true });

  app.toggleChartSync('crosshair');
  assert.strictEqual(app.chartSyncConfig().crosshair, false);
  assert.strictEqual(app.chartSyncConfig().viewport, true, 'toggles must not affect each other');

  app.toggleChartSync('bogus');
  assert.strictEqual(app.chartSyncConfig().bogus, undefined);

  // A preference saved before the link group (time/range/pan) keeps its crosshair choice.
  const { app: old, store } = freshApp();
  store['chart-sync'] = JSON.stringify({ interval: true, crosshair: false, time: true, range: true, pan: false });
  assert.deepStrictEqual(old.chartSyncConfig(), { interval: true, crosshair: false, viewport: true });
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
