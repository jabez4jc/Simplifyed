# Trading Application Order Workflow Analysis

## Table of Contents
1. [Order Types Overview](#order-types-overview)
2. [Entry Order Workflows](#entry-order-workflows)
3. [Exit Order Workflows](#exit-order-workflows)
4. [LTP (Last Traded Price) System](#ltp-last-traded-price-system)
5. [Position Book System](#position-book-system)
6. [Checks & Balances](#checks--balances)
7. [Order Execution Flow](#order-execution-flow)
8. [Complete Workflow Diagram](#complete-workflow-diagram)

---

## Order Types Overview

### Entry Order Types

| Order Type | Code | Description | Price Required | Trigger Price Required |
|------------|------|-------------|----------------|------------------------|
| **Market** | MARKET | Executed at current market price | No (converted to LIMIT) | No |
| **Limit** | LIMIT | Executed at specified price or better | Yes | No |
| **Stop Loss** | SL | Triggered when stop price is hit | Yes | Yes |
| **Stop Loss Market** | SL-M | Stop loss with market execution | No | Yes |

### Supported Exchanges & Products

| Category | Values |
|----------|--------|
| **Exchanges** | NSE, BSE, NFO, BFO, MCX, CDS |
| **Product Types** | MIS (Intraday), CNC (Delivery), NRML (Overnight) |
| **Actions** | BUY, SELL |

### Exit Order Types

| Exit Type | Trigger | Execution | Mode |
|-----------|---------|-----------|------|
| **Manual Exit** | User Action | Immediate | EXIT, EXIT_ALL |
| **Target Exit** | Profit Target | Automatic | POINTS, PERCENTAGE |
| **Stop Loss** | Loss Threshold | Automatic | Fixed, Trailing |
| **Trailing Stop** | Dynamic Threshold | Automatic | Follows price |

---

## Entry Order Workflows

### Manual Order Placement Flow

```mermaid
graph TD
    A[User Initiates Order] --> B[Validate Instance Status]
    B --> C{Is Instance Active?}
    C -->|No| D[Reject Order - Instance Inactive]
    C -->|Yes| E[Normalize Order Data]
    E --> F[Apply Instance Multiplier]
    F --> G[Resolve Limit Price]
    G --> H[Fetch Current Position]
    H --> I[Validate Position]
    I --> J{Position Valid?}
    J -->|No| K[Reject Order - Validation Failed]
    J -->|Yes| L[Build Order Payload]
    L --> M[Place Order via OpenAlgo]
    M --> N{Order Successful?}
    N -->|No| O[Handle Error]
    N -->|Yes| P[Save Order to Database]
    P --> Q[Return Success Response]
```

### Automatic Order Trigger Flow

```mermaid
graph TD
    A[Auto-Exit Service Monitoring] --> B[Evaluate Position]
    B --> C{Check Exit Conditions}
    C --> D[Target Hit?]
    C --> E[Stop Loss Hit?]
    C --> F[Trailing Stop Hit?]
    D -->|Yes| G[Calculate Exit Price]
    E -->|Yes| H[Calculate Exit Price]
    F -->|Yes| I[Calculate Exit Price]
    G --> J[Confirm Exit Action]
    H --> J
    I --> J
    J --> K{User Confirmation?}
    K -->|Analyzer Mode| L[Simulate Exit]
    K -->|Live Mode| M[Execute Real Exit]
    L --> N[Record Alert]
    M --> O[Place Exit Order]
```

### Order Types Detailed Comparison

| Aspect | MARKET | LIMIT | SL | SL-M |
|--------|--------|-------|----|-----|
| **Price Buffer** | Auto-calculated | Manual/Buffer | Trigger + Buffer | Trigger-based |
| **Slippage Control** | 0.5% max | Yes | Yes | N/A |
| **Spread Validation** | Yes (0.5% max) | Yes | Yes | Yes |
| **Retry Mechanism** | Yes (5s intervals) | Yes | Yes | Yes |
| **Order Modifications** | Converted to LIMIT | Direct | Via Trigger | Via Trigger |

---

## Exit Order Workflows

### Auto-Exit Service Flow

```mermaid
graph TD
    A[Auto-Exit Service Runs Every 5s] --> B[Get All Active Instances]
    B --> C[Loop Through Instances]
    C --> D[Fetch Instance Positions]
    D --> E[Get Position Config]
    E --> F[Evaluate Each Position]
    F --> G{Check Exit Conditions}
    G --> H[Target: POINTS/PERCENTAGE]
    G --> I[Stop Loss: Fixed]
    G --> J[Trailing Stop: Dynamic]
    H --> K{Exit Required?}
    I --> K
    J --> K
    K -->|Yes| L[Confirm Exit]
    L --> M{Confirmation Status}
    M -->|Confirmed| N[Execute Auto-Exit]
    M -->|Cancelled| O[Log Cancellation]
    N --> P[Update Position Status]
    P --> Q[Record Exit Reason]
```

### Exit Reasons & Actions

| Exit Reason | Code | Description | Action Taken |
|-------------|------|-------------|--------------|
| **Target Met** | TARGET_MET | Profit target achieved | Close position |
| **Stop Loss Hit** | STOPLOSS_HIT | Loss threshold breached | Close position |
| **Trailing Stop** | TSL_HIT | Trailing stop triggered | Close position |
| **Manual Exit** | MANUAL | User-initiated | Close position |
| **Batch Exit** | BATCH_ALL | Exit all positions | Close all |

### Position Exit Decision Matrix

| Condition | LONG Position | SHORT Position | Action |
|-----------|---------------|----------------|--------|
| **Target Hit (Points)** | LTP ≥ Entry + Target | LTP ≤ Entry - Target | Exit |
| **Target Hit (%)** | LTP ≥ Entry × (1 + Target%) | LTP ≤ Entry × (1 - Target%) | Exit |
| **Stop Loss Hit** | LTP ≤ Entry - SL | LTP ≥ Entry + SL | Exit |
| **Trailing Stop** | LTP ≤ Peak - Trail | LTP ≥ Low + Trail | Exit |

---

## LTP (Last Traded Price) System

### LTP Fetching Hierarchy

```mermaid
graph TD
    A[Order Requires LTP] --> B{WebSocket Connected?}
    B -->|Yes| C[Use WebSocket Data]
    B -->|No| D[Use REST API]
    C --> E[Extract LTP from Message]
    D --> F[Fetch LTP from API]
    E --> G[Parse LTP Value]
    F --> G
    G --> H{Valid LTP?}
    H -->|Yes| I[Return LTP]
    H -->|No| J[Try Fallback Methods]
    J --> K[Calculate Mid-Price]
    K --> L{Valid Mid-Price?}
    L -->|Yes| I
    L -->|No| M[Use Close/Prev Close]
    M --> N[Return Price]
```

### LTP Extraction Priority

| Priority | Field Names | Fallback Method |
|----------|-------------|-----------------|
| **1 (Primary)** | ltp, LTP, last_price, lastPrice, last_traded_price, lastTradedPrice | Direct LTP value |
| **2 (Bid/Ask)** | bid, ask | (Bid + Ask) / 2 |
| **3 (OHLC)** | close, prev_close, open, high, low | Close price preferred |
| **4 (Derived)** | average_price | Calculated average |

### Market Data Refresh Intervals

| Data Type | Active Positions | Idle State | TTL |
|-----------|------------------|-----------|-----|
| **Quotes (LTP)** | 5 seconds | 5 seconds | 5s |
| **Positions** | 8 seconds | 30 seconds | 8s/30s |
| **Funds** | 3 minutes | 3 minutes | 3 min |
| **Order Book** | 30 seconds | 30 seconds | 30s |
| **Trade Book** | 8 seconds | 30 seconds | 8s/30s |

### LTP Validation Rules

| Validation | Rule | Threshold | Action |
|------------|------|-----------|--------|
| **Freshness** | Age < Stale Threshold | 2-3 seconds | Use or Reject |
| **Spread** | (Ask - Bid) / Mid < Max | 0.5% | Validate or Error |
| **Circuit Breaker** | Failures > Threshold | 3 failures | Enter Cooldown |
| **Cooldown Period** | After Circuit Breaker | 30 seconds | Skip Polling |

---

## Position Book System

### Position Data Structure

```json
{
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "quantity": 100,
  "entry_price": 2500.50,
  "entry_price_source": "tradebook_avg",
  "ltp_resolved": 2525.75,
  "pnl_derived": 2525.75,
  "position_side": "LONG",
  "unrealized_pnl": 2525.75
}
```

### Entry Price Resolution Hierarchy

| Tier | Source | Method | Reliability |
|------|--------|--------|-------------|
| **1** | Tradebook Average | Calculate avg fill price | High |
| **2** | Order Price | From database order | Medium |
| **3** | Fallback Cache | Cached at order time | Medium |
| **4** | Cross-Instance Median | Median of other instances | Low |

### Position Tracking Flow

```mermaid
graph TD
    A[Position Update Trigger] --> B[Fetch Position Book]
    B --> C[Normalize Position Fields]
    C --> D[Resolve Entry Price]
    D --> E[Get Current LTP]
    E --> F[Calculate P&L]
    F --> G[Update Position Cache]
    G --> H[Check for Open Positions]
    H --> I{Open Positions?}
    I -->|Yes| J[Set Active Refresh - 8s]
    I -->|No| K[Set Idle Refresh - 30s]
    J --> L[Emit Position Update]
    K --> L
```

### Position Validation Checks

| Check Type | Validation | Error Handling |
|------------|------------|----------------|
| **Quantity** | Parse from multiple fields | Log warning, use 0 |
| **Entry Price** | Multi-tier resolution | Cross-instance median |
| **Position Side** | Sign of quantity | LONG (>0), SHORT (<0) |
| **P&L Calculation** | (LTP - Entry) × Qty | Null if data missing |

---

## Checks & Balances

### Pre-Order Validation Checklist

| Validation | Rule | Error Message |
|------------|------|---------------|
| **Instance Status** | Must be active | "Instance is not active" |
| **Order Placement** | Must be enabled | "Order placement disabled" |
| **Symbol** | Must be valid | "Invalid symbol" |
| **Exchange** | Must be supported | "Invalid exchange" |
| **Action** | Must be BUY/SELL | "Invalid action" |
| **Quantity** | > 0, < 100000 | "Invalid quantity" |
| **Price** | > 0 for LIMIT/SL | "Price required" |
| **Product Type** | MIS/CNC/NRML | "Invalid product" |

### Risk Management Controls

| Control | Threshold | Purpose | Action |
|---------|-----------|---------|--------|
| **Slippage** | 0.5% max | Prevent bad fills | Cancel order |
| **Spread** | 0.5% max | Price sanity check | Reject order |
| **Quantity** | 100,000 max | Prevent errors | Warn user |
| **Stale Quote** | 2-3 seconds | Fresh data check | Use cache/fallback |

### Position-Based Validations

| Scenario | Validation | Result |
|----------|------------|--------|
| **SELL > LONG Position** | qty ≤ position | Allow partial/exact |
| **SELL > Position** | qty > position | Reject with error |
| **SELL with SHORT** | qty increases short | Warn, allow |
| **BUY with Position** | qty adds to position | Allow |

### Error Handling Strategy

| Error Type | Handling | Retry/Fallback |
|------------|----------|----------------|
| **Network Error** | Log and retry | Exponential backoff |
| **Market Closed** | Reject order | N/A |
| **Insufficient Funds** | Reject order | N/A |
| **Invalid Symbol** | Reject order | N/A |
| **Order Rejected** | Update status | User notification |
| **Partial Fill** | Track remaining | Retry with adjusted qty |

---

## Order Execution Flow

### Complete Order Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending : Order Created
    Pending --> Open : Sent to Broker
    Open --> Partial : Partial Fill
    Partial --> Open : More Fills
    Open --> Complete : Fully Filled
    Partial --> Complete : Final Fill
    Open --> Cancelled : User Cancel
    Pending --> Cancelled : User Cancel
    Open --> Rejected : Broker Reject
    Pending --> Rejected : Broker Reject
    Complete --> [*]
    Cancelled --> [*]
    Rejected --> [*]
```

### Order Placement Sequence

```mermaid
sequenceDiagram
    participant U as User/API
    participant OS as Order Service
    participant LV as Limit Price Service
    participant PS as Position Service
    participant OP as OpenAlgo Client
    participant DB as Database

    U->>OS: placeOrder(params)
    OS->>OS: Validate instance
    OS->>LV: resolveLimitPrice()
    LV->>LV: Get fresh quote
    LV->>LV: Apply buffer
    LV-->>OS: Return price
    OS->>PS: Get current position
    PS-->>OS: Return position
    OS->>OS: Build order payload
    OS->>OP: Place order
    OP-->>OS: Order response
    OS->>DB: Save order
    OS-->>U: Success response
```

### Smart Order Features

| Feature | Description | Implementation |
|---------|-------------|----------------|
| **Position-Aware** | Repeat until target | Compare current vs target |
| **Auto Retry** | Retry failed orders | 5-second intervals |
| **Buffer Management** | Price protection | Configurable buffer points |
| **Tick Size** | Price rounding | Exchange-specific |
| **Slippage Control** | Prevent bad fills | 0.5% max slippage |
| **Correlation ID** | Track orders | UUID-based |

### Order Retry Mechanism

```mermaid
graph TD
    A[Order Placed] --> B[Wait 5 seconds]
    B --> C[Check Order Status]
    C --> D{Still Open?}
    D -->|Yes| E[Calculate Slippage]
    E --> F{Slippage < 0.5%?}
    F -->|No| G[Cancel Order - Slippage Too High]
    F -->|Yes| H[Calculate New Price]
    H --> I[Cancel Existing Order]
    I --> J[Place New Order]
    J --> K[Schedule Next Retry]
    K --> B
    D -->|No| L[Order Complete/Closed]
    L --> M[Stop Retry]
    G --> M
```

### Status Mapping

| Broker Status | Internal Status | Display |
|---------------|-----------------|---------|
| open | open | Open |
| pending | pending | Pending |
| complete | complete | Complete |
| cancelled | cancelled | Cancelled |
| rejected | rejected | Rejected |
| trigger pending | pending | Pending |
| partially filled | open | Open |

---

## Complete Workflow Diagram

### End-to-End Order Flow

```mermaid
flowchart TD
    subgraph "1. INITIATION"
        A[User/API Request] --> B{Order Type}
        B -->|Manual| C[Manual Order]
        B -->|Auto| D[Auto-Exit Service]
    end

    subgraph "2. VALIDATION"
        C --> E[Validate Instance]
        D --> F[Evaluate Position]
        E --> G{Valid?}
        F --> H{Exit Needed?}
        G -->|No| I[Reject]
        H -->|No| J[Continue Monitoring]
        G -->|Yes| K[Normalize Data]
        H -->|Yes| L[Confirm Exit]
    end

    subgraph "3. PRICE RESOLUTION"
        K --> M[Get Fresh LTP]
        L --> N[Calculate Exit Price]
        M --> O[Apply Buffer]
        N --> P[Apply Tick Size]
        O --> Q[Validate Spread]
        P --> Q
        Q -->|Fail| R[Reject Order]
        Q -->|Pass| S[Build Payload]
    end

    subgraph "4. POSITION CHECK"
        S --> T[Get Current Position]
        T --> U[Validate Position]
        U --> V{Valid?}
        V -->|No| W[Reject]
        V -->|Yes| X[Check Repeat Logic]
    end

    subgraph "5. EXECUTION"
        X --> Y[Place Order via OpenAlgo]
        Y --> Z{Success?}
        Z -->|No| AA[Handle Error]
        Z -->|Yes| BB[Save to Database]
        BB --> CC[Return Response]
    end

    subgraph "6. MONITORING"
        CC --> DD[Start Status Sync]
        DD --> EE[Check Every 8s/30s]
        EE --> FF{Order Complete?}
        FF -->|No| GG[Update Status]
        FF -->|Yes| HH[Stop Sync]
        GG --> EE
        HH --> II[Update Position]
    end

    subgraph "7. AUTO-EXIT LOOP"
        L -->|Confirmed| JJ[Execute Exit]
        JJ --> KK[Place Exit Order]
        KK --> LL[Update Position]
        LL --> MM[Record Exit Reason]
        MM --> NN[Emit Event]
    end

    I --> OO[End]
    R --> OO
    W --> OO
    AA --> PP[Log Error]
    PP --> OO
    J --> QQ[Continue]
    QQ --> DD
```

### System Architecture Overview

```mermaid
graph TB
    subgraph "User Interfaces"
        UI1[Web Dashboard]
        UI2[API Clients]
        UI3[Mobile App]
    end

    subgraph "API Gateway"
        GW[Express Router]
    end

    subgraph "Order Services"
        OS1[Order Service]
        OS2[Order Monitor Service]
        OS3[Auto-Exit Service]
        OS4[Order Retry Service]
    end

    subgraph "Market Data"
        WS[WebSocket Connection]
        MDF[Market Data Feed]
        LP[Limit Price Service]
    end

    subgraph "Risk & Validation"
        RV[Risk Controls]
        OV[Order Validation]
        RC[Position Service]
    end

    subgraph "External Systems"
        OA[OpenAlgo Broker]
        EX[NSE/BSE/NFO/MCX]
        DB[(SQLite Database)]
    end

    UI1 --> GW
    UI2 --> GW
    UI3 --> GW
    GW --> OS1
    GW --> OS2

    OS1 --> RV
    OS1 --> OV
    OS1 --> LP
    OS1 --> RC

    OS2 --> MDF
    OS3 --> RV
    OS4 --> LP

    MDF --> WS
    MDF --> OA
    LP --> MDF
    RC --> OA

    OS1 --> OA
    OS2 --> OA
    OS3 --> OA
    OS4 --> OA

    OA --> EX

    OS1 --> DB
    OS2 --> DB
    OS3 --> DB
    OS4 --> DB
    RC --> DB
```

---

## Key Metrics & Performance

### Order Processing Metrics

| Metric | Value | Purpose |
|--------|-------|---------|
| **Order Latency** | < 100ms | Speed of order placement |
| **LTP Refresh** | 5 seconds | Data freshness |
| **Position Sync** | 8s/30s | Position accuracy |
| **Auto-Exit Check** | 5 seconds | Exit responsiveness |
| **Retry Interval** | 5 seconds | Order retry timing |
| **Max Slippage** | 0.5% | Slippage protection |

### Capacity Limits

| Resource | Limit | Reason |
|----------|-------|--------|
| **Max Quantity** | 100,000 | Prevent errors |
| **Max Spread** | 0.5% | Price sanity |
| **Max Slippage** | 0.5% | Fill quality |
| **Retry Count** | Unlimited (with interval) | Ensure execution |
| **Order Age** | No limit | Hold as needed |

---

## Configuration Points

### Instance Multiplier
- Range: 1-999
- Multiplies both quantity and position_size
- Applied after validation

### Buffer Points
- Configurable per exchange/symbol
- Applied to limit price
- Protects against adverse fills

### Refresh Intervals
- Active: 8 seconds (positions)
- Idle: 30 seconds (positions)
- Always: 5 seconds (quotes, auto-exit)

---

## Error Codes & Messages

| Code | Message | Cause | Resolution |
|------|---------|-------|------------|
| 400 | Instance is not active | Instance disabled | Activate instance |
| 400 | Invalid symbol | Symbol not recognized | Use valid symbol |
| 400 | Price is required | Missing price for LIMIT | Provide price |
| 400 | Quantity must be > 0 | Invalid quantity | Use positive quantity |
| 400 | Cannot SELL X - current position is Y | Insufficient position | Reduce quantity |
| 400 | Bid/ask spread too wide | Market condition | Wait for better spread |
| 400 | Quote is stale | Old data | Retry with fresh quote |
| 500 | Order retry failed | Network/broker error | Check logs, retry |

---

## Conclusion

This trading application implements a **production-grade order management system** with:

✅ **Multi-tiered order validation** - Prevents invalid orders
✅ **Real-time market data** - WebSocket + REST fallback
✅ **Position-aware execution** - Smart order continuation
✅ **Comprehensive risk controls** - Slippage, spread, validation
✅ **Automated exit triggers** - Target, stop-loss, trailing
✅ **Retry mechanisms** - Ensures order execution
✅ **Circuit breakers** - Resilient error handling
✅ **Dynamic refresh** - Optimized resource usage

The system demonstrates **enterprise-level architecture** with proper separation of concerns, comprehensive error handling, and multiple layers of validation to ensure reliable and safe order execution.
