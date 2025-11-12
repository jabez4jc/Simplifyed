# OpenAlgo API v1 - Developer Reference

## Table of Contents
- [api-documentation](#api-documentation)

---

## api-documentation


### README

# V1

OpenAlgo API is a set of **REST APIs** that provide integration with multiple brokers with which you can build your own customized trading applications



## Endpoint URL

```http
Local Host   :  http://127.0.0.1:5000/api/v1/placeorder
Ngrok Domain :  https://<your-ngrok-domain>.ngrok-free.app/api/v1/placeorder
Custom Domain:  https://<your-custom-domain>/api/v1/placeorder
```


# Accounts API

The Accounts API provides a comprehensive list of operations to manage and handle Trading Accounts efficiently.&#x20;



### analyzer-status

# Analyzer Status

## Endpoint URL

This API Function fetches the stock holdings details from the broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/analyzer
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/analyzer
Custom Domain:  POST https://<your-custom-domain>/api/v1/analyzer
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```



## Sample API Response

```json
{
  "data": {
    "analyze_mode": false,
    "mode": "live",
    "total_logs": 2
  },
  "status": "success"
}
```



### Request Body

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| apikey    | string | Yes      | Your OpenAlgo API key |

### Response Fields

| Field         | Type    | Description                                                 |
| ------------- | ------- | ----------------------------------------------------------- |
| status        | string  | Status of the API call (success/error)                      |
| data          | object  | Container for response data                                 |
| mode          | string  | Current mode in human-readable format ("analyze" or "live") |
| analyze\_mode | boolean | Current analyzer mode flag (true = analyze, false = live)   |
| total\_logs   | integer | Total number of analyzer logs stored                        |

### Notes

* **Live Mode**: When `analyze_mode` is `false`, all API calls execute actual broker operations
* **Analyze Mode**: When `analyze_mode` is `true`, all API calls return simulated responses without executing real trades
* The `total_logs` field shows the cumulative count of all analyzer mode operations logged in the system
* This endpoint is useful for checking the current mode before executing trading operations
* Rate limited to 10 requests per second per API key




### analyzer-toggle

# Analyzer Toggle

## Endpoint URL

This API Function fetches the stock holdings details from the broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/analyzer/toggle
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/analyzer/toggle
Custom Domain:  POST https://<your-custom-domain>/api/v1/analyzer/toggle
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "mode": true
}

```



## Sample API Response

```json
{
  "data": {
    "analyze_mode": false,
    "message": "Analyzer mode switched to live",
    "mode": "live",
    "total_logs": 2
  },
  "status": "success"
}
```



### Request Body

| Parameter | Type    | Required | Description                                |
| --------- | ------- | -------- | ------------------------------------------ |
| apikey    | string  | Yes      | Your OpenAlgo API key                      |
| mode      | boolean | Yes      | Target mode (true = analyze, false = live) |

### Response Fields

| Field         | Type    | Description                                                 |
| ------------- | ------- | ----------------------------------------------------------- |
| status        | string  | Status of the API call (success/error)                      |
| data          | object  | Container for response data                                 |
| mode          | string  | Current mode in human-readable format ("analyze" or "live") |
| analyze\_mode | boolean | Current analyzer mode flag (true = analyze, false = live)   |
| total\_logs   | integer | Total number of analyzer logs stored                        |
| message       | string  | Confirmation message about the mode change                  |

### Notes

* **Live Mode (`mode: false`)**: All API calls execute actual broker operations and real trades
* **Analyze Mode (`mode: true`)**: All API calls return simulated responses without executing real trades
* The mode change is applied immediately and affects all subsequent API calls
* Use this endpoint to switch between testing (analyze) and production (live) environments
* The `total_logs` field shows the cumulative count of all analyzer mode operations
* Rate limited to 10 requests per second per API key
* **Important**: Always verify the current mode before executing trading operations to avoid unintended live trades






### funds

# Funds

## Endpoint URL

This API Function Fetches Funds and Margin Details of the Connected Trading Account

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/funds
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/funds
Custom Domain:  POST https://<your-custom-domain>/api/v1/funds
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```

###

## Sample API Response

```json
{
  "data": {
    "availablecash": "18083.01",
    "collateral": "0.00",
    "m2mrealized": "0.00",
    "m2munrealized": "0.00",
    "utiliseddebits": "0.00"
  },
  "status": "success"
}
```



## Request Body



| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |



## Response Fields

| Field   | Type  | Description                              |
| ------- | ----- | ---------------------------------------- |
| seconds | array | List of supported second-based intervals |
| minutes | array | List of supported minute-based intervals |
| hours   | array | List of supported hour-based intervals   |
| days    | array | List of supported daily intervals        |
| weeks   | array | List of supported weekly intervals       |
| months  | array | List of supported monthly intervals      |



## Notes



1. Always check supported intervals first using the intervals API
2. Use exact interval strings from intervals API response
3. All timestamps are in Unix epoch format



### holdings

# Holdings

## Endpoint URL

This API Function fetches the stock holdings details from the broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/holdings
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/holdings
Custom Domain:  POST https://<your-custom-domain>/api/v1/holdings
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```



## Sample API Response

```json
{
  "data": {
    "holdings": [
      {
        "exchange": "NSE",
        "pnl": 3.27,
        "pnlpercent": 13.04,
        "product": "CNC",
        "quantity": 1,
        "symbol": "BSLNIFTY"
      },
      {
        "exchange": "NSE",
        "pnl": 1.02,
        "pnlpercent": 14.37,
        "product": "CNC",
        "quantity": 1,
        "symbol": "IDEA"
      }
    ],
    "statistics": {
      "totalholdingvalue": 36.46,
      "totalinvvalue": 32.17,
      "totalpnlpercentage": 13.34,
      "totalprofitandloss": 4.29
    }
  },
  "status": "success"
}
```



## Request Body



| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |






### margin

# Margin

## Margin Calculator

### Endpoint URL

This API Function Calculates Margin Requirements for a Basket of Positions

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/margin
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/margin
Custom Domain:  POST https://<your-custom-domain>/api/v1/margin
```

### Basic Usage

```json
{
    "apikey": "<your_app_apikey>",
    "positions": [
        {
            "symbol": "NIFTY30DEC2526000CE",
            "exchange": "NFO",
            "action": "BUY",
            "product": "NRML",
            "pricetype": "MARKET",
            "quantity": "75",
            "price": "0"
        }
    ]
}
```

### Sample API Request (Single Position)

```json
{
    "apikey": "your_app_apikey",
    "positions": [
        {
            "symbol": "SBIN",
            "exchange": "NSE",
            "action": "BUY",
            "product": "MIS",
            "pricetype": "LIMIT",
            "quantity": "10",
            "price": "750.50",
            "trigger_price": "0"
        }
    ]
}
```

### Sample API Request (Multiple Positions - Basket)

```json
{
    "apikey": "your_app_apikey",
    "positions": [
        {
            "symbol": "NIFTY30DEC2526000CE",
            "exchange": "NFO",
            "action": "SELL",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "150.75",
            "trigger_price": "0"
        },
        {
            "symbol": "NIFTY30DEC2526000PE",
            "exchange": "NFO",
            "action": "SELL",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "125.50",
            "trigger_price": "0"
        },
    ]
}
```

### Sample API Response (Success)

```json
{
    "status": "success",
    "data": {
        "total_margin_required": 328482.00,
        "span_margin": 258482.00,
        "exposure_margin": 70000.00
    }
}
```

### Sample API Response (Error)

```json
{
    "status": "error",
    "message": "Invalid symbol: INVALID_SYMBOL on exchange: NFO"
}
```

### Parameter Description

#### Main Request Parameters

| Parameter | Description                         | Mandatory/Optional | Default Value |
| --------- | ----------------------------------- | ------------------ | ------------- |
| apikey    | App API key                         | Mandatory          | -             |
| positions | Array of position objects (max: 50) | Mandatory          | -             |

#### Position Object Parameters

| Parameter      | Description                            | Mandatory/Optional | Default Value |
| -------------- | -------------------------------------- | ------------------ | ------------- |
| symbol         | Trading symbol                         | Mandatory          | -             |
| exchange       | Exchange code (NSE/NFO/BSE/BFO/etc.)   | Mandatory          | -             |
| action         | Action (BUY/SELL)                      | Mandatory          | -             |
| product        | Product type (CNC/MIS/NRML)            | Mandatory          | -             |
| pricetype      | Price type (MARKET/LIMIT/SL/SL-M)      | Mandatory          | -             |
| quantity       | Quantity                               | Mandatory          | -             |
| price          | Price (required for LIMIT orders)      | Optional           | 0             |
| trigger\_price | Trigger price (required for SL orders) | Optional           | 0             |

### Response Fields Description

| Field   | Description                                  | Type   |
| ------- | -------------------------------------------- | ------ |
| status  | Response status (success/error)              | String |
| data    | Margin data object (present only on success) | Object |
| message | Error message (present only on error)        | String |

#### Margin Data Object Fields (Broker-Specific)

Different brokers return different margin components. Common fields include:

| Field                   | Description                             | Availability |
| ----------------------- | --------------------------------------- | ------------ |
| total\_margin\_required | Total margin required for all positions | All brokers  |
| span\_margin            | SPAN margin requirement                 | Most brokers |
| exposure\_margin        | Exposure margin requirement             | Most brokers |

### Supported Exchanges

| Exchange Code | Description                      |
| ------------- | -------------------------------- |
| NSE           | National Stock Exchange (Equity) |
| BSE           | Bombay Stock Exchange (Equity)   |
| NFO           | NSE Futures & Options            |
| BFO           | BSE Futures & Options            |
| CDS           | Currency Derivatives             |
| MCX           | Multi Commodity Exchange         |

### Supported Product Types

| Product | Description                   |
| ------- | ----------------------------- |
| CNC     | Cash and Carry (Delivery)     |
| MIS     | Margin Intraday Square-off    |
| NRML    | Normal (F\&O - Carry Forward) |

### Supported Price Types

| Price Type | Description            |
| ---------- | ---------------------- |
| MARKET     | Market order           |
| LIMIT      | Limit order            |
| SL         | Stop Loss Limit order  |
| SL-M       | Stop Loss Market order |

### Supported Actions

| Action | Description |
| ------ | ----------- |
| BUY    | Buy order   |
| SELL   | Sell order  |

### Important Notes

1. **Maximum Positions**: You can calculate margin for up to 50 positions in a single request.
2. **Basket Margin Benefit**: When calculating margin for multiple positions, many brokers provide margin benefit (reduced total margin) due to hedging. Always use basket margin calculation for strategies with multiple legs.
3. **Broker-Specific Behavior**:
   * **Angel One**: Supports batch margin for up to 50 positions
   * **Zerodha**: Uses basket API for multiple positions, orders API for single position
   * **Dhan/Firstock/Kotak/Paytm**: Single position only - multiple positions calculated sequentially and aggregated
   * **Groww**: Basket margin only for FNO segment; CASH segment calculates first position only
   * **5paisa**: Returns account-level margin (not position-specific)
4. **Price Requirements**:
   * For MARKET orders, price can be "0"
   * For LIMIT orders, price is required
   * For SL/SL-M orders, trigger\_price is required
5. **Symbol Format**: Use OpenAlgo standard symbol format:
   * Equity: "SBIN", "RELIANCE", "TCS"
   * Futures: "NIFTY30DEC25FUT", "BANKNIFTY30DEC25FUT"
   * Options: "NIFTY30DEC2526000CE", "BANKNIFTY30DEC2548000PE"
   * Lot sizes: NIFTY=75, BANKNIFTY=35
6. **Rate Limiting**: The endpoint respects the `API_RATE_LIMIT` setting (default: 50 requests per second)
7. **Error Handling**: If margin calculation fails for any position in a basket, the API will:
   * Log the error for that specific position
   * Continue calculating for remaining positions
   * Return aggregated results for successful positions

### Example Use Cases

#### Use Case 1: Check Margin for Single Stock Purchase

```json
{
    "apikey": "your_app_apikey",
    "positions": [
        {
            "symbol": "TCS",
            "exchange": "NSE",
            "action": "BUY",
            "product": "CNC",
            "pricetype": "LIMIT",
            "quantity": "10",
            "price": "3500.00"
        }
    ]
}
```

#### Use Case 2: Iron Condor Strategy (4 Legs)

```json
{
    "apikey": "your_app_apikey",
    "positions": [
        {
            "symbol": "NIFTY30DEC2526500CE",
            "exchange": "NFO",
            "action": "SELL",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "50.00"
        },
        {
            "symbol": "NIFTY30DEC2527000CE",
            "exchange": "NFO",
            "action": "BUY",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "25.00"
        },
        {
            "symbol": "NIFTY30DEC2525500PE",
            "exchange": "NFO",
            "action": "SELL",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "45.00"
        },
        {
            "symbol": "NIFTY30DEC2525000PE",
            "exchange": "NFO",
            "action": "BUY",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "20.00"
        }
    ]
}
```

#### Use Case 3: Futures Trading Margin

```json
{
    "apikey": "your_app_apikey",
    "positions": [
        {
            "symbol": "NIFTY30DEC25FUT",
            "exchange": "NFO",
            "action": "BUY",
            "product": "NRML",
            "pricetype": "LIMIT",
            "quantity": "75",
            "price": "26050.00",
            "trigger_price": "0"
        }
    ]
}
```

#### Use Case 4: Stop Loss Order Margin

```json
{
    "apikey": "your_app_apikey",
    "positions": [
        {
            "symbol": "BANKNIFTY30DEC2548000CE",
            "exchange": "NFO",
            "action": "BUY",
            "product": "MIS",
            "pricetype": "SL",
            "quantity": "35",
            "price": "300.00",
            "trigger_price": "295.00"
        }
    ]
}
```

### Error Codes and Messages

| Error Message                                      | Cause                             |
| -------------------------------------------------- | --------------------------------- |
| "API key is required"                              | Missing apikey parameter          |
| "Positions array is required"                      | Missing positions parameter       |
| "Positions must be an array"                       | Positions is not an array         |
| "Positions array cannot be empty"                  | Empty positions array             |
| "Maximum 50 positions allowed"                     | More than 50 positions in request |
| "Invalid symbol: {symbol} on exchange: {exchange}" | Symbol not found in database      |
| "Invalid exchange: {exchange}"                     | Unsupported exchange              |
| "Invalid product type: {product}"                  | Invalid product type              |
| "Invalid action: {action}"                         | Action must be BUY or SELL        |
| "Invalid pricetype: {pricetype}"                   | Unsupported price type            |
| "Quantity must be a positive number"               | Invalid quantity value            |
| "Failed to calculate margin: {error}"              | Broker API error                  |

###



### orderbook

# Orderbook

## Endpoint URL

This API Function fetches the Orderbook details from the broker with basic orderbook statistics

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/orderbook
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/orderbook
Custom Domain:  POST https://<your-custom-domain>/api/v1/orderbook
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```



## Sample API Response

```json
{
  "data": {
    "orders": [
      {
        "action": "SELL",
        "exchange": "NSE",
        "order_status": "complete",
        "orderid": "24120900000213",
        "price": 1500,
        "pricetype": "LIMIT",
        "product": "MIS",
        "quantity": 5,
        "symbol": "INFY",
        "timestamp": "09-Dec-2024 09:44:09",
        "trigger_price": 0
      },
      {
        "action": "BUY",
        "exchange": "NSE",
        "order_status": "complete",
        "orderid": "24120900000212",
        "price": 0,
        "pricetype": "MARKET",
        "product": "MIS",
        "quantity": 10,
        "symbol": "RELIANCE",
        "timestamp": "09-Dec-2024 09:44:09",
        "trigger_price": 0
      }
    
     
    ],
    "statistics": {
      "total_buy_orders": 1,
      "total_completed_orders": 2,
      "total_open_orders": 0,
      "total_rejected_orders": 0,
      "total_sell_orders": 1
    }
  },
  "status": "success"
}
```



## Request Body



| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |






### ping

# Ping

### Endpoint URL

This API Function checks connectivity and validates the API key authentication with the OpenAlgo platform

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/ping
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/ping
Custom Domain:  POST https://<your-custom-domain>/api/v1/ping
```

### Sample API Request

```json
{ 
"apikey": "<your_app_apikey>" 
}
```

### Sample API Response

```json
{
  "data": {
    "broker": "upstox",
    "message": "pong"
  },
  "status": "success"
}
```

### Request Body

| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |

### Response Fields

| Field   | Type   | Description                                        |
| ------- | ------ | -------------------------------------------------- |
| status  | string | Status of the request (success/error)              |
| message | string | Response message ("pong" on successful connection) |
| broker  | string | Name of the connected broker                       |

### Error Response

```json
{ 
"status": "error", "message": "Invalid openalgo apikey" 
}
```

Notes

1. Use this endpoint to verify API connectivity before making other API calls
2. Validates that the API key is correctly configured and active
3. Returns the broker name associated with the validated API key
4. Rate limited to 10 requests per second (configurable via API\_RATE\_LIMIT)
5. Useful for health checks and monitoring API availability



### positionbook

# PositionBook

## Endpoint URL

This API Function fetches the PositionBook details from the broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/positionbook
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/positionbook
Custom Domain:  POST https://<your-custom-domain>/api/v1/positionbook
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```



## Sample API Response

```json
{
  "data": [
    {
      "average_price": "0.00",
      "exchange": "NSE",
      "product": "MIS",
      "quantity": 0,
      "symbol": "YESBANK"
    },
    {
      "average_price": "0.00",
      "exchange": "NSE",
      "product": "MIS",
      "quantity": -1,
      "symbol": "INFY"
    },
    {
      "average_price": "0.00",
      "exchange": "NSE",
      "product": "MIS",
      "quantity": 1,
      "symbol": "RELIANCE"
    }
  ],
  "status": "success"
}
```



## Request Body



| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |






### tradebook

# Tradebook

## Endpoint URL

This API Function fetches the TradeBook details from the broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/tradebook
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/tradebook
Custom Domain:  POST https://<your-custom-domain>/api/v1/tradebook
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```



## Sample API Response

```json
{
  "data": [
    {
      "action": "BUY",
      "average_price": 1914.4,
      "exchange": "NSE",
      "orderid": "24120900009388",
      "product": "MIS",
      "quantity": 1,
      "symbol": "INFY",
      "timestamp": "09-Dec-2024 09:16:48",
      "trade_value": 1914.4
    },
    {
      "action": "SELL",
      "average_price": 21.61,
      "exchange": "NSE",
      "orderid": "24120900010875",
      "product": "MIS",
      "quantity": 20,
      "symbol": "YESBANK",
      "timestamp": "09-Dec-2024 09:17:30",
      "trade_value": 432.2
    }
  ],
  "status": "success"
}
```



## Request Body



| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |






### api-collections

# API Collections

The OpenAlgo API Collections are a comprehensive set of tools designed to streamline your journey into algorithmic trading. Hosted on [GitHub](https://github.com/marketcalls/openalgo/tree/main/collections), these collections offer an intuitive and ready-to-use interface to interact with OpenAlgoâs powerful capabilities, making it easier for developers, traders, and enthusiasts to integrate and automate trading strategies.

[Postman Collections](https://github.com/marketcalls/openalgo/blob/main/collections/openalgo_postman.json)

[Bruno Collections](https://github.com/marketcalls/openalgo/blob/main/collections/openalgo_bruno.json)



### README

# Data API




### depth

# Depth

## Endpoint URL

This API Function get Market Depth from the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/depth
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/depth
Custom Domain:  POST https://<your-custom-domain>/api/v1/depth
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "symbol": "NIFTY31JUL25FUT",
    "exchange": "NFO"
}

```

###

## Sample API Response

```json
{
  "data": {
    "asks": [
      {
        "price": 25741.1,
        "quantity": 3675
      },
      {
        "price": 25744.9,
        "quantity": 150
      },
      {
        "price": 25745,
        "quantity": 600
      },
      {
        "price": 25745.1,
        "quantity": 75
      },
      {
        "price": 25745.2,
        "quantity": 150
      }
    ],
    "bids": [
      {
        "price": 25741,
        "quantity": 150
      },
      {
        "price": 25740,
        "quantity": 375
      },
      {
        "price": 25739.9,
        "quantity": 600
      },
      {
        "price": 25739.8,
        "quantity": 150
      },
      {
        "price": 25739.7,
        "quantity": 75
      }
    ],
    "high": 25772.3,
    "low": 25635,
    "ltp": 25741.1,
    "ltq": 1050,
    "oi": 15056100,
    "open": 25695,
    "prev_close": 25615,
    "totalbuyqty": 789825,
    "totalsellqty": 386175,
    "volume": 3561150
  },
  "status": "success"
}
```



## Request Body



| Parameters | Description    | Mandatory/Optional | Default Value |
| ---------- | -------------- | ------------------ | ------------- |
| apikey     | App API key    | Mandatory          | -             |
| symbol     | Trading symbol | Mandatory          | -             |
| exchange   | Exchange code  | Mandatory          | -             |



## Response Fields



| Field        | Type   | Description                  |
| ------------ | ------ | ---------------------------- |
| asks         | array  | List of 5 best ask prices    |
| bids         | array  | List of 5 best bid prices    |
| totalbuyqty  | number | Total buy quantity           |
| totalsellqty | number | Total sell quantity          |
| high         | number | Day's high price             |
| low          | number | Day's low price              |
| ltp          | number | Last traded price            |
| ltq          | number | Last traded quantity         |
| open         | number | Opening price                |
| prev\_close  | number | Previous day's closing price |
| volume       | number | Total traded volume          |
| oi           | number | Open interest                |



### expiry

# Expiry

The Expiry API allows you to retrieve expiry dates for F\&O (Futures and Options) instruments for a given underlying symbol. This API helps you get all available expiry dates for futures or options contracts of a specific underlying asset.

### Endpoint

```
Local Host   :  POST http://127.0.0.1:5000/api/v1/expiry
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/expiry
Custom Domain:  POST https://<your-custom-domain>/api/v1/expiry
```

### Request Format

#### Headers

* `Content-Type: application/json`

#### Body Parameters

| Parameter        | Type   | Required | Description                                          |
| ---------------- | ------ | -------- | ---------------------------------------------------- |
| `apikey`         | string | Yes      | Your OpenAlgo API key for authentication             |
| `symbol`         | string | Yes      | Underlying symbol (e.g., NIFTY, BANKNIFTY, RELIANCE) |
| `exchange`       | string | Yes      | Exchange code (NFO, BFO, MCX, CDS)                   |
| `instrumenttype` | string | Yes      | Type of instrument - "futures" or "options"          |

#### Supported Exchanges and Instruments

| Exchange | Futures | Options | Examples                   |
| -------- | ------- | ------- | -------------------------- |
| NFO      |        |        | NIFTY, BANKNIFTY, RELIANCE |
| BFO      |        |        | SENSEX, BANKEX             |
| MCX      |        |        | GOLD, SILVER, CRUDEOIL     |
| CDS      |        |        | USDINR, EURINR             |

### Request and Response Examples

#### NIFTY Futures (NFO)

**Request:**

```json
{
    "apikey": "openalgo-api-key",
    "symbol": "NIFTY",
    "exchange": "NFO",
    "instrumenttype": "futures"
}
```

**Response:**

```json
{
    "data": [
        "31-JUL-25",
        "28-AUG-25",
        "25-SEP-25"
    ],
    "message": "Found 3 expiry dates for NIFTY futures in NFO",
    "status": "success"
}
```

#### NIFTY Options (NFO)

**Request:**

```json
{
    "apikey": "openalgo-api-key",
    "symbol": "NIFTY",
    "exchange": "NFO",
    "instrumenttype": "options"
}
```

**Response:**

```json
{
    "data": [
        "10-JUL-25",
        "17-JUL-25",
        "24-JUL-25",
        "31-JUL-25",
        "07-AUG-25",
        "28-AUG-25",
        "25-SEP-25",
        "24-DEC-25",
        "26-MAR-26",
        "25-JUN-26",
        "31-DEC-26",
        "24-JUN-27",
        "30-DEC-27",
        "29-JUN-28",
        "28-DEC-28",
        "28-JUN-29",
        "27-DEC-29",
        "25-JUN-30"
    ],
    "message": "Found 18 expiry dates for NIFTY options in NFO",
    "status": "success"
}
```

#### GOLD Futures (MCX)

**Request:**

```json
{
    "apikey": "openalgo-api-key",
    "symbol": "GOLD",
    "exchange": "MCX",
    "instrumenttype": "futures"
}
```

**Response:**

```json
{
    "data": [
        "05-AUG-25",
        "03-OCT-25",
        "05-DEC-25",
        "05-FEB-26",
        "02-APR-26",
        "05-JUN-26"
    ],
    "message": "Found 6 expiry dates for GOLD futures in MCX",
    "status": "success"
}
```

#### USDINR Futures (CDS)

**Request:**

```json
{
    "apikey": "openalgo-api-key",
    "symbol": "USDINR",
    "exchange": "CDS",
    "instrumenttype": "futures"
}
```

**Response:**

```json
{
    "data": [
        "11-JUL-25",
        "18-JUL-25",
        "25-JUL-25",
        "29-JUL-25",
        "01-AUG-25",
        "08-AUG-25",
        "14-AUG-25",
        "22-AUG-25",
        "26-AUG-25",
        "29-AUG-25",
        "04-SEP-25",
        "12-SEP-25",
        "19-SEP-25",
        "26-SEP-25",
        "29-OCT-25",
        "26-NOV-25",
        "29-DEC-25",
        "28-JAN-26",
        "25-FEB-26",
        "27-MAR-26",
        "28-APR-26",
        "27-MAY-26",
        "26-JUN-26"
    ],
    "message": "Found 23 expiry dates for USDINR futures in CDS",
    "status": "success"
}
```

#### Error Response

```json
{
    "status": "error",
    "message": "Invalid openalgo apikey"
}
```

### Response Fields

| Field     | Type   | Description                                                       |
| --------- | ------ | ----------------------------------------------------------------- |
| `status`  | string | Response status: "success" or "error"                             |
| `message` | string | Descriptive message about the response                            |
| `data`    | array  | Array of expiry dates in DD-MMM-YY format, sorted chronologically |



### Error Codes

| HTTP Status | Error Type   | Description                    |
| ----------- | ------------ | ------------------------------ |
| 200         | Success      | Request processed successfully |
| 400         | Bad Request  | Invalid request parameters     |
| 403         | Forbidden    | Invalid API key                |
| 500         | Server Error | Internal server error          |

### Error Messages

| Message                                                                | Description                              |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| "Invalid openalgo apikey"                                              | The provided API key is invalid          |
| "Symbol parameter is required and cannot be empty"                     | Symbol field is missing or empty         |
| "Exchange parameter is required and cannot be empty"                   | Exchange field is missing or empty       |
| "Instrumenttype parameter is required and cannot be empty"             | Instrumenttype field is missing or empty |
| "Instrumenttype must be either 'futures' or 'options'"                 | Invalid instrumenttype value             |
| "Exchange must be one of: NFO, BFO, MCX, CDS"                          | Invalid exchange value                   |
| "No expiry dates found for \[symbol] \[instrumenttype] in \[exchange]" | No matching expiry dates found           |

### Notes

* Expiry dates are returned in DD-MMM-YY format (e.g., "31-JUL-25")
* Dates are sorted chronologically from earliest to latest
* The API uses exact symbol matching to avoid confusion (e.g., "NIFTY" won't match "BANKNIFTY")
* Different exchanges use different instrument type codes internally but the API accepts standardized "futures" and "options" parameters
* Rate limiting is applied as per your OpenAlgo server configuration

### Rate Limits

This API endpoint is subject to rate limiting. The default rate limit is 10 requests per second per API key, but this may vary based on your OpenAlgo server configuration.

### Common Use Cases

1. **Options Strategy Planning**: Get all available expiry dates for options to plan multi-leg strategies
2. **Futures Trading**: Identify available futures contracts for different expiry months
3. **Calendar Spreads**: Find suitable expiry dates for calendar spread strategies

### Integration Tips

* Cache the expiry dates locally to reduce API calls
* Filter expiry dates based on your trading strategy requirements
* Consider time to expiry when selecting contracts
* Use the chronologically sorted expiry dates for time-based analysis
* Validate the symbol format according to OpenAlgo symbol conventions before making API calls



### history

# History

## Endpoint URL

This API Function to fetch historical data from the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/history
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/history
Custom Domain:  POST https://<your-custom-domain>/api/v1/history
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "symbol": "NIFTY31JUL25FUT",
    "exchange": "NFO",
    "interval": "1m",
    "start_date": "2025-06-26",
    "end_date": "2025-06-27",
  
}

```

###

## Sample API Response

```json
{
  "data": [
    {
      "close": 25292,
      "high": 25302.1,
      "low": 25272.3,
      "oi": 5401650,
      "open": 25302,
      "timestamp": 1750909500,
      "volume": 1042
    },
    {
      "close": 25298,
      "high": 25301,
      "low": 25287.6,
      "oi": 5401650,
      "open": 25288.9,
      "timestamp": 1750909560,
      "volume": 462
    },
    {
      "close": 25303,
      "high": 25310.1,
      "low": 25298.1,
      "oi": 5401650,
      "open": 25298.9,
      "timestamp": 1750909620,
      "volume": 429
    }
  ],
  "status": "success"
}
```



## Request Body



| Parameters  | Description                            | Mandatory/Optional | Default Value |
| ----------- | -------------------------------------- | ------------------ | ------------- |
| apikey      | App API key                            | Mandatory          | -             |
| symbol      | Trading symbol                         | Mandatory          | -             |
| exchange    | Exchange code                          | Mandatory          | -             |
| interval    | candle interval (see supported values) | Mandatory          | -             |
| start\_date | Start date (YYYY-MM-DD)                | Mandatory          | -             |
| end\_date   | End date (YYYY-MM-DD)                  | Mandatory          | -             |



## Response Fields

| Field     | Type   | Description          |
| --------- | ------ | -------------------- |
| timestamp | number | Unix epoch timestamp |
| open      | number | Opening price        |
| high      | number | High price           |
| oi        | number | Open Interest        |
| low       | number | Low price            |
| close     | number | Closing price        |
| volume    | number | Trading volume       |



## Notes



1. Always check supported intervals first using the intervals API
2. Use exact interval strings from intervals API response
3. All timestamps are in Unix epoch format



### intervals

# Intervals

## Endpoint URL

This API Function responds with supported broker timeframe interval for fetching historical data

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/intervals
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/intervals
Custom Domain:  POST https://<your-custom-domain>/api/v1/intervals
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>"
}

```

###

## Sample API Response

```json
{
  "data": {
    "days": [
      "D"
    ],
    "hours": [
      "1h",
      "2h",
      "4h"
    ],
    "minutes": [
      "10m",
      "15m",
      "1m",
      "20m",
      "2m",
      "30m",
      "3m",
      "5m"
    ],
    "months": [
      "M"
    ],
    "seconds": [
      "10s",
      "15s",
      "30s",
      "45s",
      "5s"
    ],
    "weeks": [
      "W"
    ]
  },
  "status": "success"
}
```



## Request Body



| Parameters | Description | Mandatory/Optional | Default Value |
| ---------- | ----------- | ------------------ | ------------- |
| apikey     | App API key | Mandatory          | -             |



## Response Fields

| Field   | Type  | Description                              |
| ------- | ----- | ---------------------------------------- |
| seconds | array | List of supported second-based intervals |
| minutes | array | List of supported minute-based intervals |
| hours   | array | List of supported hour-based intervals   |
| days    | array | List of supported daily intervals        |
| weeks   | array | List of supported weekly intervals       |
| months  | array | List of supported monthly intervals      |



## Notes



1. Always check supported intervals first using the intervals API
2. Use exact interval strings from intervals API response
3. All timestamps are in Unix epoch format



### optiongreeks

# OptionGreeks

### Endpoint URL

This API Function Calculates Option Greeks (Delta, Gamma, Theta, Vega, Rho) and Implied Volatility using Black-Scholes Model

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/optiongreeks
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/optiongreeks
Custom Domain:  POST https://<your-custom-domain>/api/v1/optiongreeks
```

### Prerequisites

1. **mibian Library Required**
   * Install with: `pip install mibian`
   * Or with uv: `uv pip install mibian`
   * Required for Black-Scholes calculations
2. **Market Data Access**
   * Requires real-time LTP for underlying and option
   * Uses OpenAlgo quotes API internally
3. **Valid API Key**
   * API key must be active and valid
   * Get API key from OpenAlgo settings

### Sample API Request (NFO - NIFTY Option with Auto-Detected Spot)

```json
{
    "apikey": "eb51c74ed08ffc821fd5da90b55b7560a3a9e48fd58df01063225ecd7b98c993",
    "symbol": "NIFTY28OCT2526000CE",
    "exchange": "NFO"
}
```

**Note**: Auto-detects NIFTY from NSE\_INDEX (spot) as underlying

####

### Sample API Request (Explicit Underlying with Zero Interest Rate)

```json
{
    "apikey": "eb51c74ed08ffc821fd5da90b55b7560a3a9e48fd58df01063225ecd7b98c993",
    "symbol": "NIFTY28OCT2526000CE",
    "exchange": "NFO",
    "interest_rate": 0,
    "underlying_symbol": "NIFTY",
    "underlying_exchange": "NSE_INDEX"
}
```

**Note**: Explicitly specifies NIFTY spot from NSE\_INDEX. Using interest\_rate: 0 for theoretical calculations or when interest rate impact is negligible.

####

### Sample API Response (Success)

```json
{
    "status": "success",
    "symbol": "NIFTY28OCT2526000CE",
    "exchange": "NFO",
    "underlying": "NIFTY",
    "strike": 26000,
    "option_type": "CE",
    "expiry_date": "28-Oct-2025",
    "days_to_expiry": 0.59,
    "spot_price": 25966.05,
    "option_price": 85.55,
    "interest_rate": 0,
    "implied_volatility": 464.42,
    "greeks": {
        "delta": 0.4489,
        "gamma": 0.001554,
        "theta": -30962.4879,
        "vega": 0.2169,
        "rho": 0.000516
    }
}
```

**Note**: This is an expiry day example (0.59 days to expiry) showing very high IV (464.42%) and extreme theta decay (-30962.48 per day), typical of near-expiry ATM options.

####

### Sample API Request (Using Futures as Underlying)

```json
{
    "apikey": "eb51c74ed08ffc821fd5da90b55b7560a3a9e48fd58df01063225ecd7b98c993",
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO",
    "underlying_symbol": "NIFTY28NOV25FUT",
    "underlying_exchange": "NFO"
}
```

**Note**: Uses futures price instead of spot for calculations. Useful when options are based on futures pricing.

####

### Sample API Response (Success - Standard)

```json
{
    "status": "success",
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO",
    "underlying": "NIFTY",
    "strike": 26000,
    "option_type": "CE",
    "expiry_date": "28-Nov-2025",
    "days_to_expiry": 5.42,
    "spot_price": 26015.75,
    "option_price": 125.50,
    "interest_rate": 0,
    "implied_volatility": 15.25,
    "greeks": {
        "delta": 0.5234,
        "gamma": 0.000125,
        "theta": -12.5678,
        "vega": 18.7654,
        "rho": 0.001234
    }
}
```

**Note**: Shows default `interest_rate: 0`. For long-dated options, specify current RBI repo rate for accurate Rho.

####

### Sample API Request (With Custom Interest Rate)

```json
{
    "apikey": "eb51c74ed08ffc821fd5da90b55b7560a3a9e48fd58df01063225ecd7b98c993",
    "symbol": "BANKNIFTY28NOV2550000CE",
    "exchange": "NFO",
    "interest_rate": 6.5
}
```

**Note**: Explicitly specify interest rate (e.g., 6.5%) for accurate Rho calculations, especially for long-dated options.

####

### Sample API Request (BFO - SENSEX Option)

```json
{
    "apikey": "your_api_key",
    "symbol": "SENSEX28NOV2580000CE",
    "exchange": "BFO"
}
```

####

### Sample API Request (CDS - Currency Option)

```json
{
    "apikey": "your_api_key",
    "symbol": "USDINR28NOV2585.50CE",
    "exchange": "CDS"
}
```

####

### Sample API Request (MCX - Commodity Option with Custom Expiry Time)

```json
{
    "apikey": "your_api_key",
    "symbol": "CRUDEOIL17NOV255400CE",
    "exchange": "MCX",
    "expiry_time": "19:00"
}
```

**Note**: MCX contracts have different expiry times. Crude Oil expires at 7:00 PM (19:00), so specify custom expiry time.

####

### Sample API Request (MCX - NATURALGAS at 19:00)

```json
{
    "apikey": "your_api_key",
    "symbol": "NATURALGAS28DEC25300CE",
    "exchange": "MCX",
    "expiry_time": "19:00"
}
```

**Note**: Natural Gas expires at 7:00 PM (19:00). Always specify correct expiry time for MCX.

####

### Parameter Description

| Parameters           | Description                                                                                                                                                                                          | Mandatory/Optional | Default Value                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| apikey               | App API key                                                                                                                                                                                          | Mandatory          | -                                                      |
| symbol               | Option symbol (e.g., NIFTY28NOV2526000CE)                                                                                                                                                            | Mandatory          | -                                                      |
| exchange             | Exchange code (NFO, BFO, CDS, MCX)                                                                                                                                                                   | Mandatory          | -                                                      |
| interest\_rate       | Risk-free interest rate (annualized %). Specify current RBI repo rate (e.g., 6.5, 6.75) for accurate Rho calculations. Use 0 for theoretical calculations or when interest rate impact is negligible | Optional           | 0                                                      |
| underlying\_symbol   | Custom underlying symbol (e.g., NIFTY or NIFTY28NOV25FUT)                                                                                                                                            | Optional           | Auto-detected                                          |
| underlying\_exchange | Custom underlying exchange (e.g., NSE\_INDEX or NFO)                                                                                                                                                 | Optional           | Auto-detected                                          |
| expiry\_time         | Custom expiry time in HH:MM format (e.g., "17:00", "19:00"). Required for MCX contracts with non-standard expiry times                                                                               | Optional           | Exchange defaults: NFO/BFO=15:30, CDS=12:30, MCX=23:30 |

**Notes**:

* **Interest Rate**: Default is 0. For accurate Greeks (especially Rho), specify current RBI repo rate (typically 6.25-7.0%). Interest rate has minimal impact on short-term options (< 7 days).
* Use `underlying_symbol` and `underlying_exchange` to choose between spot and futures as underlying. If not specified, automatically uses spot price.
* Use `expiry_time` for MCX commodities that don't expire at the default 23:30. See MCX Commodity Expiry Times section below.

####

### Response Parameters

| Parameter           | Description                            | Type   |
| ------------------- | -------------------------------------- | ------ |
| status              | API response status (success/error)    | string |
| symbol              | Option symbol                          | string |
| exchange            | Exchange code                          | string |
| underlying          | Underlying symbol                      | string |
| strike              | Strike price                           | number |
| option\_type        | Option type (CE/PE)                    | string |
| expiry\_date        | Expiry date (formatted)                | string |
| days\_to\_expiry    | Days remaining to expiry               | number |
| spot\_price         | Underlying spot/futures price          | number |
| option\_price       | Current option premium                 | number |
| interest\_rate      | Interest rate used                     | number |
| implied\_volatility | Implied Volatility (%)                 | number |
| greeks              | Object containing Greeks               | object |
| greeks.delta        | Delta (rate of change of option price) | number |
| greeks.gamma        | Gamma (rate of change of delta)        | number |
| greeks.theta        | Theta (time decay per day)             | number |
| greeks.vega         | Vega (sensitivity to volatility)       | number |
| greeks.rho          | Rho (sensitivity to interest rate)     | number |

####

### Understanding Greeks

#### Delta

* **Range**: -1 to +1 (Call: 0 to 1, Put: -1 to 0)
* **Meaning**: Change in option price for 1 change in underlying
* **Example**: Delta of 0.5 means option moves 0.50 for 1 move in underlying
* **Use**: Position sizing, hedge ratio calculation

#### Gamma

* **Range**: 0 to  (same for Call and Put)
* **Meaning**: Change in Delta for 1 change in underlying
* **Example**: Gamma of 0.01 means Delta increases by 0.01 for 1 rise
* **Use**: Delta hedging frequency, risk assessment

#### Theta

* **Range**: Negative for long options
* **Meaning**: Change in option price per day (time decay)
* **Example**: Theta of -10 means option loses 10 per day
* **Use**: Time decay analysis, optimal holding period

#### Vega

* **Range**: Positive for long options
* **Meaning**: Change in option price for 1% change in IV
* **Example**: Vega of 15 means option gains 15 if IV rises by 1%
* **Use**: Volatility trading, earnings plays

#### Rho

* **Range**: Positive for Calls, Negative for Puts
* **Meaning**: Change in option price for 1% change in interest rate
* **Example**: Rho of 0.05 means option gains 0.05 for 1% rate rise
* **Use**: Long-term options, rate-sensitive strategies

####

### Supported Exchanges and Symbols

#### NFO (NSE Futures & Options)

**Index Options:**

* NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY

**Equity Options:**

* All NSE stocks with F\&O segment (RELIANCE, TCS, INFY, etc.)

**Symbol Format:** `SYMBOL[DD][MMM][YY][STRIKE][CE/PE]`

* Example: `NIFTY28NOV2526000CE`

**Expiry Time:** 3:30 PM (15:30 IST)

#### BFO (BSE Futures & Options)

**Index Options:**

* SENSEX, BANKEX, SENSEX50

**Symbol Format:** `SYMBOL[DD][MMM][YY][STRIKE][CE/PE]`

* Example: `SENSEX28NOV2580000CE`

**Expiry Time:** 3:30 PM (15:30 IST)

#### CDS (Currency Derivatives)

**Currency Pairs:**

* USDINR, EURINR, GBPINR, JPYINR

**Symbol Format:** `SYMBOL[DD][MMM][YY][STRIKE][CE/PE]`

* Example: `USDINR28NOV2585.50CE`
* Note: Strike can have decimals for currency options

**Expiry Time:** 12:30 PM (12:30 IST)

#### MCX (Multi Commodity Exchange)

**Commodities:**

* GOLD, GOLDM, SILVER, SILVERM
* CRUDEOIL, NATURALGAS
* COPPER, ZINC, LEAD, ALUMINIUM

**Symbol Format:** `SYMBOL[DD][MMM][YY][STRIKE][CE/PE]`

* Example: `CRUDEOIL17NOV255400CE`

**Default Expiry Time:** 11:30 PM (23:30 IST)

**Important**: MCX commodities have different expiry times. Always specify `expiry_time` parameter for accurate Greeks calculation.

#### MCX Commodity Expiry Times

Different MCX commodities expire at different times. Use the `expiry_time` parameter to specify the correct time:

| Commodity Category         | Expiry Time | Format  | Example Request          |
| -------------------------- | ----------- | ------- | ------------------------ |
| **Precious Metals**        |             |         |                          |
| GOLD, GOLDM, GOLDPETAL     | 5:00 PM     | "17:00" | `"expiry_time": "17:00"` |
| SILVER, SILVERM, SILVERMIC | 5:00 PM     | "17:00" | `"expiry_time": "17:00"` |
| **Energy**                 |             |         |                          |
| CRUDEOIL, CRUDEOILM        | 7:00 PM     | "19:00" | `"expiry_time": "19:00"` |
| NATURALGAS                 | 7:00 PM     | "19:00" | `"expiry_time": "19:00"` |
| **Base Metals**            |             |         |                          |
| COPPER, ZINC, LEAD         | 5:00 PM     | "17:00" | `"expiry_time": "17:00"` |
| ALUMINIUM, NICKEL          | 5:00 PM     | "17:00" | `"expiry_time": "17:00"` |
| **Agri Commodities**       |             |         |                          |
| COTTONCANDY, MENTHAOIL     | 5:00 PM     | "17:00" | `"expiry_time": "17:00"` |

**API Request Examples:**

```json
// Crude Oil expires at 7:00 PM (LTP: 5443)
{
    "apikey": "your_api_key",
    "symbol": "CRUDEOIL17NOV255400CE",
    "exchange": "MCX",
    "expiry_time": "19:00"
}

// Gold expires at 5:00 PM
{
    "apikey": "your_api_key",
    "symbol": "GOLD28DEC2575000CE",
    "exchange": "MCX",
    "expiry_time": "17:00"
}

// Natural Gas expires at 7:00 PM
{
    "apikey": "your_api_key",
    "symbol": "NATURALGAS28DEC25300CE",
    "exchange": "MCX",
    "expiry_time": "19:00"
}
```

**Note**: If you don't specify `expiry_time`, it defaults to 23:30 (11:30 PM), which may give incorrect Greeks for most MCX commodities.

####

### API Request Examples: With and Without Optional Parameters

This section demonstrates various usage scenarios and when to use optional parameters.

#### Example 1: Basic Request (No Optional Parameters)

**Scenario**: Calculate Greeks for NIFTY option using default settings

```json
{
    "apikey": "your_api_key",
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO"
}
```

**What Happens**:

*  Auto-detects NIFTY from NSE\_INDEX (spot price)
*  Uses default interest rate: 0%
*  Uses default expiry time: 15:30 (NFO)
*  Simplest usage - good for most traders

**When to Use**:

* Standard index options trading
* Short-term options (< 7 days) where interest rate impact is negligible
* When you don't need accurate Rho calculations

***

#### Example 2: With Custom Interest Rate

**Scenario**: Calculate Greeks with current RBI repo rate for long-dated option

```json
{
    "apikey": "your_api_key",
    "symbol": "BANKNIFTY28NOV2550000CE",
    "exchange": "NFO",
    "interest_rate": 6.5
}
```

**What Happens**:

*  Uses 6.5% instead of default 0%
*  Affects Rho calculation significantly
*  Minor impact on other Greeks (< 0.5%)

**When to Use**:

* Long-dated options (> 30 days to expiry)
* Interest rate sensitive strategies (Rho hedging)
* Comparing with broker Greeks that use specific rates
* Professional trading requiring accurate Rho

**When NOT to Use**:

* Short-term weekly options (impact < 0.1%)
* Theoretical calculations (use default 0)

***

#### Example 3: Using Futures as Underlying

**Scenario**: Calculate Greeks based on futures price (arbitrage trading)

```json
{
    "apikey": "your_api_key",
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO",
    "underlying_symbol": "NIFTY28NOV25FUT",
    "underlying_exchange": "NFO"
}
```

**What Happens**:

*  Uses NIFTY futures price instead of spot
*  Futures price includes cost of carry
*  Delta, IV may differ by 1-3% vs spot

**When to Use**:

* Arbitrage strategies (futures vs options)
* When broker uses futures for Greeks
* Equity options with liquid futures
* Professional trading desks

**Example - Equity with Futures**:

```json
{
    "apikey": "your_api_key",
    "symbol": "RELIANCE28NOV251600CE",
    "exchange": "NFO",
    "underlying_symbol": "RELIANCE28NOV25FUT",
    "underlying_exchange": "NFO"
}
```

***

#### Example 4: MCX with Custom Expiry Time

**Scenario**: Calculate Greeks for Crude Oil options (expires at 19:00)

```json
{
    "apikey": "your_api_key",
    "symbol": "CRUDEOIL17NOV255400CE",
    "exchange": "MCX",
    "expiry_time": "19:00"
}
```

**What Happens**:

*  Uses 19:00 (7 PM) expiry instead of default 23:30
*  DTE calculated accurately
*  Theta, IV more accurate on expiry day

**When to Use**:

* ALL MCX commodity options (except those expiring at 23:30)
* Critical for accurate Greeks on expiry day
* Gold, Silver, Copper: 17:00
* Natural Gas, Crude Oil: 19:00

**Example - Natural Gas at 19:00**:

```json
{
    "apikey": "your_api_key",
    "symbol": "NATURALGAS28DEC245000CE",
    "exchange": "MCX",
    "expiry_time": "19:00"
}
```

***

#### Example 5: Currency Options (CDS)

**Scenario**: USD/INR option (expires at 12:30)

```json
{
    "apikey": "your_api_key",
    "symbol": "USDINR28NOV2483.50CE",
    "exchange": "CDS"
}
```

**What Happens**:

*  Auto-detects USDINR from CDS exchange
*  Uses correct expiry time: 12:30 (CDS default)
*  Supports decimal strikes (83.50)

**When to Use**: Currency derivatives trading

***

#### Example 6: All Parameters Combined

**Scenario**: Professional setup with full control

```json
{
    "apikey": "your_api_key",
    "symbol": "NIFTY28DEC2526500CE",
    "exchange": "NFO",
    "interest_rate": 6.75,
    "underlying_symbol": "NIFTY28DEC25FUT",
    "underlying_exchange": "NFO"
}
```

**What Happens**:

*  Custom interest rate: 6.75% (instead of default 0%)
*  Uses futures as underlying (instead of spot)
*  Maximum control over calculation

**When to Use**:

* Institutional trading with specific interest rate requirements
* Greeks matching with broker platform that uses specific rates
* Research and backtesting with historical interest rates
* Long-dated options requiring accurate Rho

***

#### Example 7: BSE Options (BFO)

**Scenario**: SENSEX option

```json
{
    "apikey": "your_api_key",
    "symbol": "SENSEX28NOV2475000CE",
    "exchange": "BFO"
}
```

**What Happens**:

*  Auto-detects SENSEX from BSE\_INDEX
*  Uses correct expiry time: 15:30 (BFO)

**When to Use**: BSE index options trading

***

#### Quick Reference: When to Use Optional Parameters

| Parameter             | Use When                                          | Don't Use When                |
| --------------------- | ------------------------------------------------- | ----------------------------- |
| `interest_rate`       | Long-dated options, Rho analysis, matching broker | Short-term weekly options     |
| `underlying_symbol`   | Arbitrage, comparing with broker, equity options  | Standard index option trading |
| `underlying_exchange` | Custom underlying setup                           | Auto-detection works fine     |
| `expiry_time`         | **ALWAYS for MCX** (except 23:30 contracts)       | NFO/BFO/CDS (already correct) |

***

#### Impact of Optional Parameters on Greeks

**Interest Rate (Default 0%  Custom 6.5%)**:

* Rho: Significant change (from near-zero to meaningful value)
* Delta: ±0.2-0.5% change (for long-dated options)
* Other Greeks: < 0.1% change
* **Impact**:
  * **High for Rho** (critical for interest rate sensitive strategies)
  * **Low for other Greeks** (especially short-term options)
  * **Negligible for < 7 days to expiry**

**Underlying: Spot vs Futures (1% difference in price)**:

* Delta: ±2-5% change
* IV: ±0.3-1% change
* Other Greeks: ±1-3% change
* **Impact**: Moderate to High

**Expiry Time (6 hours difference: 17:00 vs 23:30)**:

* DTE: 6 hours difference
* Theta: ±10-30% change on expiry day
* IV: ±2-8% change near expiry
* Gamma: ±5-15% change near expiry
* **Impact**: High (especially near expiry)

***

### Exchange-Specific Expiry Times

| Exchange | Expiry Time      | Impact on DTE & Greeks                            |
| -------- | ---------------- | ------------------------------------------------- |
| NFO      | 3:30 PM (15:30)  | Standard - Most index & equity options            |
| BFO      | 3:30 PM (15:30)  | Standard - BSE index options                      |
| CDS      | 12:30 PM (12:30) | Earlier expiry - Higher theta near expiry morning |
| MCX      | 11:30 PM (23:30) | Later expiry - More time value on expiry day      |

**DTE Calculation:**

* Days to Expiry (DTE) is calculated in years: `(expiry_datetime - current_datetime) / 365`
* Accurate expiry time ensures precise time decay (theta) calculations
* CDS options expire 3 hours before NFO/BFO, affecting same-day calculations
* MCX options have 8 extra hours compared to NFO/BFO on expiry day

**Example - Same Expiry Date, Different Times:**

```
Date: 17-Nov-2025 at 2:00 PM

CDS Option (USDINR17NOV2585.50CE):
  - Expired 1.5 hours ago (12:30 PM)
  - DTE: 0 (already expired)

NFO Option (NIFTY17NOV2526000CE):
  - Expires in 1.5 hours (3:30 PM)
  - DTE: 0.0063 years (~1.5 hours)

MCX Option (CRUDEOIL17NOV255400CE):
  - Expires in 5 hours (7:00 PM) [Crude Oil expires at 19:00]
  - DTE: 0.0208 years (~5 hours)
```

####

### Default Interest Rates by Exchange

| Exchange | Default Rate (%) | Description          |
| -------- | ---------------- | -------------------- |
| NFO      | 0                | NSE F\&O             |
| BFO      | 0                | BSE F\&O             |
| CDS      | 0                | Currency Derivatives |
| MCX      | 0                | Commodities          |

**Note**: Default is 0 for all exchanges. Explicitly specify `interest_rate` parameter (e.g., 6.5, 6.75) for accurate Rho calculations and when trading long-dated options.

**When to Specify Interest Rate**:

*  Long-dated options (> 30 days to expiry)
*  Interest rate sensitive strategies (Rho hedging)
*  Matching with broker Greeks
*  Short-term options (< 7 days) - minimal impact
*  Theoretical or academic calculations

####

### Error Responses

#### mibian Library Not Installed

```json
{
    "status": "error",
    "message": "Option Greeks calculation requires mibian library. Install with: pip install mibian"
}
```

#### Invalid Symbol Format

```json
{
    "status": "error",
    "message": "Invalid option symbol format: NIFTY2400CE"
}
```

#### Option Expired

```json
{
    "status": "error",
    "message": "Option has expired on 28-Oct-2024"
}
```

#### Underlying Price Not Available

```json
{
    "status": "error",
    "message": "Failed to fetch underlying price: Symbol not found"
}
```

#### Option Price Not Available

```json
{
    "status": "error",
    "message": "Option LTP not available"
}
```

####

### Common Error Messages

| Error Message                    | Cause                        | Solution                                     |
| -------------------------------- | ---------------------------- | -------------------------------------------- |
| mibian library not installed     | Missing dependency           | Run: pip install mibian                      |
| Invalid option symbol format     | Symbol pattern doesn't match | Use: SYMBOL\[DD]\[MMM]\[YY]\[STRIKE]\[CE/PE] |
| Option has expired               | Expiry date in the past      | Use current month contracts                  |
| Failed to fetch underlying price | Underlying symbol not found  | Verify symbol and exchange                   |
| Option LTP not available         | No trading data for option   | Check market hours, symbol validity          |
| Invalid openalgo apikey          | API key incorrect            | Verify API key in settings                   |

####

### How Expiry Times Affect Calculations

#### Impact on Time to Expiry (DTE)

Accurate expiry times are critical for precise Greeks calculation. The API automatically uses exchange-specific expiry times:

**Time to Expiry Formula:**

```python
time_to_expiry = (expiry_datetime - current_datetime) / 365
```

**Example on Expiry Day (28-Nov-2025):**

| Time Now | CDS (12:30)          | NFO/BFO (15:30)      | MCX (23:30)           |
| -------- | -------------------- | -------------------- | --------------------- |
| 10:00 AM | 2.5 hrs (0.0104 yrs) | 5.5 hrs (0.0229 yrs) | 13.5 hrs (0.0563 yrs) |
| 12:00 PM | 0.5 hrs (0.0021 yrs) | 3.5 hrs (0.0146 yrs) | 11.5 hrs (0.0479 yrs) |
| 1:00 PM  | Expired (0 yrs)      | 2.5 hrs (0.0104 yrs) | 10.5 hrs (0.0438 yrs) |
| 4:00 PM  | Expired (0 yrs)      | Expired (0 yrs)      | 7.5 hrs (0.0313 yrs)  |

#### Impact on Theta (Time Decay)

**Theta accelerates as expiry approaches:**

```
CDS at 11:00 AM (1.5 hours to expiry):
  Theta: -50 to -100 per day (very high decay)

NFO at 11:00 AM (4.5 hours to expiry):
  Theta: -30 to -60 per day (high decay)

MCX at 11:00 AM (12.5 hours to expiry):
  Theta: -15 to -30 per day (moderate decay)
```

**Key Insight**: On expiry day morning, CDS options decay faster than NFO/BFO, which decay faster than MCX.

#### Impact on Implied Volatility

**Same option, different DTE affects IV calculation:**

* **More time**  Lower IV for same premium (more time value)
* **Less time**  Higher IV for same premium (less time value)

**Example:**

```
NIFTY Option Premium: 50

At 10:00 AM (5.5 hrs to NFO expiry):
  Implied IV: ~18%

At 3:00 PM (0.5 hrs to NFO expiry):
  Implied IV: ~35%
  (Same premium, but much higher IV due to less time)
```

#### Impact on Delta

**Delta is less affected** by small DTE changes, but:

* Very near expiry (< 1 hour), delta can shift rapidly
* ATM options approach delta of 0.5 faster
* Deep ITM  1.0, Deep OTM  0.0 faster near expiry

#### Impact on Gamma

**Gamma peaks near expiry** for ATM options:

```
NIFTY ATM Call:

7 days before expiry:
  Gamma: ~0.0001

1 day before expiry:
  Gamma: ~0.001 (10x higher)

1 hour before expiry:
  Gamma: ~0.01 (100x higher - very sensitive!)
```

**Exchange Comparison on Expiry Day 10:00 AM:**

* **CDS** (2.5 hrs left): Gamma \~0.008 (very high)
* **NFO** (5.5 hrs left): Gamma \~0.005 (high)
* **MCX** (13.5 hrs left): Gamma \~0.002 (moderate)

#### Impact on Vega

**Vega decreases as expiry approaches:**

```
NIFTY ATM Call:

30 days to expiry:
  Vega: ~25 (high sensitivity to IV)

7 days to expiry:
  Vega: ~12

1 day to expiry:
  Vega: ~3 (low sensitivity)
```

**On Expiry Day:** MCX options retain more vega than NFO, which retain more than CDS.

#### Practical Implications

1. **Trading on Expiry Day:**
   * CDS options lose time value fastest (expire by lunch)
   * NFO/BFO options decay rapidly in afternoon
   * MCX options have full day to trade
2. **IV Calculations:**
   * Use correct expiry time to avoid IV calculation errors
   * Wrong expiry time can show IV off by 2-5% near expiry
3. **Theta Strategies:**
   * CDS theta decay is most aggressive in morning
   * MCX theta spreads decay over longer period
4. **Gamma Scalping:**
   * CDS gamma peaks earlier in the day
   * NFO gamma highest 12-3 PM on expiry
   * MCX gamma peaks late evening

####

### Spot vs Futures as Underlying

#### When to Use Spot (Default)

**Best For**:

* Index options (NIFTY, BANKNIFTY, SENSEX)
* Currency options (USDINR, EURINR)
* Most traders prefer spot for simplicity

**Example**:

```json
{
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO"
}
```

Auto-detects NIFTY from NSE\_INDEX

#### When to Use Futures

**Best For**:

* Arbitrage strategies
* When option pricing is based on futures
* Comparing with broker Greeks that use futures
* Equity options where futures are liquid

**Example - Using Futures**:

```json
{
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO",
    "underlying_symbol": "NIFTY28NOV25FUT",
    "underlying_exchange": "NFO"
}
```

**Example - Equity with Futures**:

```json
{
    "symbol": "RELIANCE28NOV251600CE",
    "exchange": "NFO",
    "underlying_symbol": "RELIANCE28NOV25FUT",
    "underlying_exchange": "NFO"
}
```

#### Spot vs Futures Pricing Difference

* **Spot**: Current index/stock price
* **Futures**: Forward price (includes cost of carry)
* **Difference**: Typically 0.5-2% depending on time to expiry
* **Impact**: Can affect Delta by 1-3% and IV by 0.1-0.5%

####

### Use Cases

#### 1. Delta-Neutral Portfolio

Calculate delta of all option positions to maintain market-neutral portfolio.

```python
# Get greeks for each position
call_greeks = get_option_greeks("NIFTY28NOV2526000CE")
put_greeks = get_option_greeks("NIFTY28NOV2526000PE")

# Calculate net delta
net_delta = (call_qty * call_greeks['delta']) + (put_qty * put_greeks['delta'])

# Hedge with futures if needed
```

#### 2. Time Decay Analysis

Monitor theta to understand daily decay and optimal exit timing.

```python
# Check theta for your position
greeks = get_option_greeks("BANKNIFTY28NOV2550000CE")

# If theta is very high (e.g., -50), consider:
# - Closing position before weekend
# - Rolling to next expiry
# - Adjusting position size
```

#### 3. Volatility Trading

Use vega to identify options most sensitive to IV changes.

```python
# Compare vega across strikes
atm_greeks = get_option_greeks("NIFTY28NOV2526000CE")  # ATM
otm_greeks = get_option_greeks("NIFTY28NOV2526500CE")  # OTM

# ATM options typically have highest vega
# Trade before events: earnings, RBI policy, budget
```

#### 4. Risk Assessment

Use gamma to understand risk of rapid delta changes.

```python
# High gamma = High risk/reward
# Gamma highest for ATM options near expiry

greeks = get_option_greeks("NIFTY28NOV2526000CE")

if greeks['gamma'] > 0.01:
    print("High gamma - expect rapid delta changes")
    # Consider: tighter stop-loss, reduce position size
```

####

### Integration Examples

#### Python Example

```python
import requests

def get_option_greeks(symbol, exchange, interest_rate=None):
    url = "http://127.0.0.1:5000/api/v1/optiongreeks"

    payload = {
        "apikey": "your_api_key_here",
        "symbol": symbol,
        "exchange": exchange
    }

    if interest_rate:
        payload["interest_rate"] = interest_rate

    response = requests.post(url, json=payload)
    return response.json()

# Usage
greeks = get_option_greeks("NIFTY28NOV2526000CE", "NFO")

print(f"Delta: {greeks['greeks']['delta']}")
print(f"Theta: {greeks['greeks']['theta']}")
print(f"IV: {greeks['implied_volatility']}%")
```

#### JavaScript Example

```javascript
async function getOptionGreeks(symbol, exchange, interestRate = null) {
    const url = 'http://127.0.0.1:5000/api/v1/optiongreeks';

    const payload = {
        apikey: 'your_api_key_here',
        symbol: symbol,
        exchange: exchange
    };

    if (interestRate) {
        payload.interest_rate = interestRate;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    return await response.json();
}

// Usage
getOptionGreeks('BANKNIFTY28NOV2550000CE', 'NFO')
    .then(data => {
        console.log('Delta:', data.greeks.delta);
        console.log('IV:', data.implied_volatility);
    });
```

#### cURL Example

```bash
curl -X POST http://127.0.0.1:5000/api/v1/optiongreeks \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key_here",
    "symbol": "NIFTY28NOV2526000CE",
    "exchange": "NFO"
  }'
```

####

### Rate Limiting

* **Limit**: 30 requests per minute
* **Scope**: Per API endpoint
* **Response**: 429 status code if limit exceeded

####

### Best Practices

1. **Install Dependencies First**
   * Install mibian before using API: `pip install mibian`
   * Verify installation: `python -c "import mibian"`
2. **Use Current Contracts**
   * Expired options will return error
   * Use current or future expiry dates
3. **Verify Symbol Format**
   * Format: `SYMBOL[DD][MMM][YY][STRIKE][CE/PE]`
   * Example: `NIFTY28NOV2526000CE` 
   * Wrong: `NIFTY24000CE` 
4. **Market Hours**
   * Greeks require live prices
   * Ensure markets are open for accurate data
   * Pre-market/post-market may have stale data
5. **Interest Rate Selection**
   * Default is 0% (no interest rate impact)
   * Explicitly specify current RBI repo rate (6.25-7.0%) for:
     * Long-dated options (> 30 days to expiry)
     * Rho-sensitive strategies
     * Matching with broker Greeks
   * Interest rate has minimal impact on short-term options (< 7 days)
6. **Understand Greek Limitations**
   * Based on Black-Scholes (assumes log-normal distribution)
   * May not account for dividends, early exercise
   * More accurate for European-style index options
7. **Cache Results**
   * Greeks don't change drastically every second
   * Cache for 30-60 seconds to reduce API calls
   * Recalculate when underlying moves significantly

####

### Troubleshooting

#### Import Error: No module named 'mibian'

**Solution**: Install mibian library

```bash
pip install mibian
# or
uv pip install mibian
```

#### Greeks Seem Incorrect

**Possible Causes**:

1. **Stale Prices**: Check if markets are open
2. **Wrong Interest Rate**: Adjust interest\_rate parameter
3. **Symbol Parsing**: Verify symbol format
4. **Deep ITM/OTM**: Greeks may be extreme for deep options

**Solution**:

* Verify underlying and option LTP manually
* Compare with broker's Greeks
* Check expiry date is future

#### High IV Calculation Errors

**Cause**: Black-Scholes may not converge for very deep ITM/OTM options

**Solution**:

* Use ATM or near-ATM options for accurate Greeks
* Very deep options may require different models

####

### Technical Notes

#### Black-Scholes Model

The API uses Black-Scholes model for European options:

**Assumptions**:

* Constant volatility
* Log-normal price distribution
* No dividends
* European exercise (index options)

**Calculation Steps**:

1. Parse option symbol to extract strike, expiry
2. Fetch spot price and option premium
3. Calculate time to expiry in years
4. Solve for Implied Volatility (IV)
5. Calculate Greeks using BS model with IV

#### Symbol Parsing

Supports multiple formats across exchanges:

* **NFO**: `NIFTY28NOV2526000CE`
* **BFO**: `SENSEX28NOV2580000CE`
* **CDS**: `USDINR28NOV2585.50CE` (decimal strikes)
* **MCX**: `CRUDEOIL17NOV255400CE`

####

### Features

1. **Multi-Exchange Support**: NFO, BFO, CDS, MCX
2. **Automatic Price Fetching**: Gets live prices via quotes API
3. **Accurate IV Calculation**: Solves Black-Scholes for IV
4. **Complete Greeks**: Delta, Gamma, Theta, Vega, Rho
5. **Flexible Interest Rate**: Override default per request
6. **Decimal Strike Support**: For currency options
7. **Error Handling**: Comprehensive validation and errors

####

### Limitations

1. **Requires mibian Library**: Must install separately
2. **European Options**: Best suited for index options
3. **No Dividend Adjustment**: Doesn't account for dividends
4. **Market Hours**: Requires live prices for accuracy
5. **Deep Options**: May have convergence issues for very deep ITM/OTM
6. **Rate Assumption**: Uses fixed interest rate (not dynamic)

####

### Support

For issues or questions:

* Verify mibian installation
* Check symbol format matches documented pattern
* Ensure markets are open for live data
* Review OpenAlgo logs for detailed errors
* Compare with broker Greeks to validate



### optionsymbol

# OptionSymbol

## Option Symbol

### Endpoint URL

This API Function Returns Option Symbol Details based on Underlying and Offset

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/optionsymbol
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/optionsymbol
Custom Domain:  POST https://<your-custom-domain>/api/v1/optionsymbol
```

### Sample API Request (Index Underlying)

```json
{
    "apikey": "eb51c74ed08ffc821fd5da90b55b7560a3a9e48fd58df01063225ecd7b98c993",
    "strategy": "test_strategy",
    "underlying": "NIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28OCT25",
    "strike_int": 50,
    "offset": "ITM2",
    "option_type": "CE"
}
```

####

### Sample API Response

```json
{
    "status": "success",
    "symbol": "NIFTY28OCT2525850CE",
    "exchange": "NFO",
    "lotsize": 75,
    "tick_size": 0.05,
    "underlying_ltp": 25966.05
}
```

####

### Sample API Request (Future as Underlying)

```json
{
    "apikey": "eb51c74ed08ffc821fd5da90b55b7560a3a9e48fd58df01063225ecd7b98c993",
    "strategy": "test_strategy",
    "underlying": "NIFTY28OCT25FUT",
    "exchange": "NFO",
    "strike_int": 50,
    "offset": "ITM2",
    "option_type": "CE"
}
```

####

### Sample API Response

```json
{
    "status": "success",
    "symbol": "NIFTY28OCT2525850CE",
    "exchange": "NFO",
    "lotsize": 75,
    "tick_size": 0.05,
    "underlying_ltp": 25966.05
}
```

####

### Parameter Description

| Parameters   | Description                                                | Mandatory/Optional | Default Value |
| ------------ | ---------------------------------------------------------- | ------------------ | ------------- |
| apikey       | App API key                                                | Mandatory          | -             |
| strategy     | Strategy name                                              | Mandatory          | -             |
| underlying   | Underlying symbol (NIFTY, BANKNIFTY, NIFTY28OCT25FUT)      | Mandatory          | -             |
| exchange     | Exchange code (NSE\_INDEX, NSE, NFO, BSE\_INDEX, BSE, BFO) | Mandatory          | -             |
| expiry\_date | Expiry date in DDMMMYY format (e.g., 28OCT25)              | Optional\*         | -             |
| strike\_int  | Strike interval (50 for NIFTY, 100 for BANKNIFTY)          | Mandatory          | -             |
| offset       | Strike offset (ATM, ITM1-ITM50, OTM1-OTM50)                | Mandatory          | -             |
| option\_type | Option type (CE for Call, PE for Put)                      | Mandatory          | -             |

\*Note: expiry\_date is optional if underlying includes expiry (e.g., NIFTY28OCT25FUT)

####

### Response Parameters

| Parameter       | Description                          | Type   |
| --------------- | ------------------------------------ | ------ |
| status          | API response status (success/error)  | string |
| symbol          | Resolved option symbol               | string |
| exchange        | Exchange code where option is listed | string |
| lotsize         | Lot size of the option contract      | number |
| tick\_size      | Minimum price movement               | number |
| underlying\_ltp | Last Traded Price of underlying      | number |

####

### Examples for Different Underlyings

#### NIFTY (Strike Interval: 50)

```json
{
    "apikey": "your_api_key",
    "strategy": "nifty_weekly",
    "underlying": "NIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 50,
    "offset": "ATM",
    "option_type": "CE"
}
```

#### BANKNIFTY (Strike Interval: 100)

```json
{
    "apikey": "your_api_key",
    "strategy": "banknifty_options",
    "underlying": "BANKNIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 100,
    "offset": "OTM2",
    "option_type": "PE"
}
```

#### RELIANCE Equity (Strike Interval: 10)

```json
{
    "apikey": "your_api_key",
    "strategy": "equity_options",
    "underlying": "RELIANCE",
    "exchange": "NSE",
    "expiry_date": "28NOV24",
    "strike_int": 10,
    "offset": "ITM1",
    "option_type": "CE"
}
```

####

### Offset Examples

For underlying LTP = 25966.05, strike\_int = 50, ATM = 26000:

| Offset | Option Type | Strike | Description         |
| ------ | ----------- | ------ | ------------------- |
| ATM    | CE          | 26000  | At-The-Money        |
| ATM    | PE          | 26000  | At-The-Money        |
| ITM1   | CE          | 25950  | In-The-Money -1     |
| ITM2   | CE          | 25900  | In-The-Money -2     |
| ITM1   | PE          | 26050  | In-The-Money +1     |
| ITM2   | PE          | 26100  | In-The-Money +2     |
| OTM1   | CE          | 26050  | Out-of-The-Money +1 |
| OTM2   | CE          | 26100  | Out-of-The-Money +2 |
| OTM1   | PE          | 25950  | Out-of-The-Money -1 |
| OTM2   | PE          | 25900  | Out-of-The-Money -2 |

####

### Error Response

```json
{
    "status": "error",
    "message": "Option symbol NIFTY28OCT2527000CE not found in NFO. Symbol may not exist or master contract needs update."
}
```

####

### Use Cases

1. **Get ATM Option**: Use `"offset": "ATM"` to get the current At-The-Money strike
2. **Get OTM for Premium Collection**: Use `"offset": "OTM2"` or higher for selling OTM options
3. **Get ITM for Directional Trades**: Use `"offset": "ITM1"` or `"ITM2"` for higher delta trades
4. **Build Iron Condor**: Fetch OTM1 and OTM3 strikes for both CE and PE
5. **Verify Symbol Before Order**: Check if option exists in master contract database



### quotes

# Quotes

## Endpoint URL

This API Function fetches Quotes from the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/quotes
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/quotes
Custom Domain:  POST https://<your-custom-domain>/api/v1/quotes
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "symbol": "WIPRO",
    "exchange": "NSE"     
}

