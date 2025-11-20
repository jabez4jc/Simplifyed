# Trading Button Behaviour Specification (Direct & Futures mode)

This document explains, in simple terms, how each trading button — **BUY, SELL, SHORT, COVER, EXIT** — should behave for a **single symbol** (equity or futures).

The goal is:
- You always know **what will be opened** and **what will be closed**.
- Buttons never do anything *unexpected* (like opening a short when you just wanted to reduce a long).

---

## 1. Key Concepts (Plain English)

### 1.1 Current Position (`N`)

For each symbol, the system keeps track of your **current net position**:

- **`N > 0`** → You are **long** (you have bought more than you sold).  
  Example: `N = 100` means you hold **+100** quantity.
- **`N = 0`** → You are **flat** (no position).
- **`N < 0`** → You are **short** (you have sold more than you bought).  
  Example: `N = -75` means you are **short 75** quantity.

### 1.2 Trade Quantity (`Q`)

- `Q` is the quantity you enter in the UI for the button click.
- It is always a **positive number** (e.g., 25, 50, 100).
- The button logic decides whether that quantity is used to **add**, **reduce**, or **flip** the position.

### 1.3 Target Position (`T`)

Internally, the system sends orders using a **target position size**:

- **`T`** is the **final net position** you want after the button is processed.
- Example: If `N = +100` and you want to reduce the position to `+40`, then `T = +40`.
- If you want to completely exit, `T = 0`.

The underlying order engine (like OpenAlgo `placesmartorder`) uses this target to figure out the exact buy/sell orders required.

---

## 2. BUY Button

### 2.1 Business Intent

- **Open or increase a long position.**
- If you are **short**, it will **cover the short first** and then open a long if needed.
- BUY **never** creates a net short position.

### 2.2 Behaviour Rules

Let:
- `N` = current position
- `Q` = quantity entered

**New target position (`T`) after pressing BUY:**

- If you are **flat or long** (`N >= 0`):  
  → Increase your long position by `Q`.  
  → **`T = N + Q`**

- If you are **short** (`N < 0`):  
  → Reduce or completely close the short; if `Q` is larger than the short size, you flip to long.  
  → **`T = N + Q`** (this moves you towards or beyond zero)

So the formula is simple:

> **BUY ⇒ New position = Current position + Q**

### 2.3 Examples

| Scenario                         | Current `N` | `Q`  | New `T` | Result                          |
|----------------------------------|------------:|-----:|--------:|---------------------------------|
| Flat, want to go long           | 0           | 100  | +100    | Open long 100                   |
| Already long, add more          | +100        | 50   | +150    | Increase long from 100 → 150    |
| Short 100, partially cover      | -100        | 50   | -50     | Short reduced from 100 → 50     |
| Short 100, fully cover          | -100        | 100  | 0       | Short closed, now flat          |
| Short 100, cover & flip to long | -100        | 150  | +50     | Cover 100 and open long 50      |

---

## 3. SELL Button

### 3.1 Business Intent

- **Only reduce or exit existing longs.**
- If there is **no long position**, SELL should **do nothing**.
- SELL should **never open a short**.

### 3.2 Behaviour Rules

**New target position (`T`) after pressing SELL:**

- If you are **flat or short** (`N <= 0`):  
  → No long to sell.  
  → **Do nothing** (no order sent).

- If you are **long** (`N > 0`):  
  → Reduce your long position by `Q`.  
  → Do **not** go past zero into a short.  
  → **`T = max(N - Q, 0)`**

So:

> **SELL ⇒ If long, new position = Current position − Q (but not below 0).  
> If not long, ignore the button.**

### 3.3 Examples

| Scenario                           | Current `N` | `Q`  | New `T` | Result                                      |
|------------------------------------|------------:|-----:|--------:|---------------------------------------------|
| Flat, press SELL                  | 0           | 100  | –       | No action                                   |
| Already short, press SELL         | -100        | 50   | –       | No action                                   |
| Long 100, reduce by 50            | +100        | 50   | +50     | Long reduced from 100 → 50                  |
| Long 100, exit fully              | +100        | 100  | 0       | Long closed, now flat                       |
| Long 100, ask to sell 150         | +100        | 150  | 0       | Exit 100 only; no new short is opened       |

---

## 4. SHORT Button

### 4.1 Business Intent

- **Open or increase a short position.**
- If you are **long**, SHORT will **close the long first** and then open a short if the quantity is larger.
- SHORT **always moves you towards a more negative position**.

> When you end up short, the final position number (`T`) is **negative**.

