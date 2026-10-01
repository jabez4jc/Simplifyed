import { useLiveDatabase } from './live-db.js';
import assert from 'assert';
import test, { before, after } from 'node:test';

import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import orderService from '../../src/services/order.service.js';
import { trackOrders, closeEverythingOpened } from './cleanup.js';

/**
 * Order placement against real brokers, in analyzer mode only.
 *
 * Read Test/live/README.md before changing anything here.
 *
 * The safety model is one rule: nothing places an order until the BROKER has confirmed, in this
 * test, that the instance is in analyzer mode. The local is_analyzer_mode column is not trusted -
 * it is a cached copy that can drift from the broker, and trusting it is the difference between a
 * simulated order and a real one.
 */

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === 'true';

/** Only these instances are ever touched, and only by name. */
const ALLOWED_INSTANCES = ['Jabez Crypto', 'Jz Fyers', 'Jz Kotak', 'Maha', 'Ana'];

/**
 * What each broker can actually be asked to trade, taken from the instruments cache rather than
 * guessed - 'BTCUSD' on MCX does not exist; deltaexchange lists 'BTCUSDFUT' on CRYPTO.
 */
const SYMBOLS = {
  'Jabez Crypto': { exchange: 'CRYPTO', symbol: 'BTCUSDFUT', product: 'MIS' },
  'Jz Fyers': { exchange: 'NSE', symbol: 'SBIN', product: 'MIS' },
  'Jz Kotak': { exchange: 'NSE', symbol: 'SBIN', product: 'MIS' },
  Maha: { exchange: 'NSE', symbol: 'SBIN', product: 'MIS' },
  Ana: { exchange: 'NSE', symbol: 'SBIN', product: 'MIS' },
};

let instances = [];
let touched = new Map(); // instanceId -> symbols this suite ordered, for the final cleanup

before(async () => {
  if (!LIVE_ENABLED) return;
  await useLiveDatabase();
  await db.connect();
  touched = trackOrders();

  const placeholders = ALLOWED_INSTANCES.map(() => '?').join(', ');
  instances = await db.all(
    `SELECT * FROM instances WHERE name IN (${placeholders})`,
    ALLOWED_INSTANCES
  );

});

after(async () => {
  if (!LIVE_ENABLED) return;
  await db.close().catch(() => {});
});

/**
 * The gate. Asks the broker what mode it is in and refuses to go further unless it says analyzer.
 *
 * Deliberately fails the test rather than skipping it: a silent skip here would look identical
 * to a pass in CI output, and "we did not check whether we were about to trade for real" is not
 * a result anyone should be able to miss.
 */
async function assertAnalyzerModeAtBroker(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);

  const analyzerOn = status?.analyze_mode === true
    || status?.mode === 'analyze'
    || status?.mode === 'analyzer';

  assert.ok(
    analyzerOn,
    `REFUSING TO TRADE: ${instance.name} did not confirm analyzer mode. Broker said: ${JSON.stringify(status)}`
  );
  return status;
}

/**
 * Orders cannot be placed without a live quote.
 *
 * `brokerage.market_order_support` is `{}` in this deployment, so NO broker is treated as
 * accepting MARKET orders - every order is a marketable LIMIT priced off the current quote. That
 * makes a live quote a hard precondition for placing anything, and it means an exchange that is
 * closed cannot be order-tested at all.
 *
 * That is correct behaviour, not a defect, so it is reported as a skip with the reason stated
 * rather than as a failure. Crypto trades 24/7 and is unaffected; NSE only passes during market
 * hours.
 */
/**
 * Run an order and classify a "no quote" failure honestly.
 *
 * Order pricing goes through limit-price.service, which reads the market-data FEED's cache
 * rather than calling the broker directly. server.js runs that feed; a bare test process does
 * not, and starting it here keeps the process alive indefinitely. So for symbols the feed has
 * not primed, this is an environment limit, not a broker or application defect - and saying so
 * is more useful than either failing or quietly passing.
 */