```

###

## Sample API Response

```json
{
  "data": {
    "ask": 265.92,
    "bid": 265.84,
    "high": 270,
    "low": 265.32,
    "ltp": 265.93,
    "oi": 106860000,
    "open": 269,
    "prev_close": 268.52,
    "volume": 4214304
  },
  "status": "success"
}
```



## Request Fields



| Parameters | Description    | Mandatory/Optional | Default Value |
| ---------- | -------------- | ------------------ | ------------- |
| apikey     | App API key    | Mandatory          | -             |
| symbol     | Trading symbol | Mandatory          | -             |
| exchange   | Exchange code  | Mandatory          | -             |





## Response Fields



| Field       | Type   | Description                  |
| ----------- | ------ | ---------------------------- |
| bid         | number | Best bid price               |
| ask         | number | Best ask price               |
| open        | number | Opening price                |
| high        | number | High price                   |
| low         | number | Low price                    |
| ltp         | number | Last traded price            |
| oi          | number | Open Interest                |
| prev\_close | number | Previous day's closing price |
| volume      | number | Total traded volume          |



### search

# Search

## Symbol Search API

The Symbol Search API allows you to search for trading symbols across different exchanges. This API is useful for finding specific instruments, including stocks, futures, and options contracts.

### Endpoint

```
Local Host   :  POST http://127.0.0.1:5000/api/v1/search
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/search
Custom Domain:  POST https://<your-custom-domain>/api/v1/search
```

### Request Headers

| Header       | Required | Description      |
| ------------ | -------- | ---------------- |
| Content-Type | Yes      | application/json |

### Request Body

| Parameter | Type   | Required | Description                                               |
| --------- | ------ | -------- | --------------------------------------------------------- |
| apikey    | string | Yes      | Your OpenAlgo API key                                     |
| query     | string | Yes      | Search query (symbol name, partial name, or option chain) |
| exchange  | string | No       | Exchange filter (NSE, BSE, NFO, MCX, etc.)                |

### Response

#### Success Response (200 OK)

```json
{
    "status": "success",
    "message": "Found X matching symbols",
    "data": [
        {
            "symbol": "string",
            "brsymbol": "string",
            "name": "string",
            "exchange": "string",
            "brexchange": "string",
            "token": "string",
            "expiry": "string",
            "strike": number,
            "lotsize": number,
            "instrumenttype": "string",
            "tick_size": number
        }
    ]
}
```

#### Response Fields

| Field          | Type   | Description                           |
| -------------- | ------ | ------------------------------------- |
| status         | string | Status of the request (success/error) |
| message        | string | Descriptive message about the result  |
| data           | array  | Array of matching symbols             |
| symbol         | string | Trading symbol                        |
| brsymbol       | string | Broker-specific symbol format         |
| name           | string | Company/instrument name               |
| exchange       | string | Exchange code                         |
| brexchange     | string | Broker-specific exchange code         |
| token          | string | Unique instrument token               |
| expiry         | string | Expiry date (for derivatives)         |
| strike         | number | Strike price (for options)            |
| lotsize        | number | Lot size for the instrument           |
| instrumenttype | string | Type of instrument (EQ, OPTIDX, etc.) |
| tick\_size     | number | Minimum price movement                |

#### Error Response

```json
{
    "status": "error",
    "message": "Error description"
}
```

### Error Codes

| Code | Description                      |
| ---- | -------------------------------- |
| 400  | Bad Request - Invalid parameters |
| 403  | Forbidden - Invalid API key      |
| 500  | Internal Server Error            |

### Examples

#### Example 1: Search for Options Contracts

**Request:**

```bash
curl -X POST http://127.0.0.1:5000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key_here",
    "query": "NIFTY 25000 JUL CE",
    "exchange": "NFO"
  }'
