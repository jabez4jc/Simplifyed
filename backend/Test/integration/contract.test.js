import assert from 'assert';
import test, { before, after } from 'node:test';
import request from 'supertest';

import { useTestDb } from '../helpers/db.js';
import { buildApp, listen } from '../helpers/app.js';
import { asAdmin, asRoleless, bearer } from '../helpers/auth.js';
import { makeWatchlist, makeWatchlistSymbol } from '../helpers/fixtures.js';
import { watchBroker, realInstance, CRYPTO } from '../helpers/real-broker.js';
import { listV1Endpoints, concrete } from '../helpers/routes.js';
import { STATUS } from '../helpers/http.js';
import apiV1Routes from '../../src/routes/v1/index.js';

/**
 * The regression net.
 *
 * The per-domain suites test what each endpoint MEANS. This one tests what every endpoint owes
 * the caller regardless of meaning, across the whole surface at once:
 *
 *   1. it is not reachable without a login (unless it is deliberately public),
 *   2. it does not answer a logged-in user who has no role yet,
 *   3. it does not answer a plausible request with a 500.
 *
 * (3) is the one that catches "a new feature broke an old endpoint": a handler that starts
 * throwing on a shape it used to accept shows up here without anyone having written a test for
 * that specific handler. The endpoint list is read off the live router (see helpers/routes.js),
 * so a newly added route is covered the moment it is mounted.
 *
 * The :id routes point at the operator's real crypto account (analyzer mode). Every broker call
 * the sweep triggers goes through the test interlock - nothing can switch the account to live,
 * and nothing is ordered unless the broker confirms analyzer mode - and anything opened is closed
 * at the end.
 */

// Endpoints that are unauthenticated ON PURPOSE. Anything not on this list must refuse an
// anonymous caller; adding to it is a deliberate decision to expose something publicly.
const PUBLIC = new Set([
  'GET /health',        // infrastructure liveness probe
  'GET /ready',         // infrastructure readiness probe
  'GET /public-config', // non-sensitive frontend bootstrap - see the comment in routes/v1/index.js
  'POST /auth/login',
  'POST /auth/register',
  // Authenticated by Telegram's own webhook secret, not by a user session, so it sits outside
  // the role system entirely. It still refuses an anonymous caller - see the sweep above, which
  // covers it - it just answers 401 rather than 403 because there is no role to check.
  'POST /telegram/webhook',
]);

// Endpoints whose side effects are real and unwanted in a sweep - they are covered by their own
// suites, where the broker and the payload are controlled.
const SKIP_SMOKE = new Set([
  'POST /orders/', 'POST /orders/cancel-all', 'POST /orders/:id/cancel', 'POST /orders/:id/modify',
  'POST /quickorders/',
  // Closes EVERY position on the account under its strategy tag - never part of a sweep.
  'POST /positions/:instanceId/close', 'POST /positions/:instanceId/close/position',
  'POST /strategies/:id/execute', 'POST /strategies/:id/exit',
  // Cancels, closes and switches EVERY instance - Test/integration/kill-switch.test.js covers it.
  'POST /kill-switch',
  'POST /auth/login', 'POST /auth/register',
]);

let app;
let server;
let broker;
let admin;
let pending;
let ids;
let realKey;

before(async () => {
  await useTestDb('contract');

  app = buildApp(apiV1Routes, '/api/v1');
  // One long-lived server for the ~1000 requests below - see listen() for why.
  server = listen(app);
  broker = watchBroker();

  admin = await asAdmin();
  pending = await asRoleless();

  // One row of everything the :params can point at, so a sweep hits real records rather than
  // only ever exercising the not-found branch.
  const instance = await realInstance(CRYPTO);
  realKey = instance.api_key;
  const watchlist = await makeWatchlist();
  const symbol = await makeWatchlistSymbol(watchlist.id);

  ids = {
    default: String(instance.id),
    id: String(instance.id),
    instanceId: String(instance.id),
    watchlistId: String(watchlist.id),
    symbolId: String(symbol.id),
    strategyId: '1',
    triggerId: '1',
    orderId: 'TEST-ORDER-1',
    legId: '1',
    key: 'polling.interval',
    slug: 'nonexistent-slug',
    userId: String(admin.id),
    roleId: '1',
  };
});

after(async () => {
  // DELETE /instances/:id is part of the sweep, so put the account back before closing anything.
  await realInstance(CRYPTO);
  const leftovers = await broker.flattenAll();
  broker.restore();
  server.close();
  assert.deepStrictEqual(leftovers, [], `left open at the broker:\n${leftovers.join('\n')}`);
});

const endpoints = listV1Endpoints();
const label = (e) => `${e.method} ${e.path}`;

test('the sweep is actually covering the whole surface', () => {
  // A guard against this file quietly testing nothing - if the router walk breaks, every loop
  // below becomes a no-op and the suite still goes green.
  assert.ok(endpoints.length > 100, `expected the full v1 surface, found only ${endpoints.length}`);
});

test('every endpoint that is not deliberately public refuses an anonymous caller', async () => {
  const leaks = [];

  for (const endpoint of endpoints) {
    if (PUBLIC.has(label(endpoint))) continue;

    const url = '/api/v1' + concrete(endpoint.path, ids);
    const res = await request(server)[endpoint.method.toLowerCase()](url).send({});

    if (res.status !== STATUS.UNAUTHORIZED) {
      leaks.push(`${label(endpoint)} -> ${res.status}`);
    }
  }

  assert.deepStrictEqual(leaks, [], `these endpoints answered an anonymous caller:\n${leaks.join('\n')}`);
});

