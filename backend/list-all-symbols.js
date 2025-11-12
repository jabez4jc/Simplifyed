/**
 * List all symbols in all watchlists
 */

import db from './src/core/database.js';

async function listSymbols() {
  try {
    await db.connect();

    console.log('Fetching all watchlists...');
    const watchlists = await db.all('SELECT * FROM watchlists');

    console.log(`Found ${watchlists.length} watchlist(s)\n`);

    for (const watchlist of watchlists) {
      console.log(`📋 Watchlist ${watchlist.id}: ${watchlist.name}`);

      const symbols = await db.all(`
        SELECT * FROM watchlist_symbols
        WHERE watchlist_id = ?
        ORDER BY id
      `, [watchlist.id]);

      if (symbols.length === 0) {
        console.log(`   ⚠️  No symbols in this watchlist!`);
      } else {
        console.log(`   Found ${symbols.length} symbol(s):`);
        symbols.forEach(s => {
          console.log(`   - ID: ${s.id}, Symbol: ${s.symbol}, Exchange: ${s.exchange}, Type: ${s.symbol_type || 'N/A'}`);
        });
      }

      console.log('');
    }

    console.log('=== Summary ===');
    const totalSymbols = await db.get('SELECT COUNT(*) as count FROM watchlist_symbols');
    console.log(`Total symbols across all watchlists: ${totalSymbols.count}`);

    if (totalSymbols.count === 0) {
      console.log('\n⚠️  No symbols found! You need to add symbols to your watchlists first.');
      console.log('\n🔧 How to add symbols:');
      console.log('   1. Go to the dashboard');
      console.log('   2. Click on a watchlist');
      console.log('   3. Use "Add Symbol" to add symbols');
    }

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    await db.close();
  }
}

listSymbols();