```

**Response:**

```json
{
  "data": [
    {
      "brexchange": "NFO",
      "brsymbol": "NIFTY17JUL2525000CE",
      "exchange": "NFO",
      "expiry": "17-JUL-25",
      "instrumenttype": "OPTIDX",
      "lotsize": 75,
      "name": "NIFTY",
      "strike": 25000,
      "symbol": "NIFTY17JUL2525000CE",
      "tick_size": 0.05,
      "token": "47275"
    },
    {
      "brexchange": "NFO",
      "brsymbol": "FINNIFTY31JUL2525000CE",
      "exchange": "NFO",
      "expiry": "31-JUL-25",
      "instrumenttype": "OPTIDX",
      "lotsize": 65,
      "name": "FINNIFTY",
      "strike": 25000,
      "symbol": "FINNIFTY31JUL2525000CE",
      "tick_size": 0.05,
      "token": "54763"
    },
    {
      "brexchange": "NFO",
      "brsymbol": "NIFTY31JUL2525000CE",
      "exchange": "NFO",
      "expiry": "31-JUL-25",
      "instrumenttype": "OPTIDX",
      "lotsize": 75,
      "name": "NIFTY",
      "strike": 25000,
      "symbol": "NIFTY31JUL2525000CE",
      "tick_size": 0.05,
      "token": "55799"
    },
    {
      "brexchange": "NFO",
      "brsymbol": "NIFTY03JUL2525000CE",
      "exchange": "NFO",
      "expiry": "03-JUL-25",
      "instrumenttype": "OPTIDX",
      "lotsize": 75,
      "name": "NIFTY",
      "strike": 25000,
      "symbol": "NIFTY03JUL2525000CE",
      "tick_size": 0.05,
      "token": "56699"
    },
    {
      "brexchange": "NFO",
      "brsymbol": "NIFTY10JUL2525000CE",
      "exchange": "NFO",
      "expiry": "10-JUL-25",
      "instrumenttype": "OPTIDX",
      "lotsize": 75,
      "name": "NIFTY",
      "strike": 25000,
      "symbol": "NIFTY10JUL2525000CE",
      "tick_size": 0.05,
      "token": "40015"
    },
    {
      "brexchange": "NFO",
      "brsymbol": "NIFTY24JUL2525000CE",
      "exchange": "NFO",
      "expiry": "24-JUL-25",
      "instrumenttype": "OPTIDX",
      "lotsize": 75,
      "name": "NIFTY",
      "strike": 25000,
      "symbol": "NIFTY24JUL2525000CE",
      "tick_size": 0.05,
      "token": "49487"
    }
  ],
  "message": "Found 6 matching symbols",
  "status": "success"
}
```

#### Example 2: Search for Equity Symbols

**Request:**

```bash
curl -X POST http://127.0.0.1:5000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key_here",
    "query": "TATA",
    "exchange": "NSE"
  }'
