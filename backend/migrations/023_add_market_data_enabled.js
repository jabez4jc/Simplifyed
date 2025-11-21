/**
 * Migration 023 - Add market_data_enabled flag to instances
 */

export const version = '023';
export const name = 'add_market_data_enabled';

export const up = async (db) => {
  await db.run(`
    ALTER TABLE instances
    ADD COLUMN market_data_enabled INTEGER DEFAULT 0
  `);

  // For existing primary/secondary roles, enable market data by default
  await db.run(`
    UPDATE instances
    SET market_data_enabled = 1
    WHERE market_data_role IN ('primary', 'secondary')
  `);
};

export const down = async () => {
  console.warn('Down migration 023 not implemented (would require table rebuild)');
};
