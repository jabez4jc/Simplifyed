import { useLiveDatabase } from './live-db.js';
import assert from 'assert';
import test, { before, after } from 'node:test';

import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import watchlistService from '../../src/services/watchlist.service.js';
import watchlistSymbolService from '../../src/services/watchlist-symbol.service.js';
import quickOrderService from '../../src/services/quick-order.service.js';
import strategyService from '../../src/services/strategy.service.js';
import autoExitService from '../../src/services/auto-exit.service.js';
import marketDataFeedService from '../../src/services/market-data-feed.service.js';
import { upcomingExpiries } from '../../src/utils/underlying.util.js';
import { trackOrders, closeEverythingOpened } from './cleanup.js';

/**
 * Auto-exit, end to end: a real position is opened (from a watchlist row or a strategy leg), a
 * target / stop-loss / trailing stop is set, and the PRODUCTION auto-exit code closes it at the
 * broker - _monitorInstance, the same risk evaluation, confirmation window and close path the
 * server runs. It runs in this process, on the live.db copy, scoped to this suite's own
 * instances and rows: the dev server reads simplifyed.db and never sees them, and nothing here
 * evaluates any other position. Never run alongside another live file.
 *
 * Uses MCX (open to 23:55) and crypto (24/7). Thresholds smaller than a tick make the next move
 * trigger. Each test asserts WHICH rule fired (TARGET_HIT, STOP_HIT, TRAIL_HIT). PERCENT is
 * proven to be a percentage: 0.5% of CRUDEOIL (~30 points) must hold for 45s where 0.5 points
 * would not. Read Test/live/README.md first.
 */

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === 'true';
const TAG = `LIVE AUTOEXIT ${new Date().toISOString().slice(0, 16)}`;
// Workflow suite: Maha and Ana are reserved for the live order tests.
const INDIAN = ['Jz Fyers'];
const CRYPTO = ['Jabez Crypto'];

let instances = [];
let touched = new Map();
let hasUnits = false;
const made = [];
const rows = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (names) => instances.filter((i) => names.includes(i.name));
// Values AND the unit: a PERCENT left on the row turned the next test's "2 points" into 2%.
const CLEAR = ['target_points', 'stoploss_points', 'trailing_stoploss_points', 'trailing_activation_points']
  .flatMap((f) => ['direct', 'futures', 'options'].map((m) => `${f}_${m} = NULL`))
  .concat(['direct', 'futures', 'options'].map((m) => `exit_unit_${m} = 'POINTS'`)).join(', ');

async function assertAnalyzerModeAtBroker(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  assert.ok(on, `REFUSING TO TRADE: ${instance.name} did not confirm analyzer mode`);
}

before(async () => {
  if (!LIVE_ENABLED) return;
  await useLiveDatabase();
  await db.connect();
  touched = trackOrders();
  hasUnits = (await db.all('PRAGMA table_info(watchlist_symbols)')).some((c) => c.name === 'exit_unit_futures');
  instances = await db.all(`SELECT * FROM instances WHERE name IN ('Jz Fyers', 'Jabez Crypto')`);
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
  // Strategy legs: a strategy-type watchlist on the crypto account.
  const sw = await watchlistService.createWatchlist({ name: `${TAG} Strategies`, type: 'strategy', is_active: true });
  made.push(sw.id);
  for (const inst of byName(CRYPTO)) await watchlistService.assignInstance(sw.id, inst.id);
  rows.strategyWatchlist = sw.id;
  startAutoExit();
});

after(async () => {
  if (!LIVE_ENABLED) return;
  stopAutoExit();
  for (const id of strategies) await strategyService.deleteStrategy(id).catch(() => {});
  for (const id of made) await watchlistService.deleteWatchlist(id).catch(() => {});
  await db.close().catch(() => {});
});

// ---------------------------------------------------------------------------
// The auto-exit loop, in process: the server's cycle (fresh position book -> _monitorInstance),
// limited to this suite's instances and the exit rows on this suite's watchlists.
// ---------------------------------------------------------------------------

const strategies = [];
let loop = null;
let cycling = false;