```

**Response:**

```json
{
  "data": [
    {
      "brexchange": "NSE",
      "brsymbol": "TATAINVEST-EQ",
      "exchange": "NSE",
      "expiry": "",
      "instrumenttype": "",
      "lotsize": 1,
      "name": "TATAINVEST",
      "strike": -0.01,
      "symbol": "TATAINVEST",
      "tick_size": 0.5,
      "token": "1621"
    },
    {
      "brexchange": "NSE",
      "brsymbol": "TATAELXSI-EQ",
      "exchange": "NSE",
      "expiry": "",
      "instrumenttype": "",
      "lotsize": 1,
      "name": "TATAELXSI",
      "strike": -0.01,
      "symbol": "TATAELXSI",
      "tick_size": 0.5,
      "token": "3411"
    },
    {
      "brexchange": "NSE",
      "brsymbol": "TATATECH-EQ",
      "exchange": "NSE",
      "expiry": "",
      "instrumenttype": "",
      "lotsize": 1,
      "name": "TATATECH",
      "strike": -0.01,
      "symbol": "TATATECH",
      "tick_size": 0.05,
      "token": "20293"
    },
    {
      "brexchange": "NSE",
      "brsymbol": "TATASTEEL-EQ",
      "exchange": "NSE",
      "expiry": "",
      "instrumenttype": "",
      "lotsize": 1,
      "name": "TATASTEEL",
      "strike": -0.01,
      "symbol": "TATASTEEL",
      "tick_size": 0.01,
      "token": "3499"
    },
    {
      "brexchange": "NSE",
      "brsymbol": "TATAMOTORS-EQ",
      "exchange": "NSE",
      "expiry": "",
      "instrumenttype": "",
      "lotsize": 1,
      "name": "TATAMOTORS",
      "strike": -0.01,
      "symbol": "TATAMOTORS",
      "tick_size": 0.05,
      "token": "3456"
    }
  ],
  "message": "Found 10 matching symbols",
  "status": "success"
}
```

#### Example 3: Search Without Exchange Filter

**Request:**

```bash
curl -X POST http://127.0.0.1:5000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key_here",
    "query": "RELIANCE"
  }'
