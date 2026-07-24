import assert from 'assert';
import test from 'node:test';
import db from '../../src/core/database.js';
import rbacService from '../../src/services/rbac.service.js';

const TEST_EMAIL = 'rbac-service-test-user@example.com';

async function cleanup() {
  const user = await db.get('SELECT id FROM users WHERE email = ?', [TEST_EMAIL]);
  if (user) {
    await db.run('DELETE FROM user_roles WHERE user_id = ?', [user.id]);
    await db.run('DELETE FROM users WHERE id = ?', [user.id]);
  }
}

test('RbacService.createUser creates a user and assigns the given role', async () => {
  await db.connect();
  await cleanup();
  try {
    const result = await rbacService.createUser(TEST_EMAIL, 'a-real-password-123', 'Monitor', null);
    assert.equal(result.email, TEST_EMAIL);
    assert.equal(result.role, 'Monitor');

    const row = await db.get(
      `SELECT u.password_hash, r.name as role
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = ?`,
      [result.id]
    );
    assert.ok(row.password_hash, 'password_hash should be set');
    assert.equal(row.role, 'Monitor');
  } finally {
    await cleanup();
  }
});

test('RbacService.createUser rejects a duplicate email', async () => {
  await db.connect();
  await cleanup();
  try {
    await rbacService.createUser(TEST_EMAIL, 'a-real-password-123', 'Monitor', null);
    await assert.rejects(
      () => rbacService.createUser(TEST_EMAIL, 'another-password-456', 'Trader', null),
      /already exists/
    );
  } finally {
    await cleanup();
  }
});

test('RbacService.resetPassword updates the password hash and rejects an unknown user', async () => {
  await db.connect();
  await cleanup();
  try {
    const created = await rbacService.createUser(TEST_EMAIL, 'original-password-1', 'Monitor', null);
    const before = await db.get('SELECT password_hash FROM users WHERE id = ?', [created.id]);

    await rbacService.resetPassword(created.id, 'a-new-password-2');
    const after = await db.get('SELECT password_hash FROM users WHERE id = ?', [created.id]);
    assert.notEqual(after.password_hash, before.password_hash);

    await assert.rejects(() => rbacService.resetPassword(999999999, 'whatever-password'), /not found/);
  } finally {
    await cleanup();
  }
});
