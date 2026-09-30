import assert from 'assert';
import test, { before, beforeEach } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asTrader, asMonitor, createUser, withPermissions, withPermissionsExcept, ROLE, bearer } from '../helpers/auth.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import rbacRoutes from '../../src/routes/v1/rbac.js';
import authRoutes from '../../src/routes/v1/auth.js';

/**
 * RBAC is the thing every other permission check depends on. A hole here is a hole everywhere,
 * so these tests are about escalation and lockout rather than happy-path CRUD.
 */

let app;
let loginApp;

before(async () => {
  await useTestDb('rbac');
  app = buildApp(rbacRoutes, '/api/v1/rbac');
  loginApp = buildApp(authRoutes, '/api/v1/auth');
});
beforeEach(async () => {
  await truncate();
});

const get = (p, u) => bearer(request(app).get(p), u);
const post = (p, u) => bearer(request(app).post(p), u);
const put = (p, u) => bearer(request(app).put(p), u);

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('every rbac route refuses an anonymous caller', async () => {
  const routes = [
    ['get', '/api/v1/rbac/roles'],
    ['get', '/api/v1/rbac/permissions'],
    ['get', '/api/v1/rbac/users'],
    ['put', '/api/v1/rbac/roles/Trader/permissions'],
    ['put', '/api/v1/rbac/users/1/role'],
    ['post', '/api/v1/rbac/users'],
    ['post', '/api/v1/rbac/users/1/reset-password'],
  ];
  for (const [method, path] of routes) {
    const res = await request(app)[method](path).send({});
    assert.strictEqual(res.status, STATUS.UNAUTHORIZED, `${method.toUpperCase()} ${path} -> ${res.status}`);
  }
});

test('an ordinary trader cannot read or reshape the permission system', async () => {
  const trader = await asTrader();

  assert.strictEqual((await get('/api/v1/rbac/roles', trader)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await get('/api/v1/rbac/permissions', trader)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await get('/api/v1/rbac/users', trader)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await put('/api/v1/rbac/roles/Trader/permissions', trader).send({ permissions: [] })).status, STATUS.FORBIDDEN);
});

test('a monitor cannot create users or assign roles', async () => {
  const monitor = await asMonitor();

  assert.strictEqual((await post('/api/v1/rbac/users', monitor)
    .send({ email: 'new@example.test', password: 'a-long-password', role: 'Admin' })).status, STATUS.FORBIDDEN);
  assert.strictEqual((await put('/api/v1/rbac/users/1/role', monitor).send({ role: 'Admin' })).status, STATUS.FORBIDDEN);
});

test('the two rbac permissions are genuinely separate', async () => {
  // Being allowed to hand out existing roles must not also mean being allowed to redefine what
  // those roles can do - that turns "assign roles" into "grant yourself anything".
  const assigner = await withPermissions(['rbac.assign_roles']);

  assert.strictEqual((await get('/api/v1/rbac/users', assigner)).status, STATUS.OK);
  assert.strictEqual(
    (await put('/api/v1/rbac/roles/Monitor/permissions', assigner).send({ permissions: ['settings.manage'] })).status,
    STATUS.FORBIDDEN,
    'rbac.assign_roles must not confer rbac.manage_roles'
  );

  const manager = await withPermissions(['rbac.manage_roles']);
  assert.strictEqual((await get('/api/v1/rbac/roles', manager)).status, STATUS.OK);
  assert.strictEqual(
    (await put('/api/v1/rbac/users/1/role', manager).send({ role: 'Admin' })).status,
    STATUS.FORBIDDEN,
    'rbac.manage_roles must not confer rbac.assign_roles'
  );
});

test('a user holding every permission except the rbac ones is still locked out of rbac', async () => {
  const almost = await withPermissionsExcept(['rbac.manage_roles', 'rbac.assign_roles']);

  assert.strictEqual((await get('/api/v1/rbac/roles', almost)).status, STATUS.FORBIDDEN);
  assert.strictEqual((await get('/api/v1/rbac/users', almost)).status, STATUS.FORBIDDEN);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the seeded roles and permissions are all there', async () => {
  const admin = await asAdmin();

  const roles = await get('/api/v1/rbac/roles', admin);
  assert.strictEqual(roles.status, STATUS.OK);
  const names = roles.body.data.map((r) => r.name);
  for (const expected of ['Admin', 'Trader', 'Monitor']) {
    assert.ok(names.includes(expected), `the ${expected} role must exist`);
  }

  const perms = await get('/api/v1/rbac/permissions', admin);
  const keys = perms.body.data.map((p) => p.key);
  assert.strictEqual(keys.length, 28, 'the seeded permission set must be intact');
  for (const retired of ['pages.audit.view', 'pages.api_playground.view', 'monitor.view']) {
    assert.ok(!keys.includes(retired), `${retired} guards nothing and must not be offered`);
  }
});

