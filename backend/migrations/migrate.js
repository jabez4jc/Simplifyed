/**
 * Database Migration Runner
 * Handles up/down migrations with tracking
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';
import db from '../src/core/database.js';
import { log } from '../src/core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Initialize migration tracking table
 */
async function initMigrationTable() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Get all applied migrations
 */
async function getAppliedMigrations() {
  const rows = await db.all(
    'SELECT version FROM schema_migrations ORDER BY version ASC'
  );
  return new Set(rows.map((row) => row.version));
}

/**
 * Load all migration files
 */
async function loadMigrations() {
  const files = readdirSync(__dirname).filter((file) =>
    /^\d{3}_.*\.js$/.test(file)
  );

  const migrations = [];

  for (const file of files) {
    const migration = await import(join(__dirname, file));
    migrations.push({
      file,
      version: migration.version,
      name: migration.name,
      up: migration.up,
      down: migration.down,
    });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Run migrations up
 */
async function migrateUp() {
  try {
    await db.connect();
    await initMigrationTable();

    const appliedMigrations = await getAppliedMigrations();
    const allMigrations = await loadMigrations();

    const pendingMigrations = allMigrations.filter(
      (m) => !appliedMigrations.has(m.version)
    );

    if (pendingMigrations.length === 0) {
      log.info('✅ Database is up to date (no pending migrations)');
      return;
    }

    log.info(`🔄 Running ${pendingMigrations.length} migration(s)...`);

    for (const migration of pendingMigrations) {
      log.info(`  ⬆️  Applying: ${migration.name}`);

      try {
        await migration.up(db);

        await db.run(
          'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
          [migration.version, migration.name]
        );

        log.info(`  ✅ Applied: ${migration.name}`);
      } catch (error) {
        log.error(`  ❌ Failed: ${migration.name}`, error);
        throw error;
      }
    }

    log.info(`✅ Applied ${pendingMigrations.length} migration(s)`);
  } catch (error) {
    log.error('Migration failed', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

/**
 * Rollback last migration
 */
async function migrateDown() {
  try {
    await db.connect();
    await initMigrationTable();

    const appliedMigrations = await db.all(
      'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );

    if (appliedMigrations.length === 0) {
      log.info('⚠️  No migrations to rollback');
      return;
    }

    const lastMigration = appliedMigrations[0];
    const allMigrations = await loadMigrations();
    const migration = allMigrations.find((m) => m.version === lastMigration.version);

    if (!migration) {
      log.error(`Migration file not found for version: ${lastMigration.version}`);
      process.exit(1);
    }

    log.info(`🔄 Rolling back: ${migration.name}`);

    try {
      if (!migration.down) {
        throw new Error('Migration has no down() method - cannot rollback');
      }

      await migration.down(db);

      await db.run('DELETE FROM schema_migrations WHERE version = ?', [
        migration.version,
      ]);

      log.info(`✅ Rolled back: ${migration.name}`);
    } catch (error) {
      log.error(`❌ Rollback failed: ${migration.name}`, error);
      throw error;
    }
  } catch (error) {
    log.error('Rollback failed', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

/**
 * Show migration status
 */
async function showStatus() {
  try {
    await db.connect();
    await initMigrationTable();

    const appliedMigrations = await getAppliedMigrations();
    const allMigrations = await loadMigrations();

    console.log('\n📊 Migration Status:\n');
    console.log('  Applied Migrations:');

    for (const migration of allMigrations) {
      const isApplied = appliedMigrations.has(migration.version);
      const status = isApplied ? '✅' : '⏳';
      console.log(`  ${status} [${migration.version}] ${migration.name}`);
    }

    const pendingCount = allMigrations.filter(
      (m) => !appliedMigrations.has(m.version)
    ).length;

    console.log(`\n  Total: ${allMigrations.length} migrations`);
    console.log(`  Applied: ${appliedMigrations.size}`);
    console.log(`  Pending: ${pendingCount}\n`);
  } catch (error) {
    log.error('Failed to show status', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Parse command line arguments
const command = process.argv[2] || 'up';

switch (command) {
  case 'up':
    migrateUp();
    break;
  case 'down':
  case 'rollback':
    migrateDown();
    break;
  case 'status':
    showStatus();
    break;
  default:
    console.log('Usage: node migrate.js [up|down|status]');
    process.exit(1);
}
