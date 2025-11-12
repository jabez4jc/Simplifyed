/**
 * Comprehensive diagnostic: Check database state, API responses, and fix mismatches
 */

import db from './src/core/database.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function comprehensiveDiagnostic() {
  try {
    await db.connect();

    console.log('='.repeat(60));
    console.log('COMPREHENSIVE DIAGNOSTIC');
    console.log('='.repeat(60));

    // 1. Check database file location
    console.log('\n1. DATABASE FILE LOCATION:');
    console.log(`   Expected: ${path.join(__dirname, 'database', 'simplifyed.db')}`);
    console.log(`   Check if DATABASE_PATH env var is set differently`);

    // 2. Check all instances
    console.log('\n2. ALL INSTANCES IN DATABASE:');
    const instances = await db.all('SELECT * FROM instances ORDER BY id');
    if (instances.length === 0) {
      console.log('   ❌ NO INSTANCES FOUND!');
    } else {
      instances.forEach(i => {
        console.log(`   - ID: ${i.id}, Name: "${i.name}", Active: ${i.is_active}, Host: ${i.host_url}`);
      });
    }

    // 3. Check all watchlists
    console.log('\n3. ALL WATCHLISTS:');
    const watchlists = await db.all('SELECT * FROM watchlists ORDER BY id');
    if (watchlists.length === 0) {
      console.log('   ❌ NO WATCHLISTS FOUND!');
    } else {
      watchlists.forEach(w => {
        console.log(`   - ID: ${w.id}, Name: "${w.name}"`);
      });
    }

    // 4. Check ALL symbols across ALL watchlists
    console.log('\n4. ALL SYMBOLS IN DATABASE:');
    const allSymbols = await db.all('SELECT * FROM watchlist_symbols ORDER BY id');
    if (allSymbols.length === 0) {
      console.log('   ❌ NO SYMBOLS FOUND!');
    } else {
      allSymbols.forEach(s => {
        console.log(`   - ID: ${s.id}, Symbol: "${s.symbol}", Exchange: ${s.exchange}, Watchlist: ${s.watchlist_id}`);
      });
    }

    // 5. Check if symbolId 1 exists
    console.log('\n5. CHECK IF SYMBOL ID 1 EXISTS:');
    const symbol1 = await db.get('SELECT * FROM watchlist_symbols WHERE id = 1');
    if (symbol1) {
      console.log(`   ✅ Symbol ID 1 EXISTS: ${symbol1.symbol} (${symbol1.exchange}) in watchlist ${symbol1.watchlist_id}`);
    } else {
      console.log(`   ❌ Symbol ID 1 DOES NOT EXIST`);
    }

    // 6. Check if instance ID 2 exists
    console.log('\n6. CHECK IF INSTANCE ID 2 EXISTS:');
    const instance2 = await db.get('SELECT * FROM instances WHERE id = 2');
    if (instance2) {
      console.log(`   ✅ Instance ID 2 EXISTS: ${instance2.name} (${instance2.host_url})`);
    } else {
      console.log(`   ❌ Instance ID 2 DOES NOT EXIST`);
    }

    // 7. Check watchlist-instance assignments
    console.log('\n7. WATCHLIST-INSTANCE ASSIGNMENTS:');
    const assignments = await db.all(`
      SELECT wi.*, w.name as watchlist_name, i.name as instance_name
      FROM watchlist_instances wi
      JOIN watchlists w ON wi.watchlist_id = w.id
      JOIN instances i ON wi.instance_id = i.id
      ORDER BY wi.watchlist_id, wi.instance_id
    `);
    if (assignments.length === 0) {
      console.log('   ❌ NO ASSIGNMENTS!');
    } else {
      assignments.forEach(a => {
        console.log(`   - Watchlist ${a.watchlist_id} (${a.watchlist_name}) → Instance ${a.instance_id} (${a.instance_name})`);
      });
    }

    // 8. Summary and recommendations
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY & RECOMMENDATIONS:');
    console.log('='.repeat(60));

    if (!symbol1 && allSymbols.length > 0) {
      console.log('\n⚠️  ISSUE: Browser expects symbolId=1 but it doesn\'t exist');
      console.log('   Solution: Clear browser cache completely OR add a symbol with ID 1');
      console.log(`   Available symbol IDs: ${allSymbols.map(s => s.id).join(', ')}`);
    }

    if (!instance2 && instances.length > 0) {
      console.log('\n⚠️  ISSUE: Frontend expects instance ID=2 but it doesn\'t exist');
      console.log('   Solution: Clear browser cache completely');
      console.log(`   Available instance IDs: ${instances.map(i => i.id).join(', ')}`);
    }

    if (assignments.length === 0 && watchlists.length > 0 && instances.length > 0) {
      console.log('\n⚠️  ISSUE: No instances assigned to watchlists');
      console.log('   Solution: Run assignment script');
    }

    console.log('\n✅ Diagnostic complete!');

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await db.close();
    process.exit(1);
  }
}

comprehensiveDiagnostic();
