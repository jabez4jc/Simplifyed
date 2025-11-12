/**
 * Assign instance to ALL watchlists
 * Run with: node assign-instance-to-all-watchlists.js
 */

import db from './src/core/database.js';

async function assignInstanceToAllWatchlists() {
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
    const instances = await db.all('SELECT * FROM instances WHERE is_active = 1');
    console.log(`Found ${instances.length} active instance(s):`);
    instances.forEach(i => {
      console.log(`  - ID: ${i.id}, Name: ${i.name}`);
    });

    if (watchlists.length === 0) {
      console.log('\n⚠️  No watchlists found!');
      await db.close();
      return;
    }

    if (instances.length === 0) {
      console.log('\n⚠️  No active instances found!');
      await db.close();
      return;
    }

    console.log('\n=== Assigning instances to ALL watchlists ===');

    let assignedCount = 0;
    let skippedCount = 0;

    for (const watchlist of watchlists) {
      for (const instance of instances) {
        // Check if already assigned
        const existing = await db.get(
          'SELECT * FROM watchlist_instances WHERE watchlist_id = ? AND instance_id = ?',
          [watchlist.id, instance.id]
        );

        if (existing) {
          console.log(`⏭️  Watchlist ${watchlist.id} (${watchlist.name}) -> Instance ${instance.id} (${instance.name}) [Already exists]`);
          skippedCount++;
        } else {
          await db.run(
            'INSERT INTO watchlist_instances (watchlist_id, instance_id) VALUES (?, ?)',
            [watchlist.id, instance.id]
          );
          console.log(`✅ Watchlist ${watchlist.id} (${watchlist.name}) -> Instance ${instance.id} (${instance.name}) [Created]`);
          assignedCount++;
        }
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`✅ Created: ${assignedCount}`);
    console.log(`⏭️  Skipped: ${skippedCount}`);
    console.log(`📊 Total: ${assignedCount + skippedCount}`);

    console.log('\nVerifying all assignments...');
    const allAssignments = await db.all(`
      SELECT wi.*, w.name as watchlist_name, i.name as instance_name
      FROM watchlist_instances wi
      JOIN watchlists w ON wi.watchlist_id = w.id
      JOIN instances i ON wi.instance_id = i.id
    `);

    console.log(`\nTotal assignments: ${allAssignments.length}`);
    allAssignments.forEach(a => {
      console.log(`  - Watchlist ${a.watchlist_id} (${a.watchlist_name}) → Instance ${a.instance_id} (${a.instance_name})`);
    });

    await db.close();
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    await db.close();
    process.exit(1);
  }
}

assignInstanceToAllWatchlists();
