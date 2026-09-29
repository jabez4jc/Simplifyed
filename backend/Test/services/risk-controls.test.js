import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import db from '../../src/core/database.js';
import riskControls from '../../src/services/risk-controls.service.js';
import { makeInstance, makeWatchlist, makeWatchlistSymbol } from '../helpers/fixtures.js';

/**
 * Target, stop-loss and trailing-stop evaluation.
 *
 * This is the logic that decides when to close a live position. Every branch is a decision about
 * real money and there is no confirmation step behind it, so the cases below are deliberately
 * about the boundaries and the wrong-direction mistakes: a stop that triggers on the wrong side
 * of the entry closes a winning trade, and one that fails to trigger lets a loss run.
 */

before(async () => {
  await useTestDb('risk-controls');
});

beforeEach(async () => {
  await truncate();
  riskControls.reset();
});

/**
 * Trailing state is stored per (instance, exchange, symbol, side), and the in-memory key encodes
 * exactly that - so a key has to be built with the service's own builder. An arbitrary string
 * works for the in-memory map but silently skips persistence, which would make the restart test
 * below pass for the wrong reason.
 */
const keyFor = (symbol, side = 'LONG', instanceId = 1, exchange = 'NSE') =>
  riskControls._key(instanceId, exchange, symbol, side);

/** Config as it is stored on a watchlist symbol row, for the 'direct' (equity) column set. */
const direct = (overrides = {}) => ({ symbol_type: 'EQUITY', ...overrides });

const evaluate = (params) => riskControls.evaluateExit({
  key: `k-${Math.random()}`,
  exchange: 'NSE',
  symbol: 'RELIANCE',
  instanceId: 1,
  watchlistId: 1,
  symbolId: 1,
  ...params,
});

// ---------------------------------------------------------------------------
// Which column set applies
// ---------------------------------------------------------------------------

test('an equity whose name contains CE or PE is not treated as an option', async () => {
  // `symbol.includes('CE')` matches RELIANCE, CESC, ACE and ACEATLTD. Every one of those was
  // classified as an option, so the engine read the options target/stop columns for them and
  // silently ignored whatever the operator configured on the Direct tab.
  for (const symbol of ['RELIANCE', 'CESC', 'ACE', 'ACEATLTD', 'PERSISTENT', 'PEL']) {
    const result = await evaluate({
      symbol,
      side: 'LONG',
      entryPrice: 100,
      currentPrice: 110,
      configEntry: { target_points_direct: 5, target_points_options: 50 },
    });
    assert.strictEqual(result.mode, 'direct', `${symbol} must use the direct column set`);
    assert.strictEqual(result.reason, 'TARGET_MET', `${symbol} must honour its direct target`);
  }
});

test('a real option symbol does use the options column set', async () => {
  const result = await evaluate({
    symbol: 'NIFTY26JUL24000CE',
    side: 'LONG',
    entryPrice: 100,
    currentPrice: 110,
    configEntry: { target_points_direct: 5, target_points_options: 50 },
  });
  assert.strictEqual(result.mode, 'options');
  assert.strictEqual(result.reason, null, 'the options target of 50 has not been reached');
});

test('a futures symbol uses the futures column set', async () => {
  const result = await evaluate({
    symbol: 'BANKNIFTY26JULFUT',
    side: 'LONG',
    entryPrice: 100,
    currentPrice: 110,
    configEntry: { target_points_futures: 5 },
  });
  assert.strictEqual(result.mode, 'futures');
  assert.strictEqual(result.reason, 'TARGET_MET');
});

test('an explicit symbol_type beats any guess made from the name', async () => {
  const result = await evaluate({
    symbol: 'RELIANCE',
    side: 'LONG',
    entryPrice: 100,
    currentPrice: 160,
    configEntry: direct({ symbol_type: 'OPTIONS', target_points_options: 50, target_points_direct: 5 }),
  });
  assert.strictEqual(result.mode, 'options');
});

// ---------------------------------------------------------------------------
// Target and stop-loss, both directions
// ---------------------------------------------------------------------------

