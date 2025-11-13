/**
 * Check which watchlist a symbol belongs to
 */

import db from './src/core/database.js';

async function checkSymbol() {
  try {
    await db.connect();

    const symbolId = 1;

    console.log(`Checking symbolId ${symbolId}...`);

    const symbol = await db.get(`
      SELECT ws.*, w.name as watchlist_name, w.id as watchlist_id
      FROM watchlist_symbols ws
      JOIN watchlists w ON ws.watchlist_id = w.id
      WHERE ws.id = ?
    `, [symbolId]);

    if (!symbol) {
      console.log(`❌ Symbol ${symbolId} not found!`);
      await db.close();
      return;
    }

    console.log(`✅ Symbol found:`);
    console.log(`   Symbol ID: ${symbol.id}`);
    console.log(`   Symbol: ${symbol.symbol}`);
    console.log(`   Exchange: ${symbol.exchange}`);
    console.log(`   Watchlist ID: ${symbol.watchlist_id}`);
    console.log(`   Watchlist Name: ${symbol.watchlist_name}`);

    console.log(`\nChecking if watchlist ${symbol.watchlist_id} has instances assigned...`);

    const assignments = await db.all(`
      SELECT wi.*, i.name as instance_name, i.is_active
      FROM watchlist_instances wi
      JOIN instances i ON wi.instance_id = i.id
      WHERE wi.watchlist_id = ?
    `, [symbol.watchlist_id]);

    if (assignments.length === 0) {
      console.log(`❌ Watchlist ${symbol.watchlist_id} (${symbol.watchlist_name}) has NO instances assigned!`);
      console.log(`\n🔧 Fix: Run this command:`);
      console.log(`   node backend/assign-instance-to-all-watchlists.js`);
    } else {
      console.log(`✅ Watchlist ${symbol.watchlist_id} (${symbol.watchlist_name}) has ${assignments.length} instance(s):`);
      assignments.forEach(a => {
        console.log(`   - Instance ${a.instance_id} (${a.instance_name}), Active: ${a.is_active}`);
      });

      const activeCount = assignments.filter(a => a.is_active === 1).length;
      if (activeCount === 0) {
        console.log(`\n⚠️  No ACTIVE instances! Activate an instance first.`);
      } else {
        console.log(`\n✅ ${activeCount} active instance(s) ready for order placement.`);
        console.log(`\n🔧 If still getting errors, restart backend server:`);
        console.log(`   cd backend && npm run dev`);
      }
    }

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    await db.close();
  }
}

checkSymbol();
