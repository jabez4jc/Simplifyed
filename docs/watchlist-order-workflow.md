# Watchlist Quick-Order Workflow (Front-End ↔ Back-End Integration)

This document explains, in depth, how the watchlist page renders its trading controls and how those controls submit orders to the backend. It also highlights the current failure mode where all orders for index symbols (e.g., `NIFTY`) are rejected with:

```
✕ Order failed: Symbol NIFTY (type: INDEX) does not support options trading. To trade options, add an OPTIONS-type symbol or set tradable_options=1.
```

Understanding each step will make it clear why that message appears and what needs to change.

---

## 1. Watchlist Interaction Flow (Dashboard Layer)

**Relevant file:** `backend/public/js/dashboard.js`

1. `DashboardApp.renderWatchlistsView()` builds a grid of watchlist cards.
2. Each card lists its symbols via `renderWatchlistSymbols()`, which renders a table row per symbol (`<tr class="symbol-row" ...>`).
3. Every row exposes a chevron button (`btn-toggle-expansion`) that calls `quickOrder.toggleRowExpansion(watchlistId, symbolId)` when clicked.
4. The toggle inserts a hidden `<tr id="expansion-row-${symbolId}">` directly after the row and, on first expansion, asks the `QuickOrderHandler` to load the UI.

This layout means the Dashboard is only responsible for wiring the DOM hooks; everything else—state management, control rendering, and order placement—lives in `QuickOrderHandler`.

---

## 2. QuickOrderHandler State Machine

**Relevant file:** `backend/public/js/quick-order.js`

When the handler is created it initializes several `Map`s keyed by watchlist symbol ID:

| Map | Purpose |
| --- | --- |
| `expandedRows` | Tracks expanded/collapsed state |
| `selectedTradeModes` | Remembers current `DIRECT/FUTURES/OPTIONS` mode |
| `selectedOptionsLegs` | Stores ITM/ATM/OTM leg offset |
| `selectedExpiries` / `availableExpiries` | Cache expiry selections and fetches |
| `operatingModes` | `BUYER` or `WRITER` for options |
| `strikePolicies` | `FLOAT_OFS` or `ANCHOR_OFS` |
| `defaultQuantities` / `stepLots` | Per-symbol lot count |
| `writerGuards` | Toggle for writer protective mode |

This client-side cache lets each symbol “remember” its settings even if the user collapses/expands rows repeatedly.

---

## 3. Rendering the Trade Controls (Front-End)

When a row is expanded, `loadExpansionContent()` performs the following steps:

1. **Read DOM attributes:** The method pulls `data-symbol`, `data-exchange`, and the “Type” badge to learn whether the symbol is `INDEX`, `EQUITY`, `FUTURES`, etc.
2. **Decide default trade mode:** `getDefaultTradeMode()` maps symbol types to trade modes:
   - EQUITY_ONLY/EQUITY_FNO/UNKNOWN → `EQUITY`
   - FUTURES/OPTIONS (raw instruments) → `EQUITY` (still uses BUY/SELL/EXIT UI)
   - INDEX → `OPTIONS` (assumes we want quick CE/PE legs)
3. **Populate state maps:** If the symbol has no saved values, the handler seeds them (e.g., options leg defaults to ATM, quantity to 1, operating mode to BUYER, strike policy to FLOAT_OFS).
4. **Fetch expiries when needed:** For FUTURES or OPTIONS modes, it calls `api.getExpiry()` (via `fetchAvailableExpiries`). The call selects the first active instance that has order placement enabled, resolves underlying symbol, and caches the expiry list.
5. **Normalize expiry format:** All expiries are stored in `YYYY-MM-DD` to match backend expectations. DD-MMM-YY inputs (e.g., `18-NOV-25`) are converted via `normalizeExpiryDate`.
6. **Render fields:** `renderTradingControls()` builds a two-column layout:
   - Left column uses `renderField(label, help, controlHtml)` to output each control with a tooltip button (the info icon you now see).
   - Right column renders action grids tailored to the trade mode:
     - `EQUITY/FUTURES`: simple BUY / SELL / EXIT buttons.
     - `OPTIONS`: CE section (BUY/REDUCE or SELL/INCREASE), PE section, and Exit options (`CLOSE ALL CE/PE`, `EXIT ALL`).
7. **Enable/Disable actions:** `isOptionsModeConfigured()` ensures required data (expiry, options leg, etc.) exists before enabling options buttons. All action buttons share the `.btn-quick-action` class, allowing the handler to disable/enable them as a group while orders are in flight.

The rendering logic is therefore highly dynamic: it selects defaults based on the symbol type, fetches derivative metadata, and shows only the controls that make sense for the chosen mode.

---

## 4. Placing an Order (Front-End → API)

When a button is clicked:

