import assert from 'assert';
import test from 'node:test';
import openalgoWsService from '../../src/services/openalgo-ws.service.js';

/**
 * Which connection a symbol's WebSocket subscription round-robins onto.
 *
 * Round-robin used to ignore broker compatibility entirely: with a crypto instance and an
 * Indian-broker instance as the only two live connections, an Indian index had a coin-flip
 * chance of landing on the crypto connection - which has no NSE session to subscribe to, so no
 * quote for that symbol ever arrives. It still LOOKS subscribed (desired.add succeeds), so the
 * failure is invisible: the cached snapshot simply never updates again. Observed live: NIFTY
 * landed on the crypto connection and its quote was 190 days stale.
 *
 * `syncAll` is exercised directly against the real singleton, with fake connections swapped
 * into its internal map - real ones open a socket in their constructor, which has no place in
 * a unit test.
 */
function fakeConn(id, broker) {
  return {
    instance: { id, broker },
    desired: new Set(),
    setSubscriptions() { this.desired = new Set(); },
    _syncSubscriptions() { /* no real socket to push to */ },
  };
}

function withConnections(map, run) {
  const saved = openalgoWsService.connections;
  openalgoWsService.connections = map;
  try { return run(); } finally { openalgoWsService.connections = saved; }
}

test('an Indian index never lands on the crypto connection', () => {
  const conns = new Map([
    [6, fakeConn(6, 'fyers')],
    [26, fakeConn(26, 'deltaexchange')],
  ]);
  withConnections(conns, () => {
    // Run many times: round-robin state persists across calls, so one pass proves nothing.
    for (let i = 0; i < 10; i += 1) {
      openalgoWsService.syncAll([{ exchange: 'NSE_INDEX', symbol: 'NIFTY' }]);
      assert.ok(conns.get(6).desired.has('NSE_INDEX|NIFTY'), `pass ${i}: must be on the Indian broker`);
      assert.ok(!conns.get(26).desired.has('NSE_INDEX|NIFTY'), `pass ${i}: must not be on crypto`);
    }
  });
});

test('a crypto symbol never lands on an Indian-broker connection', () => {
  const conns = new Map([
    [6, fakeConn(6, 'fyers')],
    [26, fakeConn(26, 'deltaexchange')],
  ]);
  withConnections(conns, () => {
    for (let i = 0; i < 10; i += 1) {
      openalgoWsService.syncAll([{ exchange: 'CRYPTO', symbol: 'BTCUSDFUT' }]);
      assert.ok(conns.get(26).desired.has('CRYPTO|BTCUSDFUT'));
      assert.ok(!conns.get(6).desired.has('CRYPTO|BTCUSDFUT'));
    }
  });
});

test('round-robin distributes across MULTIPLE compatible connections, not just the first', () => {
  const conns = new Map([
    [1, fakeConn(1, 'fyers')],
    [2, fakeConn(2, 'angel')],
    [3, fakeConn(3, 'deltaexchange')],
  ]);
  withConnections(conns, () => {
    const symbols = Array.from({ length: 6 }, (_, i) => ({ exchange: 'NSE', symbol: `SYM${i}` }));
    openalgoWsService.syncAll(symbols);
    assert.strictEqual(conns.get(3).desired.size, 0, 'the crypto connection gets none of these');
    // Split across the two Indian-broker connections rather than piling onto one.
    assert.ok(conns.get(1).desired.size > 0 && conns.get(2).desired.size > 0);
    assert.strictEqual(conns.get(1).desired.size + conns.get(2).desired.size, 6);
  });
});

test('a symbol with no compatible connection at all is simply not subscribed', () => {
  // Only a crypto connection exists; an Indian symbol has nowhere valid to go.
  const conns = new Map([[26, fakeConn(26, 'deltaexchange')]]);
  withConnections(conns, () => {
    openalgoWsService.syncAll([{ exchange: 'NSE', symbol: 'RELIANCE' }]);
    assert.strictEqual(conns.get(26).desired.size, 0);
  });
});

test('a preferred instance is honoured only when it is actually compatible', () => {
  const conns = new Map([
    [6, fakeConn(6, 'fyers')],
    [26, fakeConn(26, 'deltaexchange')],
  ]);
  withConnections(conns, () => {
    // Preferred instance is the WRONG one for this exchange - must fall back, not honour it.
    const preferred = new Map([['NSE_INDEX|NIFTY', 26]]);
    openalgoWsService.syncAll([{ exchange: 'NSE_INDEX', symbol: 'NIFTY' }], preferred);
    assert.ok(conns.get(6).desired.has('NSE_INDEX|NIFTY'));
    assert.ok(!conns.get(26).desired.has('NSE_INDEX|NIFTY'));
  });
});
