#!/bin/bash

# Import instruments from CSV to database
# This version rebuilds the FTS table after import

echo "============================================================"
echo "Starting instruments import from CSV..."
echo "============================================================"
echo ""

CSV_FILE="/Users/jnt/GitHub/Simplifyed/oasymbols.csv"
DB_FILE="/Users/jnt/GitHub/Simplifyed/backend/database/simplifyed.db"

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

# Create import SQL script
cat > /tmp/import_instruments.sql << 'EOF'
-- Import instruments from CSV

-- Clear existing instruments
DELETE FROM instruments;

-- Set PRAGMA for faster import
PRAGMA synchronous = OFF;
PRAGMA journal_mode = MEMORY;
PRAGMA cache_size = 10000;

-- Create temp table for CSV import
CREATE TEMP TABLE instruments_temp (
    id INTEGER,
    symbol TEXT,
    brsymbol TEXT,
    name TEXT,
    exchange TEXT,
    brexchange TEXT,
    token TEXT,
    expiry TEXT,
    strike TEXT,
    lotsize TEXT,
    instrumenttype TEXT,
    tick_size TEXT
);

-- Import data from CSV
.mode csv
.import /Users/jnt/GitHub/Simplifyed/oasymbols.csv instruments_temp

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

-- Rebuild FTS table
DELETE FROM instruments_fts;

INSERT INTO instruments_fts(rowid, symbol, name)
SELECT id, symbol, name FROM instruments;

-- Re-enable normal settings
PRAGMA synchronous = NORMAL;

-- Get count
SELECT 'Total instruments imported: ' || COUNT(*) FROM instruments;
EOF

echo "🗄️  Importing to database: $DB_FILE"
echo ""

# Run the import using sqlite3
sqlite3 "$DB_FILE" < /tmp/import_instruments.sql 2>&1

# Check if import was successful
IMPORT_RESULT=$?

if [ $IMPORT_RESULT -eq 0 ]; then
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

    # Update refresh log
    sqlite3 "$DB_FILE" << 'SQL'
INSERT INTO instruments_refresh_log (exchange, status, instrument_count, refresh_started_at, refresh_completed_at)
VALUES ('CSV_UPLOAD', 'completed', (SELECT COUNT(*) FROM instruments), datetime('now'), datetime('now'));
SQL

    echo "✅ Refresh log updated"
    echo ""

    echo "============================================================"
    echo "🎉 Import complete! Instruments cache is now populated."
    echo "============================================================"
else
    echo ""
    echo "❌ Import failed with exit code: $IMPORT_RESULT"
    cat /tmp/import_instruments.sql
    exit 1
fi

# Cleanup
rm -f /tmp/import_instruments.sql
