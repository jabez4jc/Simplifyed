import assert from 'assert';
import test from 'node:test';
import {
  normalizeOrderStatus,
  roundToTick,
  roundToNearestTick,
  applyBufferAndTick,
} from '../../src/utils/order-helpers.js';
import { extractLtp } from '../../src/utils/price-extraction.js';
import quickOrderQuotesService from '../../src/services/quick-order-quotes.service.js';

test('normalizeOrderStatus: one vocabulary for placement, retry, feed and history', () => {
  assert.strictEqual(normalizeOrderStatus('COMPLETED'), 'complete');
  assert.strictEqual(normalizeOrderStatus('Canceled'), 'cancelled');
  assert.strictEqual(normalizeOrderStatus('trigger pending'), 'trigger_pending');
  assert.strictEqual(normalizeOrderStatus('partially_filled'), 'partial');
  assert.strictEqual(normalizeOrderStatus('open'), 'open');
  assert.strictEqual(normalizeOrderStatus(''), 'unknown');
  assert.strictEqual(normalizeOrderStatus(null), 'unknown');
});

test('tick rounding: directional (BUY up, SELL down), nearest, buffer + tick', () => {
  assert.strictEqual(roundToTick(100.03, 0.05, 'BUY'), 100.05);
  assert.strictEqual(roundToTick(100.03, 0.05, 'SELL'), 100);
  assert.strictEqual(roundToTick(100.123, null, 'BUY'), 100.12);
  assert.strictEqual(roundToNearestTick(100.03, 0.05), 100.05);
  assert.strictEqual(roundToNearestTick(0, 0.05), 0);
  assert.strictEqual(applyBufferAndTick({ ltp: 100, side: 'BUY', bufferPct: 1, tickSize: 0.05 }), 101);
  assert.strictEqual(applyBufferAndTick({ ltp: 100, side: 'SELL', bufferPoints: 0.52, tickSize: 0.05 }), 99.45);
});

test('extractLtp forOrder: only ltp/bid/ask, never close/prev_close/open/high/low', () => {
  const closeOnly = { close: 250, prev_close: 249, open: 251, high: 260, low: 240 };
  assert.strictEqual(extractLtp(closeOnly), 250, 'display callers still fall back to close');
  assert.strictEqual(extractLtp(closeOnly, { forOrder: true }), null);
  assert.strictEqual(extractLtp({ ltp: 101, close: 90 }, { forOrder: true }), 101);
  assert.strictEqual(extractLtp({ bid: 100, ask: 102, close: 90 }, { forOrder: true }), 101);
  assert.strictEqual(extractLtp({ bid: 100, close: 90 }, { forOrder: true }), 100);
});

test('extractChangePercentFromQuote never reads an absolute change as a percent', () => {
  assert.strictEqual(quickOrderQuotesService.extractChangePercentFromQuote({ change: 12.5 }), null);
  assert.strictEqual(quickOrderQuotesService.extractChangePercentFromQuote({ percent_change: 1.2, change: 12.5 }), 1.2);
});
