/**
 * Pending/working orders on the chart - openalgo-charts' `trade` tier (`WorkingOrderLine` +
 * `TradeController`): a broker-style dashed line at the order price with a segmented pill
 * ([SIDE][qty][TYPE price ± LTP-distance][x]), dimmed while unacknowledged.
 *
 * Sourced from this app's own local order-tracking table via the existing
 * GET /orders?symbol=&status=open - the same one the Orders page itself reads, not a new
 * broker round-trip.
 *
 * One line per ORDER GROUP, not per broker order: a chart order fanned out to three instances is
 * three rows sharing a request id (`chart-…-<instanceId>`), drawn as one line with their total
 * quantity; dragging or ✕-ing it acts on all of them. A change touching a live (real-money)
 * instance asks first; an analyzer-only group applies straight away.
 *
 * The position is a `PositionMarker` at the quantity-weighted average entry across instances
 * (what /positions/symbol aggregates), with live P&L and a ✕ that squares it off per instance.
 */
// Order lines redraw when a pushed order_update arrives (dashboard-core.js wsRefreshOrders);
// this timer only covers a missed push or a dropped browser socket.
const ORDER_LINES_FALLBACK_MS = 30000;

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
    this.bindOrderLineGestures(this.chart, () => this.refreshOrderLines(), undefined);
    // A position drawn before the layer existed was a plain line - redraw it as the marker.
    if (typeof this.redrawChartLines === 'function') this.redrawChartLines();
    this.refreshOrderLines();
    if (!s.refreshTimer) {
      s.refreshTimer = setInterval(() => this.refreshOrderLines(), ORDER_LINES_FALLBACK_MS);
    }
  },

  /**
   * The order line draws a drag handle and a close button; the engine reports them as
   * `order:<id>` (drag) and `order:<id>::close` (click), and acting on them is ours. Nothing
   * listened before, so dragging a line or pressing its x did nothing. Bound once per chart.
   */
  /** `scope` is undefined for the main chart, 'ce'/'pe' for an option pane. */
  bindOrderLineGestures(chart, refresh, scope) {
    if (!chart || chart._orderGesturesBound) return;
    chart._orderGesturesBound = true;
    // The engine only lets an order line be grabbed once something subscribes to drags; without
    // this the lines showed a resize cursor but never started a drag, so no order could be moved.
    chart.subscribeDrag?.(() => {});
    chart.on('click', (e) => {
      const m = /^order:(\d+)::close$/.exec(e?.id || '');
      if (m) { this.cancelChartOrder(Number(m[1]), refresh, scope); return; }
      if (/^position:.+::close$/.test(e?.id || '')) this.closeChartPosition(scope);
    });
    chart.on('drag:end', (e) => {
      const m = /^order:(\d+)$/.exec(e?.id || '');
      if (m && Number.isFinite(e.price)) this.moveChartOrder(Number(m[1]), e.price, refresh, scope);
    });
  },

  /** The broker orders a line stands for, and whether any sits on a live (real-money) instance. */
  orderGroupFor(id, scope) {
    const groups = scope ? this.optionPanes?.[scope]?.orderLines?.groups : this.orderLinesState().groups;
    const g = groups?.get(String(id)) || { ids: [id], insts: [] };
    const insts = g.insts;
    // Unknown means live: a confirmation is never skipped for lack of information.
    const live = insts.length === 0 || insts.some((i) => i.isAnalyzer !== true);
    return { ...g, insts, live };
  },

  async cancelChartOrder(id, refresh, scope) {
    const g = this.orderGroupFor(id, scope);
    const names = g.insts.map((i) => i.name).join(', ');
    if (g.live && !(await Utils.confirm(
      `Cancel ${g.ids.length === 1 ? 'this order' : `these ${g.ids.length} orders`}${names ? ` (${names})` : ''} at the broker?`,
      'Cancel order'
    ))) return;
    const results = await Promise.allSettled(g.ids.map((oid) => api.request(`/orders/${oid}/cancel`, { method: 'POST' })));
    const failed = results.filter((r) => r.status === 'rejected');
    Utils.showToast(
      failed.length ? `Cancel failed on ${failed.length} of ${results.length}: ${failed[0].reason?.message || ''}` : `Cancelled ${results.length} order${results.length === 1 ? '' : 's'}`,
      failed.length ? 'error' : 'success'
    );
    refresh();
  },

  async moveChartOrder(id, price, refresh, scope) {
    const g = this.orderGroupFor(id, scope);
    const names = g.insts.map((i) => i.name).join(', ');
    // Real money asks first; analyzer-only moves straight away. Refresh either way: on "no" or a
    // failure the line snaps back to the broker's price.
    if (g.live && !(await Utils.confirm(
      `Move ${g.ids.length === 1 ? 'this order' : `these ${g.ids.length} orders`}${names ? ` (${names})` : ''} to ${Utils.formatNumber(price)}? This includes a live account.`,
      'Move order'
    ))) {
      refresh();
      return;
    }
    const results = await Promise.allSettled(g.ids.map((oid) => api.request(`/orders/${oid}/modify`, { method: 'POST', body: { price } })));
    const done = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    const d = done[0]?.value?.data;
    const at = Number(d?.order_type === 'LIMIT' ? d.price : d?.trigger_price) || price;
    Utils.showToast(
      failed.length
        ? `Moved ${done.length} of ${results.length}; failed: ${failed[0].reason?.message || ''}`
        : `${results.length === 1 ? 'Order' : `${results.length} orders`} moved to ${Utils.formatNumber(at)}`,
      failed.length ? 'error' : 'success'
    );
    refresh();
  },

  /**
   * Chart rows -> one library Order per group. Grouped by the request id's base (a chart fan-out
   * suffixes the instance id), plus side/type/price, so siblings modified apart stay apart.
   * @returns {{ orders: Object[], groups: Map<string, {ids: number[], insts: Object[]}> }}
   */
  groupChartOrders(rows) {
    const byKey = new Map();
    for (const o of rows) {
      const rid = String(o.request_id || '');
      const suffix = `-${o.instance_id}`;
      const base = rid.startsWith('chart-') && rid.endsWith(suffix) ? rid.slice(0, -suffix.length) : `row${o.id}`;
      const type = /SL-M/i.test(o.order_type) ? 'SL-M' : /SL/i.test(o.order_type) ? 'SL' : /LIMIT/i.test(o.order_type) ? 'LIMIT' : 'MARKET';
      const side = (o.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      const key = `${base}|${side}|${type}|${Number(o.price) || 0}|${Number(o.trigger_price) || 0}`;
      const g = byKey.get(key);
      // Each order's own account, straight from the order row: real money or analyzer.
      const inst = { id: o.instance_id, name: o.instance_name || `#${o.instance_id}`, isAnalyzer: Boolean(o.instance_analyzer) };
      if (g) {
        g.order.qty += Number(o.quantity) || 0;
        g.ids.push(o.id);
        g.insts.push(inst);
      } else {
        byKey.set(key, {
          ids: [o.id],
          insts: [inst],
          order: {
            // The first row's own id: cancel/modify look the rest of the group up from it.
            id: String(o.id),
            symbol: o.symbol,
            side,
            type,
            qty: Number(o.quantity) || 0,
            // This app's local order cache does not track partial fills - 0 rather than a guess.
            filledQty: 0,
            price: Number(o.price) || 0,
            triggerPrice: o.trigger_price ? Number(o.trigger_price) : undefined,
            status: 'working',
          },
        });
      }
    }
    const groups = new Map();
    for (const g of byKey.values()) groups.set(g.order.id, { ids: g.ids, insts: g.insts });
    return { orders: [...byKey.values()].map((g) => g.order), groups };
  },

  /**
   * Redraw one chart's trade layer - order lines plus the position marker - from the last order
   * poll and the last position load. Called by either as it lands, so neither waits on the other.
   */
  reconcileTrade(scope) {
    const holder = scope ? this.optionPanes?.[scope]?.orderLines : this.orderLinesState();
    const controller = holder?.controller;
    if (!controller) return false;
    const data = scope ? this.optionPanes?.[scope]?.positionData : this.chartPositionData;
    const symbol = scope ? this.optionPanes?.[scope]?.contract?.symbol : this.chartOrderTarget().symbol;
    const positions = data?.netQuantity && data.avgEntryPrice
      ? [{ symbol, netQty: data.netQuantity, avgPrice: data.avgEntryPrice }]
      : [];
    try {
      controller.reconcile(holder.lastOrders || [], positions);
      const ltp = scope
        ? this.optionPanes?.[scope]?.candles?.at(-1)?.close
        : this.chartLastPrice;
      if (Number.isFinite(ltp)) controller.onLtp(symbol, ltp);
    } catch (error) {
      console.error('[Chart] trade layer failed', error);
    }
    return true;
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
    try { s.controller.onLtp(this.chartOrderTarget().symbol, this.chartLastPrice); } catch (_) { /* disposed */ }
  },

  async refreshOrderLines() {
    const s = this.orderLinesState();
    const state = this.chartState;
    if (!s.controller || !state) return;
    const target = this.chartOrderTarget();

    let rows;
    try {
      const res = await api.request(`/orders?symbol=${encodeURIComponent(target.symbol)}&status=open,pending`);
      rows = res.data || [];
    } catch (_) {
      // No orders.view permission, most likely - a read-only chart is still fully usable.
      return;
    }
    // A newer request finishing first (chart torn down mid-flight) must not draw onto a
    // detached controller.
    if (s !== this.orderLinesState() || !s.controller) return;

    // Only orders on THIS chart's own instrument (the future, for an index) - an option leg
    // carries a different symbol and belongs on its own pane's price scale.
    const { orders, groups } = this.groupChartOrders(rows
      .filter((o) => (o.exchange || '').toUpperCase() === (target.exchange || '').toUpperCase()
        && (o.symbol || '').toUpperCase() === target.symbol.toUpperCase()));
    s.lastOrders = orders;
    s.groups = groups;
    this.reconcileTrade(undefined);

    // Same cadence refreshes the position marker, as on the option panes: a fill that lands after
    // the order was sent (market orders, a resting one filling later) otherwise never showed.
    if (typeof this.loadChartPosition === 'function') this.loadChartPosition();
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
    this.bindOrderLineGestures(pane.chart, () => this.refreshPaneOrderLines(key), key);
    if (typeof this.redrawChartLines === 'function') this.redrawChartLines(key);
    this.refreshPaneOrderLines(key);
    pane.orderLines.refreshTimer = setInterval(() => this.refreshPaneOrderLines(key), ORDER_LINES_FALLBACK_MS);
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
      const res = await api.request(`/orders?symbol=${encodeURIComponent(pane.contract.symbol)}&status=open,pending`);
      rows = res.data || [];
    } catch (_) {
      return; // no orders.view permission, most likely - the pane is still fully usable
    }
    // A newer build of this pane (symbol/timeframe switch, or the pane torn down) must not draw
    // onto a detached controller.
    if (this.optionPanes?.[key] !== pane || pane.orderLines?.controller !== controller) return;

    const { orders, groups } = this.groupChartOrders(rows
      .filter((o) => (o.exchange || '').toUpperCase() === (pane.contract.exchange || '').toUpperCase()
        && (o.symbol || '').toUpperCase() === pane.contract.symbol.toUpperCase()));
    pane.orderLines.lastOrders = orders;
    pane.orderLines.groups = groups;
    this.reconcileTrade(key);

    // Same poll cadence refreshes the position line - a fill or a manual close elsewhere should
    // show up on the chart within one cycle, not only on the next full pane rebuild.
    if (typeof this.loadPanePosition === 'function') this.loadPanePosition(key);
  },
});
