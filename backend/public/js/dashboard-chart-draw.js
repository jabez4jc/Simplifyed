/**
 * Drawing tools.
 *
 * Uses openalgo-charts' own `DrawingController` (the `draw` tier - see
 * js/openalgo-charts-bridge.js), not a separate vendored library. It is a headless engine: no
 * toolbar, no dialogs - it owns placement (live preview, both click-click and press-drag-release
 * gestures), selection, whole-shape and per-anchor dragging, magnet snap to O/H/L/C, undo/redo,
 * and JSON serialisation. This file is only the adapter on top of that: a vertical icon rail,
 * per-symbol persistence, and the one piece of integration that matters here - a horizontal line
 * is a price you have already chosen and committed to on screen, so right-clicking one offers the
 * chart's own limit/stop menu. That routes through contextMenuItemsFor + confirmChartOrder rather
 * than a parallel path, so a line-placed order gets the same validity rules, the same sizing and
 * the same blast-radius confirmation as any other order on this screen. Nothing here places an
 * order on its own.
 *
 * All 43 built-in tools are offered (the previous, Lightweight Charts based drawing engine was
 * deliberately restricted to 18 of its 67 - the smaller, more curated set the new engine ships
 * makes that restriction unnecessary). Categories below are this app's own grouping for the rail;
 * the engine's tool registry has no category field of its own.
 */

/** Tool id -> rail category. Every id in openalgo-charts' BUILTIN_DRAWING_TOOLS must appear here
 * once - drawToolsIn() silently drops anything missing, which would otherwise be a tool nobody
 * can ever select. */
const TOOL_CATEGORY = {
  'trend-line': 'line', ray: 'line', 'extended-line': 'line', arrow: 'line',
  'horizontal-line': 'line', 'horizontal-ray': 'line', 'vertical-line': 'line', 'cross-line': 'line',
  'arrow-up': 'line', 'arrow-down': 'line',
  'parallel-channel': 'channel', 'fib-channel': 'channel',
  'fib-retracement': 'fibonacci', 'fib-extension': 'fibonacci', 'fib-time-zone': 'fibonacci', 'fib-fan': 'fibonacci',
  rectangle: 'shape', 'rotated-rectangle': 'shape', ellipse: 'shape', circle: 'shape', triangle: 'shape',
  'long-position': 'forecasting', 'short-position': 'forecasting', forecast: 'forecasting',
  'gann-fan': 'forecasting', 'gann-box': 'forecasting', 'cyclic-lines': 'forecasting',
  'time-cycles': 'forecasting', 'sine-line': 'forecasting',
  'price-range': 'measurement', 'date-range': 'measurement', measure: 'measurement',
  text: 'annotation', path: 'annotation', 'price-label': 'annotation', callout: 'annotation',
  'flag-mark': 'annotation', highlighter: 'annotation', brush: 'annotation', polyline: 'annotation',
  curve: 'annotation', 'double-curve': 'annotation', arc: 'annotation',
};

/**
 * The rail, in the order a trader reaches for it. `cursor` is not a category - it is the absence
 * of a tool, i.e. select-and-drag - so it sits first and always.
 *
 * Icons are inline SVG paths rather than a font or sprite: the app serves no external assets and
 * a 24px stroke icon is a handful of characters. Each is drawn on a 24x24 grid with
 * currentColor, so the active state needs no second asset.
 */
