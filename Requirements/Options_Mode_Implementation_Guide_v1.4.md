# Options Mode — Buyer/Writer Implementation Guide (No‑Risk, Non‑Breaking)
**Version:** 1.4  
**Updated:** 2025-11-17 05:10:01 IST

**One‑liner:** Add Buyer/Writer buttons for **Index Options** with **deterministic target‑position control**. No API changes. No new payload fields. No TP/SL/TSL.

---

## 1) Purpose & Promise (plain English)
- You will trade Index Options with two modes: **Buyer** (go long premium) and **Writer** (go short premium).
- Each click sets a **target position** (contracts you want right now). OpenAlgo instances trade **only the delta** to reach that target → **no accidental stacking**.
- As **ATM moves**, you may hold **multiple strikes** (FLOAT_OFS). Your **reduce/close/exit** actions apply across **all open strikes** for the **selected expiry**, unless you anchor the strike.
- This guide **does not change endpoints or payload keys**. It is 100% **non‑breaking**.

---

## 2) Quick Glossary
- **TARGET POSITION (`position_size`)**: The desired total contracts for a leg/type **now**.
- **DELTA**: The difference to trade so current → target. `delta = target - current`.
- **LEG**: One specific option symbol (e.g., `NIFTY05DEC25C22450` for the chosen expiry).
- **TYPE**: CE or PE **across all strikes** for the selected expiry.
- **FLOAT_OFS**: Offsets (ATM/ITM/OTM) float with price; new clicks may resolve **new strikes**.
- **ANCHOR_OFS**: First click **pins** the strike; later clicks reuse it until you change offset/expiry.
- **Qstep**: Contracts per click. For Options: `Qstep = step_lots × lotsize(resolved option)`.

---

## 3) Zero‑Breaking Principles
- **No new endpoints, no new fields.** Keep using your existing **order payload** (e.g., `placesmartorder`) with **`position_size`**.
- **Server is authoritative** for symbol resolution and targets. Instances **must not** re‑resolve symbols.
- All **“close/cover”** behaviors are implemented by **lowering targets** to 0 at the right scope; instances trade the delta.
- Retain your existing **allocation policy** across legs (LIFO/FIFO/proportional). We never override it.

---

## 4) Modes & Buttons (authoritative semantics)

### 4.1 Buyer mode (cover **longs** by **selling**)
- `BUY_CE` → `target = current + Qstep` (add CE longs)
- `REDUCE_CE` → `target = max(0, current - Qstep)` (**sell** CE to reduce longs)
- `CLOSE_ALL_CE` → CE target = **0** (selected expiry; **sell** all CE longs)

- `BUY_PE` → `target = current + Qstep` (add PE longs)
- `REDUCE_PE` → `target = max(0, current - Qstep)` (**sell** PE to reduce longs)
- `CLOSE_ALL_PE` → PE target = **0** (selected expiry; **sell** all PE longs)

- `EXIT_ALL` → CE target = **0** **and** PE target = **0** (selected expiry; **sell** all longs)

### 4.2 Writer mode (cover **shorts** by **buying back**)
- `SELL_CE` → `target = current - Qstep` (**open/add** CE short)
- `INCREASE_CE` → `target = min(0, current + Qstep)` (**buy back** CE to **reduce** short; clamp at 0 if Writer guard prevents net‑long)
- `CLOSE_ALL_CE` → CE target = **0** (selected expiry; **buy back** all CE shorts)

- `SELL_PE` → `target = current - Qstep` (**open/add** PE short)
- `INCREASE_PE` → `target = min(0, current + Qstep)` (**buy back** PE to **reduce** short; clamp at 0 if Writer guard prevents net‑long)
- `CLOSE_ALL_PE` → PE target = **0** (selected expiry; **buy back** all PE shorts)

- `EXIT_ALL` → CE target = **0** **and** PE target = **0** (selected expiry; **buy back** all shorts)

> **Naming note (non‑breaking):** We retain the **INCREASE_*** label in UI. Document/tooltips should clarify it **buys back** to **reduce** the short exposure.

---

## 5) ATM Drift & Strike Scope
**When using `FLOAT_OFS`:**
- New **add** clicks may open **new strikes** as ATM changes.
- Buyer **REDUCE/CLOSE/EXIT** **sell** across **all open strikes** of that TYPE (CE/PE) for the **selected expiry**.
- Writer **INCREASE/CLOSE/EXIT** **buy back** across **all open strikes** of that TYPE (CE/PE) for the **selected expiry**.

