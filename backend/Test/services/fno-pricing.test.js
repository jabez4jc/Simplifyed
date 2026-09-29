/**
 * Limit pricing for the segments actually traded: index F&O (NFO/BFO), MCX F&O, and Delta
 * Exchange crypto futures and options.
 *
 * SEBI requires retail algo orders on Indian exchanges to be LIMIT orders, and the exchange
 * rejects a limit price that is not a whole multiple of the contract's tick. Tick sizes differ
 * by contract and are not guessable - BANKNIFTY futures tick at 0.2, CRUDEOIL futures at 1.0 but
 * CRUDEOIL options at 0.1 - so every case below uses the tick from the instruments cache.
 *
 * Crypto is outside SEBI's rule and Delta Exchange accepts MARKET orders.
 */

import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import limitPriceService from '../../src/services/limit-price.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import settingsService from '../../src/services/settings.service.js';
import orderPlacementService from '../../src/services/order-placement.service.js';
import db from '../../src/core/database.js';

// [label, exchange, symbol, tick, bestBid, bestAsk, buffer, expected BUY, expected SELL]
const CONTRACTS = [
  ['NIFTY future', 'NFO', 'NIFTY27OCT26FUT', 0.1, 25150.1, 25150.3, 0.33, 25150.7, 25149.7],
  ['BANKNIFTY future', 'NFO', 'BANKNIFTY27OCT26FUT', 0.2, 56010.2, 56010.4, 1.1, 56011.6, 56009],
  ['NIFTY option', 'NFO', 'NIFTY06OCT2625150CE', 0.05, 132.3, 132.35, 0.52, 132.9, 131.75],
  ['BANKNIFTY option', 'NFO', 'BANKNIFTY27OCT2656000PE', 0.05, 410.1, 410.35, 1.07, 411.45, 409],
  ['SENSEX future', 'BFO', 'SENSEX29OCT26FUT', 0.05, 82310.1, 82311.15, 2.02, 82313.2, 82308.05],
  ['SENSEX option', 'BFO', 'SENSEX01OCT2682300CE', 0.05, 245.1, 245.15, 1.02, 246.2, 244.05],
  ['CRUDEOIL future', 'MCX', 'CRUDEOIL19OCT26FUT', 1, 6011, 6012, 2.5, 6015, 6008],
  ['CRUDEOIL option', 'MCX', 'CRUDEOIL15OCT266000CE', 0.1, 187.2, 187.3, 0.55, 187.9, 186.6],
  ['NATURALGAS future', 'MCX', 'NATURALGAS27OCT26FUT', 0.1, 275.4, 275.5, 0.35, 275.9, 275],
  ['GOLDM future', 'MCX', 'GOLDM05NOV26FUT', 1, 98764, 98765, 7.5, 98773, 98756],
  ['BTC perpetual', 'CRYPTO', 'BTCUSDFUT', 0.5, 83250, 83250.5, 1.2, 83252, 83248.5],
  ['ETH perpetual', 'CRYPTO', 'ETHUSDFUT', 0.05, 3120.4, 3120.45, 0.12, 3120.6, 3120.25],
  ['BTC option', 'CRYPTO', 'BTC01OCT2683000CE', 0.1, 1523.3, 1523.4, 0.25, 1523.7, 1523],
];

const onTick = (price, tick) => Math.abs(price / tick - Math.round(price / tick)) < 1e-6;

function stubDepth(bid, ask) {
  mock.method(settingsService, 'getSetting', async () => { throw new Error('unset'); });
  mock.method(marketDataFeedService, 'fetchDepthForSymbol', async () => ({ bid, ask, fetchedAt: Date.now() }));
}

