import assert from 'assert';
import test from 'node:test';
import {
  InstanceHealthTrackerService,
  backoffMs,
  isUnreachableError,
  MAX_UNREACHABLE_BACKOFF_MS,
} from '../../src/integrations/openalgo/instance-health-tracker.service.js';
import client from '../../src/integrations/openalgo/client.js';

/**
 * The circuit breaker that replaced the fixed IST blackout windows: calls to an instance pause
 * only while it is actually unreachable, and resume on their own - no clock, no manual refresh.
 */

test('a real OpenAlgo rejection is not "unreachable"; a dead host is', () => {
  assert.strictEqual(isUnreachableError({ statusCode: 400, message: 'Invalid symbol' }), false);
  assert.strictEqual(isUnreachableError({ statusCode: 404, message: 'Order not found' }), false);
  assert.strictEqual(isUnreachableError({ isHtmlResponse: true }), true);
  assert.strictEqual(isUnreachableError({ statusCode: 502 }), true);
  assert.strictEqual(isUnreachableError({ message: 'connect ECONNREFUSED 1.2.3.4:443' }), true);
  assert.strictEqual(isUnreachableError({ message: 'The operation was aborted due to timeout' }), true);
});

test('backoff doubles per failure and caps at 10 minutes', () => {
  assert.strictEqual(backoffMs(1, 60_000), 60_000);
  assert.strictEqual(backoffMs(2, 60_000), 120_000);
  assert.strictEqual(backoffMs(20, 60_000), MAX_UNREACHABLE_BACKOFF_MS);
});

test('an HTML error page opens the circuit at once, a probe failure widens it, success closes it - never a manual-refresh lockout', (t) => {
  const tracker = new InstanceHealthTrackerService();
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);

  tracker.recordInstanceFailure(1, new Error('502'), { isHtml: true });
  assert.strictEqual(tracker.isInstanceHealthy(1), false);
  assert.strictEqual(tracker.getInstanceCooldownRemaining(1), 60_000);

  // Many consecutive failures (an overnight outage): still auto-recovering, cooldown capped.
  for (let i = 0; i < 20; i += 1) {
    now += MAX_UNREACHABLE_BACKOFF_MS; // cooldown lapsed -> half-open probe
    assert.strictEqual(tracker.isInstanceHealthy(1), true, 'the probe is let through');
    tracker.recordInstanceFailure(1, new Error('502'), { isHtml: true });
  }
  assert.strictEqual(tracker.getInstanceCooldownRemaining(1), MAX_UNREACHABLE_BACKOFF_MS);
  assert.strictEqual(tracker.instanceRequiresManualRefresh(1), false);

  now += MAX_UNREACHABLE_BACKOFF_MS;
  tracker.resetInstanceHealth(1); // the probe succeeded
  assert.strictEqual(tracker.isInstanceHealthy(1), true);
});

test('generic failures open the circuit only after three in a row', () => {
  const tracker = new InstanceHealthTrackerService();
  tracker.recordInstanceFailure(2, new Error('timeout'));
  tracker.recordInstanceFailure(2, new Error('timeout'));
  assert.strictEqual(tracker.isInstanceHealthy(2), true);
  tracker.recordInstanceFailure(2, new Error('timeout'));
  assert.strictEqual(tracker.isInstanceHealthy(2), false);
});

test('a paused instance short-circuits background calls without touching the network; orders still go out', async (t) => {
  const instance = { id: 9901, name: 'down', host_url: 'https://down.invalid', api_key: 'k' };
  client.recordInstanceFailure(instance.id, new Error('502'), { isHtml: true });
  const network = t.mock.method(client, '_makeRequest', async () => ({ status: 'success', data: { ok: 1 } }));
  try {
    await assert.rejects(client.request(instance, 'quotes', { symbol: 'X', exchange: 'NSE' }, 'POST', { skipRateLimit: true }),
      (err) => err.code === 'INSTANCE_UNREACHABLE');
    assert.strictEqual(network.mock.callCount(), 0);

    const res = await client.request(instance, 'cancelorder', { orderid: '1' }, 'POST', { isCritical: true, skipRateLimit: true });
    assert.strictEqual(res.status, 'success');
    assert.strictEqual(network.mock.callCount(), 1);
    assert.strictEqual(client.isInstanceHealthy(instance.id), true, 'a success closes the circuit');
  } finally {
    client.forceResetInstanceHealth(instance.id);
  }
});
