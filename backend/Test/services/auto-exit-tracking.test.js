import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import autoExitService from '../../src/services/auto-exit.service.js';

/**
 * Brokers keep a closed position row (quantity 0) for the day beside a live one in another
 * product - an MIS trade closed, then an NRML re-entry in the same symbol. Seen live: auto-exit
 * tracked positions by symbol alone, so every cycle the zero MIS row cleared the NRML row's
 * pending confirmation, a hit target/stop was never confirmed, and the exit never fired.
 */

before(async () => { await useTestDb('auto-exit-tracking'); });

test('each product row has its own tracking entry', () => {
  const nrml = autoExitService._getTrackingKey(26, 'BTCUSDFUT', 'CRYPTO', 'NRML');
  const mis = autoExitService._getTrackingKey(26, 'BTCUSDFUT', 'CRYPTO', 'MIS');
  assert.notStrictEqual(nrml, mis);
});

test('a closed MIS row does not wipe the live NRML row\'s exit confirmation', async () => {
  const nrmlKey = autoExitService._getTrackingKey(26, 'BTCUSDFUT', 'CRYPTO', 'NRML');
  autoExitService.exitConfirmations.set(nrmlKey, { reason: 'STOPLOSS_HIT', firstSeen: Date.now() });
  autoExitService.pendingExits.delete(nrmlKey);

  // The closed row is evaluated first, as the broker lists it first.
  await autoExitService._evaluatePosition(
    { id: 26, name: 'Jabez Crypto' },
    { symbol: 'BTCUSDFUT', exchange: 'CRYPTO', product: 'MIS', quantity: 0 },
    new Map()
  );

  assert.ok(autoExitService.exitConfirmations.has(nrmlKey), 'the NRML confirmation must survive the MIS row');
  autoExitService.exitConfirmations.delete(nrmlKey);
});
