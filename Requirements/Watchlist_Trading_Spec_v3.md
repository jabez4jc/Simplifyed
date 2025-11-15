# Watchlist Trading Spec — Index Options, Futures & Direct Symbols
**Server-Side TP/SL/TSL • Per-Unit Risk • Pyramiding • Non-Accumulation • DB‑Backed Settings**
**Version:** 3.0  
**Updated:** 2025-11-15 20:30:33 IST


## Who this is for (plain English)
- You trade from a **Watchlist**. Each row is an **Index or Symbol** with a live price (LTP).
- You can trade:
  - **Index Options** (NIFTY/BANKNIFTY/FINNIFTY/SENSEX) with Buyer/Writer workflows.
  - **Futures** or **Direct Symbols** (equities, futures, or specific option symbols) with simple BUY/SELL/EXIT.
- The **server** is the brain: it resolves symbols, sets **target positions**, sends orders to all mapped OpenAlgo instances, and **enforces TP/SL/TSL**.
- Risk is **per-unit (contract) points**, so lot-size changes don’t affect where stops/targets sit.
- **No accidental position stacking**: every click sets a **target**; instances only move the **difference** to reach that target.

---

## Table of Contents
1. [Quick glossary](#quick-glossary)
2. [Modes and buttons](#modes-and-buttons)
3. [UI flow (Watchlist)](#ui-flow-watchlist)
4. [Server control plane](#server-control-plane)
5. [Symbol resolution](#symbol-resolution)
6. [Targets, deltas & non-accumulation](#targets-deltas--non-accumulation)
7. [Risk (TP/SL/TSL) — per-unit, server-side](#risk-tpsltsl--per-unit-server-side)
8. [Scope (LEG / TYPE / INDEX) in simple terms](#scope-leg--type--index-in-simple-terms)
9. [Runtime overrides & settings precedence](#runtime-overrides--settings-precedence)
10. [DB schema (settings)](#db-schema-settings)
11. [Settings API](#settings-api)
12. [Trade payloads](#trade-payloads)
13. [Button math](#button-math)
14. [Risk math: examples](#risk-math-examples)
15. [Acceptance criteria & QA checklist](#acceptance-criteria--qa-checklist)
16. [Operational guardrails](#operational-guardrails)
17. [Appendix: FAQs](#appendix-faqs)

---

## Quick glossary
- **Index Options:** Options on indices like NIFTY/BANKNIFTY/FINNIFTY/SENSEX. **CE** = Call, **PE** = Put; **Expiry** = last trade date.
- **Futures:** Contracts moving point-for-point with the index/symbol.
- **Direct Symbol:** You already know the exact tradable symbol (equity, future, or option); no chain resolution required.
- **Per-unit point:**
  - Options → **premium points** per contract (e.g., SL=20 means ₹20 on option price).
  - Futures/Equity → **instrument points** per contract (e.g., SL=40 index points).
- **Lot size:** Contracts per lot (varies by instrument). We deliberately **avoid** using it in risk numbers.
- **Leg:** One tradable instrument (e.g., `NIFTY20NOV25C22450` or `NIFTY25NOV25FUT`).

---

## Modes and buttons
### A) Index Options (based on an underlying Index)
**Operating Modes**
- **Buyer** (long premium) → Buttons: `BUY_CE · REDUCE_CE · CLOSE_ALL_CE · BUY_PE · REDUCE_PE · CLOSE_ALL_PE · EXIT_ALL`
- **Writer** (short premium) → Buttons: `SELL_CE · INCREASE_CE · CLOSE_ALL_CE · SELL_PE · INCREASE_PE · CLOSE_ALL_PE · EXIT_ALL`

**Strike Policy (how strikes are chosen across clicks)**
- **FLOAT_OFS (default):** Each click can re-resolve (ATM/ITM/OTM moves with market). Accumulate positions at multiple strikes.
- **ANCHOR_OFS:** First click pins the strike; next clicks reuse it until the user changes offset/expiry.

### B) Futures / Equity / Direct Option Symbol
**Buttons:** `BUY · SELL · EXIT` (covers all scenarios).
- `BUY`: increases longs or reduces/closess shorts; can flip side if allowed.
- `SELL`: increases shorts or reduces/closes longs; can flip side if allowed.
- `EXIT`: cancels pendings and flattens to zero.
- Optional toggle: **Disallow auto-reverse** (clamp at 0 instead of flipping side in one click).

---

## UI flow (Watchlist)
Each row shows: `Index/Symbol` • `LTP (auto refresh)` • `Trade Mode` selector

- If **Index Options**: choose **Operating Mode** (Buyer/Writer) and **Expiry**; optional **Strike Offset** (ATM/ITM±n/OTM±n). Action bar appears.
- If **Futures/Direct Symbol**: action bar shows `BUY/SELL/EXIT`.
- **Risk Panel (always available before placing a trade):** TP/SL/TSL in **per-unit points** with an option to:
  - **Use once** (this trade only), or
  - **Save as default** for this Index/Watchlist/User (writes to DB, not `.env`).

---

## Server control plane
**Authoritative roles (server does the thinking; instances just execute):**
1) **Order Orchestrator** — Resolves symbol(s), computes **target position**, broadcasts deltas to OpenAlgo instances.
2) **Fill Aggregator** — Polls `orderbook/tradebook`, maintains per-leg `net_qty`, `weighted_avg_entry`, `best_favorable`, `last_trail_px`.
3) **Quote Router** — Streams quotes (option premium for options; underlying price for futures/equity).
4) **Risk Engine** — Enforces **TP/SL/TSL per unit**; fires one **market EXIT** when thresholds hit.
5) **Audit/State** — Persists leg state & intents; restart-safe.

**Anchor Mode (for risk entry averages)**
- `GLOBAL` (default): One anchor across all instances (single coherent TP/SL/TSL).
- `PER_INSTANCE`: Separate anchors/exits per instance (fine-grained, more events).

---

## Symbol resolution
- **Index Options:** Use **OptionSymbol** API with inputs `{ underlying, exchange, expiry_date, option_type (CE|PE), strike_int, offset }`. It returns authoritative `{ symbol, lotsize, tick_size }`.
- **Futures:** Resolve futures symbol for the selected index+expiry (via a search endpoint or static map).
- **Direct Symbol:** Take the symbol as given (or resolve via search if needed).
**Instances must not re-resolve** symbols; they execute the server’s symbols as-is.

---

## Targets, deltas & non-accumulation
- The server always sends **position_size (target)**; the instance computes **delta = |target - current|** and trades only the difference.
- This guarantees **no accidental stacking**. Repeated clicks are intentional **pyramiding** (increasing the target).

---

## Risk (TP/SL/TSL) — per-unit, server-side
- **Per-unit** means points per contract (premium for options; instrument price for futures/equity).
- **Long leg**: `tp_px = entry + tp_per_unit`, `sl_px = entry - sl_per_unit`.
- **Short leg**: `tp_px = entry - tp_per_unit`, `sl_px = entry + sl_per_unit`.
- **Trailing Stop (TSL):**
  - `arm_after`: start trailing only after unrealized gain ≥ X.
  - `trail_by`: keep stop X points behind the best favorable price.
  - `step`: move stop only in steps ≥ this value (cuts noise).
  - `breakeven_after`: once gain ≥ Y, never trail past entry.
- **Pyramiding**: default `on_pyramid = reanchor` → recompute weighted-avg entry & reset TP/SL/TSL; `scale` (advanced) keeps child slices; `ignore` adds size but keeps anchors.
- **Scope for risk exits**: start with **LEG**. TYPE/INDEX can close multiple legs at once (see below).

---

## Scope (LEG / TYPE / INDEX) in simple terms
- **LEG (default):** Only the specific symbol you traded. (Easiest and safest.)
- **TYPE:** All **calls** (CE) or all **puts** (PE) for the same index+expiry.
- **INDEX:** All options legs (CE+PE) for the same index+expiry.
> If unsure, use **LEG**. TYPE/INDEX are portfolio-level behaviors.

---

## Runtime overrides & settings precedence
When placing a trade, resolve **effective settings** in this order (last wins):
1) **Global defaults** (DB)
2) **Per-Index profile** (e.g., NIFTY/BANKNIFTY…)
3) **Per-Watchlist overrides** (optional)
4) **Per-User defaults** (optional)
5) **Per-Symbol overrides** (Direct/Futures, optional)
6) **Per-Click UI overrides** (applies once; snapshot into intent)

- `.env` holds **bootstrap** and **secrets** only. Store live-tunable settings in **DB** + Admin **Settings UI**.

---

## DB schema (settings)
**Tables (illustrative):**

**1) `global_defaults`** (one row)
- `ltp_refresh_seconds` int
- `default_strike_policy` enum('FLOAT_OFS','ANCHOR_OFS')
- `default_step_lots` int, `default_step_contracts` int
- Risk per-unit: `tp_per_unit`, `sl_per_unit`, `tsl_enabled`, `tsl_trail_by`, `tsl_step`, `tsl_arm_after`, `tsl_breakeven_after`
- Flags: `disallow_auto_reverse` bool

**2) `index_profiles`** (one per index)
- `index` PK  
- `exchange_segment` (e.g., 'NSE_INDEX','BSE_INDEX')
- `strike_step` int, `risk_anchor_mode` enum('GLOBAL','PER_INSTANCE')
- Optional risk overrides (same fields as global; nullable = inherit)
- UI defaults: `default_offset` ('ATM','ITM2',...) , `default_product` ('MIS','NRML')

**3) `watchlist_overrides`**
- `watchlist_id` + optional `index` (composite PK)
- Optional overrides (nullable = inherit)

**4) `user_defaults`**
- `user_id` PK + optional overrides

**5) `symbol_overrides`** (for Futures/Direct)
- `symbol` PK + optional overrides

**6) `config_audit`**
- `id`, `scope` enum('GLOBAL','INDEX','WATCHLIST','USER','SYMBOL'), `scope_key`, `changed_json`, `changed_by`, `changed_at`