```

This will return all symbols matching "RELIANCE" across all exchanges.

### Notes

1. The search is case-insensitive
2. Partial matches are supported
3. For options, you can search using various formats:
   * Symbol with strike and type: "NIFTY 25000 CE"
   * Symbol with expiry: "NIFTY JUL"
   * Complete option chain: "NIFTY 25000 JUL CE"
4. The exchange parameter is optional but recommended for faster and more accurate results
5. Empty or missing query parameter will return an error
6. The API uses the same search logic as the web interface at `/search/token`

###

### Common Use Cases

1. **Finding Option Contracts**: Search for specific strike prices and expiries
2. **Symbol Lookup**: Find the exact trading symbol for a company
3. **Token Retrieval**: Get the instrument token required for other API calls
4. **Lot Size Information**: Retrieve lot sizes for F\&O instruments
5. **Exchange Validation**: Verify if a symbol is available on a specific exchange



### symbol

# Symbol

## Endpoint URL

This API Function fetches Quotes from the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/symbol
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/symbol
Custom Domain:  POST https://<your-custom-domain>/api/v1/symbol
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "symbol":"SBIN", 
    "exchange":"NSE"     
}

```

###

## Sample API Response

```json
{
  "data": {
    "brexchange": "NSE",
    "brsymbol": "ZOMATO-EQ",
    "exchange": "NSE",
    "expiry": "",
    "id": 7162,
    "instrumenttype": "",
    "lotsize": 1,
    "name": "ZOMATO",
    "strike": -0.01,
    "symbol": "ZOMATO",
    "tick_size": 0.01,
    "token": "5097"
  },
  "status": "success"
}
```



## Request Fields



| Parameters | Description    | Mandatory/Optional | Default Value |
| ---------- | -------------- | ------------------ | ------------- |
| apikey     | App API key    | Mandatory          | -             |
| symbol     | Trading symbol | Mandatory          | -             |
| exchange   | Exchange code  | Mandatory          | -             |





## Response Fields

| Field          | Type    | Description                                |
| -------------- | ------- | ------------------------------------------ |
| brexchange     | String  | Broker exchange name                       |
| brsymbol       | String  | Broker-specific symbol                     |
| exchange       | String  | Exchange name (e.g., NSE, BSE)             |
| expiry         | String  | Expiry date (empty for equity instruments) |
| id             | Integer | Unique instrument identifier               |
| instrumenttype | String  | Type of instrument (e.g., EQ, FUT, OPT)    |
| lotsize        | Integer | Lot size (number of units per lot)         |
| name           | String  | Name of the instrument/company             |
| strike         | Float   | Strike price (used in options, -0.01 here) |
| symbol         | String  | Trading symbol                             |
| tick\_size     | Float   | Minimum price movement                     |
| token          | String  | Token ID                                   |



### ticker

# Ticker

## Endpoint URL

The  Ticker  API provides historical price data for stocks in customizable time windows. It allows you to fetch OHLCV (Open, High, Low, Close, Volume) data for any stock with flexible interval options.

```http
Local Host   :  GET http://127.0.0.1:5000/api/v1/ticker/{exchange}:{symbol}
Ngrok Domain :  GET https://<your-ngrok-domain>.ngrok-free.app/api/v1/ticker/{exchange}:{symbol}
Custom Domain:  GET https://<your-custom-domain>/api/v1/ticker/{exchange}:{symbol}
```

### Parameters

#### Path Parameters

* `exchange:symbol` (required): Combined exchange and symbol (e.g., NSE:RELIANCE). Defaults to NSE:RELIANCE if not provided.

#### Query Parameters

* `interval` (optional): The time interval for the data. Default: D Supported intervals:
  * Seconds: 5s, 10s, 15s, 30s, 45s
  * Minutes: 1m, 2m, 3m, 5m, 10m, 15m, 20m, 30m
  * Hours: 1h, 2h, 4h
  * Days: D
  * Weeks: W
  * Months: M
* `from` (required): The start date in YYYY-MM-DD format or millisecond timestamp
* `to` (required): The end date in YYYY-MM-DD format or millisecond timestamp
* `adjusted` (optional): Whether to adjust for splits. Default: true
  * true: Results are adjusted for splits
  * false: Results are NOT adjusted for splits
* `sort` (optional): Sort results by timestamp. Default: asc
  * asc: Results sorted in ascending order (oldest first)
  * desc: Results sorted in descending order (newest first)

#### Authentication

API key must be provided either:

* In the request header as `X-API-KEY`
* As a query parameter `apikey`

**Note**: The API key must be obtained from your OpenAlgo instance dashboard under the API Key section.

#### AmiBroker Integration

For AmiBroker users, use this exact URL template format to fetch historical quotes:

```
http://127.0.0.1:5000/api/v1/ticker/{symbol}?apikey={api_key}&interval={interval_extra}&from={from_ymd}&to={to_ymd}&format=txt
```

Example:

```
http://127.0.0.1:5000/api/v1/ticker/NSE:ICICIBANK?apikey=your_api_key_here&interval=1m&from=2025-06-04&to=2025-07-04&format=txt
```

### Example Request

```
GET http://127.0.0.1:5000/api/v1/ticker/NSE:RELIANCE?apikey=your_api_key_here&interval=D&from=2023-01-09&to=2023-02-10&adjusted=true&sort=asc
```

### Response Format

```json
{
    "status": "success",
    "data": [
        {
            "timestamp": "2023-01-09, 05:00:00",
            "open": 60.25,
            "high": 61.40,
            "low": 59.80,
            "close": 60.95,
            "volume": 12345678
        },
        // ... more data points
    ]
}
```

### Error Responses

* 400: Bad Request - Invalid parameters
* 403: Forbidden - Invalid API key
* 404: Not Found - Broker module not found
* 500: Internal Server Error - Unexpected error

### Example Usage

For example, to get 5-minute bars for RELIANCE stock from NSE:

```
GET http://127.0.0.1:5000/api/v1/ticker/NSE:RELIANCE?apikey=your_api_key_here&interval=5m&from=2023-01-09&to=2023-02-10
```

This will return 5-minute OHLCV bars for RELIANCE between January 9, 2023, and February 10, 2023.

### Ticker API Documentation

The Ticker API provides historical stock data in both daily and intraday formats. The API supports both JSON and plain text responses.

### Endpoint

```
GET /api/v1/ticker/{exchange}:{symbol}
```

### Parameters

| Parameter | Type   | Required | Description                                     | Example        |
| --------- | ------ | -------- | ----------------------------------------------- | -------------- |
| symbol    | string | Yes      | Stock symbol with exchange (e.g., NSE:RELIANCE) | NSE:RELIANCE   |
| interval  | string | No       | Time interval (D, 1m, 5m, 1h, etc.). Default: D | 5m             |
| from      | string | No       | Start date in YYYY-MM-DD format                 | 2024-12-01     |
| to        | string | No       | End date in YYYY-MM-DD format                   | 2024-12-31     |
| apikey    | string | Yes      | API Key for authentication                      | your\_api\_key |
| format    | string | No       | Response format (json/txt). Default: json       | txt            |

### Response Formats

