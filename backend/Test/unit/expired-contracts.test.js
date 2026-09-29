import assert from 'assert';
import test from 'node:test';
import { contractExpiry, isContractExpired } from '../../src/utils/underlying.util.js';
import { withoutExpiredContracts } from '../../src/integrations/openalgo/client.js';

/**
 * An expired contract no longer exists at any broker. Seen live: GOLDPETAL31AUG26FUT sat in a
 * watchlist a month after expiry, and every poll asked four instances for it and logged four
 * "Symbol not found" rejections. Nothing may be quoted, subscribed or ordered for one.
 */

const NOON_29_SEP = new Date('2026-09-29T12:00:00+05:30');

test('the expiry comes from the row, or failing that from the symbol itself', () => {
  assert.strictEqual(contractExpiry({ symbol: 'GOLDPETAL31AUG26FUT' }), '31-AUG-26');
  assert.strictEqual(contractExpiry({ symbol: 'NATGASMINI24JUL26275CE' }), '24-JUL-26');
  assert.strictEqual(contractExpiry({ symbol: 'BTC29SEP2683000CE' }), '29-SEP-26');
  assert.strictEqual(contractExpiry({ symbol: 'NIFTY29SEP2622600.5PE' }), '29-SEP-26');
  assert.strictEqual(contractExpiry({ symbol: 'X', expiry: '2026-08-26' }), '2026-08-26', 'the row wins');
  for (const symbol of ['SBIN', 'NIFTY', 'BTCUSDFUT', 'ETHUSDFUT', 'XAUTUSDFUT']) {
    assert.strictEqual(contractExpiry({ symbol }), null, `${symbol} has no expiry`);
  }
});

test('expired vs live across index F&O, MCX F&O and crypto', () => {
  const cases = [
    [{ exchange: 'MCX', symbol: 'GOLDPETAL31AUG26FUT' }, true],
    [{ exchange: 'MCX', symbol: 'NATGASMINI24JUL26275CE' }, true],
    [{ exchange: 'NFO', symbol: 'NIFTY29SEP26FUT' }, false], // expires today - trades all day
    [{ exchange: 'BFO', symbol: 'SENSEX01OCT2673100CE' }, false],
    [{ exchange: 'CRYPTO', symbol: 'BTC29SEP2683000CE' }, false], // until 17:30 IST
    [{ exchange: 'CRYPTO', symbol: 'BTCUSDFUT' }, false], // perpetual
    [{ exchange: 'NSE', symbol: 'SBIN' }, false],
  ];
  for (const [row, want] of cases) assert.strictEqual(isContractExpired(row, NOON_29_SEP), want, row.symbol);
  assert.strictEqual(isContractExpired({ exchange: 'CRYPTO', symbol: 'BTC29SEP2683000CE' }, new Date('2026-09-29T17:50:00+05:30')), true);
});

test('orders, quotes and depth on an expired contract are refused before any broker call', () => {
  for (const endpoint of ['placesmartorder', 'placeorder', 'quotes', 'depth', 'symbol']) {
    assert.throws(
      () => withoutExpiredContracts(endpoint, { exchange: 'MCX', symbol: 'GOLDPETAL31AUG26FUT', quantity: 1 }),
      /has expired \(31-AUG-26\)/,
      endpoint
    );
  }
  const live = { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT' };
  assert.strictEqual(withoutExpiredContracts('placesmartorder', live), live);
});

test('multiquotes drops only the expired symbols; a basket with one expired leg is refused whole', () => {
  const out = withoutExpiredContracts('multiquotes', { symbols: [
    { exchange: 'MCX', symbol: 'GOLDPETAL31AUG26FUT' },
    { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT' },
    { exchange: 'CRYPTO', symbol: 'BTCUSDFUT' },
  ] });
  assert.deepStrictEqual(out.symbols.map((s) => s.symbol), ['NIFTY27OCT26FUT', 'BTCUSDFUT']);

  assert.throws(() => withoutExpiredContracts('basketorder', { orders: [
    { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT', quantity: 65 },
    { exchange: 'MCX', symbol: 'NATGASMINI24JUL26275CE', quantity: 250 },
  ] }), /NATGASMINI24JUL26275CE has expired/);
});
