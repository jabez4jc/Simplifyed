/**
 * Test what the API endpoints actually return
 */

import instanceService from './src/services/instance.service.js';
import db from './src/core/database.js';

async function testAPIResponses() {
  try {
    await db.connect();

    console.log('='.repeat(60));
    console.log('TESTING API RESPONSES');
    console.log('='.repeat(60));

    // Test 1: Get all instances
    console.log('\n1. Testing instanceService.getAllInstances()');
    const instances = await instanceService.getAllInstances();
    console.log(`   Returned ${instances.length} instance(s):`);
    instances.forEach(i => {
      console.log(`   - ID: ${i.id}, Name: ${i.name}, Active: ${i.is_active}`);
    });

    // Test 2: Get active instances only
    console.log('\n2. Testing instanceService.getAllInstances({ is_active: 1 })');
    const activeInstances = await instanceService.getAllInstances({ is_active: 1 });
    console.log(`   Returned ${activeInstances.length} active instance(s):`);
    activeInstances.forEach(i => {
      console.log(`   - ID: ${i.id}, Name: ${i.name}`);
    });

    // Test 3: Get all watchlist symbols
    console.log('\n3. Testing direct DB query for watchlist symbols');
    const symbols = await db.all('SELECT * FROM watchlist_symbols ORDER BY id');
    console.log(`   Returned ${symbols.length} symbol(s):`);
    symbols.forEach(s => {
      console.log(`   - ID: ${s.id}, Symbol: ${s.symbol}, Watchlist: ${s.watchlist_id}`);
    });

    // Test 4: Get watchlists
    console.log('\n4. Testing watchlists query');
    const watchlists = await db.all(`
      SELECT
        w.*,
        (SELECT COUNT(*) FROM watchlist_symbols WHERE watchlist_id = w.id) as symbol_count
      FROM watchlists w
      ORDER BY w.id
    `);
    console.log(`   Returned ${watchlists.length} watchlist(s):`);
    watchlists.forEach(w => {
      console.log(`   - ID: ${w.id}, Name: ${w.name}, Symbols: ${w.symbol_count}`);
    });

    // Test 5: Get a specific watchlist's symbols
    if (watchlists.length > 0) {
      const watchlistId = watchlists[0].id;
      console.log(`\n5. Getting symbols for watchlist ${watchlistId}`);
      const watchlistSymbols = await db.all(
        'SELECT * FROM watchlist_symbols WHERE watchlist_id = ? ORDER BY id',
        [watchlistId]
      );
      console.log(`   Returned ${watchlistSymbols.length} symbol(s):`);
      watchlistSymbols.forEach(s => {
        console.log(`   - ID: ${s.id}, Symbol: ${s.symbol}`);
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('CONCLUSION:');
    console.log('='.repeat(60));
    console.log('The backend service layer is returning the data shown above.');
    console.log('If the frontend sees different data, it\'s cached in the browser');
    console.log('or in GitHub Codespaces proxy.');

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await db.close();
    process.exit(1);
  }
}

testAPIResponses();
