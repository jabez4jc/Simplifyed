import assert from 'assert';
import test from 'node:test';

import quickOrderService from '../../src/services/quick-order.service.js';
import optionsResolutionService from '../../src/services/options-resolution.service.js';
import quickOrderQuotesService from '../../src/services/quick-order-quotes.service.js';

// H10: the strike follows the live LTP, so a resolution must never be served from a cache.
test('two FLOAT resolutions straddling a strike boundary return different strikes', async () => {
  let ltp = 24_990;
  const stubs = {
    _ensureQuoteAvailableForSymbol: async () => {},
    _resolveExpiryForOption: async () => '2026-10-27',
  };
  const realResolve = optionsResolutionService.resolveOptionSymbol;
  const realLtp = quickOrderQuotesService.getUnderlyingLTP;
  quickOrderQuotesService.getUnderlyingLTP = async () => ltp;
  const saved = {};
  for (const [k, v] of Object.entries(stubs)) { saved[k] = quickOrderService[k]; quickOrderService[k] = v; }
  optionsResolutionService.resolveOptionSymbol = async ({ ltp: l }) => ({ strike: Math.round(l / 50) * 50 });
  try {
    const symbol = { id: 7, exchange: 'NSE_INDEX', symbol: 'NIFTY', underlying_symbol: 'NIFTY' };
    const params = { action: 'BUY_CE', optionsLeg: 'ATM' };
    const a = await quickOrderService._resolveOptionSymbolForInstance({ id: 1 }, symbol, params);
    ltp = 25_030;
    const b = await quickOrderService._resolveOptionSymbolForInstance({ id: 1 }, symbol, params);
    assert.strictEqual(a.optionSymbol.strike, 25_000);
    assert.strictEqual(b.optionSymbol.strike, 25_050);
  } finally {
    Object.assign(quickOrderService, saved);
    quickOrderQuotesService.getUnderlyingLTP = realLtp;
    optionsResolutionService.resolveOptionSymbol = realResolve;
  }
});
