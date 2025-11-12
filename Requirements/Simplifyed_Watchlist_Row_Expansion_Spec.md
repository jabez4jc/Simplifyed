# Simplifyed — Watchlist Integration & Trading Controls (Row Expansion)
**Version:** 2.5 • **Date:** 2025‑11‑12 • **Owner:** Simplifyed Platform

This **final version (v2.5)** consolidates all requirements — covering **Equity**, **Futures**, **Direct Option Symbols**, and **Options Mode** workflows — into one unified, fully deployable specification aligned with the Simplifyed multi‑instance architecture.

---

## 1) Objectives
1. Enable trading directly from the Watchlist via row expansion.  
2. Maintain synchronized execution across all attached OpenAlgo instances.  
3. Unify workflows for **Equity**, **Futures**, **Direct Options**, and **Underlying Options Mode**.  
4. Centralize symbol resolution and position lookup in the **primary or secondary instance**.  
5. Use **OptionsOrder** for long CE/PE entries, and **placesmartorder** for all other trades.  
6. Provide complete observability through per‑instance logs, inline alerts, and email escalation.

---

## 2) Watchlist Row Layout & Behavior

Each row expands to show **context‑specific trade controls** based on the instrument type:

| Instrument Type | Controls Shown | Toggle Options |
|------------------|----------------|----------------|
| Equity (non‑F&O) | [BUY] [SELL] [EXIT] | — |
| Equity (F&O‑eligible) | [BUY] [SELL] [EXIT] (Equity) + Options/Futures toggles | `Equity | Futures | Options` |
| Futures | [BUY] [SELL] [EXIT] | — |
| Direct Option Symbol | [BUY] [SELL] [EXIT] | — |
| Index (e.g., NIFTY) | Options/Futures controls | `Futures | Options` |

---

## 3) Equity Trades (Non‑F&O Eligible)

- **Buttons:** `[BUY] [SELL] [EXIT]`  
- **Endpoint:** `placesmartorder`  
- **Quantity:** Actual number of shares per click.  
- **Workflow:**  
  - `BUY` → opens or adds to long position.  
  - `SELL` → reduces or opens short position.  
  - `EXIT` → brings `position_size` to 0 (fully exits).  

**Sample Payload**
```json
{
  "symbol": "TCS",
  "exchange": "NSE",
  "action": "BUY",
  "product": "CNC",
  "pricetype": "MARKET",
  "quantity": 10
}
```

---

## 4) Equity Symbols that are F&O Eligible

- **Toggle:** `Equity | Futures | Options`  
- **Behavior:**  
  - **Equity Mode** → uses workflow above.  
  - **Futures Mode** → see next section.  
  - **Options Mode** → detailed in Section 7.  
- Switching between modes updates the available buttons dynamically.

---

## 5) Futures Trades

- **Buttons:** `[BUY] [SELL] [EXIT]`  
- **Endpoint:** `placesmartorder`  
- **Quantity:** in **lots**, converted server‑side → `lots × lot_size = contracts`.  
- **Expiry:** user selects from **Expiry endpoint**; default = nearest active expiry.  
- **Workflow:**  
  - `BUY` → open long future.  
  - `SELL` → open short future.  
  - `EXIT` → close open future position.  

**Sample Payload**
```json
{
  "symbol": "BANKNIFTY25NOVFUT",
  "exchange": "NFO",
  "action": "BUY",
  "product": "MIS",
  "pricetype": "MARKET",
  "quantity": 30,
  "reason": "Futures trade from watchlist"
}
```

---

## 6) Direct Option Symbols (CE/PE contracts already in Watchlist)

- **Buttons:** `[BUY] [SELL] [EXIT]`  
- **Endpoint:** `placesmartorder`  
- **Quantity:** lots per click → converted to contracts.  
- **Workflow:**  
  - `BUY` → open/add long position on this strike.  
  - `SELL` → open/add short position on this strike.  
  - `EXIT` → closes **only this strike** (no cross‑leg actions).  

**Sample Payload**
```json
{
  "symbol": "BANKNIFTY25NOV2044500CE",
  "exchange": "NFO",
  "action": "SELL",
  "product": "MIS",
  "pricetype": "MARKET",
  "quantity": 30,
  "reason": "Exit direct option leg"
}
```

---

## 7) Options Mode — Instance‑Aware Workflow (Underlying‑Driven)