**7) `intents`** (existing trade intents)
- Add `resolved_config_json` (the merged snapshot used for this trade)

---

## Settings API
- `GET /settings/effective?user_id&watchlist_id&index&symbol` → merged config for UI and pre-trade preview
- `PATCH /settings/global` → edit global defaults
- `PATCH /settings/index/:index` → edit per-index profile
- `PATCH /settings/watchlist/:watchlistId` → edit per-watchlist
- `PATCH /settings/user/:userId` → edit per-user defaults
- `PATCH /settings/symbol/:symbol` → edit per-symbol overrides
- All writes append to `config_audit` and return the new effective view for confirmation

---

## Trade payloads
### A) Intent snapshot (server audit + risk loop; instances ignore `risk`)
```jsonc
{
  "intent_id": "uuid",
  "watchlist_id": "WL-DEFAULT",
  "ts": "2025-11-16T12:05:00+05:30",
  "trade_mode": "OPTIONS | FUTURES | DIRECT",
  "index": "NIFTY",
  "symbol": "NIFTY25NOV25FUT",
  "mode": "Buyer | Writer",
  "expiry": "20NOV2025",
  "strike_policy": "FLOAT_OFS | ANCHOR_OFS",
  "offset": "ATM | ITM2 | OTM3",
  "step_lots": 1,
  "step_contracts": 1,
  "lotsize": 50,
  "risk": {
    "enabled": true,
    "scope": "LEG",
    "on_pyramid": "reanchor",
    "tp_per_unit": 30,
    "sl_per_unit": 20,
    "tsl": {
      "enabled": true,
      "trail_by": 15,
      "step": 5,
      "arm_after": 10,
      "breakeven_after": 12
    },
    "anchor_mode": "GLOBAL"
  }
}
```

