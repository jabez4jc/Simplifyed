import assert from 'assert';
import test, { before, after } from 'node:test';

import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import orderService from '../../src/services/order.service.js';
import { trackOrders, closeEverythingOpened, flattenSymbol } from './cleanup.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';
import { upcomingExpiries } from '../../src/utils/underlying.util.js';
import { isCryptoBroker, isCryptoExchange } from '../../src/utils/broker-type.util.js';

/**
 * Live F&O coverage for what is actually traded: index F&O (NFO/BFO), MCX F&O, and Delta
 * Exchange crypto futures and options. Read Test/live/README.md first.
 *
 * Same safety rule as live-orders.test.js: nothing is placed until the BROKER confirms analyzer
 * mode, checked per test. Contracts are picked from the instruments cache at run time - the
 * nearest unexpired future and the at-the-money option - because hardcoded expiries go stale.
 *
 * SEBI requires retail algo orders on Indian exchanges to be LIMIT orders, so every order sent to
 * NFO/BFO/MCX must reach the broker as LIMIT, priced on the contract's tick, in whole lots.
 * Crypto is outside that rule and Delta Exchange accepts MARKET orders.
 */

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === 'true';
const ALLOWED_INSTANCES = ['Jz Kotak', 'Jz Fyers', 'Maha', 'Ana', 'Jabez Crypto'];

const INDIAN_UNDERLYINGS = [
  { exchange: 'NFO', name: 'NIFTY', options: true },
  { exchange: 'NFO', name: 'BANKNIFTY', options: true },
  { exchange: 'BFO', name: 'SENSEX', options: true },
  { exchange: 'MCX', name: 'CRUDEOIL', options: true },
  { exchange: 'MCX', name: 'NATURALGAS', options: false },
  { exchange: 'MCX', name: 'GOLDM', options: false }, // Kotak lot 100 vs cache 10
  { exchange: 'MCX', name: 'GOLD', options: false }, // Kotak lot 1 vs cache 100
  { exchange: 'MCX', name: 'ZINC', options: false }, // Kotak lot 5 vs cache 5000
];
const CRYPTO_UNDERLYINGS = [
  { perp: 'BTCUSDFUT', name: 'BTC' },
  { perp: 'ETHUSDFUT', name: 'ETH' },
];

let instances = [];
let touched = new Map(); // instanceId -> symbols this suite ordered, for the final cleanup
const contractsBySegment = { indian: [], crypto: [] };
const sent = []; // every placesmartorder payload, in order

const segmentOf = (instance) => (isCryptoBroker(instance.broker) ? 'crypto' : 'indian');
const onTick = (price, tick) => Math.abs(price / tick - Math.round(price / tick)) < 1e-6;
const floorToTick = (price, tick) => Number((Math.floor(price / tick) * tick).toFixed(4));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nearestExpiry(exchange, name, type) {
  const rows = await db.all(
    'SELECT DISTINCT expiry FROM instruments WHERE exchange = ? AND name = ? AND instrumenttype = ?',
    [exchange, name, type]
  );
  return upcomingExpiries(rows, new Date(), { crypto: isCryptoExchange(exchange) })[0] || null;
}

async function instrument(where, params) {
  return db.get(`SELECT symbol, exchange, lotsize, tick_size FROM instruments WHERE ${where}`, params);
}

