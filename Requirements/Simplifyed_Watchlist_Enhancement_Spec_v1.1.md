# Simplifyed Watchlist and Add Symbol Enhancement — Full Specification

This document provides a **comprehensive, descriptive explanation** of the proposed enhancements to the *Watchlist Management* and *Add Symbol* modules in Simplifyed’s trading dashboard.  
The goal is to make the functionality easily understandable even for someone without technical background.

---

## 🧭 1. Overview

The Watchlist and Add Symbol modals are being enhanced to make them more **intuitive, automated, and F&O-aware**.  
These changes are designed to ensure that the platform dynamically understands which types of trades (Equity, Futures, or Options) are possible for each symbol, and automatically configures the interface and order logic accordingly.

Key enhancements include:
- Moving the symbol type filters from the **search section** to the **Product & Order Type section**.
- Adding **checkboxes** to select which types of trades (Equity, Futures, Options) can be performed for the selected symbol.
- Dynamically updating available trading options based on the symbol type.
- Adding **Options configuration** for symbols that support Options trading (ITM/ATM/OTM levels).
- Enhancing the **Watchlist UI** to display trade buttons as per symbol type.
- Centralizing LTP updates and expiry handling for Options.

---

## ⚙️ 2. Source of Truth for F&O Eligibility

The platform determines whether a symbol can be traded in the Equity, Futures, or Options market by analyzing the **OpenAlgo Search API** results.

### Logic:

When a user searches for a symbol:
- If the search result **name** and **symbol** are the same and there’s **no expiry** → It’s a **pure equity** symbol.
- If results with the **same name** have **different symbol values** that include expiry → It’s an **F&O symbol**.
- If results with the **same name** have `instrumenttype` as `OPTIDX` or `OPTSTK` → The symbol supports **Options trading**.

### Example:
```text
RELIANCE     → Equity (no expiry)
RELIANCE25NOVFUT → F&O available (Futures)
RELIANCE25NOV2450CE → Options available (OPTIDX/OPTSTK)
```

This logic ensures every symbol automatically inherits the correct trade types.

---

## 🧩 3. Add / Edit Symbol Modal (Redesigned)

The Add Symbol modal now provides a more structured layout to clearly separate symbol search, tradability configuration, and Options setup.

### 3.1. Layout Structure

#### 1️⃣ Symbol Search Section
- The user types a symbol name.
- The system fetches all **matching instruments** from OpenAlgo.
- On selecting a result, the system detects if it supports **Equity**, **Futures**, or **Options**.

#### 2️⃣ Product & Order Type Section
This section now replaces the old “symbol type” filter.

**Based on the symbol type:**
| Symbol Type | Available Options | Default Selection |
|--------------|------------------|-------------------|
| Equity-only | Equity | Equity (checked, disabled) |
| Equity + F&O Underlying | Equity, Futures, Options | Equity (checked) |
| Futures Symbol | Futures, Options | Futures (checked) |
| Options Symbol | Options | Options (checked, disabled) |

These checkboxes determine which trade buttons will appear in the Watchlist.

#### 3️⃣ Options Configuration (Shown only if Options available)
- Adds a new field for **Relative Strike Selection**:
  `[ ITM3 | ITM2 | ITM1 | ATM | OTM1 | OTM2 | OTM3 ]`
- Default: **ITM2**
- Expiry: **Auto-selected to the nearest expiry**
- The expiry automatically refreshes every **Wednesday and Friday at 8:00 AM**, or earlier if the existing expiry has expired or becomes invalid.
- This ensures traders never manually update expiry settings.

#### 4️⃣ Quantity & Lot Size
- Standard validations apply.
- The system uses existing logic for lot size validation and exposure management.

---

## 💻 4. Watchlist UI Enhancements

The Watchlist screen is redesigned for clarity and speed (as shown in the mockup).  
Each symbol row now dynamically adjusts its trade controls depending on its tradability.

### 4.1. Common UI Elements per Symbol Row

Each symbol displays:
- Symbol, Exchange, Instrument Type, Lot Size, Configuration, Product Type
- Underlying LTP (auto-refresh every 30s)
- Status (Enabled/Disabled)
- Action buttons (Edit, Delete)

LTP is received via a **central broadcast** from the primary or secondary admin instance.

---

### 4.2. Action Button Layouts

#### A. **Equity-only Symbols**
Display only the Equity actions:
```
[ BUY ] [ SELL ] [ EXIT ]
```

#### B. **Equity Symbols that also support F&O**
Show both sections:

**1. Equity/Futures Toggle:**
```
Toggle: [ Equity | Futures ]
Trade Controls: [ BUY ] [ SELL ] [ EXIT ]
```

**2. Options Controls:**
```
Trade Options: [ BUY CE ] [ SELL CE ] [ BUY PE ] [ SELL PE ] [ EXIT ALL ]
```

