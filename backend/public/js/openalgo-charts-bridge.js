/**
 * Bridges openalgo-charts (native ES modules) into the classic-script world dashboard-chart*.js
 * lives in. Those files are plain `Object.assign(DashboardApp.prototype, ...)` scripts with no
 * module system - rewriting them as ESM to import the library directly would touch every file in
 * the chart feature, for no benefit over exposing the same handful of exports as one global. A
 * module script's execution is deferred until after the DOM is parsed and always runs before
 * classic `defer` scripts fire (both wait for the same point, but module graphs resolve first),
 * so `window.OAC` is guaranteed populated before any dashboard-chart*.js code that might use it.
 *
 * The `webgl` tier is imported for its side effect only: it registers the WebGL2 backend, which
 * is what lets `createChart({ renderer: 'auto' })` take the GPU path where the device has it and
 * silently stay on canvas2d where it does not. Importing it registers; not importing it would
 * make `'auto'` a no-op.
 */
import {
  createChart, darkTheme, lightTheme, IST_OFFSET_SECONDS, indicatorDefaults, getIndicator, hasIndicator,
  registeredIndicators, indicatorStyleInputs, INDICATOR_SOURCES, INDICATOR_LINE_STYLES, PaneLegend,
  PriceLevels, registerIndicator, VERSION as CHARTS_VERSION,
} from '/vendor/openalgo-charts/openalgo-charts.mjs';
import {
  DiagnosticBag, parse, check, emit, isError, sourceFile, renderDiagnostics,
} from '/vendor/openalgo-script/core/index.js';
import { descriptorFor } from '/vendor/openalgo-script/adapters/charts/index.js';
import { registerBuiltinIndicators } from '/vendor/openalgo-charts/openalgo-charts.indicators.mjs';
import {
  DrawingController, registerBuiltinDrawingTools, registeredDrawingTools, getDrawingTool,
  migrateDrawings, keyToDrawingAction, drawingToolIcon, iconSvg,
} from '/vendor/openalgo-charts/openalgo-charts.draw.mjs';
import {
  computeVolumeProfileSessions, VolumeProfile, computeFootprint, cumulativeDelta,
  FootprintAggregator, Footprint,
} from '/vendor/openalgo-charts/openalgo-charts.profile.mjs';
import { TradeController } from '/vendor/openalgo-charts/openalgo-charts.trade.mjs';
import {
  HeikinAshiTransform, RenkoTransform, RangeBarsTransform, LineBreakTransform,
  PointFigureTransform, KagiTransform, runTransform,
} from '/vendor/openalgo-charts/openalgo-charts.transform.mjs';
import '/vendor/openalgo-charts/openalgo-charts.webgl.mjs';

registerBuiltinIndicators();
registerBuiltinDrawingTools();

/**
 * OpenScript (github.com/marketcalls/openscript): a script compiles to an ordinary indicator
 * descriptor and is registered like a built-in, so the picker, settings panel and saved config in
 * dashboard-chart-panes.js treat it exactly as one - nothing there is special-cased to scripts.
 *
 * The id comes from the study's name rather than the adapter's default source hash, so editing a
 * script replaces it in place and a chart that had it switched on keeps it on. Sources persist in
 * this browser, like the rest of the chart's state, and are re-registered here before `oac:ready`
 * so a saved indicator config never refers to an id the registry has not seen yet.
 *
 * `simulateOrders` lets a `strategy(...)` script draw its entries and exits against the same
 * simulated venue a backtest uses. It places no order anywhere.
 */
const SCRIPT_STORE_KEY = 'openscript-sources';

function readScripts() {
  try { return JSON.parse(localStorage.getItem(SCRIPT_STORE_KEY) || '{}'); } catch (_) { return {}; }
}

function writeScripts(scripts) {
  try { localStorage.setItem(SCRIPT_STORE_KEY, JSON.stringify(scripts)); } catch (_) { /* private mode */ }
}

function compileScript(source) {
  const file = sourceFile('script.oscript', String(source || ''));
  const bag = new DiagnosticBag();
  const checked = check(file, parse(file, bag), bag);
  const { program } = emit(file, checked, bag, {});
  const errors = bag.ordered().filter(isError);
  if (errors.length || !program) {
    throw new Error(renderDiagnostics(file, errors) || 'The script did not compile');
  }
  const probe = descriptorFor(program, { chartVersion: CHARTS_VERSION, source: file });
  const slug = probe.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script';
  return descriptorFor(program, {
    id: `oscript-${slug}`,
    category: 'OpenScript',
    chartVersion: CHARTS_VERSION,
    source: file,
    simulateOrders: true,
  });
}

/** Compile, register and remember a script. Throws with the rendered diagnostics on error. */
function applyScript(source) {
  const descriptor = compileScript(source);
  registerIndicator(descriptor);
  writeScripts({ ...readScripts(), [descriptor.id]: source });
  return descriptor;
}

/** Forget a script. The chart library has no unregister, so it leaves the picker on reload. */
function removeScript(id) {
  const scripts = readScripts();
  delete scripts[id];
  writeScripts(scripts);
}

for (const [id, source] of Object.entries(readScripts())) {
  try {
    registerIndicator(compileScript(source));
  } catch (error) {
    console.warn(`[OpenScript] saved script ${id} no longer compiles`, error);
  }
}

window.OAC = {
  createChart,
  darkTheme,
  lightTheme,
  IST_OFFSET_SECONDS,
  indicatorDefaults,
  getIndicator,
  hasIndicator,
  registeredIndicators,
  indicatorStyleInputs,
  INDICATOR_SOURCES,
  INDICATOR_LINE_STYLES,
  PaneLegend,
  PriceLevels,
  DrawingController,
  registeredDrawingTools,
  getDrawingTool,
  migrateDrawings,
  keyToDrawingAction,
  drawingToolIcon,
  iconSvg,
  computeVolumeProfileSessions,
  VolumeProfile,
  computeFootprint,
  cumulativeDelta,
  FootprintAggregator,
  Footprint,
  TradeController,
  HeikinAshiTransform,
  RenkoTransform,
  RangeBarsTransform,
  LineBreakTransform,
  PointFigureTransform,
  KagiTransform,
  runTransform,
  applyScript,
  removeScript,
  savedScripts: readScripts,
};
window.dispatchEvent(new Event('oac:ready'));