async function ltpOf(instance, exchange, symbol) {
  const quote = await openalgoClient.getQuote(instance, symbol, exchange);
  const ltp = Number(quote?.ltp ?? quote?.last_price ?? quote?.lp);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

async function atmOption(exchange, name, type, spot) {
  const expiry = await nearestExpiry(exchange, name, type);
  if (!expiry || !spot) return null;
  return instrument(
    'exchange = ? AND name = ? AND instrumenttype = ? AND expiry = ? ORDER BY ABS(strike - ?) LIMIT 1',
    [exchange, name, type, expiry, spot]
  );
}

const asContract = (label, row) => row && {
  label, exchange: row.exchange, symbol: row.symbol,
  lot: Number(row.lotsize) || 1, tick: Number(row.tick_size) || 0.05,
};

/** A price from the first instance of the segment that answers - one slow broker must not blank the rest. */
async function anyLtp(quoteInstances, exchange, symbol) {
  for (const inst of quoteInstances) {
    const ltp = await ltpOf(inst, exchange, symbol).catch(() => null);
    if (ltp) return ltp;
  }
  return null;
}

async function resolveContracts(quoteInstances, segment) {
  const out = [];
  if (segment === 'indian') {
    for (const u of INDIAN_UNDERLYINGS) {
      const futExpiry = await nearestExpiry(u.exchange, u.name, 'FUT');
      const fut = futExpiry && await instrument(
        "exchange = ? AND name = ? AND instrumenttype = 'FUT' AND expiry = ?", [u.exchange, u.name, futExpiry]
      );
      out.push(asContract(`${u.name} future`, fut) || { label: `${u.name} future`, missing: true });
      if (u.options) {
        const spot = fut && await anyLtp(quoteInstances, u.exchange, fut.symbol);
        const opt = await atmOption(u.exchange, u.name, 'CE', spot);
        out.push(asContract(`${u.name} ATM call`, opt) || { label: `${u.name} ATM call`, missing: true });
      }
    }
  } else {
    for (const u of CRYPTO_UNDERLYINGS) {
      const perp = await instrument("exchange = 'CRYPTO' AND symbol = ?", [u.perp]);
      out.push(asContract(`${u.name} perpetual`, perp) || { label: `${u.name} perpetual`, missing: true });
      const spot = perp && await anyLtp(quoteInstances, 'CRYPTO', perp.symbol);
      const opt = await atmOption('CRYPTO', u.name, 'PE', spot);
      out.push(asContract(`${u.name} ATM put`, opt) || { label: `${u.name} ATM put`, missing: true });
    }
  }
  return out;
}

before(async () => {
  if (!LIVE_ENABLED) return;
  process.env.DATABASE_PATH = process.env.DATABASE_PATH || './database/simplifyed.db';
  await db.connect();
  touched = trackOrders();
  instances = await db.all(
    `SELECT * FROM instances WHERE name IN (${ALLOWED_INSTANCES.map(() => '?').join(', ')}) ORDER BY id`,
    ALLOWED_INSTANCES
  );
  for (const segment of ['indian', 'crypto']) {
    const quoteInstances = instances.filter((i) => segmentOf(i) === segment);
    if (quoteInstances.length) contractsBySegment[segment] = await resolveContracts(quoteInstances, segment);
  }
  const original = openalgoClient.request.bind(openalgoClient);
  openalgoClient.request = async (inst, endpoint, data, ...rest) => {
    if (endpoint === 'placesmartorder') sent.push({ instanceId: inst.id, ...data });
    return original(inst, endpoint, data, ...rest);
  };
});

after(async () => {
  if (!LIVE_ENABLED) return;
  await db.close().catch(() => {});
});

async function assertAnalyzerModeAtBroker(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  assert.ok(on, `REFUSING TO TRADE: ${instance.name} did not confirm analyzer mode. Broker said: ${JSON.stringify(status)}`);
}

async function skipIfClosed(t, instance, contract) {
  if (isCryptoExchange(contract.exchange)) return false;
  if (await marketCalendarService.isExchangeOpen(contract.exchange, new Date(), instance)) return false;
  t.skip(`${contract.exchange} is closed - orders need a live market`);
  return true;
}

/** Runs fn once per (instance, contract) of that instance's segment. */
function eachContract(name, fn, { orders = false } = {}) {
  test(name, { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests' }, async (t) => {
    assert.ok(instances.length > 0, `None of ${ALLOWED_INSTANCES.join(', ')} were found in the database`);
    for (const instance of instances) {
      for (const contract of contractsBySegment[segmentOf(instance)]) {
        await t.test(`${instance.name} - ${contract.label}${contract.symbol ? ` (${contract.symbol})` : ''}`, async (st) => {
          assert.ok(!contract.missing, `no unexpired ${contract.label} in the instruments cache - is the master contract stale?`);
          try {
            await fn(instance, contract, st);
          } finally {
            // Pass or fail, a test that ordered leaves its symbol flat - a leftover lot would
            // change what the next test's position-targeted order does.
            if (orders && touched.get(instance.id)?.has(contract.symbol)) {
              await flattenSymbol(instance, contract, (m) => st.diagnostic(m));
            }
          }
        });
      }
    }
  });
}

/** Orders placed since `mark` for this instance and symbol. */
const sentSince = (mark, instance, contract) =>
  sent.slice(mark).filter((o) => o.instanceId === instance.id && o.symbol === contract.symbol);

function assertCompliantPayload(order, instance, contract) {
  const mult = Math.max(Number(instance.multiplier) || 1, 1);
  if (!isCryptoExchange(contract.exchange)) {
    assert.strictEqual(order.pricetype, 'LIMIT', `${contract.exchange} order went out as ${order.pricetype} - SEBI requires LIMIT`);
  }
  if (order.pricetype === 'LIMIT') {
    const price = Number(order.price);
    assert.ok(price > 0, `LIMIT with no price: ${JSON.stringify(order)}`);
    assert.ok(onTick(price, contract.tick), `price ${price} is not a multiple of the ${contract.tick} tick`);
  }
  assert.strictEqual(Number(order.quantity) % contract.lot, 0, `quantity ${order.quantity} is not whole lots of ${contract.lot}`);
  assert.strictEqual(Number(order.quantity), contract.lot * mult, `one lot on a ${mult}x instance must be ${contract.lot * mult}`);
}

async function netPosition(instance, contract) {
  const book = await openalgoClient.getPositionBook(instance);
  // Sum every product row for the symbol - an old MIS row at 0 can sit beside a live NRML one.
  return (Array.isArray(book) ? book : [])
    .filter((p) => (p.symbol || p.tradingsymbol) === contract.symbol)
    .reduce((sum, p) => sum + Number(p.quantity ?? p.netqty ?? 0), 0);
}

const placeLots = (instance, contract, action, positionLots, extra = {}) => orderService.placeOrder({
  instanceId: instance.id, exchange: contract.exchange, symbol: contract.symbol, action,
  quantity: contract.lot, position_size: contract.lot * positionLots, product: 'MIS',
  pricetype: 'MARKET', source: 'live_test', trigger_type: 'Manual', ...extra,
});

// ---------------------------------------------------------------------------
// Market data - no orders
// ---------------------------------------------------------------------------

eachContract('the contract quotes with a usable price', async (instance, contract) => {
  const ltp = await ltpOf(instance, contract.exchange, contract.symbol);
  assert.ok(ltp, `no last price for ${contract.exchange}:${contract.symbol}`);
});

eachContract('the depth book is two-sided and not crossed', async (instance, contract, t) => {
  if (await skipIfClosed(t, instance, contract)) return;
  const depth = await openalgoClient.getDepth(instance, contract.exchange, contract.symbol);
  const bid = Number((depth?.bids || depth?.buy || [])[0]?.price);
  const ask = Number((depth?.asks || depth?.sell || [])[0]?.price);
  assert.ok(bid > 0 && ask > 0, `one-sided book: bid ${bid}, ask ${ask}`);
  assert.ok(bid <= ask, `crossed book: bid ${bid} > ask ${ask}`);
  assert.ok(onTick(bid, contract.tick) && onTick(ask, contract.tick), `book prices off the ${contract.tick} tick`);
});

// ---------------------------------------------------------------------------
// Orders - analyzer mode only, gated per test
// ---------------------------------------------------------------------------

eachContract('one lot is bought and flattened with compliant orders', async (instance, contract, t) => {
  await assertAnalyzerModeAtBroker(instance);
  if (await skipIfClosed(t, instance, contract)) return;

  const mark = sent.length;
  const opened = await placeLots(instance, contract, 'BUY', 1);
  assert.ok(opened.order_id || opened.orderid || opened.id, `no order id on entry: ${JSON.stringify(opened).slice(0, 300)}`);
  const closed = await placeLots(instance, contract, 'SELL', 0);
  assert.ok(closed.order_id || closed.orderid || closed.id, `no order id on exit: ${JSON.stringify(closed).slice(0, 300)}`);

  const orders = sentSince(mark, instance, contract);
  assert.ok(orders.length >= 2, `expected an entry and an exit, broker received ${orders.length}`);
  for (const order of orders) assertCompliantPayload(order, instance, contract);

  // The exit must actually leave the book flat - a leftover lot is invisible risk.
  let net = null;
  for (let i = 0; i < 4 && net !== 0; i += 1) {
    if (i) await sleep(1000);
    net = await netPosition(instance, contract);
  }
  assert.strictEqual(net, 0, `position left open after the exit: ${net}`);
}, { orders: true });

eachContract('a caller-priced resting limit is sent exactly as priced and can be cancelled', async (instance, contract, t) => {
  await assertAnalyzerModeAtBroker(instance);
  if (await skipIfClosed(t, instance, contract)) return;

  const ltp = await ltpOf(instance, contract.exchange, contract.symbol);
  assert.ok(ltp, 'need a price to rest below');
  const restAt = floorToTick(ltp * 0.99, contract.tick); // 1% under: rests, inside exchange price bands

  const mark = sent.length;
  const placed = await placeLots(instance, contract, 'BUY', 1, { pricetype: 'LIMIT', price: restAt });
  const orderId = placed.order_id || placed.orderid;
  assert.ok(orderId, `no order id: ${JSON.stringify(placed).slice(0, 300)}`);

  const [order] = sentSince(mark, instance, contract);
  assert.strictEqual(order.pricetype, 'LIMIT');
  assert.strictEqual(Number(order.price), restAt, 'a caller-chosen price must never be rewritten');

  await cancelOrFlatten(t, instance, contract, orderId);
}, { orders: true });

eachContract('an SL-M stop goes out as a stop-loss limit (SL) past its trigger on Indian exchanges', async (instance, contract, t) => {
  await assertAnalyzerModeAtBroker(instance);
  if (await skipIfClosed(t, instance, contract)) return;

  const ltp = await ltpOf(instance, contract.exchange, contract.symbol);
  assert.ok(ltp, 'need a price to set the stop from');
  const trigger = floorToTick(ltp * 1.01, contract.tick); // a buy stop 1% above the market

  const mark = sent.length;
  const placed = await placeLots(instance, contract, 'BUY', 1, { pricetype: 'SL-M', trigger_price: trigger });
  const orderId = placed.order_id || placed.orderid;
  assert.ok(orderId, `no order id: ${JSON.stringify(placed).slice(0, 300)}`);

  const [order] = sentSince(mark, instance, contract);
  if (isCryptoExchange(contract.exchange)) {
    assert.strictEqual(order.pricetype, 'SL-M', 'crypto keeps its stop-market');
  } else {
    assert.strictEqual(order.pricetype, 'SL', 'Indian brokers take no SL-M from algos (SEBI)');
    assert.ok(Number(order.price) > trigger, `a buy stop's limit must sit above its trigger ${trigger}, got ${order.price}`);
    assert.ok(onTick(Number(order.price), contract.tick), `limit ${order.price} is off the ${contract.tick} tick`);
  }
  assert.strictEqual(Number(order.trigger_price), trigger, 'the trigger is sent as given');

  await cancelOrFlatten(t, instance, contract, orderId);
}, { orders: true });

/**
 * Analyzer mode fills a resting limit at once (observed on every broker here), so a cancel can
 * find the order complete. Either way the test must not leave a position behind.
 */
async function cancelOrFlatten(t, instance, contract, orderId) {
  try {
    const cancelled = await openalgoClient.cancelOrder(instance, orderId, instance.strategy_tag || 'default');
    assert.strictEqual(cancelled.status, 'success', `cancel failed: ${JSON.stringify(cancelled)}`);
    return;
  } catch (error) {
    if (!/complete/i.test(error.message)) throw error;
    t.diagnostic(`analyzer filled order ${orderId} immediately - flattening instead of cancelling`);
  }
  await placeLots(instance, contract, 'SELL', 0);
  let net = null;
  for (let i = 0; i < 4 && net !== 0; i += 1) {
    if (i) await sleep(1000);
    net = await netPosition(instance, contract);
  }
  assert.strictEqual(net, 0, `position left open after flattening: ${net}`);
}

// ---------------------------------------------------------------------------
// Cleanup - must stay the LAST test in this file
// ---------------------------------------------------------------------------

test('every order and position this suite opened is closed', { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests' }, async (t) => {
  const leftovers = await closeEverythingOpened(instances, touched, (msg) => t.diagnostic(msg));
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});
