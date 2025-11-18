
# Option Chain Construction Logic and API Specification

This document describes how to build option chains from the instruments table and exposes this logic via HTTP APIs for both **index** and **stock** underlyings on the **NFO** segment.

---

## 1. Data Model Assumptions

We assume a symbol master table (or view) called instruments table with at least the following columns:

- `symbol` (string) – Full tradable symbol (e.g. `NIFTY25NOV2525000CE`)
- `name` (string) – Underlying code (e.g. `NIFTY`, `BANKNIFTY`, `HDFCBANK`)
- `exchange` (string) – e.g. `NFO`, `BFO`, `NSE_INDEX`, `NSE`
- `expiry` (string) – e.g. `25-NOV-25` (or whatever standard you use)
- `strike` (number) – Strike price for options  
  - Options: `strike > 0`  
  - Futures: typically `strike` is `-0.01` or `-1` (or some non-positive placeholder)
- `lotsize` (number) – Lot size for that contract
- `instrumenttype` (string) – `CE`, `PE`, `FUT`, `EQ`, `INDEX`, etc.

For **option chains**, we only care about NFO options:

- `exchange = 'NFO'`
- `instrumenttype IN ('CE','PE')`
- `strike > 0`
- `expiry IS NOT NULL`

This subset is the **options universe**.

---

## 2. Core Option Chain Logic (Common for Indices & Stocks)

### 2.1 Filter to NFO Options Universe

**SQL:**
```sql
SELECT symbol, name, exchange, expiry, strike, lotsize, instrumenttype
FROM   oasymbols
WHERE  exchange = 'NFO'
AND    instrumenttype IN ('CE','PE')
AND    strike > 0
AND    expiry IS NOT NULL;
```

**Conceptual Python:**
```python
opts = df[
    (df["exchange"] == "NFO") &
    (df["instrumenttype"].isin(["CE", "PE"])) &
    (df["strike"] > 0) &
    df["expiry"].notna()
]
```

All subsequent logic operates on this `opts` set.

---

### 2.2 Identify Underlyings and Expiries

For any **underlying** (`name`), available expiries are:

```sql
SELECT DISTINCT expiry
FROM   oasymbols
WHERE  exchange = 'NFO'
AND    instrumenttype IN ('CE','PE')
AND    name = :underlying
ORDER BY /* convert to date in your DB */ expiry;
```

This works identically for both index and stock underlyings.

---

### 2.3 Build Option Chain for a Given Underlying + Expiry

Given:
- `:underlying` (e.g. `NIFTY`, `BANKNIFTY`, `HDFCBANK`)
- `:expiry` (e.g. `25-NOV-25`)

**Base dataset:**
```sql
SELECT symbol, name, exchange, expiry, strike, lotsize, instrumenttype
FROM   oasymbols
WHERE  exchange = 'NFO'
AND    instrumenttype IN ('CE','PE')
AND    name   = :underlying
AND    expiry = :expiry;
```

Now **pivot by strike** so each row is:

> `strike | Call symbol + lotsize | Put symbol + lotsize`

**SQL with conditional aggregation:**
```sql
SELECT
    strike,
    MAX(CASE WHEN instrumenttype = 'CE' THEN symbol  END) AS call_symbol,
    MAX(CASE WHEN instrumenttype = 'CE' THEN lotsize END) AS call_lotsize,
    MAX(CASE WHEN instrumenttype = 'PE' THEN symbol  END) AS put_symbol,
    MAX(CASE WHEN instrumenttype = 'PE' THEN lotsize END) AS put_lotsize
FROM   oasymbols
WHERE  exchange = 'NFO'
AND    instrumenttype IN ('CE','PE')
AND    name   = :underlying
AND    expiry = :expiry
GROUP BY strike
ORDER BY strike;
```

