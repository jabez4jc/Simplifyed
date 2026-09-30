import assert from 'assert';
import test, { before, beforeEach } from 'node:test';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { createUser, ROLE, bearer } from '../helpers/auth.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import authRoutes from '../../src/routes/v1/auth.js';
import { config } from '../../src/core/config.js';

/**
 * The credential surface. Everything here fronts live broker API keys, so the tests are about
 * what an attacker can do rather than what a happy user can.
 */

let app;

before(async () => {
  await useTestDb('auth');
  app = buildApp(authRoutes, '/api/v1/auth');
});
beforeEach(async () => {
  await truncate();
});

const post = (path) => request(app).post(path);

// ---------------------------------------------------------------------------
// Registration - a one-shot bootstrap, not an open door
// ---------------------------------------------------------------------------

test('the first registration creates an admin and then closes registration', async () => {
  const first = await post('/api/v1/auth/register')
    .send({ email: 'founder@example.test', password: 'a-good-long-password' });

  assert.strictEqual(first.status, STATUS.OK, JSON.stringify(first.body));
  assert.ok(first.body.data.token, 'the bootstrap admin is logged straight in');
  assert.strictEqual(first.body.data.user.is_admin, 1);
  assert.strictEqual(first.body.data.user.role, 'Admin');

  const second = await post('/api/v1/auth/register')
    .send({ email: 'gatecrasher@example.test', password: 'another-long-password' });

  assert.strictEqual(second.status, STATUS.FORBIDDEN, 'registration must close after the first account');
  const rows = await db.all('SELECT id FROM users');
  assert.strictEqual(rows.length, 1, 'no second account may be created through this route');
});

test('registration never returns a password hash', async () => {
  const res = await post('/api/v1/auth/register')
    .send({ email: 'founder@example.test', password: 'a-good-long-password' });

  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('password_hash'), 'the hash must not be serialised into a response');
  assert.ok(!body.includes('a-good-long-password'), 'the password must not be echoed back');
});

test('registration rejects a weak or malformed credential', async () => {
  const bad = [
    ['no email', { password: 'a-good-long-password' }],
    ['malformed email', { email: 'not-an-email', password: 'a-good-long-password' }],
    ['password too short', { email: 'a@b.test', password: 'short' }],
    ['password over bcrypt 72-byte limit', { email: 'a@b.test', password: 'x'.repeat(73) }],
    ['non-string password', { email: 'a@b.test', password: 12345678 }],
  ];

  for (const [label, body] of bad) {
    const res = await post('/api/v1/auth/register').send(body);
    assert.strictEqual(res.status, STATUS.BAD_REQUEST, `${label} -> ${res.status}`);
  }

  assert.strictEqual((await db.all('SELECT id FROM users')).length, 0, 'nothing may have been created');
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('a correct password returns a token that this server will accept', async () => {
  const user = await createUser({ roleId: ROLE.ADMIN, isAdmin: true, password: 'the-correct-password' });

  const res = await post('/api/v1/auth/login').send({ email: user.email, password: 'the-correct-password' });

  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));
  const payload = jwt.verify(res.body.data.token, config.auth.jwtSecret, { algorithms: ['HS256'] });
  assert.strictEqual(payload.sub, String(user.id));
});

test('the email is matched case-insensitively but the password is not', async () => {
  const user = await createUser({ roleId: ROLE.TRADER, password: 'CaseSensitivePass1' });

  const upper = await post('/api/v1/auth/login')
    .send({ email: user.email.toUpperCase(), password: 'CaseSensitivePass1' });
  assert.strictEqual(upper.status, STATUS.OK, 'an operator typing their email in caps must still get in');

  const wrongCase = await post('/api/v1/auth/login')
    .send({ email: user.email, password: 'casesensitivepass1' });
  assert.strictEqual(wrongCase.status, STATUS.UNAUTHORIZED, 'password comparison must stay case-sensitive');
});

test('a wrong password and an unknown account are answered identically', async () => {
  // Different answers turn login into an account-enumeration oracle.
  const user = await createUser({ roleId: ROLE.TRADER, password: 'the-correct-password' });

  const wrongPassword = await post('/api/v1/auth/login').send({ email: user.email, password: 'wrong' });
  const unknownUser = await post('/api/v1/auth/login').send({ email: 'ghost@example.test', password: 'wrong' });

  assert.strictEqual(wrongPassword.status, unknownUser.status);
  assert.strictEqual(wrongPassword.body.message, unknownUser.body.message);
});

test('login never returns a password hash', async () => {
  const user = await createUser({ roleId: ROLE.ADMIN, isAdmin: true, password: 'the-correct-password' });
  const res = await post('/api/v1/auth/login').send({ email: user.email, password: 'the-correct-password' });

  assert.ok(!JSON.stringify(res.body).includes('password_hash'));
});

