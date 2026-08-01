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
 * fetch is stubbed rather than talking to a broker; skipRateLimit/skipMarketCheck bypass the
 * throttle and blackout gates so only the retry decision is under test.
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
    client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true, skipMarketCheck: true }),
    /Invalid symbol/
  );
  assert.strictEqual(calls.count, 1, 'a deterministic rejection must be sent exactly once');
});

test('a rate-limit rejection IS retried', async () => {
  const { client, calls } = clientWithResponse(() =>
    jsonResponse(200, { status: 'error', message: 'Rate limit exceeded' })
  );

  await assert.rejects(
    client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true, skipMarketCheck: true })
  );
  assert.ok(calls.count > 1, `rate limiting must be retried, got ${calls.count} attempt(s)`);
});

test('a 5xx is still retried, a 4xx still is not', async () => {
  const server = clientWithResponse(() => jsonResponse(503, { status: 'error', message: 'upstream down' }));
  await assert.rejects(
    server.client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true, skipMarketCheck: true })
  );
  assert.ok(server.calls.count > 1, 'a 5xx is transient and must be retried');

  const client4xx = clientWithResponse(() => jsonResponse(403, { status: 'error', message: 'Invalid openalgo apikey' }));
  await assert.rejects(
    client4xx.client.request(instance, 'quotes', {}, 'POST', { skipRateLimit: true, skipMarketCheck: true })
  );
  assert.strictEqual(client4xx.calls.count, 1, 'a 4xx must not be retried');
});
