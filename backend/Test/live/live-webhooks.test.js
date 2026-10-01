import { useLiveDatabase } from './live-db.js';
import assert from 'assert';
import test, { before, after } from 'node:test';
import express from 'express';
import request from 'supertest';

import db from '../../src/core/database.js';
import config from '../../src/core/config.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import watchlistService from '../../src/services/watchlist.service.js';
import strategyService from '../../src/services/strategy.service.js';
import tradingviewWebhookRoutes from '../../src/routes/tradingview-webhook.js';
import { upcomingExpiries } from '../../src/utils/underlying.util.js';
import { isCryptoExchange } from '../../src/utils/broker-type.util.js';
import { trackOrders, closeEverythingOpened } from './cleanup.js';

/**
 * The TradingView webhook, end to end through the real route (/webhook/tradingview/broadcast):
 * a broadcast watchlist fanning a raw alert out to its instances, and a strategy webhook entering
 * and exiting every leg (or one leg by leg_tag). Read Test/live/README.md first.
 *
 * Temporary watchlists/strategies are created and deleted by the suite. Broadcasts post straight
 * to each instance with fetch (not through openalgoClient.request), so they are captured at fetch.
 * Every symbol ordered is flattened and verified at the end. The webhook token is read from your
 * settings and never printed.
 */

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === 'true';
// Workflow suite: Maha and Ana are reserved for the live order tests (live-orders, live-fno).
const INDIAN = ['Jz Kotak', 'Jz Fyers'];
const CRYPTO = ['Jabez Crypto'];
const TAG = `LIVE WEBHOOK ${new Date().toISOString().slice(0, 16)}`;

let instances = [];
let touched = new Map();
let app;
let token;
const made = { watchlists: [], strategies: [] };
const broadcasts = []; // { host, body } of every order posted by the broadcast path
const slugs = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (names) => instances.filter((i) => names.includes(i.name));

async function assertAnalyzerModeAtBroker(instance) {
  const status = await openalgoClient.getAnalyzerStatus(instance);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  assert.ok(on, `REFUSING TO TRADE: ${instance.name} did not confirm analyzer mode`);
}

async function nearestFuture(exchange, name) {
  const expiries = await db.all("SELECT DISTINCT expiry FROM instruments WHERE exchange = ? AND name = ? AND instrumenttype = 'FUT'", [exchange, name]);
  const expiry = upcomingExpiries(expiries)[0];
  return db.get("SELECT * FROM instruments WHERE exchange = ? AND name = ? AND instrumenttype = 'FUT' AND expiry = ?", [exchange, name, expiry]);
}

before(async () => {
  if (!LIVE_ENABLED) return;
  await useLiveDatabase();
  await db.connect();
  await config.loadFromDatabase?.();
  token = config.webhooks?.tradingviewBroadcast?.token || process.env.WEBHOOK_TOKEN;
  assert.ok(token, 'no webhook token configured');
  touched = trackOrders();

  // Record every broadcast order posted straight to an instance.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/api/v1/placesmartorder')) {
      try {
        const body = JSON.parse(opts.body || '{}');
        delete body.apikey;
        broadcasts.push({ host: new URL(String(url)).host, body });
      } catch { /* not JSON - ignore */ }
    }
    return realFetch(url, opts);
  };

  app = express();
  app.use('/webhook/tradingview', tradingviewWebhookRoutes);
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ status: 'error', message: err.message })); // eslint-disable-line no-unused-vars

  instances = await db.all(
    `SELECT * FROM instances WHERE name IN (${[...INDIAN, ...CRYPTO].map(() => '?').join(', ')}) ORDER BY id`,
    [...INDIAN, ...CRYPTO]
  );
  for (const inst of instances) await assertAnalyzerModeAtBroker(inst);

  for (const [label, names] of [['Indian', INDIAN], ['Crypto', CRYPTO]]) {
    const wl = await watchlistService.createWatchlist({ name: `${TAG} ${label} broadcast`, type: 'broadcast', is_broadcast: true, is_active: true });
    made.watchlists.push(wl.id);
    for (const inst of byName(names)) await watchlistService.assignInstance(wl.id, inst.id);
    slugs[label] = (await watchlistService.getWatchlistById(wl.id)).webhook_slug;
    assert.ok(slugs[label], `${label} broadcast watchlist has no webhook slug`);
  }

  const sw = await watchlistService.createWatchlist({ name: `${TAG} Strategies`, type: 'strategy', is_active: true });
  made.watchlists.push(sw.id);
  for (const inst of instances) await watchlistService.assignInstance(sw.id, inst.id);
  const s = await strategyService.createStrategy({ watchlist_id: sw.id, name: `${TAG} NIFTY`, underlying: 'NIFTY', exchange: 'NSE_INDEX', entry_trigger: 'WEBHOOK' });
  made.strategies.push(s.id);
  for (const leg of [
    { option_type: 'CE', action: 'BUY', strike_offset: 'ATM', leg_tag: `wh-ce-${s.id}` },
    { option_type: 'PE', action: 'BUY', strike_offset: 'ATM', leg_tag: `wh-pe-${s.id}` },
  ]) {
    await strategyService.addLeg(s.id, { strike_policy: 'FLOAT_OFS', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', exit_mechanism: 'POLLING', ...leg });
  }
  for (const inst of byName(INDIAN)) await strategyService.assignStrategyInstance(s.id, inst.id);
  slugs.strategy = (await strategyService.getStrategyWithLegs(s.id)).webhook_slug;
  slugs.legCe = `wh-ce-${s.id}`;
  assert.ok(slugs.strategy, 'webhook strategy has no slug');
});

