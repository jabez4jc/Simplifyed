import assert from 'assert';
import test, { before, after } from 'node:test';

import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import watchlistService from '../../src/services/watchlist.service.js';
import watchlistSymbolService from '../../src/services/watchlist-symbol.service.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import { upcomingExpiries } from '../../src/utils/underlying.util.js';
import { trackOrders, closeEverythingOpened } from './cleanup.js';

/**
 * Auto-exit, end to end, by the RUNNING SERVER: a real position is opened from a watchlist row,
 * a target/stop-loss is set on that row, and the test waits for the server's auto-exit loop
 * (every ~5s, confirmed over ~6s) to close it. This process never runs auto-exit itself - two
 * actors closing one position is how double exits happen.
 *
 * Requires the server to be running with this code. Uses MCX (open to 23:55) and crypto (24/7)
 * so it does not depend on NSE hours. Read Test/live/README.md first.
 *
 * POINTS thresholds smaller than one tick make the next price move trigger an exit. PERCENT is
 * proven to be read as a percentage, not points: 0.5% of CRUDEOIL (~30 points) must NOT trigger
 * within 45s, where 0.5 points would trigger on the first tick; then 0.001% must trigger.
 */

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === 'true';
const TAG = `LIVE AUTOEXIT ${new Date().toISOString().slice(0, 16)}`;
const INDIAN = ['Maha'];
const CRYPTO = ['Jabez Crypto'];

let instances = [];
let touched = new Map();
let hasUnits = false;
const made = [];
const rows = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (names) => instances.filter((i) => names.includes(i.name));
const CLEAR = ['target_points', 'stoploss_points', 'trailing_stoploss_points', 'trailing_activation_points']
  .flatMap((f) => ['direct', 'futures', 'options'].map((m) => `${f}_${m} = NULL`)).join(', ');

async function assertAnalyzerModeAtBroker(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  assert.ok(on, `REFUSING TO TRADE: ${instance.name} did not confirm analyzer mode`);
}

before(async () => {
  if (!LIVE_ENABLED) return;
  process.env.DATABASE_PATH = process.env.DATABASE_PATH || './database/simplifyed.db';
  await db.connect();
  touched = trackOrders();
  hasUnits = (await db.all('PRAGMA table_info(watchlist_symbols)')).some((c) => c.name === 'exit_unit_futures');
  instances = await db.all(`SELECT * FROM instances WHERE name IN ('Maha', 'Jabez Crypto')`);
  for (const inst of instances) await assertAnalyzerModeAtBroker(inst);

  const mk = async (label, names) => {
    const wl = await watchlistService.createWatchlist({ name: `${TAG} ${label}`, type: 'standard', is_active: true });
    made.push(wl.id);
    for (const inst of byName(names)) await watchlistService.assignInstance(wl.id, inst.id);
    return wl.id;
  };
  const indian = await mk('Indian', INDIAN);
  const expiries = await db.all("SELECT DISTINCT expiry FROM instruments WHERE exchange = 'MCX' AND name = 'CRUDEOIL' AND instrumenttype = 'FUT'");
  const crude = await db.get("SELECT * FROM instruments WHERE exchange = 'MCX' AND name = 'CRUDEOIL' AND instrumenttype = 'FUT' AND expiry = ?", [upcomingExpiries(expiries)[0]]);
  rows.CRUDEOIL = await watchlistSymbolService.addSymbol(indian, {
    exchange: 'MCX', symbol: crude.symbol, symbol_type: 'FUTURES', lot_size: crude.lotsize, tick_size: crude.tick_size, expiry: crude.expiry,
    underlying_symbol: 'CRUDEOIL', name: 'CRUDEOIL', instrumenttype: 'FUT', qty_type: 'LOTS', qty_value: 1, product_type: 'MIS',
    tradable_futures: 1, tradable_options: 0, is_enabled: 1,
  });
  const crypto = await mk('Crypto', CRYPTO);
  rows.BTC = await watchlistSymbolService.addSymbol(crypto, {
    exchange: 'CRYPTO', symbol: 'BTCUSDFUT', symbol_type: 'FUTURES', lot_size: 1, tick_size: 0.5, underlying_symbol: 'BTC', name: 'BTCUSDFUT',
    instrumenttype: 'PERPFUT', qty_type: 'LOTS', qty_value: 1, product_type: 'MIS', tradable_futures: 1, tradable_options: 1, is_enabled: 1,
  });
});

after(async () => {
  if (!LIVE_ENABLED) return;
  for (const id of made) await watchlistService.deleteWatchlist(id).catch(() => {});
  await db.close().catch(() => {});
});

