#!/usr/bin/env node

/**
 * Import instruments from CSV file to database
 */

import fs from 'fs';
import path from 'path';
import db from '../src/core/database.js';
import { log } from '../src/core/logger.js';

const CSV_FILE = '/Users/jnt/GitHub/Simplifyed/oasymbols.csv';
const BATCH_SIZE = 500; // Process 500 records at a time

async function importInstruments() {
  const startTime = Date.now();
  log.info('Starting instruments import from CSV', { file: CSV_FILE });

  try {
    // Read and parse CSV
    const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    const lines = csvContent.trim().split('\n');

    // Skip header line
    const header = lines.shift();
    log.info('CSV header', { header });

    const totalRecords = lines.length;
    log.info('Total records to import', { count: totalRecords });

    // Clear existing instruments
    log.info('Clearing existing instruments...');
    await db.run('DELETE FROM instruments');
    log.info('Existing instruments cleared');

    // Process in batches
    let processed = 0;
    let inserted = 0;

    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      const batch = lines.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(lines.length / BATCH_SIZE);

      log.info(`Processing batch ${batchNum}/${totalBatches}`, {
        batch_start: i,
        batch_size: batch.length,
        progress: `${((i / lines.length) * 100).toFixed(1)}%`
      });

      // Parse batch
      const values = [];
      const placeholders = [];

      for (const line of batch) {
        // Parse CSV line
        const fields = parseCsvLine(line);

        if (fields.length < 12) {
          log.warn('Skipping invalid line', { line, fieldsCount: fields.length });
          continue;
        }

        const [
          id, symbol, brsymbol, name, exchange, brexchange,
          token, expiry, strike, lotsize, instrumenttype, tick_size
        ] = fields;

        // Prepare values (convert empty strings to null)
        const value = [
          symbol || null,
          brsymbol || null,
          name || null,
          exchange || null,
          brexchange || null,
          token || null,
          expiry || null,
          strike === '-1' || strike === '' ? null : strike,
          lotsize === '-1' || lotsize === '' ? 1 : parseInt(lotsize, 10),
          instrumenttype || null,
          tick_size === '-1' || tick_size === '' ? null : tick_size
        ];

        values.push(...value);
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)');
      }

      // Insert batch
      const sql = `
        INSERT INTO instruments (
          symbol, brsymbol, name, exchange, brexchange, token, expiry, strike,
          lotsize, instrumenttype, tick_size, created_at, updated_at
        ) VALUES ${placeholders.join(', ')}
      `;

      await db.run(sql, values);
      inserted += batch.length;
      processed += batch.length;

      log.info(`Batch ${batchNum} completed`, {
        batch_size: batch.length,
        total_inserted: inserted,
        elapsed_ms: Date.now() - startTime
      });
    }

    const duration = Date.now() - startTime;

    // Get final count
    const countResult = await db.get('SELECT COUNT(*) as count FROM instruments');
    const finalCount = countResult.count;

    // Log success
    log.info('Instruments import completed successfully', {
      total_lines: totalRecords,
      total_inserted: finalCount,
      duration_ms: duration,
      duration_sec: (duration / 1000).toFixed(2),
      records_per_sec: (finalCount / (duration / 1000)).toFixed(0)
    });

    // Update refresh log
    await db.run(
      `INSERT INTO instruments_refresh_log (
        exchange, status, instrument_count, refresh_started_at, refresh_completed_at
      ) VALUES (?, 'completed', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ['CSV_UPLOAD', finalCount]
    );

    console.log('\n✅ Import completed successfully!');
    console.log(`   Total records: ${finalCount}`);
    console.log(`   Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`   Rate: ${(finalCount / (duration / 1000)).toFixed(0)} records/sec`);

    process.exit(0);
  } catch (error) {
    log.error('Import failed', error);
    console.error('\n❌ Import failed:', error.message);
    process.exit(1);
  }
}

/**
 * Parse a CSV line, handling quoted fields
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Add last field
  fields.push(current.trim());

  return fields;
}

// Run import
importInstruments();