async function placeOrSkip(t, instance, config, overrides = {}) {
  try {
    return await orderService.placeOrder({
      instanceId: instance.id,
      exchange: config.exchange,
      symbol: config.symbol,
      action: 'BUY',
      quantity: 1,
      position_size: 1,
      product: config.product,
      pricetype: 'MARKET',
      source: 'live_test',
      trigger_type: 'Manual',
      ...overrides,
    });
  } catch (error) {
    if (/square-off time/i.test(error.message)) {
      t.skip(`the broker refuses MIS orders after the 15:15 IST square-off: ${error.message}`);
      return null;
    }
    if (/no quote available/i.test(error.message)) {
      t.skip(`the market-data feed has no cached quote for ${config.exchange}:${config.symbol}, and every `
        + 'order here is a limit priced off that cache. Run the app (npm start) alongside this suite, '
        + 'or test a symbol the feed already polls.');
      return null;
    }
    throw error;
  }
}

async function liveQuoteOrSkip(t, instance) {
  const config = SYMBOLS[instance.name];
  try {
    const quote = await openalgoClient.getQuote(instance, config.symbol, config.exchange);
    const ltp = Number(quote?.ltp ?? quote?.last_price ?? quote?.lp);
    if (Number.isFinite(ltp) && ltp > 0) return { config, ltp };
  } catch (error) {
    t.diagnostic(`quote unavailable for ${config.exchange}:${config.symbol} - ${error.message}`);
  }
  t.skip(`no live quote for ${config.exchange}:${config.symbol} - the exchange is most likely closed. `
    + 'Every order here is a limit priced off the quote, so there is nothing to place.');
  return null;
}

function eachInstance(name, fn) {
  test(name, { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests' }, async (t) => {
    if (instances.length === 0) {
      assert.fail(`None of ${ALLOWED_INSTANCES.join(', ')} were found in the database`);
    }
    for (const instance of instances) {
      await t.test(instance.name, async (subtest) => fn(instance, subtest));
    }
  });
}

// ---------------------------------------------------------------------------
// Connectivity - no orders involved
// ---------------------------------------------------------------------------

eachInstance('the instance is reachable and identifies its broker', async (instance) => {
  const ping = await openalgoClient.ping(instance);
  assert.ok(ping?.broker, `expected a broker name, got ${JSON.stringify(ping)}`);
  assert.strictEqual(
    String(ping.broker).toLowerCase(),
    String(instance.broker).toLowerCase(),
    'the stored broker must match what the instance reports - a mismatch means the row is stale'
  );
});

eachInstance('the api key is accepted and funds are readable', async (instance) => {
  const funds = await openalgoClient.getFunds(instance);
  assert.ok(funds && typeof funds === 'object', `expected a funds object, got ${JSON.stringify(funds)}`);
  assert.ok(
    'availablecash' in funds || 'availableCash' in funds || 'cash' in funds,
    `funds response has no recognisable cash field: ${JSON.stringify(funds)}`
  );
});

eachInstance('the broker confirms it is in analyzer mode', async (instance) => {
  const status = await assertAnalyzerModeAtBroker(instance);
  assert.ok(status, 'analyzer status must be readable');
});

eachInstance('the local analyzer flag agrees with the broker', async (instance) => {
  // Drift here is the dangerous case: the dashboard shows "Analyzer" while the broker is live,
  // so the operator believes they are simulating and every order is real.
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const brokerSaysAnalyzer = status?.analyze_mode === true || status?.mode === 'analyze';
  const dbSaysAnalyzer = !!instance.is_analyzer_mode;

  assert.strictEqual(
    dbSaysAnalyzer,
    brokerSaysAnalyzer,
    `the dashboard shows ${dbSaysAnalyzer ? 'ANALYZER' : 'LIVE'} but the broker reports ${brokerSaysAnalyzer ? 'ANALYZER' : 'LIVE'}`
  );
});

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

eachInstance('a live quote comes back with a usable price', async (instance, t) => {
  const live = await liveQuoteOrSkip(t, instance);
  if (!live) return;
  assert.ok(live.ltp > 0, `expected a positive last price, got ${live.ltp}`);
  t.diagnostic(`${instance.name} ${live.config.exchange}:${live.config.symbol} = ${live.ltp}`);
});