### B) Order (server → instance) — delta to reach target
```json
{
  "apikey": "<OPENALGO_API_KEY>",
  "strategy": "Watchlist-Orchestrator",
  "exchange": "NFO",
  "symbol": "NIFTY25NOV25FUT",
  "action": "BUY",
  "product": "MIS",
  "pricetype": "MARKET",
  "quantity": "1",
  "position_size": "3",
  "price": "0",
  "trigger_price": "0",
  "disclosed_quantity": "0"
}
```

### C) Risk exit (server → instance)
- If **long**: send `SELL` with `position_size=0` (market)
- If **short**: send `BUY` with `position_size=0` (market)
- Use an internal `risk_trigger_id` to de-duplicate

---

## Button math
Let **Qstep** be contracts per click.

**Index Options (Buyer)**
- `BUY_CE / BUY_PE`: target = `curr + Qstep`
- `REDUCE_*`: target = `max(0, curr - Qstep)`
- `CLOSE_ALL_*`: target = `0` for all CE or all PE of the selected expiry
- `EXIT_ALL`: target = `0` for all CE+PE of the selected index+expiry
- `Qstep = step_lots × lotsize(resolved option)`

**Index Options (Writer)**
- `SELL_/INCREASE_*`: target = `curr - Qstep` (more short)
- `BUY` (cover): target = `min(0, curr + Qstep)` if hedge-longs disabled (won’t go net long)
- `CLOSE_ALL_*` / `EXIT_ALL`: as above → targets to 0

