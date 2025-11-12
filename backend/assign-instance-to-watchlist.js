/**
 * Quick script to assign instance to watchlist
 * Run with: node assign-instance-to-watchlist.js
 */

import db from './src/core/database.js';

async function assignInstanceToWatchlist() {
  try {
    console.log('Connecting to database...');
    await db.connect();

    console.log('Checking watchlists...');
    const watchlists = await db.all('SELECT * FROM watchlists');
    console.log(`Found ${watchlists.length} watchlist(s):`);
    watchlists.forEach(w => {
      console.log(`  - ID: ${w.id}, Name: ${w.name}`);
    });

    console.log('\nChecking instances...');
    const instances = await db.all('SELECT * FROM instances');
    console.log(`Found ${instances.length} instance(s):`);
    instances.forEach(i => {
      console.log(`  - ID: ${i.id}, Name: ${i.name}, Active: ${i.is_active}`);
    });

    console.log('\nChecking current watchlist_instances assignments...');
    const assignments = await db.all('SELECT * FROM watchlist_instances');
    console.log(`Found ${assignments.length} assignment(s):`);
    assignments.forEach(a => {
      console.log(`  - Watchlist ${a.watchlist_id} -> Instance ${a.instance_id}`);
    });

    if (watchlists.length > 0 && instances.length > 0) {
      const watchlistId = watchlists[0].id;
      const instanceId = instances[0].id;

      console.log(`\nAssigning instance ${instanceId} (${instances[0].name}) to watchlist ${watchlistId} (${watchlists[0].name})...`);

      // Check if already assigned
      const existing = await db.get(
        'SELECT * FROM watchlist_instances WHERE watchlist_id = ? AND instance_id = ?',
        [watchlistId, instanceId]
      );

      if (existing) {
        console.log('✅ Already assigned!');
      } else {
        await db.run(
          'INSERT INTO watchlist_instances (watchlist_id, instance_id) VALUES (?, ?)',
          [watchlistId, instanceId]
        );
        console.log('✅ Assignment created!');
      }

      console.log('\nVerifying assignment...');
      const newAssignments = await db.all('SELECT * FROM watchlist_instances');
      console.log(`Total assignments: ${newAssignments.length}`);
      newAssignments.forEach(a => {
        console.log(`  - Watchlist ${a.watchlist_id} -> Instance ${a.instance_id}`);
      });
    } else {
      console.log('\n⚠️  No watchlists or instances found to assign!');
    }

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await db.close();
    process.exit(1);
  }
}

assignInstanceToWatchlist();
