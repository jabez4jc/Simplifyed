/**
 * Clear instruments to trigger fresh fetch
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';

async function clearInstruments() {
  try {
    await db.connect();

    // Wrap DELETE operations in a transaction for atomicity
    await db.transaction(async () => {
      // Delete all instruments
      await db.run('DELETE FROM instruments');
      console.log('✅ Cleared all instruments');

      // Delete refresh log to force a fresh fetch
      await db.run('DELETE FROM instruments_refresh_log');
      console.log('✅ Cleared refresh log');
    });

    // Verify
    const count = await db.get('SELECT COUNT(*) as count FROM instruments');
    console.log(`Instruments count: ${count.count}`);

    await db.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

clearInstruments();