after(async () => {
  if (!LIVE_ENABLED) return;
  for (const id of made.strategies) await strategyService.deleteStrategy(id).catch(() => {});
  for (const id of made.watchlists) await watchlistService.deleteWatchlist(id).catch(() => {});
  await db.close().catch(() => {});
});

const live = (name, fn) => test(name, { skip: !LIVE_ENABLED && 'set RUN_LIVE_TESTS=true to run live broker tests' }, fn);

/** POST an alert exactly as TradingView sends it: text/plain JSON, token header. */
const alert = (slug, body, tok = token) => request(app)
  .post(`/webhook/tradingview/broadcast/${slug}`)
  .set('Content-Type', 'text/plain')
  .set('X-Webhook-Token', tok)
  .send(JSON.stringify(body));

/** Remember a broadcast symbol for the final cleanup (broadcasts bypass the client tracker). */
function trackBroadcast(names, symbol, exchange) {
  for (const inst of byName(names)) {
    if (!touched.has(inst.id)) touched.set(inst.id, new Map());
    touched.get(inst.id).set(symbol, exchange);
  }
}

async function assertFlat(names, symbol) {
  const open = [];
  for (const inst of byName(names)) {
    let q = null;
    for (let i = 0; i < 5; i += 1) {
      if (i) await sleep(1500);
      const book = await openalgoClient.getPositionBook(inst);
      // Sum every product row for the symbol - an old MIS row at 0 can sit beside a live NRML one.
      q = (book || []).filter((p) => p.symbol === symbol).reduce((sum, p) => sum + Number(p.quantity ?? p.netqty ?? 0), 0);
      if (q === 0) break;
    }
    if (q !== 0) open.push(`${inst.name} ${symbol} ${q}`);
  }
  assert.deepStrictEqual(open, [], `left open:\n${open.join('\n')}`);
}