async function autoExitCycle() {
  if (cycling) return;
  cycling = true;
  try {
    const all = await autoExitService._buildAutoExitLookup();
    const lookup = new Map([...all]
      .map(([k, list]) => [k, list.filter((r) => made.includes(r.watchlist_id))])
      .filter(([, list]) => list.length));
    for (const inst of instances) {
      marketDataFeedService.setPositionSnapshot(inst.id, await openalgoClient.getPositionBook(inst));
      await autoExitService._monitorInstance(inst, lookup);
    }
  } catch (error) {
    console.error('auto-exit cycle failed:', error.message); // eslint-disable-line no-console
  } finally {
    cycling = false;
  }
}
function startAutoExit() { loop = setInterval(autoExitCycle, autoExitService.monitorIntervalMs); }
function stopAutoExit() { if (loop) clearInterval(loop); loop = null; }

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
    `SELECT event_type FROM risk_events WHERE symbol = ? AND instance_id IN (${ids.map(() => '?').join(',')}) AND id > ? ORDER BY id DESC LIMIT 1`,
    [symbol, ...ids, since]
  );
}

// A marker, not a clock: the last risk event before this test. A time window five seconds back
// counted the previous test's exit as this one's.
const sqlNow = async () => (await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM risk_events')).id;

live('POINTS: a CRUDEOIL long is auto-exited when a sub-tick target/stop is crossed', async () => {
  const since = await sqlNow();
  await open('CRUDEOIL', 'BUY', INDIAN);
  await setExits('CRUDEOIL', { target_points_futures: 0.5, stoploss_points_futures: 0.5 });
  const took = await waitForAutoExit(INDIAN, rows.CRUDEOIL.symbol, 120000);
  await clearExits('CRUDEOIL');
  assert.ok(took !== null, 'the server did not auto-exit within 120s - is the auto-exit loop running?');
  const ev = await exitEvent(INDIAN, rows.CRUDEOIL.symbol, since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a TARGET_HIT/STOP_HIT risk event, got ${ev?.event_type}`);
});

/** Every risk event for `symbol` since `since`, oldest first. */
async function eventsSince(names, symbol, since) {
  const ids = byName(names).map((i) => i.id);
  return db.all(
    `SELECT event_type, metadata FROM risk_events WHERE symbol = ? AND instance_id IN (${ids.map(() => '?').join(',')}) AND id > ? ORDER BY id`,
    [symbol, ...ids, since]
  );
}
const exitsSince = async (names, symbol, since) => (await eventsSince(names, symbol, since))
  .filter((e) => ['TARGET_HIT', 'STOP_HIT', 'TRAIL_HIT'].includes(e.event_type)).map((e) => e.event_type);

/**
 * A one-sided rule (a stop alone, a target alone, an unarmed trail) only fires if the market moves
 * its way, and a trend can run the other way for minutes. Open `side`, set `exits`, and if nothing
 * fires within `perSideMs`, close the position and try the opposite side - the trend that never
 * reached one side's level reaches the other's.
 */
async function openUntilExited(label, names, side, exits, perSideMs = 90000, rounds = 4) {
  const { symbol, exchange } = rows[label];
  for (let i = 0; i < rounds; i += 1) {
    const buy = (side === 'BUY') === (i % 2 === 0);
    await open(label, buy ? 'BUY' : 'SHORT', names);
    await setExits(label, exits);
    const took = await waitForAutoExit(names, symbol, perSideMs);
    await clearExits(label);
    if (took !== null) return true;
    for (const inst of byName(names)) {
      await quickOrderService.closePosition(inst, { symbol, exchange }, { tradeMode: 'EQUITY', strategy: 'live_test' });
    }
    assert.ok(await waitForAutoExit(names, symbol, 30000) !== null, `${symbol} could not be flattened between rounds`);
  }
  return false;
}

live('TARGET alone: a BTCUSDFUT position is closed by its target, recorded as TARGET_HIT', async () => {
  const since = await sqlNow();
  assert.ok(await openUntilExited('BTC', CRYPTO, 'BUY', { target_points_futures: 0.5 }), 'a sub-tick target never fired on either side');
  assert.deepStrictEqual(await exitsSince(CRYPTO, 'BTCUSDFUT', since), ['TARGET_HIT']);
});

live('STOP alone: a BTCUSDFUT position is closed by its stop-loss, recorded as STOP_HIT', async () => {
  const since = await sqlNow();
  assert.ok(await openUntilExited('BTC', CRYPTO, 'SHORT', { stoploss_points_futures: 0.5 }), 'a sub-tick stop never fired on either side');
  assert.deepStrictEqual(await exitsSince(CRYPTO, 'BTCUSDFUT', since), ['STOP_HIT']);
});

live('PERCENT is read as a percentage: 0.5% of CRUDEOIL (~30 points) holds, 0.001% exits', async (t) => {
  if (!hasUnits) { t.skip('migration 064 not applied (run npm run migrate, then restart the server)'); return; }
  await open('CRUDEOIL', 'BUY', INDIAN);
  // As points, 0.5 would trigger on the first tick. As a percent of ~6,000 it is ~30 points.
  await setExits('CRUDEOIL', { exit_unit_futures: 'PERCENT', target_points_futures: 0.5, stoploss_points_futures: 0.5 });
  const early = await waitForAutoExit(INDIAN, rows.CRUDEOIL.symbol, 45000);
  assert.strictEqual(early, null, 'exited within 45s - 0.5 was read as points, not percent (server running older code?)');

  const since = await sqlNow();
  await setExits('CRUDEOIL', { exit_unit_futures: 'PERCENT', target_points_futures: 0.001, stoploss_points_futures: 0.001 });
  const took = await waitForAutoExit(INDIAN, rows.CRUDEOIL.symbol, 120000);
  await clearExits('CRUDEOIL');
  assert.ok(took !== null, 'a 0.001% threshold was not auto-exited within 120s');
  const ev = await exitEvent(INDIAN, rows.CRUDEOIL.symbol, since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a risk event, got ${ev?.event_type}`);
});

live('PERCENT on a crypto short: 0.0001% of BTC exits on the next move', async (t) => {
  if (!hasUnits) { t.skip('migration 064 not applied (run npm run migrate, then restart the server)'); return; }
  const since = await sqlNow();
  await open('BTC', 'SHORT', CRYPTO);
  await setExits('BTC', { exit_unit_futures: 'PERCENT', target_points_futures: 0.0001, stoploss_points_futures: 0.0001 });
  const took = await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 120000);
  await clearExits('BTC');
  assert.ok(took !== null, 'the server did not auto-exit within 120s');
  const ev = await exitEvent(CRYPTO, 'BTCUSDFUT', since);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(ev?.event_type), `expected a risk event, got ${ev?.event_type}`);
});

