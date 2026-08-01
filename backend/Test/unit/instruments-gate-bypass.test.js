import assert from 'assert';
import test from 'node:test';
import { checkInstrumentsRefresh } from '../../src/middleware/instruments-refresh.middleware.js';

/**
 * The instruments gate blocks API traffic while the instruments cache is stale, so a trade can
 * never be placed against stale contracts. Two things must NOT be behind it:
 *
 *  - identity (/api/user, /api/v1/auth/*) - the login page treated the gate's 503 as a bad
 *    token, wiped it and bounced back to the form, so a dead broker instance presented as
 *    "wrong password";
 *  - administration (/instances, /settings, ...) - the cache can only be refreshed via a
 *    healthy instance, so gating the screens that repair an instance made an all-unhealthy
 *    state unrecoverable from inside the app.
 *
 * These ran with an authenticated request and an unready cache, which is exactly the state that
 * produced the lockout. `next()` being called is the whole assertion.
 */
const gatedState = {
  user: { id: 1, email: 'admin@example.com' },
  headers: {},
  app: { locals: {} },
};

async function passesGate(path) {
  const req = { ...gatedState, path };
  let called = false;
  const res = {
    status() {
      throw new Error(`gate blocked ${path}`);
    },
  };
  await checkInstrumentsRefresh(req, res, () => {
    called = true;
  });
  return called;
}

for (const path of [
  '/api/user',
  '/api/v1/auth/login',
  '/api/v1/instances',
  '/api/v1/instances/26/refresh',
  '/api/v1/settings',
  '/api/v1/instruments/refresh',
]) {
  test(`${path} is not gated on the instruments cache`, async () => {
    assert.strictEqual(await passesGate(path), true);
  });
}
