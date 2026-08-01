import assert from 'assert';
import test from 'node:test';
import { calculateTradeChargesOpenAlgo } from '../../src/utils/trade-pnl.js';

/**
 * Options and futures carry different exchange fees on NFO (0.0005 vs 0.00019). Classifying by
 * "contains CE or PE" instead of "ends in <strike>CE/PE" silently overcharged every future whose
 * underlying happens to contain those letters, and the error compounds through GST.
 */

test('an NFO future on a CE/PE-containing underlying is not billed as an option', () => {
  for (const symbol of ['PERSISTENT26SEP26FUT', 'CESC26SEP26FUT', 'PEL26SEP26FUT']) {
    const charges = calculateTradeChargesOpenAlgo(100000, { exchange: 'NFO', symbol, side: 'BUY' });
    assert.strictEqual(charges.instrument_type, 'FUTURE', symbol);
    assert.strictEqual(charges.exchange_fee, 19); // 0.00019 * 100000, not 50
  }
});

test('a real option symbol is still billed as an option', () => {
  const charges = calculateTradeChargesOpenAlgo(100000, {
    exchange: 'NFO',
    symbol: 'NIFTY28AUG2624000CE',
    side: 'BUY',
  });
  assert.strictEqual(charges.instrument_type, 'OPTION');
  assert.strictEqual(charges.exchange_fee, 50); // 0.0005 * 100000
});

test('stamp duty is charged on the buy leg only', () => {
  const opts = { exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE' };
  assert.ok(calculateTradeChargesOpenAlgo(100000, { ...opts, side: 'BUY' }).stamp_duty > 0);
  assert.strictEqual(calculateTradeChargesOpenAlgo(100000, { ...opts, side: 'SELL' }).stamp_duty, 0);
});