async function broadcastRoundTrip(label, names, exchange, symbol, lot) {
  trackBroadcast(names, symbol, exchange);
  const mark = broadcasts.length;
  const product = isCryptoExchange(exchange) ? 'MIS' : 'NRML'; // F&O as NRML - MIS is refused after the 15:15 square-off
  const entry = await alert(slugs[label], { strategy: 'live-webhook', symbol, exchange, action: 'BUY', quantity: lot, position_size: lot, product, pricetype: 'MARKET' });
  assert.strictEqual(entry.status, 200, `entry: ${JSON.stringify(entry.body).slice(0, 500)}`);
  assert.strictEqual(entry.body.summary.failed, 0, `entry failed on: ${JSON.stringify(entry.body.results).slice(0, 500)}`);
  assert.strictEqual(entry.body.summary.total, names.length, `entry reached ${entry.body.summary.total} of ${names.length} instances`);

  const exit = await alert(slugs[label], { strategy: 'live-webhook', symbol, exchange, action: 'SELL', quantity: lot, position_size: 0, product, pricetype: 'MARKET' });
  assert.strictEqual(exit.status, 200, `exit: ${JSON.stringify(exit.body).slice(0, 500)}`);
  assert.strictEqual(exit.body.summary.failed, 0, `exit failed on: ${JSON.stringify(exit.body.results).slice(0, 500)}`);

  const posted = broadcasts.slice(mark);
  assert.ok(posted.length >= names.length * 2, `expected an entry and exit per instance, saw ${posted.length}`);
  for (const { body } of posted) {
    if (!isCryptoExchange(body.exchange)) {
      assert.strictEqual(body.pricetype, 'LIMIT', `${body.exchange}:${body.symbol} broadcast went out as ${body.pricetype} - SEBI requires LIMIT`);
      assert.ok(Number(body.price) > 0, 'a LIMIT carries its price');
    }
  }
  await assertFlat(names, symbol);
  return posted;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

live('a wrong token is refused and nothing is placed', async () => {
  const mark = broadcasts.length;
  const res = await alert(slugs.Indian, { strategy: 'x', symbol: 'SBIN', exchange: 'NSE', action: 'BUY', quantity: 1, position_size: 1 }, 'not-the-token');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(broadcasts.length, mark);
});

// ---------------------------------------------------------------------------
// Broadcast watchlist webhooks
// ---------------------------------------------------------------------------

live('broadcast: NIFTY future BUY then flatten, to both Indian instances, as LIMIT', async () => {
  const fut = await nearestFuture('NFO', 'NIFTY');
  await broadcastRoundTrip('Indian', INDIAN, 'NFO', fut.symbol, fut.lotsize);
});

live('broadcast: MCX GOLDM - converted to each broker\'s lot units (Kotak 100 vs 10)', async () => {
  const fut = await nearestFuture('MCX', 'GOLDM');
  const posted = await broadcastRoundTrip('Indian', INDIAN, 'MCX', fut.symbol, fut.lotsize);
  const kotakHost = new URL(byName(['Jz Kotak'])[0].host_url).host;
  const toKotak = posted.find((p) => p.host === kotakHost && Number(p.body.position_size) > 0);
  assert.ok(toKotak, 'no GOLDM entry reached Kotak');
  assert.strictEqual(Number(toKotak.body.quantity) % 100, 0, `Kotak received ${toKotak.body.quantity} - must be whole lots of Kotak's 100`);
});

live('broadcast: crypto BTCUSDFUT BUY then flatten on Delta Exchange (MARKET allowed)', async () => {
  await broadcastRoundTrip('Crypto', CRYPTO, 'CRYPTO', 'BTCUSDFUT', 1);
});

// ---------------------------------------------------------------------------
// Strategy webhooks
// ---------------------------------------------------------------------------

live('strategy webhook: ENTRY places every leg on every scoped instance, EXIT closes them all', async () => {
  const entry = await alert(slugs.strategy, {});
  assert.strictEqual(entry.status, 200, `entry: ${JSON.stringify(entry.body).slice(0, 600)}`);
  const legs = entry.body.data.instances.flatMap((i) => (i.legs || []).map((l) => ({ ...l, instance: i.instanceName })));
  const failed = legs.filter((l) => l.success === false);
  assert.deepStrictEqual(failed, [], 'every leg must be placed');
  assert.deepStrictEqual(entry.body.data.instances.map((i) => i.instanceName).sort(), [...INDIAN].sort());

  const exit = await alert(slugs.strategy, { action: 'EXIT' });
  assert.strictEqual(exit.status, 200, `exit: ${JSON.stringify(exit.body).slice(0, 600)}`);
});

live('strategy webhook: one leg by leg_tag enters and exits only that leg', async () => {
  const entry = await alert(slugs.strategy, { leg_tag: slugs.legCe });
  assert.strictEqual(entry.status, 200, `entry: ${JSON.stringify(entry.body).slice(0, 600)}`);
  const legIds = new Set(entry.body.data.instances.flatMap((i) => (i.legs || []).map((l) => l.legId ?? l.leg_id)));
  assert.strictEqual(legIds.size, 1, `leg_tag must address exactly one leg, got ${[...legIds]}`);

  const exit = await alert(slugs.strategy, { action: 'EXIT', leg_tag: slugs.legCe });
  assert.strictEqual(exit.status, 200, `exit: ${JSON.stringify(exit.body).slice(0, 600)}`);
});

// ---------------------------------------------------------------------------
// Cleanup - must stay the LAST test in this file
// ---------------------------------------------------------------------------

live('every order and position this suite opened is closed', async (t) => {
  const leftovers = await closeEverythingOpened(instances, touched, (msg) => t.diagnostic(msg));
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});
