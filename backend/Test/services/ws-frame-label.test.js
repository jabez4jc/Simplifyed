import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';

/**
 * A WebSocket frame is used only for the contract it really belongs to.
 *
 * Captured live from the brokers on 2026-09-30. Fyers labelled frames for NIFTY options and the
 * NIFTY future as NSE_INDEX:NIFTY; the chart drew the index's candle at an option premium, and the
 * same cache prices the watchlist, orders and auto-exit. Every legitimate frame below is from the
 * same capture and must still pass.
 */

before(async () => {
  await useTestDb('ws-frame-label');
  await db.run('DELETE FROM instruments');
  const rows = [
    ['NSE_INDEX', 'NIFTY', '101000000026000'],
    ['NFO', 'NIFTY06OCT2622800CE', '101126100640715'],
    ['MCX', 'CRUDEOIL19OCT26FUT', '1120261019569900'],
    ['NSE', 'RELIANCE', '10100000002885'],
    ['CRYPTO', 'BTCUSDFUT', '27'],
  ];
  for (const [exchange, symbol, token] of rows) {
    await db.run('INSERT INTO instruments (exchange, symbol, token) VALUES (?, ?, ?)', [exchange, symbol, token]);
  }
  marketDataFeedService.instrumentTokens.clear();
});

const passes = (frame) => marketDataFeedService._frameIsForItsLabel(2, frame);

test('frames for NIFTY options and the NIFTY future labelled as the index are dropped', async () => {
  for (const token of ['40710', '40711', '40716', '48704']) {
    assert.strictEqual(await passes({ exchange: 'NSE_INDEX', symbol: 'NIFTY', token, ltp: 206.4 }), false, token);
  }
});

test('every legitimate frame seen from Fyers, Kotak and Delta still passes', async () => {
  const good = [
    { exchange: 'NSE_INDEX', symbol: 'NIFTY', token: '', ltp: 22783.2 }, // Fyers index: empty token
    { exchange: 'NFO', symbol: 'NIFTY06OCT2622800CE', token: '40715', ltp: 144.8 }, // Fyers
    { exchange: 'MCX', symbol: 'CRUDEOIL19OCT26FUT', token: '569900', ltp: 8602 }, // Fyers
    { exchange: 'NSE', symbol: 'RELIANCE', token: '2885', ltp: 1193.7 }, // Fyers
    { exchange: 'NFO', symbol: 'NIFTY06OCT2622800CE', ltp: 145 }, // Kotak: no token
    { exchange: 'CRYPTO', symbol: 'BTCUSDFUT', ltp: 83300.95 }, // Delta: no token
    { exchange: 'NFO', symbol: 'NOTINCACHE', token: '123', ltp: 1 }, // unknown contract: nothing to check against
  ];
  for (const frame of good) {
    assert.strictEqual(await passes(frame), true, `${frame.exchange}:${frame.symbol}`);
  }
});
