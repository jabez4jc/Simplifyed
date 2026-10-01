import assert from 'assert';
import test from 'node:test';
import { computeSessionPnl, calculateTradeChargesOpenAlgo } from '../../src/utils/trade-pnl.js';

/**
 * C5: session P&L used to be Sigma(sell value) - Sigma(buy value) - charges, reconstructed from
 * the tradebook. An untouched OPEN position has no matching sell, so a BUY that never closed was
 * priced as its full notional loss - tripping SESSION_MAX_LOSS and closing every position - and
 * an open SHORT was priced as a notional profit big enough to trip SESSION_TARGET. The fix: price
 * every position by the broker's own MTM (qty=0 is realized, qty!=0 is unrealized), with only
 * today's trade charges subtracted.
 */

test('an open BUY with no SELL prices at its MTM, not its full notional', () => {
  const tradebook = [
    { action: 'BUY', exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', trade_value: 500000, quantity: 1250, average_price: 400 },
  ];
  const positions = [
    { symbol: 'NIFTY28AUG2624000CE', exchange: 'NFO', quantity: 1250, pnl: -50 },
  ];

  const charges = calculateTradeChargesOpenAlgo(500000, { exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', side: 'BUY', brokerage: 20 }).total_cost;

  const result = computeSessionPnl(positions, tradebook, 20);

  assert.strictEqual(result.unrealized_pnl, -50, 'the open leg is unrealized MTM, not -500000');
  assert.strictEqual(result.realized_pnl, Number((-charges).toFixed(2)), "today's charges are the only realized component with nothing closed");
  assert.strictEqual(result.total_pnl, Number((-50 - charges).toFixed(2)), 'session P&L is MTM minus charges, not minus notional');
});

test('an open SHORT prices at its MTM, not a notional profit', () => {
  const tradebook = [
    { action: 'SELL', exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', trade_value: 500000, quantity: 1250, average_price: 400 },
  ];
  const positions = [
    { symbol: 'NIFTY28AUG2624000CE', exchange: 'NFO', quantity: -1250, pnl: 30 },
  ];

  const result = computeSessionPnl(positions, tradebook, 20);

  assert.strictEqual(result.unrealized_pnl, 30, 'the open short is unrealized MTM, not +500000');
  assert.ok(result.total_pnl < 1000, `a held short must not register a notional-sized profit, got ${result.total_pnl}`);
});

test('a flat (qty=0) position is realized, and charges are netted against it', () => {
  const tradebook = [
    { action: 'BUY', exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', trade_value: 400000, quantity: 1000, average_price: 400 },
    { action: 'SELL', exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', trade_value: 405000, quantity: 1000, average_price: 405 },
  ];
  const positions = [
    { symbol: 'NIFTY28AUG2624000CE', exchange: 'NFO', quantity: 0, pnl: 5000 },
  ];

  const buyCharges = calculateTradeChargesOpenAlgo(400000, { exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', side: 'BUY', brokerage: 20 }).total_cost;
  const sellCharges = calculateTradeChargesOpenAlgo(405000, { exchange: 'NFO', symbol: 'NIFTY28AUG2624000CE', side: 'SELL', brokerage: 20 }).total_cost;

  const result = computeSessionPnl(positions, tradebook, 20);

  assert.strictEqual(result.unrealized_pnl, 0);
  assert.strictEqual(result.realized_pnl, Number((5000 - buyCharges - sellCharges).toFixed(2)));
  assert.strictEqual(result.total_pnl, result.realized_pnl);
});

test('no positions and no trades gives zero, not a crash', () => {
  const result = computeSessionPnl([], [], 20);
  assert.deepStrictEqual(result, { realized_pnl: 0, unrealized_pnl: 0, total_pnl: 0 });
});
