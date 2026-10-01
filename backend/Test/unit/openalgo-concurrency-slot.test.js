import assert from 'assert';
import test from 'node:test';
import { OpenAlgoClient } from '../../src/integrations/openalgo/client.js';

/**
 * `currentTasks` used to be incremented in `_waitForConcurrency` and only decremented in a
 * try/finally one level up in `_executeWithConcurrency`. The token-bucket wait that follows the
 * increment can throw (a 429 after 100 retries), and that throw happened between the increment
 * and the caller's try, so the slot leaked forever. After `maxConcurrentTasks` such leaks, every
 * call through the limiter - positionbook, quotes, orderbook, tradebook - spun forever in
 * `_waitForConcurrencySlot`'s wait loop.
 */
const instance = { id: 'test-instance-c2', host_url: 'http://localhost:1', api_key: 'x' };

test('a concurrency slot released on throw does not leak, even 11 times in a row', async () => {
  const client = new OpenAlgoClient();
  // One slot: if a single leak slipped through, the next call would hang in
  // _waitForConcurrencySlot's while loop forever instead of resolving.
  client.maxConcurrentTasks = 1;

  let calls = 0;
  client._waitForRateBucket = async () => {
    calls += 1;
    if (calls <= 11) {
      const err = new Error('Rate bucket throttle for orders');
      err.statusCode = 429;
      throw err;
    }
  };
  client._makeRequest = async () => ({ status: 'success' });

  for (let i = 0; i < 11; i += 1) {
    await assert.rejects(
      () => client._executeWithConcurrency(instance, 'placesmartorder', 'POST', 'http://x', {}, true),
      /Rate bucket throttle/
    );
  }

  const result = await client._executeWithConcurrency(instance, 'placesmartorder', 'POST', 'http://x', {}, true);
  assert.deepStrictEqual(result, { status: 'success' });
  assert.strictEqual(client.currentTasks.get(client._instanceKey(instance)) || 0, 0, 'slot must be released after the final call too');
}, 2000);

test('the concurrency limit is per instance, not global', async () => {
  const client = new OpenAlgoClient();
  client.maxConcurrentTasks = 1;
  const instanceA = { id: 'inst-a', host_url: 'http://localhost:1', api_key: 'x' };
  const instanceB = { id: 'inst-b', host_url: 'http://localhost:2', api_key: 'x' };

  let releaseA;
  const aInFlight = new Promise((resolve) => { releaseA = resolve; });
  client._waitForRateBucket = async () => {};
  client._makeRequest = async (url) => {
    if (url === 'http://a') {
      await aInFlight;
    }
    return { status: 'success' };
  };

  const pendingA = client._executeWithConcurrency(instanceA, 'quotes', 'GET', 'http://a', {}, false);
  // Instance A now holds its only slot. A call to instance B must not wait on it.
  const bResult = await Promise.race([
    client._executeWithConcurrency(instanceB, 'quotes', 'GET', 'http://b', {}, false),
    new Promise((_, reject) => setTimeout(() => reject(new Error('instance B was blocked by instance A')), 500)),
  ]);
  assert.deepStrictEqual(bResult, { status: 'success' });

  releaseA();
  await pendingA;
}, 2000);