**Conceptual Python:**
```python
def build_chain(df, underlying, expiry):
    subset = df[
        (df["exchange"] == "NFO") &
        (df["instrumenttype"].isin(["CE", "PE"])) &
        (df["name"] == underlying) &
        (df["expiry"] == expiry)
    ]

    calls = subset[subset["instrumenttype"] == "CE"].set_index("strike")
    puts  = subset[subset["instrumenttype"] == "PE"].set_index("strike")

    strikes = sorted(set(calls.index) | set(puts.index))

    rows = []
    for k in strikes:
        rows.append({
            "strike": k,
            "call_symbol":  calls.loc[k]["symbol"]   if k in calls.index else None,
            "call_lotsize": int(calls.loc[k]["lotsize"]) if k in calls.index else None,
            "put_symbol":   puts.loc[k]["symbol"]    if k in puts.index else None,
            "put_lotsize":  int(puts.loc[k]["lotsize"])  if k in puts.index else None,
        })
    return rows  # sorted chain rows
```

Later, you join quotes (LTP, bid/ask, OI, IV, etc.) by `symbol`.

---

## 3. Distinguishing Indices vs NFO Stocks

The chain-building pipeline is the **same** for indices and stocks. The difference is **how you classify/select the underlying.**

### 3.1 Index Underlyings

Index master rows typically look like:

