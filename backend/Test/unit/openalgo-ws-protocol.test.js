import assert from 'assert';
import test from 'node:test';
import {
  quoteSubscriptionFrames,
  depthSubscriptionFrames,
  marketDataPayload,
  orderUpdateKey,
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
