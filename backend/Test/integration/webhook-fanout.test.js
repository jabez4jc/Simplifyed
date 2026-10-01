import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { makeWatchlist, makeInstance, linkInstanceToWatchlist } from '../helpers/fixtures.js';
import { watchBroker, realInstance, copyRealInstruments, waitForNet, netPosition, CRYPTO } from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';
import webhookRoutes from '../../src/routes/tradingview-webhook.js';
import { config } from '../../src/core/config.js';
import strategyService from '../../src/services/strategy.service.js';
import db from '../../src/core/database.js';

/**
 * Where a TradingView alert goes, and how much it trades - for both kinds of webhook:
 *
 *   - a broadcast watchlist: one raw order fanned out to every mapped instance, times each
 *     instance's multiplier, as a position-targeted smart order;
 *   - a strategy webhook: every leg (or one by leg_tag) entered or exited as a basket.
 *
 * On the operator's real crypto account (analyzer mode, 24x7), posted as TradingView posts
 * (text/plain JSON). Every position is closed after its test and the test fails if anything
 * stays open. The token is this file's own, set in-process.
 */

const TOKEN = 'webhook-fanout-token-0123456789abcdef';
const SYMBOL = 'BTCUSDFUT';

let app;
let broker;

before(async () => {
  await useTestDb('webhook-fanout');
  config.webhooks = { ...(config.webhooks || {}), tradingviewBroadcast: { token: TOKEN } };
  process.env.WEBHOOK_TOKEN = TOKEN;
  app = express();
  app.use('/webhook/tradingview', webhookRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  broker = watchBroker();
});
after(() => broker.restore());
beforeEach(async () => {
  await truncate();
  broker.reset();
});
afterEach(async () => {
  const leftovers = await broker.flattenAll();
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});

const smartOrders = () => broker.orders().filter((o) => o.endpoint === 'placesmartorder');
const baskets = () => broker.callsTo('basketorder');

/** POST exactly as TradingView does: text/plain JSON, token header. */
const send = (slug, body, query = '') => request(app)
  .post(`/webhook/tradingview/broadcast/${slug}${query}`)
  .set('Content-Type', 'text/plain')
  .set('X-Webhook-Token', TOKEN)
  .send(JSON.stringify(body));

const alert = (overrides = {}) => ({
  strategy: 'tv', symbol: SYMBOL, exchange: 'CRYPTO', action: 'BUY', quantity: 1, position_size: 1, product: 'NRML', ...overrides,
});

async function broadcastWatchlist() {
  const wl = await makeWatchlist({ type: 'broadcast', is_broadcast: 1, webhook_slug: `fan-${Date.now()}` });
  const inst = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, inst.id);
  return { wl, inst };
}

async function webhookStrategy() {
  const wl = await makeWatchlist({ type: 'strategy' });
  const inst = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, inst.id);
  await copyRealInstruments("exchange = 'CRYPTO' AND symbol = 'BTCUSDFUT'");
  const s = await strategyService.createStrategy({ watchlist_id: wl.id, name: 'BTC hook', underlying: 'BTC', exchange: 'CRYPTO', entry_trigger: 'WEBHOOK' });
  await strategyService.addLeg(s.id, { action: 'BUY', qty_type: 'LOTS', qty_value: 1, product_type: 'NRML', leg_tag: 'long' });
  return { s: await strategyService.getStrategyWithLegs(s.id), inst };
}

// ---------------------------------------------------------------------------
// Broadcast: who receives the alert
// ---------------------------------------------------------------------------

test('broadcast: an inactive watchlist places nothing - deactivating is how alerts are switched off', async () => {
  const { wl } = await broadcastWatchlist();
  await db.run('UPDATE watchlists SET is_active = 0 WHERE id = ?', [wl.id]);
  const res = await send(wl.webhook_slug, alert());
  assert.strictEqual(res.status, STATUS.VALIDATION, JSON.stringify(res.body));
  assert.match(res.body.message, /inactive/);
  assert.strictEqual(smartOrders().length, 0);
});

test('broadcast: an instance with order placement off is never sent the alert', async () => {
  const { wl, inst } = await broadcastWatchlist();
  const off = await makeInstance({ name: 'Order-off', order_placement_enabled: 0 });
  await linkInstanceToWatchlist(wl.id, off.id);

  const res = await send(wl.webhook_slug, alert());
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.results.map((r) => r.target), [inst.name], 'only the order-enabled instance is a target');
  assert.strictEqual(await waitForNet(inst, SYMBOL, 1), 1);
});

// ---------------------------------------------------------------------------
// Broadcast: how much it trades
// ---------------------------------------------------------------------------

test('broadcast: quantity and target position are scaled by the instance multiplier', async () => {
  const { wl, inst } = await broadcastWatchlist();
  await db.run('UPDATE instances SET multiplier = 2 WHERE id = ?', [inst.id]);
  const res = await send(wl.webhook_slug, alert({ quantity: 1, position_size: 1 }));
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  const [sent] = smartOrders();
  assert.strictEqual(Number(sent.data.quantity), 2);
  assert.strictEqual(Number(sent.data.position_size), 2);
  assert.strictEqual(await waitForNet(inst, SYMBOL, 2), 2, 'the broker holds 2');
});

