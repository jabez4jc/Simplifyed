/**
 * Migration 075: drop dead tables and settings (audit Phase 2)
 *
 * - instance_health_tests setting (D12): the endpoint probes are constants now.
 * - expiry_calendar (D16): write-only; nearest expiry comes from the instruments table.
 * - symbol_cache (D17): duplicated `instruments` and could serve expired contracts.
 */

export const version = '075';
export const name = 'drop_dead_tables';

export async function up(db) {
  await db.run("DELETE FROM application_settings WHERE key = 'instance_health_tests'");
  await db.run('DROP TABLE IF EXISTS expiry_calendar');
  await db.run('DROP TABLE IF EXISTS symbol_cache');
}

export async function down() {
  // Nothing to restore: nothing reads or writes these any more.
}
