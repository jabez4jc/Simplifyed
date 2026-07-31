/**
 * Bridges openalgo-charts (native ES modules) into the classic-script world dashboard-chart*.js
 * lives in. Those files are plain `Object.assign(DashboardApp.prototype, ...)` scripts with no
 * module system - rewriting them as ESM to import the library directly would touch every file in
 * the chart feature, for no benefit over exposing the same handful of exports as one global. A
 * module script's execution is deferred until after the DOM is parsed and always runs before
 * classic `defer` scripts fire (both wait for the same point, but module graphs resolve first),
 * so `window.OAC` is guaranteed populated before any dashboard-chart*.js code that might use it.
 */
import {
  createChart, darkTheme, lightTheme, IST_OFFSET_SECONDS, indicatorDefaults, getIndicator, hasIndicator,
  indicatorStyleInputs, INDICATOR_SOURCES, INDICATOR_LINE_STYLES, PaneLegend,
} from '/vendor/openalgo-charts/openalgo-charts.mjs';
import { registerBuiltinIndicators } from '/vendor/openalgo-charts/openalgo-charts.indicators.mjs';
import {
  DrawingController, registerBuiltinDrawingTools, registeredDrawingTools, getDrawingTool,
} from '/vendor/openalgo-charts/openalgo-charts.draw.mjs';
import {
  computeVolumeProfileSessions, VolumeProfile, computeFootprint, cumulativeDelta,
  FootprintAggregator, Footprint,
} from '/vendor/openalgo-charts/openalgo-charts.profile.mjs';
import { TradeController } from '/vendor/openalgo-charts/openalgo-charts.trade.mjs';
import {
  HeikinAshiTransform, RenkoTransform, RangeBarsTransform, LineBreakTransform, runTransform,
} from '/vendor/openalgo-charts/openalgo-charts.transform.mjs';

registerBuiltinIndicators();
registerBuiltinDrawingTools();

window.OAC = {
  createChart,
  darkTheme,
  lightTheme,
  IST_OFFSET_SECONDS,
  indicatorDefaults,
  getIndicator,
  hasIndicator,
  indicatorStyleInputs,
  INDICATOR_SOURCES,
  INDICATOR_LINE_STYLES,
  PaneLegend,
  DrawingController,
  registeredDrawingTools,
  getDrawingTool,
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
  runTransform,
};
window.dispatchEvent(new Event('oac:ready'));
