import { useLiveDatabase } from './live-db.js';
import assert from 'assert';
import test, { before, after } from 'node:test';

import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import watchlistService from '../../src/services/watchlist.service.js';
import watchlistSymbolService from '../../src/services/watchlist-symbol.service.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import strategyService from '../../src/services/strategy.service.js';
import { upcomingExpiries } from '../../src/utils/underlying.util.js';
import { isCryptoExchange } from '../../src/utils/broker-type.util.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';
import { trackOrders, closeEverythingOpened } from './cleanup.js';

/**
 * Orders the way the dashboard places them: from a watchlist row (quick orders, fanned out to
 * every instance assigned to the watchlist) and from a strategy (every leg on every instance the
 * strategy is scoped to). Read Test/live/README.md first.
 *
 * The suite builds its own temporary records - an Indian watchlist (copy of "Indices" plus MCX
 * and NSE rows), a crypto watchlist (copy of "Crypto") and a strategy watchlist - and deletes
 * them at the end. Auto-exit settings are cleared on the copies so the running server's auto-exit
 * cannot act on test positions. Every order is preceded by a broker-side analyzer check, and the
 * last tests close everything the suite opened and verify the books are flat.
 */

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === 'true';
// Workflow suite: Maha and Ana are reserved for the live order tests (live-orders, live-fno).
const INDIAN = ['Jz Kotak', 'Jz Fyers'];
const CRYPTO = ['Jabez Crypto'];
const TAG = `LIVE TEST ${new Date().toISOString().slice(0, 16)}`;

let instances = [];
let touched = new Map();
const sent = []; // every order payload that reached the client, canonical units
const made = { watchlists: [], strategies: [] };
const rows = {}; // label -> watchlist_symbols row
const strategies = {}; // label -> strategy id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (names) => instances.filter((i) => names.includes(i.name));

const EXIT_FIELDS = [
  'target_points_direct', 'stoploss_points_direct', 'trailing_stoploss_points_direct', 'trailing_activation_points_direct',
  'target_points_futures', 'stoploss_points_futures', 'trailing_stoploss_points_futures', 'trailing_activation_points_futures',
  'target_points_options', 'stoploss_points_options', 'trailing_stoploss_points_options', 'trailing_activation_points_options',
];

async function assertAnalyzerModeAtBroker(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  assert.ok(on, `REFUSING TO TRADE: ${instance.name} did not confirm analyzer mode`);
}

async function copyWatchlist(sourceId, name, instanceNames) {
  const wl = await watchlistService.cloneWatchlist(sourceId, name);
  made.watchlists.push(wl.id);
  await watchlistService.updateWatchlist(wl.id, { is_active: true }); // clones start inactive
  const clear = EXIT_FIELDS.map((f) => `${f} = NULL`).join(', ');
  await db.run(`UPDATE watchlist_symbols SET ${clear} WHERE watchlist_id = ?`, [wl.id]);
  for (const inst of byName(instanceNames)) await watchlistService.assignInstance(wl.id, inst.id);
  return wl;
}

async function nearestFuture(exchange, name) {
  const expiries = await db.all("SELECT DISTINCT expiry FROM instruments WHERE exchange = ? AND name = ? AND instrumenttype = 'FUT'", [exchange, name]);
  const expiry = upcomingExpiries(expiries)[0];
  return db.get("SELECT * FROM instruments WHERE exchange = ? AND name = ? AND instrumenttype = 'FUT' AND expiry = ?", [exchange, name, expiry]);
}

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