1. **`placeOrder(watchlistId, symbolId, action)`** runs.
2. It re-reads the DOM row to double-check the symbol and exchange (this ensures we always use the latest data if the table was re-rendered).
3. It retrieves all cached selections from the various maps: trade mode, quantity, expiry, options leg, operating mode, strike policy.
4. **Validation:** Quantity must be > 0. Additional validations are centrally handled in `_validateOrderParams` on the backend, but the front-end already blocks options-specific buttons unless you are in OPTIONS mode.
5. **Payload construction:** The handler builds the POST body for `/api/v1/quickorders`:
   ```json
   {
     "symbolId": 123,
     "tradeMode": "OPTIONS",
     "action": "BUY_CE",
     "quantity": 2,
     "expiry": "2025-11-28",
     "optionsLeg": "ATM",
     "operatingMode": "BUYER",
     "strikePolicy": "FLOAT_OFS",
     "stepLots": 2
   }
   ```
   - `expiry` is supplied only for FUTURES/OPTIONS.
   - `optionsLeg`, `operatingMode`, `strikePolicy`, and `stepLots` are included only for OPTIONS actions.
6. **UI state while pending:** All `.btn-quick-action` elements inside the expansion row are disabled and get a `loading` class until the API responds.
7. **Sending the order:** `api.placeQuickOrder()` hands the body to `/quickorders` (see `backend/public/js/api-client.js:369-378`).
8. **Handling the response:** The backend returns a per-instance results array plus a summary `{ total, successful, failed }`. The handler shows toast notifications:
   - Pure success → green toast
   - Partial success/failure → warning with the ratio
   - Full failure → red toast
   It also logs per-instance errors to the console so we have full context in dev tools.

This means the front-end is correctly building the payload; the repeated “symbol does not support options trading” error originates from the backend validation layer.

---

## 5. Backend Validation That Rejects These Orders

**Relevant file:** `backend/src/services/quick-order.service.js`

```js
const optionsActions = [
  'BUY_CE','SELL_CE','BUY_PE','SELL_PE','EXIT_ALL',
  'REDUCE_CE','REDUCE_PE','INCREASE_CE','INCREASE_PE',
  'CLOSE_ALL_CE','CLOSE_ALL_PE'
];
if (optionsActions.includes(action)) {
  if (symbol.symbol_type !== 'OPTIONS' && symbol.tradable_options !== 1) {
    throw new ValidationError(
      `Symbol ${symbol.symbol} (type: ${symbol.symbol_type}) does not support options trading...`
    );
  }
}
```

Key observations:

1. `symbol` comes from the `watchlist_symbols` table. For most watchlists, entries such as `NIFTY` are stored as `symbol_type = 'INDEX'` with `tradable_options = 0`.
2. The front-end defaults index symbols to OPTIONS mode (see `getDefaultTradeMode`), then calls BUY_CE / etc.
3. The backend rejects these because the underlying record is **not** an OPTIONS symbol and has `tradable_options = 0`.
4. The error message matches the toast you’re seeing.

Therefore, the current workflow cannot trade derivative legs against index rows unless the watchlist symbol itself either:
- is an `OPTIONS` instrument, or
- explicitly sets `tradable_options = 1` (so the backend knows this index can spawn options chains).

---

## 6. Suggested Fix / Next Steps

To restore watchlist-based options trading for index rows we need to align the data rules with how the UI behaves. Two approaches:

1. **Mark applicable symbols as option-enabled:** Whenever we ingest watchlist symbols for `INDEX` entries like `NIFTY`, set `tradable_options = 1`. That satisfies the backend guard and tells downstream logic that options can be resolved dynamically. This can be done with a migration or by updating the symbol-classification service so that indexes automatically flip the flag.

2. **Adjust the UI default:** If the backend requirement is intentional (i.e., you must add a dedicated OPTIONS symbol), then `getDefaultTradeMode` should *not* default INDEX rows to OPTIONS mode unless `tradable_options` is already flagged. The UI can read the badge or a new data attribute to decide whether to show the options controls.

Given the current product vision (trade CE/PE from index watchlist rows), option #1 is more aligned. Option #2 would simply hide the buttons instead of fixing the capability.

Until this is addressed, every OPTIONS action triggered from an INDEX row will fail with the validation error shown above, even though the front-end configures the payload correctly.

---

## 7. Recap of the Full Workflow

1. **User expands a symbol** → QuickOrderHandler loads current state, fetches expiries if needed, and renders controls with info-tooltips.
2. **User configures trade mode/leg/quantity** → choices are stored per symbol.
3. **User hits BUY/SELL/etc.** → payload is composed and posted to `/api/v1/quickorders`.
4. **Backend validates symbol/trade mode compatibility** → rejects OPTIONS actions when the watchlist symbol is not flagged as options-tradable.

Fixing the `tradable_options` mapping (or changing the default trade mode) will remove the last failure point and allow the workflow to operate as designed.
### 5.5 Derivative resolution is currently missing

Even when `tradable_options = 1` for newly-added symbols, `_executeOrderStrategy()` still sends the watchlist row itself (`symbol.symbol`) to the instance. For an `INDEX` row that means “NIFTY”, not the actual CE/PE contract. Instances reject these tokens because they are not derivatives. The option-chain service already exposes the correct derivative instruments in the `instruments` table, but the quick-order flow never calls it.
