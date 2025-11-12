# OpenAlgo: Classifying Equity vs Futures vs Options Using `/search` + `/symbol`

This playbook shows a deterministic, production‑grade method to fuse **Data API → `/search`** and **Data API → `/symbol`** to classify an input as **Equity**, **Futures**, or **Options** (across NSE/BSE/NFO, etc.).

---

## 1) Endpoint roles (what each gives you)

- **`/search`** — Broad lookup returning candidate instruments with fields like `symbol`, `exchange`, `instrumenttype`, `expiry`, `strike`, `lotsize`, `tick_size`, `brsymbol`, `brexchange`, `token`. Use this to **discover and disambiguate** the instrument.
- **`/symbol`** — Point lookup for a single `(symbol, exchange)` returning authoritative instrument metadata (same field family as above). Use this to **verify and enrich** the chosen candidate.

> Tip: OpenAlgo’s symbology is consistent: futures typically end with `FUT`, options with `CE`/`PE`, and equities have **no** `expiry`.

---

## 2) Deterministic classification rule

Given an instrument row resolved and verified via **`/symbol`**:

1. **Equity** if `instrumenttype == "EQ"` (or `expiry` is empty **and** no option suffix).
2. **Options** if `instrumenttype` starts with `"OPT"` **or** (`expiry` present **and** `strike` > 0 **and** `symbol` ends with `CE` or `PE`).
3. **Futures** if `instrumenttype` starts with `"FUT"` **or** (`expiry` present **and** (`strike` is `None` or `<= 0`) **and** symbol **not** ending with CE/PE).

This rule is robust to broker quirks such as `strike: -0.01` for non‑options instruments and empty `instrumenttype` in rare payloads, because it layers **type + structure** checks.

---

## 3) Selection pipeline (recommended)

**Input:** User text like `SBIN`, `BANKNIFTY28NOV25FUT`, or `NIFTY28NOV2522500CE` and, optionally, a preferred exchange.

**A. Search fan‑out**
- Call **`/search`** with `query=<user_input>`.
- If you know the venue, pass `exchange` (e.g., `NSE` for cash, `NFO` for F&O). Otherwise, run two passes (`NSE` + `NFO`) and merge candidates.

**B. Candidate narrowing**
- Prefer exact `symbol` match (case‑insensitive).
- Break ties by venue (`NFO` for derivatives‑looking inputs, `NSE/BSE` for cash), then by `expiry` policy (nearest/next per your business rule).

**C. Verify**
- Call **`/symbol`** on the chosen `(symbol, exchange)` to guard against stale search caches and to obtain `brsymbol/brexchange` for routing.

**D. Classify**
- Apply the rule in §2 → **Equity / Futures / Options**.

---

## 4) Field‑accurate reference implementation (Python)