test('a long position exits at its target and at its stop, and not in between', async () => {
  const configEntry = direct({ target_points_direct: 10, stoploss_points_direct: 5 });

  const below = await evaluate({ side: 'LONG', entryPrice: 100, currentPrice: 103, configEntry });
  assert.strictEqual(below.reason, null, 'a position in profit but short of target must stay open');

  const atTarget = await evaluate({ side: 'LONG', entryPrice: 100, currentPrice: 110, configEntry });
  assert.strictEqual(atTarget.reason, 'TARGET_MET', 'the target is inclusive');

  const atStop = await evaluate({ side: 'LONG', entryPrice: 100, currentPrice: 95, configEntry });
  assert.strictEqual(atStop.reason, 'STOPLOSS_HIT', 'the stop is inclusive');

  const wellBelow = await evaluate({ side: 'LONG', entryPrice: 100, currentPrice: 80, configEntry });
  assert.strictEqual(wellBelow.reason, 'STOPLOSS_HIT', 'a gap through the stop must still trigger it');
});

test('a short position exits in the opposite direction from a long', async () => {
  // Getting this backwards closes every winning short and holds every losing one.
  const configEntry = direct({ target_points_direct: 10, stoploss_points_direct: 5 });

  const inProfit = await evaluate({ side: 'SHORT', entryPrice: 100, currentPrice: 90, configEntry });
  assert.strictEqual(inProfit.reason, 'TARGET_MET', 'a short profits when price FALLS');

  const inLoss = await evaluate({ side: 'SHORT', entryPrice: 100, currentPrice: 105, configEntry });
  assert.strictEqual(inLoss.reason, 'STOPLOSS_HIT', 'a short loses when price RISES');

  const between = await evaluate({ side: 'SHORT', entryPrice: 100, currentPrice: 98, configEntry });
  assert.strictEqual(between.reason, null);
});

test('the target is preferred over the stop when a tick satisfies both', async () => {
  // A single tick can jump past both levels. Reporting the stop would book a loss on a move that
  // went the operator's way.
  const result = await evaluate({
    side: 'LONG',
    entryPrice: 100,
    currentPrice: 200,
    configEntry: direct({ target_points_direct: 10, stoploss_points_direct: 1000 }),
  });
  assert.strictEqual(result.reason, 'TARGET_MET');
});

test('a symbol with no risk configuration is never force-exited', async () => {
  const result = await evaluate({
    side: 'LONG',
    entryPrice: 100,
    currentPrice: 1,
    configEntry: direct({}),
  });
  assert.strictEqual(result.reason, null, 'an unconfigured symbol must not be closed by the engine');
});

test('a zero or negative threshold is treated as "not configured", not as "exit immediately"', async () => {
  for (const value of [0, -5, null, undefined, '']) {
    const result = await evaluate({
      side: 'LONG',
      entryPrice: 100,
      currentPrice: 100,
      configEntry: direct({ target_points_direct: value, stoploss_points_direct: value }),
    });
    assert.strictEqual(result.reason, null, `threshold ${JSON.stringify(value)} must not trigger an exit`);
  }
});

test('missing price information yields no decision at all', async () => {
  // A missing quote must never be read as "price is zero", which would look like a total loss.
  for (const patch of [{ currentPrice: null }, { entryPrice: null }, { currentPrice: 0 }, { entryPrice: 0 }]) {
    const result = await evaluate({
      side: 'LONG',
      entryPrice: 100,
      currentPrice: 100,
      configEntry: direct({ stoploss_points_direct: 5 }),
      ...patch,
    });
    assert.strictEqual(result, null, `${JSON.stringify(patch)} must produce no decision`);
  }
});

// ---------------------------------------------------------------------------
// Trailing stop
// ---------------------------------------------------------------------------

test('a trailing stop does not arm until its activation profit is reached', async () => {
  const key = keyFor('TRAILACT');
  const configEntry = direct({ trailing_stoploss_points_direct: 5, trailing_activation_points_direct: 20 });

  // Up 10 - short of the 20-point activation, so a 6-point pullback must NOT exit.
  await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 110, configEntry, symbol: 'RELIANCE' });
  const pullback = await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 104, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(pullback.reason, null, 'an unarmed trailing stop must not fire');
});

test('once armed, a trailing stop follows the high and fires on the pullback', async () => {
  const key = keyFor('TRAILARM');
  const configEntry = direct({ trailing_stoploss_points_direct: 5, trailing_activation_points_direct: 20 });

  // Up 30: armed, stop sits at 130 - 5 = 125.
  const armed = await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 130, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(armed.reason, null, 'arming is not an exit');

  const stillAbove = await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 126, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(stillAbove.reason, null, '126 is above the 125 stop');

  const through = await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 125, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(through.reason, 'TSL_HIT', 'touching the trailing stop exits');
});