const DRAW_RAIL = [
  { id: 'cursor', label: 'Select', icon: 'M4 12h6M14 12h6M12 4v6M12 14v6' },
  { id: 'line', label: 'Lines', icon: 'M5 19L19 5M5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM19 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z' },
  { id: 'channel', label: 'Channels', icon: 'M4 15L20 7M4 19L20 11M6 16.5a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z' },
  { id: 'fibonacci', label: 'Fibonacci', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16M8 6v12M16 6v12' },
  { id: 'shape', label: 'Shapes', icon: 'M4 6h11v8H4zM10 11h10v9H10z' },
  { id: 'forecasting', label: 'Forecast', icon: 'M4 18l5-6 4 3 7-9M20 6h-5M20 6v5' },
  { id: 'measurement', label: 'Measure', icon: 'M3 9l6-6 12 12-6 6zM8 8l2 2M11 5l2 2M5 11l2 2' },
  { id: 'annotation', label: 'Notes', icon: 'M6 5h12M12 5v14M9 19h6' },
];

const DRAW_ACTIONS = [
  { id: 'lock', label: 'Lock drawings', icon: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z' },
  { id: 'hide', label: 'Hide drawings', icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  { id: 'clear', label: 'Remove all drawings', icon: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6', danger: true },
];

Object.assign(DashboardApp.prototype, {
  drawState() {
    if (!this._draw) {
      let prefs = {};
      try { prefs = JSON.parse(localStorage.getItem('chart-draw-prefs') || '{}'); } catch (_) { /* corrupt */ }
      this._draw = {
        controller: null,
        tool: null,
        colour: prefs.colour || '#3B82F6',
        hidden: false,
        locked: false,
        flyout: null,
      };
    }
    return this._draw;
  },

  saveDrawPrefs() {
    const d = this.drawState();
    try { localStorage.setItem('chart-draw-prefs', JSON.stringify({ colour: d.colour })); } catch (_) { /* private mode */ }
  },

  /** Drawings are per instrument - a trend line on NIFTY means nothing on BTC. */
  drawStorageKey() {
    const s = this.chartState;
    return s ? `chart-draw:${s.exchange}:${s.symbol}` : null;
  },

  /**
   * Attach the drawing engine to the current chart. Called after the chart is built, and safe
   * to call again on a rebuild - the previous controller is destroyed first.
   */
  attachDrawingLayer() {
    const container = document.getElementById('chart-container');
    if (!window.OAC?.DrawingController) {
      const rail = document.getElementById('chart-draw-tools');
      if (rail) rail.innerHTML = '<p class="chart-draw-note">Drawing tools failed to load.</p>';
      return;
    }
    if (!this.chart || !this.candleSeries || !container) return;

    const d = this.drawState();
    if (d.controller) {
      try { d.controller.destroy(); } catch (_) { /* already gone */ }
      d.controller = null;
    }

    try {
      d.controller = new window.OAC.DrawingController(this.chart, {
        magnet: true,
        defaultStyle: { color: d.colour },
      });
      this.restoreDrawings();
      this.attachDrawSaveTrigger();
    } catch (error) {
      // A broken drawing layer must not take the chart with it.
      console.error('Drawing layer unavailable:', error);
      d.controller = null;
    }

    this.renderDrawToolbar();
    this.attachDrawingOrderMenu();
  },

  detachDrawingLayer() {
    const d = this._draw;
    if (!d?.controller) return;
    try { d.controller.destroy(); } catch (_) { /* already gone */ }
    d.controller = null;
  },

  saveDrawings() {
    const key = this.drawStorageKey();
    const controller = this.drawState().controller;
    if (!key || !controller) return;
    try { localStorage.setItem(key, JSON.stringify(controller.toJSON())); } catch (_) { /* private mode, or quota */ }
    this.renderDrawToolbar();
  },

  /**
   * Debounced save triggered on pointerup/click inside the chart. The controller has no
   * "drawing added/removed/updated" event to hook (unlike the previous drawing engine) - every
   * placement, drag, or deletion gesture ends with the pointer lifting off the canvas, so that is
   * the proxy used instead. Explicit call sites (delete/clear/hide/lock below) also save
   * immediately, since those do not always involve a pointer gesture on the canvas itself.
   *
   * The same pointerup is also what catches a freshly placed Fibonacci retracement for
   * _fixFibDirection - see that function for why it is needed at all.
   */
  attachDrawSaveTrigger() {
    const container = document.getElementById('chart-container');
    if (!container || container.dataset.drawSaveBound === 'true') return;
    container.dataset.drawSaveBound = 'true';
    this._knownDrawingIds = new Set((this.drawState().controller?.drawings() || []).map((d) => d.id));
    const schedule = () => {
      this._fixFibDirection();
      clearTimeout(this._drawSaveTimer);
      this._drawSaveTimer = setTimeout(() => this.saveDrawings(), 300);
    };
    container.addEventListener('pointerup', schedule);
  },

  /**
   * openalgo-charts' `fib-retracement` anchors 0% at the START of the drag
   * (`price0 + (price1 - price0) * level`), so dragging a swing low to a swing high puts 0% at
   * the low. Every charting package - and every trader - puts 0% at the END of the move and
   * measures the retracement back from it; verified live against this engine (dragging low to
   * high labelled the low 0.0% and the high 100.0%, the wrong way round for the retracement
   * this tool is for). There is no `reverseDirection`-style option to ask for the other
   * convention (unlike the previous drawing engine, which had one) and no per-drawing "just
   * created" event to hook, so this diffs the controller's drawing ids on every pointerup - the
   * gesture that ends any placement - and reverses the anchor order of anything new tagged
   * `fib-retracement`. Reversing the ANCHORS (not the level list) is what actually flips which
   * end reads 0%, since the tool always treats anchor 0 as 0% regardless of level ordering.
   */
  _fixFibDirection() {
    const controller = this.drawState().controller;
    if (!controller) return;
    const known = this._knownDrawingIds || (this._knownDrawingIds = new Set());
    for (const drawing of controller.drawings()) {
      if (known.has(drawing.id)) continue;
      known.add(drawing.id);
      if (drawing.tool === 'fib-retracement' && drawing.points?.length === 2) {
        controller.update(drawing.id, { points: [drawing.points[1], drawing.points[0]] });
      }
    }
  },

  restoreDrawings() {
    const key = this.drawStorageKey();
    const controller = this.drawState().controller;
    if (!key || !controller) return;

    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) { return; }
    if (!Array.isArray(saved) || !saved.length) return;

    try {
      controller.fromJSON(saved);
    } catch (error) {
      console.error('Could not restore drawings:', error);
    }
  },

  setDrawTool(type) {
    const d = this.drawState();
    if (!d.controller) return;
    const next = d.tool === type ? null : type;
    d.tool = next;
    d.controller.setTool(next);
    this.renderDrawToolbar();
  },

  deleteSelectedDrawing() {
    const controller = this.drawState().controller;
    const id = controller?.selected();
    if (!id) return;
    controller.remove(id);
    this.saveDrawings();
  },

  async clearDrawings() {
    const controller = this.drawState().controller;
    if (!controller) return;
    const count = controller.drawings().length;
    if (!count) return;
    const ok = await Utils.confirm(`Remove all ${count} drawing${count === 1 ? '' : 's'} from this chart?`);
    if (ok) { controller.clear(); this.saveDrawings(); }
  },

  toggleDrawingsHidden() {
    const d = this.drawState();
    if (!d.controller) return;
    d.hidden = !d.hidden;
    for (const drawing of d.controller.drawings()) {
      d.controller.update(drawing.id, { visible: !d.hidden });
    }
    this.saveDrawings();
    this.renderDrawToolbar();
  },

  /** Lock every drawing against selection and dragging, leaving them visible. */
  toggleDrawingsLocked() {
    const d = this.drawState();
    if (!d.controller) return;
    d.locked = !d.locked;
    for (const drawing of d.controller.drawings()) {
      d.controller.update(drawing.id, { locked: d.locked });
    }
    if (d.locked) d.controller.select(null);
    this.saveDrawings();
    this.renderDrawToolbar();
  },

  /**
   * Right-clicking a horizontal line opens the chart's ordinary order menu at that line's price.
   *
   * Only horizontal lines: they are the only shape that names a single unambiguous price. The
   * controller has no public hit-test of its own to ask, so this checks the (small) set of
   * horizontal lines/rays directly - each is one price, mapped to a y-coordinate with the same
   * `chart.priceToCoordinate` the level-line dragging on the main chart already uses, and
   * compared against the click within a small pixel tolerance.
   */
  attachDrawingOrderMenu() {
    const container = document.getElementById('chart-container');
    if (!container || container.dataset.drawOrderBound === 'true') return;
    container.dataset.drawOrderBound = 'true';

    const HIT_TOLERANCE_PX = 6;

    container.addEventListener('contextmenu', (e) => {
      const controller = this.drawState().controller;
      if (!controller || !this.chart) return;

      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;
      let hitPrice = null;
      for (const drawing of controller.drawings()) {
        if (drawing.tool !== 'horizontal-line' && drawing.tool !== 'horizontal-ray') continue;
        if (drawing.visible === false) continue;
        const price = drawing.points?.[0]?.price;
        if (!Number.isFinite(price)) continue;
        let ly;
        try { ly = this.chart.priceToCoordinate(price, drawing.paneIndex || 0); } catch (_) { continue; }
        if (Number.isFinite(ly) && Math.abs(ly - y) <= HIT_TOLERANCE_PX) { hitPrice = price; break; }
      }
      if (hitPrice === null) return;

      e.preventDefault();
      e.stopPropagation();
      this.openLineOrderMenu(Number(hitPrice.toFixed(2)), e);
    }, true); // capture, so this runs before the chart's own handler
  },

  openLineOrderMenu(price, event) {
    const menu = document.getElementById('chart-ctx');
    const container = document.getElementById('chart-container');
    if (!menu || !container) return;

    if (!this.chartTradeInfo || this.chartTradeBlocked) {
      Utils.showToast('No order-enabled instance assigned to this symbol', 'error');
      return;
    }
    // Trades the underlying, as the chart's own menu does - see attachChartContextMenu.
    const items = this.contextMenuItemsFor(price);
    menu.innerHTML = `<div class="chart-ctx-head">Line @ ${Utils.formatNumber(price)}</div>`
      + items.map((it, i) => `
        <button type="button" class="chart-ctx-item ${it.side === 'BUY' ? 'is-buy' : 'is-sell'}"
                data-i="${i}" ${it.enabled ? '' : 'disabled'}
                ${it.enabled ? '' : `title="Not valid here — ${Utils.escapeHTML(it.why)}"`}>
          ${Utils.escapeHTML(it.label)}
        </button>`).join('');

    const rect = container.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX - rect.left, rect.width - 210))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY - rect.top, rect.height - items.length * 30 - 40))}px`;
    menu.hidden = false;

    menu.querySelectorAll('.chart-ctx-item').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        this.confirmChartOrder(items[Number(btn.dataset.i)]);
      });
    });
  },

  /** Tools of one category, from the engine's own registry (see TOOL_CATEGORY above). */
  drawToolsIn(category) {
    if (!window.OAC?.registeredDrawingTools) return [];
    return window.OAC.registeredDrawingTools().filter((t) => TOOL_CATEGORY[t.id] === category);
  },

  /** The category a tool belongs to, so the rail can show which button is live. */
  drawToolCategory(type) {
    return TOOL_CATEGORY[type] || null;
  },

  /** Rail entries that still have a tool behind them, so no button opens an empty flyout. */
  drawRailItems() {
    return DRAW_RAIL.filter((item) => item.id === 'cursor' || this.drawToolsIn(item.id).length);
  },

  toggleDrawFlyout(category) {
    const d = this.drawState();
    d.flyout = d.flyout === category ? null : category;
    if (d.flyout === 'cursor') {
      d.flyout = null;
      this.setDrawTool(null);
      return;
    }
    this.renderDrawToolbar();
  },

  renderDrawToolbar() {
    const rail = document.getElementById('chart-draw-tools');
    const flyout = document.getElementById('chart-draw-flyout');
    if (!rail) return;
    const d = this.drawState();

    if (!d.controller) {
      rail.innerHTML = '';
      rail.hidden = true;
      if (flyout) flyout.hidden = true;
      return;
    }
    rail.hidden = false;

    const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    const liveCategory = d.tool ? this.drawToolCategory(d.tool) : null;
    const count = d.controller.drawings().length;

    rail.innerHTML = `
      ${this.drawRailItems().map((item) => {
        const isCursor = item.id === 'cursor';
        const active = isCursor ? !d.tool : liveCategory === item.id;
        return `
          <button type="button" class="chart-rail-btn ${active ? 'active' : ''} ${d.flyout === item.id ? 'open' : ''}"
                  data-rail="${item.id}" title="${Utils.escapeHTML(item.label)}"
                  aria-label="${Utils.escapeHTML(item.label)}" aria-pressed="${active}">
            ${icon(item.icon)}
          </button>`;
      }).join('')}
      <span class="chart-rail-sep"></span>
      ${DRAW_ACTIONS.map((a) => {
        const on = (a.id === 'lock' && d.locked) || (a.id === 'hide' && d.hidden);
        return `
          <button type="button" class="chart-rail-btn ${on ? 'active' : ''} ${a.danger ? 'is-danger' : ''}"
                  data-act="${a.id}" title="${Utils.escapeHTML(a.label)}${a.id === 'clear' && count ? ` (${count})` : ''}"
                  aria-label="${Utils.escapeHTML(a.label)}" aria-pressed="${Boolean(on)}">
            ${icon(a.icon)}
          </button>`;
      }).join('')}`;

    rail.querySelectorAll('[data-rail]').forEach((b) =>
      b.addEventListener('click', () => this.toggleDrawFlyout(b.dataset.rail)));
    rail.querySelector('[data-act="lock"]').addEventListener('click', () => this.toggleDrawingsLocked());
    rail.querySelector('[data-act="hide"]').addEventListener('click', () => this.toggleDrawingsHidden());
    rail.querySelector('[data-act="clear"]').addEventListener('click', () => this.clearDrawings());

    this.renderDrawFlyout();
  },

  renderDrawFlyout() {
    const flyout = document.getElementById('chart-draw-flyout');
    const rail = document.getElementById('chart-draw-tools');
    if (!flyout || !rail) return;
    const d = this.drawState();

    if (!d.flyout) { flyout.hidden = true; flyout.innerHTML = ''; return; }
    const item = this.drawRailItems().find((r) => r.id === d.flyout);
    const tools = this.drawToolsIn(d.flyout);
    if (!item || !tools.length) { flyout.hidden = true; return; }

    flyout.hidden = false;
    flyout.innerHTML = `
      <div class="chart-flyout-head">${Utils.escapeHTML(item.label)}</div>
      ${tools.map((t) => `
        <button type="button" class="chart-flyout-item ${d.tool === t.id ? 'active' : ''}"
                data-tool="${t.id}">
          <span>${Utils.escapeHTML(t.name)}</span>
          <span class="chart-flyout-anchors">${t.freehand ? 'drag' : t.points ? `${t.points} pt` : 'click'}</span>
        </button>`).join('')}`;

    // Anchor the panel to the rail button it belongs to, clamped inside the chart.
    const button = rail.querySelector(`[data-rail="${d.flyout}"]`);
    const wrap = rail.parentElement;
    if (button && wrap) {
      const top = button.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
      const maxTop = Math.max(0, wrap.clientHeight - flyout.offsetHeight - 8);
      flyout.style.top = `${Math.max(0, Math.min(top, maxTop))}px`;
    }

    flyout.querySelectorAll('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => {
        this.setDrawTool(b.dataset.tool);
        this.drawState().flyout = null;
        this.renderDrawToolbar();
      }));
  },
});

document.addEventListener('keydown', (e) => {
  const app = window.app;
  if (!app || app.currentView !== 'chart') return;
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  const d = app.drawState();
  if (!d.controller) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (d.controller.selected()) {
      e.preventDefault();
      app.deleteSelectedDrawing();
    }
  }
  if (e.key === 'Escape') {
    if (d.tool) { d.tool = null; d.controller.setTool(null); app.renderDrawToolbar(); }
    d.controller.select(null);
  }
  if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (e.shiftKey) d.controller.redo(); else d.controller.undo();
    app.saveDrawings();
  }
});
