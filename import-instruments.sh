#!/bin/bash

# Import instruments from CSV to database

echo "============================================================"
echo "Starting instruments import from CSV..."
echo "============================================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Allow overrides via env vars; otherwise use paths relative to repo root
CSV_FILE="${CSV_FILE_OVERRIDE:-${SCRIPT_DIR}/oasymbols.csv}"
DB_FILE="${DB_FILE_OVERRIDE:-${SCRIPT_DIR}/backend/database/simplifyed.db}"

# Check if files exist
if [ ! -f "$CSV_FILE" ]; then
    echo "❌ Error: CSV file not found at $CSV_FILE"
    exit 1
fi

if [ ! -f "$DB_FILE" ]; then
    echo "❌ Error: Database file not found at $DB_FILE"
    exit 1
fi

# Get record count
TOTAL_LINES=$(wc -l < "$CSV_FILE")
TOTAL_RECORDS=$((TOTAL_LINES - 1))
echo "📊 Total records to import: $TOTAL_RECORDS"
echo ""

# Start timer
START_TIME=$(date +%s)

# Busy timeout (ms) can be overridden; helps avoid lock errors if the app is still running
SQLITE_TIMEOUT_MS="${SQLITE_TIMEOUT_MS:-5000}"

# Create import SQL script
cat > /tmp/import_instruments.sql << EOF
-- Import instruments from CSV

-- Apply performance pragmas *before* the transaction (SQLite forbids changing
-- safety level inside a transaction)
PRAGMA busy_timeout = $SQLITE_TIMEOUT_MS;
PRAGMA journal_mode = MEMORY;
PRAGMA synchronous = OFF;
PRAGMA cache_size = 10000;

BEGIN EXCLUSIVE;

-- Clear existing instruments
DELETE FROM instruments;

-- Import data from CSV using SQLite's CSV mode
.mode csv
.import '$CSV_FILE' instruments_temp

-- Insert data from temp table to instruments table with proper column mapping
INSERT INTO instruments (symbol, brsymbol, name, exchange, brexchange, token, expiry, strike, lotsize, instrumenttype, tick_size, created_at, updated_at)
SELECT
    symbol,
    brsymbol,
    name,
    exchange,
    brexchange,
    token,
    CASE WHEN expiry = '-1' OR expiry = '' THEN NULL ELSE expiry END,
    CASE WHEN strike = '-1' OR strike = '' THEN NULL ELSE strike END,
    CASE WHEN lotsize = '-1' OR lotsize = '' THEN 1 ELSE CAST(lotsize AS INTEGER) END,
    instrumenttype,
    CASE WHEN tick_size = '-1' OR tick_size = '' THEN NULL ELSE tick_size END,
    datetime('now'),
    datetime('now')
FROM instruments_temp
WHERE symbol IS NOT NULL AND symbol != '';

-- Drop temp table
DROP TABLE instruments_temp;

COMMIT;

-- Re-enable normal settings
PRAGMA synchronous = NORMAL;

-- Get count
SELECT 'Total instruments imported: ' || COUNT(*) FROM instruments;

-- Update refresh log
INSERT INTO instruments_refresh_log (exchange, status, instrument_count, refresh_started_at, refresh_completed_at)
VALUES ('CSV_UPLOAD', 'completed', (SELECT COUNT(*) FROM instruments), datetime('now'), datetime('now'));

SELECT 'Refresh log updated';
EOF

echo "🗄️  Importing to database: $DB_FILE"
echo ""

# Run the import using sqlite3
sqlite3 -cmd ".timeout $SQLITE_TIMEOUT_MS" "$DB_FILE" < /tmp/import_instruments.sql

# Check if import was successful
if [ $? -eq 0 ]; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))

    echo ""
    echo "============================================================"
    echo "✅ INSTRUMENTS IMPORT COMPLETED SUCCESSFULLY!"
    echo "============================================================"
    echo "Duration: ${DURATION}s"
    echo ""

    # Verify the data
    echo "📊 Verifying import..."
    COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM instruments;")
    echo "   Total instruments in database: $COUNT"
    echo ""

    # Show sample data
    echo "📋 Sample instruments:"
    sqlite3 "$DB_FILE" "SELECT symbol, name, exchange, instrumenttype FROM instruments LIMIT 5;" | column -t -s '|'
    echo ""

    # Check FTS table
    FTS_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM instruments_fts;")
    echo "✅ FTS table records: $FTS_COUNT"
    echo ""

    echo "============================================================"
    echo "🎉 Import complete! Instruments cache is now populated."
    echo "============================================================"
else
    echo ""
    echo "❌ Import failed!"
    exit 1
fi

# Cleanup
rm -f /tmp/import_instruments.sql
