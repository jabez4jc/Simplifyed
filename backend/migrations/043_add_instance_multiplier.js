export const version = '043';
export const name = 'add_instance_multiplier';

export async function up(db) {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN multiplier INTEGER DEFAULT 1 CHECK (multiplier >= 1 AND multiplier <= 999)
  `);
}

export async function down(db) {
  console.warn('  ⚠️  Rollback for Migration 043 is not implemented (requires manual update)');
}
