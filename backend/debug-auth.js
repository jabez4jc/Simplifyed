import db from './src/core/database.js';

async function debugAuth() {
  try {
    await db.connect();

    console.log('\n=== ALL USERS ===');
    const users = await db.all('SELECT * FROM users ORDER BY id');
    console.table(users);

    console.log('\n=== USER ROLES ===');
    const userRoles = await db.all(`
      SELECT
        ur.user_id,
        u.email,
        u.is_admin,
        r.id as role_id,
        r.name as role_name,
        ur.assigned_at
      FROM user_roles ur
      JOIN users u ON ur.user_id = u.id
      JOIN roles r ON ur.role_id = r.id
      ORDER BY ur.user_id
    `);
    console.table(userRoles);

    console.log('\n=== USERS WITHOUT ROLES ===');
    const usersWithoutRoles = await db.all(`
      SELECT u.id, u.email, u.is_admin, u.created_at
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      WHERE ur.user_id IS NULL
    `);
    console.table(usersWithoutRoles);

    console.log('\n=== ADMIN ROLE PERMISSIONS (sample) ===');
    const adminPerms = await db.all(`
      SELECT p.key, p.description
      FROM role_permissions rp
      JOIN permissions p ON rp.permission_id = p.id
      JOIN roles r ON rp.role_id = r.id
      WHERE r.name = 'Admin'
      LIMIT 10
    `);
    console.table(adminPerms);

    console.log('\n=== SETTINGS COUNT ===');
    const settingsCount = await db.get('SELECT COUNT(*) as count FROM application_settings');
    console.log('Total settings:', settingsCount.count);

    await db.close();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

debugAuth();
