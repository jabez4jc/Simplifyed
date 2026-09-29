/**
 * A fake OpenAlgo broker.
 *
 * Every broker call in this app funnels through `openalgoClient.request(instance, endpoint,
 * data, method)` - ping, funds, orderbook, positionbook, quotes, placesmartorder, all of it - so
 * replacing that single method substitutes the whole upstream. The layers ABOVE it (retry,
 * position reconciliation, order-id resolution) still run for real; the layers below it
 * (throttle, concurrency gate, undici) are skipped, which is what makes route tests fast.
 *
 * Those skipped layers are not untested - Test/unit/smart-order-rate-limit.test.js and
 * Test/unit/openalgo-retry.test.js drive them directly against a fresh OpenAlgoClient.
 */

import openalgoClient from '../../src/integrations/openalgo/client.js';
import { OpenAlgoError } from '../../src/core/errors.js';

/** Shapes copied from OpenAlgo's actual responses, so route code parses them as it would live. */
const DEFAULTS = {
  ping: { status: 'success', data: { broker: 'zerodha', message: 'pong' } },
  analyzer: { status: 'success', data: { mode: 'live', analyze_mode: false, total_logs: 0 } },
  'analyzer/toggle': { status: 'success', data: { mode: 'analyze', analyze_mode: true } },
  funds: {
    status: 'success',
    data: {
      availablecash: '100000.00',
      collateral: '0.00',
      m2mrealized: '0.00',
      m2munrealized: '0.00',
      utiliseddebits: '0.00',
    },
  },
  holdings: { status: 'success', data: { holdings: [], statistics: {} } },
  orderbook: { status: 'success', data: { orders: [], statistics: {} } },
  tradebook: { status: 'success', data: [] },
  positionbook: { status: 'success', data: [] },
  openposition: { status: 'success', data: { quantity: 0 } },
  quotes: {
    status: 'success',
    data: { ltp: 100.5, open: 99, high: 101, low: 98.5, prev_close: 99.5, volume: 12345, bid: 100.4, ask: 100.6 },
  },
  depth: {
    status: 'success',
    data: {
      ltp: 100.5, open: 99, high: 101, low: 98.5, prev_close: 99.5, volume: 12345,
      bids: [{ price: 100.4, quantity: 50 }],
      asks: [{ price: 100.6, quantity: 50 }],
    },
  },
  placesmartorder: { status: 'success', orderid: 'TEST-ORDER-1' },
  placeorder: { status: 'success', orderid: 'TEST-ORDER-1' },
  modifyorder: { status: 'success', orderid: 'TEST-ORDER-1' },
  cancelorder: { status: 'success', orderid: 'TEST-ORDER-1' },
  cancelallorder: { status: 'success', data: { canceled_orders: [], failed_cancels: [] } },
  closeposition: { status: 'success', message: 'All positions closed' },
  orderstatus: { status: 'success', data: { order_status: 'complete', average_price: 100.5, quantity: 1 } },
  history: { status: 'success', data: [] },
  expiry: { status: 'success', data: [] },
  optionchain: { status: 'success', data: {} },
  search: { status: 'success', data: [] },
  symbol: { status: 'success', data: {} },
  intervals: { status: 'success', data: { seconds: [], minutes: ['1m', '5m'], days: ['D'] } },
};

/**
 * Install the fake. Returns a handle for scripting responses and reading back what was called.
 * Call `restore()` in an `after()` hook - the client is a module singleton shared by every
 * import in the process, so a fake left installed leaks into the rest of the file.
 */
export function installFakeOpenAlgo() {
  const original = openalgoClient.request;
  const calls = [];
  const overrides = new Map();

  openalgoClient.request = async (instance, endpoint, data = {}, method = 'POST', options = {}) => {
    calls.push({ instance, endpoint, data, method, options });

    const override = overrides.get(endpoint);
    if (override) {
      const result = typeof override === 'function' ? await override(data, instance) : override;
      if (result instanceof Error) throw result;
      return result;
    }

    if (endpoint in DEFAULTS) return structuredClone(DEFAULTS[endpoint]);

    // An unmapped endpoint is a test-authoring bug, not a broker condition. Fail loudly rather
    // than returning a plausible-looking empty success that quietly makes an assertion pass.
    throw new Error(
      `fake-openalgo: no canned response for '${endpoint}'. Add it to DEFAULTS or script it with broker.on('${endpoint}', ...).`
    );
  };

  return {
    calls,

    /** Script one endpoint: a value, an Error to throw, or a fn(data, instance) => value. */
    on(endpoint, response) {
      overrides.set(endpoint, response);
      return this;
    },

    /** Make an endpoint fail the way a real broker rejection arrives. */
    fail(endpoint, message = 'Broker rejected the request', statusCode = 502) {
      overrides.set(endpoint, new OpenAlgoError(message, endpoint, statusCode));
      return this;
    },

    /** Every call made to one endpoint, in order. */
    callsTo(endpoint) {
      return calls.filter((c) => c.endpoint === endpoint);
    },

    /** How many times an endpoint was hit - the assertion for "we did not double-send". */
    countOf(endpoint) {
      return this.callsTo(endpoint).length;
    },

    reset() {
      calls.length = 0;
      overrides.clear();
      return this;
    },

    restore() {
      openalgoClient.request = original;
    },
  };
}

/**
 * A fake broker at the HTTP layer.
 *
 * The TradingView broadcast path does NOT go through openalgoClient - it builds the broker URL
 * itself and calls global fetch (tradingview-broadcast.service._postJson), so `installFakeOpenAlgo`
 * cannot see it. Stubbing fetch covers that path, and gives the strongest form of the security
 * assertion this endpoint needs: an unauthorised alert must produce ZERO outbound requests, not
 * merely zero successful ones.
 *
 * Without this the tests still "pass" - the fixture host names do not resolve - but they pass for
 * the wrong reason, they take a retry-backoff second each, and they would stop proving anything
 * the moment a fixture pointed at a reachable host.
 */
export function installFakeFetch({ status = 200, body = { status: 'success', orderid: 'TEST-BROADCAST-1' } } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  let response = { status, body };

  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      body: typeof options.body === 'string' ? tryParse(options.body) : options.body,
    });
    const payload = JSON.stringify(response.body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  };

  return {
    calls,
    /** Every outbound call whose URL contains this fragment - e.g. 'placesmartorder'. */
    callsTo: (fragment) => calls.filter((c) => c.url.includes(fragment)),
    countOf(fragment) { return this.callsTo(fragment).length; },
    respondWith(next) { response = { status: 200, ...next }; return this; },
    reset() { calls.length = 0; return this; },
    restore() { globalThis.fetch = original; },
  };
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
