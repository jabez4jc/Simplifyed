# 📊 OpenAlgo Hybrid Position Tracking with Points-Based SL/Target/TSL

---

## ✅ Objective

To build a **robust and fool-proof position tracking system** that:
- Accurately tracks **open positions**
- Calculates **average entry price**
- Handles **absolute point-based** targets, stoplosses, and trailing stoplosses

This solution combines:
- `positionbook()` → to detect open positions
- `orderbook()` → to filter out closed orders
- `tradebook()` → to compute true executed entry prices

---

## 🚨 Problem

When using `positionbook()` alone:
- `average_price` may be missing (especially for NRML or market orders)
- You don’t get historical trade context
- You may end up using wrong price for SL/Target (can lead to **missed exits**)

---

## ✅ Combined Strategy (Hybrid Model)

### 1. `positionbook()` — Get Open Positions
```json
{
  "symbol": "NATGASMINI24NOV25FUT",
  "exchange": "MCX",
  "quantity": 50,
  "average_price": null
}
```
- `quantity > 0` → **LONG position** (you bought, need to sell to exit)
- `quantity < 0` → **SHORT position** (you sold, need to buy back to exit)
- `quantity = 0` → position is closed

### 2. `orderbook()` — Find completed orders
- Use `status = COMPLETE`
- Filter by `symbol`, `exchange`
- Get `BUY` orders for LONG and `SELL` orders for SHORT
- Track reference orders (`ref_orderid`) to detect exited trades

### 3. `tradebook()` — Actual fill prices
- Get all trades for the symbol
- Match trades against completed order IDs
- Exclude trades that are already fully offset (via `orderbook`)
- Remaining trades = **currently open lots**

---

## 🧮 Calculate Weighted Average Entry Price (Per Symbol)

**Formula:**
```
avg_price = Σ(price * quantity) / Σ(quantity)
```

### ✅ Example:
You placed 3 BUY orders:
| Trade Price | Qty |
|-------------|-----|
| 200.5       | 50  |
| 201.0       | 25  |
| 199.5       | 25  |

Then:
```
total_cost = (200.5*50) + (201*25) + (199.5*25) = 10025 + 5025 + 4987.5 = 20037.5
avg_price = 20037.5 / 100 = 200.375
```

---

## 🎯 Handling Point-Based SL / Target / TSL

### ✅ Inputs (defined by you):
```yaml
target_points: 15
stoploss_points: 10
trailing_trigger_profit: 20
trailing_sl_gap: 8
```

---

## 📈 Logic for LONG Position (Buy first)

- **Entry price** = 200
- **Target** = 200 + 15 = `215`
- **Stoploss** = 200 - 10 = `190`
- **Start trailing when** LTP ≥ 220
- **Trailing SL** = Highest seen LTP - 8

### 🔁 Trailing Example (LONG):
| LTP | Action              | Trail SL |
|-----|---------------------|----------|
| 220 | Start trailing      | 212      |
| 225 | Move trail SL       | 217      |
| 223 | No change           | 217      |
| 216 | SL hit (exit trade) |          |

---

## 📉 Logic for SHORT Position (Sell first)

- **Entry price** = 200
- **Target** = 200 - 15 = `185`
- **Stoploss** = 200 + 10 = `210`
- **Start trailing when** LTP ≤ 180
- **Trailing SL** = Lowest seen LTP + 8

### 🔁 Trailing Example (SHORT):
| LTP | Action              | Trail SL |
|-----|---------------------|----------|
| 180 | Start trailing      | 188      |
| 176 | Move trail SL       | 184      |
| 179 | No change           | 184      |
| 185 | SL hit (exit trade) |          |

---

## ✅ Final Strategy Summary

| API          | Purpose                        |
|---------------|---------------------------------|
| `positionbook()` | Get current open positions     |
| `orderbook()`    | Detect completed exits         |
| `tradebook()`    | Get actual executed prices     |
| `quotes()`       | Monitor live price (LTP)       |
| `placesmartorder()` | Place market exit orders     |

---

## 🧠 Benefits
- Avoids errors due to missing average_price
- Works across brokers (even with partial fills)
- Prevents SL/Target being missed due to wrong price
- Point-based logic gives more control for option/future traders

---

Let us know if you want a **Node.js implementation** or a **webhook-based service** that can handle SL/Target/TSL exit logic with polling or real-time LTP tracking!

