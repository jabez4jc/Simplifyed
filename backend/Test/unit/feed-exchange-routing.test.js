import assert from 'assert';
import test, { mock, afterEach } from 'node:test';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';

/**
 * The market-data pool mixes Delta Exchange with Indian brokers. Seen live: Maha (Fyers) was
 * asked for CRYPTO:BTCUSDFUT on every poll and rejected it every time. Each instance must only be
 * sent symbols from the segment its broker trades.
 */

afterEach(() => mock.restoreAll());

const MAHA = { id: 19, name: 'Maha', broker: 'fyers', supports_multiquotes: 1 };
const DELTA = { id: 26, name: 'Jabez Crypto', broker: 'deltaexchange', supports_multiquotes: 1 };

test('multiquotes sends each instance only its own segment', async () => {
  const asked = [];
  mock.method(openalgoClient, 'getMultiQuotes', async (inst, symbols) => {
    asked.push({ inst: inst.name, symbols: symbols.map((s) => s.symbol) });
    return { quotes: symbols.map((s) => ({ ...s, ltp: 100 })), failed: [] };
  });
  marketDataFeedService.multiQuoteTimestamps.clear();

  const { quotes, pendingSymbols } = await marketDataFeedService._fetchViaMultiQuotes([
    { exchange: 'NFO', symbol: 'NIFTY27OCT26FUT' },
    { exchange: 'CRYPTO', symbol: 'BTCUSDFUT' },
    { exchange: 'MCX', symbol: 'CRUDEOIL19OCT26FUT' },
  ], [MAHA, DELTA]);

  assert.deepStrictEqual(asked, [
    { inst: 'Maha', symbols: ['NIFTY27OCT26FUT', 'CRUDEOIL19OCT26FUT'] },
    { inst: 'Jabez Crypto', symbols: ['BTCUSDFUT'] },
  ]);
  assert.strictEqual(quotes.length, 3);
  assert.strictEqual(pendingSymbols.length, 0);
});

test('_tradesExchange: crypto brokers take only CRYPTO, Indian brokers everything else', () => {
  assert.strictEqual(marketDataFeedService._tradesExchange(DELTA, 'CRYPTO'), true);
  assert.strictEqual(marketDataFeedService._tradesExchange(DELTA, 'NFO'), false);
  assert.strictEqual(marketDataFeedService._tradesExchange(MAHA, 'CRYPTO'), false);
  for (const ex of ['NSE', 'NFO', 'BFO', 'MCX', 'NSE_INDEX']) assert.strictEqual(marketDataFeedService._tradesExchange(MAHA, ex), true);
});
