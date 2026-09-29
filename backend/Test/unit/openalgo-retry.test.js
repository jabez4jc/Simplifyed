import assert from 'assert';
import test from 'node:test';
import { OpenAlgoClient } from '../../src/integrations/openalgo/client.js';

/**
 * OpenAlgo answers most rejections with HTTP 200 and `{"status":"error"}` in the body, not with a
 * 4xx. The retry loop only skipped 4xx, so those deterministic refusals were re-sent as if they
 * were network blips: the same request, the same rejection, extra round-trips on the order path.
 *
 * Rate limiting is the exception worth retrying - the next attempt sits behind a backoff.
 *
 * fetch is stubbed rather than talking to a broker; skipRateLimit bypasses the throttle so only
 * the retry decision is under test.
 */

const instance = { id: 'test-instance', host_url: 'http://localhost:1', api_key: 'x' };

function clientWithResponse(makeResponse) {
  const client = new OpenAlgoClient();
  client.nonCriticalRetries = 2; // allow up to 3 attempts, so a retry is visible if it happens
  client.nonCriticalRetryDelay = 1;
  const calls = { count: 0 };
  globalThis.fetch = async () => {
    calls.count += 1;
    return makeResponse();
  };
  return { client, calls };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: () => 'application/json' },
  clone() { return this; },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

test('a broker rejection sent as HTTP 200 + status:error is not retried', async () => {
  const { client, calls } = clientWithResponse(() =>
    jsonResponse(200, { status: 'error', message: 'Invalid symbol' })
  );

  await assert.rejects(
    client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true }),
    /Invalid symbol/
  );
  assert.strictEqual(calls.count, 1, 'a deterministic rejection must be sent exactly once');
});

test('a rate-limit rejection IS retried', async () => {
  const { client, calls } = clientWithResponse(() =>
    jsonResponse(200, { status: 'error', message: 'Rate limit exceeded' })
  );

  await assert.rejects(
    client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true })
  );
  assert.ok(calls.count > 1, `rate limiting must be retried, got ${calls.count} attempt(s)`);
});

test('a background call to an unreachable instance (5xx) fails fast - the circuit breaker, not a retry loop, handles it', async () => {
  const inst = { ...instance, id: 'test-instance-5xx' };
  const server = clientWithResponse(() => jsonResponse(503, { status: 'error', message: 'upstream down' }));
  await assert.rejects(server.client.request(inst, 'quotes', {}, 'POST', { skipRateLimit: true }));
  assert.strictEqual(server.calls.count, 1, 'the next poll tick is the retry; hammering a dead host is the error flood');
  server.client.forceResetInstanceHealth(inst.id);
});

test('a critical call still retries a 5xx, and a 4xx is never retried', async () => {
  const inst = { ...instance, id: 'test-instance-critical' };
  const server = clientWithResponse(() => jsonResponse(503, { status: 'error', message: 'upstream down' }));
  server.client.criticalRetries = 2;
  server.client.criticalRetryDelay = 1;
  await assert.rejects(server.client.request(inst, 'cancelorder', {}, 'POST', { skipRateLimit: true, isCritical: true }));
  assert.ok(server.calls.count > 1, 'a user action gets its retries');
  server.client.forceResetInstanceHealth(inst.id);

  const client4xx = clientWithResponse(() => jsonResponse(403, { status: 'error', message: 'Invalid openalgo apikey' }));
  await assert.rejects(
    client4xx.client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true })
  );
  assert.strictEqual(client4xx.calls.count, 1, 'a 4xx must not be retried');
});

test('an HTTP 429 with a bare "2 per 1 second" body IS retried', async () => {
  // Observed live on the Fyers instances: OpenAlgo's limiter says only "2 per 1 second". It
  // matched no rate-limit wording and every 4xx was final, so orders were dropped outright.
  const { client, calls } = clientWithResponse(() => jsonResponse(429, { message: '2 per 1 second' }));

  await assert.rejects(client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true }));
  assert.ok(calls.count > 1, `a 429 must be retried, was sent ${calls.count} time(s)`);
});