#### Plain Text Format (format=txt)

**Daily Data (interval=D)**

Format: `Ticker,Date_YMD,Open,High,Low,Close,Volume`

Example:

```
NSE:RELIANCE,2024-12-02,2815.9,2857.7,2804.45,2825.5,3517068
NSE:RELIANCE,2024-12-03,2797.7,2823.35,2790.0,2798.5,3007864
```

**Intraday Data (interval=1m, 5m, etc.)**

Format: `Ticker,Date_YMD,Time,Open,High,Low,Close,Volume`

Example:

```
NSE:ICICIBANK,2025-06-04,09:15:00,1437.4,1440.1,1433.0,1433.6,345598
NSE:ICICIBANK,2025-06-04,09:16:00,1434.0,1436.3,1432.5,1434.2,83225
NSE:ICICIBANK,2025-06-04,09:17:00,1434.4,1434.8,1432.9,1433.8,26743
NSE:ICICIBANK,2025-06-04,09:18:00,1433.8,1434.8,1433.2,1433.4,22281
NSE:ICICIBANK,2025-06-04,09:19:00,1433.3,1433.3,1430.3,1431.0,35529
NSE:ICICIBANK,2025-06-04,09:20:00,1430.6,1431.9,1430.1,1431.0,31222
NSE:ICICIBANK,2025-06-04,09:21:00,1431.0,1432.0,1430.9,1431.8,25495
NSE:ICICIBANK,2025-06-04,09:22:00,1431.8,1432.3,1431.4,1432.3,9631
NSE:ICICIBANK,2025-06-04,09:23:00,1432.3,1432.3,1431.4,1431.8,15877
NSE:ICICIBANK,2025-06-04,09:24:00,1431.5,1431.7,1430.6,1431.2,12727
NSE:ICICIBANK,2025-06-04,09:25:00,1431.2,1431.5,1431.0,1431.3,20720
NSE:ICICIBANK,2025-06-04,09:26:00,1431.5,1432.2,1431.3,1432.2,10217
```

#### JSON Format (format=json)

```json
{
    "status": "success",
    "data": [
        {
            "timestamp": 1701432600,
            "open": 2815.9,
            "high": 2857.7,
            "low": 2804.45,
            "close": 2825.5,
            "volume": 3517068
        },
        ...
    ]
}
```

### Error Responses

#### Plain Text Format

Error messages are returned as plain text with appropriate HTTP status codes.

Example:

```
Invalid openalgo apikey
```

#### JSON Format

```json
{
    "status": "error",
    "message": "Invalid openalgo apikey"
}
```

### HTTP Status Codes

| Code | Description                      |
| ---- | -------------------------------- |
| 200  | Successful request               |
| 400  | Bad request (invalid parameters) |
| 403  | Invalid API key                  |
| 404  | Broker module not found          |
| 500  | Internal server error            |

### Rate Limiting

The API is rate-limited to 10 requests per second by default. This can be configured using the `API_RATE_LIMIT` environment variable.

### Date Range Restrictions

To prevent large queries that could hit broker rate limits, the API automatically restricts date ranges:

* **Daily/Weekly/Monthly intervals (D, W, M)**: Maximum 10 years from end date
* **Intraday intervals (1m, 5m, 1h, etc.)**: Maximum 30 days from end date

If a request exceeds these limits, the start date will be automatically adjusted. For example:

* Original request: `http://127.0.0.1:5000/api/v1/ticker/NSE:ICICIBANK?apikey=your_api_key_here&interval=1m&from=2000-06-01&to=2025-07-04&format=txt`
* Adjusted to: `from=2025-06-04&to=2025-07-04&interval=1m` (30 days for 1-minute data)

### Notes

1. All timestamps in the responses are in Indian Standard Time (IST)
2. Volume is always returned as an integer
3. If no symbol is provided, defaults to "NSE:RELIANCE"
4. If no exchange is specified in the symbol, defaults to "NSE"
5. The API supports both formats:
   * `NSE:RELIANCE` (preferred)
   * `RELIANCE` (defaults to NSE)



### README

# Alert API




### telegram

# Telegram

### Endpoint URL

This API Function Sends Custom Alert Messages to Telegram Users

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/telegram/notify
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/telegram/notify
Custom Domain:  POST https://<your-custom-domain>/api/v1/telegram/notify
```

### Prerequisites

1. **Telegram Bot Must Be Running**
   * Start the bot from OpenAlgo Telegram settings
   * Bot must be active to send alerts
2. **User Must Be Linked**
   * User must have linked their account using `/link` command in Telegram
   * Username in API request must match your OpenAlgo login username (the username you use to login to OpenAlgo app)
   * This is NOT your Telegram username
3. **Valid API Key**
   * API key must be active and valid
   * Get API key from OpenAlgo settings

### Sample API Request (Basic Notification)

```json
{
    "apikey": "your_api_key",
    "username": "john_trader",
    "message": "NIFTY crossed 24000! Consider taking profit on long positions."
}
```

**Note**: `username` should be your OpenAlgo login username (e.g., "john\_trader"), not your Telegram username (e.g., @johntrader).

####

### Sample API Response (Success)

```json
{
    "status": "success",
    "message": "Notification sent successfully"
}
```

####

### Sample API Request (With Priority)

```json
{
    "apikey": "your_api_key",
    "username": "john_trader",
    "message": "¨ URGENT: Stop loss hit on BANKNIFTY position!",
    "priority": 10
}
```

####

### Sample API Request (Multi-line Alert)

```json
{
    "apikey": "your_api_key",
    "username": "john_trader",
    "message": " Daily Trading Summary\nâââââââââââââââââââââ\nâ Winning Trades: 8\nâ Losing Trades: 2\n° Net P&L: +â¹15,450\n Win Rate: 80%\n\n¯ Great day! Keep it up!",
    "priority": 5
}
```

####

### Parameter Description

| Parameters | Description                                                                                 | Mandatory/Optional | Default Value |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------ | ------------- |
| apikey     | App API key                                                                                 | Mandatory          | -             |
| username   | OpenAlgo login username (the username used to login to OpenAlgo app, NOT Telegram username) | Mandatory          | -             |
| message    | Alert message to send                                                                       | Mandatory          | -             |
| priority   | Message priority (1-10, higher = more urgent)                                               | Optional           | 5             |

####

### Response Parameters

| Parameter | Description                         | Type   |
| --------- | ----------------------------------- | ------ |
| status    | API response status (success/error) | string |
| message   | Response message                    | string |

####

### Use Cases

#### 1. Price Alert Notifications

```json
{
    "apikey": "your_api_key",
    "username": "trader_123",
    "message": " Price Alert: RELIANCE reached target price â¹2,850",
    "priority": 8
}
```

#### 2. Strategy Signal Alerts

```json
{
    "apikey": "your_api_key",
    "username": "algo_trader",
    "message": " BUY Signal: RSI oversold on NIFTY 24000 CE\nEntry: â¹145.50\nTarget: â¹165.00\nSL: â¹138.00",
    "priority": 9
}
```

#### 3. Risk Management Alerts

```json
{
    "apikey": "your_api_key",
    "username": "trader_123",
    "message": "â ï¸ Risk Alert: Daily loss limit reached (-â¹25,000)\nNo new positions recommended.",
    "priority": 10
}
```

#### 4. Market Update Notifications

```json
{
    "apikey": "your_api_key",
    "username": "trader_123",
    "message": "° Market Update: FII bought â¹2,500 crores today\nMarket sentiment: Bullish\nNIFTY support: 23,800",
    "priority": 5
}
```

#### 5. Trade Execution Confirmation

```json
{
    "apikey": "your_api_key",
    "username": "trader_123",
    "message": "â Order Executed\nSymbol: BANKNIFTY 48000 CE\nAction: BUY\nQty: 30\nPrice: â¹245.75\nTotal: â¹7,372.50",
    "priority": 7
}
```

#### 6. Technical Indicator Alerts

```json
{
    "apikey": "your_api_key",
    "username": "technical_trader",
    "message": " Technical Alert: NIFTY\nâ¢ RSI: 72 (Overbought)\nâ¢ MACD: Bearish Crossover\nâ¢ Support: 23,850\nâ¢ Resistance: 24,150\n\nConsider booking profits.",
    "priority": 8
}
```

####

### Priority Levels

| Priority | Description     | Use Case                       |
| -------- | --------------- | ------------------------------ |
| 1-3      | Low Priority    | General updates, market news   |
| 4-6      | Normal Priority | Trade signals, daily summaries |
| 7-8      | High Priority   | Price alerts, position updates |
| 9-10     | Urgent          | Stop loss hits, risk alerts    |

**Note**: Priority affects message delivery order but all messages are delivered.

####

### Error Responses

#### Invalid API Key

```json
{
    "status": "error",
    "message": "Invalid or missing API key"
}
```

#### User Not Found

```json
{
    "status": "error",
    "message": "User not found or not linked to Telegram"
}
```

**Common Cause**: Using Telegram username instead of OpenAlgo login username. Use the username you login to OpenAlgo with, not your @telegram\_handle.

#### Missing Parameters

```json
{
    "status": "error",
    "message": "Username and message are required"
}
```

#### Bot Not Running

```json
{
    "status": "error",
    "message": "Failed to send notification"
}
```

####

### Common Error Messages

| Error Message                            | Cause                                              | Solution                                                                              |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Invalid or missing API key               | API key is incorrect or expired                    | Check API key in settings                                                             |
| User not found or not linked to Telegram | User hasn't linked account OR using wrong username | Use OpenAlgo login username (not Telegram username). Link account via `/link` command |
| Username and message are required        | Missing required fields                            | Provide username and message                                                          |
| Failed to send notification              | Bot is not running                                 | Start bot from Telegram settings                                                      |

####

### Message Formatting

#### Supported Markdown

* **Bold**: `*text*` or `**text**`
* **Italic**: `_text_` or `__text__`
* **Code**: `` `text` ``
* **Pre-formatted**: ` ```text``` `
* **Links**: `[text](url)`

#### Emojis

Use standard Unicode emojis in messages:

*   Charts
* ° µ Money
* â â Status
* ¨ â ï¸ Alerts
*   Analytics
* ¯  Notifications

#### Line Breaks

Use `\n` for line breaks in JSON strings.

####

### Rate Limiting

* **Limit**: 30 requests per minute per user
* **Scope**: Per API endpoint
* **Response**: 429 status code if limit exceeded

####

### Best Practices

1. **Use Correct Username**: Always use your OpenAlgo login username (the one you use to login to OpenAlgo app), NOT your Telegram username (@handle)
2. **Keep Messages Concise**: Short, actionable messages work best
3. **Use Emojis Wisely**: Emojis improve readability but don't overuse
4. **Set Appropriate Priority**: Reserve high priority (9-10) for urgent alerts only
5. **Format for Readability**: Use line breaks and sections for multi-line messages
6. **Test First**: Send test messages before automating
7. **Handle Errors**: Implement error handling for failed notifications
8. **Username Match**: Ensure username matches exactly (case-sensitive)
9. **Bot Status**: Check bot is running before bulk notifications

####

### Integration Examples

#### Python Example

```python
import requests
import json

def send_telegram_alert(username, message, priority=5):
    url = "http://127.0.0.1:5000/api/v1/telegram/notify"

    payload = {
        "apikey": "your_api_key_here",
        "username": username,
        "message": message,
        "priority": priority
    }

    response = requests.post(url, json=payload)
    return response.json()

# Usage
result = send_telegram_alert(
    username="trader_123",
    message="¯ Target reached on NIFTY 24000 CE",
    priority=8
)

print(result)
```

#### JavaScript Example

```javascript
async function sendTelegramAlert(username, message, priority = 5) {
    const url = 'http://127.0.0.1:5000/api/v1/telegram/notify';

    const payload = {
        apikey: 'your_api_key_here',
        username: username,
        message: message,
        priority: priority
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    return await response.json();
}

// Usage
sendTelegramAlert(
    'trader_123',
    ' Buy signal detected on BANKNIFTY',
    8
).then(result => console.log(result));
```

#### cURL Example

```bash
curl -X POST http://127.0.0.1:5000/api/v1/telegram/notify \
  -H "Content-Type: application/json" \
  -d '{
    "apikey": "your_api_key_here",
    "username": "trader_123",
    "message": "Test alert from API",
    "priority": 5
  }'
```

####

### Workflow Integration

#### With Trading Strategies

```python
# After order execution
if order_status == "success":
    send_telegram_alert(
        username="trader_123",
        message=f"â Order executed: {symbol} {action} {quantity}",
        priority=7
    )
```

#### With Price Monitoring

```python
# Price alert system
if current_price >= target_price:
    send_telegram_alert(
        username="trader_123",
        message=f"¯ {symbol} reached target price: â¹{current_price}",
        priority=9
    )
```

#### With Risk Management

```python
# Daily loss limit
if daily_loss >= max_loss_limit:
    send_telegram_alert(
        username="trader_123",
        message=f"¨ Daily loss limit reached: -â¹{daily_loss}\nTrading halted.",
        priority=10
    )
```

####

### Features

1. **Custom Messages**: Send any text-based alert
2. **Priority System**: Control message importance (1-10)
3. **Rich Formatting**: Support for emojis, markdown, line breaks
4. **User-Specific**: Target specific users by username
5. **High Reliability**: Messages queued if delivery fails
6. **Rate Limited**: Prevents spam and abuse
7. **Secure**: API key authentication required

####

### Troubleshooting

#### Alert Not Received

1. **Check Bot Status**: Ensure bot is running in OpenAlgo settings
2. **Verify Username**: Confirm username matches linked account (case-sensitive)
3. **Check Linking**: User must have linked account via `/link` command
4. **Review Logs**: Check OpenAlgo logs for error messages
5. **Test Connection**: Use `/status` command in Telegram bot

#### Delivery Delays

1. **Rate Limiting**: Check if rate limit exceeded (30/min)
2. **Bot Load**: High message volume may cause slight delays
3. **Network Issues**: Check internet connectivity
4. **Telegram API**: Telegram may have temporary issues

#### Formatting Issues

1. **Escape Characters**: Use proper JSON escaping for special characters
2. **Line Breaks**: Use `\n` not actual line breaks in JSON
3. **Markdown**: Check markdown syntax is correct
4. **Message Length**: Keep messages under 4096 characters (Telegram limit)

####

### Security Considerations

1. **API Key Protection**: Never expose API keys in client-side code
2. **Username Privacy**: Usernames are case-sensitive and private
3. **Message Content**: Don't send sensitive data in plain text
4. **Rate Limiting**: Prevents abuse and spam
5. **Authentication**: Every request must include valid API key

####

### Limitations

* Maximum message length: 4096 characters (Telegram limit)
* Rate limit: 30 messages per minute per user
* Bot must be running to send messages
* User must be linked to receive messages
* Messages are queued but not guaranteed during bot downtime

####

### Support

For issues or questions:

* Check bot status in OpenAlgo Telegram settings
* Verify user is linked via `/status` command in Telegram
* Review API response for specific error messages
* Check OpenAlgo logs for detailed error information



### http-status-codes

# HTTP Status Codes

The status codes contain the following

| Status Code | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| 200         | Request was successful                                                     |
| 400         | Bad request. The request is invalid or certain other errors                |
| 401         | Authorization error. User could not be authenticated                       |
| 403         | Permission error. User does not have the necessary permissions             |
| 429         | Rate limit exceeded. Users have been blocked for exceeding the rate limit. |
| 500         | Internal server error.                                                     |



### order-constants

# Order Constants

## Order Constants



### Exchange

* NSE: NSE Equity
* NFO: NSE Futures & Options
* CDS: NSE Currency
* BSE: BSE Equity
* BFO: BSE Futures & Options
* BCD: BSE Currency
* MCX: MCX Commodity
* NCDEX: NCDEX Commodity

### Product Type

* CNC: Cash & Carry for equity
* NRML: Normal for futures and options
* MIS: Intraday Square off

### Price Type

* MARKET: Market Order
* LIMIT: Limit Order
* SL: Stop Loss Limit Order
* SL-M: Stop Loss Market Order

### Action

* BUY: Buy
* SELL: Sell




### README

# Orders API

The Orders API provides a comprehensive list of operations to manage and handle orders efficiently.&#x20;



### basketorder

# BasketOrder

## Endpoint URL

This API Function Place Basket Orders to the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/basketorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/basketorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/basketorder
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "your-strategy",
    "orders": [
        {
            "symbol": "RELIANCE",
            "exchange": "NSE",
            "action": "BUY",
            "quantity": "1",
            "pricetype": "MARKET",
            "product": "MIS"
        },
        {
            "symbol": "INFY",
            "exchange": "NSE",
            "action": "SELL",
            "quantity": "1",
            "pricetype": "MARKET",
            "product": "MIS"
        }
    ]
}

```

###

## Sample API Response

```json
{
  "results": [
    {
      "orderid": "24120900343250",
      "status": "success",
      "symbol": "INFY"
    },
    {
      "orderid": "24120900343249",
      "status": "success",
      "symbol": "RELIANCE"
    }
  ],
  "status": "success"
}
```

###

## Parameter Description



| Parameters          | Description        | Mandatory/Optional | Default Value |
| ------------------- | ------------------ | ------------------ | ------------- |
| apikey              | App API key        | Mandatory          | -             |
| strategy            | Strategy name      | Mandatory          | -             |
| exchange            | Exchange code      | Mandatory          | -             |
| symbol              | Trading symbol     | Mandatory          | -             |
| action              | Action (BUY/SELL)  | Mandatory          | -             |
| product             | Product type       | Optional           | MIS           |
| pricetype           | Price type         | Optional           | MARKET        |
| quantity            | Quantity           | Mandatory          | -             |
| price               | Price              | Optional           | 0             |
| trigger\_price      | Trigger price      | Optional           | 0             |
| disclosed\_quantity | Disclosed quantity | Optional           | 0             |