test('broadcast: a reversal alert takes a long straight to a short, and a flat alert flattens it', async () => {
  const { wl, inst } = await broadcastWatchlist();
  assert.strictEqual((await send(wl.webhook_slug, alert())).status, STATUS.OK);
  assert.strictEqual(await waitForNet(inst, SYMBOL, 1), 1);

  const reverse = await send(wl.webhook_slug, alert({ action: 'SELL', quantity: 2, position_size: -1 }));
  assert.strictEqual(reverse.status, STATUS.OK, JSON.stringify(reverse.body));
  assert.strictEqual(await waitForNet(inst, SYMBOL, -1), -1, 'long 1 -> short 1');

  const flat = await send(wl.webhook_slug, alert({ action: 'BUY', quantity: 1, position_size: 0 }));
  assert.strictEqual(flat.status, STATUS.OK, JSON.stringify(flat.body));
  assert.strictEqual(await waitForNet(inst, SYMBOL, 0), 0);
});

// ---------------------------------------------------------------------------
// Broadcast: refused before anything is sent
// ---------------------------------------------------------------------------

test('broadcast: a LIMIT with no price and a stop with no trigger are refused, not sent at 0', async () => {
  const { wl } = await broadcastWatchlist();
  for (const body of [alert({ pricetype: 'LIMIT' }), alert({ pricetype: 'SL', price: 100 })]) {
    const res = await send(wl.webhook_slug, body);
    assert.strictEqual(res.status, STATUS.VALIDATION, JSON.stringify(res.body));
  }
  assert.strictEqual(smartOrders().length, 0);
});

test('broadcast: an expired contract is refused - it no longer exists at any broker', async () => {
  const { wl } = await broadcastWatchlist();
  const res = await send(wl.webhook_slug, alert({ exchange: 'MCX', symbol: 'CRUDEOIL19AUG26FUT' }));
  assert.strictEqual(res.status, STATUS.VALIDATION, JSON.stringify(res.body));
  assert.match(res.body.message, /expired/);
  assert.strictEqual(smartOrders().length, 0);
});

test('broadcast: a refused text/plain alert retried with its request id gets the same answer, not "in progress"', async () => {
  const { wl } = await broadcastWatchlist();
  await db.run('UPDATE watchlists SET is_active = 0 WHERE id = ?', [wl.id]);
  const body = { ...alert(), request_id: `rid-${Date.now()}` };
  const first = await send(wl.webhook_slug, body);
  const retry = await send(wl.webhook_slug, body);
  assert.strictEqual(first.status, STATUS.VALIDATION);
  assert.strictEqual(retry.status, STATUS.VALIDATION, `the retry was answered ${retry.status} ${JSON.stringify(retry.body)}`);
  assert.strictEqual(smartOrders().length, 0);
});

// ---------------------------------------------------------------------------
// Strategy webhook
// ---------------------------------------------------------------------------

test('strategy webhook: ENTRY places the basket, a repeated ENTRY skips the open leg, EXIT closes it', async () => {
  const { s, inst } = await webhookStrategy();
  const before = await netPosition(inst, SYMBOL);

  const entry = await send(s.webhook_slug, {});
  assert.strictEqual(entry.status, STATUS.OK, JSON.stringify(entry.body));
  assert.strictEqual(await waitForNet(inst, SYMBOL, before + 1), before + 1);

  const again = await send(s.webhook_slug, {});
  assert.strictEqual(again.status, STATUS.OK, JSON.stringify(again.body));
  assert.strictEqual(baskets().length, 1, 'a repeated alert must not duplicate the leg');
  assert.ok(again.body.data.instances[0].legs.every((l) => l.skipped), JSON.stringify(again.body.data));

  const exit = await send(s.webhook_slug, { action: 'EXIT' });
  assert.strictEqual(exit.status, STATUS.OK, JSON.stringify(exit.body));
  assert.strictEqual(await waitForNet(inst, SYMBOL, before), before);
});

test('strategy webhook: an inactive strategy and an unknown leg_tag place nothing', async () => {
  const { s } = await webhookStrategy();
  assert.strictEqual((await send(s.webhook_slug, { leg_tag: 'no-such-leg' })).status, STATUS.NOT_FOUND);
  await strategyService.updateStrategy(s.id, { is_active: false });
  assert.strictEqual((await send(s.webhook_slug, {})).status, STATUS.VALIDATION);
  assert.strictEqual(baskets().length, 0);
});

test('strategy webhook: instanceId must be one of the strategy\'s own order-enabled targets', async () => {
  const { s } = await webhookStrategy();
  const stranger = await makeInstance({ name: 'Not mapped' });
  for (const q of ['?instanceId=abc', `?instanceId=${stranger.id}`]) {
    const res = await send(s.webhook_slug, {}, q);
    assert.strictEqual(res.status, STATUS.VALIDATION, `${q}: ${JSON.stringify(res.body)}`);
  }
  assert.strictEqual(baskets().length, 0, 'nothing reaches any broker');
});