// ---------------------------------------------------------------------------
// Trailing stop-loss
// ---------------------------------------------------------------------------

live('TRAILING: a BTCUSDFUT position arms at once, follows the price and is closed on the pullback (TRAIL_HIT)', async () => {
  const since = await sqlNow();
  assert.ok(await openUntilExited('BTC', CRYPTO, 'BUY', { trailing_stoploss_points_futures: 2 }, 150000), 'a 2-point trailing stop never fired');
  const events = (await eventsSince(CRYPTO, 'BTCUSDFUT', since)).map((e) => e.event_type);
  assert.ok(events.includes('TRAIL_ACTIVATED'), `the trail must arm first: ${events}`);
  assert.deepStrictEqual(await exitsSince(CRYPTO, 'BTCUSDFUT', since), ['TRAIL_HIT']);
});

live('TRAILING activation: an unreached activation never arms or exits; a reachable one arms, trails and exits', async () => {
  const since = await sqlNow();
  await open('BTC', 'SHORT', CRYPTO);
  // 6,000 points is not reachable in 45s, so the 0.5-point trail must stay off.
  await setExits('BTC', { trailing_stoploss_points_futures: 0.5, trailing_activation_points_futures: 6000 });
  const early = await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 45000);
  await clearExits('BTC');
  assert.strictEqual(early, null, 'an unarmed trailing stop closed the position');
  assert.ok(!(await eventsSince(CRYPTO, 'BTCUSDFUT', since)).some((e) => e.event_type === 'TRAIL_ACTIVATED'), 'it must not have armed');
  for (const inst of byName(CRYPTO)) await quickOrderService.closePosition(inst, { symbol: 'BTCUSDFUT', exchange: 'CRYPTO' }, { tradeMode: 'EQUITY', strategy: 'live_test' });
  assert.ok(await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 30000) !== null);

  const armedSince = await sqlNow();
  assert.ok(await openUntilExited('BTC', CRYPTO, 'SHORT', { trailing_stoploss_points_futures: 2, trailing_activation_points_futures: 0.5 }, 150000),
    'the reachable trailing stop never fired');
  const events = (await eventsSince(CRYPTO, 'BTCUSDFUT', armedSince)).map((e) => e.event_type);
  assert.ok(events.includes('TRAIL_ACTIVATED'), `armed before it fired: ${events}`);
  assert.deepStrictEqual(await exitsSince(CRYPTO, 'BTCUSDFUT', armedSince), ['TRAIL_HIT']);
});

