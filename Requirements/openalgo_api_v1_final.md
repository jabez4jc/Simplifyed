# OpenAlgo API v1 - Complete Documentation with Parameter Specifications

**Generated:** November 2024  
**Source:** docs.openalgo.in + OpenAlgo Python SDK  
**Version:** 3.0 - FINAL with Mandatory/Optional Fields

---

## Base URLs

- **Local:** `http://127.0.0.1:5000/api/v1`
- **Ngrok:** `https://<your-ngrok-domain>.ngrok-free.app/api/v1`
- **Custom:** `https://<your-custom-domain>/api/v1`

---

## Authentication

**All endpoints require:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your OpenAlgo API key |

**Get API Key:** Settings → API in OpenAlgo dashboard

---

## Table of Contents

- [Accounts API](#accounts-api)
- [Orders API](#orders-api)
- [Options API](#options-api) ⭐
- [Data API](#data-api)
- [Margin API](#margin-api) ⭐
- [Telegram API](#telegram-api) ⭐
- [WebSocket API](#websocket-api)
- [Constants & Reference](#constants--reference)

---

# Accounts API

## Ping

**Endpoint:** `POST /api/v1/ping`

Test API connectivity and authentication.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

**Request:**
```json
{
  "apikey": "your-api-key"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "pong"
}
```

---

## Funds

**Endpoint:** `POST /api/v1/funds`

Get available funds and margin information.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

**Request:**
```json
{
  "apikey": "your-api-key"
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "availablecash": "100000.50",
    "collateral": "0.00",
    "m2munrealized": "0.00",
    "m2mrealized": "0.00",
    "utiliseddebits": "0.00"
  }
}
```

---

## Orderbook

**Endpoint:** `POST /api/v1/orderbook`

Get all orders for current trading session.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

**Request:**
```json
{
  "apikey": "your-api-key"
}
```

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "symbol": "RELIANCE",
      "exchange": "NSE",
      "action": "BUY",
      "quantity": 10,
      "price": 2500.50,
      "product": "MIS",
      "status": "complete",
      "orderid": "240101000012345"
    }
  ]
}
```

---

## Tradebook

**Endpoint:** `POST /api/v1/tradebook`

Get executed trades.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

---

## PositionBook

**Endpoint:** `POST /api/v1/positionbook`

Get current open positions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

---

## Holdings

**Endpoint:** `POST /api/v1/holdings`

Get long-term holdings.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

---

## Analyzer Status

**Endpoint:** `POST /api/v1/analyzerstatus`

Check if analyzer mode (paper trading) is enabled.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

**Response:**
```json
{
  "status": "success",
  "data": {
    "analyzer_enabled": true
  }
}
```

---

## Analyzer Toggle

**Endpoint:** `POST /api/v1/analyzertoggle`

Enable or disable analyzer mode.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `enabled` | boolean | **MANDATORY** | true = enable, false = disable |

**Request:**
```json
{
  "apikey": "your-api-key",
  "enabled": true
}
```

---

# Orders API

## PlaceOrder

**Endpoint:** `POST /api/v1/placeorder`

Place a single order.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name/identifier |
| `symbol` | string | **MANDATORY** | Trading symbol (e.g., "RELIANCE") |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `exchange` | string | **MANDATORY** | Exchange (e.g., "NSE", "NFO") |
| `price_type` | string | **MANDATORY** | "MARKET", "LIMIT", "SL", "SL-M" |
| `product` | string | **MANDATORY** | "MIS", "CNC", "NRML" |
| `quantity` | string | **MANDATORY** | Order quantity |
| `price` | string | OPTIONAL | Required for LIMIT orders |
| `trigger_price` | string | OPTIONAL | Required for SL/SL-M orders |
| `disclosed_quantity` | string | OPTIONAL | For iceberg orders |
| `tag` | string | OPTIONAL | Custom order tag |

**Request:**
```json
{
  "apikey": "your-api-key",
  "strategy": "MyStrategy",
  "symbol": "RELIANCE",
  "action": "BUY",
  "exchange": "NSE",
  "price_type": "MARKET",
  "product": "MIS",
  "quantity": "10"
}
```

**Response:**
```json
{
  "status": "success",
  "orderid": "240101000012345"
}
```

---

## PlaceSmartOrder

**Endpoint:** `POST /api/v1/placesmartorder`

Place order with intelligent position sizing.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `exchange` | string | **MANDATORY** | Exchange name |
| `price_type` | string | **MANDATORY** | Order type |
| `product` | string | **MANDATORY** | Product type |
| `position_size` | string | **MANDATORY** | Position size in currency |
| `price` | string | OPTIONAL | For LIMIT orders |
| `trigger_price` | string | OPTIONAL | For SL/SL-M orders |

**Request:**
```json
{
  "apikey": "your-api-key",
  "strategy": "SmartStrategy",
  "symbol": "NIFTY",
  "action": "BUY",
  "exchange": "NFO",
  "price_type": "MARKET",
  "product": "MIS",
  "position_size": "50000"
}
```

---

## BasketOrder

**Endpoint:** `POST /api/v1/basketorder`

Place multiple orders in single request.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `orders` | array | **MANDATORY** | Array of order objects |

**Each order object:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | **MANDATORY** | Trading symbol |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `exchange` | string | **MANDATORY** | Exchange name |
| `price_type` | string | **MANDATORY** | Order type |
| `product` | string | **MANDATORY** | Product type |
| `quantity` | string | **MANDATORY** | Order quantity |
| `price` | string | OPTIONAL | For LIMIT orders |
| `trigger_price` | string | OPTIONAL | For SL/SL-M |

---

## SplitOrder

**Endpoint:** `POST /api/v1/splitorder`

Split large orders into chunks.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `exchange` | string | **MANDATORY** | Exchange name |
| `price_type` | string | **MANDATORY** | Order type |
| `product` | string | **MANDATORY** | Product type |
| `quantity` | string | **MANDATORY** | Total quantity |
| `splitsize` | string | **MANDATORY** | Size per chunk |
| `price` | string | OPTIONAL | For LIMIT orders |
| `trigger_price` | string | OPTIONAL | For SL/SL-M |

---

## ModifyOrder

**Endpoint:** `POST /api/v1/modifyorder`

Modify pending order.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `orderid` | string | **MANDATORY** | Order ID to modify |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `product` | string | **MANDATORY** | Product type |
| `price_type` | string | **MANDATORY** | Order type |
| `quantity` | string | **MANDATORY** | New quantity |
| `price` | string | OPTIONAL | New price |
| `trigger_price` | string | OPTIONAL | New trigger price |
| `disclosed_quantity` | string | OPTIONAL | New disclosed qty |

---

## CancelOrder

**Endpoint:** `POST /api/v1/cancelorder`

Cancel a pending order.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `orderid` | string | **MANDATORY** | Order ID to cancel |

---

## CancelAllOrder

**Endpoint:** `POST /api/v1/cancelallorder`

Cancel all pending orders.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |

---

## ClosePosition

**Endpoint:** `POST /api/v1/closeposition`

Close an existing position.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `product` | string | **MANDATORY** | Product type |

**Note:** Action (BUY/SELL) is auto-determined based on existing position.

---

## OrderStatus

**Endpoint:** `POST /api/v1/orderstatus`

Get status of specific order.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `orderid` | string | **MANDATORY** | Order ID |

---

## OpenPosition

**Endpoint:** `POST /api/v1/openposition`

Check if position is open.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `product` | string | **MANDATORY** | Product type |

---

# Options API

## OptionsOrder ⭐

**Endpoint:** `POST /api/v1/optionsorder`

**CRITICAL FEATURE:** Place option orders with automatic strike resolution using offsets.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `strategy` | string | **MANDATORY** | Strategy name |
| `underlying` | string | **MANDATORY** | Underlying symbol (e.g., "NIFTY", "BANKNIFTY") |
| `exchange` | string | **MANDATORY** | "NSE_INDEX" for indices, "NFO" for futures |
| `strike_int` | integer | **MANDATORY** | Strike interval (50 for NIFTY, 100 for BANKNIFTY) |
| `offset` | string | **MANDATORY** | "ATM", "ITM1"-"ITM4", "OTM1"-"OTM4" |
| `option_type` | string | **MANDATORY** | "CE" for Call, "PE" for Put |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `quantity` | string | **MANDATORY** | Order quantity (multiple of lot size) |
| `pricetype` | string | **MANDATORY** | "MARKET", "LIMIT", "SL", "SL-M" |
| `product` | string | **MANDATORY** | "MIS" or "NRML" |
| `expiry_date` | string | OPTIONAL | Format "DDMMMYY" (e.g., "28OCT25"). Required for indices |
| `price` | string | OPTIONAL | Required for LIMIT orders |
| `trigger_price` | string | OPTIONAL | Required for SL/SL-M orders |

**Offset Values:**
- `ATM` - At The Money (closest to spot price)
- `ITM1` to `ITM4` - In The Money (1-4 strikes)
- `OTM1` to `OTM4` - Out of The Money (1-4 strikes)

**Request:**
```json
{
  "apikey": "your-api-key",
  "strategy": "OptionsStrategy",
  "underlying": "NIFTY",
  "exchange": "NSE_INDEX",
  "expiry_date": "28NOV24",
  "strike_int": 50,
  "offset": "ATM",
  "option_type": "CE",
  "action": "BUY",
  "quantity": "75",
  "pricetype": "MARKET",
  "product": "NRML"
}
```

**Response:**
```json
{
  "status": "success",
  "orderid": "25102800000007",
  "symbol": "NIFTY28NOV2526000CE",
  "exchange": "NFO",
  "offset": "ATM",
  "option_type": "CE",
  "underlying": "NIFTY28OCT25FUT",
  "underlying_ltp": 25966.05
}
```

**Example - Iron Condor:**
```python
# Sell OTM1 strikes
client.optionsorder(underlying="NIFTY", offset="OTM1", option_type="CE", action="SELL", ...)
client.optionsorder(underlying="NIFTY", offset="OTM1", option_type="PE", action="SELL", ...)

# Buy OTM3 protection
client.optionsorder(underlying="NIFTY", offset="OTM3", option_type="CE", action="BUY", ...)
client.optionsorder(underlying="NIFTY", offset="OTM3", option_type="PE", action="BUY", ...)
```

---

## OptionSymbol ⭐

**Endpoint:** `POST /api/v1/optionsymbol`

**CRITICAL FEATURE:** Get option symbol details with automatic strike resolution.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `underlying` | string | **MANDATORY** | Underlying symbol |
| `exchange` | string | **MANDATORY** | "NSE_INDEX" or "NFO" |
| `strike_int` | integer | **MANDATORY** | Strike interval |
| `offset` | string | **MANDATORY** | "ATM", "ITM1"-"ITM4", "OTM1"-"OTM4" |
| `option_type` | string | **MANDATORY** | "CE" or "PE" |
| `expiry_date` | string | OPTIONAL | Format "DDMMMYY". Required for indices |

**Request:**
```json
{
  "apikey": "your-api-key",
  "underlying": "NIFTY",
  "exchange": "NSE_INDEX",
  "expiry_date": "28NOV24",
  "strike_int": 50,
  "offset": "ATM",
  "option_type": "CE"
}
```

**Response:**
```json
{
  "status": "success",
  "symbol": "NIFTY28NOV2526000CE",
  "exchange": "NFO",
  "lotsize": 75,
  "tick_size": 0.05,
  "underlying_ltp": 25966.05
}
```

**Use Case:**
```python
# Get symbol details first
info = client.optionsymbol(underlying="NIFTY", offset="ATM", option_type="CE", ...)

# Use resolved symbol and lot size
symbol = info['symbol']
lotsize = info['lotsize']

# Place order
client.placeorder(symbol=symbol, quantity=str(lotsize), ...)
```

---

## OptionGreeks ⭐

**Endpoint:** `POST /api/v1/optiongreeks`

**CRITICAL FEATURE:** Calculate option Greeks (Delta, Gamma, Theta, Vega, Rho, IV).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbol` | string | **MANDATORY** | Option symbol |
| `exchange` | string | **MANDATORY** | "NFO" or "MCX" |
| `interest_rate` | float | OPTIONAL | Risk-free rate (default: 0.0) |
| `underlying_symbol` | string | OPTIONAL | Underlying symbol (auto-detected if not provided) |
| `underlying_exchange` | string | OPTIONAL | Underlying exchange (auto-detected) |
| `expiry_time` | string | OPTIONAL | Expiry time (e.g., "19:00" for MCX crude oil) |

**Request:**
```json
{
  "apikey": "your-api-key",
  "symbol": "NIFTY25NOV2526000CE",
  "exchange": "NFO",
  "interest_rate": 0.00
}
```

**Response:**
```json
{
  "status": "success",
  "symbol": "NIFTY25NOV2526000CE",
  "strike": 26000.0,
  "option_type": "CE",
  "spot_price": 25966.05,
  "option_price": 435,
  "days_to_expiry": 28.5071,
  "expiry_date": "25-Nov-2025",
  "implied_volatility": 15.6,
  "interest_rate": 0.0,
  "underlying": "NIFTY",
  "exchange": "NFO",
  "greeks": {
    "delta": 0.4967,
    "gamma": 0.000352,
    "theta": -7.919,
    "vega": 28.9489,
    "rho": 9.733994
  }
}
```

**Greek Meanings:**
- **Delta** (0 to 1 for CE, -1 to 0 for PE): Change in option price per 1 point change in underlying
- **Gamma**: Rate of change of Delta
- **Theta**: Time decay per day (always negative for long options)
- **Vega**: Change per 1% change in implied volatility
- **Rho**: Change per 1% change in interest rate

**Use Case - Delta Hedging:**
```python
# Get Greeks
greeks = client.optiongreeks(symbol="NIFTY28NOV2526000CE", exchange="NFO")
delta = greeks['greeks']['delta']

# Calculate hedge
position_lots = 100
lotsize = 75
position_delta = delta * lotsize * position_lots

# Hedge with futures
hedge_lots = int(abs(position_delta) / lotsize)
```

---

# Margin API

## Margin ⭐

**Endpoint:** `POST /api/v1/margin`

**CRITICAL FEATURE:** Calculate margin requirements before placing orders.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `positions` | array | **MANDATORY** | Array of position objects |

**Each position object:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `action` | string | **MANDATORY** | "BUY" or "SELL" |
| `product` | string | **MANDATORY** | "MIS" or "NRML" |
| `pricetype` | string | **MANDATORY** | "MARKET" or "LIMIT" |
| `quantity` | string | **MANDATORY** | Order quantity |
| `price` | string | OPTIONAL | Required for LIMIT orders |

**Request:**
```json
{
  "apikey": "your-api-key",
  "positions": [
    {
      "symbol": "NIFTY25NOV2525000CE",
      "exchange": "NFO",
      "action": "BUY",
      "product": "NRML",
      "pricetype": "MARKET",
      "quantity": "75"
    },
    {
      "symbol": "NIFTY25NOV2525500CE",
      "exchange": "NFO",
      "action": "SELL",
      "product": "NRML",
      "pricetype": "MARKET",
      "quantity": "75"
    }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "total_margin_required": 91555.7625,
    "span_margin": 0.0,
    "exposure_margin": 91555.7625
  }
}
```

**Use Case - Pre-Order Validation:**
```python
# Check margin first
margin = client.margin(positions=[...])
required = margin['data']['total_margin_required']

# Check funds
funds = client.funds()
available = float(funds['data']['availablecash'])

# Place order only if sufficient
if available >= required:
    client.placeorder(...)
else:
    print(f"Insufficient funds: Need ₹{required}, Have ₹{available}")
```

---

# Telegram API

## Telegram ⭐

**Endpoint:** `POST /api/v1/telegram`

**CRITICAL FEATURE:** Send instant Telegram notifications.

**Setup Required:**
1. Configure Telegram bot in OpenAlgo settings
2. Link your Telegram account with OpenAlgo username

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `username` | string | **MANDATORY** | Your OpenAlgo login username |
| `message` | string | **MANDATORY** | Message text (supports formatting) |
| `priority` | integer | OPTIONAL | 1-10 (10=highest, controls sound/vibration) |

**Request:**
```json
{
  "apikey": "your-api-key",
  "username": "trader123",
  "message": "✅ Order placed: NIFTY28NOV2526000CE BUY 75 @ Market",
  "priority": 8
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Notification sent successfully"
}
```

**Examples:**

**Order Alert:**
```python
client.telegram(
    username="trader123",
    message=f"✅ {symbol} {action} {quantity} @ {price}",
    priority=8
)
```

**Risk Alert:**
```python
client.telegram(
    username="trader123",
    message=f"⚠️ Daily loss limit reached: -₹{loss}",
    priority=10
)
```

**Strategy Signal:**
```python
client.telegram(
    username="trader123",
    message="""📈 BUY Signal
Symbol: NIFTY 26000 CE
Entry: ₹150
Target: ₹175
SL: ₹140""",
    priority=9
)
```

---

# Data API

## Quotes

**Endpoint:** `POST /api/v1/quotes`

Get real-time market quotes.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |

**Request:**
```json
{
  "apikey": "your-api-key",
  "symbol": "RELIANCE",
  "exchange": "NSE"
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "symbol": "RELIANCE",
    "ltp": 2500.50,
    "open": 2495.00,
    "high": 2510.00,
    "low": 2490.00,
    "close": 2498.00,
    "volume": 1234567,
    "bid": 2500.00,
    "ask": 2501.00,
    "oi": 0
  }
}
```

---

## Depth

**Endpoint:** `POST /api/v1/depth`

Get market depth (order book).

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |

---

## History

**Endpoint:** `POST /api/v1/history`

Get historical candlestick data.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `interval` | string | **MANDATORY** | "1m", "3m", "5m", "15m", "30m", "1h", "1d" |
| `start_date` | string | **MANDATORY** | Format: "YYYY-MM-DD" |
| `end_date` | string | **MANDATORY** | Format: "YYYY-MM-DD" |

**Request:**
```json
{
  "apikey": "your-api-key",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "interval": "5m",
  "start_date": "2025-01-01",
  "end_date": "2025-01-05"
}
```

---

## Intervals

**Endpoint:** `POST /api/v1/intervals`

Get supported intervals.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |

---

## Symbol

**Endpoint:** `POST /api/v1/symbol`

Get complete symbol information.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |

**Response:**
```json
{
  "status": "success",
  "data": {
    "symbol": "NIFTY24JAN25000CE",
    "exchange": "NFO",
    "tradingsymbol": "NIFTY24JAN25000CE",
    "instrumenttype": "OPTIDX",
    "lotsize": 50,
    "ticksize": 0.05
  }
}
```

---

## Search

**Endpoint:** `POST /api/v1/search`

Search for symbols.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `query` | string | **MANDATORY** | Search keyword |
| `exchange` | string | **MANDATORY** | Exchange name |

**Request:**
```json
{
  "apikey": "your-api-key",
  "query": "RELIANCE",
  "exchange": "NSE"
}
```

---

## Expiry

**Endpoint:** `POST /api/v1/expiry`

Get expiry dates for derivatives.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbol` | string | **MANDATORY** | Underlying symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `instrumenttype` | string | **MANDATORY** | "futures" or "options" |

**Request:**
```json
{
  "apikey": "your-api-key",
  "symbol": "NIFTY",
  "exchange": "NFO",
  "instrumenttype": "options"
}
```

**Response:**
```json
{
  "status": "success",
  "data": [
    "31-JAN-25",
    "07-FEB-25",
    "14-FEB-25"
  ],
  "message": "Found 3 expiry dates for NIFTY options in NFO"
}
```

---

## Ticker

**Endpoint:** `POST /api/v1/ticker`

Get LTP for multiple symbols.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apikey` | string | **MANDATORY** | Your API key |
| `symbols` | array | **MANDATORY** | Array of symbol objects |

**Each symbol object:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |

---

# WebSocket API

**WebSocket URL:** `ws://127.0.0.1:8765`

## Authentication

**Message:**
```json
{
  "action": "authenticate",
  "api_key": "your-api-key"
}
```

## Subscribe

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | **MANDATORY** | "subscribe" |
| `symbol` | string | **MANDATORY** | Trading symbol |
| `exchange` | string | **MANDATORY** | Exchange name |
| `mode` | integer | **MANDATORY** | 1 (LTP), 2 (OHLC+Vol), 3 (Full Depth) |

**Message:**
```json
{
  "action": "subscribe",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "mode": 2
}
```

## Unsubscribe

**Message:**
```json
{
  "action": "unsubscribe",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "mode": 2
}
```

---

# Constants & Reference

## Action Values

| Value | Description |
|-------|-------------|
| `BUY` | Buy order |
| `SELL` | Sell order |

## Price Type Values

| Value | Description |
|-------|-------------|
| `MARKET` | Market order |
| `LIMIT` | Limit order |
| `SL` | Stop Loss Limit |
| `SL-M` | Stop Loss Market |

## Product Values

| Value | Description |
|-------|-------------|
| `MIS` | Intraday (Margin Intraday Squared Off) |
| `CNC` | Delivery (Cash and Carry - equity only) |
| `NRML` | Normal (Carry Forward - F&O) |

## Exchange Values

| Value | Description |
|-------|-------------|
| `NSE` | National Stock Exchange (Equity) |
| `NFO` | NSE Futures & Options |
| `NSE_INDEX` | NSE Indices (for OptionsOrder/OptionSymbol underlying) |
| `BSE` | Bombay Stock Exchange |
| `BFO` | BSE Futures & Options |
| `MCX` | Multi Commodity Exchange |
| `CDS` | Currency Derivatives |
| `BCD` | BSE Currency |
| `NCDEX` | National Commodity & Derivatives Exchange |

## Order Status Values

| Value | Description |
|-------|-------------|
| `pending` | Order pending |
| `open` | Order open |
| `complete` | Order executed |
| `rejected` | Order rejected |
| `cancelled` | Order cancelled |

## HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Bad Request (Invalid parameters) |
| `401` | Unauthorized (Invalid API key) |
| `404` | Not Found |
| `429` | Rate Limit Exceeded |
| `500` | Internal Server Error |

## Rate Limits

| Type | Default Limit |
|------|---------------|
| General API | 10 requests/second per API key |
| Order Placement | 10 orders/second per API key |
| Login | 5/minute, 25/hour |

---

# Symbol Format Reference

## Equity
- **Format:** `SYMBOL`
- **Example:** `RELIANCE`, `TCS`, `INFY`

## Futures
- **Format:** `SYMBOLDDMMMYY[FUT]`
- **Example:** `NIFTY28NOV25FUT`, `BANKNIFTY05DEC25FUT`

## Options
- **Format:** `SYMBOLDDMMMYYXXXXX[CE|PE]`
- **Example:** `NIFTY28NOV2526000CE`, `BANKNIFTY05DEC2548000PE`

**Components:**
- `DD` = Day (01-31)
- `MMM` = Month (JAN, FEB, MAR, APR, MAY, JUN, JUL, AUG, SEP, OCT, NOV, DEC)
- `YY` = Year (24, 25, 26...)
- `XXXXX` = Strike price
- `CE` = Call Option
- `PE` = Put Option

---

# Quick Reference - Common Patterns

## Complete Options Workflow

```python
from openalgo import api

client = api(api_key="your-key", host="http://127.0.0.1:5000")

# 1. Get option symbol
symbol_info = client.optionsymbol(
    underlying="NIFTY",
    exchange="NSE_INDEX",
    expiry_date="28NOV24",
    strike_int=50,
    offset="ATM",
    option_type="CE"
)

# 2. Calculate Greeks
greeks = client.optiongreeks(
    symbol=symbol_info['symbol'],
    exchange="NFO"
)

# 3. Check margin
margin = client.margin(positions=[{
    "symbol": symbol_info['symbol'],
    "exchange": "NFO",
    "action": "BUY",
    "product": "NRML",
    "pricetype": "MARKET",
    "quantity": str(symbol_info['lotsize'])
}])

# 4. Verify funds
funds = client.funds()
available = float(funds['data']['availablecash'])

# 5. Place order if sufficient
if available >= margin['data']['total_margin_required']:
    order = client.optionsorder(
        strategy="MyStrategy",
        underlying="NIFTY",
        exchange="NSE_INDEX",
        expiry_date="28NOV24",
        strike_int=50,
        offset="ATM",
        option_type="CE",
        action="BUY",
        quantity=str(symbol_info['lotsize']),
        pricetype="MARKET",
        product="NRML"
    )
    
    # 6. Send notification
    if order['status'] == 'success':
        client.telegram(
            username="trader",
            message=f"✅ Bought {symbol_info['symbol']}",
            priority=8
        )
```

---

**Last Updated:** November 2024  
**API Version:** v1  
**Documentation Version:** 3.0 (FINAL with Mandatory/Optional)  
**License:** MIT
