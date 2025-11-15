/**
 * Add test instance to database
 * Usage: node add-test-instance.js
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';

async function addTestInstance() {
  try {
    await db.connect();
    log.info('Database connected');

    // Check if instance already exists
    const existing = await db.get(
      'SELECT * FROM instances WHERE host_url = ?',
      ['https://flattrade.simplifyed.in']
    );

    if (existing) {
      log.info('Test instance already exists', { id: existing.id, name: existing.name });
      console.log(`✅ Instance already exists: ${existing.name} (ID: ${existing.id})`);
      await db.close();
      return;
    }

    // Add new instance
    const result = await db.run(
      `INSERT INTO instances (
        name, host_url, api_key, broker, is_active, market_data_role
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'Flattrade Test',
        'https://flattrade.simplifyed.in',
        'b2a6eaa12fda860966a9b73d12760adcdf9760d67a88babfaa8a49bfb9fa2ff5',
        'flattrade',
        1, // is_active
        'primary' // market_data_role
      ]
    );

    log.info('Test instance added', { id: result.lastID });
    console.log(`✅ Added test instance: Flattrade Test (ID: ${result.lastID})`);

    await db.close();
    log.info('Database closed');
  } catch (error) {
    log.error('Failed to add test instance', error);
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

addTestInstance();