### cancelallorder

# CancelAllOrder

## Endpoint URL

```
Local Host   :  POST http://127.0.0.1:5000/api/v1/cancelallorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/cancelallorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/cancelallorder
```



## Sample API Request

```json
{
"apikey":"<your_app_apikey>",
"strategy":"Test Strategy"
}
```



## Sample API Response

```json
{
  "canceled_orders": [
    "24120600373935",
    "24120600373918",
    "24120600373901",
    "24120600373890"
  ],
  "failed_cancellations": [],
  "message": "Canceled 4 orders. Failed to cancel 0 orders.",
  "status": "success"
}
```

###

## Parameters Description

| Parameters | Description   | Mandatory/Optional | Default Value |
| ---------- | ------------- | ------------------ | ------------- |
| apikey     | App API key   | Mandatory          | -             |
| strategy   | Strategy name | Mandatory          | -             |



### cancelorder

# CancelOrder

## Endpoint URL

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/cancelorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/cancelorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/cancelorder
```



## Sample API Request

```json

{
    "apikey": "<your_app_apikey>",
    "strategy": "Test Strategy",
    "orderid": "1000000123665912"
}
```



## Sample API Response

```json

{
        "orderid": "1000000123665912",
        "status": "success"
}

```

###

## Parameters Description

| Parameters | Description   | Mandatory/Optional | Default Value |
| ---------- | ------------- | ------------------ | ------------- |
| apikey     | App API key   | Mandatory          | -             |
| strategy   | Strategy name | Mandatory          | -             |
| orderid    | Order Id      | Mandatory          | -             |



### closeposition

# ClosePosition

## Endpoint URL

```
Local Host   :  POST http://127.0.0.1:5000/api/v1/closeposition
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/closeposition
Custom Domain:  POST https://<your-custom-domain>/api/v1/closeposition
```



## Sample API Request

```json
{
"apikey":"<your_app_apikey>",
"strategy":"Test Strategy"
}
```



## Sample API Response

```json
{
        "message": "All Open Positions SquaredOff",
        "status": "success"
}
```

###

## Parameters Description

| Parameters | Description   | Mandatory/Optional | Default Value |
| ---------- | ------------- | ------------------ | ------------- |
| apikey     | App API key   | Mandatory          | -             |
| strategy   | Strategy name | Mandatory          | -             |



### modifyorder

# ModifyOrder

## Endpoint URL

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/modifyorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/modifyorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/modifyorder
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey",
    "strategy": "Test Message",
    "symbol": "USDINR15MAR2483CE",
    "action": "BUY",
    "exchange": "CDS",
    "orderid":"240307000562466",
    "product":"NRML",
    "pricetype":"LIMIT",
    "price":"0.0050",
    "quantity":"1",
    "disclosed_quantity":"0",
    "trigger_price":"0"
}

```



## Sample API Response

```json
{
        "orderid": "240307000562466",
        "status": "success"
}

```



## Parameter Description



| Parameters          | Description        | Mandatory/Optional | Default Value |
| ------------------- | ------------------ | ------------------ | ------------- |
| apikey              | App API key        | Mandatory          | -             |
| strategy            | Strategy name      | Mandatory          | -             |
| symbol              | Trading Symbol     | Mandatory          | -             |
| action              | Action (BUY/SELL)  | Mandatory          | -             |
| exchange            | Exchange           | Mandatory          | -             |
| orderid             | Order ID           | Mandatory          | -             |
| product             | Product type       | Mandatory          | -             |
| pricetype           | Price type         | Mandatory          | -             |
| quantity            | Quantity           | Mandatory          | -             |
| price               | Price              | Mandatory          | 0             |
| trigger\_price      | Trigger price      | Mandatory          | 0             |
| disclosed\_quantity | Disclosed quantity | Mandatory          | 0             |



### openposition

# OpenPosition

## Endpoint URL

```
Local Host   :  POST http://127.0.0.1:5000/api/v1/openposition
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/openposition
Custom Domain:  POST https://<your-custom-domain>/api/v1/openposition
```



## Sample API Request

<pre class="language-json"><code class="lang-json">{
<strong>    "apikey":"&#x3C;your_app_apikey>",
</strong>    "strategy": "Test Strategy",
    "symbol": "YESBANK",
    "exchange": "NSE",
    "product": "CNC"
}
</code></pre>



## Sample API Response

```json
{
  "quantity": 10,
  "status": "success"
}
```

###

## Parameters Description

| Parameters | Description    | Mandatory/Optional | Default Value |
| ---------- | -------------- | ------------------ | ------------- |
| apikey     | App API key    | Mandatory          | -             |
| strategy   | Strategy name  | Mandatory          | -             |
| Symbol     | Trading Symbol | Mandatory          | -             |
| Exchange   | Exchange       | Mandatory          | -             |
| Product    | Product        | Mandatory          | -             |



### optionsorder

# OptionsOrder

## Options Order

### Endpoint URL

This API Function Places Option Orders by Auto-Resolving Symbol based on Underlying and Offset

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/optionsorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/optionsorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/optionsorder
```

### Sample API Request (Future as Underlying)

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "test_strategy",
    "underlying": "NIFTY28OCT25FUT",
    "exchange": "NFO",
    "strike_int": 50,
    "offset": "ITM2",
    "option_type": "CE",
    "action": "BUY",
    "quantity": 75,
    "pricetype": "MARKET",
    "product": "NRML"
}
```

####

### Sample API Response (Analyze Mode)

```json
{
    "status": "success",
    "orderid": "25102700000020",
    "symbol": "NIFTY28OCT2525850CE",
    "exchange": "NFO",
    "underlying": "NIFTY28OCT25FUT",
    "underlying_ltp": 25966.05,
    "offset": "ITM2",
    "option_type": "CE",
    "mode": "analyze"
}
```

####

### Sample API Request (Index Underlying with MARKET Order)

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "nifty_weekly",
    "underlying": "NIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 50,
    "offset": "ATM",
    "option_type": "CE",
    "action": "BUY",
    "quantity": 75,
    "pricetype": "MARKET",
    "product": "MIS",
    "price": "0",
    "trigger_price": "0",
    "disclosed_quantity": "0"
}
```

####

### Sample API Response (Live Mode)

```json
{
    "status": "success",
    "orderid": "240123000001234",
    "symbol": "NIFTY28NOV2424000CE",
    "exchange": "NFO",
    "underlying": "NIFTY",
    "underlying_ltp": 23987.50,
    "offset": "ATM",
    "option_type": "CE"
}
```

####

### Sample API Request (LIMIT Order)

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "nifty_scalping",
    "underlying": "NIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 50,
    "offset": "OTM1",
    "option_type": "CE",
    "action": "BUY",
    "quantity": 75,
    "pricetype": "LIMIT",
    "product": "MIS",
    "price": "50.0",
    "trigger_price": "0",
    "disclosed_quantity": "0"
}
```

####

### Sample API Request (Stop Loss Order)

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "protective_stop",
    "underlying": "BANKNIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 100,
    "offset": "ATM",
    "option_type": "PE",
    "action": "SELL",
    "quantity": 30,
    "pricetype": "SL",
    "product": "MIS",
    "price": "100.0",
    "trigger_price": "105.0",
    "disclosed_quantity": "0"
}
```

####

### Parameter Description

| Parameters          | Description                                                | Mandatory/Optional | Default Value |
| ------------------- | ---------------------------------------------------------- | ------------------ | ------------- |
| apikey              | App API key                                                | Mandatory          | -             |
| strategy            | Strategy name                                              | Mandatory          | -             |
| underlying          | Underlying symbol (NIFTY, BANKNIFTY, NIFTY28OCT25FUT)      | Mandatory          | -             |
| exchange            | Exchange code (NSE\_INDEX, NSE, NFO, BSE\_INDEX, BSE, BFO) | Mandatory          | -             |
| expiry\_date        | Expiry date in DDMMMYY format (e.g., 28OCT25)              | Optional\*         | -             |
| strike\_int         | Strike interval (50 for NIFTY, 100 for BANKNIFTY)          | Mandatory          | -             |
| offset              | Strike offset (ATM, ITM1-ITM50, OTM1-OTM50)                | Mandatory          | -             |
| option\_type        | Option type (CE for Call, PE for Put)                      | Mandatory          | -             |
| action              | Action (BUY/SELL)                                          | Mandatory          | -             |
| quantity            | Quantity (must be multiple of lot size)                    | Mandatory          | -             |
| pricetype           | Price type (MARKET/LIMIT/SL/SL-M)                          | Optional           | MARKET        |
| product             | Product type (MIS/NRML)\*\*                                | Optional           | MIS           |
| price               | Limit price                                                | Optional           | 0             |
| trigger\_price      | Trigger price for SL orders                                | Optional           | 0             |
| disclosed\_quantity | Disclosed quantity                                         | Optional           | 0             |

\*Note: expiry\_date is optional if underlying includes expiry (e.g., NIFTY28OCT25FUT) \*\*Note: Options only support MIS and NRML products (CNC not supported)

####

### Response Parameters

| Parameter       | Description                                  | Type   |
| --------------- | -------------------------------------------- | ------ |
| status          | API response status (success/error)          | string |
| orderid         | Broker order ID (or SB-xxx for analyze mode) | string |
| symbol          | Resolved option symbol                       | string |
| exchange        | Exchange code where order is placed          | string |
| underlying      | Underlying symbol from request               | string |
| underlying\_ltp | Last Traded Price of underlying              | number |
| offset          | Strike offset from request                   | string |
| option\_type    | Option type (CE/PE)                          | string |
| mode            | Trading mode (analyze/live)\*\*\*            | string |

\*\*\*Note: mode field is only present in Analyze Mode responses

####

### Live Mode vs Analyze Mode

#### Live Mode

* **When**: Analyze Mode toggle is OFF in OpenAlgo settings
* **Behavior**: Places real orders with connected broker
* **Order ID Format**: Broker's order ID (e.g., "240123000001234")
* **Response**: No "mode" field present

#### Analyze Mode (Sandbox)

* **When**: Analyze Mode toggle is ON in OpenAlgo settings
* **Behavior**: Places virtual orders in sandbox environment
* **Order ID Format**: Sandbox ID with "SB-" prefix (e.g., "SB-1234567890")
* **Response**: Includes "mode": "analyze" field
* **Features**: Virtual capital, realistic execution, auto square-off

**Note**: Same API call works in both modes. The system automatically detects which mode is active.

####

### Product Types for Options

| Product | Description            | Margin | Square-off     | Use Case            |
| ------- | ---------------------- | ------ | -------------- | ------------------- |
| MIS     | Margin Intraday        | Lower  | Auto (3:15 PM) | Intraday trading    |
| NRML    | Normal (Carry Forward) | Higher | Manual         | Overnight positions |

**Note**: CNC (Cash & Carry) is not supported for options trading.

####

### Examples for Different Strategies

#### 1. Buy ATM Straddle

**Call Leg:**

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "straddle",
    "underlying": "NIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 50,
    "offset": "ATM",
    "option_type": "CE",
    "action": "BUY",
    "quantity": 75,
    "pricetype": "MARKET",
    "product": "MIS"
}
```

**Put Leg:**

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "straddle",
    "underlying": "NIFTY",
    "exchange": "NSE_INDEX",
    "expiry_date": "28NOV24",
    "strike_int": 50,
    "offset": "ATM",
    "option_type": "PE",
    "action": "BUY",
    "quantity": 75,
    "pricetype": "MARKET",
    "product": "MIS"
}
```

#### 2. Iron Condor (4 Legs)

**Leg 1: Sell OTM1 Call**

```json
{
    "underlying": "NIFTY",
    "offset": "OTM1",
    "option_type": "CE",
    "action": "SELL",
    "quantity": 75
}
```

**Leg 2: Sell OTM1 Put**

```json
{
    "underlying": "NIFTY",
    "offset": "OTM1",
    "option_type": "PE",
    "action": "SELL",
    "quantity": 75
}
```

**Leg 3: Buy OTM3 Call**

```json
{
    "underlying": "NIFTY",
    "offset": "OTM3",
    "option_type": "CE",
    "action": "BUY",
    "quantity": 75
}
```

**Leg 4: Buy OTM3 Put**

```json
{
    "underlying": "NIFTY",
    "offset": "OTM3",
    "option_type": "PE",
    "action": "BUY",
    "quantity": 75
}
```

#### 3. Covered Call (Equity + Short Call)

```json
{
    "apikey": "your_api_key",
    "strategy": "covered_call",
    "underlying": "RELIANCE",
    "exchange": "NSE",
    "expiry_date": "28NOV24",
    "strike_int": 10,
    "offset": "OTM2",
    "option_type": "CE",
    "action": "SELL",
    "quantity": 1000,
    "pricetype": "MARKET",
    "product": "NRML"
}
```

####

### Lot Size Reference

| Underlying | Lot Size | Strike Interval | Exchange   |
| ---------- | -------- | --------------- | ---------- |
| NIFTY      | 25       | 50              | NSE\_INDEX |
| BANKNIFTY  | 15       | 100             | NSE\_INDEX |
| FINNIFTY   | 25       | 50              | NSE\_INDEX |
| MIDCPNIFTY | 50       | 25              | NSE\_INDEX |
| SENSEX     | 10       | 100             | BSE\_INDEX |
| BANKEX     | 15       | 100             | BSE\_INDEX |

**Note**: For equity options, lot size varies. Check contract specifications.

####

### Error Response

```json
{
    "status": "error",
    "message": "Option symbol NIFTY28NOV2425500CE not found in NFO. Symbol may not exist or master contract needs update."
}
```

####

### Common Error Messages

| Error Message                       | Cause                           | Solution                     |
| ----------------------------------- | ------------------------------- | ---------------------------- |
| Invalid openalgo apikey             | API key is incorrect or expired | Check API key in settings    |
| Option symbol not found             | Calculated strike doesn't exist | Check strike\_int and offset |
| Quantity must be a positive integer | Invalid quantity value          | Provide valid quantity       |
| Insufficient funds                  | Not enough margin (Live mode)   | Add funds or reduce quantity |
| Master contract needs update        | Symbol database is outdated     | Update master contract data  |

####

### Features

1. **Auto Symbol Resolution**: Automatically calculates ATM and resolves option symbol
2. **Dual Mode Support**: Works in both Live and Analyze (Sandbox) modes
3. **All Order Types**: Supports MARKET, LIMIT, SL, and SL-M orders
4. **Real-time LTP**: Uses current market price for ATM calculation
5. **Strategy Tracking**: Associates orders with strategy names for analytics
6. **Telegram Alerts**: Automatic notifications for order placement
7. **Error Handling**: Comprehensive error messages for debugging

####

### Rate Limiting

* **Limit**: 10 requests per second
* **Scope**: Per API endpoint
* **Response**: 429 status code if limit exceeded

####

### Best Practices

1. **Test in Analyze Mode First**: Enable Analyze Mode to test strategies without real money
2. **Verify Lot Size**: Ensure quantity is a multiple of lot size
3. **Check Strike Intervals**: Use correct strike\_int for each underlying (50 for NIFTY, 100 for BANKNIFTY)
4. **Use Appropriate Product**: MIS for intraday, NRML for overnight
5. **Handle Errors**: Implement error handling for failed orders
6. **Monitor Margin**: Check available margin before placing orders
7. **Update Master Contracts**: Keep symbol database updated for accurate symbol resolution



### orderstatus

# OrderStatus

## Endpoint URL

```
Local Host   :  POST http://127.0.0.1:5000/api/v1/orderstatus
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/orderstatus
Custom Domain:  POST https://<your-custom-domain>/api/v1/orderstatus
```



## Sample API Request

```json
{
    "apikey":"<your_app_apikey>",
    "strategy": "Test Strategy",
    "orderid": "24120900146469"
}
```



## Sample API Response

```json
{
  "data": {
    "action": "BUY",
    "average_price": 18.95,
    "exchange": "NSE",
    "order_status": "complete",
    "orderid": "250828000185002",
    "price": 0,
    "pricetype": "MARKET",
    "product": "MIS",
    "quantity": "1",
    "symbol": "YESBANK",
    "timestamp": "28-Aug-2025 09:59:10",
    "trigger_price": 0
  },
  "status": "success"
}
```

###

## Parameters Description

| Parameters | Description   | Mandatory/Optional | Default Value |
| ---------- | ------------- | ------------------ | ------------- |
| apikey     | App API key   | Mandatory          | -             |
| strategy   | Strategy name | Mandatory          | -             |
| orderid    | Order Id      | Mandatory          | -             |



### placeorder

# Placeorder

## Endpoint URL

This API Function Place Orders to the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/placeorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/placeorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/placeorder
```

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "Test Strategy", 
    "symbol":"SAIL", 
    "action":"BUY", 
    "exchange":"NSE", 
    "pricetype":"MARKET", 
    "product":"MIS", 
    "quantity":"1" 
    
}

