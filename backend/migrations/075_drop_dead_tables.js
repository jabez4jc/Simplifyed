/**
 * Migration 075: drop dead tables and settings (audit Phase 2)
 *
 * - instance_health_tests setting (D12): the endpoint probes are constants now.
 */

export const version = '075';
export const name = 'drop_dead_tables';

export async function up(db) {
  await db.run("DELETE FROM application_settings WHERE key = 'instance_health_tests'");
}

export async function down() {
  // Nothing to restore: nothing reads or writes these any more.
}
