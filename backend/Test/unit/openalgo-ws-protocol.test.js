import assert from 'assert';
import test from 'node:test';
import {
  quoteSubscriptionFrames,
  depthSubscriptionFrames,
  marketDataPayload,
  orderUpdateKey,
  routeMarketData,
} from '../../src/services/openalgo-ws.service.js';

/**
 * Frames and payloads as the OpenAlgo v1 WebSocket spec defines them
 * (openalgo-docs/api-documentation/v1/websockets.md).
 */

test('new symbols go out as ONE batched Quote subscribe, not a frame per symbol', () => {
  const frames = quoteSubscriptionFrames(new Set(), new Set(['NSE|RELIANCE', 'NSE|INFY']));
  assert.deepStrictEqual(frames, [{
    action: 'subscribe',
    mode: 'Quote',
    symbols: [{ exchange: 'NSE', symbol: 'RELIANCE' }, { exchange: 'NSE', symbol: 'INFY' }],
  }]);
});

test('a symbol dropped from the watchlist is unsubscribed, with the mode on each symbol', () => {
  const frames = quoteSubscriptionFrames(new Set(['NSE|RELIANCE', 'NSE|INFY']), new Set(['NSE|INFY']));
  assert.deepStrictEqual(frames, [{
    action: 'unsubscribe',
    symbols: [{ exchange: 'NSE', symbol: 'RELIANCE', mode: 'Quote' }],
  }]);
});

test('an unchanged set sends nothing', () => {
  const same = new Set(['NSE|INFY']);
  assert.deepStrictEqual(quoteSubscriptionFrames(same, new Set(same)), []);
});

test('depth subscribes use the spec `depth` field, grouped per level, skipping ones already held', () => {
  const desired = new Map([
    ['NSE|INFY', { exchange: 'NSE', symbol: 'INFY', depth_level: 5 }],
    ['NSE|TCS', { exchange: 'NSE', symbol: 'TCS', depth_level: 20 }],
    ['NSE|SBIN', { exchange: 'NSE', symbol: 'SBIN', depth_level: 5 }],
  ]);
  const frames = depthSubscriptionFrames(new Map([['NSE|SBIN', 5]]), desired);
  assert.deepStrictEqual(frames, [
    { action: 'subscribe', mode: 'Depth', depth: 5, symbols: [{ exchange: 'NSE', symbol: 'INFY' }] },
    { action: 'subscribe', mode: 'Depth', depth: 20, symbols: [{ exchange: 'NSE', symbol: 'TCS' }] },
  ]);
});

test('market_data takes symbol/exchange from the envelope, where the spec puts them', () => {
  const payload = marketDataPayload({
    type: 'market_data', symbol: 'reliance', exchange: 'nse', mode: 2,
    data: { ltp: 1424, open: 1415 },
  });
  assert.strictEqual(payload.symbol, 'RELIANCE');
  assert.strictEqual(payload.exchange, 'NSE');
  assert.strictEqual(payload.ltp, 1424);
  assert.strictEqual(payload.mode, 2);
});

test('non market_data frames produce no payload', () => {
  assert.strictEqual(marketDataPayload({ type: 'auth', status: 'success' }), null);
  assert.strictEqual(marketDataPayload(null), null);
});

test('order updates dedupe on orderid + order_status + filled_quantity, so a partial fill is not a duplicate of the fill', () => {
  const partial = { orderid: '1', order_status: 'open', filled_quantity: 5 };
  const full = { orderid: '1', order_status: 'complete', filled_quantity: 10 };
  assert.strictEqual(orderUpdateKey(partial), orderUpdateKey({ ...partial }));
  assert.notStrictEqual(orderUpdateKey(partial), orderUpdateKey(full));
});

test('a quote frame that carries a book is still a quote - BTCUSDFUT on Delta Exchange', () => {
  // Captured live: Delta attaches `depth` to Quote-mode (mode 2) frames for BTCUSDFUT only.
  const btc = {
    type: 'market_data', symbol: 'BTCUSDFUT', exchange: 'CRYPTO', mode: 2,
    data: { ltp: 84350.5, bid_price: 84353.5, ask_price: 84354, depth: { buy: [{ price: 84237, quantity: 1 }], sell: [] } },
  };
  const routed = routeMarketData(btc);
  assert.strictEqual(routed.quote?.ltp, 84350.5, 'the price must reach the quote cache');
  assert.ok(routed.depth?.depth, 'and the book the depth cache');

  const eth = { type: 'market_data', symbol: 'ETHUSDFUT', exchange: 'CRYPTO', mode: 2, data: { ltp: 2739.5 } };
  assert.deepStrictEqual([!!routeMarketData(eth).quote, routeMarketData(eth).depth], [true, null]);

  const depthOnly = { type: 'market_data', symbol: 'NIFTY', exchange: 'NSE_INDEX', mode: 3, data: { ltp: 1, depth: { buy: [], sell: [] } } };
  assert.deepStrictEqual([routeMarketData(depthOnly).quote, !!routeMarketData(depthOnly).depth], [null, true]);

  assert.deepStrictEqual(routeMarketData({ type: 'order_update' }), { quote: null, depth: null });
});
