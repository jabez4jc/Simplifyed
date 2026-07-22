import assert from 'assert';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword, signLocalToken } from '../../src/middleware/auth.js';
import { config } from '../../src/core/config.js';

test('hashPassword/verifyPassword round trip', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('verifyPassword rejects a missing hash instead of throwing', async () => {
  assert.equal(await verifyPassword('anything', null), false);
});

test('signLocalToken issues a token verifiable with the configured secret', () => {
  const token = signLocalToken({ id: 42, email: 'trader@example.com' });
  const payload = jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
  assert.equal(payload.sub, '42');
  assert.equal(payload.email, 'trader@example.com');
});

test('signLocalToken output is rejected by a different secret', () => {
  const token = signLocalToken({ id: 42, email: 'trader@example.com' });
  assert.throws(() => jwt.verify(token, 'a-different-secret', { algorithms: ['HS256'] }));
});
