import assert from 'assert';
import test from 'node:test';
import { verifyLocalToken, signLocalToken } from '../../src/middleware/auth.js';
import jwt from 'jsonwebtoken';

/**
 * The WebSocket gateway's connection-upgrade auth.
 *
 * It used to check an express-session cookie (`connect.sid`), which NOTHING in this app ever
 * issues: `configureSession()` sets `saveUninitialized: false`, and no route anywhere writes to
 * `req.session` (confirmed by search) - the app is JWT-only. That meant every WS connection was
 * rejected, not merely some of them: the "Disconnected" pill was permanent, not flaky. It now
 * verifies the same locally-issued JWT every REST request already authenticates with.
 */

test('a token signed by this server verifies', () => {
  const token = signLocalToken({ id: 42, email: 'trader@example.com' });
  const payload = verifyLocalToken(token);
  assert.ok(payload, 'a genuine token must verify');
  assert.strictEqual(payload.sub, '42');
});

test('no token, an empty string, and garbage are all rejected the same way', () => {
  assert.strictEqual(verifyLocalToken(null), null);
  assert.strictEqual(verifyLocalToken(undefined), null);
  assert.strictEqual(verifyLocalToken(''), null);
  assert.strictEqual(verifyLocalToken('not-a-jwt'), null);
  assert.strictEqual(verifyLocalToken('a.b.c'), null);
});

test('a token signed with a different secret is rejected, not silently trusted', () => {
  // Simulates the exact failure mode this replaces: a credential that LOOKS like it might be
  // valid must not be treated as authentication.
  const forged = jwt.sign({ sub: '1' }, 'wrong-secret', { algorithm: 'HS256' });
  assert.strictEqual(verifyLocalToken(forged), null);
});
