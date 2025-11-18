#!/usr/bin/env node

/**
 * Import instruments from CSV file to database using sqlite3 directly
 */

import fs from 'fs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const CSV_FILE = '/Users/jnt/GitHub/Simplifyed/oasymbols.csv';
const DB_FILE = '/Users/jnt/GitHub/Simplifyed/database/simplifyed.db';
const BATCH_SIZE = 500; // Process 500 records at a time

async function importInstruments() {
  const startTime = Date.now();
  console.log('Starting instruments import from CSV...\n');

  try {
    // Open database
    const db = await open({
      filename: DB_FILE,
      driver: sqlite3.Database
    });

    console.log('✅ Database connected');

    // Read and parse CSV
    const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    const lines = csvContent.trim().split('\n');

    // Skip header line
    const header = lines.shift();
    console.log('CSV Header:', header);

    const totalRecords = lines.length;
    console.log(`Total records to import: ${totalRecords.toLocaleString()}\n`);

    // Clear existing instruments
    console.log('Clearing existing instruments...');
    await db.exec('DELETE FROM instruments');
    console.log('✅ Existing instruments cleared\n');

    // Process in batches
    let processed = 0;
    let inserted = 0;

    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      const batch = lines.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(lines.length / BATCH_SIZE);

      console.log(`Processing batch ${batchNum}/${totalBatches} (${((i / lines.length) * 100).toFixed(1)}%)`);

      // Parse batch
      const values = [];
      const placeholders = [];

      for (const line of batch) {
        // Parse CSV line
        const fields = parseCsvLine(line);

        if (fields.length < 12) {
          console.warn(`⚠️  Skipping invalid line: ${line.substring(0, 50)}...`);
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
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"), datetime("now"))');
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

      const elapsed = Date.now() - startTime;
      const rate = (inserted / (elapsed / 1000)).toFixed(0);
      console.log(`  ✅ Batch ${batchNum} completed: ${inserted.toLocaleString()} records (${rate} rec/s)\n`);
    }

    const duration = Date.now() - startTime;

    // Get final count
    const countResult = await db.get('SELECT COUNT(*) as count FROM instruments');
    const finalCount = countResult.count;

    // Log success
    console.log('\n' + '='.repeat(60));
    console.log('✅ INSTRUMENTS IMPORT COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(60));
    console.log(`Total records: ${finalCount.toLocaleString()}`);
    console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`Rate: ${(finalCount / (duration / 1000)).toFixed(0)} records/sec`);
    console.log('='.repeat(60) + '\n');

    // Update refresh log
    await db.run(
      `INSERT INTO instruments_refresh_log (
        exchange, status, instrument_count, refresh_started_at, refresh_completed_at
      ) VALUES (?, 'completed', ?, datetime("now"), datetime("now"))`,
      ['CSV_UPLOAD', finalCount]
    );

    console.log('✅ Refresh log updated\n');

    // Verify FTS table
    const ftsCount = await db.get('SELECT COUNT(*) as count FROM instruments_fts');
    console.log(`✅ FTS table populated: ${ftsCount.count.toLocaleString()} records\n`);

    await db.close();

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Import failed:', error.message);
    console.error(error.stack);
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
