#!/usr/bin/env python3

import sqlite3
import csv
import sys
from datetime import datetime

# Configuration
CSV_FILE = '/Users/jnt/GitHub/Simplifyed/oasymbols.csv'
DB_FILE = '/Users/jnt/GitHub/Simplifyed/backend/database/simplifyed.db'

def import_instruments():
    print("=" * 70)
    print("Starting instruments import from CSV...")
    print("=" * 70)
    print()

    # Connect to database
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Clear existing instruments
    print("Clearing existing instruments...")
    cursor.execute("DELETE FROM instruments")
    conn.commit()
    print("✓ Existing instruments cleared\n")

    # Read and import CSV
    print(f"Reading CSV file: {CSV_FILE}")
    with open(CSV_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)

        total_rows = sum(1 for _ in reader)
        f.seek(0)
        reader = csv.DictReader(f)

        print(f"Total records to import: {total_rows:,}")
        print()

        # Prepare batch insert
        batch_size = 1000
        inserted = 0

        for i, row in enumerate(reader):
            if i % batch_size == 0:
                if i > 0:
                    conn.commit()
                    print(f"✓ Committed batch: {inserted:,} records")

                batch = []
                progress = (i / total_rows) * 100
                print(f"Processing... {i:,}/{total_rows:,} ({progress:.1f}%)")

            # Map CSV columns to database columns
            # CSV columns: id, symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size
            # DB columns: id, symbol, brsymbol, name, exchange, token, expiry, strike, lotsize, instrumenttype, tick_size, created_at, updated_at, brexchange
            record = (
                row['symbol'] if row['symbol'] else None,
                row['brsymbol'] if row['brsymbol'] else None,
                row['name'] if row['name'] else None,
                row['exchange'] if row['exchange'] else None,
                row['token'] if row['token'] else None,
                None if row['expiry'] in ['-1', ''] else row['expiry'],
                None if row['strike'] in ['-1', ''] else float(row['strike']) if row['strike'] else None,
                1 if row['lotsize'] in ['-1', ''] else int(row['lotsize']),
                row['instrumenttype'] if row['instrumenttype'] else None,
                None if row['tick_size'] in ['-1', ''] else float(row['tick_size']) if row['tick_size'] else None,
                datetime.now().isoformat(),
                datetime.now().isoformat(),
                row['brexchange'] if row['brexchange'] else None,
            )

            batch.append(record)
            inserted += 1

        # Commit final batch
        if batch:
            placeholders = ','.join(['?' for _ in range(len(record))])
            sql = f"""
                INSERT INTO instruments (
                    symbol, brsymbol, name, exchange, token, expiry, strike,
                    lotsize, instrumenttype, tick_size, created_at, updated_at, brexchange
                ) VALUES ({placeholders})
            """
            cursor.executemany(sql, batch)
            conn.commit()
            print(f"✓ Committed final batch: {inserted:,} records\n")

    # Verify import
    cursor.execute("SELECT COUNT(*) FROM instruments")
    count = cursor.fetchone()[0]
    print(f"✓ Total instruments in database: {count:,}\n")

    # Clear and rebuild FTS table
    print("Rebuilding FTS table...")
    cursor.execute("DELETE FROM instruments_fts")
    cursor.execute("""
        INSERT INTO instruments_fts(rowid, symbol, name)
        SELECT id, symbol, name FROM instruments
    """)
    conn.commit()

    cursor.execute("SELECT COUNT(*) FROM instruments_fts")
    fts_count = cursor.fetchone()[0]
    print(f"✓ FTS table records: {fts_count:,}\n")

    # Update refresh log
    cursor.execute("""
        INSERT INTO instruments_refresh_log (
            exchange, status, instrument_count, refresh_started_at, refresh_completed_at
        ) VALUES (?, 'completed', ?, ?, ?)
    """, ['CSV_UPLOAD', count, datetime.now().isoformat(), datetime.now().isoformat()])
    conn.commit()

    print("✓ Refresh log updated\n")

    # Show sample data
    print("Sample instruments:")
    print("-" * 70)
    cursor.execute("SELECT symbol, name, exchange, instrumenttype FROM instruments LIMIT 5")
    for row in cursor.fetchall():
        print(f"  {row[0]:20s} {row[1]:40s} {row[2]:10s} {row[3]}")
    print()

    # Show breakdown by exchange
    print("Instruments by exchange (top 10):")
    print("-" * 70)
    cursor.execute("""
        SELECT exchange, COUNT(*) as count
        FROM instruments
        GROUP BY exchange
        ORDER BY count DESC
        LIMIT 10
    """)
    for row in cursor.fetchall():
        print(f"  {row[0]:20s} {row[1]:>10,}")
    print()

    # Show breakdown by instrument type
    print("Instruments by type:")
    print("-" * 70)
    cursor.execute("""
        SELECT instrumenttype, COUNT(*) as count
        FROM instruments
        GROUP BY instrumenttype
        ORDER BY count DESC
    """)
    for row in cursor.fetchall():
        print(f"  {row[0]:20s} {row[1]:>10,}")
    print()

    # Close connection
    cursor.close()
    conn.close()

    print("=" * 70)
    print("✅ INSTRUMENTS IMPORT COMPLETED SUCCESSFULLY!")
    print("=" * 70)
    print()
    print(f"Total instruments: {count:,}")
    print(f"FTS records: {fts_count:,}")
    print()
    print("🎉 Instruments cache is now populated!")
    print("   Fast symbol search is now available.")
    print()

if __name__ == '__main__':
    try:
        import_instruments()
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Import failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)
