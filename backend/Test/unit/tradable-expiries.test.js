import assert from 'assert';
import test from 'node:test';

import { tradableExpiries, upcomingExpiries, isContractExpired } from '../../src/utils/underlying.util.js';

/**
 * A crypto daily stops being "nearest" in its final hour before the 17:30 IST expiry: on the Delta
 * analyzer, orders on it then filled but never showed as positions. It stays a live contract, so a
 * position already held in it can still be quoted and closed.
 */

const at = (hhmm) => new Date(`2026-09-30T${hhmm}:00+05:30`);
const DAILIES = ['2026-09-30', '2026-10-01', '2026-10-02'];

test('a crypto daily is nearest until 16:30 IST on its expiry day, then the next one is', () => {
  assert.strictEqual(tradableExpiries(DAILIES, at('16:29'), { crypto: true })[0], '2026-09-30');
  assert.strictEqual(tradableExpiries(DAILIES, at('16:30'), { crypto: true })[0], '2026-10-01');
  assert.strictEqual(tradableExpiries(DAILIES, at('17:10'), { crypto: true })[0], '2026-10-01');
});

test('Indian expiries are untouched - they trade all of their expiry day', () => {
  const weeklies = ['30-SEP-26', '07-OCT-26'];
  assert.deepStrictEqual(tradableExpiries(weeklies, at('16:45')), upcomingExpiries(weeklies, at('16:45')));
  assert.strictEqual(tradableExpiries(weeklies, at('15:20'))[0], '30-SEP-26');
});

test('a held position in the expiring daily is still live until it really expires', () => {
  const row = { exchange: 'CRYPTO', symbol: 'BTC30SEP2683800CE', expiry: '2026-09-30' };
  assert.strictEqual(isContractExpired(row, at('17:10')), false);
  assert.strictEqual(isContractExpired(row, at('17:50')), true);
});