test('guessing is throttled per account, and the lockout is scoped so it cannot be weaponised', async () => {
  const target = await createUser({ roleId: ROLE.ADMIN, isAdmin: true, password: 'the-correct-password' });
  const bystander = await createUser({ roleId: ROLE.TRADER, password: 'another-password' });

  for (let i = 0; i < 5; i += 1) {
    const res = await post('/api/v1/auth/login').send({ email: target.email, password: `guess-${i}` });
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `attempt ${i + 1} should be a plain rejection`);
  }

  const blocked = await post('/api/v1/auth/login').send({ email: target.email, password: 'guess-6' });
  assert.strictEqual(blocked.status, STATUS.RATE_LIMITED);
  assert.ok(blocked.headers['retry-after'], 'the client must be told when to come back');

  // Even the RIGHT password is refused while locked out - otherwise the throttle is decorative.
  const correctButLocked = await post('/api/v1/auth/login')
    .send({ email: target.email, password: 'the-correct-password' });
  assert.strictEqual(correctButLocked.status, STATUS.RATE_LIMITED);

  // A different account is unaffected: the lockout is per target, so it cannot be used to lock
  // the real operator out of their own dashboard.
  const other = await post('/api/v1/auth/login')
    .send({ email: bystander.email, password: 'another-password' });
  assert.strictEqual(other.status, STATUS.OK, 'one account being attacked must not lock out another');
});

test('an oversized password is refused before it reaches bcrypt', async () => {
  const res = await post('/api/v1/auth/login').send({ email: 'a@b.test', password: 'x'.repeat(5000) });
  assert.strictEqual(res.status, STATUS.BAD_REQUEST);
});

test('a non-string credential does not crash the login handler', async () => {
  for (const body of [{ email: {}, password: [] }, { email: null, password: null }, {}, { email: 1, password: 2 }]) {
    const res = await post('/api/v1/auth/login').send(body);
    assert.ok(res.status < 500, `${JSON.stringify(body)} -> ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// Changing a password
// ---------------------------------------------------------------------------

test('changing a password requires the current one and then actually takes effect', async () => {
  const user = await createUser({ roleId: ROLE.ADMIN, isAdmin: true, password: 'the-old-password' });

  const wrong = await bearer(post('/api/v1/auth/change-password'), user)
    .send({ currentPassword: 'not-it', newPassword: 'the-new-password' });
  assert.strictEqual(wrong.status, STATUS.UNAUTHORIZED, 'a stolen session must not be enough to take the account');

  const ok = await bearer(post('/api/v1/auth/change-password'), user)
    .send({ currentPassword: 'the-old-password', newPassword: 'the-new-password' });
  assert.strictEqual(ok.status, STATUS.OK, JSON.stringify(ok.body));

  const withNew = await post('/api/v1/auth/login').send({ email: user.email, password: 'the-new-password' });
  assert.strictEqual(withNew.status, STATUS.OK, 'the new password must work');

  const withOld = await post('/api/v1/auth/login').send({ email: user.email, password: 'the-old-password' });
  assert.strictEqual(withOld.status, STATUS.UNAUTHORIZED, 'the old password must stop working');
});

test('changing a password requires a session at all', async () => {
  const res = await post('/api/v1/auth/change-password')
    .send({ currentPassword: 'x', newPassword: 'the-new-password' });
  assert.strictEqual(res.status, STATUS.UNAUTHORIZED);
});

test('a weak new password is refused', async () => {
  const user = await createUser({ roleId: ROLE.ADMIN, isAdmin: true, password: 'the-old-password' });

  for (const newPassword of ['short', '', 'x'.repeat(73)]) {
    const res = await bearer(post('/api/v1/auth/change-password'), user)
      .send({ currentPassword: 'the-old-password', newPassword });
    assert.strictEqual(res.status, STATUS.BAD_REQUEST, `'${newPassword.slice(0, 12)}' -> ${res.status}`);
  }

  const stillOld = await post('/api/v1/auth/login').send({ email: user.email, password: 'the-old-password' });
  assert.strictEqual(stillOld.status, STATUS.OK, 'a refused change must not have altered anything');
});

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

test('a forged or tampered token is not accepted', async () => {
  const user = await createUser({ roleId: ROLE.ADMIN, isAdmin: true });

  const forged = jwt.sign({ sub: String(user.id), email: user.email }, 'an-attackers-secret', { algorithm: 'HS256' });
  const tampered = user.token.slice(0, -3) + 'aaa';
  const expired = jwt.sign({ sub: String(user.id) }, config.auth.jwtSecret, { algorithm: 'HS256', expiresIn: '-1s' });

  for (const [label, token] of [['forged', forged], ['tampered', tampered], ['expired', expired], ['garbage', 'not.a.token']]) {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'x', newPassword: 'the-new-password' });
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `${label} token -> ${res.status}`);
  }
});

test('an "alg: none" token is rejected - the classic JWT bypass', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: '1', email: 'admin@example.test' })).toString('base64url');

  const res = await request(app)
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${header}.${payload}.`)
    .send({ currentPassword: 'x', newPassword: 'the-new-password' });

  assert.strictEqual(res.status, STATUS.UNAUTHORIZED);
});

test('a token for a deleted user stops working', async () => {
  const user = await createUser({ roleId: ROLE.ADMIN, isAdmin: true, password: 'the-old-password' });
  await db.run('DELETE FROM users WHERE id = ?', [user.id]);

  const res = await bearer(post('/api/v1/auth/change-password'), user)
    .send({ currentPassword: 'the-old-password', newPassword: 'the-new-password' });

  assert.strictEqual(res.status, STATUS.UNAUTHORIZED, 'a deleted account must not keep a working session');
});
