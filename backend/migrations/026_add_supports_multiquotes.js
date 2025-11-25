/**
 * Migration 026 - Add supports_multiquotes flag to instances
 */

export const version = '026';
export const name = 'add_supports_multiquotes';

export const up = async (db) => {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN supports_multiquotes INTEGER DEFAULT 0
  `);
};

export const down = async () => {
  console.warn('Down migration 026 not implemented (would require table rebuild)');
};
