/**
 * One-off CLI to set a local password on an EXISTING user (e.g. a Supabase-provisioned
 * account being cut over to local auth). Never creates a user - use the "Create User" UI
 * (Settings > Access Control) for that. CLI-only, no HTTP route, so it can't be reached
 * over the network.
 *
 * Usage: node scripts/set-user-password.js <email> <password>
 */

import db from '../src/core/database.js';
import { hashPassword } from '../src/middleware/auth.js';

async function main() {
  const [, , email, password] = process.argv;

  if (!email || !password) {
    console.log('Usage: node scripts/set-user-password.js <email> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  await db.connect();
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await db.get('SELECT id, email FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) {
      console.error(`No user found with email: ${normalizedEmail}`);
      process.exit(1);
    }

    const passwordHash = await hashPassword(password);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);

    console.log(`Password set for ${user.email} (user id ${user.id}).`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('Failed to set password:', error.message);
  process.exit(1);
});
