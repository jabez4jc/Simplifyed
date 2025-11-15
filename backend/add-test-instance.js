/**
 * Add test instance to database
 * Usage: TEST_API_KEY=your_api_key node add-test-instance.js
 *
 * Environment Variables:
 *   TEST_API_KEY - API key for the test instance (required)
 *   TEST_HOST_URL - Host URL (default: https://flattrade.simplifyed.in)
 *   TEST_INSTANCE_NAME - Instance name (default: Flattrade Test)
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';

async function addTestInstance() {
  try {
    // Validate required environment variables
    const apiKey = process.env.TEST_API_KEY;
    if (!apiKey) {
      console.error('❌ Error: TEST_API_KEY environment variable is required');
      console.error('Usage: TEST_API_KEY=your_api_key node add-test-instance.js');
      process.exit(1);
    }

    const hostUrl = process.env.TEST_HOST_URL || 'https://flattrade.simplifyed.in';
    const instanceName = process.env.TEST_INSTANCE_NAME || 'Flattrade Test';

    await db.connect();
    log.info('Database connected');

    // Check if instance already exists
    const existing = await db.get(
      'SELECT * FROM instances WHERE host_url = ?',
      [hostUrl]
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
        instanceName,
        hostUrl,
        apiKey,
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
