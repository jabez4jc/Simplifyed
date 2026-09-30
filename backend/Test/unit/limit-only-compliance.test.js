import assert from 'assert';
import test from 'node:test';
import { assertLimitOnlyCompliance } from '../../src/integrations/openalgo/client.js';
import { requiresLimitOrders, marketOrderAllowed } from '../../src/utils/broker-type.util.js';

/**
 * SEBI requires retail algo orders on Indian exchanges to be LIMIT orders, and Indian brokers
 * take no SL-M from algos. assertLimitOnlyCompliance is the client's last check before an order
 * leaves the process, whatever priced it upstream. Crypto (Delta Exchange) is exempt.
 */

const INDIAN = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];

test('MARKET and SL-M are refused on every Indian exchange, for every order endpoint', () => {
  for (const exchange of INDIAN) {
    for (const pricetype of ['MARKET', 'SL-M']) {
      const order = { exchange, symbol: 'X', pricetype, price: 0 };
      for (const endpoint of ['placeorder', 'placesmartorder', 'splitorder', 'modifyorder']) {
        assert.throws(() => assertLimitOnlyCompliance(endpoint, order), /SEBI requires LIMIT/, `${endpoint} ${exchange} ${pricetype}`);
      }
      assert.throws(() => assertLimitOnlyCompliance('basketorder', { orders: [{ exchange: 'NSE', symbol: 'A', pricetype: 'LIMIT', price: 1 }, order] }),
        /SEBI requires LIMIT/, 'one bad basket leg refuses the basket');
    }
  }
});

test('LIMIT and SL (stop-loss limit) pass on Indian exchanges', () => {
  for (const exchange of INDIAN) {
    assert.doesNotThrow(() => assertLimitOnlyCompliance('placesmartorder', { exchange, pricetype: 'LIMIT', price: 101.5 }));
    assert.doesNotThrow(() => assertLimitOnlyCompliance('placesmartorder', { exchange, pricetype: 'SL', price: 99, trigger_price: 99.5 }));
  }
});

test('CRYPTO may use MARKET and SL-M; non-order endpoints are never checked', () => {
  assert.doesNotThrow(() => assertLimitOnlyCompliance('placesmartorder', { exchange: 'CRYPTO', pricetype: 'MARKET', price: 0 }));
  assert.doesNotThrow(() => assertLimitOnlyCompliance('placesmartorder', { exchange: 'CRYPTO', pricetype: 'SL-M', trigger_price: 83000 }));
  assert.doesNotThrow(() => assertLimitOnlyCompliance('margin', { exchange: 'NSE', pricetype: 'MARKET' }), 'margin previews are not orders');
});

test('broker MARKET support never overrides the rule, and an unknown exchange counts as Indian', () => {
  assert.strictEqual(marketOrderAllowed(true, 'NFO'), false);
  assert.strictEqual(marketOrderAllowed(true, 'CRYPTO'), true);
  assert.strictEqual(marketOrderAllowed(false, 'CRYPTO'), false);
  assert.strictEqual(requiresLimitOrders(''), true, 'when in doubt, refuse MARKET');
  assert.strictEqual(requiresLimitOrders('crypto'), false);
});

test('crypto brokers default to MARKET support; an explicit setting still wins; Indian brokers default off', async () => {
  const { resolveMarketOrderSupport, buildMarketOrderSupportMap } = await import('../../src/utils/brokerage.js');
  assert.strictEqual(resolveMarketOrderSupport('deltaexchange', {}), true, 'unlisted crypto broker: MARKET on');
  assert.strictEqual(resolveMarketOrderSupport('deltaexchange', buildMarketOrderSupportMap({ deltaexchange: false })), false);
  assert.strictEqual(resolveMarketOrderSupport('kotak', {}), false);
  assert.strictEqual(resolveMarketOrderSupport('fyers', buildMarketOrderSupportMap({ fyers: true })), true, 'broker support is recorded...');
  assert.strictEqual(marketOrderAllowed(true, 'NFO'), false, '...but SEBI still forbids MARKET on an Indian exchange');
});

test('REDUCE only trims longs and INCREASE only trims shorts - neither squares off the other side', async () => {
  // Seen live: INCREASE_CE on a long of +65 computed min(0, 130) = 0 and closed the position.
  const { default: quickOrderService } = await import('../../src/services/quick-order.service.js');
  const target = (current, action) => quickOrderService._computeTarget(current, action, 65, true);
  assert.strictEqual(target(130, 'REDUCE_CE'), 65);
  assert.strictEqual(target(65, 'REDUCE_CE'), 0);
  assert.strictEqual(target(-65, 'REDUCE_CE'), -65, 'a short is left alone by REDUCE');
  assert.strictEqual(target(-130, 'INCREASE_PE'), -65);
  assert.strictEqual(target(-65, 'INCREASE_PE'), 0);
  assert.strictEqual(target(65, 'INCREASE_CE'), 65, 'a long is left alone by INCREASE');
});

test('closeposition is refused outright - it squares off at MARKET with no price', () => {
  assert.throws(() => assertLimitOnlyCompliance('closeposition', { strategy: 'x' }), /SEBI requires LIMIT/);
});

test('a GTT whose legs would fire as MARKET is refused on Indian exchanges, allowed on crypto', () => {
  const gtt = (exchange) => ({ exchange, symbol: 'X', pricetype: 'MARKET', trigger_type: 'OCO' });
  assert.throws(() => assertLimitOnlyCompliance('placegttorder', gtt('NFO')), /SEBI requires LIMIT/);
  assert.doesNotThrow(() => assertLimitOnlyCompliance('placegttorder', gtt('CRYPTO')));
});
