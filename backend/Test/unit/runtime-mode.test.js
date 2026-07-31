import assert from 'assert';
import test from 'node:test';
import { config, isTestMode } from '../../src/core/config.js';
import { isSecureBaseUrl } from '../../src/middleware/auth.js';
import { AppError } from '../../src/core/errors.js';

/**
 * NODE_ENV defaults to 'development' when unset, so anything gated on it fails *open* - the
 * wrong direction for a trading system. These tests pin the behaviours that used to hang off
 * it to inputs that state the thing they actually depend on.
 */

const snapshot = () => ({ baseUrl: config.baseUrl, env: config.env, tm: config.auth.enableTestMode });
const restore = (s) => { config.baseUrl = s.baseUrl; config.env = s.env; config.auth.enableTestMode = s.tm; };

test('cookie Secure follows the URL scheme, not NODE_ENV', () => {
  const s = snapshot();
  try {
    config.baseUrl = 'https://admin.example.com';
    config.env = 'development'; // a TLS deployment that lost its NODE_ENV
    assert.strictEqual(isSecureBaseUrl(), true, 'TLS must imply Secure regardless of NODE_ENV');

    config.baseUrl = 'http://localhost:3000';
    config.env = 'production'; // a local run labelled production
    assert.strictEqual(isSecureBaseUrl(), false, 'plain HTTP must not set Secure, or the cookie is never sent');

    config.baseUrl = 'HTTPS://Admin.Example.com';
    assert.strictEqual(isSecureBaseUrl(), true, 'scheme check must be case-insensitive');

    config.baseUrl = undefined;
    assert.strictEqual(isSecureBaseUrl(), false, 'missing BASE_URL must not throw');
  } finally {
    restore(s);
  }
});

test('authentication can only be disabled by ENABLE_TEST_MODE', () => {
  const s = snapshot();
  const envBackup = { e: process.env.ENABLE_TEST_MODE, t: process.env.TEST_MODE };
  try {
    delete process.env.ENABLE_TEST_MODE;
    delete process.env.TEST_MODE;
    config.auth.enableTestMode = false;

    config.env = 'development';
    assert.strictEqual(isTestMode(), false, 'NODE_ENV must never imply an auth bypass');

    // TEST_MODE was a second, independent switch for the same thing. It is retired; if it ever
    // comes back, that is two ways to disable auth and one place to audit.
    process.env.TEST_MODE = 'true';
    assert.strictEqual(isTestMode(), false, 'the retired TEST_MODE var must have no effect');

    process.env.ENABLE_TEST_MODE = 'true';
    assert.strictEqual(isTestMode(), true, 'ENABLE_TEST_MODE is the one switch');
  } finally {
    if (envBackup.e === undefined) delete process.env.ENABLE_TEST_MODE; else process.env.ENABLE_TEST_MODE = envBackup.e;
    if (envBackup.t === undefined) delete process.env.TEST_MODE; else process.env.TEST_MODE = envBackup.t;
    restore(s);
  }
});

test('serialised errors never carry a stack trace', () => {
  const before = process.env.NODE_ENV;
  try {
    // The old guard emitted the stack whenever NODE_ENV was 'development' - i.e. by default.
    process.env.NODE_ENV = 'development';
    const body = new AppError('boom', 500).toJSON();
    assert.ok(!('stack' in body), 'stack must never reach an API response');
    assert.deepStrictEqual(Object.keys(body).sort(), ['message', 'status', 'statusCode']);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
  }
});

test('config exposes no NODE_ENV-derived behaviour flags', () => {
  // isDev/isProd/isTest had no consumers and were an invitation to add a fourth coupling.
  // config.testMode and config.google were dead alongside them.
  for (const key of ['isDev', 'isProd', 'isTest', 'testMode', 'google']) {
    assert.ok(!(key in config), `config.${key} was removed and must not return`);
  }
  assert.strictEqual(typeof config.env, 'string', 'config.env survives as a log label only');
});