### 4.2 Behaviour Rules

**New target position (`T`) after pressing SHORT:**

- Whether you are flat, long, or already short:

  → **`T = N - Q`**

This:
- Decreases your position if you are long (and can flip you to short).
- Makes you more short if you are already short.
- Opens a new short if you were flat.

So:

> **SHORT ⇒ New position = Current position − Q**

### 4.3 Examples

| Scenario                            | Current `N` | `Q`  | New `T` | Result                                      |
|-------------------------------------|------------:|-----:|--------:|---------------------------------------------|
| Flat, open new short               | 0           | 100  | -100    | Open short 100                              |
| Already short, add more            | -100        | 50   | -150    | Short increased from 100 → 150              |
| Long 100, partial short (reduce)   | +100        | 50   | +50     | Long reduced from 100 → 50                  |
| Long 100, short exactly 100        | +100        | 100  | 0       | Long fully closed, now flat                 |
| Long 100, short 150 (flip to short)| +100        | 150  | -50     | Sell 100 to exit long, then short 50        |

---

## 5. COVER Button

### 5.1 Business Intent

- **Only reduce or exit existing shorts.**
- If there is **no short position**, COVER should **do nothing**.
- COVER should **never open a long**.

Think of COVER as the opposite of SHORT:
- SHORT = “move more short”
- COVER = “move less short (towards zero)”

### 5.2 Behaviour Rules

**New target position (`T`) after pressing COVER:**

- If you are **flat or long** (`N >= 0`):  
  → No short to cover.  
  → **Do nothing** (no order).

- If you are **short** (`N < 0`):  
  → Reduce your short position by `Q`.  
  → Do **not** go beyond zero into a long.  
  → **`T = min(N + Q, 0)`**

So:

> **COVER ⇒ If short, new position = Current position + Q (but not above 0).  
> If not short, ignore the button.**

### 5.3 Examples

| Scenario                            | Current `N` | `Q`  | New `T` | Result                                      |
|-------------------------------------|------------:|-----:|--------:|---------------------------------------------|
| Flat, press COVER                  | 0           | 100  | –       | No action                                   |
| Long 100, press COVER              | +100        | 50   | –       | No action                                   |
| Short 100, cover 50                | -100        | 50   | -50     | Short reduced from 100 → 50                 |
| Short 100, cover fully             | -100        | 100  | 0       | Short closed, now flat                      |
| Short 100, ask to cover 150        | -100        | 150  | 0       | Cover entire 100; extra 50 ignored (no long)|

---

## 6. EXIT Button

### 6.1 Business Intent

- For the **selected symbol**, close **all open positions** (long or short).
- After EXIT, you should be **flat (`N = 0`)** for that symbol.

### 6.2 Behaviour Rules

**New target position (`T`) after pressing EXIT:**

- If you are already **flat** (`N = 0`):  
  → **Do nothing**.

- If you are **long** (`N > 0`):  
  → Set target position to `0`.  
  → This means sell off the entire long.

- If you are **short** (`N < 0`):  
  → Set target position to `0`.  
  → This means buy back the entire short.

So:

> **EXIT ⇒ New position = 0 (flat), for the selected symbol.**

### 6.3 Examples

| Scenario           | Current `N` | New `T` | Result                                      |
|--------------------|------------:|--------:|---------------------------------------------|
| Flat               | 0           | –       | No action                                   |
| Long 150           | +150        | 0       | Sell 150 → flat                             |
| Short 75           | -75         | 0       | Buy 75 → flat                               |

---

## 7. Behaviour Summary (One-Liner View)

For each symbol:

- **BUY**  
  - Moves position **upwards** by `Q`: `New position = N + Q`  
  - Can close shorts and open longs.  
  - Never ends short.

- **SELL**  
  - Only reduces existing longs: `New position = max(N - Q, 0)` if `N > 0`  
  - Does nothing if you are flat or short.  
  - Never opens a short.

- **SHORT**  
  - Moves position **downwards** by `Q`: `New position = N - Q`  
  - Can close longs and open shorts.  
  - Final short positions are negative.

- **COVER**  
  - Only reduces existing shorts: `New position = min(N + Q, 0)` if `N < 0`  
  - Does nothing if you are flat or long.  
  - Never opens a long.

- **EXIT**  
  - Closes all positions for that symbol.  
  - `New position = 0` (flat).

This model ensures:
- You always know what the buttons will do.
- No accidental opening of new positions when you just wanted to reduce/exit.
- Clean, predictable behaviour across **Direct and Futures mode**.