live('TRAILING on MCX: a CRUDEOIL position on Fyers trails and is closed on the reversal', async () => {
  const since = await sqlNow();
  assert.ok(await openUntilExited('CRUDEOIL', INDIAN, 'SHORT', { trailing_stoploss_points_futures: 1 }, 150000), 'a 1-point CRUDEOIL trail never fired');
  assert.deepStrictEqual(await exitsSince(INDIAN, rows.CRUDEOIL.symbol, since), ['TRAIL_HIT']);
});

// ---------------------------------------------------------------------------
// Strategy legs: the leg's own target / stop / trailing, run by auto-exit
// ---------------------------------------------------------------------------

async function btcStrategy(name, leg) {
  for (const inst of byName(CRYPTO)) await assertAnalyzerModeAtBroker(inst);
  const s = await strategyService.createStrategy({ watchlist_id: rows.strategyWatchlist, name: `${TAG} ${name}`, underlying: 'BTC', exchange: 'CRYPTO' });
  strategies.push(s.id);
  await strategyService.addLeg(s.id, { action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', ...leg });
  return s;
}

async function executeAndTrack(s) {
  const res = await strategyService.executeStrategy(s.id, { source: 'live_test' });
  const legs = res.instances.flatMap((i) => i.legs || []);
  assert.ok(res.success && legs.length, `execute failed: ${JSON.stringify(res).slice(0, 500)}`);
  for (const leg of legs.filter((l) => l.resolvedSymbol)) {
    for (const inst of byName(CRYPTO)) {
      if (!touched.has(inst.id)) touched.set(inst.id, new Map());
      touched.get(inst.id).set(leg.resolvedSymbol, leg.resolvedExchange || 'CRYPTO');
    }
  }
  return legs;
}

async function waitOpen(names, symbol) {
  for (let i = 0; i < 15; i += 1) {
    if (i) await sleep(2000);
    const q = await Promise.all(byName(names).map((inst) => netQty(inst, symbol)));
    if (q.every((x) => x !== 0)) return true;
  }
  return false;
}

live('STRATEGY futures leg: its own target/stop closes it, and the next execute enters it again', async () => {
  const s = await btcStrategy('BTC target leg', { target_points: 0.5, stoploss_points: 0.5 });
  const since = await sqlNow();
  const [leg] = await executeAndTrack(s);
  assert.strictEqual(leg.resolvedSymbol, 'BTCUSDFUT');
  assert.ok(await waitOpen(CRYPTO, 'BTCUSDFUT'), 'the leg position never appeared');
  const took = await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 240000);
  assert.ok(took !== null, 'the leg target/stop was not auto-exited within 240s');
  const exits = await exitsSince(CRYPTO, 'BTCUSDFUT', since);
  assert.ok(exits.length === 1 && ['TARGET_HIT', 'STOP_HIT'].includes(exits[0]), `one exit by the leg's own rule, got ${exits}`);

  // Auto-exit closed it, not the strategy: the ledger still says open. Past the settle window the
  // next execute must find it flat at the broker and enter again rather than skip it.
  await db.run('UPDATE strategy_leg_executions SET opened_at = ? WHERE strategy_id = ?', [new Date(Date.now() - 120000).toISOString(), s.id]);
  await clearExits('BTC').catch(() => {});
  await db.run('UPDATE watchlist_symbols SET target_points_futures = NULL, stoploss_points_futures = NULL WHERE watchlist_id = ?', [rows.strategyWatchlist]);
  const [again] = await executeAndTrack(s);
  assert.ok(!again.skipped, 'the auto-exited leg must be entered again, not skipped');
  assert.ok(await waitOpen(CRYPTO, 'BTCUSDFUT'), 'the re-entry never appeared');
  const exit = await strategyService.exitStrategy(s.id, { source: 'live_test' });
  assert.ok(exit.success, JSON.stringify(exit).slice(0, 400));
  assert.strictEqual(await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 60000) !== null, true, 'strategy exit left the leg open');
});

