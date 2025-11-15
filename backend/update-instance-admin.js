/**
 * Update instance to be primary admin
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';

async function updateInstance() {
  try {
    await db.connect();

    // Update instance to be primary admin
    await db.run(
      'UPDATE instances SET is_primary_admin = 1 WHERE id = 1'
    );

    console.log('✅ Updated instance to be primary admin');

    // Verify
    const instance = await db.get(
      'SELECT id, name, is_primary_admin, is_secondary_admin FROM instances WHERE id = 1'
    );
    console.log('Instance status:', instance);

    await db.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

updateInstance();