```python
import requests

BASE = "https://<your-custom-domain>/api/v1"
APIKEY = "<your_app_apikey>"

def oa_search(query, exchange=None):
    body = {"apikey": APIKEY, "query": query}
    if exchange:
        body["exchange"] = exchange
    r = requests.post(f"{BASE}/search", json=body, timeout=5)
    r.raise_for_status()
    return r.json().get("data", [])

def oa_symbol(symbol, exchange):
    body = {"apikey": APIKEY, "symbol": symbol, "exchange": exchange}
    r = requests.post(f"{BASE}/symbol", json=body, timeout=5)
    r.raise_for_status()
    return r.json()["data"]

def classify_row(row):
    it = (row.get("instrumenttype") or "").upper()
    sym = (row.get("symbol") or "").upper()
    expiry = (row.get("expiry") or "").strip()
    strike = row.get("strike")

    # Primary: instrumenttype
    if it == "EQ":
        return "EQUITY"
    if it.startswith("OPT"):
        return "OPTIONS"
    if it.startswith("FUT"):
        return "FUTURES"

    # Secondary: structure checks
    if expiry and isinstance(strike, (int, float)) and strike > 0:
        if sym.endswith("CE") or sym.endswith("PE"):
            return "OPTIONS"
    if expiry and (strike is None or strike <= 0) and not (sym.endswith("CE") or sym.endswith("PE")):
        return "FUTURES"

    # Fallback
    return "EQUITY"

def resolve_and_classify(user_input, preferred_exchange=None):
    # A) fan-out search
    pools = []
    if preferred_exchange:
        pools.extend(oa_search(user_input, preferred_exchange))
    else:
        for ex in ("NSE", "NFO", "BSE"):
            pools.extend(oa_search(user_input, ex))

    if not pools:
        return None, "NOT_FOUND"

    # B) narrowing
    ui_upper = user_input.upper()
    exact = [r for r in pools if (r.get("symbol") or "").upper() == ui_upper]
    candidates = exact if exact else pools

    looks_deriv = ui_upper.endswith(("FUT", "CE", "PE"))
    if looks_deriv:
        # Prefer derivatives venue, then earlier expiry by default
        candidates.sort(key=lambda r: (r.get("exchange") != "NFO", r.get("expiry") or ""))
    else:
        candidates.sort(key=lambda r: (r.get("exchange") not in ("NSE", "BSE"), r.get("name") or ""))

    chosen = candidates[0]
    verified = oa_symbol(chosen["symbol"], chosen["exchange"])
    asset_class = classify_row(verified)

    return {
        "symbol": verified["symbol"],
        "exchange": verified["exchange"],
        "instrumenttype": verified.get("instrumenttype", ""),
        "expiry": verified.get("expiry", ""),
        "strike": verified.get("strike"),
        "lotsize": verified.get("lotsize"),
        "tick_size": verified.get("tick_size"),
        "brsymbol": verified.get("brsymbol"),
        "brexchange": verified.get("brexchange"),
        "token": verified.get("token"),
        "asset_class": asset_class
    }, asset_class
```

---

## 5) cURL smoke tests

**Equity (cash):**
```bash
curl -X POST "$HOST/api/v1/search" -H "Content-Type: application/json" -d '{"apikey":"XXX","query":"SBIN","exchange":"NSE"}'
# Expect instrumenttype:"EQ", empty expiry → classify Equity
```

**Futures (index/stock):**
```bash
curl -X POST "$HOST/api/v1/search" -H "Content-Type: application/json" -d '{"apikey":"XXX","query":"BANKNIFTY28NOV25FUT","exchange":"NFO"}'
# Expect instrumenttype like "FUT*", expiry populated → Futures
```

**Options (CE/PE):**
```bash
curl -X POST "$HOST/api/v1/search" -H "Content-Type: application/json" -d '{"apikey":"XXX","query":"NIFTY28NOV2522500CE","exchange":"NFO"}'
# Expect instrumenttype like "OPT*", expiry populated, strike>0, CE suffix → Options
```

Always confirm with:
```bash
curl -X POST "$HOST/api/v1/symbol" -H "Content-Type: application/json" -d '{"apikey":"XXX","symbol":"<PickedSymbol>","exchange":"<PickedExchange>"}'
```

---

## 6) Edge cases & guardrails

- **Weekly vs monthly**: You may see multiple results; sort by `expiry` per business rule (nearest/next).
- **Index spot vs derivatives**: Spot indices use `NSE_INDEX` / `BSE_INDEX`; derivatives live on `NFO`/`BFO`. Don’t mis‑route orders.
- **Broker mapping**: Use `brsymbol` / `brexchange` from **`/symbol`** for the final order route.
- **Strike sentinel**: Non‑options instruments may return `strike = 0` or `-0.01`; never rely on a positive‑strike check alone—always pair with `instrumenttype`/suffix checks.
- **Empty instrumenttype**: Rarely `instrumenttype` can be empty—fallback structure checks in §2 will still classify correctly.

---

## References

- OpenAlgo Data API — **Symbol**: https://docs.openalgo.in/api-documentation/v1/data-api/symbol
- OpenAlgo Data API — **Search**: https://docs.openalgo.in/api-documentation/v1/data-api/search
- OpenAlgo — **Symbol Format** (EQ vs FUT vs CE/PE conventions, exchange codes): https://docs.openalgo.in/symbol-format