live('STRATEGY option leg: a BTC call leg is closed by its own stop-loss', async () => {
  const s = await btcStrategy('BTC call stop leg', { option_type: 'CE', strike_offset: 'ATM', stoploss_points: 0.1, target_points: 0.1 });
  const since = await sqlNow();
  const [leg] = await executeAndTrack(s);
  assert.ok(await waitOpen(CRYPTO, leg.resolvedSymbol), `${leg.resolvedSymbol} never appeared`);
  const took = await waitForAutoExit(CRYPTO, leg.resolvedSymbol, 300000);
  assert.ok(took !== null, `the option leg ${leg.resolvedSymbol} was not auto-exited within 300s`);
  const exits = await exitsSince(CRYPTO, leg.resolvedSymbol, since);
  assert.strictEqual(exits.length, 1, `one exit, got ${exits}`);
  assert.ok(['TARGET_HIT', 'STOP_HIT'].includes(exits[0]));
});

live('STRATEGY trailing leg: a BTC futures leg is closed by its own trailing stop (TRAIL_HIT)', async () => {
  const s = await btcStrategy('BTC trailing leg', { trailing_stoploss_points: 2 });
  const since = await sqlNow();
  await executeAndTrack(s);
  assert.ok(await waitOpen(CRYPTO, 'BTCUSDFUT'));
  const took = await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 300000);
  await db.run('UPDATE watchlist_symbols SET trailing_stoploss_points_futures = NULL WHERE watchlist_id = ?', [rows.strategyWatchlist]);
  assert.ok(took !== null, 'the leg trailing stop was not hit within 300s');
  assert.deepStrictEqual(await exitsSince(CRYPTO, 'BTCUSDFUT', since), ['TRAIL_HIT']);
});

live('STRATEGY GTT leg (crypto): the broker-side exit is placed on entry and cancelled on Exit', async () => {
  const s = await btcStrategy('BTC GTT leg', { exit_mechanism: 'GTT', target_points: 5000, stoploss_points: 5000 });
  const [leg] = await executeAndTrack(s);
  assert.ok(await waitOpen(CRYPTO, 'BTCUSDFUT'));
  const gtt = await db.get('SELECT * FROM gtt_orders WHERE strategy_leg_id = ? ORDER BY id DESC', [leg.legId]);
  assert.ok(gtt?.trigger_id && gtt.status === 'active', `no active GTT for the leg: ${JSON.stringify(gtt)}`);

  const exit = await strategyService.exitStrategy(s.id, { source: 'live_test' });
  assert.ok(exit.success, JSON.stringify(exit).slice(0, 400));
  const after = await db.get('SELECT status FROM gtt_orders WHERE id = ?', [gtt.id]);
  assert.notStrictEqual(after.status, 'active', 'Exit must cancel the broker-side GTT');
  assert.ok(await waitForAutoExit(CRYPTO, 'BTCUSDFUT', 60000) !== null, 'strategy exit left the leg open');
});

// ---------------------------------------------------------------------------
// Cleanup - must stay the LAST test in this file
// ---------------------------------------------------------------------------

live('every order and position this suite opened is closed', async (t) => {
  stopAutoExit();
  await clearExits('CRUDEOIL').catch(() => {});
  await clearExits('BTC').catch(() => {});
  const leftovers = await closeEverythingOpened(instances, touched, (msg) => t.diagnostic(msg));
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});
