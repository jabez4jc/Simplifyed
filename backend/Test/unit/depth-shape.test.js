import assert from 'assert';
import test from 'node:test';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';

/**
 * OpenAlgo reports depth in two DIFFERENT shapes depending on transport:
 *
 *   WebSocket push   data.depth.buy[] / data.depth.sell[]
 *   REST /depth      data.bids[]      / data.asks[]
 *
 * `_extractBestBidAskFromDepth` feeds both `limit-price.service.js` and `order-retry.service.js`
 * for marketable-LIMIT synthesis, but used to recognise only the WebSocket shape. Every REST
 * fallback (WS depth unavailable or too slow to arrive) therefore computed bid=null/ask=null
 * even though the broker returned real numbers - silently degrading to a plain-quote price
 * instead of the tighter, depth-derived one, for no reason other than a missed key name.
 */

const extract = (depth) => marketDataFeedService._extractBestBidAskFromDepth(depth);

test('the REST shape (bids/asks) is read correctly', () => {
  const rest = {
    ltp: 769.6,
    asks: [{ price: 769.6, quantity: 767 }, { price: 769.65, quantity: 115 }],
    bids: [{ price: 769.4, quantity: 886 }, { price: 769.35, quantity: 212 }],
  };
  assert.deepStrictEqual(extract(rest), { bid: 769.4, ask: 769.6 });
});

test('the WebSocket shape (depth.buy/sell) still works', () => {
  const ws = {
    depth: {
      buy: [{ price: 1423.9, quantity: 50 }],
      sell: [{ price: 1424.1, quantity: 47 }],
    },
  };
  assert.deepStrictEqual(extract(ws), { bid: 1423.9, ask: 1424.1 });
});

test('a flattened buy/sell shape at the top level also works', () => {
  const flat = { buy: [{ price: 100 }], sell: [{ price: 101 }] };
  assert.deepStrictEqual(extract(flat), { bid: 100, ask: 101 });
});

test('missing or empty depth yields null, not zero or a throw', () => {
  assert.deepStrictEqual(extract({}), { bid: null, ask: null });
  assert.deepStrictEqual(extract({ bids: [], asks: [] }), { bid: null, ask: null });
  assert.deepStrictEqual(extract(null), { bid: null, ask: null });
  assert.deepStrictEqual(extract(undefined), { bid: null, ask: null });
});

test('a zero or negative price is treated as unusable, not a real touch', () => {
  assert.deepStrictEqual(extract({ bids: [{ price: 0 }], asks: [{ price: -5 }] }), { bid: null, ask: null });
});
