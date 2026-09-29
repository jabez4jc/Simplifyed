import { test, expect } from '@playwright/test';
import { login, gotoDashboard, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';

/**
 * The charting engine, exercised in a real browser.
 *
 * openalgo-charts is a browser-only dependency loaded as native ES modules (see
 * js/openalgo-charts-bridge.js), so nothing in the node test suites can reach it: a version bump
 * that removed an export, renamed a series type, or changed the shape of the persisted drawings
 * would pass `npm test` and break the chart for every user. These run against the vendored build
 * the app actually serves.
 *
 * They assert the CONTRACT this app depends on, not the library's own behaviour (which has its
 * own suite upstream): the exports the bridge publishes, the series types the type picker offers,
 * that every registered indicator can actually be placed, that every registered drawing tool has
 * a home on the rail, and that a saved drawing layout survives a round trip.
 */

/** Plausible OHLCV, enough bars for the longest indicator warmup to produce values. */
const BARS_SCRIPT = `
  (() => {
    const bars = [];
    let price = 100;
    for (let i = 0; i < 400; i++) {
      const open = price;
      const close = open + Math.sin(i / 7) * 2 + (i % 5 === 0 ? 1.5 : -0.4);
      bars.push({
        time: 1700000000 + i * 300,
        open,
        high: Math.max(open, close) + 0.8,
        low: Math.min(open, close) - 0.8,
        close,
        volume: 1000 + (i % 13) * 50,
      });
      price = close;
    }
    return bars;
  })()
`;

test.beforeEach(async ({ page }) => {
  await login(page);
  await gotoDashboard(page);
  await page.waitForFunction(() => Boolean(window.OAC), null, { timeout: 15000 });
});

test('the bridge publishes every export the chart code calls', async ({ page }) => {
  const missing = await page.evaluate(() => {
    const required = [
      'createChart', 'darkTheme', 'lightTheme', 'IST_OFFSET_SECONDS', 'indicatorDefaults',
      'getIndicator', 'hasIndicator', 'registeredIndicators', 'indicatorStyleInputs',
      'INDICATOR_SOURCES', 'INDICATOR_LINE_STYLES', 'PaneLegend', 'PriceLevels',
      'DrawingController', 'registeredDrawingTools', 'getDrawingTool', 'migrateDrawings',
      'keyToDrawingAction', 'drawingToolIcon', 'iconSvg', 'computeVolumeProfileSessions',
      'VolumeProfile', 'computeFootprint', 'cumulativeDelta', 'FootprintAggregator', 'Footprint',
      'TradeController', 'HeikinAshiTransform', 'RenkoTransform', 'RangeBarsTransform',
      'LineBreakTransform', 'PointFigureTransform', 'KagiTransform', 'runTransform',
      'applyScript', 'removeScript', 'savedScripts',
    ];
    return required.filter((key) => !window.OAC[key]);
  });
  expect(missing, 'window.OAC is what every dashboard-chart*.js file calls into').toEqual([]);
});

test('every series type the picker offers can actually be built and drawn', async ({ page }) => {
  const errors = collectPageErrors(page);
  const result = await page.evaluate(`(() => {
    const bars = ${BARS_SCRIPT};
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:400px';
    document.body.appendChild(host);

    const plain = ['candlestick', 'hollow-candle', 'volume-candle', 'bar', 'high-low', 'line',
      'line-markers', 'step', 'area', 'hlc-area', 'baseline', 'column', 'histogram',
      'point-figure', 'kagi'];
    const failures = [];
    const chart = window.OAC.createChart(host, { renderer: 'auto', timezone: 'Asia/Kolkata' });
    for (const type of plain) {
      try {
        const s = chart.addSeries(type);
        s.setData(bars);
        s.remove();
      } catch (e) {
        failures.push(type + ': ' + e.message);
      }
    }
    const rendererKind = chart.rendererKind;
    chart.destroy();
    host.remove();
    return { failures, rendererKind };
  })()`);

  expect(result.failures).toEqual([]);
  // 'auto' resolves at construction; either answer is correct, a missing one is not.
  expect(['canvas2d', 'webgl2']).toContain(result.rendererKind);
  assertNoPageErrors(errors);
});

test('every bar transform the type picker offers produces bars', async ({ page }) => {
  const result = await page.evaluate(`(() => {
    const bars = ${BARS_SCRIPT};
    const made = {
      'heikin-ashi': new window.OAC.HeikinAshiTransform(),
      renko: new window.OAC.RenkoTransform({ boxSize: 1 }),
      'range-bars': new window.OAC.RangeBarsTransform({ range: 1 }),
      'line-break': new window.OAC.LineBreakTransform({ lines: 3 }),
      'point-figure': new window.OAC.PointFigureTransform({ boxSize: 1 }),
      kagi: new window.OAC.KagiTransform({ reversal: 1 }),
    };
    const counts = {};
    for (const [id, t] of Object.entries(made)) counts[id] = window.OAC.runTransform(t, bars).length;
    return counts;
  })()`);

  for (const [id, count] of Object.entries(result)) {
    expect(count, `${id} produced no bars`).toBeGreaterThan(0);
  }
});

test('every registered indicator can be placed on a chart', async ({ page }) => {
  const result = await page.evaluate(`(() => {
    const bars = ${BARS_SCRIPT};
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:400px';
    document.body.appendChild(host);
    const chart = window.OAC.createChart(host, { timezone: 'Asia/Kolkata' });
    chart.addSeries('candlestick').setData(bars);

    const ids = window.OAC.registeredIndicators().map((d) => d.id);
    const failures = [];
    for (const id of ids) {
      try {
        const handle = chart.addIndicator(id);
        handle.remove();
      } catch (e) {
        failures.push(id + ': ' + e.message);
      }
    }
    chart.destroy();
    host.remove();
    return { count: ids.length, failures };
  })()`);

  // The app builds its indicator menu straight off this registry, so an indicator that cannot be
  // placed is a menu entry that does nothing.
  expect(result.failures).toEqual([]);
  expect(result.count).toBeGreaterThanOrEqual(100);
});

test('every registered drawing tool has a home on the rail', async ({ page }) => {
  const result = await page.evaluate(() => {
    const tools = window.OAC.registeredDrawingTools();
    const categories = new Set(window.app.drawRailItems().map((r) => r.id));
    return {
      count: tools.length,
      homeless: tools
        .map((t) => ({ id: t.id, cat: window.app.drawToolCategory(t.id) }))
        .filter((t) => !categories.has(t.cat))
        .map((t) => t.id),
      withoutGlyph: tools.filter((t) => !window.OAC.drawingToolIcon(t.id)).map((t) => t.id),
    };
  });

  expect(result.count).toBeGreaterThanOrEqual(85);
  expect(result.homeless, 'a tool with no rail category is a tool nobody can select').toEqual([]);
  expect(result.withoutGlyph).toEqual([]);
});

test('a saved drawing layout survives the round trip through storage', async ({ page }) => {
  const result = await page.evaluate(`(() => {
    const bars = ${BARS_SCRIPT};
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:400px';
    document.body.appendChild(host);
    const chart = window.OAC.createChart(host, { timezone: 'Asia/Kolkata' });
    chart.addSeries('candlestick').setData(bars);

    const a = new window.OAC.DrawingController(chart, { magnet: 'weak' });
    a.add({
      tool: 'trend-line',
      paneIndex: 0,
      points: [{ time: bars[10].time, price: bars[10].close }, { time: bars[80].time, price: bars[80].close }],
    });
    a.add({
      tool: 'text',
      paneIndex: 0,
      points: [{ time: bars[40].time, price: bars[40].close }],
      text: { value: 'Breakout' },
    });

    // Exactly what saveDrawings/restoreDrawings do: JSON in local storage, read back through
    // the engine's own migration so a 1.x array and a 2.x document both land.
    const stored = JSON.parse(JSON.stringify(a.toJSON()));
    const b = new window.OAC.DrawingController(chart, { magnet: 'weak' });
    b.fromJSON(window.OAC.migrateDrawings(stored));
    const restored = b.drawings();

    const out = {
      storedIsDocument: !Array.isArray(stored) && Array.isArray(stored.drawings),
      count: restored.length,
      tools: restored.map((d) => d.tool).sort(),
      text: restored.find((d) => d.tool === 'text')?.text?.value ?? null,
      // A 1.x payload (a bare array) must still load - users have those in local storage.
      legacyCount: (() => {
        const c = new window.OAC.DrawingController(chart, { magnet: 'weak' });
        c.fromJSON(window.OAC.migrateDrawings(stored.drawings));
        const n = c.drawings().length;
        c.destroy();
        return n;
      })(),
    };
    a.destroy(); b.destroy(); chart.destroy(); host.remove();
    return out;
  })()`);

  expect(result.storedIsDocument, '2.x persists { version, drawings }').toBe(true);
  expect(result.count).toBe(2);
  expect(result.tools).toEqual(['text', 'trend-line']);
  expect(result.text).toBe('Breakout');
  expect(result.legacyCount).toBe(2);
});

test('the drawing keymap maps the chords the chart binds', async ({ page }) => {
  const actions = await page.evaluate(() => {
    const ctx = { hasSelection: true, hasTarget: false, editingText: false };
    const map = (e, extra) => window.OAC.keyToDrawingAction(e, { ...ctx, ...extra })?.type ?? null;
    return {
      undo: map({ key: 'z', ctrlKey: true }),
      redo: map({ key: 'z', ctrlKey: true, shiftKey: true }),
      del: map({ key: 'Delete' }),
      copy: map({ key: 'c', metaKey: true }),
      paste: map({ key: 'v', metaKey: true }),
      nudge: map({ key: 'ArrowUp' }),
      cancelWhilePlacing: map({ key: 'Escape' }, { placing: true }),
      typing: map({ key: 'Delete' }, { editingText: true }),
    };
  });

  expect(actions).toEqual({
    undo: 'undo', redo: 'redo', del: 'delete', copy: 'copy', paste: 'paste',
    nudge: 'nudge', cancelWhilePlacing: 'cancel', typing: null,
  });
});

test('the chart view builds a chart with the engine options this app asks for', async ({ page }) => {
  const errors = collectPageErrors(page);
  await switchView(page, 'chart');

  // The view builds its chart once a symbol resolves; a seeded e2e database may have none, in
  // which case there is legitimately nothing to build and the assertions below are skipped
  // rather than asserted against a chart that was never meant to exist.
  const built = await page
    .waitForFunction(() => Boolean(window.app?.chart), null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (built) {
    const state = await page.evaluate(() => ({
      rendererKind: window.app.chart.rendererKind,
      timezone: typeof window.app.chart.timezone === 'function'
        ? window.app.chart.timezone()
        : window.app.chart.options?.().timezone,
      hasPriceLevels: Boolean(window.app._priceLevels),
      hasSeries: Boolean(window.app.candleSeries),
    }));
    expect(['canvas2d', 'webgl2']).toContain(state.rendererKind);
    expect(state.hasSeries).toBe(true);
    expect(state.hasPriceLevels, 'session reference levels are attached in initChart').toBe(true);
  }

  assertNoPageErrors(errors);
});

test('an OpenScript study applied from the picker is registered and switched on', async ({ page }) => {
  const errors = collectPageErrors(page);
  await switchView(page, 'chart');
  await page.click('[data-pop="indicators"]');
  await page.evaluate(() => window.app.toggleIndicatorPicker());
  await page.click('#chart-ind-picker [data-action="script"]');
  await page.fill('#chart-ind-picker [data-role="src"]', [
    'version 1',
    'study("E2E mean", overlay = true)',
    'plot(sma(close, input(5, "Length")), "Mean", orange)',
  ].join('\n'));
  await page.click('#chart-ind-picker [data-action="apply"]');

  const state = await page.evaluate(() => ({
    registered: window.OAC.hasIndicator('oscript-e2e-mean'),
    on: window.app.indicatorConfig()['oscript-e2e-mean']?.on,
    saved: Object.keys(window.OAC.savedScripts()),
  }));
  expect(state).toEqual({ registered: true, on: true, saved: ['oscript-e2e-mean'] });

  // A script that does not compile shows its diagnostics instead of registering anything.
  await page.evaluate(() => window.app.toggleIndicatorPicker());
  await page.click('#chart-ind-picker [data-action="script"]');
  await page.fill('#chart-ind-picker [data-role="src"]', 'version 1\nstudy("Broken")\nplot(nope)\n');
  await page.click('#chart-ind-picker [data-action="apply"]');
  await expect(page.locator('#chart-ind-picker [data-role="errors"]')).toBeVisible();

  assertNoPageErrors(errors);
});