**When using `ANCHOR_OFS`:**
- The **first add** pins a strike. Follow‑ups reuse it until you change offset/expiry.
- Reduce/close/exit operate on that anchored leg. If you happen to hold extra legs (e.g., legacy), they’re handled by your existing allocation policy.

**Cross‑expiry safety:** All actions are **scoped to the selected expiry** only.

---

## 6) UI/UX Wiring (pragmatic)
**Show the Options action bar only after these are set:**
1) **Operating Mode**: Buyer | Writer  
2) **Expiry**: dropdown (mandatory)  
3) **Strike Offset**: `ATM`, `ITM±n`, `OTM±n`  
4) **Strike Policy**: `FLOAT_OFS` (default) | `ANCHOR_OFS`  
5) **Step Lots**: lots per click (Options → derives Qstep)

**Validation UX**
- Disable buttons until required inputs are present.
- Display a **context chip** beside the action bar: `Mode • Offset • Policy • step_lots`.

---

## 7) Server Control Plane (no risk logic)
- **Order Orchestrator**: Resolves symbol(s) via OptionSymbol, computes **targets** from button semantics, issues orders to all mapped instances.
- **Fill Aggregator**: Polls order/trade books, maintains `net_qty` and `weighted_avg_entry` per leg/type for UI only.
- **Quote Router**: Streams quotes for live LTP (underlying or option premium as applicable).
- **Audit/State**: Persists intents (with resolved config snapshot), orders, fills. Must be restart‑safe.

---

## 8) Symbol Resolution (server only)
- Use your existing **OptionSymbol** flow with inputs:  
  `{{ underlying, exchange, expiry_date, option_type(CE|PE), strike_int, offset }}` → returns `{{ symbol, lotsize, tick_size }}`.
- Instances **must not** re‑resolve symbols; they execute the server‑sent symbols verbatim.

---

## 9) Target‑Delta Algorithm (reference)
**Core invariant:** Instances execute only **delta** to reach the server’s **target**.

**Pseudo:**
```text
onButtonClick(row, button):
  cfg  = readEffectiveConfig(row)        # includes mode, offset, policy, step_lots
  legs = resolveSymbolsIfNeeded(cfg)     # OptionSymbol only when adding new CE/PE
  curr = readAggregatedPosition(row, scope=TYPE or INDEX)

  Qstep = cfg.step_lots * legs.lotsize   # for Options; for Futures/Direct use step_contracts

  target = computeTarget(curr, button, Qstep, writer_guard=cfg.writer_guard)

  for leg in selectedLegs(button, cfg):
      sendOrder(
        position_size = targetFor(leg, target, allocationPolicy),
        # quantity (delta) is computed inside the instance from position_size - current
      )
```

**Allocation policy remains yours** (LIFO/FIFO/proportional). The server sets **totals** per TYPE; decomposition across legs follows your existing policy.

---

## 10) Order Payload (unchanged)
Use your existing OpenAlgo payload (example below). **No new fields**.
```json
{{
  "apikey": "<OPENALGO_API_KEY>",
  "strategy": "Watchlist-Orchestrator",
  "exchange": "NFO",
  "symbol": "<RESOLVED_SYMBOL>",
  "action": "BUY|SELL",
  "product": "MIS",
  "pricetype": "MARKET",
  "quantity": "<deltaContracts>",
  "position_size": "<targetContracts>",
  "price": "0",
  "trigger_price": "0",
  "disclosed_quantity": "0"
}}
```

---

## 11) Settings & Precedence (DB‑backed; .env bootstrap only)
**Minimum knobs (reuse existing if present):**
- `default_strike_policy` (`FLOAT_OFS` | `ANCHOR_OFS`)
- `step_lots` (Options), `step_contracts` (Futures/Direct)
- `disallow_auto_reverse` (Futures/Direct only)
- `allow_hedge_longs_in_writer` (if **false**, covering shorts clamps at 0 → never flips net‑long)

**Precedence (last wins):** Global → Index → Watchlist → User → Symbol → **Click override** (snapshot into intent).

**Settings API (unchanged shape):**
- `GET /settings/effective?user_id&watchlist_id&index&symbol`
- `PATCH /settings/global|index/:index|watchlist/:id|user/:id|symbol/:symbol`

