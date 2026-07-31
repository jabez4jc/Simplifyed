/**
 * Pending/working orders on the chart - openalgo-charts' `trade` tier (`WorkingOrderLine` +
 * `TradeController`): a broker-style dashed line at the order price with a segmented pill
 * ([SIDE][qty][TYPE price ± LTP-distance][x]), dimmed while unacknowledged.
 *
 * Sourced from this app's own local order-tracking table via the existing
 * GET /orders?symbol=&status=open - the same one the Orders page itself reads, not a new
 * broker round-trip.
 *
 * Scoped to pending ORDERS only. Position and target/stop levels already have this app's own
 * lines (see loadChartPosition/loadChartLevels in dashboard-chart.js), built around a
 * multi-instance AGGREGATE the library's own `Position`/`BracketState` types do not model - a
 * fan-out position can span several broker instances at different average prices, where the
 * library's `Position` is a single `{symbol, netQty, avgPrice}` - so those stay as they are
 * rather than being swapped for `PositionMarker`/`BracketGroup`.
 */
Object.assign(DashboardApp.prototype, {
  orderLinesState() {
    if (!this._orderLines) {
      this._orderLines = { controller: null, refreshTimer: null };
    }
    return this._orderLines;
  },

  /** Called after the chart is (re)built - safe to call repeatedly. */
  attachOrderLines() {
    const s = this.orderLinesState();
    if (!this.chart || !window.OAC?.TradeController) return;
    if (s.controller) return; // already attached to this chart instance

    // TradeHost only needs add/removePrimitive - the chart itself satisfies that structurally,
    // but every order line belongs on the price pane specifically, so pane 0 is pinned here
    // rather than trusting whatever default an un-indexed addPrimitive call would pick.
    const host = {
      addPrimitive: (p) => this.chart.addPrimitive(p, 0),
      removePrimitive: (p) => { try { this.chart.removePrimitive(p); } catch (_) { /* disposed */ } },
    };
    s.controller = new window.OAC.TradeController(host);
    this.refreshOrderLines();
    if (!s.refreshTimer) {
      s.refreshTimer = setInterval(() => this.refreshOrderLines(), 5000);
    }
  },

  /** Called from destroyChart() - the primitives belong to the chart instance going away. */
  detachOrderLines() {
    const s = this.orderLinesState();
    if (s.refreshTimer) { clearInterval(s.refreshTimer); s.refreshTimer = null; }
    s.controller = null;
  },

  /** Push the latest price into the working-order lines for their live LTP-distance readout,
   * without a full re-fetch - called from applyChartQuote on every accepted tick. */
  pushOrderLinesLtp() {
    const s = this.orderLinesState();
    if (!s.controller || !this.chartState || !Number.isFinite(this.chartLastPrice)) return;
    try { s.controller.onLtp(this.chartState.symbol, this.chartLastPrice); } catch (_) { /* disposed */ }
  },

  async refreshOrderLines() {
    const s = this.orderLinesState();
    const state = this.chartState;
    if (!s.controller || !state) return;

    let rows;
    try {
      const res = await api.request(`/orders?symbol=${encodeURIComponent(state.symbol)}&status=open`);
      rows = res.data || [];
    } catch (_) {
      // No orders.view permission, most likely - a read-only chart is still fully usable.
      return;
    }
    // A newer request finishing first (chart torn down mid-flight) must not draw onto a
    // detached controller.
    if (s !== this.orderLinesState() || !s.controller) return;

    // Only orders on THIS underlying's own exchange - an option leg carries a different symbol
    // and belongs on its own pane's price scale, not the underlying's.
    const orders = rows
      .filter((o) => (o.exchange || '').toUpperCase() === (state.exchange || '').toUpperCase())
      .map((o) => ({
        id: String(o.order_id ?? o.id),
        symbol: o.symbol,
        side: (o.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        type: /SL-M/i.test(o.order_type) ? 'SL-M' : /SL/i.test(o.order_type) ? 'SL' : /LIMIT/i.test(o.order_type) ? 'LIMIT' : 'MARKET',
        qty: Number(o.quantity) || 0,
        // This app's local order cache does not track partial fills - 0 rather than a guess.
        filledQty: 0,
        price: Number(o.price) || 0,
        triggerPrice: o.trigger_price ? Number(o.trigger_price) : undefined,
        status: 'working',
      }));

    try {
      s.controller.reconcile(orders, []);
      this.pushOrderLinesLtp();
    } catch (error) {
      console.error('[Chart] order lines failed', error);
    }
  },

  /**
   * The pane equivalent of the above - one `TradeController` per CE/PE pane, each filtered to
   * that pane's own contract symbol, so a stop placed on the CE pane's own right-click menu
   * (attachOptionPaneOrders, dashboard-chart-panes.js) shows up as a draggable/closable
   * `WorkingOrderLine` on THAT pane once the next poll picks it up - the same native
   * drag-to-modify/close-button behaviour the main chart's order lines already get for free from
   * the engine, not hand-rolled a second time.
   */
  attachPaneOrderLines(key) {
    const pane = this.optionPanes?.[key];
    if (!pane?.chart || !window.OAC?.TradeController) return;
    if (pane.orderLines?.controller) return;

    const host = {
      addPrimitive: (p) => pane.chart.addPrimitive(p, 0),
      removePrimitive: (p) => { try { pane.chart.removePrimitive(p); } catch (_) { /* disposed */ } },
    };
    pane.orderLines = { controller: new window.OAC.TradeController(host), refreshTimer: null };
    this.refreshPaneOrderLines(key);
    pane.orderLines.refreshTimer = setInterval(() => this.refreshPaneOrderLines(key), 5000);
  },

  /** Called from destroyOptionPanes() - the primitives belong to the pane's chart, going away. */
  detachPaneOrderLines(key) {
    const pane = this.optionPanes?.[key];
    if (!pane?.orderLines) return;
    if (pane.orderLines.refreshTimer) clearInterval(pane.orderLines.refreshTimer);
    pane.orderLines = null;
  },

  async refreshPaneOrderLines(key) {
    const pane = this.optionPanes?.[key];
    const controller = pane?.orderLines?.controller;
    if (!controller || !pane.contract) return;

    let rows;
    try {
      const res = await api.request(`/orders?symbol=${encodeURIComponent(pane.contract.symbol)}&status=open`);
      rows = res.data || [];
    } catch (_) {
      return; // no orders.view permission, most likely - the pane is still fully usable
    }
    // A newer build of this pane (symbol/timeframe switch, or the pane torn down) must not draw
    // onto a detached controller.
    if (this.optionPanes?.[key] !== pane || pane.orderLines?.controller !== controller) return;

    const orders = rows
      .filter((o) => (o.exchange || '').toUpperCase() === (pane.contract.exchange || '').toUpperCase()
        && (o.symbol || '').toUpperCase() === pane.contract.symbol.toUpperCase())
      .map((o) => ({
        id: String(o.order_id ?? o.id),
        symbol: o.symbol,
        side: (o.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        type: /SL-M/i.test(o.order_type) ? 'SL-M' : /SL/i.test(o.order_type) ? 'SL' : /LIMIT/i.test(o.order_type) ? 'LIMIT' : 'MARKET',
        qty: Number(o.quantity) || 0,
        filledQty: 0,
        price: Number(o.price) || 0,
        triggerPrice: o.trigger_price ? Number(o.trigger_price) : undefined,
        status: 'working',
      }));

    try {
      controller.reconcile(orders, []);
      const lastClose = pane.candles?.[pane.candles.length - 1]?.close;
      if (Number.isFinite(lastClose)) controller.onLtp(pane.contract.symbol, lastClose);
    } catch (error) {
      console.error(`[Chart] pane ${key} order lines failed`, error);
    }

    // Same poll cadence refreshes the position line - a fill or a manual close elsewhere should
    // show up on the chart within one cycle, not only on the next full pane rebuild.
    if (typeof this.loadPanePosition === 'function') this.loadPanePosition(key);
  },
});
