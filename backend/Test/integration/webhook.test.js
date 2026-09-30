import assert from 'assert';
import test, { before, after, beforeEach, afterEach } from 'node:test';
import express from 'express';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { makeWatchlist, linkInstanceToWatchlist } from '../helpers/fixtures.js';
import { watchBroker, realInstance, CRYPTO } from '../helpers/real-broker.js';
import { STATUS } from '../helpers/http.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';
import { auditLogger } from '../../src/middleware/audit-logger.js';
import webhookRoutes from '../../src/routes/tradingview-webhook.js';
import { config } from '../../src/core/config.js';
import tradingviewBroadcastService from '../../src/services/tradingview-broadcast.service.js';
import db from '../../src/core/database.js';

/**
 * This is the only route in the app that places live orders with no logged-in user behind it.
 * Its entire access control is one shared token, so every one of these tests is about the two
 * questions that matter: can an unauthorised caller trade, and can an authorised caller trade
 * twice by accident.
 *
 * Alerts go to the operator's real crypto account (analyzer mode, 24x7) through the same fetch
 * path production uses; every position an alert opens is closed after its test. The token here
 * is this file's own, set in-process - never the operator's.
 */

const TOKEN = 'webhook-token-for-tests-0123456789';

let app;
let broker;
let http;

