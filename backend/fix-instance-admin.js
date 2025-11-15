/**
 * Fix instance admin configuration
 * Marks the first active instance as primary admin
 * Usage: node fix-instance-admin.js
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';

async function fixInstanceAdmin() {
  try {
    await db.connect();

    // Check current instances
    const instances = await db.all(
      'SELECT id, name, is_active, is_primary_admin, is_secondary_admin, health_status FROM instances'
    );

    console.log('\n=== Current Instances ===');
    instances.forEach(inst => {
      console.log(`ID ${inst.id}: ${inst.name}`);
      console.log(`  Active: ${inst.is_active}, Health: ${inst.health_status}`);
      console.log(`  Primary Admin: ${inst.is_primary_admin}, Secondary Admin: ${inst.is_secondary_admin}`);
    });

    // Find active instances
    const activeInstances = instances.filter(inst => inst.is_active === 1);

    if (activeInstances.length === 0) {
      console.log('\n❌ No active instances found!');
      console.log('Please add an instance first or activate an existing one.');
      await db.close();
      return;
    }

    // Check if we already have admin instances
    const hasAdmin = instances.some(inst => inst.is_primary_admin === 1 || inst.is_secondary_admin === 1);

    if (hasAdmin) {
      console.log('\n✅ Admin instances already configured:');
      instances.filter(inst => inst.is_primary_admin === 1 || inst.is_secondary_admin === 1).forEach(inst => {
        const role = inst.is_primary_admin === 1 ? 'Primary Admin' : 'Secondary Admin';
        console.log(`  - ${inst.name} (ID: ${inst.id}) - ${role}`);
      });
      await db.close();
      return;
    }

    // No admin instances - mark the first active instance as primary admin
    const firstActive = activeInstances[0];

    console.log(`\n⚙️  Setting "${firstActive.name}" (ID: ${firstActive.id}) as primary admin...`);

    await db.run(
      'UPDATE instances SET is_primary_admin = 1 WHERE id = ?',
      [firstActive.id]
    );

    console.log('✅ Instance updated successfully!');
    console.log(`\n"${firstActive.name}" is now the primary admin instance.`);
    console.log('This instance will be used for fetching instruments data.');

    await db.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

fixInstanceAdmin();
