/**
 * Add NIFTY symbol to match what the browser is expecting
 */

import db from './src/core/database.js';

async function addNiftySymbol() {
  try {
    await db.connect();

    console.log('Checking existing symbols...');
    const existingSymbols = await db.all('SELECT * FROM watchlist_symbols ORDER BY id');
    console.log(`Found ${existingSymbols.length} existing symbols:`);
    existingSymbols.forEach(s => {
      console.log(`  - ID: ${s.id}, Symbol: ${s.symbol}`);
    });

    // Check if NIFTY already exists
    const nifty = existingSymbols.find(s => s.symbol === 'NIFTY');
    if (nifty) {
      console.log(`\n✅ NIFTY already exists with ID: ${nifty.id}`);
      await db.close();
      return;
    }

    // Get the watchlist ID
    const watchlist = await db.get('SELECT * FROM watchlists LIMIT 1');
    if (!watchlist) {
      console.log('\n❌ No watchlist found! Create a watchlist first.');
      await db.close();
      return;
    }

    console.log(`\nAdding NIFTY to watchlist ${watchlist.id} (${watchlist.name})...`);

    // Insert NIFTY symbol
    await db.run(`
      INSERT INTO watchlist_symbols (
        watchlist_id,
        symbol,
        exchange,
        symbol_type,
        lot_size,
        options_strike_selection,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      watchlist.id,
      'NIFTY',
      'NSE_INDEX',
      'INDEX',
      1,
      'ATM'
    ]);

    console.log('✅ NIFTY symbol added!');

    // Get the new symbol ID
    const newSymbol = await db.get('SELECT * FROM watchlist_symbols WHERE symbol = "NIFTY"');
    console.log(`   New symbol ID: ${newSymbol.id}`);

    console.log('\nAll symbols now:');
    const allSymbols = await db.all('SELECT * FROM watchlist_symbols ORDER BY id');
    allSymbols.forEach(s => {
      console.log(`  - ID: ${s.id}, Symbol: ${s.symbol}, Exchange: ${s.exchange}`);
    });

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await db.close();
    process.exit(1);
  }
}

addNiftySymbol();
