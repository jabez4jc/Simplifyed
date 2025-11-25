/**
 * Migration 028 - Track per-day session max-loss hit counts
 */

export const version = '028';
export const name = 'instance_session_loss_hits';

export const up = async (db) => {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_max_loss_hits INTEGER DEFAULT 0
  `);

  await db.run(`
    ALTER TABLE instances
    ADD COLUMN session_max_loss_hits_date TEXT
  `);
};

export const down = async () => {
  console.warn('Down migration 028 not implemented (would require table rebuild)');
};
