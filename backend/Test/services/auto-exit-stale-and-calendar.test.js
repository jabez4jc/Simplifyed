import assert from 'assert';
import test, { before, mock, afterEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import autoExitService from '../../src/services/auto-exit.service.js';
import riskControlsService from '../../src/services/risk-controls.service.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import exitLevelsService from '../../src/services/exit-levels.service.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import db from '../../src/core/database.js';

/**
 * H7: auto-exit judged stops on 8-30s-old positionbook LTPs, went blind whenever the market
 * calendar failed to load (isExchangeOpen answered "closed"), closed every product of a symbol
 * when one product row hit its level, and guessed entries from other instances' current prices.
 */

before(async () => { await useTestDb('auto-exit-h7'); });
afterEach(() => mock.restoreAll());

const SBIN = { id: 700, watchlist_id: 1, exchange: 'NSE', symbol: 'SBIN', symbol_type: 'EQUITY', stoploss_points_direct: 5 };
const lookup = new Map([['NSE:SBIN', [SBIN]]]);
const position = { symbol: 'SBIN', exchange: 'NSE', product: 'MIS', quantity: 10, average_price: 100, ltp: 100 };
const INSTANCE = { id: 31, name: 'Test Kotak' };

async function evaluateWith(openAnswer) {
  let evaluated = 0;
  mock.method(marketCalendarService, 'isExchangeOpen', async () => openAnswer);
  mock.method(riskControlsService, 'evaluateExit', async () => { evaluated += 1; return null; });
  await autoExitService._evaluatePosition(INSTANCE, position, lookup);
  return evaluated;
}

test('a calendar that cannot load (null) does not stop evaluation - stops stay armed', async () => {
  assert.strictEqual(await evaluateWith(null), 1);
});

test('a definite "closed" still skips evaluation', async () => {
  assert.strictEqual(await evaluateWith(false), 0);
});

test('isExchangeOpen is null when timings never loaded, false when loaded-but-empty', async () => {
  const mod = await import(`../../src/services/market-calendar.service.js?h7=${Math.random()}`);
  const svc = mod.default;
  svc.getMarketTimings = async () => [];
  svc.getMarketHolidays = async () => new Map();
  assert.strictEqual(await svc.isExchangeOpen('NSE'), null);
  svc.timingsCache.set(svc._formatDate(), { data: [], fetchedAt: Date.now() });
  assert.strictEqual(await svc.isExchangeOpen('NSE'), false);
});

test('a fresh WS quote beats the stale positionbook LTP', async () => {
  mock.method(marketDataFeedService, 'getCachedQuoteEntriesForSymbols',
    () => ({ cached: [{ quote: { ltp: 123.5 }, fetchedAt: Date.now() }], missing: [] }));
  const res = await autoExitService._resolveCurrentPrice({ ltp: 100 }, 'NSE', 'SBIN', 31);
  assert.deepStrictEqual(res, { price: 123.5, source: 'ws_quote' });
});

test('with no fresh WS quote the position LTP is used', async () => {
  mock.method(marketDataFeedService, 'getCachedQuoteEntriesForSymbols', () => ({ cached: [], missing: [] }));
  const res = await autoExitService._resolveCurrentPrice({ ltp: 100 }, 'NSE', 'SBIN', 31);
  assert.deepStrictEqual(res, { price: 100, source: 'position_ltp' });
});

test('the cross-instance median entry guess is gone', () => {
  assert.strictEqual(autoExitService._resolveCrossInstanceMedianLtp, undefined);
});

test('a risk exit closes only the triggering product row', async () => {
  const calls = [];
  mock.method(quickOrderService, 'closePosition', async (...args) => { calls.push(args); return {}; });
  const ok = await autoExitService._executeAutoExit(INSTANCE, { ...position, product: 'NRML' }, 'direct', 'STOPLOSS_HIT', null);
  assert.strictEqual(ok, true);
  assert.strictEqual(calls[0][2].onlyProduct, true);
  assert.strictEqual(calls[0][2].product, 'NRML');
});

test('a strategy leg exits only the quantity the strategy owns, not the whole position', async () => {
  const parts = [];
  mock.method(quickOrderService, 'closePosition', async () => { throw new Error('must not full-close a shared contract'); });
  mock.method(quickOrderService, 'exitPartOfPosition', async (...args) => { parts.push(args); return {}; });
  mock.method(db, 'all', async (sql) => (sql.includes('FROM strategies')
    ? [{ id: 5 }]
    : [{ resolved_symbol: 'SBIN', resolved_exchange: 'NSE', product: 'MIS', quantity: 4, action: 'BUY' }]));
  const ok = await autoExitService._executeAutoExit(INSTANCE, position, 'direct', 'STOPLOSS_HIT', { watchlist_id: 1 });
  assert.strictEqual(ok, true);
  assert.strictEqual(parts[0][2], 4, 'exit qty is the strategy\'s 4, not the position\'s 10');
});

test('exit levels also evaluate when the calendar cannot say, and skip on a definite closed', async () => {
  mock.method(marketCalendarService, 'isExchangeOpen', async () => null);
  exitLevelsService.openCache.clear();
  assert.strictEqual(await exitLevelsService._isOpen('NFO'), true);
  mock.restoreAll();
  mock.method(marketCalendarService, 'isExchangeOpen', async () => false);
  exitLevelsService.openCache.clear();
  assert.strictEqual(await exitLevelsService._isOpen('NFO'), false);
});