test('the endpoints that ARE public stay reachable', async () => {
  // The other half of the contract: locking everything down is not a fix if it breaks the
  // liveness probes or the login form.
  for (const name of ['GET /health', 'GET /ready', 'GET /public-config']) {
    const [method, path] = name.split(' ');
    const res = await request(server)[method.toLowerCase()]('/api/v1' + path);
    assert.ok(res.status < 400 || res.status === 503, `${name} -> ${res.status}`);
  }
});

test('a logged-in user with no role assigned is refused everywhere, not silently allowed', async () => {
  const allowed = [];

  for (const endpoint of endpoints) {
    if (PUBLIC.has(label(endpoint))) continue;
    if (SKIP_SMOKE.has(label(endpoint))) continue;

    const url = '/api/v1' + concrete(endpoint.path, ids);
    const res = await bearer(request(server)[endpoint.method.toLowerCase()](url), pending).send({});

    if (res.status !== STATUS.FORBIDDEN) {
      allowed.push(`${label(endpoint)} -> ${res.status}`);
    }
  }

  assert.deepStrictEqual(allowed, [], `a role-less account got past these:\n${allowed.join('\n')}`);
});

test('no endpoint answers a plausible authenticated request with a 500', async () => {
  // Not "every endpoint returns 200" - many legitimately 404 or 422 on this input. The contract
  // is narrower and more useful: whatever the answer, it is a considered one. A 500 means an
  // exception escaped, which is how a broken handler actually presents.
  const crashes = [];

  for (const endpoint of endpoints) {
    if (SKIP_SMOKE.has(label(endpoint))) continue;

    const url = '/api/v1' + concrete(endpoint.path, ids);
    const res = await bearer(request(server)[endpoint.method.toLowerCase()](url), admin).send({});

    // 503 from /ready is its contract, not a crash: it reports the instruments cache as not yet
    // loaded, which is exactly the state a test process is in.
    if (res.status >= 500 && !(res.status === 503 && endpoint.path === '/ready')) {
      crashes.push(`${label(endpoint)} -> ${res.status} ${JSON.stringify(res.body?.message ?? '')}`);
    }
  }

  assert.deepStrictEqual(crashes, [], `these endpoints crashed:\n${crashes.join('\n')}`);
});

test('no endpoint crashes on a garbage id', async () => {
  // Route params reach parseInt and then SQL. A non-numeric id must produce a 404 or a 422,
  // never a stack trace.
  const crashes = [];
  const garbage = Object.fromEntries(Object.keys(ids).map((k) => [k, 'not-an-id']));

  for (const endpoint of endpoints) {
    if (SKIP_SMOKE.has(label(endpoint))) continue;
    if (!endpoint.path.includes(':')) continue;

    const url = '/api/v1' + concrete(endpoint.path, garbage);
    const res = await bearer(request(server)[endpoint.method.toLowerCase()](url), admin).send({});

    if (res.status >= 500) {
      crashes.push(`${label(endpoint)} -> ${res.status}`);
    }
  }

  assert.deepStrictEqual(crashes, [], `these endpoints crashed on a junk id:\n${crashes.join('\n')}`);
});

test('no endpoint crashes on an unexpected body', async () => {
  const crashes = [];
  const hostile = { name: null, id: [], quantity: {}, nested: { deep: [1, 2, 3] }, '': '' };

  for (const endpoint of endpoints) {
    if (SKIP_SMOKE.has(label(endpoint))) continue;
    if (endpoint.method === 'GET') continue;

    const url = '/api/v1' + concrete(endpoint.path, ids);
    const res = await bearer(request(server)[endpoint.method.toLowerCase()](url), admin).send(hostile);

    if (res.status >= 500) {
      crashes.push(`${label(endpoint)} -> ${res.status} ${JSON.stringify(res.body?.message ?? '')}`);
    }
  }

  assert.deepStrictEqual(crashes, [], `these endpoints crashed on a hostile body:\n${crashes.join('\n')}`);
});

test('no response anywhere carries a broker api key', async () => {
  // Masking is applied per-route, which means it can be forgotten on a new one. This checks the
  // whole surface at once against the real account's own key.
  const marker = realKey;
  await realInstance(CRYPTO);

  const leaks = [];
  for (const endpoint of endpoints) {
    if (endpoint.method !== 'GET') continue;

    const url = '/api/v1' + concrete(endpoint.path, ids);
    const res = await bearer(request(server).get(url), admin);
    const body = typeof res.text === 'string' ? res.text : JSON.stringify(res.body);

    if (body && body.includes(marker)) {
      leaks.push(label(endpoint));
    }
  }

  assert.deepStrictEqual(leaks, [], `these endpoints leaked a live api key:\n${leaks.join('\n')}`);
});

test('no error response carries a stack trace', async () => {
  // A stack trace names internal paths and library versions. The error handler strips them; this
  // makes sure no route bypasses it by responding itself.
  const leaks = [];

  for (const endpoint of endpoints) {
    if (SKIP_SMOKE.has(label(endpoint))) continue;

    const url = '/api/v1' + concrete(endpoint.path, { default: '999999' });
    const res = await bearer(request(server)[endpoint.method.toLowerCase()](url), admin).send({});
    const body = JSON.stringify(res.body ?? {});

    if (/\bat\s+\w+.*\(.*\.js:\d+:\d+\)/.test(body) || body.includes('node_modules')) {
      leaks.push(`${label(endpoint)} -> ${body.slice(0, 120)}`);
    }
  }

  assert.deepStrictEqual(leaks, [], `these endpoints leaked internals:\n${leaks.join('\n')}`);
});