#### C. **Futures Symbols (that support Options)**
```
Trade Futures: [ BUY ] [ SELL ] [ EXIT ]
Trade Options: [ BUY CE ] [ SELL CE ] [ BUY PE ] [ SELL PE ] [ EXIT ALL ]
```

#### D. **Option Symbols (Direct Option Contracts)**
Treated like equity instruments:
```
[ BUY ] [ SELL ] [ EXIT ]
```

---

## 🔁 5. Updated placequickorder API Specification

The **placequickorder** API is enhanced to handle direct trades for all instrument types — Equity, Futures, and Options — while maintaining compatibility with `placesmartorder`.

### 5.1. Example Payload
```json
{
  "symbol": "NIFTY25NOV25FUT",
  "underlying": "NIFTY",
  "action": "BUY" | "SELL" | "EXIT" | "BUY_CE" | "SELL_CE" | "BUY_PE" | "SELL_PE" | "EXIT_ALL",
  "trade_mode": "EQUITY" | "FUTURES" | "OPTIONS",
  "options_leg": "ITM3" | "ITM2" | "ITM1" | "ATM" | "OTM1" | "OTM2" | "OTM3",
  "quantity": 75,
  "product": "MIS",
  "instance_id": "primary-or-assigned",
  "reason": "watchlist_quick_action"
}
```

### 5.2. Behavior by Trade Type
- **Equity/Futures/Direct Options** → `[BUY] [SELL] [EXIT]`  
- **Options Group Buttons** → `[BUY_CE] [SELL_CE] [BUY_PE] [SELL_PE] [EXIT_ALL]`  
- `EXIT_ALL` closes **all CE and PE positions** for the current expiry.

---

## 🔄 6. Options Order Logic (Updated)

### When the user clicks `[BUY CE]`:
1. Identify the **target strike** using the **underlying LTP**, **strike step**, and the **selected ITM/OTM offset**.
2. Fetch all **open positions** for the same **underlying** and **expiry**.
3. If there are any **short CE positions**, even if they are **at different strikes** but belong to the same underlying:
   - Set their `position_size` to **0** (close all of them).
   - If multiple short positions exist at different strikes, **close all** of them.
   - Then **open a new long position** using the latest strike symbol corresponding to the target level, with the configured **quantity**.
4. If after closing shorts, there’s still a net long requirement, open or increase the **long CE** position at the **current target strike**.

### When the user clicks `[SELL CE]`:
1. Identify the **target strike** using **LTP + strike step + ITM/OTM offset**.
2. Fetch all existing **open positions** for the same **underlying** and **expiry**.
3. If there are any **long CE positions**, even if they are at different strikes but the same underlying:
   - Set their `position_size` to **0** (close all of them).
   - If multiple long positions exist at different strikes, **close all** of them.
   - Then **open a new short position** using the updated strike symbol matching the required **quantity**.
4. If after closing longs, additional short exposure is still required, open a **new short CE** at the correct target strike.

### Same Logic for `[BUY PE]` and `[SELL PE]`
The same sequence of logic applies identically to **PUT options**, where “CE” simply changes to “PE”.

---

## ⏱️ 7. Expiry Auto-Refresh Mechanism

- **Auto-refresh schedule:** Every **Wednesday and Friday at 08:00 AM IST**.
- **Fallback refresh:** If quotes fail or the existing expiry becomes invalid.
- This ensures the Options configuration always points to the **nearest valid expiry**.

Example configuration field:
```json
{
  "expiry_mode": "AUTO",
  "last_refreshed_at": "2025-11-11T08:00:00+05:30"
}
```

---

## 📡 8. LTP Broadcast & Refresh

- LTP updates are managed by a **central broadcast** every **15 seconds**.
- All watchlist UIs subscribe to this broadcast, ensuring consistent prices across all clients.
- Users can still click the **refresh icon** to force a manual update if needed.

---

## ✅ 9. Assumptions & Dependencies

1. The **OptionSymbol** API provides a consistent strike interval for each underlying and expiry.
2. Assigned OpenAlgo instances (e.g., Flattrade, Shoonya) are already linked to each watchlist row.
3. placequickorder internally calls placesmartorder for actual order routing and reconciliation.
4. The position reconciliation and trade-close logic remain consistent with the existing app.

---

## 🏁 Summary

This enhancement makes the Watchlist and Add Symbol modules:
- Smarter: Dynamically adapts to the tradability of each symbol.
- Cleaner: Moves symbol-type logic to Product & Order Type section.
- Faster: Centralized price broadcasts avoid redundant polling.
- Safer: Automatic expiry and position reconciliation minimize manual intervention.
- Scalable: Uniform payloads across Equity, Futures, and Options simplify backend logic.

---

**Author:** Simplifyed Development Team  
**Version:** 1.1  
**Date:** November 11, 2025