test('a trailing stop ratchets and never gives ground', async () => {
  // The whole point of a trailing stop is that it only moves in the operator's favour. If it
  // retreated with the price it would give back every gain it was meant to protect.
  const key = keyFor('TRAILRAT');
  const configEntry = direct({ trailing_stoploss_points_direct: 10 });

  await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 150, configEntry, symbol: 'RELIANCE' });
  const afterHigh = riskControls.trailingState.get(key).stopPrice;
  assert.strictEqual(afterHigh, 140);

  // Price falls back to 120. The stop must stay at 140, not drop to 110.
  await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 141, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(riskControls.trailingState.get(key).stopPrice, 140, 'the stop must not retreat');
});

test('a short position trails downward', async () => {
  const key = keyFor('TRAILSHORT', 'SHORT');
  const configEntry = direct({ trailing_stoploss_points_direct: 10 });

  // Price falls to 50: the short is winning, stop sits at 50 + 10 = 60.
  await riskControls.evaluateExit({ key, side: 'SHORT', entryPrice: 100, currentPrice: 50, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(riskControls.trailingState.get(key).stopPrice, 60);

  const bounce = await riskControls.evaluateExit({ key, side: 'SHORT', entryPrice: 100, currentPrice: 60, configEntry, symbol: 'RELIANCE' });
  assert.strictEqual(bounce.reason, 'TSL_HIT');
});

test('trailing state survives a restart', async () => {
  // The engine runs continuously against open positions. If a restart lost the ratcheted stop,
  // every open position would silently revert to a looser stop than the operator had earned.
  const key = keyFor('TRAILPERSIST');
  const configEntry = direct({ trailing_stoploss_points_direct: 10 });

  await riskControls.evaluateExit({
    key, side: 'LONG', entryPrice: 100, currentPrice: 150, configEntry, symbol: 'RELIANCE',
    instanceId: 1, watchlistId: 1, symbolId: 1, exchange: 'NSE',
  });

  const persisted = await db.get(
    'SELECT * FROM trailing_state WHERE instance_id = ? AND exchange = ? AND symbol = ? AND side = ?',
    ['1', 'NSE', 'TRAILPERSIST', 'LONG']
  );
  assert.ok(persisted, 'the ratcheted stop must be written down');
  assert.strictEqual(Number(persisted.stop_price), 140);

  // Simulate the restart.
  riskControls.reset();
  await riskControls.hydrateFromDb();

  assert.strictEqual(
    riskControls.trailingState.get(key)?.stopPrice, 140,
    'the stop must come back at the level it had reached, not reset'
  );
});

test('clearing a position forgets its trailing state', async () => {
  // A stale stop from a closed position would be applied to the next position on the same symbol.
  const key = keyFor('TRAILCLEAR');
  const configEntry = direct({ trailing_stoploss_points_direct: 10 });

  await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 150, configEntry, symbol: 'RELIANCE' });
  assert.ok(riskControls.trailingState.get(key));

  riskControls.clearTrailingState(key);
  assert.strictEqual(riskControls.trailingState.get(key), undefined);
});

test('a ratchet is recorded as a risk event the operator can audit afterwards', async () => {
  // risk_events carries foreign keys to the instance, watchlist and symbol, so this needs real
  // rows - and the recorder swallows a failed insert, which is exactly why it is worth asserting
  // that the row actually lands rather than that the call did not throw.
  const instance = await makeInstance();
  const watchlist = await makeWatchlist();
  const symbol = await makeWatchlistSymbol(watchlist.id);

  const key = riskControls._key(instance.id, 'NSE', 'TRAILEVENTS', 'LONG');
  const configEntry = direct({ trailing_stoploss_points_direct: 10 });
  const context = {
    instanceId: instance.id,
    watchlistId: watchlist.id,
    symbolId: symbol.id,
    exchange: 'NSE',
    symbol: 'TRAILEVENTS',
  };

  await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 150, configEntry, ...context });
  await riskControls.evaluateExit({ key, side: 'LONG', entryPrice: 100, currentPrice: 170, configEntry, ...context });

  const events = await db.all('SELECT event_type, previous_value, new_value FROM risk_events ORDER BY id');
  assert.ok(events.length >= 2, 'arming and ratcheting must both be recorded');
  assert.strictEqual(events[0].event_type, 'TRAIL_ACTIVATED');
  assert.strictEqual(events[1].event_type, 'STOP_RATCHET');
  assert.strictEqual(Number(events[1].new_value), 160);
});