test('the user list never carries password hashes', async () => {
  const admin = await asAdmin();
  await createUser({ roleId: ROLE.TRADER, password: 'some-password-here' });

  const res = await get('/api/v1/rbac/users', admin);
  assert.strictEqual(res.status, STATUS.OK);

  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('password_hash'), 'the user list must not expose hashes');
  assert.ok(!body.includes('$2b$'), 'not even a bcrypt hash fragment may appear');
});

// ---------------------------------------------------------------------------
// Creating users
// ---------------------------------------------------------------------------

test('creating a user makes an account that can actually log in with the given role', async () => {
  const admin = await asAdmin();

  const created = await post('/api/v1/rbac/users', admin)
    .send({ email: 'newtrader@example.test', password: 'a-long-enough-password', role: 'Trader' });
  assert.strictEqual(created.status, STATUS.CREATED, JSON.stringify(created.body));

  const login = await request(loginApp).post('/api/v1/auth/login')
    .send({ email: 'newtrader@example.test', password: 'a-long-enough-password' });
  assert.strictEqual(login.status, STATUS.OK, 'the account must be usable');
  assert.strictEqual(login.body.data.user.role, 'Trader');
  assert.strictEqual(login.body.data.user.is_admin, 0, 'a Trader must not be created as a superuser');
});

test('a created user is never stored with a plaintext password', async () => {
  const admin = await asAdmin();
  await post('/api/v1/rbac/users', admin)
    .send({ email: 'hashed@example.test', password: 'plaintext-check-password', role: 'Trader' });

  const row = await db.get('SELECT password_hash FROM users WHERE email = ?', ['hashed@example.test']);
  assert.ok(row.password_hash, 'a hash must be stored');
  assert.notStrictEqual(row.password_hash, 'plaintext-check-password');
  assert.match(row.password_hash, /^\$2[aby]\$/, 'it must be a bcrypt hash');
});

test('creating a user rejects a weak password, a missing role, and a duplicate email', async () => {
  const admin = await asAdmin();

  assert.strictEqual((await post('/api/v1/rbac/users', admin)
    .send({ email: 'a@b.test', password: 'short', role: 'Trader' })).status, STATUS.BAD_REQUEST);

  assert.strictEqual((await post('/api/v1/rbac/users', admin)
    .send({ email: 'a@b.test', password: 'a-long-enough-password' })).status, STATUS.BAD_REQUEST);

  await post('/api/v1/rbac/users', admin)
    .send({ email: 'dupe@example.test', password: 'a-long-enough-password', role: 'Trader' });
  const again = await post('/api/v1/rbac/users', admin)
    .send({ email: 'dupe@example.test', password: 'a-different-password', role: 'Admin' });

  assert.ok(again.status >= 400 && again.status < 500, `a duplicate email -> ${again.status}`);
  const rows = await db.all('SELECT id FROM users WHERE email = ?', ['dupe@example.test']);
  assert.strictEqual(rows.length, 1, 'a duplicate must not create a second account');
});

test('creating a user with an unknown role does not leave a role-less account behind', async () => {
  const admin = await asAdmin();

  const res = await post('/api/v1/rbac/users', admin)
    .send({ email: 'norole@example.test', password: 'a-long-enough-password', role: 'Sysadmin' });

  if (res.status < 400) {
    const assigned = await db.get(
      'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE u.email = ?',
      ['norole@example.test']
    );
    assert.ok(assigned, 'if the account was created it must have a real role, not none');
  } else {
    const row = await db.get('SELECT id FROM users WHERE email = ?', ['norole@example.test']);
    assert.ok(!row, 'a rejected creation must not leave an orphan account');
  }
});

// ---------------------------------------------------------------------------
// Assigning roles
// ---------------------------------------------------------------------------

test('assigning a role changes what that user can do', async () => {
  const admin = await asAdmin();
  const user = await createUser({ roleId: ROLE.MONITOR });

  const res = await put(`/api/v1/rbac/users/${user.id}/role`, admin).send({ role: 'Trader' });
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));

  const rows = await db.all('SELECT role_id FROM user_roles WHERE user_id = ?', [user.id]);
  assert.strictEqual(rows.length, 1, 'a user must hold exactly one role, not accumulate them');
  assert.strictEqual(rows[0].role_id, ROLE.TRADER);
});