eachInstance('the position book is readable', async (instance) => {
  const positions = await openalgoClient.getPositionBook(instance);
  assert.ok(Array.isArray(positions) || typeof positions === 'object',
    `unexpected position book shape: ${JSON.stringify(positions)?.slice(0, 200)}`);
});

eachInstance('the order book is readable', async (instance) => {
  const orders = await openalgoClient.getOrderBook(instance);
  assert.ok(orders !== undefined && orders !== null, 'the order book must be readable');
});

// ---------------------------------------------------------------------------
// Order placement - analyzer mode only, gated per test
// ---------------------------------------------------------------------------

eachInstance('a simulated order is accepted and comes back with an order id', async (instance, t) => {
  await assertAnalyzerModeAtBroker(instance);
  const live = await liveQuoteOrSkip(t, instance);
  if (!live) return;

  const order = await placeOrSkip(t, instance, live.config);
  if (!order) return;

  assert.ok(
    order.order_id || order.orderid || order.id,
    `expected an order id in the response: ${JSON.stringify(order).slice(0, 300)}`
  );
});

eachInstance('the simulated order is recorded locally', async (instance, t) => {
  // An order that reached the broker but left no local row is invisible to auto-exit, to the
  // risk controls and to the P&L view - the position exists and nothing in the app knows.
  await assertAnalyzerModeAtBroker(instance);
  const live = await liveQuoteOrSkip(t, instance);
  if (!live) return;

  const before = await db.get(
    'SELECT COUNT(*) AS count FROM watchlist_orders WHERE instance_id = ?',
    [instance.id]
  );

  const order = await placeOrSkip(t, instance, live.config);
  if (!order) return;

  const after = await db.get(
    'SELECT COUNT(*) AS count FROM watchlist_orders WHERE instance_id = ?',
    [instance.id]
  );

  assert.strictEqual(
    after.count, before.count + 1,
    'an order that reached the broker must leave a local record'
  );
});

eachInstance('the instance multiplier is applied to what the broker actually receives', async (instance, t) => {
  // Jz Fyers runs at 5x. A multiplier that is stored but not applied means every position is a
  // fraction of the size the operator configured.
  await assertAnalyzerModeAtBroker(instance);
  const live = await liveQuoteOrSkip(t, instance);
  if (!live) return;

  const multiplier = Number(instance.multiplier) || 1;
  const sent = [];
  const original = openalgoClient.request.bind(openalgoClient);
  openalgoClient.request = async (inst, endpoint, data, method, options) => {
    if (endpoint === 'placesmartorder') sent.push(data);
    return original(inst, endpoint, data, method, options);
  };

  let placed;
  try {
    placed = await placeOrSkip(t, instance, live.config);
  } finally {
    openalgoClient.request = original;
  }
  if (!placed) return;

  assert.strictEqual(sent.length, 1, 'exactly one order should have been sent');
  assert.strictEqual(
    Number(sent[0].quantity), multiplier,
    `quantity 1 on a ${multiplier}x instance must reach the broker as ${multiplier}`
  );
});

eachInstance('an order for a symbol the broker does not know is rejected, not silently accepted', async (instance) => {
  await assertAnalyzerModeAtBroker(instance);
  const config = SYMBOLS[instance.name];
  await assert.rejects(
    () => orderService.placeOrder({
      instanceId: instance.id,
      exchange: config.exchange,
      symbol: 'DEFINITELYNOTAREALSYMBOL999',
      action: 'BUY',
      quantity: 1,
      position_size: 1,
      product: config.product,
      pricetype: 'MARKET',
      source: 'live_test',
      trigger_type: 'Manual',
    }),
    'an unknown symbol must produce an error the operator can see'
  );
});

// ---------------------------------------------------------------------------
// Cleanup - must stay the LAST test in this file
// ---------------------------------------------------------------------------

test('every order and position this suite opened is closed', { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests' }, async (t) => {
  const leftovers = await closeEverythingOpened(instances, touched, (msg) => t.diagnostic(msg));
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});