before(async () => {
  await useTestDb('webhook');

  config.webhooks = { ...(config.webhooks || {}), tradingviewBroadcast: { token: TOKEN } };
  process.env.WEBHOOK_TOKEN = TOKEN;

  // Mirrors server.js: auditLogger before the router, because it works by attaching a finish
  // hook and calling next() - mounted after, it would never run for the one order path with no
  // human in the loop.
  app = express();
  app.use('/webhook/tradingview', auditLogger);
  app.use('/webhook/tradingview', webhookRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  broker = watchBroker();
  // Orders over either path (client or the broadcast's own fetch), counted by endpoint.
  http = { countOf: (e) => broker.orders().filter((o) => o.endpoint === e).length };
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

/** The shape TradingView actually posts - normalizePayload requires strategy and position_size. */
const alert = (overrides = {}) => ({
  strategy: 'tv-strategy',
  symbol: 'BTCUSDFUT',
  exchange: 'CRYPTO',
  action: 'BUY',
  quantity: 1,
  position_size: 1,
  ...overrides,
});

/** A broadcast-enabled watchlist with the real crypto account behind it. */
async function broadcastTarget() {
  const wl = await makeWatchlist({ type: 'broadcast', is_broadcast: 1, webhook_slug: `slug-${Date.now()}` });
  const inst = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, inst.id);
  return { wl, inst };
}

// ---------------------------------------------------------------------------
// The token is the whole door
// ---------------------------------------------------------------------------

test('no token, a wrong token, and an empty token are all refused', async () => {
  const { wl } = await broadcastTarget();

  const attempts = [
    ['no token at all', (r) => r],
    ['wrong token', (r) => r.set('X-Webhook-Token', 'not-the-token')],
    ['empty token', (r) => r.set('X-Webhook-Token', '')],
    ['token as a prefix', (r) => r.set('X-Webhook-Token', TOKEN.slice(0, -1))],
    ['token with extra', (r) => r.set('X-Webhook-Token', TOKEN + 'x')],
  ];

  for (const [label, decorate] of attempts) {
    const res = await decorate(request(app).post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`))
      .send(alert());
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `${label} -> ${res.status}`);
  }

  assert.strictEqual(http.countOf('placesmartorder'), 0, 'not one unauthorised alert may reach a broker');
});

test('the token is accepted from the query string as well as the header', async () => {
  // TradingView cannot set custom headers on every plan, so ?token= is a supported form. It is
  // still the same credential and must behave identically.
  const { wl } = await broadcastTarget();

  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}?token=${TOKEN}`)
    .send(alert());

  assert.notStrictEqual(res.status, STATUS.UNAUTHORIZED);
});

test('a wrong token in the query string is refused just like a wrong header', async () => {
  const { wl } = await broadcastTarget();
  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}?token=wrong`)
    .send(alert());

  assert.strictEqual(res.status, STATUS.UNAUTHORIZED);
  assert.strictEqual(http.countOf('placesmartorder'), 0);
});

test('authorisation is checked before the body is looked at', async () => {
  // An unauthorised caller must not be able to tell a malformed payload from a well-formed one -
  // that difference is a probe for what this endpoint accepts.
  const { wl } = await broadcastTarget();

  const garbage = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('Content-Type', 'text/plain')
    .send('this is not json');
  assert.strictEqual(garbage.status, STATUS.UNAUTHORIZED);

  const wellFormed = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .send(alert());
  assert.strictEqual(wellFormed.status, STATUS.UNAUTHORIZED);
});

// ---------------------------------------------------------------------------
// Payload handling
// ---------------------------------------------------------------------------

test('a plain-text JSON body is accepted - that is how TradingView sends alerts', async () => {
  const { wl } = await broadcastTarget();

  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify(alert()));

  assert.notStrictEqual(res.status, STATUS.UNAUTHORIZED);
  assert.ok(res.status < 500, `a text/plain alert must be understood, got ${res.status}`);
});

test('an unparseable body is a validation error, not a 500 and not an order', async () => {
  const { wl } = await broadcastTarget();

  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .set('Content-Type', 'text/plain')
    .send('{ this is not valid json');

  assert.strictEqual(res.status, STATUS.VALIDATION);
  assert.strictEqual(http.countOf('placesmartorder'), 0);
});

test('an alert for an unknown watchlist slug does not place an order anywhere', async () => {
  await broadcastTarget();

  const res = await request(app)
    .post('/webhook/tradingview/broadcast/no-such-slug')
    .set('X-Webhook-Token', TOKEN)
    .send(alert());

  assert.ok(res.status >= 400, `an unroutable alert must fail, got ${res.status}`);
  assert.strictEqual(http.countOf('placesmartorder'), 0, 'an unknown slug must not fan out to every instance');
});

test('a non-broadcast watchlist cannot be driven through the broadcast webhook', async () => {
  const wl = await makeWatchlist({ type: 'standard', is_broadcast: 0, webhook_slug: `std-${Date.now()}` });
  const inst = await realInstance(CRYPTO);
  await linkInstanceToWatchlist(wl.id, inst.id);

  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(alert());

  assert.ok(res.status >= 400, `got ${res.status}`);
  assert.strictEqual(http.countOf('placesmartorder'), 0);
});

test('a malformed watchlistId is rejected rather than silently ignored', async () => {
  const res = await request(app)
    .post('/webhook/tradingview/broadcast?watchlistId=abc')
    .set('X-Webhook-Token', TOKEN)
    .send(alert());

  assert.strictEqual(res.status, STATUS.VALIDATION);
});

// ---------------------------------------------------------------------------
// Idempotency - TradingView retries alerts
// ---------------------------------------------------------------------------

test('a retried alert with the same request id does not trade twice', async () => {
  // TradingView resends an alert it did not get a timely 200 for. Without this, a slow response
  // to one alert becomes two live positions.
  const { wl } = await broadcastTarget();
  const payload = alert({ request_id: 'tv-alert-0001' });

  const first = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(payload);

  const sentAfterFirst = http.countOf('placesmartorder');

  const retry = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(payload);

  assert.strictEqual(retry.headers['x-idempotency-hit'], 'true', 'the resend must be recognised as a replay');
  assert.strictEqual(http.countOf('placesmartorder'), sentAfterFirst, 'a resent alert must not place a second order');
  assert.strictEqual(retry.status, first.status, 'the replay must give the same answer as the original');
});

test('the request id may also arrive as a header', async () => {
  const { wl } = await broadcastTarget();

  const send = () => request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .set('X-Request-Id', 'tv-header-0001')
    .send(alert());

  await send();
  const sent = http.countOf('placesmartorder');
  const retry = await send();

  assert.strictEqual(retry.headers['x-idempotency-hit'], 'true');
  assert.strictEqual(http.countOf('placesmartorder'), sent);
});

test('the same request id carrying a different alert is refused', async () => {
  const { wl } = await broadcastTarget();
  const url = `/webhook/tradingview/broadcast/${wl.webhook_slug}`;

  await request(app).post(url).set('X-Webhook-Token', TOKEN).send(alert({ request_id: 'tv-reuse-1', action: 'BUY' }));
  const sent = http.countOf('placesmartorder');

  const conflicting = await request(app).post(url).set('X-Webhook-Token', TOKEN)
    .send(alert({ request_id: 'tv-reuse-1', action: 'SELL' }));

  assert.strictEqual(conflicting.status, STATUS.CONFLICT);
  assert.strictEqual(http.countOf('placesmartorder'), sent, 'the conflicting alert must not be executed');
});

test('a blank request id in the body is refused rather than treated as absent', async () => {
  // Tested via the body, not the header: Node trims header values, so a whitespace-only
  // X-Request-Id arrives as '' and is indistinguishable from absent before this code runs.
  const { wl } = await broadcastTarget();

  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(alert({ request_id: '   ' }));

  assert.strictEqual(res.status, STATUS.VALIDATION);
});

// ---------------------------------------------------------------------------
// The audit record
// ---------------------------------------------------------------------------

test('a webhook-placed order leaves an audit trail', async () => {
  // This is the one order path with no human in the loop, so it is the one that most needs a
  // record. The audit logger works by attaching a res finish hook, so mounting it after the
  // router silently disables it - hence testing it through the same wiring server.js uses.
  const { wl } = await broadcastTarget();

  await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(alert());

  await new Promise((resolve) => setTimeout(resolve, 50)); // the hook writes after the response

  const entries = await db.all('SELECT * FROM audit_logs');
  assert.ok(entries.length > 0, 'an unattended live-order path must be audited');
});

test('an authorised alert actually reaches the instance behind the watchlist', async () => {
  const { wl } = await broadcastTarget();

  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(alert({ action: 'SELL', quantity: 1, position_size: -1 }));

  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));

  const [sent] = broker.orders().filter((o) => o.endpoint === 'placesmartorder');
  assert.ok(sent, 'the alert must have been forwarded to the broker');
  assert.strictEqual(sent.data.symbol, 'BTCUSDFUT');
  assert.strictEqual(sent.data.action, 'SELL');
});

test('a broker that rejects the alert is reported as a failure, not a silent success', async () => {
  const { wl } = await broadcastTarget();

  // A contract the broker does not list: a genuine rejection.
  const res = await request(app)
    .post(`/webhook/tradingview/broadcast/${wl.webhook_slug}`)
    .set('X-Webhook-Token', TOKEN)
    .send(alert({ symbol: 'NOSUCHCONTRACTFUT' }));

  assert.notStrictEqual(res.status, STATUS.OK, 'a rejected alert must not be answered 200');
});

// ---------------------------------------------------------------------------
// Rotation - revoking a leaked token
// ---------------------------------------------------------------------------

test('rotating the token locks out the old one at once and stores the new one as a secret', async () => {
  const { wl } = await broadcastTarget();
  const url = `/webhook/tradingview/broadcast/${wl.webhook_slug}`;
  // An unparseable body: past the token check it is a 422, and nothing can be ordered either way.
  const probe = (token) => request(app).post(url).set('X-Webhook-Token', token)
    .set('Content-Type', 'text/plain').send('{ not json');

  try {
    const fresh = await tradingviewBroadcastService.rotateToken();
    assert.ok(fresh.length >= 32 && fresh !== TOKEN, 'a new, long, random token');
    assert.strictEqual((await probe(TOKEN)).status, STATUS.UNAUTHORIZED, 'the old token is refused straight away');
    assert.strictEqual((await probe(fresh)).status, STATUS.VALIDATION, 'the new token is accepted');

    const row = await db.get("SELECT value, is_sensitive FROM application_settings WHERE key = 'webhooks.tradingview.token'");
    assert.strictEqual(Number(row.is_sensitive), 1, 'and is masked wherever settings are listed');

    // A restart: config.loadFromDatabase() must load the real token, not the masked one.
    config.webhooks.tradingviewBroadcast.token = TOKEN;
    await config.loadFromDatabase();
    assert.strictEqual((await probe(fresh)).status, STATUS.VALIDATION, 'the new token still works after a restart');
  } finally {
    config.webhooks.tradingviewBroadcast.token = TOKEN;
  }
  assert.strictEqual(http.countOf('placesmartorder'), 0);
});
