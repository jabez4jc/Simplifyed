/**
 * A "fill now" caller must still place its order when the quote feed is cold.
 *
 * resolveLimitPrice throws `No quote available` by design - it is asked for a price and has
 * none. Every fill-now caller used to let that escape, so a cold feed meant no order at all:
 * a quick order that silently did nothing, or an auto-exit that did not exit while the
 * position stayed open. On Indian exchanges SEBI requires LIMIT orders, so after the relaxed
 * retry an unpriced order is REFUSED (auto-exit retries next tick); only crypto may go MARKET.
 */

import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import limitPriceService from '../../src/services/limit-price.service.js';

describe('limitPriceService.resolveMarketablePricing', () => {
  afterEach(() => mock.restoreAll());

  test('returns the computed LIMIT when a quote is available', async () => {
    mock.method(limitPriceService, 'resolveLimitPrice', async () => ({ price: 101.5 }));

    const pricing = await limitPriceService.resolveMarketablePricing({
      exchange: 'NSE', symbol: 'SBIN', side: 'BUY',
    });

    assert.deepEqual(pricing, { pricetype: 'LIMIT', price: 101.5 });
  });

  test('retries on a relaxed quote before conceding MARKET', async () => {
    // MARKET is the expensive outcome: the broker converts it to a LIMIT far off the touch.
    // A merely-stale cache entry must not cost the operator that.
    const calls = [];
    mock.method(limitPriceService, 'resolveLimitPrice', async (options) => {
      calls.push(options);
      if (calls.length === 1) throw new Error('Quote is stale for NSE:SBIN');
      return { price: 99.75 };
    });

    const pricing = await limitPriceService.resolveMarketablePricing({
      exchange: 'NSE', symbol: 'SBIN', side: 'SELL',
    });

    assert.deepEqual(pricing, { pricetype: 'LIMIT', price: 99.75 });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].bypassSpreadCheck, true);
    assert.ok(calls[1].quoteStaleMs > 2000);
  });

  test('refuses an NSE order when no quote is available - never MARKET (SEBI limit-only)', async () => {
    mock.method(limitPriceService, 'resolveLimitPrice', async () => {
      throw new Error('No quote available for NSE:SBIN');
    });

    await assert.rejects(
      () => limitPriceService.resolveMarketablePricing({ exchange: 'NSE', symbol: 'SBIN', side: 'BUY' }),
      /No price available for NSE:SBIN/
    );
  });

  test('refuses an NSE order when the spread check rejects every quote', async () => {
    mock.method(limitPriceService, 'resolveLimitPrice', async () => {
      throw new Error('Spread too wide for NSE:SBIN');
    });

    await assert.rejects(
      () => limitPriceService.resolveMarketablePricing({ exchange: 'NSE', symbol: 'SBIN', side: 'SELL' }),
      /Spread too wide/
    );
  });

  test('a crypto order with no quote falls back to MARKET', async () => {
    mock.method(limitPriceService, 'resolveLimitPrice', async () => {
      throw new Error('No quote available for CRYPTO:BTCUSDFUT');
    });

    const pricing = await limitPriceService.resolveMarketablePricing({ exchange: 'CRYPTO', symbol: 'BTCUSDFUT', side: 'BUY' });

    // price 0 is what OpenAlgo expects alongside pricetype MARKET.
    assert.deepEqual(pricing, { pricetype: 'MARKET', price: 0 });
  });
});
