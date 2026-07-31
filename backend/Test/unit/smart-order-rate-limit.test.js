import assert from 'assert';
import test from 'node:test';
import { OpenAlgoClient } from '../../src/integrations/openalgo/client.js';

/**
 * OpenAlgo caps /placesmartorder at 2 requests/sec - a stricter limit than plain /placeorder's
 * 10/sec. Every order this app places goes through placesmartorder (order-placement.service.js
 * always reconciles against the open position via `position_size`), but the internal throttle
 * used ONE shared `ordersPerSecondLimit` (10) for both endpoints - applying the lenient figure
 * to what is, in every call site this app has, exclusively smart-order traffic. A burst could
 * legally be sent by this app faster than OpenAlgo actually accepts it.
 *
 * `_throttle` is exercised directly against a fresh client instance (not the shared singleton,
 * so this test's rate-limit state can't leak into or be polluted by any other test) rather than
 * through the full `request()` path, which would need a live instance and network I/O.
 */

const instance = { id: 'test-instance', host_url: 'http://localhost:1', api_key: 'x' };

test('defaults: smart orders capped tighter than plain orders', () => {
  const client = new OpenAlgoClient();
  assert.strictEqual(client.smartOrdersPerSecondLimit, 2);
  assert.strictEqual(client.ordersPerSecondLimit, 10);
});

/**
 * `_throttle` is a pure GATE: it reads `state.orders` / `this.globalOrders` but never writes to
 * them - that bookkeeping happens in `_executeWithConcurrency`, a different function, once a
 * request actually goes out. So exercising the gate on its own means recording each "order
 * placed" the same way that function does, immediately after `_throttle` clears it.
 */
function recordOrderSent(client) {
  const now = Date.now();
  const state = client._getRateState(client._instanceKey(instance));
  state.orders.push(now);
  client.globalOrders.push(now);
}

test('a third placesmartorder call within the same second is actually throttled', async () => {
  const client = new OpenAlgoClient();
  const elapsed = async () => {
    const start = Date.now();
    await client._throttle(instance, 'placesmartorder', true);
    recordOrderSent(client);
    return Date.now() - start;
  };

  assert.ok((await elapsed()) < 200, 'call 1 must not wait');
  assert.ok((await elapsed()) < 200, 'call 2 must not wait');
  // The 2/sec cap is now full; the 3rd call must sit in the throttle loop until the window
  // clears (~1s), not sail through as it would under the old shared 10/sec limit.
  assert.ok((await elapsed()) > 700, 'call 3 must be throttled toward the smart-order cap');
}, 5000);

test('plain placeorder is NOT held to the smart-order cap', async () => {
  const client = new OpenAlgoClient();
  const elapsed = async () => {
    const start = Date.now();
    await client._throttle(instance, 'placeorder', true);
    recordOrderSent(client);
    return Date.now() - start;
  };

  // Three calls would have throttled placesmartorder (cap 2); placeorder's cap is 10, so all
  // three must sail through immediately.
  for (let i = 0; i < 3; i += 1) {
    assert.ok((await elapsed()) < 200, `placeorder call ${i + 1} must not wait`);
  }
}, 5000);

test('a non-order endpoint is never subject to the orders cap at all', async () => {
  const client = new OpenAlgoClient();
  const start = Date.now();
  for (let i = 0; i < 5; i += 1) {
    await client._throttle(instance, 'quotes', false);
  }
  assert.ok(Date.now() - start < 200, 'quote calls must not be gated by either order limit');
}, 5000);
