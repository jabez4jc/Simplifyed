import assert from 'assert';
import test, { afterEach } from 'node:test';
import { cancelOpenOrdersForSymbol } from '../../src/utils/order-helpers.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';

/**
 * C3: a retry or close-retry used to cancel EVERY open order on the account, via OpenAlgo's
 * account-wide cancelallorder (the `strategy` param there is a label only, not a scope). Both
 * call sites - order-retry.service's limit-chase retry and quick-order.service's close/exit
 * retry - now route through a symbol-scoped cancel that only touches that order's own
 * symbol/exchange/product, so a retry on one symbol can no longer cancel protective stops on
 * every other open position.
 */

const original = { cancelOrder: openalgoClient.cancelOrder, cancelAllOrders: openalgoClient.cancelAllOrders };
afterEach(() => {
  openalgoClient.cancelOrder = original.cancelOrder;
  openalgoClient.cancelAllOrders = original.cancelAllOrders;
});

test('order-retry: retrying symbol A cancels only A\'s open orders, never the whole account', async () => {
  const instance = { id: 99, strategy_tag: 'default' };
  const cancelledIds = [];
  openalgoClient.cancelOrder = async (_inst, orderId) => { cancelledIds.push(orderId); return { status: 'success' }; };
  openalgoClient.cancelAllOrders = async () => {
    throw new Error('cancelAllOrders must never be called from a symbol-scoped retry');
  };

  const orders = [
    { orderid: 'A1', symbol: 'NIFTY24DECFUT', exchange: 'NFO', product: 'MIS', order_status: 'open' },
    { orderid: 'A2', symbol: 'NIFTY24DECFUT', exchange: 'NFO', product: 'MIS', order_status: 'trigger_pending' },
    { orderid: 'B1', symbol: 'BANKNIFTY24DECFUT', exchange: 'NFO', product: 'MIS', order_status: 'open' },
    { orderid: 'A3', symbol: 'NIFTY24DECFUT', exchange: 'NFO', product: 'MIS', order_status: 'complete' },
  ];
  const payload = { symbol: 'NIFTY24DECFUT', exchange: 'NFO', product: 'MIS' };

  await cancelOpenOrdersForSymbol(instance, orders, payload, 'default');

  assert.deepStrictEqual(
    cancelledIds.sort(),
    ['A1', 'A2'],
    "only A's open/pending orders are cancelled - not B's, and not A's already-complete order"
  );
});

test('quick-order: a close/exit retry cancels only its own contract\'s orders, never the whole account', async () => {
  const instance = { id: 42 };
  const cancelledIds = [];
  openalgoClient.cancelOrder = async (_inst, orderId) => { cancelledIds.push(orderId); return { status: 'success' }; };
  openalgoClient.cancelAllOrders = async () => {
    throw new Error('cancelAllOrders must never be called from a close/exit retry');
  };

  const originalSnapshot = marketDataFeedService.getOrderbookSnapshot;
  marketDataFeedService.getOrderbookSnapshot = async () => ({
    data: [
      { orderid: 'X1', symbol: 'BTCUSDFUT', exchange: 'CRYPTO', product: 'MIS', order_status: 'open' },
      { orderid: 'Y1', symbol: 'ETHUSDFUT', exchange: 'CRYPTO', product: 'MIS', order_status: 'open' },
    ],
  });

  try {
    await quickOrderService._cancelOwnOrdersBeforeRetry(
      instance,
      { symbol: 'BTCUSDFUT', exchange: 'CRYPTO', watchlist_name: 'wl' },
      { product: 'MIS' }
    );
  } finally {
    marketDataFeedService.getOrderbookSnapshot = originalSnapshot;
  }

  assert.deepStrictEqual(cancelledIds, ['X1']);
});
