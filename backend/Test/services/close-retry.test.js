import assert from 'assert';
import test, { before, beforeEach, afterEach } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import { makeWatchlist, makeInstance, makeWatchlistSymbol, linkInstanceToWatchlist } from '../helpers/fixtures.js';
import quickOrderService from '../../src/services/quick-order.service.js';

/**
 * A watchlist EXIT that fails is retried once the dust settles - but only a DEFINITE failure.
 * An uncertain one (timeout, 5xx, outcome unknown) may already have closed the position; with the
 * position book lagging the fill, re-sending the exit sells again and leaves a short where the
 * account should be flat (seen live on Fyers and Kotak). No broker is involved: the close itself
 * is stubbed so only the retry decision is under test.
 */

const original = {
  close: quickOrderService._closePositions,
  force: quickOrderService._forceCloseSymbolIfNeeded,
  cancel: quickOrderService._cancelOwnOrdersBeforeRetry,
};

before(async () => { await useTestDb('close-retry'); });
beforeEach(async () => { await truncate(); });
afterEach(() => {
  quickOrderService._closePositions = original.close;
  quickOrderService._forceCloseSymbolIfNeeded = original.force;
  quickOrderService._cancelOwnOrdersBeforeRetry = original.cancel;
});

async function exitWith(error) {
  const wl = await makeWatchlist();
  const inst = await makeInstance();
  await linkInstanceToWatchlist(wl.id, inst.id);
  const sym = await makeWatchlistSymbol(wl.id, { exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', tradable_futures: 1 });
  const sent = { count: 0 };
  quickOrderService._closePositions = async () => { sent.count += 1; throw error; };
  quickOrderService._forceCloseSymbolIfNeeded = async () => {};
  quickOrderService._cancelOwnOrdersBeforeRetry = async () => {};
  const res = await quickOrderService.placeQuickOrder({ symbolId: sym.id, action: 'EXIT', tradeMode: 'FUTURES', quantity: 1 });
  return { res, sent };
}

test('an exit whose outcome is unknown is reported uncertain and never re-sent', async () => {
  const unknown = Object.assign(new Error('Order outcome unknown - check the order book'), { statusCode: 504 });
  const { res, sent } = await exitWith(unknown);
  assert.strictEqual(sent.count, 1, 'an uncertain exit must not be sent again');
  assert.strictEqual(res.results[0].uncertain, true);
});

test('a definite rejection is still retried', async () => {
  const rejected = Object.assign(new Error('Insufficient funds'), { statusCode: 400 });
  const { sent } = await exitWith(rejected);
  assert.ok(sent.count > 1, `a definite failure gets its retries, saw ${sent.count} attempt(s)`);
});
