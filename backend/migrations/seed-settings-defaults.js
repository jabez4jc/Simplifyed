/**
 * Seed Script: Settings Defaults
 * Populates global_defaults and index_profiles with conservative defaults
 *
 * Usage: node migrations/seed-settings-defaults.js
 */

import db from '../src/core/database.js';
import { log } from '../src/core/logger.js';

async function seedGlobalDefaults() {
  console.log('\n📝 Seeding global_defaults...');

  // Check if already seeded
  const existing = await db.get('SELECT * FROM global_defaults WHERE id = 1');
  if (existing) {
    console.log('  ⏭️  Global defaults already exist, skipping');
    return;
  }

  // Insert conservative global defaults
  await db.run(`
    INSERT INTO global_defaults (
      id,
      ltp_refresh_seconds,
      default_strike_policy,
      default_step_lots,
      default_step_contracts,
      tp_per_unit,
      sl_per_unit,
      tsl_enabled,
      tsl_trail_by,
      tsl_step,
      tsl_arm_after,
      tsl_breakeven_after,
      disallow_auto_reverse
    ) VALUES (
      1,
      5,                    -- Refresh quotes every 5 seconds
      'FLOAT_OFS',          -- Default: Floating strike offset (re-resolve each trade)
      1,                    -- 1 lot per click for options
      1,                    -- 1 contract per click for futures/equity
      NULL,                 -- No default TP (user must set)
      NULL,                 -- No default SL (user must set)
      0,                    -- TSL disabled by default (conservative)
      NULL,                 -- No default TSL trail
      NULL,                 -- No default TSL step
      NULL,                 -- No default TSL arm threshold
      NULL,                 -- No default TSL breakeven
      0                     -- Allow auto-reverse (can flip from long to short and vice versa)
    )
  `);

  console.log('  ✅ Global defaults seeded with conservative values');
  console.log('     - No default risk (TP/SL/TSL) - users must configure');
  console.log('     - FLOAT_OFS strike policy for flexibility');
  console.log('     - 1 lot/contract per click for safety');
}

async function seedIndexProfiles() {
  console.log('\n📝 Seeding index_profiles...');

  const indices = [
    {
      index_name: 'NIFTY',
      exchange_segment: 'NFO',
      strike_step: 50,
      risk_anchor_mode: 'GLOBAL',
      default_offset: 'ATM',
      default_product: 'MIS',
      // Conservative: No default risk - users must set per trade
      tp_per_unit: null,
      sl_per_unit: null,
      tsl_enabled: false,
      step_lots: 1,
      disallow_auto_reverse: false,
    },
    {
      index_name: 'BANKNIFTY',
      exchange_segment: 'NFO',
      strike_step: 100,
      risk_anchor_mode: 'GLOBAL',
      default_offset: 'ATM',
      default_product: 'MIS',
      tp_per_unit: null,
      sl_per_unit: null,
      tsl_enabled: false,
      step_lots: 1,
      disallow_auto_reverse: false,
    },
    {
      index_name: 'FINNIFTY',
      exchange_segment: 'NFO',
      strike_step: 50,
      risk_anchor_mode: 'GLOBAL',
      default_offset: 'ATM',
      default_product: 'MIS',
      tp_per_unit: null,
      sl_per_unit: null,
      tsl_enabled: false,
      step_lots: 1,
      disallow_auto_reverse: false,
    },
    {
      index_name: 'MIDCPNIFTY',
      exchange_segment: 'NFO',
      strike_step: 25,
      risk_anchor_mode: 'GLOBAL',
      default_offset: 'ATM',
      default_product: 'MIS',
      tp_per_unit: null,
      sl_per_unit: null,
      tsl_enabled: false,
      step_lots: 1,
      disallow_auto_reverse: false,
    },
    {
      index_name: 'SENSEX',
      exchange_segment: 'BFO',
      strike_step: 100,
      risk_anchor_mode: 'GLOBAL',
      default_offset: 'ATM',
      default_product: 'MIS',
      tp_per_unit: null,
      sl_per_unit: null,
      tsl_enabled: false,
      step_lots: 1,
      disallow_auto_reverse: false,
    },
    {
      index_name: 'BANKEX',
      exchange_segment: 'BFO',
      strike_step: 100,
      risk_anchor_mode: 'GLOBAL',
      default_offset: 'ATM',
      default_product: 'MIS',
      tp_per_unit: null,
      sl_per_unit: null,
      tsl_enabled: false,
      step_lots: 1,
      disallow_auto_reverse: false,
    },
  ];

  for (const index of indices) {
    // Check if already exists
    const existing = await db.get(
      'SELECT * FROM index_profiles WHERE index_name = ?',
      [index.index_name]
    );

    if (existing) {
      console.log(`  ⏭️  ${index.index_name} profile already exists, skipping`);
      continue;
    }

    await db.run(
      `INSERT INTO index_profiles (
        index_name,
        exchange_segment,
        strike_step,
        risk_anchor_mode,
        default_offset,
        default_product,
        tp_per_unit,
        sl_per_unit,
        tsl_enabled,
        step_lots,
        disallow_auto_reverse
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        index.index_name,
        index.exchange_segment,
        index.strike_step,
        index.risk_anchor_mode,
        index.default_offset,
        index.default_product,
        index.tp_per_unit,
        index.sl_per_unit,
        index.tsl_enabled ? 1 : 0,
        index.step_lots,
        index.disallow_auto_reverse ? 1 : 0,
      ]
    );

    console.log(`  ✅ Seeded ${index.index_name} profile (Strike step: ${index.strike_step})`);
  }
}

async function main() {
  try {
    console.log('🌱 Starting settings seed...\n');

    // Connect to database
    await db.connect();
    log.info('Database connected');

    await seedGlobalDefaults();
    await seedIndexProfiles();

    console.log('\n✅ Settings seed completed successfully!');
    console.log('\n📊 Summary:');
    console.log('   - Global defaults: Conservative (no default risk)');
    console.log('   - Index profiles: 6 indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX)');
    console.log('   - Users must configure TP/SL/TSL per trade or save their own defaults');
    console.log('\n💡 Next steps:');
    console.log('   1. Verify data: SELECT * FROM global_defaults;');
    console.log('   2. View indices: SELECT * FROM index_profiles;');
    console.log('   3. Test settings API once Phase 2 is complete');

    // Close database
    await db.close();
    log.info('Database closed');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Seed failed:', error);
    log.error('Settings seed failed', error);
    await db.close();
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { seedGlobalDefaults, seedIndexProfiles };