### 7.1 User Inputs
- **Expiry** → from `/api/v1/data/expiry`  
- **Strike selection** → `[ ITM3 | ITM2 | ITM1 | ATM | OTM1 | OTM2 | OTM3 ]`  
- **Buttons:** `[BUY CE] [SELL CE] [BUY PE] [SELL PE] [EXIT ALL]`

### 7.2 BUY CE / BUY PE
- **Primary/Secondary instance** fetches OptionSymbol:
  ```
  GET /api/v1/data/optionsymbol?underlying=<UNDERLYING>&exchange=<EXCHANGE>&expiry=<YYYY-MM-DD>
  ```
- Extracts **CE/PE** symbol for selected leg (e.g., ITM2).  
- That symbol becomes the **canonical trading symbol** for all instances.  
- Execute `OptionsOrder` across all instances:

```json
{
  "symbol": "BANKNIFTY25NOV2044500CE",
  "exchange": "NFO",
  "product": "MIS",
  "pricetype": "MARKET",
  "quantity": 30
}
```

### 7.3 SELL CE / SELL PE
- **Primary/Secondary instance** queried for open positions:
  ```
  GET /api/v1/orders/positions
  ```
- The open CE/PE symbol(s) are extracted, and `placesmartorder` is broadcast to **all instances** using that symbol.  
- Each instance closes its matching open position for the same CE/PE strike.  

### 7.4 EXIT ALL
- Closes all CE & PE legs for same **underlying + expiry** using unified `placesmartorder` calls.  

### 7.5 Data Flow Summary

| Step | Action | Endpoint | Instance Scope | Resolution Source |
|------|---------|-----------|----------------|------------------|
| 1 | Fetch Expiries | `/api/v1/data/expiry` | Primary/Secondary | - |
| 2 | Fetch OptionSymbol | `/api/v1/data/optionsymbol` | Primary/Secondary | Determines tradable CE/PE |
| 3 | BUY CE/PE | `OptionsOrder` | All Instances | Symbol from primary instance |
| 4 | SELL CE/PE | `placesmartorder` | All Instances | Symbol from primary open positions |
| 5 | EXIT ALL | `placesmartorder` | All Instances | All CE/PE for same expiry |

---

## 8) Index Instruments (Non‑Tradable Directly)

| Index | Exchange | Toggle Options |
|--------|-----------|----------------|
| NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY | NSE_INDEX | `Futures | Options` |
| SENSEX | BSE_INDEX | `Futures | Options` |

Indexes follow the same logic as underlying equity but are **always traded via Futures or Options** only.

---

## 9) Quantity & Conversion Rules

| Type | Input | Conversion | Example |
|------|--------|-------------|----------|
| Equity | Shares | No conversion | Qty = 10 |
| Futures | Lots | lots × lot_size | 2 lots × 15 = 30 |
| Options | Lots | lots × lot_size | 1 lot × 25 = 25 |

All per‑click quantities persist in DB (`quantity_clicks`, `quantity_units`).

---

## 10) Error Handling & Alerts

| Error Type | Action |
|-------------|--------|
| F&O permission denied | Inline error + email to admin + persistent log |
| Expiry list empty | Disable trade buttons; show inline alert |
| OptionSymbol missing leg | Default to ATM + yellow notice |
| Endpoint failure (5xx/timeout) | Retry once + log instance + show toast “Retrying…” |

---

## 11) Logs & Observability

| Field | Description |
|--------|-------------|
| timestamp | ISO timestamp |
| instance_id | Target OpenAlgo instance |
| watchlist_id | Active watchlist |
| underlying | Root symbol |
| mode | Equity / Futures / Options |
| action | BUY / SELL / EXIT |
| endpoint | OptionsOrder / placesmartorder |
| symbol | Final trade symbol |
| quantity | In contracts |
| response_status | HTTP response |
| response_msg | OpenAlgo API message |
| result | SUCCESS / PARTIAL / FAILED |

---

## 12) Acceptance Criteria

1. Each instrument type exposes correct control set in row expansion.  
2. Equity, Futures, Direct Option Symbols trade via `placesmartorder`.  
3. Options Mode uses `OptionSymbol` (primary instance) for symbol resolution, then broadcasts across instances.  
4. Quantity handling consistent (shares vs lots).  
5. Index trading allowed only via Futures or Options.  
6. Errors surfaced inline, logged, and emailed.  
7. All trades mirrored to all instances, with full response logging.  
8. Primary/Secondary instance acts as authoritative source for symbol, expiry, and open positions.

---

**End of Spec v2.5 — Final Approved Version**