```



## Sample API Request

```json
{
    "apikey": "your_app_apikey",
    "strategy": "Test Strategy",
    "exchange": "NSE",
    "symbol": "BHEL",
    "action": "BUY",
    "product": "MIS",
    "pricetype": "MARKET",
    "quantity": "1",
    "price": "0",
    "trigger_price": "0",
    "disclosed_quantity": "0"
}
```

###

## Sample API Response

```json
{
    "orderid": "240307000614705",
    "status": "success"
}
```

###

## Parameter Description



| Parameters          | Description        | Mandatory/Optional | Default Value |
| ------------------- | ------------------ | ------------------ | ------------- |
| apikey              | App API key        | Mandatory          | -             |
| strategy            | Strategy name      | Mandatory          | -             |
| exchange            | Exchange code      | Mandatory          | -             |
| symbol              | Trading symbol     | Mandatory          | -             |
| action              | Action (BUY/SELL)  | Mandatory          | -             |
| product             | Product type       | Optional           | MIS           |
| pricetype           | Price type         | Optional           | MARKET        |
| quantity            | Quantity           | Mandatory          | -             |
| price               | Price              | Optional           | 0             |
| trigger\_price      | Trigger price      | Optional           | 0             |
| disclosed\_quantity | Disclosed quantity | Optional           | 0             |



### placesmartorder

# PlaceSmartOrder

Place Order Smartly by analyzing the current open position. It matches the Position Size with the given position book. Buy/Sell Signal Orders will be traded accordingly to the Position Size



## Endpoint URL

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/placesmartorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/placesmartorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/placesmartorder
```

## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "Test Strategy",
    "exchange": "NSE",
    "symbol": "IDEA",
    "action": "BUY",
    "product": "MIS",
    "pricetype": "MARKET",
    "quantity": "1",
    "position_size": "5",
    "price": "0",
    "trigger_price": "0",
    "disclosed_quantity": "0"
}
```

## Sample API Response

```json
{
    "orderid": "240307000616990",
    "status": "success"
}
```

## Parameters Description

| Parameters          | Description        | Mandatory/Optional | Default Value |
| ------------------- | ------------------ | ------------------ | ------------- |
| apikey              | App API key        | Mandatory          | -             |
| strategy            | Strategy name      | Mandatory          | -             |
| exchange            | Exchange code      | Mandatory          | -             |
| symbol              | Trading symbol     | Mandatory          | -             |
| action              | Action (BUY/SELL)  | Mandatory          | -             |
| product             | Product type       | Optional           | MIS           |
| pricetype           | Price type         | Optional           | MARKET        |
| quantity            | Quantity           | Mandatory          | -             |
| position\_size      | Position Size      | Mandatory          | -             |
| price               | Price              | Optional           | 0             |
| trigger\_price      | Trigger price      | Optional           | 0             |
| disclosed\_quantity | Disclosed quantity | Optional           | 0             |

## How PlaceSmartOrder API Works?



{% embed url="https://www.youtube.com/watch?v=bC46E1GV4gY" %}



PlaceSmartOrder API function, which allows traders to build intelligent trading systems that can automatically place orders based on existing trade positions in the position book.

| Action | Qty (API) | Pos Size (API) | Current Open Pos | Action by OpenAlgo                      |
| ------ | --------- | -------------- | ---------------- | --------------------------------------- |
| BUY    | 100       | 0              | 0                | No Open Pos Found. Buy +100 qty         |
| BUY    | 100       | 100            | -100             | BUY 200 to match Open Pos in API Param  |
| BUY    | 100       | 100            | 100              | No Action. Position matched             |
| BUY    | 100       | 200            | 100              | BUY 100 to match Open Pos in API Param  |
| SELL   | 100       | 0              | 0                | No Open Pos Found. SELL 100 qty         |
| SELL   | 100       | -100           | +100             | SELL 200 to match Open Pos in API Param |
| SELL   | 100       | -100           | -100             | No Action. Position matched             |
| SELL   | 100       | -200           | -100             | SELL 100 to match Open Pos in API Param |

\



### splitorder

# SplitOrder

## Endpoint URL

This API Function Place Split Orders to the Broker

```http
Local Host   :  POST http://127.0.0.1:5000/api/v1/splitorder
Ngrok Domain :  POST https://<your-ngrok-domain>.ngrok-free.app/api/v1/splitorder
Custom Domain:  POST https://<your-custom-domain>/api/v1/splitorder
```



## Sample API Request

```json
{
    "apikey": "<your_app_apikey>",
    "strategy": "Test Strategy",
    "exchange": "NSE",
    "symbol": "YESBANK",
    "action": "SELL",
    "quantity": "105",
    "splitsize": "20",
    "pricetype": "MARKET",
    "product": "MIS"
}
```

###

## Sample API Response

```json
{
  "results": [
    {
      "order_num": 1,
      "orderid": "24120900343417",
      "quantity": 20,
      "status": "success"
    },
    {
      "order_num": 2,
      "orderid": "24120900343419",
      "quantity": 20,
      "status": "success"
    },
    {
      "order_num": 3,
      "orderid": "24120900343420",
      "quantity": 20,
      "status": "success"
    },
    {
      "order_num": 4,
      "orderid": "24120900343418",
      "quantity": 20,
      "status": "success"
    },
    {
      "order_num": 5,
      "orderid": "24120900343421",
      "quantity": 20,
      "status": "success"
    },
    {
      "order_num": 6,
      "orderid": "24120900343416",
      "quantity": 5,
      "status": "success"
    }
  ],
  "split_size": 20,
  "status": "success",
  "total_quantity": 105
}
```

###

## Parameter Description



| Parameters          | Description        | Mandatory/Optional | Default Value |
| ------------------- | ------------------ | ------------------ | ------------- |
| apikey              | App API key        | Mandatory          | -             |
| strategy            | Strategy name      | Mandatory          | -             |
| exchange            | Exchange code      | Mandatory          | -             |
| symbol              | Trading symbol     | Mandatory          | -             |
| action              | Action (BUY/SELL)  | Mandatory          | -             |
| product             | Product type       | Optional           | MIS           |
| pricetype           | Price type         | Optional           | MARKET        |
| quantity            | Quantity           | Mandatory          | -             |
| price               | Price              | Optional           | 0             |
| trigger\_price      | Trigger price      | Optional           | 0             |
| disclosed\_quantity | Disclosed quantity | Optional           | 0             |



### rate-limiting

# Rate Limiting

## Rate Limiting

To protect OpenAlgo from abuse and ensure fair usage, rate limits are enforced at both login and API levels. These limits are configurable via the `.env` file and apply globally per IP address.

### UI Login Rate Limits

OpenAlgo applies two login-specific rate limits:

| Scope      | Limit        | Description                                      |
| ---------- | ------------ | ------------------------------------------------ |
| Per Minute | 5 per minute | Allows a maximum of 5 login attempts per minute. |
| Per Hour   | 25 per hour  | Allows a maximum of 25 login attempts per hour.  |

These limits help prevent brute-force login attempts and secure user accounts.

### API Rate Limits

OpenAlgo implements differentiated rate limiting for various types of operations:

#### Order Management APIs

| Scope      | Limit         | Description                                     |
| ---------- | ------------- | ----------------------------------------------- |
| Per Second | 10 per second | Order placement, modification, and cancellation |

Applies to:

* `/api/v1/placeorder` - Place new orders
* `/api/v1/modifyorder` - Modify existing orders
* `/api/v1/cancelorder` - Cancel orders

#### Smart Order API

| Scope      | Limit        | Description                                |
| ---------- | ------------ | ------------------------------------------ |
| Per Second | 2 per second | Multi-leg smart order placement operations |

Applies to:

* `/api/v1/placesmartorder` - Place multi-leg smart orders

Smart orders have the most restrictive limit due to their complexity and additional processing requirements.

#### General APIs

| Scope      | Limit         | Description                                   |
| ---------- | ------------- | --------------------------------------------- |
| Per Second | 50 per second | All other API endpoints including market data |

Applies to all other API endpoints including:

* Market data APIs (quotes, depth, history)
* Account APIs (funds, positions, holdings)
* Information APIs (orderbook, tradebook)
* Search and symbol APIs

#### Webhook APIs

| Scope      | Limit          | Description                                       |
| ---------- | -------------- | ------------------------------------------------- |
| Per Minute | 100 per minute | External webhook endpoints from trading platforms |

Applies to:

* `/strategy/webhook/<webhook_id>` - Strategy webhook from external platforms
* `/chartink/webhook/<webhook_id>` - ChartInk webhook from external platforms

These limits protect against external DoS attacks and webhook flooding.

#### Strategy Management APIs

| Scope      | Limit          | Description                                   |
| ---------- | -------------- | --------------------------------------------- |
| Per Minute | 200 per minute | Strategy creation, modification, and deletion |

Applies to:

* `/strategy/new` - Create new strategies
* `/strategy/<id>/delete` - Delete strategies
* `/strategy/<id>/configure` - Configure strategy symbols
* `/chartink/new` - Create new ChartInk strategies
* `/chartink/<id>/delete` - Delete ChartInk strategies
* `/chartink/<id>/configure` - Configure ChartInk strategy symbols

These limits prevent strategy management abuse and database flooding.

### Configuration via .env

You can adjust the rate limits by editing the following variables in your `.env` or `.env.sample` file:

```env
# Login rate limits
LOGIN_RATE_LIMIT_MIN="5 per minute"
LOGIN_RATE_LIMIT_HOUR="25 per hour"

# API rate limits
API_RATE_LIMIT="50 per second"
ORDER_RATE_LIMIT="10 per second"
SMART_ORDER_RATE_LIMIT="2 per second"
WEBHOOK_RATE_LIMIT="100 per minute"
STRATEGY_RATE_LIMIT="200 per minute"
```

These limits follow [Flask-Limiter syntax](https://flask-limiter.readthedocs.io/en/stable/#rate-limit-string-format) and support formats like:

* `10 per second`
* `100 per minute`
* `1000 per day`

### What Happens When Limits Are Exceeded

If a client exceeds any configured rate limit:

* The server will respond with HTTP status `429 Too Many Requests`.
* A `Retry-After` header will be sent with the time to wait before retrying.
* Further requests will be blocked until the rate window resets.

### Security Impact

The rate limiting implementation provides essential protection:

#### Critical Protection

* **External DoS Attacks**: Webhook endpoints are protected from unlimited external requests
* **System Overload**: Strategy operations are protected from flooding
* **Resource Exhaustion**: Prevents accidental system overwhelming

#### Attack Vector Mitigation

* **Webhook Flooding**: External platforms cannot flood webhook endpoints
* **Strategy Abuse**: Prevents rapid strategy creation/deletion attempts
* **Order Flooding**: Prevents overwhelming the order management system

### Implementation Details

#### Rate Limiting Strategy

OpenAlgo uses the **moving-window** strategy for rate limiting, which provides more accurate rate limiting compared to fixed-window approaches.

#### Storage Backend

Rate limit counters are stored in memory (`memory://`), which means:

* Fast performance with minimal latency
* Counters reset when the application restarts
* Suitable for single-user deployments

#### Key Function

Rate limits are applied per IP address using `get_remote_address` as the key function. Each unique IP address has its own rate limit counter.

### Version History

* **v1.0.1**: Single `API_RATE_LIMIT` for all endpoints (10 per second)
* **v1.0.2**: Introduced differentiated rate limits:
  * Separate limits for order operations (10 per second)
  * Dedicated limit for smart orders (2 per second)
  * Increased general API limit to 50 per second
  * Added webhook protection (100 per minute)
  * Added strategy operation protection (200 per minute)

### Recommendations

#### For API Consumers

* Avoid retrying failed login attempts rapidly
* Spread out API requests using sleep/delay logic or a rate-limiter in your client code
* Use queues or batching when dealing with large volumes of data or orders
* Implement exponential backoff when receiving 429 errors

#### For Webhook Integration

* Ensure webhook calls are spread out appropriately
* Implement retry logic with delays for webhook failures
* Monitor webhook success rates to detect rate limiting

#### For Strategy Management

* Avoid rapid creation/deletion of strategies
* Batch symbol configuration operations when possible
* Implement proper error handling for strategy operations

### Troubleshooting

#### Common Issues

1. **"Rate limit exceeded" errors**
   * Check your request frequency
   * Implement proper retry logic with delays
   * Consider using batch operations
2. **Webhook failures**
   * Verify webhook rate limits are appropriate for your platform
   * Check if external platforms are respecting rate limits
   * Monitor webhook logs for patterns
3. **Strategy operation failures**
   * Ensure strategy operations are not happening too rapidly
   * Check for automated scripts that might be creating excessive requests
   * Verify proper error handling in strategy management code

### Customization

To modify rate limits:

1. Update the values in your `.env` file
2. Restart the application for changes to take effect
3. Ensure the `ENV_CONFIG_VERSION` matches the expected version (1.0.2)

Example customization:

```env
# Increase webhook rate limit for high-frequency platforms
WEBHOOK_RATE_LIMIT="200 per minute"

# Decrease strategy operations for tighter control
STRATEGY_RATE_LIMIT="100 per minute"

# Increase order rate limit for active trading
ORDER_RATE_LIMIT="20 per second"
```

***



### websockets

# Websockets

## OpenAlgo WebSocket Protocol Documentation

### Overview

The OpenAlgo WebSocket protocol allows clients to receive **real-time market data** using a standardized and broker-agnostic interface. It supports data streaming for **LTP (Last Traded Price)**, **Quotes (OHLC + Volume)**, and **Market Depth** (up to 50 levels depending on broker capability).

The protocol ensures efficient, scalable, and secure communication between client applications (such as trading bots, dashboards, or analytics tools) and the OpenAlgo platform. Authentication is handled using the OpenAlgo API key, and subscriptions are maintained per session.

### Version

* Protocol Version: 1.0
* Last Updated: May 28, 2025
* Platform: OpenAlgo Trading Framework

### WebSocket URL

```
ws://<host>:8765
```

Replace `<host>` with the IP/domain of your OpenAlgo instance. For local development setups, use thee hostname as`127.0.0.1`

```
ws://127.0.0.1:8765
```



In the production ubuntu server if your host is https://yourdomain.com then&#x20;

WebSocket url will be

```
wss://yourdomain.com/ws
```

In the production ubuntu server if your host is https://sub.yourdomain.com then&#x20;

WebSocket url will be

```
wss://sub.yourdomain.com/ws
```

### Authentication

All WebSocket sessions must begin with API key authentication:

```json
{
  "action": "authenticate", 
  "api_key": "YOUR_OPENALGO_API_KEY"
}
```

On success, the server confirms authentication. On failure, the connection is closed or an error message is returned.

### Data Modes

Clients can subscribe to different types of market data using the `mode` parameter. Each mode corresponds to a specific level of detail:

| Mode | Description    | Details                                    |
| ---- | -------------- | ------------------------------------------ |
| 1    | **LTP Mode**   | Last traded price and timestamp only       |
| 2    | **Quote Mode** | Includes OHLC, LTP, volume, change, etc.   |
| 3    | **Depth Mode** | Includes buy/sell order book (5â50 levels) |

> Note: Mode 3 supports optional parameter `depth_level` to define the number of depth levels requested (e.g., 5, 20, 30, 50). Actual support depends on the broker.

### Subscription Format

#### Basic Subscription

```json
{
  "action": "subscribe",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "mode": 1
}
```

#### Depth Subscription (with levels)

```json
{
  "action": "subscribe",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "mode": 3,
  "depth_level": 5
}
```

### Unsubscription

To unsubscribe from a stream:

```json
{
  "action": "unsubscribe",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "mode": 2
}
```

### Error Handling

If a client requests a depth level not supported by their broker:

```json
{
  "type": "error",
  "code": "UNSUPPORTED_DEPTH_LEVEL",
  "message": "Depth level 50 is not supported by broker Angel for exchange NSE",
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "requested_mode": 3,
  "requested_depth": 50,
  "supported_depths": [5, 20]
}
```

### Market Data Format

#### LTP (Mode 1)

```json
{
  "type": "market_data",
  "mode": 1,
  "topic": "RELIANCE.NSE",
  "data": {
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "ltp": 1424.0,
    "timestamp": "2025-05-28T10:30:45.123Z"
  }
}
```

#### Quote (Mode 2)

```json
{
  "type": "market_data",
  "mode": 2,
  "topic": "RELIANCE.NSE",
  "data": {
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "ltp": 1424.0,
    "change": 6.0,
    "change_percent": 0.42,
    "volume": 100000,
    "open": 1415.0,
    "high": 1432.5,
    "low": 1408.0,
    "close": 1418.0,
    "last_trade_quantity": 50,
    "avg_trade_price": 1419.35,
    "timestamp": "2025-05-28T10:30:45.123Z"
  }
}
```

#### Depth (Mode 3 with depth\_level = 5)

```json
{
  "type": "market_data",
  "mode": 3,
  "depth_level": 5,
  "topic": "RELIANCE.NSE",
  "data": {
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "ltp": 1424.0,
    "depth": {
      "buy": [
        {"price": 1423.9, "quantity": 50, "orders": 3},
        {"price": 1423.5, "quantity": 35, "orders": 2},
        {"price": 1423.0, "quantity": 42, "orders": 4},
        {"price": 1422.5, "quantity": 28, "orders": 1},
        {"price": 1422.0, "quantity": 33, "orders": 5}
      ],
      "sell": [
        {"price": 1424.1, "quantity": 47, "orders": 2},
        {"price": 1424.5, "quantity": 39, "orders": 3},
        {"price": 1425.0, "quantity": 41, "orders": 4},
        {"price": 1425.5, "quantity": 32, "orders": 2},
        {"price": 1426.0, "quantity": 30, "orders": 1}
      ]
    },
    "timestamp": "2025-05-28T10:30:45.123Z",
    "broker_supported": true
  }
}
```

### Heartbeat and Reconnection

* Server sends `ping` messages every 30 seconds.
* Clients must respond with `pong` or will be disconnected.
* Upon reconnection, clients must re-authenticate and re-subscribe to streams.
* Proxy may automatically restore prior subscriptions if supported by broker.

### Security & Compliance

* All clients must authenticate with an API key.
* Unauthorized or malformed requests are rejected.
* Rate limits may apply to prevent abuse.
* TLS encryption recommended for production deployments.





The OpenAlgo WebSocket feed provides a reliable and structured method for receiving real-time trading data. Proper mode selection and parsing allow efficient integration into trading algorithms and monitoring systems.