/** The nearest live expiry, as the dashboard sends it (its dropdown's first entry, YYYY-MM-DD). */
async function uiExpiry(exchange, name, type) {
  const rowsE = await db.all('SELECT DISTINCT expiry FROM instruments WHERE exchange = ? AND name = ? AND instrumenttype = ?', [exchange, name, type]);
  const dmy = upcomingExpiries(rowsE, new Date(), { crypto: isCryptoExchange(exchange) })[0];
  assert.ok(dmy, `no live ${type} expiry for ${exchange}:${name}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy; // crypto feeds may already send ISO
  const [d, m, y] = dmy.split('-');
  return `20${y}-${MONTHS[m]}-${d}`;
}

async function addRow(watchlistId, label, fields) {
  const row = await watchlistSymbolService.addSymbol(watchlistId, {
    qty_type: 'LOTS', qty_value: 1, product_type: 'MIS', is_enabled: 1,
    operating_mode: 'BUYER', strike_policy: 'FLOAT_OFS', step_lots: 1, options_expiry_mode: 'AUTO', ...fields,
  });
  rows[label] = row;
  return row;
}

before(async () => {
  if (!LIVE_ENABLED) return;
  await useLiveDatabase();
  await db.connect();
  touched = trackOrders();
  const original = openalgoClient.request.bind(openalgoClient);
  openalgoClient.request = async (inst, endpoint, data, ...rest) => {
    if (['placesmartorder', 'placeorder', 'basketorder'].includes(endpoint)) {
      const list = endpoint === 'basketorder' ? (data?.orders || []) : [data];
      for (const o of list) sent.push({ instance: inst.name, endpoint, ...o });
    }
    return original(inst, endpoint, data, ...rest);
  };

  instances = await db.all(
    `SELECT * FROM instances WHERE name IN (${[...INDIAN, ...CRYPTO].map(() => '?').join(', ')}) ORDER BY id`,
    [...INDIAN, ...CRYPTO]
  );
  for (const inst of instances) await assertAnalyzerModeAtBroker(inst);

  // Indian watchlist: your Indices rows, plus an MCX future and an NSE stock.
  const indian = await copyWatchlist(2, `${TAG} Indian`, INDIAN);
  const idx = await db.all('SELECT * FROM watchlist_symbols WHERE watchlist_id = ?', [indian.id]);
  for (const r of idx) rows[r.symbol] = r;
  const crude = await nearestFuture('MCX', 'CRUDEOIL');
  await addRow(indian.id, 'CRUDEOIL', {
    exchange: 'MCX', symbol: crude.symbol, symbol_type: 'FUTURES', lot_size: crude.lotsize, tick_size: crude.tick_size,
    expiry: crude.expiry, underlying_symbol: 'CRUDEOIL', name: 'CRUDEOIL', instrumenttype: 'FUT',
    tradable_equity: 0, tradable_futures: 1, tradable_options: 1,
  });
  const goldm = await nearestFuture('MCX', 'GOLDM');
  await addRow(indian.id, 'GOLDM', {
    exchange: 'MCX', symbol: goldm.symbol, symbol_type: 'FUTURES', lot_size: goldm.lotsize, tick_size: goldm.tick_size,
    expiry: goldm.expiry, underlying_symbol: 'GOLDM', name: 'GOLDM', instrumenttype: 'FUT',
    tradable_equity: 0, tradable_futures: 1, tradable_options: 0,
  });
  await addRow(indian.id, 'SBIN', {
    exchange: 'NSE', symbol: 'SBIN', symbol_type: 'EQUITY', lot_size: 1, tick_size: 0.05, qty_type: 'FIXED',
    underlying_symbol: 'SBIN', name: 'SBIN', instrumenttype: 'EQ', tradable_equity: 1, tradable_futures: 0, tradable_options: 0,
  });
  // An expired contract in the list - it must be refused, and nothing sent.
  await addRow(indian.id, 'EXPIRED', {
    exchange: 'MCX', symbol: 'NATGASMINI26AUG26FUT', symbol_type: 'FUTURES', lot_size: 250, expiry: '26-AUG-26',
    underlying_symbol: 'NATGASMINI', name: 'NATGASMINI', instrumenttype: 'FUT', tradable_futures: 1, tradable_options: 1,
  });

  // Crypto watchlist: your Crypto rows.
  const crypto = await copyWatchlist(16, `${TAG} Crypto`, CRYPTO);
  for (const r of await db.all('SELECT * FROM watchlist_symbols WHERE watchlist_id = ?', [crypto.id])) rows[r.symbol] = r;

  // Strategy watchlist with three strategies, each scoped to its own instances.
  const sw = await watchlistService.createWatchlist({ name: `${TAG} Strategies`, type: 'strategy', is_active: true });
  made.watchlists.push(sw.id);
  for (const inst of instances) await watchlistService.assignInstance(sw.id, inst.id);
  const mkStrategy = async (label, underlying, exchange, legs, scope) => {
    const s = await strategyService.createStrategy({ watchlist_id: sw.id, name: `${TAG} ${label}`, underlying, exchange });
    made.strategies.push(s.id);
    strategies[label] = s.id;
    for (const leg of legs) {
      // NRML: brokers refuse MIS entries AND exits after the 15:15 square-off, and the dashboard sends F&O as NRML anyway.
      await strategyService.addLeg(s.id, { strike_policy: 'FLOAT_OFS', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', exit_mechanism: 'POLLING', ...leg });
    }
    for (const inst of byName(scope)) await strategyService.assignStrategyInstance(s.id, inst.id);
    // Leg-exit rows seeded by addLeg carry no targets here, but clear them defensively too.
    await db.run(`UPDATE watchlist_symbols SET ${EXIT_FIELDS.map((f) => `${f} = NULL`).join(', ')} WHERE watchlist_id = ?`, [sw.id]);
  };
  await mkStrategy('NIFTY hedge', 'NIFTY', 'NSE_INDEX', [
    { option_type: 'CE', action: 'BUY', strike_offset: 'ATM' },
    { option_type: 'PE', action: 'SELL', strike_offset: 'OTM2' },
  ], INDIAN);
  await mkStrategy('CRUDEOIL put', 'CRUDEOIL', 'MCX', [
    { option_type: 'PE', action: 'BUY', strike_offset: 'ATM' },
  ], INDIAN);
  await mkStrategy('BTC call', 'BTC', 'CRYPTO', [
    { option_type: 'CE', action: 'BUY', strike_offset: 'ATM' },
  ], CRYPTO);
});

after(async () => {
  if (!LIVE_ENABLED) return;
  // Records only - positions are closed and verified by the last test.
  for (const id of made.strategies) await strategyService.deleteStrategy(id).catch(() => {});
  for (const id of made.watchlists) await watchlistService.deleteWatchlist(id).catch(() => {});
  await db.close().catch(() => {});
});

const live = (name, fn) => test(name, { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests' }, fn);

/** Place a quick order the way the dashboard does, and require every instance to succeed. */
async function quick(label, body, expectInstances) {
  const row = rows[label];
  assert.ok(row, `no watchlist row for ${label}`);
  const mark = sent.length;
  // F&O and equity both take MIS; after the 15:15 square-off brokers refuse MIS, so NRML then
  // (equity tests pass their own product).
  const res = await quickOrderService.placeQuickOrder({
    symbolId: row.id, product: afterMisSquareOff() ? 'NRML' : 'MIS', quantity: 1, source: 'live_test', triggerType: 'Manual', ...body,
  });
  const failures = (res.results || []).filter((r) => !r.success)
    .map((r) => `${r.instance_name || r.instance_id}: ${r.error || r.message || JSON.stringify(r).slice(0, 200)}`);
  assert.deepStrictEqual(failures, [], `${label} ${body.action} failed on:\n${failures.join('\n')}`);
  const names = new Set((res.results || []).map((r) => r.instance_name));
  for (const n of expectInstances) assert.ok(names.has(n), `${label} ${body.action}: no result for ${n}`);
  const orders = sent.slice(mark);
  for (const o of orders) {
    if (!isCryptoExchange(o.exchange)) {
      assert.ok(['LIMIT', 'SL'].includes(String(o.pricetype).toUpperCase()), `${o.instance} ${o.exchange}:${o.symbol} went out as ${o.pricetype} - SEBI requires LIMIT`);
    }
  }
  return { res, orders };
}

async function netFor(instance, symbols) {
  const book = await openalgoClient.getPositionBook(instance);
  return (Array.isArray(book) ? book : [])
    .filter((p) => symbols.has(p.symbol))
    // Sum per symbol across product rows - the last row used to overwrite the others.
    .reduce((acc, p) => ({ ...acc, [p.symbol]: (acc[p.symbol] || 0) + Number(p.quantity ?? p.netqty ?? 0) }), {});
}

/** Every symbol these orders touched is flat on every instance that received one. */
async function assertFlat(orders) {
  const bySym = new Map();
  for (const o of orders) {
    if (!bySym.has(o.instance)) bySym.set(o.instance, new Set());
    bySym.get(o.instance).add(o.symbol);
  }
  const open = [];
  for (const [name, symbols] of bySym) {
    const inst = instances.find((i) => i.name === name);
    let net = {};
    for (let i = 0; i < 5; i += 1) {
      if (i) await sleep(1500);
      net = await netFor(inst, symbols);
      if (Object.values(net).every((q) => q === 0)) break;
    }
    for (const [sym, q] of Object.entries(net)) if (q !== 0) open.push(`${name} ${sym} ${q}`);
  }
  assert.deepStrictEqual(open, [], `left open:\n${open.join('\n')}`);
}

// ---------------------------------------------------------------------------
// Watchlist quick orders - Indian (fanned out to Jz Kotak and Jz Fyers)
// ---------------------------------------------------------------------------

/** Skip a test whose exchange is closed - after hours the analyzer and resolution behave differently. */
async function skipIfClosed(t, exchange) {
  if (await marketCalendarService.isExchangeOpen(exchange, new Date(), instances[0])) return false;
  t.skip(`${exchange} is closed`);
  return true;
}

const afterMisSquareOff = () => { const t = new Date(Date.now() + 5.5 * 3600e3); return t.getUTCHours() * 60 + t.getUTCMinutes() >= 15 * 60 + 15; };

// Equity trades as MIS (intraday) or CNC (delivery). Brokers refuse MIS after the 15:15 IST
// square-off but take CNC until the 15:30 close, so each product runs while it is allowed.
for (const product of ['MIS', 'CNC']) {
  live(`equity (${product}): BUY then EXIT on NSE:SBIN - the chosen product reaches the broker`, async (t) => {
    if (await skipIfClosed(t, 'NSE')) return;
    if (product === 'MIS' && afterMisSquareOff()) { t.skip('brokers refuse MIS equity orders after the 15:15 IST square-off'); return; }
    const a = await quick('SBIN', { tradeMode: 'EQUITY', action: 'BUY', product }, INDIAN);
    assert.ok(a.orders.length >= INDIAN.length, `expected an order per instance, got ${a.orders.length}`);
    assert.ok(a.orders.every((o) => o.product === product), `sent as ${[...new Set(a.orders.map((o) => o.product))]}, not ${product}`);
    const b = await quick('SBIN', { tradeMode: 'EQUITY', action: 'EXIT', product }, INDIAN);
    assert.ok(b.orders.every((o) => o.product === product), 'the exit closes the same product it opened');
    await assertFlat([...a.orders, ...b.orders]);
  });
}

live('index futures: BUY then EXIT on NIFTY', async (t) => {
  if (await skipIfClosed(t, 'NFO')) return;
  const expiry = await uiExpiry('NFO', 'NIFTY', 'FUT');
  const a = await quick('NIFTY', { tradeMode: 'FUTURES', action: 'BUY', expiry }, INDIAN);
  assert.ok(a.orders.every((o) => /NIFTY\d{2}[A-Z]{3}\d{2}FUT$/.test(o.symbol)), `expected a NIFTY future, got ${a.orders.map((o) => o.symbol)}`);
  assert.ok(a.orders.every((o) => Number(o.quantity) % 65 === 0), 'whole NIFTY lots');
  const b = await quick('NIFTY', { tradeMode: 'FUTURES', action: 'EXIT', expiry }, INDIAN);
  await assertFlat([...a.orders, ...b.orders]);
});

live('MCX futures: SHORT then COVER on CRUDEOIL', async () => {
  const a = await quick('CRUDEOIL', { tradeMode: 'FUTURES', action: 'SHORT' }, INDIAN);
  const b = await quick('CRUDEOIL', { tradeMode: 'FUTURES', action: 'COVER' }, INDIAN);
  await assertFlat([...a.orders, ...b.orders]);
});

live('MCX futures where Kotak counts lots differently: BUY then EXIT on GOLDM', async () => {
  const a = await quick('GOLDM', { tradeMode: 'FUTURES', action: 'BUY' }, INDIAN);
  const b = await quick('GOLDM', { tradeMode: 'FUTURES', action: 'EXIT' }, INDIAN);
  await assertFlat([...a.orders, ...b.orders]);
});

live('index options (buyer): BUY_CE x2, REDUCE_CE, CLOSE_ALL_CE on NIFTY - and INCREASE_CE never squares off a long', async (t) => {
  if (await skipIfClosed(t, 'NFO')) return;
  const opts = { tradeMode: 'OPTIONS', optionsLeg: 'ATM', operatingMode: 'BUYER', strikePolicy: 'FLOAT_OFS', stepLots: 1, expiry: await uiExpiry('NFO', 'NIFTY', 'CE') };
  const all = [];
  for (const action of ['BUY_CE', 'BUY_CE']) all.push(...(await quick('NIFTY', { ...opts, action }, INDIAN)).orders);

  // INCREASE is the writer action (buy back a short). On a long it must do nothing - it used to
  // compute a target of 0 and close the position.
  const mark = sent.length;
  const guard = await quickOrderService.placeQuickOrder({ symbolId: rows.NIFTY.id, quantity: 1, product: 'MIS', source: 'live_test', ...opts, action: 'INCREASE_CE' })
    .catch((e) => ({ threw: e.message }));
  assert.strictEqual(sent.length, mark, `INCREASE_CE on a long sent orders: ${JSON.stringify(guard).slice(0, 200)}`);

  all.push(...(await quick('NIFTY', { ...opts, action: 'REDUCE_CE' }, INDIAN)).orders);
  all.push(...(await quick('NIFTY', { ...opts, action: 'CLOSE_ALL_CE' }, INDIAN)).orders);
  assert.ok(all.every((o) => /CE$/.test(o.symbol)), 'only calls were traded');
  await assertFlat(all);
});

live('index options (writer): SELL_PE x2, INCREASE_PE, EXIT_ALL on SENSEX', async (t) => {
  if (await skipIfClosed(t, 'BFO')) return;
  const opts = { tradeMode: 'OPTIONS', optionsLeg: 'ATM', operatingMode: 'WRITER', strikePolicy: 'FLOAT_OFS', stepLots: 1, expiry: await uiExpiry('BFO', 'SENSEX', 'PE') };
  const all = [];
  for (const action of ['SELL_PE', 'SELL_PE', 'INCREASE_PE', 'EXIT_ALL']) all.push(...(await quick('SENSEX', { ...opts, action }, INDIAN)).orders);
  assert.ok(all.some((o) => o.exchange === 'BFO' && /PE$/.test(o.symbol)), 'a SENSEX put on BFO');
  await assertFlat(all);
});

live('MCX options: BUY_PE then EXIT_ALL on CRUDEOIL', async () => {
  const opts = { tradeMode: 'OPTIONS', optionsLeg: 'ATM', operatingMode: 'BUYER', strikePolicy: 'FLOAT_OFS', stepLots: 1, expiry: await uiExpiry('MCX', 'CRUDEOIL', 'PE') };
  const a = await quick('CRUDEOIL', { ...opts, action: 'BUY_PE' }, INDIAN);
  assert.ok(a.orders.some((o) => o.exchange === 'MCX' && /PE$/.test(o.symbol)), 'a CRUDEOIL put on MCX');
  const b = await quick('CRUDEOIL', { ...opts, action: 'EXIT_ALL' }, INDIAN);
  await assertFlat([...a.orders, ...b.orders]);
});

live('an expired watchlist contract is refused and nothing reaches any broker', async () => {
  const mark = sent.length;
  await assert.rejects(
    () => quickOrderService.placeQuickOrder({ symbolId: rows.EXPIRED.id, tradeMode: 'FUTURES', action: 'BUY', quantity: 1, product: 'MIS', source: 'live_test' }),
    /expired/i
  );
  assert.strictEqual(sent.length, mark, 'no order may be sent for an expired contract');
});

// ---------------------------------------------------------------------------
// Watchlist quick orders - crypto (Delta Exchange)
// ---------------------------------------------------------------------------

live('crypto perpetual: BUY then EXIT on BTCUSDFUT', async () => {
  const a = await quick('BTCUSDFUT', { tradeMode: 'FUTURES', action: 'BUY' }, CRYPTO);
  const b = await quick('BTCUSDFUT', { tradeMode: 'FUTURES', action: 'EXIT' }, CRYPTO);
  await assertFlat([...a.orders, ...b.orders]);
});

live('crypto options: BUY_CE then EXIT_ALL on BTC', async () => {
  const opts = { tradeMode: 'OPTIONS', optionsLeg: 'ATM', operatingMode: 'BUYER', strikePolicy: 'FLOAT_OFS', stepLots: 1, expiry: await uiExpiry('CRYPTO', 'BTC', 'CE') };
  const a = await quick('BTCUSDFUT', { ...opts, action: 'BUY_CE' }, CRYPTO);
  assert.ok(a.orders.some((o) => /^BTC\d.*CE$/.test(o.symbol)), `a BTC call, got ${a.orders.map((o) => o.symbol)}`);
  const b = await quick('BTCUSDFUT', { ...opts, action: 'EXIT_ALL' }, CRYPTO);
  await assertFlat([...a.orders, ...b.orders]);
});

// ---------------------------------------------------------------------------
// Strategies - execute every leg on every scoped instance, then exit
// ---------------------------------------------------------------------------

async function runStrategy(label, scope, legCount) {
  const mark = sent.length;
  const exec = await strategyService.executeStrategy(strategies[label], { source: 'live_test' });
  const problems = [];
  for (const inst of exec.instances) {
    if (!inst.success) problems.push(`${inst.instanceName}: ${inst.error || JSON.stringify(inst.legs).slice(0, 300)}`); // error now carries the broker's reason
    for (const leg of inst.legs || []) {
      if (leg.success === false || leg.status === 'FAILED') problems.push(`${inst.instanceName} leg ${leg.legId ?? leg.leg_id}: ${leg.error || leg.message}`);
    }
  }
  assert.deepStrictEqual(problems, [], `${label} execute:\n${problems.join('\n')}`);
  assert.deepStrictEqual(exec.instances.map((i) => i.instanceName).sort(), [...scope].sort(), `${label} ran on the wrong instances`);
  const placed = sent.slice(mark);
  assert.strictEqual(placed.length, legCount * scope.length, `${label}: expected ${legCount} leg(s) x ${scope.length} instance(s), got ${placed.length}`);
  for (const o of placed) {
    if (!isCryptoExchange(o.exchange)) assert.strictEqual(String(o.pricetype).toUpperCase(), 'LIMIT', `${o.instance} ${o.symbol} went out as ${o.pricetype}`);
  }

  const exitMark = sent.length;
  const exit = await strategyService.exitStrategy(strategies[label], { source: 'live_test' });
  const exitProblems = exit.instances.filter((i) => !i.success).map((i) => `${i.instanceName}: ${i.error || JSON.stringify(i.legs).slice(0, 300)}`);
  assert.deepStrictEqual(exitProblems, [], `${label} exit:\n${exitProblems.join('\n')}`);
  await assertFlat([...placed, ...sent.slice(exitMark)]);
}

live('strategy: NIFTY hedge (BUY CE ATM + SELL PE OTM2) executes on both Indian instances, then exits flat', async (t) => {
  if (await skipIfClosed(t, 'NFO')) return;
  await runStrategy('NIFTY hedge', INDIAN, 2);
});

live('strategy: CRUDEOIL put (MCX options) executes and exits flat', async () => {
  await runStrategy('CRUDEOIL put', INDIAN, 1);
});

live('strategy: BTC call (crypto options) executes on Delta Exchange and exits flat', async () => {
  await runStrategy('BTC call', CRYPTO, 1);
});

// ---------------------------------------------------------------------------
// Cleanup - must stay the LAST test in this file
// ---------------------------------------------------------------------------

live('every order and position this suite opened is closed', async (t) => {
  const leftovers = await closeEverythingOpened(instances, touched, (msg) => t.diagnostic(msg));
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});
