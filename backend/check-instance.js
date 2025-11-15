/**
 * Check instance configuration
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';

async function checkInstance() {
  try {
    await db.connect();

    const instances = await db.all(
      'SELECT id, name, broker, market_data_role, is_primary_admin, is_secondary_admin FROM instances WHERE is_active = 1'
    );

    console.log('\n=== Active Instances ===');
    console.log(JSON.stringify(instances, null, 2));

    // Check instruments count
    const instrumentsCount = await db.get('SELECT COUNT(*) as count FROM instruments');
    console.log('\n=== Instruments Count ===');
    console.log(`Total instruments: ${instrumentsCount.count}`);

    // Check sample instrument with brexchange
    const sample = await db.get('SELECT * FROM instruments WHERE brexchange IS NOT NULL LIMIT 1');
    console.log('\n=== Sample Instrument (with brexchange) ===');
    console.log(JSON.stringify(sample, null, 2));

    // Check sample without brexchange
    const sampleNull = await db.get('SELECT * FROM instruments WHERE brexchange IS NULL LIMIT 1');
    console.log('\n=== Sample Instrument (brexchange NULL) ===');
    console.log(JSON.stringify(sampleNull, null, 2));

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkInstance();