**Futures / Equity / Direct Symbol**
- `BUY`: target = `curr + Qstep`
- `SELL`: target = `curr - Qstep`
- `EXIT`: target = `0`
- `Qstep = step_contracts` (default 1; row-configurable)
- Optional: **Disallow auto-reverse** → clamp target at 0 when crossing sides.

---

## Risk math: examples
**Long Option example**
- Entry ₹100 premium, `SL=20`, `TP=30` → stop at ₹80, target at ₹130.
- TSL armed at `arm_after=10`: if best price seen is ₹116 and `trail_by=15`, trail stop=₹101.
- With `step=5`, stop only moves if it can move by ≥₹5 from the last trail stop.
- With `breakeven_after=12`, stop won’t go below ₹100 after gains ≥₹12.

**Short Future example**
- Short 22,450, `SL=40`, `TP=80` → stop at 22,490, target at 22,370.
- TSL trails **above** best (lowest) price by `trail_by`.

---

## Acceptance criteria & QA checklist
- Buttons always set **targets**; instances execute **deltas** → no unintended accumulation.
- Index Options resolution is deterministic; instances never re-resolve symbols.
- Server enforces TP/SL/TSL in **per-unit points**; lot-size changes do not move levels.
- TSL arms only after `arm_after`, moves by `trail_by` in `step` chunks, respects `breakeven_after`.
- `GLOBAL` anchor mode produces one coherent exit across instances; `PER_INSTANCE` yields per-account exits.
- `CLOSE_ALL_*`/`EXIT_ALL` flatten exactly the intended scope with no leftovers; pendings are cancelled first.
- Duplicate clicks are debounced; risk exits are idempotent (single-shot).

**QA Scenarios**
1) **Futures**: BUY→BUY→SELL→EXIT; verify exact contract changes, optional anti-flip.
2) **Options Buyer**: `BUY_CE` twice with FLOAT_OFS → possibly two strikes; `CLOSE_ALL_CE` → both flat.
3) **Options Writer**: `SELL_PE` twice with ANCHOR_OFS → same strike pyramided; `BUY` twice → flat; never net long.
4) **Risk**: SL=20 points; drive price through SL → server fires single market exit; net goes to 0; audit shows trigger.
5) **UI override**: Change SL in pane; confirm server enforces override and intent snapshot stores it.
6) **Restart**: stop server mid-session; restart; rebuild leg state from tradebook/positionbook; risk resumes with correct anchors.

---

## Operational guardrails
- **Idempotency**: `(intent_id)` for entries/increases; `(risk_trigger_id)` for exits.
- **Locks**: per-leg mutex; for TYPE/INDEX also a group mutex to avoid race conditions.
- **Cadence**: quotes 50–200ms stream; trades/orders poll 1–2s; tune to venue limits.
- **Tick conformance**: TP/SL/TSL ≥ instrument `tick_size`.
- **Gaps/Slippage**: exits are market; log slippage; optionally add limit-emulation later.
- **Caching**: cache effective settings 30–60s; on DB outage, fall back to cache, then to `.env` seed.
- **RBAC**: Admins edit Global/Index/Watchlist; Traders edit User defaults + per-click overrides; Viewers read-only.

---

## Appendix: FAQs
**Q: Why per-unit risk?**  
A: It survives lot-size changes and is easy to reason about (points are universal).

**Q: When should I use TYPE or INDEX scope?**  
A: Only if you want one stop to close multiple legs at once. Start with **LEG**.

**Q: Can I add a new index without code changes?**  
A: Yes. Add it in the DB **Index Profiles** (exchange segment, strike step, risk defaults). UI will pick it up.

**Q: Do instances enforce risk?**  
A: No. The **server** decides TP/SL/TSL and sends one exit command when needed.