const live = (name, fn, opts = {}) => test(name, { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests', ...opts }, fn);

async function setExits(label, fields) {
  const cols = Object.keys(fields);
  await db.run(`UPDATE watchlist_symbols SET ${CLEAR}, ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fields[c]), rows[label].id]);
}
const clearExits = (label) => db.run(`UPDATE watchlist_symbols SET ${CLEAR} WHERE id = ?`, [rows[label].id]);

async function open(label, action, names) {
  for (const inst of byName(names)) await assertAnalyzerModeAtBroker(inst);
  const res = await quickOrderService.placeQuickOrder({ symbolId: rows[label].id, tradeMode: 'FUTURES', action, quantity: 1, product: 'MIS', source: 'live_test', triggerType: 'Manual' });
  const failed = res.results.filter((r) => !r.success).map((r) => `${r.instance_name}: ${r.error}`);
  assert.deepStrictEqual(failed, [], `${label} ${action} failed`);
  // The analyzer's position book lags the fill. Until the position shows, "flat" means nothing -
  // reading too early made a still-open short look auto-exited.
  const symbol = rows[label].symbol;
  for (const inst of byName(names)) {
    let q = 0;
    for (let i = 0; i < 15 && q === 0; i += 1) {
      if (i) await sleep(2000);
      q = await netQty(inst, symbol);
    }
    assert.notStrictEqual(q, 0, `${inst.name}: ${symbol} position never appeared after ${action}`);
  }
}

async function netQty(inst, symbol) {
  // A symbol can have one row per product (an old MIS row at 0 beside a live NRML one): sum them.
  const book = await openalgoClient.getPositionBook(inst);
  return (book || []).filter((p) => p.symbol === symbol).reduce((sum, p) => sum + Number(p.quantity ?? p.netqty ?? 0), 0);
}

/** Wait until the server's auto-exit has flattened `symbol` on every instance, or time out. */
async function waitForAutoExit(names, symbol, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const open = [];
    for (const inst of byName(names)) if ((await netQty(inst, symbol)) !== 0) open.push(inst.name);
    if (open.length === 0) return Date.now() - started;
    await sleep(3000);
  }
  return null;
}

async function exitEvent(names, symbol, since) {
  const ids = byName(names).map((i) => i.id);
  return db.get(
    `SELECT event_type FROM risk_events WHERE symbol = ? AND instance_id IN (${ids.map(() => '?').join(',')}) AND created_at >= ? ORDER BY id DESC LIMIT 1`,
    [symbol, ...ids, since]
  );
}

const sqlNow = () => new Date(Date.now() - 5000).toISOString().replace('T', ' ').slice(0, 19);

live('POINTS: a CRUDEOIL long is auto-exited when a sub-tick target/stop is crossed', async () => {
  const since = sqlNow();
  await open('CRUDEOIL', 'BUY', INDIAN);
  await setExits('CRUDEOIL', { target_points_futures: 0.5, stoploss_points_futures: 0.5 });
  const took = await waitForAutoExit(INDIAN, rows.CRUDEOIL.symbol, 120000);
  await clearExits('CRUDEOIL');
  assert.ok(took !== null, 'the server did not auto-exit within 120s - is it running?');
  const ev = await exitEvent(INDIAN, rows.CRUDEOIL.symbol, since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a TARGET_HIT/STOP_HIT risk event, got ${ev?.event_type}`);
});

live('POINTS: a BTCUSDFUT short is auto-exited when a sub-tick target/stop is crossed', async () => {
  const since = sqlNow();
  await open('BTC', 'SHORT', CRYPTO);
  await setExits('BTC', { target_points_futures: 0.1, stoploss_points_futures: 0.1 });
  const took = await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 120000);
  await clearExits('BTC');
  assert.ok(took !== null, 'the server did not auto-exit within 120s - is it running?');
  const ev = await exitEvent(CRYPTO, 'BTCUSDFUT', since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a risk event, got ${ev?.event_type}`);
});

live('PERCENT is read as a percentage: 0.5% of CRUDEOIL (~30 points) holds, 0.001% exits', async (t) => {
  if (!hasUnits) { t.skip('migration 064 not applied (run npm run migrate, then restart the server)'); return; }
  await open('CRUDEOIL', 'BUY', INDIAN);
  // As points, 0.5 would trigger on the first tick. As a percent of ~6,000 it is ~30 points.
  await setExits('CRUDEOIL', { exit_unit_futures: 'PERCENT', target_points_futures: 0.5, stoploss_points_futures: 0.5 });
  const early = await waitForAutoExit(INDIAN, rows.CRUDEOIL.symbol, 45000);
  assert.strictEqual(early, null, 'exited within 45s - 0.5 was read as points, not percent (server running older code?)');

  const since = sqlNow();
  await setExits('CRUDEOIL', { exit_unit_futures: 'PERCENT', target_points_futures: 0.001, stoploss_points_futures: 0.001 });
  const took = await waitForAutoExit(INDIAN, rows.CRUDEOIL.symbol, 120000);
  await clearExits('CRUDEOIL');
  assert.ok(took !== null, 'a 0.001% threshold was not auto-exited within 120s');
  const ev = await exitEvent(INDIAN, rows.CRUDEOIL.symbol, since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a risk event, got ${ev?.event_type}`);
});

live('PERCENT on a crypto short: 0.0001% of BTC exits on the next move', async (t) => {
  if (!hasUnits) { t.skip('migration 064 not applied (run npm run migrate, then restart the server)'); return; }
  const since = sqlNow();
  await open('BTC', 'SHORT', CRYPTO);
  await setExits('BTC', { exit_unit_futures: 'PERCENT', target_points_futures: 0.0001, stoploss_points_futures: 0.0001 });
  const took = await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 120000);
  await clearExits('BTC');
  assert.ok(took !== null, 'the server did not auto-exit within 120s');
  const ev = await exitEvent(CRYPTO, 'BTCUSDFUT', since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a risk event, got ${ev?.event_type}`);
});

// ---------------------------------------------------------------------------
// Cleanup - must stay the LAST test in this file
// ---------------------------------------------------------------------------

live('every order and position this suite opened is closed', async (t) => {
  await clearExits('CRUDEOIL').catch(() => {});
  await clearExits('BTC').catch(() => {});
  const leftovers = await closeEverythingOpened(instances, touched, (msg) => t.diagnostic(msg));
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});