describe('marketable limit price per traded segment', () => {
  afterEach(() => mock.restoreAll());

  for (const [label, exchange, symbol, tick, bid, ask, buffer, wantBuy, wantSell] of CONTRACTS) {
    test(`${label} (${exchange}, tick ${tick}): BUY rounds up from the ask, SELL down from the bid`, async () => {
      stubDepth(bid, ask);
      const buy = await limitPriceService.resolveLimitPrice({ exchange, symbol, side: 'BUY', bufferPoints: buffer, tickSize: tick });
      const sell = await limitPriceService.resolveLimitPrice({ exchange, symbol, side: 'SELL', bufferPoints: buffer, tickSize: tick });

      assert.equal(buy.price, wantBuy);
      assert.equal(sell.price, wantSell);
      assert.ok(onTick(buy.price, tick) && onTick(sell.price, tick), 'the exchange rejects an off-tick limit');
      // Marketable: a buy at or through the ask, a sell at or through the bid.
      assert.ok(buy.price >= ask && sell.price <= bid);
      assert.equal(buy.source, 'ask');
      assert.equal(sell.source, 'bid');
    });
  }

  test('a spread wider than the limit is refused rather than priced', async () => {
    stubDepth(100, 110); // ~9.5% - an illiquid far-OTM option
    await assert.rejects(
      () => limitPriceService.resolveLimitPrice({ exchange: 'NFO', symbol: 'NIFTY06OCT2628000CE', side: 'BUY', tickSize: 0.05 }),
      /spread too wide/i
    );
  });

  test('without a caller tick size, the contract tick comes from the instruments cache', async () => {
    // Orders placed without a watchlist symbol used to round to 2 decimals: 56011.5 here, which
    // the exchange rejects for BANKNIFTY's 0.2 tick.
    stubDepth(56010.2, 56010.4);
    limitPriceService.tickCache.clear();
    mock.method(db, 'get', async () => ({ tick_size: 0.2 }));
    const { price } = await limitPriceService.resolveLimitPrice({ exchange: 'NFO', symbol: 'BANKNIFTY27OCT26FUT', side: 'BUY', bufferPoints: 1.1 });
    assert.ok(onTick(price, 0.2), `${price} is not a multiple of BANKNIFTY's 0.2 tick`);
  });
});

describe('when no price can be found', () => {
  afterEach(() => mock.restoreAll());

  for (const exchange of ['NSE', 'BSE', 'NFO', 'BFO', 'MCX']) {
    test(`${exchange} refuses the order rather than falling back to MARKET`, async () => {
      mock.method(limitPriceService, 'resolveLimitPrice', async () => { throw new Error(`No quote available for ${exchange}:X`); });
      await assert.rejects(
        () => limitPriceService.resolveMarketablePricing({ exchange, symbol: 'X', side: 'BUY' }),
        new RegExp(`No price available for ${exchange}:X`)
      );
    });
  }

  test('CRYPTO may fall back to MARKET - Delta Exchange accepts market orders', async () => {
    mock.method(limitPriceService, 'resolveLimitPrice', async () => { throw new Error('No quote available for CRYPTO:BTCUSDFUT'); });
    const pricing = await limitPriceService.resolveMarketablePricing({ exchange: 'CRYPTO', symbol: 'BTCUSDFUT', side: 'SELL' });
    assert.deepEqual(pricing, { pricetype: 'MARKET', price: 0 });
  });
});

/**
 * Indian brokers take no SL-M from algos (SEBI). A stop-market becomes a stop-loss LIMIT: the
 * limit sits past the trigger by the caller's buffer, else 0.5% of the trigger, rounded away from
 * the trigger to the contract's tick so the stop still fills through a fast move.
 */
describe('SL-M becomes a stop-loss limit on Indian exchanges', () => {
  // [label, exchange, action, trigger, tick, bufferPoints, expected limit]
  const STOPS = [
    ['NIFTY future long stop', 'NFO', 'SELL', 25100, 0.1, null, 24974.5],
    ['BANKNIFTY option short stop', 'NFO', 'BUY', 410.35, 0.05, null, 412.45],
    ['SENSEX option long stop', 'BFO', 'SELL', 245.15, 0.05, 1.02, 244.1],
    ['CRUDEOIL future long stop', 'MCX', 'SELL', 6012, 1, null, 5981],
    ['GOLDM future short stop', 'MCX', 'BUY', 98765, 1, 2.5, 98768],
    ['NATURALGAS future long stop', 'MCX', 'SELL', 275.4, 0.1, null, 274],
  ];

  for (const [label, exchange, action, trigger, tick, buffer, want] of STOPS) {
    test(`${label}: SL-M ${action} @ ${trigger} -> SL limit ${want}`, async () => {
      const out = await orderPlacementService._convertStopMarketToStopLimit(
        { exchange, symbol: 'X', action, pricetype: 'SL-M', trigger_price: trigger, price: 0 },
        { tickSize: tick, limitBufferPoints: buffer }
      );
      assert.equal(out.pricetype, 'SL');
      assert.equal(out.price, want);
      assert.ok(onTick(out.price, tick));
      assert.ok(action === 'SELL' ? out.price < trigger : out.price > trigger, 'limit must sit past the trigger');
      assert.equal(out.trigger_price, trigger, 'the trigger is unchanged');
    });
  }

  test('an SL-M with no trigger price is refused', async () => {
    await assert.rejects(
      () => orderPlacementService._convertStopMarketToStopLimit({ exchange: 'NFO', symbol: 'X', action: 'SELL', pricetype: 'SL-M', trigger_price: 0 }),
      /no trigger price/
    );
  });
});
