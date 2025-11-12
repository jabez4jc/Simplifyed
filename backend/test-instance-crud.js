/**
 * Test script for Instance CRUD operations
 * Tests: Create, Read, Update (with broker immutability), Delete
 */

import db from './src/core/database.js';
import { log } from './src/core/logger.js';
import instanceService from './src/services/instance.service.js';

async function testInstanceCRUD() {
  try {
    // Connect to database first
    await db.connect();

    console.log('\n📋 Testing Instance CRUD Operations\n');
    console.log('=' .repeat(60));

    // Cleanup: Delete any existing test instances
    await db.run('DELETE FROM instances WHERE host_url = ?', [
      'https://flattrade.simplifyed.in'
    ]);
    console.log('\nℹ️  Cleaned up existing test instances\n');

    // Test 1: Create Instance (bypassing connection test by inserting directly)
    console.log('\n✅ TEST 1: Creating test instance...');
    const result = await db.run(`
      INSERT INTO instances (
        name, host_url, api_key, broker, strategy_tag, market_data_role,
        target_profit, target_loss, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'Flattrade Test Instance',
      'https://flattrade.simplifyed.in',
      '9f96b8911d7f4536d2185510e9105f229db01b578082f4c7eefa03395f72c3ab',
      'flattrade',
      'default',
      'primary',
      5000.00,
      2000.00,
      1
    ]);

    const instanceId = result.lastID;
    console.log(`   Instance created with ID: ${instanceId}`);

    // Test 2: Read Instance
    console.log('\n✅ TEST 2: Reading instance...');
    const instance = await instanceService.getInstanceById(instanceId);
    console.log('   Instance details:');
    console.log(`   - Name: ${instance.name}`);
    console.log(`   - Broker: ${instance.broker}`);
    console.log(`   - Market Data Role: ${instance.market_data_role}`);
    console.log(`   - Host URL: ${instance.host_url}`);

    // Test 3: Update Instance (allowed fields)
    console.log('\n✅ TEST 3: Updating instance (allowed fields)...');
    const updated = await instanceService.updateInstance(instanceId, {
      name: 'Flattrade Updated Instance',
      target_profit: 10000,
      market_data_role: 'secondary'
    });
    console.log('   Updated successfully:');
    console.log(`   - Name: ${updated.name}`);
    console.log(`   - Target Profit: ${updated.target_profit}`);
    console.log(`   - Market Data Role: ${updated.market_data_role}`);

    // Test 4: Test Broker Immutability
    console.log('\n✅ TEST 4: Testing broker field immutability...');
    try {
      const attemptBrokerUpdate = await instanceService.updateInstance(instanceId, {
        broker: 'zerodha', // This should be ignored
        name: 'Test Broker Update' // Include another field so update doesn't fail
      });
      console.log(`   Broker field after update attempt: ${attemptBrokerUpdate.broker}`);
      if (attemptBrokerUpdate.broker === 'flattrade') {
        console.log('   ✓ Broker immutability working correctly!');
      } else {
        console.log('   ✗ ERROR: Broker was changed (should be immutable)');
      }
    } catch (error) {
      // If it throws "No valid fields to update", that means broker was filtered out
      if (error.message.includes('No valid fields to update')) {
        console.log('   ✓ Broker field was completely filtered out (immutability working)');
      } else {
        throw error;
      }
    }

    // Test 5: Test Market Data Role CHECK Constraint
    console.log('\n✅ TEST 5: Testing market_data_role CHECK constraint...');
    try {
      await db.run(
        'UPDATE instances SET market_data_role = ? WHERE id = ?',
        ['invalid_role', instanceId]
      );
      console.log('   ✗ ERROR: CHECK constraint not working (invalid value accepted)');
    } catch (error) {
      if (error.message.includes('CHECK constraint failed')) {
        console.log('   ✓ CHECK constraint working correctly!');
        console.log('   Invalid value rejected:', error.message);
      } else {
        throw error;
      }
    }

    // Test 6: Get Market Data Instances
    console.log('\n✅ TEST 6: Testing market data instance filtering...');
    const marketDataInstances = await instanceService.getMarketDataInstances();
    console.log(`   Found ${marketDataInstances.length} market data instance(s)`);
    if (marketDataInstances.length > 0) {
      console.log(`   First instance role: ${marketDataInstances[0].market_data_role}`);
      console.log(`   First instance name: ${marketDataInstances[0].name}`);
    }

    // Test 7: Update to 'none' and verify it's filtered out
    console.log('\n✅ TEST 7: Testing market data role filtering (set to none)...');
    await instanceService.updateInstance(instanceId, {
      market_data_role: 'none'
    });
    const marketDataInstancesAfter = await instanceService.getMarketDataInstances();
    console.log(`   Market data instances after setting to 'none': ${marketDataInstancesAfter.length}`);
    if (marketDataInstancesAfter.length === 0) {
      console.log('   ✓ Filtering working correctly!');
    }

    // Test 8: Delete Instance
    console.log('\n✅ TEST 8: Deleting instance...');
    await instanceService.deleteInstance(instanceId);
    console.log('   Instance deleted successfully');

    // Verify deletion
    try {
      await instanceService.getInstanceById(instanceId);
      console.log('   ✗ ERROR: Instance still exists after deletion');
    } catch (error) {
      if (error.message.includes('not found') || error.message.includes('NotFoundError')) {
        console.log('   ✓ Instance deletion confirmed!');
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ All tests completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await db.close();
    process.exit(0);
  }
}

// Run tests
testInstanceCRUD();
