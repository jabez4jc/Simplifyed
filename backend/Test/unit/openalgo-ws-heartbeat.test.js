import assert from 'assert';
import test from 'node:test';
import { pingReplyFor, isConnectionStale } from '../../src/services/openalgo-ws.service.js';

/**
 * Application-level heartbeat handling.
 *
 * `_onMessage` used to recognise exactly three message types (market_data, order_update, auth)
 * and silently ignore everything else - including any heartbeat OpenAlgo's server sends at the
 * application level rather than as a native WebSocket protocol ping (the `ws` library answers
 * protocol-level pings on its own; this is the layer that library can't see). Every instance
 * this app connects to is a proxied subdomain (`wss://fyers.simplifyed.in/ws` etc.), exactly the
 * deployment shape where a server falls back to a JSON heartbeat because a proxy strips raw
 * control frames. Missing it would mean the server eventually drops a connection nothing told
 * it was still alive - invisible in logs, indistinguishable from a network blip.
 */

test('a type-based ping is answered', () => {
  assert.deepStrictEqual(pingReplyFor({ type: 'ping' }), { type: 'pong', action: 'pong' });
});

test('an action-based ping is answered the same way', () => {
  assert.deepStrictEqual(pingReplyFor({ action: 'ping' }), { type: 'pong', action: 'pong' });
});

test('ordinary traffic is left alone', () => {
  for (const msg of [
    { type: 'market_data', data: { symbol: 'NIFTY' } },
    { type: 'order_update' },
    { type: 'auth', status: 'success' },
    { action: 'subscribe' },
    {},
  ]) {
    assert.strictEqual(pingReplyFor(msg), null, `${JSON.stringify(msg)} must not be answered`);
  }
});

test('malformed input does not throw', () => {
  assert.strictEqual(pingReplyFor(null), null);
  assert.strictEqual(pingReplyFor(undefined), null);
});

/**
 * The liveness watchdog: a connection can report `connected: true` (the socket object is open)
 * while having produced no actual message in a long time - a half-open socket, common behind the
 * proxies every OpenAlgo instance this app talks to sits behind. `isConnectionStale` is the pure
 * decision `_startLivenessWatchdog` runs per connection every WS_LIVENESS_CHECK_MS; kept separate
 * from the interval and the real `OpenAlgoWsConnection` (which opens a real socket in its
 * constructor - see the note above) so this is testable with plain objects.
 */
test('a connected socket that has gone silent past the timeout is stale', () => {
  const now = Date.now();
  const conn = { connected: true, lastMessageAt: now - 46_000 }; // just over the 45s timeout
  assert.strictEqual(isConnectionStale(conn, now), true);
});

test('a connected socket heard from recently is not stale', () => {
  const now = Date.now();
  const conn = { connected: true, lastMessageAt: now - 1000 };
  assert.strictEqual(isConnectionStale(conn, now), false);
});

test('a connection already reconnecting (connected: false) is never flagged stale - it is already on its own close/error path', () => {
  const now = Date.now();
  const conn = { connected: false, lastMessageAt: now - 999_999 };
  assert.strictEqual(isConnectionStale(conn, now), false);
});

test('a connection with no lastMessageAt yet (should not happen - _onOpen stamps it) is treated as stale rather than throwing', () => {
  const now = Date.now();
  assert.strictEqual(isConnectionStale({ connected: true }, now), true);
});

test('malformed connection input does not throw', () => {
  assert.strictEqual(isConnectionStale(null), false);
  assert.strictEqual(isConnectionStale(undefined), false);
});
