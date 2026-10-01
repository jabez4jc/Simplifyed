import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Which order rows become lines on the chart. A line is something a drag or its ✕ acts on at the
 * broker, so a row the broker never acknowledged, or one with no price to rest at, must not be one.
 * Browser module, evaluated against a stub like the other chart tests.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { DashboardApp: function DashboardApp() {} };
new Function('DashboardApp', fs.readFileSync(path.join(dir, '../../public/js/dashboard-chart-orders.js'), 'utf8'))(sandbox.DashboardApp);
const app = new sandbox.DashboardApp();

const row = (over) => ({
  id: 1, instance_id: 1, instance_name: 'A', instance_analyzer: 1, order_id: '111', request_id: 'chart-9-BUY-LIMIT-1-1',
  side: 'BUY', order_type: 'LIMIT', quantity: 65, price: 22400, trigger_price: 0, ...over,
});

test('one chart order on two accounts is one line; unacknowledged and market rows are no line at all', () => {
  const { orders, groups } = app.groupChartOrders([
    row({}),
    row({ id: 2, instance_id: 2, instance_name: 'B', order_id: '222', request_id: 'chart-9-BUY-LIMIT-1-2', quantity: 325 }),
    row({ id: 3, order_id: null, request_id: 'x' }),
    row({ id: 4, order_id: '444', order_type: 'MARKET', price: 0, request_id: 'y' }),
    row({ id: 5, order_id: '555', side: 'SELL', order_type: 'SL-M', price: 22300, trigger_price: 22310, request_id: 'z' }),
  ]);
  assert.deepStrictEqual(orders.map((o) => [o.id, o.side, o.type, o.qty, o.price, o.triggerPrice]), [
    ['1', 'BUY', 'LIMIT', 390, 22400, undefined],
    ['5', 'SELL', 'SL-M', 65, 22300, 22310],
  ]);
  assert.deepStrictEqual(groups.get('1').ids, [1, 2]);
});

/**
 * An index chart trades its future, which sits a basis away from the index. Levels are the
 * index's; orders, lines and the position are the future's, converted by the live basis.
 */
function indexChart({ futLtp = 22520, idxLtp = 22422, quoteAge = 0 } = {}) {
  const sb = { DashboardApp: function DashboardApp() {}, Utils: { formatNumber: (n) => String(n), escapeHTML: String } };
  const keys = Object.keys(sb);
  for (const f of ['dashboard-chart-orders.js', 'dashboard-chart.js']) {
    new Function(...keys, fs.readFileSync(path.join(dir, '../../public/js', f), 'utf8'))(...keys.map((k) => sb[k]));
  }
  const a = new sb.DashboardApp();
  a.chartState = { exchange: 'NSE_INDEX', symbol: 'NIFTY', qty: 1 };
  a.chartFuture = { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT', tickSize: 0.1, lotsize: 65, isRow: false };
  a.chartLastPrice = idxLtp;
  a.chartFutureLtp = futLtp;
  a.chartFutureLtpAt = Date.now() - quoteAge;
  a.chartTradeMode = 'FUTURES';
  a.chartTradeInfo = { symbol: { mode: 'futures' } };
  return a;
}

test('an index level goes to the future at the same distance from its market, and its lines come back to that level', () => {
  const a = indexChart();
  assert.strictEqual(a.indexToFuturePrice(22392.4), 22490.4);
  assert.strictEqual(a.futureToIndexPrice(22490.4), 22392.4);

  const items = a.contextMenuItemsFor(22468.7);
  const sellLimit = items.find((i) => i.side === 'SELL' && i.orderType === 'LIMIT');
  assert.strictEqual(sellLimit.price, 22566.7, 'above the future\'s market, so it rests');
  assert.strictEqual(sellLimit.level, 22468.7);
  assert.strictEqual(sellLimit.crosses, false);
  assert.match(sellLimit.label, /@ 22468\.7 → FUT 22566\.7$/);

  const drawn = [];
  a._orderLines = { controller: { reconcile: (orders, positions) => drawn.push({ orders, positions }), onLtp() {} },
    lastOrders: [{ id: '1', side: 'BUY', type: 'LIMIT', price: 22490.4 }, { id: '2', side: 'SELL', type: 'SL-M', price: 22300, triggerPrice: 22310 }] };
  a.chartPositionData = { netQuantity: 65, avgEntryPrice: 22598 };
  a.reconcileTrade(undefined);
  assert.deepStrictEqual(drawn[0].orders.map((o) => [o.price, o.triggerPrice]).map(([p, t]) => [Math.round(p * 10) / 10, t && Math.round(t * 10) / 10]),
    [[22392.4, undefined], [22202, 22212]]);
  assert.strictEqual(drawn[0].positions[0].avgPrice, 22500);
});

test('with no live future price nothing priced is offered, sent or drawn on an index chart', () => {
  const a = indexChart({ quoteAge: 120000 });
  assert.strictEqual(a.indexToFuturePrice(22392.4), null);
  const priced = a.contextMenuItemsFor(22392.4).filter((i) => i.orderType !== 'MARKET');
  assert.ok(priced.every((i) => i.enabled === false), 'every priced item is refused');
  const drawn = [];
  a._orderLines = { controller: { reconcile: (orders, positions) => drawn.push({ orders, positions }), onLtp() {} },
    lastOrders: [{ id: '1', side: 'BUY', type: 'LIMIT', price: 22490.4 }] };
  a.reconcileTrade(undefined);
  assert.deepStrictEqual(drawn[0], { orders: [], positions: [] });
});
