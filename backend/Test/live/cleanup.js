import assert from 'assert';

import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import orderService from '../../src/services/order.service.js';

/**
 * Leave nothing behind. Every live suite records each symbol it sent an order for, and its last
 * test cancels whatever is still working on those symbols and flattens their positions, then
 * re-reads the books and fails if anything is still open.
 *
 * Only symbols a live test has ever ordered are acted on - this run's, plus every symbol recorded
 * locally with source 'live_test' (an earlier run's ATM strike is not this run's) - never an
 * instance's other positions, and only after the broker confirms analyzer mode.
 */

const ORDER_ENDPOINTS = new Set(['placeorder', 'placesmartorder', 'splitorder', 'basketorder']);
const OPEN_STATUSES = /^(open|pending|trigger pending|trigger_pending|validation pending|put order req received|modify pending|amo req received)$/i;

/** Wraps the client so every order this process sends is recorded. Returns the record. */
export function trackOrders() {
  const touched = new Map(); // instanceId -> Map(symbol -> exchange)
  const original = openalgoClient.request.bind(openalgoClient);
  openalgoClient.request = async (inst, endpoint, data, ...rest) => {
    if (ORDER_ENDPOINTS.has(endpoint)) {
      const rows = endpoint === 'basketorder' ? (data?.orders || []) : [data];
      if (!touched.has(inst.id)) touched.set(inst.id, new Map());
      for (const row of rows) if (row?.symbol) touched.get(inst.id).set(row.symbol, row.exchange);
    }
    return original(inst, endpoint, data, ...rest);
  };
  return touched;
}

const symbolOf = (row) => row?.symbol || row?.tradingsymbol || row?.trading_symbol;
const netOf = (row) => Number(row?.quantity ?? row?.netqty ?? row?.net_quantity ?? 0);
const statusOf = (row) => String(row?.order_status || row?.status || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openOrders(instance, symbols) {
  const book = await openalgoClient.getOrderBook(instance);
  const orders = Array.isArray(book) ? book : (book?.orders || []);
  return orders.filter((o) => symbols.has(symbolOf(o)) && OPEN_STATUSES.test(statusOf(o)));
}

async function openPositions(instance, symbols) {
  const book = await openalgoClient.getPositionBook(instance);
  return (Array.isArray(book) ? book : []).filter((p) => symbols.has(symbolOf(p)) && netOf(p) !== 0);
}

async function assertAnalyzer(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  assert.ok(on, `REFUSING TO CLEAN UP: ${instance.name} did not confirm analyzer mode`);
}

/**
 * Cancel working orders and flatten positions on every touched symbol, then verify. Returns a
 * list of what is still open (empty when clean) so the caller can assert on it.
 */
export async function closeEverythingOpened(instances, touched, log = () => {}, { includePast = true } = {}) {
  const leftovers = [];
  for (const instance of instances) {
    const symbols = new Map(touched.get(instance.id) || []);
    if (includePast) {
      const past = await db.all(
        "SELECT DISTINCT symbol, exchange FROM watchlist_orders WHERE instance_id = ? AND source LIKE 'live_test%'",
        [instance.id]
      );
      for (const row of past) if (!symbols.has(row.symbol)) symbols.set(row.symbol, row.exchange);
    }
    if (symbols.size === 0) continue;
    // One instance failing must not stop the others being cleaned - and an instance that could
    // not be verified is reported, never silently assumed clean.
    try {
      leftovers.push(...await cleanInstance(instance, symbols, log));
    } catch (error) {
      leftovers.push(`${instance.name}: could not verify - ${error.message}`);
    }
  }
  return leftovers;
}

/** Flatten one symbol after a test, whatever state the test left it in. Never throws. */
export async function flattenSymbol(instance, contract, log = () => {}) {
  const one = new Map([[instance.id, new Map([[contract.symbol, contract.exchange]])]]);
  const left = await closeEverythingOpened([instance], one, log, { includePast: false }).catch((e) => [e.message]);
  left.forEach((l) => log(`still open after test: ${l}`));
}

async function cleanInstance(instance, symbols, log) {
  // A slow broker trips the circuit breaker, which would pause these very calls. Cleanup is
  // the one thing that must get through, so it clears the pause first.
  openalgoClient.forceResetInstanceHealth(instance.id);
  await assertAnalyzer(instance);
  const strategy = instance.strategy_tag || 'default';

  for (const order of await openOrders(instance, symbols)) {
    await openalgoClient.cancelOrder(instance, order.orderid, strategy)
      .then(() => log(`${instance.name}: cancelled ${order.orderid} ${symbolOf(order)}`))
      .catch((error) => log(`${instance.name}: cancel ${order.orderid} failed - ${error.message}`));
  }

  for (const position of await openPositions(instance, symbols)) {
    const net = netOf(position);
    await orderService.placeOrder({
      instanceId: instance.id,
      exchange: position.exchange || symbols.get(symbolOf(position)),
      symbol: symbolOf(position),
      action: net > 0 ? 'SELL' : 'BUY',
      quantity: Math.abs(net),
      position_size: 0,
      product: position.product || 'MIS',
      pricetype: 'MARKET', // priced to a LIMIT for Indian exchanges by the order path
      source: 'live_test_cleanup',
      trigger_type: 'Manual',
    })
      .then(() => log(`${instance.name}: flattened ${symbolOf(position)} (was ${net})`))
      .catch((error) => log(`${instance.name}: flatten ${symbolOf(position)} failed - ${error.message}`));
  }

  // Analyzer fills are quick but not synchronous with the books; give them a few seconds.
  let stillOpen = [];
  for (let i = 0; i < 5; i += 1) {
    if (i) await sleep(1500);
    stillOpen = [
      ...(await openOrders(instance, symbols)).map((o) => `order ${o.orderid} ${symbolOf(o)} ${statusOf(o)}`),
      ...(await openPositions(instance, symbols)).map((p) => `position ${symbolOf(p)} net ${netOf(p)}`),
    ];
    if (stillOpen.length === 0) break;
  }
  return stillOpen.map((s) => `${instance.name}: ${s}`);
}