---

## 12) Debounce, Idempotency, Errors
- **Debounce** rapid clicks (UI) to avoid duplicate intents.
- **Idempotency** keys on the server (intent_id) to de‑dupe retries.
- **Cancel‑then‑Exit**: For `CLOSE_ALL_*` and `EXIT_ALL`, cancel pendings before flattening targets.
- **Error surfacing**: Show precise rejection reason (margin, instrument not found, market closed, etc.). No retry storms.

---

## 13) Acceptance Criteria & QA Suite
**Functional**
1) **Buyer‑CE pyramid**: `BUY_CE` twice (FLOAT_OFS) → possibly two CE strikes. `CLOSE_ALL_CE` → CE total goes to 0 (all strikes).  
2) **Buyer‑PE reduce**: `BUY_PE` once → `REDUCE_PE` once → PE decreases by exactly **Qstep** (or to 0).  
3) **Writer‑PE add & cover**: `SELL_PE` twice (ANCHOR_OFS), then `INCREASE_PE` once → absolute PE short reduces by **Qstep** (no net‑long if guard on).  
4) **EXIT_ALL**: With mixed CE/PE positions → `EXIT_ALL` flattens both CE and PE for the **selected expiry** only.  
5) **Expiry isolation**: Open on two expiries; close one; the other stays intact.  
6) **No re‑resolution in instances**: Change server’s strike policy and add again → instances still execute the symbols received.

**Non‑functional**
7) **No new fields/endpoints** used.  
8) **Deterministic deltas** even under latency (orders reflect target deltas only).  
9) **Restart safety**: After orchestrator restart, state rebuilds from books and targets remain consistent.

---

## 14) Implementation Snippets (reference only)

**Compute target (Writer guard aware):**
```text
computeTarget(curr, button, Qstep, writer_guard):
  if button in [SELL_CE, SELL_PE]:
     return curr - Qstep
  if button in [INCREASE_CE, INCREASE_PE]:
     t = curr + Qstep        # buying back shorts reduces the negative
     return min(0, t) if writer_guard else t
  if button in [CLOSE_ALL_CE, CLOSE_ALL_PE, EXIT_ALL]:
     return 0
  # Buyer path:
  if button in [BUY_CE, BUY_PE]:
     return curr + Qstep
  if button in [REDUCE_CE, REDUCE_PE]:
     return max(0, curr - Qstep)
```

**Scope selection (TYPE vs INDEX):**
```text
selectedLegs(button, cfg):
  if button in [CLOSE_ALL_CE, REDUCE_CE, INCREASE_CE, SELL_CE, BUY_CE]:
     return all CE legs for selected expiry
  if button in [CLOSE_ALL_PE, REDUCE_PE, INCREASE_PE, SELL_PE, BUY_PE]:
     return all PE legs for selected expiry
  if button == EXIT_ALL:
     return all CE and PE legs for selected expiry
```

**Order emission (server → all mapped instances):**
```text
for leg in selectedLegs(button, cfg):
    target_for_leg = decomposeTotalTarget(target, allocationPolicy)  # your existing logic
    sendOrder(instance, symbol=leg.symbol, position_size=target_for_leg)
```

---

## 15) Rollout Checklist
- [ ] Feature‑flag the **Options Buyer/Writer** bar per watchlist.
- [ ] Add tooltips explaining **INCREASE_*** (buy back to reduce shorts).
- [ ] Confirm **FLOAT_OFS vs ANCHOR_OFS** behaviors against QA suite.
- [ ] Verify Writer guard (if enabled) clamps at **0** on cover.
- [ ] Confirm **no payload or endpoint changes** in code review.
- [ ] Update operator runbook screenshots.

---

## 16) FAQs
**Q: Does this affect Futures or Direct Symbols?**  
A: No. They remain `BUY / SELL / EXIT` with target‑position semantics.

**Q: Can I accumulate strikes when ATM moves?**  
A: Yes with `FLOAT_OFS`. Your reduce/close actions span **all open strikes** for that TYPE and expiry.

**Q: Why keep INCREASE_* for covering shorts?**  
A: To avoid breaking the UI. We clarify with tooltips/docs that **INCREASE_*** **buys back** shorts to **reduce** exposure.

**Q: What if I want strict one‑strike behavior?**  
A: Use `ANCHOR_OFS` so add clicks reuse the same strike until you change offset/expiry.