- `exchange = 'NSE_INDEX'`
- `instrumenttype = 'INDEX'`
- `symbol`/`name` like `NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, etc.

**Index underlying set:**
```sql
SELECT DISTINCT symbol AS index_name
FROM   oasymbols
WHERE  exchange = 'NSE_INDEX'
AND    instrumenttype = 'INDEX';
```

To build an index option chain for, say, `NIFTY`:

1. Confirm it’s an index:
   ```sql
   SELECT 1
   FROM   oasymbols
   WHERE  exchange = 'NSE_INDEX'
   AND    instrumenttype = 'INDEX'
   AND    symbol = 'NIFTY';
   ```

2. Run the generic chain logic with `name = 'NIFTY'` and the selected `expiry`.
   ```sql
   -- same query as in §2.3 with name = 'NIFTY'
   ```

### 3.2 NFO Stock Underlyings

Stock underlyings are EQ scrips that have NFO options:

```sql
SELECT DISTINCT name
FROM   oasymbols
WHERE  exchange = 'NFO'
AND    instrumenttype IN ('CE','PE')
AND    name NOT IN (
  SELECT symbol
  FROM   oasymbols
  WHERE  exchange = 'NSE_INDEX'
  AND    instrumenttype = 'INDEX'
);
```

This yields all **NFO stock underlyings** (e.g. `HDFCBANK`, `RELIANCE`, etc.).

To build a stock option chain for `HDFCBANK`:

1. Get expiries:
   ```sql
   SELECT DISTINCT expiry
   FROM   oasymbols
   WHERE  exchange = 'NFO'
   AND    instrumenttype IN ('CE','PE')
   AND    name = 'HDFCBANK'
   ORDER BY expiry;  -- or date-converted
   ```
2. Use the generic chain query from §2.3 with `name = 'HDFCBANK'` and chosen `expiry`.

---

## 4. ATM / ITM / OTM Presentation Logic (Optional)

The symbol master does **not** contain LTP; that comes from quotes. Once you have the **underlying spot price**, you can compute:

1. **ATM strike**:
   ```text
   atm_strike = strike in chain with minimum |strike - spot|
   ```

2. **Visible strike range** (typical UI):
   - Indices: e.g. ±10 strikes around ATM
   - Stocks: e.g. ±5 strikes around ATM

   ```text
   visible_strikes = strikes where
       strike between atm_strike - K * step and atm_strike + K * step
   ```

3. Mark **ITM/OTM** per row:

   - For calls:
     - ITM if `strike < spot`
     - OTM if `strike > spot`
   - For puts:
     - ITM if `strike > spot`
     - OTM if `strike < spot`
   - ATM row(s) are the ones closest to `spot`.

This is purely **presentation-layer logic** on top of the chain data.

---

## 5. HTTP API Specification

This section defines REST-style APIs that expose the above logic.

All endpoints are under a base path (example):

```text
/api/v1
```

You can adjust the prefix as needed.

---

### 5.1 Common Types

#### 5.1.1 UnderlyingType

```text
"index"  | "stock"
```

#### 5.1.2 OptionChainRow

Static chain row from the symbol master (without quotes):

```json
{
  "strike": 25000.0,
  "call_symbol": "NIFTY25NOV2525000CE",
  "call_lotsize": 50,
  "put_symbol": "NIFTY25NOV2525000PE",
  "put_lotsize": 50
}
```

Extended chain row **with quotes** (optional fields):

```json
{
  "strike": 25000.0,
  "call_symbol": "NIFTY25NOV2525000CE",
  "call_lotsize": 50,
  "call_quote": {
    "ltp": 123.45,
    "bid_price": 123.40,
    "bid_qty": 100,
    "ask_price": 123.55,
    "ask_qty": 75,
    "oi": 150000,
    "volume": 2000,
    "iv": 12.34
  },
  "put_symbol": "NIFTY25NOV2525000PE",
  "put_lotsize": 50,
  "put_quote": {
    "ltp": 110.20,
    "bid_price": 110.15,
    "bid_qty": 150,
    "ask_price": 110.30,
    "ask_qty": 120,
    "oi": 140000,
    "volume": 1800,
    "iv": 13.10
  },
  "is_atm": true,
  "call_moneyness": "ATM",
  "put_moneyness": "ATM"
}
```

- `call_quote` / `put_quote` can be omitted if you want a purely static chain.
- `is_atm` / `call_moneyness` / `put_moneyness` are presentation fields; you may compute these in the API layer if you have the underlying spot.

---

### 5.2 Get All Underlyings That Have NFO Options

**Endpoint:**  
`GET /api/v1/option-chain/underlyings`

**Query Params:**
- `type` (optional): `"index"` or `"stock"`  
  - If omitted, return both.

**Response 200 JSON:**

```json
{
  "indices": [
    {
      "name": "NIFTY",
      "symbol": "NIFTY",
      "type": "index"
    },
    {
      "name": "BANKNIFTY",
      "symbol": "BANKNIFTY",
      "type": "index"
    }
  ],
  "stocks": [
    {
      "name": "HDFCBANK",
      "symbol": "HDFCBANK",
      "type": "stock"
    },
    {
      "name": "RELIANCE",
      "symbol": "RELIANCE",
      "type": "stock"
    }
  ]
}
```

**Backend logic:**
- For indices: use the query in §3.1.
- For NFO stocks: use the query in §3.2.
- Filter by `type` if provided.

---

### 5.3 Get Available Expiries for an Underlying

**Endpoint:**  
`GET /api/v1/option-chain/expiries`

**Query Params:**
- `underlying` (required): e.g. `"NIFTY"`, `"HDFCBANK"`  
- `type` (optional): `"index"` or `"stock"` (can be used to validate or route logic, but not strictly required if `underlying` is unique in your universe)

**Response 200 JSON:**

```json
{
  "underlying": "NIFTY",
  "type": "index",
  "exchange": "NFO",
  "expiries": [
    "20-NOV-25",
    "27-NOV-25",
    "25-DEC-25"
  ]
}
```

**Backend logic:**
- Validate that `underlying` exists either in index master or NFO stock universe.
- Run the `DISTINCT expiry` query for that `underlying` on `NFO` CE/PE instruments (§2.2).

---

### 5.4 Get Option Chain for Underlying + Expiry

**Endpoint:**  
`GET /api/v1/option-chain`

**Query Params:**
- `underlying` (required): e.g. `"NIFTY"`, `"HDFCBANK"`
- `expiry` (required): exact expiry string as returned by `/expiries`
- `type` (optional): `"index"` or `"stock"` – mainly for validation and UI clarity
- `include_quotes` (optional, default `false`): `"true"`/`"false"` string or boolean
- `strike_window` (optional): integer, number of strikes above and below ATM to return
  - If omitted, return the **full chain**.

**Response 200 JSON (without quotes, full chain):**

```json
{
  "underlying": "NIFTY",
  "type": "index",
  "exchange": "NFO",
  "expiry": "27-NOV-25",
  "has_quotes": false,
  "rows": [
    {
      "strike": 24500.0,
      "call_symbol": "NIFTY27NOV2524500CE",
      "call_lotsize": 50,
      "put_symbol": "NIFTY27NOV2524500PE",
      "put_lotsize": 50
    },
    {
      "strike": 24600.0,
      "call_symbol": "NIFTY27NOV2524600CE",
      "call_lotsize": 50,
      "put_symbol": "NIFTY27NOV2524600PE",
      "put_lotsize": 50
    }
    // ... more rows
  ]
}
```

**Response 200 JSON (with quotes, ATM windowed):**

```json
{
  "underlying": "NIFTY",
  "type": "index",
  "exchange": "NFO",
  "expiry": "27-NOV-25",
  "has_quotes": true,
  "spot": 24780.25,
  "atm_strike": 24800.0,
  "strike_window": 10,
  "rows": [
    {
      "strike": 24300.0,
      "call_symbol": "NIFTY27NOV2524300CE",
      "call_lotsize": 50,
      "call_quote": {
        "ltp": 350.25,
        "bid_price": 349.95,
        "bid_qty": 200,
        "ask_price": 350.30,
        "ask_qty": 180,
        "oi": 180000,
        "volume": 2500,
        "iv": 11.85
      },
      "put_symbol": "NIFTY27NOV2524300PE",
      "put_lotsize": 50,
      "put_quote": {
        "ltp": 55.10,
        "bid_price": 55.05,
        "bid_qty": 150,
        "ask_price": 55.20,
        "ask_qty": 120,
        "oi": 95000,
        "volume": 1200,
        "iv": 13.05
      },
      "is_atm": false,
      "call_moneyness": "ITM",
      "put_moneyness": "OTM"
    },
    {
      "strike": 24800.0,
      "call_symbol": "NIFTY27NOV2524800CE",
      "call_lotsize": 50,
      "call_quote": {
        "ltp": 180.50,
        "bid_price": 180.30,
        "bid_qty": 220,
        "ask_price": 180.70,
        "ask_qty": 210,
        "oi": 210000,
        "volume": 3000,
        "iv": 12.30
      },
      "put_symbol": "NIFTY27NOV2524800PE",
      "put_lotsize": 50,
      "put_quote": {
        "ltp": 195.25,
        "bid_price": 195.15,
        "bid_qty": 190,
        "ask_price": 195.35,
        "ask_qty": 160,
        "oi": 205000,
        "volume": 3100,
        "iv": 12.40
      },
      "is_atm": true,
      "call_moneyness": "ATM",
      "put_moneyness": "ATM"
    }
    // ... remaining strikes within +/- strike_window of atm_strike
  ]
}
```

**Backend steps:**

1. Validate `underlying` and `expiry` (and `type` if provided).
2. Query the base option set for that `underlying` and `expiry` on `NFO` CE/PE instruments (see §2.3).
3. Pivot into rows per `strike` with `call_symbol`, `put_symbol`, lot sizes.
4. If `include_quotes = true`:
   - Get `spot` for underlying from your quotes API.
   - For each symbol (`call_symbol` and `put_symbol`), fetch quotes and attach to each row as `call_quote` and `put_quote`.
   - Compute `atm_strike`, `is_atm`, `call_moneyness`, `put_moneyness`.
5. If `strike_window` is provided:
   - Filter rows to strikes within `atm_strike ± strike_window * strike_step` where `strike_step` may come from your symbol master or exchange spec.
6. Sort rows by `strike` ascending and return.

---

## 6. Summary

1. Use instruments table as the canonical master for all NFO options.
2. Filter NFO CE/PE options (`exchange = 'NFO'`, `instrumenttype IN ('CE','PE')`, `strike > 0`, `expiry IS NOT NULL`).  
3. Classify **index** underlyings from `NSE_INDEX` master and **stock** underlyings as NFO names that are not indices.  
4. For any `(underlying, expiry)`, pivot CE/PE by `strike` into chain rows.  
5. Optionally decorate rows with quotes, moneyness and ATM-windowing.  
6. Expose everything via 3 key endpoints:
   - `/api/v1/option-chain/underlyings`
   - `/api/v1/option-chain/expiries?underlying=...`
   - `/api/v1/option-chain?underlying=...&expiry=...`

This gives you a clean, backend-driven option chain service that works identically for indices and NFO stocks.
