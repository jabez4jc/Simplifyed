import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import autoExitService from '../../src/services/auto-exit.service.js';
import riskControlsService from '../../src/services/risk-controls.service.js';
import db from '../../src/core/database.js';

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

// ---------------------------------------------------------------------------
// Trailing stops as auto-exit runs them
// ---------------------------------------------------------------------------

const BTC_TRAIL = { id: 900, watchlist_id: 1, exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', trailing_stoploss_points_futures: 10 };
const lookupOf = (...rows) => new Map(rows.map((r) => [`${r.exchange}:${r.symbol}`, [r]]));
const btc = (quantity, average_price, ltp) => ({ symbol: 'BTCUSDFUT', exchange: 'CRYPTO', product: 'NRML', quantity, average_price, ltp });
const INSTANCE = { id: 26, name: 'Jabez Crypto' };
const trailKey = (side) => riskControlsService.trailingKey(26, 'CRYPTO', 'BTCUSDFUT', side, 'NRML');

test('a trail auto-exit starts is written down, so a restart does not reset it', async () => {
  // The tracking key was colon-separated; the trailing store parses "|" keys, so it silently
  // persisted nothing and every restart (each node --watch reload) gave the trail's gains back.
  riskControlsService.reset();
  await autoExitService._evaluatePosition(INSTANCE, btc(1, 100, 150), lookupOf(BTC_TRAIL));
  assert.strictEqual(riskControlsService.trailingState.get(trailKey('LONG'))?.stopPrice, 140);
  const row = await db.get("SELECT stop_price FROM trailing_state WHERE instance_id = 26 AND symbol = 'BTCUSDFUT'");
  assert.strictEqual(Number(row?.stop_price), 140, 'the ratcheted stop is persisted');

  riskControlsService.reset();
  await riskControlsService.hydrateFromDb();
  assert.strictEqual(riskControlsService.trailingState.get(trailKey('LONG'))?.stopPrice, 140, 'and comes back after a restart');
  riskControlsService.clearTrailingState(trailKey('LONG'));
});

test('a reversal starts a fresh trail - a short never inherits the long\'s stop', async () => {
  riskControlsService.reset();
  const track = autoExitService._getTrackingKey(26, 'BTCUSDFUT', 'CRYPTO', 'NRML');
  await autoExitService._evaluatePosition(INSTANCE, btc(1, 100, 150), lookupOf(BTC_TRAIL)); // long trail, stop 140
  // Reversed to short at 145: with one shared trail, 145 >= the long's 140 stop read as a hit.
  await autoExitService._evaluatePosition(INSTANCE, btc(-1, 146, 145), lookupOf(BTC_TRAIL));
  assert.strictEqual(autoExitService.exitConfirmations.has(track), false, 'the new short must not be stopped out');
  assert.strictEqual(riskControlsService.trailingState.get(trailKey('SHORT'))?.stopPrice, 155);
  assert.strictEqual(riskControlsService.trailingState.has(trailKey('LONG')), false, 'the long trail is gone');
  riskControlsService.clearTrailingState(trailKey('SHORT'));
});

test('by underlying, the row with an exit for the position\'s mode governs it', () => {
  // A strategy's BTC option leg (options exits only) used to shadow the row with the futures stop.
  const optionLeg = { id: 1, exchange: 'CRYPTO', symbol: 'C-BTC-120000-021026', underlying_symbol: 'BTC', symbol_type: 'OPTIONS', stoploss_points_options: 5 };
  const futuresRow = { id: 2, exchange: 'CRYPTO', symbol: 'BTCUSD', underlying_symbol: 'BTC', symbol_type: 'FUTURES', stoploss_points_futures: 300 };
  const found = autoExitService._findConfig('BTCUSDFUT', 'CRYPTO', lookupOf(optionLeg, futuresRow));
  assert.strictEqual(found?.id, 2);
  assert.strictEqual(autoExitService._findConfig('BTCUSDFUT', 'CRYPTO', lookupOf(optionLeg)), null,
    'an options exit never applies to the perpetual');
});