test('a retried smart order that returns success with no order id gets its id from the order book', async () => {
  // Observed live on Fyers: attempt 1 timed out but reached the broker; the retry found the
  // target already met, placed nothing, and returned success with no order id.
  const client = new OpenAlgoClient();
  client.criticalRetries = 1;
  client.criticalRetryDelay = 1;
  client.getPositionBook = async () => [];
  client.getOrderBook = async () => ({ orders: [{ orderid: 'LANDED-1', symbol: 'NATURALGAS27OCT26FUT', exchange: 'MCX', action: 'BUY', product: 'MIS', quantity: 1250, order_status: 'complete', timestamp: new Date().toISOString() }] });
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
    return jsonResponse(200, { status: 'success', message: 'No action needed' });
  };
  const res = await client.request(instance, 'placesmartorder',
    { symbol: 'NATURALGAS27OCT26FUT', exchange: 'MCX', action: 'BUY', quantity: 1250, position_size: 1250, pricetype: 'LIMIT', price: 300 },
    'POST', { skipRateLimit: true, isCritical: true });
  assert.strictEqual(res.orderid, 'LANDED-1');
});

test('broker order timestamps are read as IST whatever the server timezone', async () => {
  const { parseBrokerTimestamp } = await import('../../src/integrations/openalgo/client.js');
  assert.strictEqual(parseBrokerTimestamp('2026-09-29 10:52:02'), Date.UTC(2026, 8, 29, 5, 22, 2));
  assert.strictEqual(parseBrokerTimestamp('2026-09-29T05:22:02.000Z'), Date.UTC(2026, 8, 29, 5, 22, 2));
  assert.strictEqual(parseBrokerTimestamp(''), 0);
  assert.strictEqual(parseBrokerTimestamp('garbage'), 0);
});

function timeoutThenSuccessClient(orderBook) {
  const client = new OpenAlgoClient();
  client.criticalRetries = 1;
  client.criticalRetryDelay = 1;
  client.getPositionBook = async () => [{ symbol: 'NATURALGAS27OCT26FUT', exchange: 'MCX', quantity: 1250 }];
  client.getOrderBook = async () => orderBook;
  const sent = { count: 0 };
  globalThis.fetch = async () => {
    sent.count += 1;
    if (sent.count === 1) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
    return jsonResponse(200, { status: 'success', orderid: 'SECOND-ORDER' });
  };
  return { client, sent };
}

const EXIT = { symbol: 'NATURALGAS27OCT26FUT', exchange: 'MCX', action: 'SELL', product: 'MIS', quantity: 1250, position_size: 0, pricetype: 'LIMIT', price: 299 };

test('a timed-out exit that DID fill is confirmed from the order book and never re-sent', async () => {
  // Observed live on Fyers: the retry of a filled exit sold again because the position book
  // still lagged - flat became short.
  const { client, sent } = timeoutThenSuccessClient({ orders: [
    { orderid: 'FILLED-EXIT', ...EXIT, order_status: 'complete', timestamp: new Date().toISOString() },
  ] });
  const res = await client.request(instance, 'placesmartorder', EXIT, 'POST', { skipRateLimit: true, isCritical: true });
  assert.strictEqual(res.orderid, 'FILLED-EXIT');
  assert.strictEqual(sent.count, 1, 'the order must not be sent a second time');
});

test('a timed-out order that never reached the book is retried', async () => {
  const { client, sent } = timeoutThenSuccessClient({ orders: [
    // An identical exit from two minutes ago must not be mistaken for this one.
    { orderid: 'OLD-EXIT', ...EXIT, order_status: 'complete', timestamp: new Date(Date.now() - 120000).toISOString() },
  ] });
  client._awaitOrderInBook = ((orig) => (inst, data, since) => orig.call(client, inst, data, since, { checks: 1, delayMs: 1 }))(client._awaitOrderInBook);
  const res = await client.request(instance, 'placesmartorder', EXIT, 'POST', { skipRateLimit: true, isCritical: true });
  assert.strictEqual(res.orderid, 'SECOND-ORDER');
  assert.strictEqual(sent.count, 2);
});

test('if the order book cannot be read after a failed order, the order is NOT re-sent - outcome unknown', async () => {
  // Seen live on Kotak: a stalled exit had filled, the order book also timed out, and the
  // retry sold a second time - leaving a short where the position should have been flat.
  const { client, sent } = timeoutThenSuccessClient(null);
  client.getOrderBook = async () => { throw new Error('Request timeout after 15000ms'); };
  client._awaitOrderInBook = ((orig) => (inst, data, since) => orig.call(client, inst, data, since, { checks: 2, delayMs: 1 }))(client._awaitOrderInBook);
  await assert.rejects(
    client.request(instance, 'placesmartorder', EXIT, 'POST', { skipRateLimit: true, isCritical: true }),
    (err) => err.code === 'ORDER_OUTCOME_UNKNOWN' && /check the order book/.test(err.message)
  );
  assert.strictEqual(sent.count, 1, 'an order with an unknown outcome must never be re-sent');
});