test('assigning an unknown role is refused rather than silently stripping the current one', async () => {
  const admin = await asAdmin();
  const user = await createUser({ roleId: ROLE.TRADER });

  const res = await put(`/api/v1/rbac/users/${user.id}/role`, admin).send({ role: 'Wizard' });
  assert.ok(res.status >= 400 && res.status < 500, `expected a client error, got ${res.status}`);

  const rows = await db.all('SELECT role_id FROM user_roles WHERE user_id = ?', [user.id]);
  assert.deepStrictEqual(rows.map((r) => r.role_id), [ROLE.TRADER], 'the existing role must survive a failed change');
});

test('assigning a role to a user who does not exist is refused', async () => {
  const admin = await asAdmin();
  const res = await put('/api/v1/rbac/users/999999/role', admin).send({ role: 'Trader' });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
});

// ---------------------------------------------------------------------------
// Reshaping roles
// ---------------------------------------------------------------------------

test('changing a role\'s permissions takes effect for its members immediately', async () => {
  const admin = await asAdmin();
  const monitor = await asMonitor();

  // A Monitor cannot manage watchlists to begin with.
  assert.ok(!(monitor.permissions ?? []).includes('watchlists.manage'));

  const res = await put('/api/v1/rbac/roles/Monitor/permissions', admin)
    .send({ permissions: ['pages.dashboard.view', 'watchlists.manage'] });
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));

  const granted = await db.all(
    `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    [ROLE.MONITOR]
  );
  const keys = granted.map((g) => g.key).sort();
  assert.deepStrictEqual(keys, ['pages.dashboard.view', 'watchlists.manage'],
    'the new set must replace the old one, not merge with it');
});

test('an unknown permission key cannot be granted', async () => {
  const admin = await asAdmin();

  const res = await put('/api/v1/rbac/roles/Monitor/permissions', admin)
    .send({ permissions: ['pages.dashboard.view', 'permissions.that.do.not.exist'] });

  const granted = await db.all(
    `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    [ROLE.MONITOR]
  );
  assert.ok(!granted.some((g) => g.key === 'permissions.that.do.not.exist'),
    'a made-up permission must never end up in role_permissions');
  assert.ok(res.status < 500, `got ${res.status}`);
});

test('reshaping a role that does not exist is refused', async () => {
  const admin = await asAdmin();
  const res = await put('/api/v1/rbac/roles/NoSuchRole/permissions', admin).send({ permissions: [] });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
});

test('a non-array permissions payload does not crash or wipe the role', async () => {
  const admin = await asAdmin();

  for (const permissions of ['settings.manage', { key: 'x' }, 42, null]) {
    const res = await put('/api/v1/rbac/roles/Monitor/permissions', admin).send({ permissions });
    assert.ok(res.status < 500, `${JSON.stringify(permissions)} -> ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test('an admin reset replaces the password and the old one stops working', async () => {
  const admin = await asAdmin();
  const user = await createUser({ roleId: ROLE.TRADER, password: 'the-original-password' });

  const res = await post(`/api/v1/rbac/users/${user.id}/reset-password`, admin)
    .send({ newPassword: 'the-reset-password' });
  assert.strictEqual(res.status, STATUS.OK, JSON.stringify(res.body));

  const withNew = await request(loginApp).post('/api/v1/auth/login')
    .send({ email: user.email, password: 'the-reset-password' });
  assert.strictEqual(withNew.status, STATUS.OK);

  const withOld = await request(loginApp).post('/api/v1/auth/login')
    .send({ email: user.email, password: 'the-original-password' });
  assert.strictEqual(withOld.status, STATUS.UNAUTHORIZED);
});

test('a reset rejects a weak password and an unknown user', async () => {
  const admin = await asAdmin();
  const user = await createUser({ roleId: ROLE.TRADER, password: 'the-original-password' });

  assert.strictEqual((await post(`/api/v1/rbac/users/${user.id}/reset-password`, admin)
    .send({ newPassword: 'short' })).status, STATUS.BAD_REQUEST);

  const unknown = await post('/api/v1/rbac/users/999999/reset-password', admin)
    .send({ newPassword: 'a-long-enough-password' });
  assert.ok(unknown.status >= 400 && unknown.status < 500, `got ${unknown.status}`);

  const stillOriginal = await request(loginApp).post('/api/v1/auth/login')
    .send({ email: user.email, password: 'the-original-password' });
  assert.strictEqual(stillOriginal.status, STATUS.OK, 'a refused reset must not have changed anything');
});
