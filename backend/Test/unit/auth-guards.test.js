import assert from 'assert';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import db from '../../src/core/database.js';
import authRoutes from '../../src/routes/v1/auth.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { timingSafeEqualStr } from '../../src/utils/sanitizers.js';
import { OpenAlgoError } from '../../src/core/errors.js';

/**
 * Guards on the two paths an outsider can reach: the login form, and any response that carries a
 * broker's own HTTP status back to the browser.
 */

test('login locks out after repeated failures instead of allowing unlimited guesses', async () => {
  await db.connect();

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);

  const creds = { email: `nobody-${Date.now()}@example.com`, password: 'not-the-password' };

  // Five wrong guesses are answered normally...
  for (let i = 0; i < 5; i += 1) {
    const res = await request(app).post('/api/v1/auth/login').send(creds);
    assert.strictEqual(res.status, 401, `attempt ${i + 1} should be a plain rejection`);
  }

  // ...the sixth is refused outright, without reaching bcrypt.
  const blocked = await request(app).post('/api/v1/auth/login').send(creds);
  assert.strictEqual(blocked.status, 429);
  assert.ok(blocked.headers['retry-after'], 'must tell the client when to come back');

  // A different account from the same address is unaffected - the lockout is per target, so it
  // cannot be used to lock the real operator out.
  const other = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: `someone-else-${Date.now()}@example.com`, password: 'x' });
  assert.strictEqual(other.status, 401);
});

test("a broker's 401 is not passed through as this app's 401", () => {
  // api-client.js treats any 401 as "your session died" and wipes the stored token, so leaking an
  // upstream auth failure logs the operator out of the dashboard.
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
  };

  errorHandler(new OpenAlgoError('Invalid openalgo apikey', 'funds', 401), { path: '/x', method: 'GET' }, res, () => {});
  assert.strictEqual(captured.code, 502);
  assert.match(captured.body.message, /Invalid openalgo apikey/, 'the message still reaches the UI');

  errorHandler(new OpenAlgoError('Forbidden', 'funds', 403), { path: '/x', method: 'GET' }, res, () => {});
  assert.strictEqual(captured.code, 502);

  // Everything else keeps the upstream status.
  errorHandler(new OpenAlgoError('Bad symbol', 'quotes', 400), { path: '/x', method: 'GET' }, res, () => {});
  assert.strictEqual(captured.code, 400);
});

test('secret comparison accepts the right value and rejects everything else', () => {
  assert.strictEqual(timingSafeEqualStr('s3cret', 's3cret'), true);
  assert.strictEqual(timingSafeEqualStr('s3crey', 's3cret'), false);
  // A missing header must never match a configured secret, whatever its length.
  assert.strictEqual(timingSafeEqualStr(undefined, 's3cret'), false);
  assert.strictEqual(timingSafeEqualStr(null, 's3cret'), false);
  assert.strictEqual(timingSafeEqualStr('', 's3cret'), false);
});
