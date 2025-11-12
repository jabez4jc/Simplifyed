# Simplifyed Admin V2 - Comprehensive Application Documentation

**Version:** 2.0.0
**Last Updated:** November 2025
**Status:** Backend Complete, Frontend Pending

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Technology Stack](#technology-stack)
4. [Application Structure](#application-structure)
5. [Core Components](#core-components)
6. [Database Schema](#database-schema)
7. [API Routes & Endpoints](#api-routes--endpoints)
8. [OpenAlgo Integration](#openalgo-integration)
9. [Services Layer](#services-layer)
10. [Polling & Real-time Updates](#polling--real-time-updates)
11. [Authentication & Security](#authentication--security)
12. [Configuration](#configuration)
13. [Error Handling](#error-handling)
14. [Development Workflow](#development-workflow)

---

## Executive Summary

Simplifyed Admin V2 is a **Node.js/Express backend application** that provides a comprehensive management dashboard for multiple OpenAlgo trading instances. The system enables:

- **Multi-instance management**: Connect and manage multiple OpenAlgo brokers
- **Smart polling**: Automatic P&L updates (15s) and market data (5s when active)
- **Watchlist management**: Create watchlists with symbols and assign to instances
- **Order execution**: Place, modify, and cancel orders using OpenAlgo's smart order API
- **P&L tracking**: Real-time profit/loss calculations with target monitoring
- **Health monitoring**: Continuous health checks of all connected instances

**Current Status:**
- ✅ Backend: Fully functional with 40+ OpenAlgo API endpoints integrated
- ⏳ Frontend: Pending implementation (backend serves static files from `/public/`)

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Client (Browser)                         │
│                    [Future Frontend]                         │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP/REST API
                       │ WebSocket (future)
┌──────────────────────▼──────────────────────────────────────┐
│              Express.js Application (server.js)              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Middleware Stack                        │   │
│  │  • Security (Helmet, CORS)                          │   │
│  │  • Authentication (Google OAuth / Test Mode)        │   │
│  │  • Request Logging (Winston)                        │   │
│  │  • Error Handling                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Routes Layer (v1)                       │   │
│  │  /api/v1/instances  /api/v1/watchlists              │   │
│  │  /api/v1/orders     /api/v1/positions               │   │
│  │  /api/v1/symbols    /api/v1/polling                 │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Services Layer                          │   │
│  │  • Instance Service  • Watchlist Service            │   │
│  │  • Order Service     • P&L Service                  │   │
│  │  • Polling Service   • Symbol Validation Service    │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            OpenAlgo Integration Layer                │   │
│  │  • HTTP Client (with retry logic)                   │   │
│  │  • 40+ API Endpoints                                │   │
│  │  • Request/Response Handling                        │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Core Infrastructure                     │   │
│  │  • Configuration  • Logger  • Database              │   │
│  │  • Custom Errors  • Utilities                       │   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                  SQLite Database (WAL mode)                  │
│  • 11 Tables  • 40+ Indexes  • ACID Compliant               │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│            External: Multiple OpenAlgo Instances             │
│  Instance 1 (Primary)  │  Instance 2  │  Instance N          │
│  ┌──────────────────┐  │  ┌────────┐  │  ┌────────┐        │
│  │ OpenAlgo API     │  │  │  API   │  │  │  API   │        │
│  │ (Broker: Zerodha,│  │  │        │  │  │        │        │
│  │  Angel, etc.)    │  │  │        │  │  │        │        │
│  └──────────────────┘  │  └────────┘  │  └────────┘        │
└─────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Clean Architecture**: Separation of concerns across layers (routes → services → integrations)
2. **Singleton Pattern**: Shared instances for database, logger, and HTTP client
3. **Service-Oriented**: Business logic encapsulated in service classes
4. **Error-First**: Comprehensive error handling with custom error classes
5. **Configuration-Driven**: Environment-based configuration with sensible defaults
6. **Async/Await**: Modern JavaScript with promises throughout

---

## Technology Stack

### Core Dependencies

```json
{
  "runtime": "Node.js >= 18.0.0",
  "framework": "Express 4.18.2",
  "database": "SQLite3 5.1.7 (WAL mode)",
  "authentication": "Passport (Google OAuth 2.0)",
  "http_client": "undici 7.16.0 (with ProxyAgent)",
  "logging": "Winston 3.11.0",
  "validation": "Joi 17.11.0",
  "session": "express-session 1.17.3",
  "websockets": "socket.io 4.6.1 (future use)"
}
```

### Security Stack

- **Helmet**: HTTP security headers
- **CORS**: Cross-origin resource sharing
- **Compression**: Response compression
- **Session Management**: Secure cookie-based sessions
- **Input Sanitization**: Custom sanitizers for SQL injection prevention

### Development Tools

- **ESLint**: Code linting
- **Prettier**: Code formatting
- **Node Test Runner**: Built-in test framework
- **Playwright**: E2E testing (watchlist flicker tests)

---

## Application Structure

```
backend/
├── server.js                    # Express app entry point
├── package.json                 # Dependencies and scripts
├── .env.example                 # Environment template
├── .eslintrc.json              # ESLint configuration
│
├── src/
│   ├── core/                    # Core infrastructure
│   │   ├── config.js           # Environment configuration
│   │   ├── database.js         # SQLite wrapper
│   │   ├── logger.js           # Winston logger
│   │   └── errors.js           # Custom error classes
│   │
│   ├── middleware/              # Express middleware
│   │   ├── auth.js             # Google OAuth + test mode
│   │   ├── error-handler.js    # Global error handler
│   │   └── request-logger.js   # Request/response logging
│   │
│   ├── routes/                  # API route handlers
│   │   └── v1/
│   │       ├── index.js        # Route aggregator
│   │       ├── instances.js    # Instance CRUD
│   │       ├── watchlists.js   # Watchlist management
│   │       ├── orders.js       # Order placement
│   │       ├── positions.js    # Position tracking
│   │       ├── symbols.js      # Symbol search
│   │       └── polling.js      # Polling control
│   │
│   ├── services/                # Business logic
│   │   ├── instance.service.js            # Instance management (507 lines)
│   │   ├── watchlist.service.js           # Watchlist operations (720+ lines)
│   │   ├── order.service.js               # Order execution (460+ lines)
│   │   ├── pnl.service.js                 # P&L calculations (460+ lines)
│   │   ├── polling.service.js             # Polling orchestration (450 lines)
│   │   └── symbol-validation.service.js   # Symbol validation/caching
│   │
│   ├── integrations/            # External API clients
│   │   └── openalgo/
│   │       ├── client.js       # HTTP client with retry (660 lines)
│   │       ├── endpoints.js    # Endpoint definitions (40+ endpoints)
│   │       └── validators.js   # Request/response validators
│   │
│   └── utils/                   # Utility functions
│       └── sanitizers.js       # Input sanitization helpers
│
├── migrations/                  # Database migrations
│   ├── migrate.js              # Migration runner
│   ├── 000_initial_schema.js   # Core tables (11 tables)
│   ├── 001_add_indexes.js      # Performance indexes
│   ├── 002_add_broker_and_market_data_role.js
│   ├── 003_add_market_data_role_constraint.js
│   ├── 004_add_symbol_cache.js
│   ├── 005_add_index_symbol_type.js
│   └── 006_add_symbol_metadata.js
│
├── database/                    # SQLite database files
│   └── simplifyed.db           # Main database (created on first run)
│
├── logs/                        # Application logs
│   └── app.log                 # Winston log file
│
├── public/                      # Static files (frontend)
│   └── [frontend files here]
│
├── tests/                       # Test suites
│   ├── unit/                   # Unit tests (pending)
│   └── integration/            # Integration tests (pending)
│
└── e2e/                         # End-to-end tests
    └── watchlist-flicker.spec.js  # Playwright test
```

---

## Core Components

### 1. server.js (Application Entry Point)

**Location**: `/backend/server.js` (215 lines)

**Purpose**: Initializes and configures the Express application.

**Key Responsibilities:**
- Middleware setup (security, CORS, body parsing, session, authentication)
- Route registration (`/api/v1/*`)
- Google OAuth routes (`/auth/google`, `/auth/google/callback`)
- Static file serving (`/public/`)
- Database connection initialization
- Polling service startup
- Graceful shutdown handling (SIGTERM, SIGINT)

**Startup Sequence:**
1. Load environment configuration
2. Create Express app
3. Apply middleware stack
4. Register API routes
5. Connect to database
6. Create test user (if in development mode)
7. Start polling service
8. Listen on configured port
9. Display ASCII art banner with configuration summary

---

### 2. Core Infrastructure (src/core/)

#### config.js
**Purpose**: Environment variable management with validation

**Configuration Sections:**
- Environment (NODE_ENV, dev/prod/test flags)
- Server (port, base URL)
- Database (SQLite path)
- Session (secret, max age)
- Google OAuth (client ID, secret, callback URL)
- CORS (origin, credentials)
- Test Mode (enabled flag, test user email)
- Polling (instance interval: 15s, market data interval: 5s)
- OpenAlgo (request timeout: 15s, max retries: 3, retry delay: 1s)
- Logging (level, file path)
- Rate Limiting (window, max requests)

#### database.js
**Purpose**: SQLite database wrapper with connection pooling

**Features:**
- WAL (Write-Ahead Logging) mode for better concurrency
- Connection management (connect, close)
- Query methods (run, get, all)
- Transaction support
- Error handling with custom errors

#### logger.js
**Purpose**: Winston-based structured logging

**Log Levels:**
- error: Error conditions
- warn: Warning messages
- info: Informational messages (default)
- debug: Debug-level messages
- openalgo: Custom level for OpenAlgo API calls

**Transports:**
- Console (colorized, timestamped)
- File (JSON format, rotated daily)

#### errors.js
**Purpose**: Custom error classes for domain-specific errors

**Error Classes:**
- `ValidationError`: Input validation failures (400)
- `NotFoundError`: Resource not found (404)
- `ConflictError`: Duplicate resources (409)
- `OpenAlgoError`: OpenAlgo API errors (502)
- `InternalError`: Internal server errors (500)

---

## Database Schema

### Tables Overview

The database consists of **11 core tables** with **40+ indexes** for optimal query performance.

```
┌─────────────────────────────────────────────────────────────┐
│                      Database Schema                         │
└─────────────────────────────────────────────────────────────┘

users
├── id (PK)
├── email (UNIQUE)
├── is_admin
└── created_at

instances
├── id (PK)
├── name, host_url (UNIQUE), api_key, strategy_tag
├── is_primary_admin, is_secondary_admin
├── order_placement_enabled, market_data_role
├── target_profit, target_loss
├── current_balance, realized_pnl, unrealized_pnl, total_pnl
├── is_active, is_analyzer_mode, health_status
├── last_health_check, last_ping_at
├── created_at, last_updated
└── broker (from migration 002)

watchlists
├── id (PK)
├── name, description
├── is_active
├── created_at
└── updated_at

watchlist_symbols
├── id (PK)
├── watchlist_id (FK)
├── exchange, symbol, token, lot_size
├── qty_type, qty_value
├── product_type, order_type
├── target_type, target_value
├── sl_type, sl_value
├── ts_type, ts_value
├── trailing_activation_type, trailing_activation_value
├── max_position_size, max_instances
├── is_enabled
├── created_at
└── updated_at

watchlist_instances (junction table)
├── id (PK)
├── watchlist_id (FK)
├── instance_id (FK)
├── assigned_by
└── assigned_at
└── UNIQUE(watchlist_id, instance_id)

watchlist_orders
├── id (PK)
├── watchlist_id (FK), instance_id (FK), symbol_id (FK)
├── exchange, symbol
├── side, quantity, order_type, product_type
├── price, trigger_price
├── status, order_id, broker_order_id
├── message, metadata
├── placed_at
└── updated_at

watchlist_positions
├── id (PK)
├── watchlist_id (FK), instance_id (FK), symbol_id (FK)
├── exchange, symbol
├── quantity, average_price, current_price
├── realized_pnl, unrealized_pnl
├── status, is_closed
├── entered_at, exited_at
└── updated_at

market_data
├── id (PK)
├── exchange, symbol (UNIQUE), token
├── ltp, open, high, low, close, volume
├── change, change_percent
├── timestamp
└── updated_at

system_alerts
├── id (PK)
├── type, severity, title, message
├── details_json
├── instance_id (FK), watchlist_id (FK)
├── is_resolved, resolved_at
└── created_at

symbol_search_cache
├── id (PK)
├── search_query, symbol, tradingsymbol
├── exchange, exchange_segment, instrument_type
├── lot_size, tick_size, name, isin, asset_class
├── created_at
└── UNIQUE(search_query, symbol, exchange)

websocket_sessions (future use)
├── id (PK)
├── instance_id (FK)
├── session_type, status
├── connected_at, disconnected_at
├── last_message_at, messages_received
├── error_count, last_error
├── failover_at, failover_reason
└── created_at
```

### Key Database Features

1. **Foreign Key Constraints**: Cascade deletes to maintain referential integrity
2. **Unique Constraints**: Prevent duplicate instances, watchlists, symbols
3. **Indexes**: Optimize queries on frequently accessed columns (40+ indexes)
4. **Default Values**: Sensible defaults for configuration columns
5. **Timestamps**: Track creation and update times for all records
6. **ACID Compliance**: SQLite in WAL mode ensures data consistency

---

## API Routes & Endpoints

### Base URL Structure

```
All API endpoints are prefixed with: /api/v1
Example: http://localhost:3000/api/v1/instances
```

### 1. Health Check

**Endpoint**: `GET /api/v1/health`
**Authentication**: None
**Description**: Check API server health status

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-12T10:30:00.000Z",
  "version": "2.0.0"
}
```

---

### 2. Instance Management (`/api/v1/instances`)

#### GET /api/v1/instances
**Description**: Get all instances with optional filters
**Query Parameters:**
- `is_active` (boolean): Filter by active status
- `is_analyzer_mode` (boolean): Filter by analyzer mode
- `health_status` (string): Filter by health status (healthy/unhealthy/unknown)

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": 1,
      "name": "Primary Instance",
      "host_url": "https://openalgo.example.com",
      "strategy_tag": "default",
      "is_primary_admin": true,
      "target_profit": 5000,
      "target_loss": 2000,
      "current_balance": 50000,
      "total_pnl": 1500,
      "is_active": true,
      "is_analyzer_mode": false,
      "health_status": "healthy",
      "broker": "zerodha"
    }
  ],
  "count": 1
}
```

#### GET /api/v1/instances/:id
**Description**: Get instance by ID

#### POST /api/v1/instances
**Description**: Create new instance
**Body:**
```json
{
  "name": "Trading Instance",
  "host_url": "https://openalgo.example.com",
  "api_key": "your-api-key-here",
  "strategy_tag": "default",
  "target_profit": 5000,
  "target_loss": 2000,
  "is_active": true
}
```

#### PUT /api/v1/instances/:id
**Description**: Update instance

#### DELETE /api/v1/instances/:id
**Description**: Delete instance

#### POST /api/v1/instances/test/connection
**Description**: Test OpenAlgo connection (ping endpoint)
**Body:**
```json
{
  "host_url": "https://openalgo.example.com",
  "api_key": "your-api-key-here"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Connection successful",
  "data": {
    "broker": "zerodha"
  }
}
```

#### POST /api/v1/instances/test/apikey
**Description**: Test API key validity (funds endpoint)

#### POST /api/v1/instances/:id/refresh
**Description**: Manually refresh instance data (P&L, orders, health)

#### POST /api/v1/instances/:id/health
**Description**: Update health status for instance

#### POST /api/v1/instances/:id/pnl
**Description**: Update P&L data for instance

#### POST /api/v1/instances/:id/analyzer/toggle
**Description**: Toggle analyzer mode (Safe-Switch workflow)
**Body:**
```json
{
  "mode": true  // true = analyzer mode, false = live mode
}
```

#### GET /api/v1/instances/admin/instances
**Description**: Get admin instances (primary and secondary)

---

### 3. Watchlist Management (`/api/v1/watchlists`)

#### GET /api/v1/watchlists
**Description**: Get all watchlists
**Query Parameters:**
- `is_active` (boolean): Filter by active status

#### GET /api/v1/watchlists/:id
**Description**: Get watchlist by ID with symbols and instances

#### POST /api/v1/watchlists
**Description**: Create new watchlist
**Body:**
```json
{
  "name": "Intraday Stocks",
  "description": "High volume stocks for day trading",
  "is_active": true
}
```

#### PUT /api/v1/watchlists/:id
**Description**: Update watchlist

#### DELETE /api/v1/watchlists/:id
**Description**: Delete watchlist

#### POST /api/v1/watchlists/:id/clone
**Description**: Clone watchlist with new name
**Body:**
```json
{
  "name": "Cloned Watchlist"
}
```

#### GET /api/v1/watchlists/:id/symbols
**Description**: Get watchlist symbols with latest quotes

#### POST /api/v1/watchlists/:id/symbols
**Description**: Add symbol to watchlist
**Body:**
```json
{
  "exchange": "NSE",
  "symbol": "RELIANCE",
  "lot_size": 1,
  "qty_type": "FIXED",
  "qty_value": 10,
  "product_type": "MIS",
  "order_type": "MARKET"
}
```

#### PUT /api/v1/watchlists/:id/symbols/:symbolId
**Description**: Update symbol configuration

#### DELETE /api/v1/watchlists/:id/symbols/:symbolId
**Description**: Remove symbol from watchlist

#### POST /api/v1/watchlists/:id/instances
**Description**: Assign instance to watchlist
**Body:**
```json
{
  "instanceId": 1
}
```

#### DELETE /api/v1/watchlists/:id/instances/:instanceId
**Description**: Unassign instance from watchlist

---

### 4. Order Management (`/api/v1/orders`)

#### GET /api/v1/orders
**Description**: Get orders with filters
**Query Parameters:**
- `instanceId` (number): Filter by instance
- `watchlistId` (number): Filter by watchlist
- `status` (string): Filter by order status
- `symbol` (string): Filter by symbol
- `side` (string): Filter by order side (BUY/SELL)

#### GET /api/v1/orders/:id
**Description**: Get order by ID

#### POST /api/v1/orders
**Description**: Place order (using placesmartorder)
**Body:**
```json
{
  "instanceId": 1,
  "exchange": "NSE",
  "symbol": "RELIANCE",
  "action": "BUY",
  "quantity": 10,
  "position_size": 0,  // Current position size (for smart order)
  "product": "MIS",
  "pricetype": "MARKET",
  "price": "0",
  "trigger_price": "0"
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Order placed successfully",
  "data": {
    "id": 1,
    "order_id": "240626000012345",
    "status": "complete",
    "exchange": "NSE",
    "symbol": "RELIANCE"
  }
}
```

#### POST /api/v1/orders/batch
**Description**: Place multiple orders
**Body:**
```json
{
  "orders": [
    { "instanceId": 1, "exchange": "NSE", "symbol": "RELIANCE", ... },
    { "instanceId": 1, "exchange": "NSE", "symbol": "TCS", ... }
  ]
}
```

#### POST /api/v1/orders/:id/cancel
**Description**: Cancel specific order

#### POST /api/v1/orders/cancel-all
**Description**: Cancel all orders for an instance
**Body:**
```json
{
  "instanceId": 1,
  "strategy": "default"  // optional
}
```

#### POST /api/v1/orders/sync/:instanceId
**Description**: Sync order status from OpenAlgo

---

### 5. Position Management (`/api/v1/positions`)

#### GET /api/v1/positions/aggregate/pnl
**Description**: Get aggregated P&L across all active instances

**Response:**
```json
{
  "status": "success",
  "data": {
    "total_pnl": 2500,
    "realized_pnl": 1500,
    "unrealized_pnl": 1000,
    "instances": [
      {
        "id": 1,
        "name": "Primary Instance",
        "total_pnl": 1500,
        "realized_pnl": 1000,
        "unrealized_pnl": 500
      }
    ]
  }
}
```

#### GET /api/v1/positions/:instanceId
**Description**: Get positions for an instance

#### GET /api/v1/positions/:instanceId/pnl
**Description**: Get P&L breakdown for an instance

#### POST /api/v1/positions/:instanceId/close
**Description**: Close all positions for an instance

#### GET /api/v1/positions/:instanceId/target-check
**Description**: Check if instance has hit profit/loss targets

---

### 6. Symbol Management (`/api/v1/symbols`)

#### GET /api/v1/symbols/search
**Description**: Search for symbols using OpenAlgo
**Query Parameters:**
- `query` (string, required): Search query
- `instanceId` (number, optional): Specific instance to use for search

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "symbol": "RELIANCE",
      "tradingsymbol": "RELIANCE-EQ",
      "exchange": "NSE",
      "instrument_type": "EQ",
      "lot_size": 1,
      "name": "Reliance Industries Ltd"
    }
  ],
  "count": 1
}
```

#### POST /api/v1/symbols/validate
**Description**: Validate and get detailed symbol information
**Body:**
```json
{
  "symbol": "RELIANCE",
  "exchange": "NSE",
  "instanceId": 1
}
```

#### POST /api/v1/symbols/quotes
**Description**: Get quotes for multiple symbols
**Body:**
```json
{
  "symbols": [
    { "exchange": "NSE", "symbol": "RELIANCE" },
    { "exchange": "NSE", "symbol": "TCS" }
  ],
  "instanceId": 1
}
```

#### GET /api/v1/symbols/market-data/:exchange/:symbol
**Description**: Get cached market data for a symbol

#### GET /api/v1/symbols/expiry
**Description**: Get expiry dates for options
**Query Parameters:**
- `symbol` (string, required): Underlying symbol (e.g., NIFTY)
- `exchange` (string): Exchange code (default: NFO)
- `instanceId` (number, required): Instance to use

#### GET /api/v1/symbols/option-chain
**Description**: Get option chain for a symbol
**Query Parameters:**
- `symbol` (string, required): Underlying symbol
- `expiry` (string, required): Expiry date
- `exchange` (string): Exchange code (default: NFO)
- `instanceId` (number, required): Instance to use

---

### 7. Polling Control (`/api/v1/polling`)

#### GET /api/v1/polling/status
**Description**: Get polling service status

**Response:**
```json
{
  "status": "success",
  "data": {
    "isPolling": true,
    "isMarketDataPolling": true,
    "activeWatchlistId": 1,
    "intervals": {
      "instance": 15000,
      "marketData": 5000,
      "healthCheck": 300000
    }
  }
}
```

#### POST /api/v1/polling/start
**Description**: Start polling service

#### POST /api/v1/polling/stop
**Description**: Stop polling service

#### POST /api/v1/polling/market-data/start
**Description**: Start market data polling for watchlist
**Body:**
```json
{
  "watchlistId": 1
}
```

#### POST /api/v1/polling/market-data/stop
**Description**: Stop market data polling

---

### 8. Authentication Routes

#### GET /auth/google
**Description**: Initiate Google OAuth login flow

#### GET /auth/google/callback
**Description**: Google OAuth callback handler

#### POST /auth/logout
**Description**: Logout user

#### GET /api/user
**Description**: Get current user information
**Authentication**: Required

**Response:**
```json
{
  "status": "success",
  "data": {
    "id": 1,
    "email": "user@example.com",
    "is_admin": true
  }
}
```

---

## OpenAlgo Integration

### Overview

The OpenAlgo integration layer provides a complete HTTP client for interacting with OpenAlgo trading platforms. It implements **40+ API endpoints** with automatic retry logic, error handling, and proxy support.

### Client Architecture

**Location**: `/backend/src/integrations/openalgo/client.js` (660 lines)

**Features:**
- **Retry Logic**: Exponential backoff (3 retries, 1s initial delay)
- **Timeout Handling**: 15s request timeout (configurable)
- **Proxy Support**: Environment-based proxy with TLS verification control
- **Error Handling**: Custom `OpenAlgoError` with detailed context
- **Rate Limiting**: Respects OpenAlgo rate limits (50 req/s default)
- **Logging**: Structured logs for all API calls with duration tracking

### Request Flow

```
┌─────────────────────────────────────────────────────────────┐
│                   OpenAlgo Client Request Flow               │
└─────────────────────────────────────────────────────────────┘

1. Service calls openalgoClient.method(instance, params)
   ↓
2. Client prepares request:
   - Constructs URL: {host_url}/api/v1/{endpoint}
   - Adds apikey to payload
   - Masks sensitive data for logging
   ↓
3. Request execution with retry loop (max 3 attempts):
   ↓
4. HTTP request via undici fetch:
   - Timeout: 15s
   - Proxy: ProxyAgent (if configured)
   - Headers: Content-Type: application/json
   ↓
5. Response handling:
   - Parse JSON
   - Check HTTP status (4xx = no retry, 5xx = retry)
   - Check OpenAlgo status field
   - Extract data from response
   ↓
6. On failure (network, timeout, 5xx):
   - Wait: delay * 2^attempt (1s, 2s, 4s)
   - Retry (if attempts remaining)
   ↓
7. Return data to service or throw OpenAlgoError
```

### Endpoint Categories

#### 1. Account Management (7 endpoints)

```javascript
// Connection test
await openalgoClient.ping(instance);
// Returns: { broker, message }

// Analyzer mode
await openalgoClient.getAnalyzerStatus(instance);
// Returns: { mode, analyze_mode, total_logs }

await openalgoClient.toggleAnalyzer(instance, true);
// Toggles analyzer mode

// Account funds
await openalgoClient.getFunds(instance);
// Returns: { availablecash, collateral, m2mrealized, m2munrealized, utiliseddebits }

// Holdings
await openalgoClient.getHoldings(instance);
// Returns: Array of holdings
```

#### 2. Order Management (9 endpoints)

```javascript
// Get order book
await openalgoClient.getOrderBook(instance);
// Returns: { orders, statistics }

// Place smart order (position-aware)
await openalgoClient.placeSmartOrder(instance, {
  strategy: 'default',
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  position_size: 0,  // Current position
  product: 'MIS',
  pricetype: 'MARKET'
});
// Returns: { orderid, status }

// Cancel order
await openalgoClient.cancelOrder(instance, orderId, strategy);
// Returns: { orderid, status }

// Cancel all orders
await openalgoClient.cancelAllOrders(instance, strategy);
// Returns: { canceled_orders, failed_cancellations }

// Modify order
await openalgoClient.modifyOrder(instance, {
  orderid: '240626000012345',
  quantity: 20,
  price: '2500'
});
// Returns: { orderid, status }

// Split order (large orders into chunks)
await openalgoClient.placeSplitOrder(instance, {
  ...orderParams,
  splitsize: 5
});
// Returns: { success_orders, failed_orders }
```

#### 3. Position Management (3 endpoints)

```javascript
// Get position book
await openalgoClient.getPositionBook(instance);
// Returns: Array of positions

// Get open position for symbol
await openalgoClient.getOpenPosition(instance, symbol, exchange, product, strategy);
// Returns: { quantity }

// Close all positions
await openalgoClient.closePosition(instance, strategy);
// Returns: Result object
```

#### 4. Trade Management (1 endpoint)

```javascript
// Get trade book
await openalgoClient.getTradeBook(instance);
// Returns: Array of trades
```

#### 5. Market Data (3 endpoints)

```javascript
// Get quotes (batch request)
await openalgoClient.getQuotes(instance, [
  { exchange: 'NSE', symbol: 'RELIANCE' },
  { exchange: 'NSE', symbol: 'TCS' }
]);
// Returns: Array of quotes with ltp, open, high, low, close, volume

// Get market depth
await openalgoClient.getDepth(instance, exchange, symbol);
// Returns: Depth data with buy/sell orders

// Search symbols
await openalgoClient.searchSymbols(instance, 'RELIANCE');
// Returns: Array of matching symbols

// Get symbol details
await openalgoClient.getSymbol(instance, symbol, exchange);
// Returns: Symbol metadata (instrumenttype, expiry, strike, lotsize, etc.)
```

#### 6. Options & Derivatives (3 endpoints)

```javascript
// Get expiry dates
await openalgoClient.getExpiry(instance, 'NIFTY', 'NFO');
// Returns: Array of expiry dates

// Get option chain
await openalgoClient.getOptionChain(instance, 'NIFTY', '2025-11-28', 'NFO');
// Returns: Option chain data with calls and puts
```

#### 7. Historical Data (2 endpoints)

```javascript
// Get supported intervals
await openalgoClient.getIntervals(instance);
// Returns: Supported intervals by timeframe

// Get historical data
await openalgoClient.getHistory(instance, symbol, exchange, interval, start_date, end_date);
// Returns: Array of OHLCV data
```

#### 8. Margin Calculator (2 endpoints)

```javascript
// Calculate margin requirement
await openalgoClient.calculateMargin(instance, positions);
// Returns: Margin calculation
```

#### 9. Contract Info (2 endpoints)

```javascript
// Get contract information
await openalgoClient.getContractInfo(instance, exchange, symbol);
// Returns: Contract details
```

### Error Handling

The client implements comprehensive error handling:

```javascript
try {
  const result = await openalgoClient.placeSmartOrder(instance, orderData);
} catch (error) {
  if (error instanceof OpenAlgoError) {
    // OpenAlgo-specific error
    console.log('OpenAlgo error:', error.message);
    console.log('Endpoint:', error.endpoint);
    console.log('Status code:', error.statusCode);
  } else {
    // Network or other error
    console.log('General error:', error.message);
  }
}
```

**Error Types:**
- **Client Errors (4xx)**: No retry, thrown immediately
- **Server Errors (5xx)**: Retry with exponential backoff
- **Timeout**: Retry after delay
- **Network Errors**: Retry after delay

### Proxy Configuration

The client supports corporate proxies via environment variables:

```bash
# Set proxy URL
export https_proxy=http://proxy.company.com:8080

# Disable TLS verification (development only)
export PROXY_TLS_REJECT_UNAUTHORIZED=false
```

---

## Services Layer

### 1. Instance Service

**Location**: `/backend/src/services/instance.service.js` (507 lines)

**Responsibilities:**
- Instance CRUD operations
- Connection testing (ping, funds validation)
- Health status monitoring
- P&L data updates
- Analyzer mode toggling with Safe-Switch workflow
- Admin instance management (primary/secondary)
- Market data instance selection

**Key Methods:**
```javascript
// Create instance
await instanceService.createInstance({
  name: 'Trading Instance',
  host_url: 'https://openalgo.example.com',
  api_key: 'api-key',
  target_profit: 5000,
  target_loss: 2000
});

// Update P&L data
await instanceService.updatePnLData(instanceId);

// Update health status
await instanceService.updateHealthStatus(instanceId);

// Toggle analyzer mode
await instanceService.toggleAnalyzerMode(instanceId, true);

// Get market data instances (primary > secondary)
const instances = await instanceService.getMarketDataInstances();
```

---

### 2. Watchlist Service

**Location**: `/backend/src/services/watchlist.service.js` (720+ lines)

**Responsibilities:**
- Watchlist CRUD operations
- Symbol management (add, update, remove)
- Instance assignment/unassignment
- Quote fetching with caching
- Watchlist cloning
- Symbol configuration validation

**Key Methods:**
```javascript
// Create watchlist
await watchlistService.createWatchlist({
  name: 'Intraday Stocks',
  description: 'High volume stocks'
});

// Add symbol
await watchlistService.addSymbol(watchlistId, {
  exchange: 'NSE',
  symbol: 'RELIANCE',
  lot_size: 1,
  qty_type: 'FIXED',
  qty_value: 10
});

// Get symbols with quotes
const symbols = await watchlistService.getSymbolsWithQuotes(watchlistId);

// Assign instance
await watchlistService.assignInstance(watchlistId, instanceId);

// Clone watchlist
await watchlistService.cloneWatchlist(watchlistId, 'Cloned Watchlist');
```

---

### 3. Order Service

**Location**: `/backend/src/services/order.service.js` (460+ lines)

**Responsibilities:**
- Order placement using placesmartorder
- Batch order placement
- Order cancellation (single, all)
- Order status synchronization
- Order history tracking
- Validation and error handling

**Key Methods:**
```javascript
// Place order
await orderService.placeOrder({
  instanceId: 1,
  exchange: 'NSE',
  symbol: 'RELIANCE',
  action: 'BUY',
  quantity: 10,
  position_size: 0,
  product: 'MIS',
  pricetype: 'MARKET'
});

// Place multiple orders
await orderService.placeMultipleOrders(ordersArray);

// Cancel order
await orderService.cancelOrder(orderId);

// Cancel all orders
await orderService.cancelAllOrders(instanceId, strategy);

// Sync order status
await orderService.syncOrderStatus(instanceId);
```

---

### 4. P&L Service

**Location**: `/backend/src/services/pnl.service.js` (460+ lines)

**Responsibilities:**
- P&L calculations (realized, unrealized, total)
- Position book analysis
- Funds tracking
- Target monitoring (profit/loss targets)
- Aggregated P&L across instances

**Key Methods:**
```javascript
// Calculate instance P&L
const pnl = await pnlService.getInstancePnL(instance);
// Returns: { realized_pnl, unrealized_pnl, total_pnl, current_balance }

// Get aggregated P&L
const aggregated = await pnlService.getAggregatedPnL(instances);
// Returns: { total_pnl, instances: [...] }

// Check targets
const targetCheck = pnlService.checkTargets(instance, currentPnL);
// Returns: { hitTarget, targetType, target, current }
```

**P&L Calculation Logic:**
1. Fetch funds from OpenAlgo
2. Fetch position book with current prices
3. Calculate unrealized P&L per position: `(current_price - average_price) * quantity`
4. Fetch trade book for realized P&L
5. Calculate total P&L: `realized_pnl + unrealized_pnl`
6. Update instance record in database

---

### 5. Polling Service

**Location**: `/backend/src/services/polling.service.js` (450 lines)

**Responsibilities:**
- Orchestrate periodic updates
- Instance polling (every 15 seconds)
- Market data polling (every 5 seconds when active)
- Health checks (every 5 minutes)
- Manual refresh capability
- Target monitoring and alerts

**Polling Strategy:**

```
┌─────────────────────────────────────────────────────────────┐
│                    Polling Strategy                          │
└─────────────────────────────────────────────────────────────┘

Instance Polling (15 seconds):
├── Poll all active instances
├── Update P&L data
├── Sync order status
├── Check profit/loss targets
└── Log target hits (alert service integration pending)

Market Data Polling (5 seconds):
├── Only when watchlist page is active
├── Fetch quotes for all watchlist symbols
├── Update market_data table
├── Stop when watchlist page is inactive
└── Single market data instance (primary > secondary)

Health Check Polling (5 minutes):
├── Check all instances (including inactive)
├── Ping OpenAlgo endpoint
├── Update health_status
└── Log results
```

**Key Methods:**
```javascript
// Start polling
await pollingService.start();

// Stop polling
pollingService.stop();

// Manual refresh
await pollingService.refreshInstance(instanceId);

// Start market data polling
await pollingService.startMarketDataPolling(watchlistId);

// Stop market data polling
pollingService.stopMarketDataPolling();

// Get status
const status = pollingService.getStatus();
```

---

### 6. Symbol Validation Service

**Location**: `/backend/src/services/symbol-validation.service.js`

**Responsibilities:**
- Symbol search with caching
- Symbol validation using OpenAlgo /symbol endpoint
- Symbol classification (EQ, FUT, OPT, etc.)
- Cache management (symbol_search_cache table)
- Instance selection for symbol operations

**Key Methods:**
```javascript
// Search symbols
await symbolValidationService.searchSymbols('RELIANCE', instanceId);

// Validate symbol
await symbolValidationService.validateSymbol('RELIANCE', 'NSE', instanceId);
// Returns: Symbol metadata with from_cache flag
```

---

## Polling & Real-time Updates

### Overview

The polling service provides real-time data updates without WebSocket overhead. It implements a **smart polling strategy** that balances freshness with API rate limits.

### Polling Intervals

| Polling Type | Interval | Condition | Data Updated |
|--------------|----------|-----------|--------------|
| **Instance Polling** | 15 seconds | Always active | P&L, orders, targets |
| **Market Data Polling** | 5 seconds | Watchlist page active | Symbol quotes (LTP, OHLC) |
| **Health Checks** | 5 minutes | Always active | Instance connectivity |

### Instance Polling Flow

```
Every 15 seconds:
┌─────────────────────────────────────────────────────────────┐
│  1. Get all active instances                                 │
│  2. For each instance (parallel):                            │
│     ├── Update P&L:                                          │
│     │   ├── Fetch funds                                      │
│     │   ├── Fetch positions                                  │
│     │   ├── Calculate unrealized P&L                         │
│     │   └── Update instance.total_pnl                        │
│     ├── Sync orders:                                         │
│     │   ├── Fetch orderbook                                  │
│     │   ├── Match with local orders                          │
│     │   └── Update order status                              │
│     └── Check targets:                                       │
│         ├── Compare total_pnl with target_profit/target_loss │
│         └── Log alert if target hit (future: trigger action) │
│  3. Log results (successful, failed, duration)               │
└─────────────────────────────────────────────────────────────┘
```

### Market Data Polling Flow

```
Every 5 seconds (when active):
┌─────────────────────────────────────────────────────────────┐
│  1. Check if watchlist page is active                        │
│  2. Get watchlist symbols (is_enabled = 1)                   │
│  3. Get market data instance (primary > secondary)           │
│  4. Group symbols by exchange                                │
│  5. For each exchange:                                       │
│     ├── Fetch quotes (batch request)                         │
│     ├── Parse quote data (ltp, open, high, low, close)       │
│     ├── Calculate change_percent                             │
│     └── Upsert into market_data table                        │
│  6. Log results (symbols updated, duration)                  │
└─────────────────────────────────────────────────────────────┘

Market Data Instance Selection:
├── Query instances with market_data_role
├── Priority: primary > secondary > none
├── Use first available instance
└── Fallback: Use any active instance
```

### Market Data Activation

**Frontend Control:**
```javascript
// When user opens watchlist page
POST /api/v1/polling/market-data/start
Body: { "watchlistId": 1 }

// When user closes watchlist page
POST /api/v1/polling/market-data/stop
```

**Behavior:**
- Market data polling starts only when explicitly requested
- Stops automatically when watchlist page is closed
- Prevents unnecessary API calls when data is not being viewed
- Reduces load on OpenAlgo instances

### Performance Considerations

1. **Parallel Processing**: Instances polled in parallel using `Promise.allSettled`
2. **Error Isolation**: One instance failure doesn't affect others
3. **Graceful Degradation**: Failed polls logged but don't crash service
4. **Rate Limiting**: Respects OpenAlgo rate limits (configurable)
5. **Caching**: Market data cached in database for instant frontend access

---

## Authentication & Security

### Authentication Methods

#### 1. Google OAuth 2.0 (Production)

**Flow:**
```
1. User clicks "Login with Google"
   ↓
2. Redirect to /auth/google
   ↓
3. Passport.js initiates OAuth flow
   ↓
4. User authenticates with Google
   ↓
5. Google redirects to /auth/google/callback
   ↓
6. Passport.js verifies OAuth token
   ↓
7. Create/update user in database
   ↓
8. Create session cookie
   ↓
9. Redirect to /dashboard
```

**Configuration:**
```bash
# .env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
```

#### 2. Test Mode (Development)

**Flow:**
```
When TEST_MODE=true:
├── All API routes bypass authentication
├── req.user = { id: 1, email: 'test@simplifyed.in', is_admin: 1 }
└── No Google OAuth required
```

**Configuration:**
```bash
# .env
TEST_MODE=true
TEST_USER_EMAIL=test@simplifyed.in
```

### Session Management

- **Storage**: Express-session with SQLite store (future)
- **Cookie**: HTTP-only, Secure (in production), SameSite: Lax
- **Max Age**: 7 days
- **Secret**: Configurable via `SESSION_SECRET` environment variable

### Security Headers (Helmet)

```javascript
app.use(helmet({
  contentSecurityPolicy: false  // Disabled for development
}));
```

**Headers Applied:**
- X-DNS-Prefetch-Control
- X-Frame-Options: SAMEORIGIN
- X-Content-Type-Options: nosniff
- X-XSS-Protection: 1; mode=block

### CORS Configuration

```javascript
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
```

### Input Sanitization

**Location**: `/backend/src/utils/sanitizers.js`

**Sanitizers:**
- `sanitizeString(str)`: Remove SQL injection characters
- `parseFloatSafe(value, defaultValue)`: Safe float parsing
- `parseIntSafe(value, defaultValue)`: Safe integer parsing
- `maskApiKey(apiKey)`: Mask API keys for logging (show first 4, last 4)

### API Key Storage

- **Storage**: Encrypted at rest (future enhancement)
- **Transmission**: HTTPS only in production
- **Logging**: Masked API keys in logs
- **Access**: Service layer only (not exposed in API responses)

---

## Configuration

### Environment Variables

**Location**: `/backend/.env`

**Required Variables:**
```bash
# Server
NODE_ENV=development
PORT=3000
BASE_URL=http://localhost:3000

# Database
DATABASE_PATH=./database/simplifyed.db

# Session
SESSION_SECRET=your-secure-secret-here

# Google OAuth (optional, for production)
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# Test Mode (development)
TEST_MODE=true
TEST_USER_EMAIL=test@simplifyed.in

# CORS
CORS_ORIGIN=http://localhost:3000

# Polling Intervals
INSTANCE_POLL_INTERVAL_MS=15000
MARKET_DATA_POLL_INTERVAL_MS=5000

# OpenAlgo
OPENALGO_REQUEST_TIMEOUT_MS=15000
OPENALGO_MAX_RETRIES=3
OPENALGO_RETRY_DELAY_MS=1000

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/app.log

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Proxy (optional)
https_proxy=http://proxy.company.com:8080
PROXY_TLS_REJECT_UNAUTHORIZED=false
```

### Configuration Loading

```javascript
// src/core/config.js
import { config as loadEnv } from 'dotenv';
loadEnv({ path: join(__dirname, '../../.env') });

export const config = {
  env: getEnv('NODE_ENV', 'development'),
  port: getEnvInt('PORT', 3000),
  // ... other config
};
```

### Configuration Access

```javascript
import { config } from './src/core/config.js';

console.log('Server port:', config.port);
console.log('Polling interval:', config.polling.instanceInterval);
```

---

## Error Handling

### Error Hierarchy

```
Error (base)
├── ValidationError (400)
│   └── Invalid input data
├── NotFoundError (404)
│   └── Resource not found
├── ConflictError (409)
│   └── Duplicate resource
├── OpenAlgoError (502)
│   └── OpenAlgo API errors
└── InternalError (500)
    └── Server errors
```

### Custom Error Classes

**Location**: `/backend/src/core/errors.js`

```javascript
// Validation error
throw new ValidationError('Instance name is required');

// Not found error
throw new NotFoundError('Instance not found', { instance_id: 123 });

// Conflict error
throw new ConflictError('Instance with this host_url already exists');

// OpenAlgo error
throw new OpenAlgoError('Order placement failed', 'placeorder', 400);
```

### Global Error Handler

**Location**: `/backend/src/middleware/error-handler.js`

**Flow:**
```
1. Error thrown in route/service
   ↓
2. Express catches error
   ↓
3. Global error handler middleware
   ↓
4. Determine error type and status code
   ↓
5. Log error (with stack trace in development)
   ↓
6. Send JSON response:
   {
     "status": "error",
     "message": "Human-readable message",
     "error": "ERROR_CODE",
     "details": { ... }  // Optional
   }
```

### Error Response Format

```json
{
  "status": "error",
  "message": "Instance not found",
  "error": "NOT_FOUND",
  "details": {
    "instance_id": 123
  }
}
```

### Logging Errors

```javascript
import { log } from './src/core/logger.js';

try {
  // Operation
} catch (error) {
  log.error('Operation failed', error, { context: 'data' });
  throw error;
}
```

---

## Development Workflow

### Setup

```bash
# Clone repository
git clone https://github.com/your-repo/simplifyed-admin-v2.git
cd simplifyed-admin-v2/backend

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
npm run migrate

# Start development server (with watch mode)
npm run dev
```

### Common Commands

```bash
# Development
npm run dev                # Start with watch mode
npm start                  # Start production server

# Database
npm run migrate            # Run migrations
npm run migrate:rollback   # Rollback last migration

# Testing
npm test                   # Run all tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run test:coverage     # With coverage report

# Code Quality
npm run lint              # ESLint
npm run format            # Prettier
```

### Database Migrations

**Run Migration:**
```bash
npm run migrate
# or
node migrations/migrate.js
```

**Rollback Migration:**
```bash
npm run migrate:rollback
# or
node migrations/migrate.js rollback
```

**Check Migration Status:**
```bash
node migrations/migrate.js status
```

### Creating New Migrations

```javascript
// migrations/007_add_new_feature.js

export const version = '007';
export const name = 'add_new_feature';

export async function up(db) {
  await db.run(`
    ALTER TABLE instances ADD COLUMN new_field TEXT
  `);
  console.log('  ✅ Added new_field to instances');
}

export async function down(db) {
  await db.run(`
    ALTER TABLE instances DROP COLUMN new_field
  `);
  console.log('  ✅ Removed new_field from instances');
}
```

### Testing Strategy

**Unit Tests** (pending implementation):
- Services: Test business logic in isolation
- Integrations: Mock OpenAlgo HTTP client
- Utils: Test sanitizers and helpers

**Integration Tests** (pending implementation):
- Routes: Test API endpoints with supertest
- Database: Test with in-memory SQLite

**E2E Tests** (implemented):
- Playwright: Watchlist flicker test (e2e/watchlist-flicker.spec.js)

### Debugging

**Enable Debug Logging:**
```bash
LOG_LEVEL=debug npm run dev
```

**Enable OpenAlgo Request Logging:**
```javascript
// src/integrations/openalgo/client.js
log.openalgo(method, endpoint, duration, success);
```

**Database Queries:**
```javascript
// src/core/database.js
log.debug('SQL Query', { query, params });
```

### Deployment

**Production Checklist:**
- [ ] Set `NODE_ENV=production`
- [ ] Configure `SESSION_SECRET` (strong random value)
- [ ] Set up Google OAuth credentials
- [ ] Disable `TEST_MODE`
- [ ] Configure `DATABASE_PATH` (persistent storage)
- [ ] Set `LOG_LEVEL=info` or `warn`
- [ ] Enable HTTPS
- [ ] Set up proxy (if behind corporate firewall)
- [ ] Configure CORS origin
- [ ] Set up monitoring and alerting

**Environment Variables (Production):**
```bash
NODE_ENV=production
PORT=3000
DATABASE_PATH=/var/lib/simplifyed/simplifyed.db
SESSION_SECRET=your-strong-random-secret
GOOGLE_CLIENT_ID=production-client-id
GOOGLE_CLIENT_SECRET=production-client-secret
GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback
CORS_ORIGIN=https://yourdomain.com
LOG_LEVEL=info
LOG_FILE=/var/log/simplifyed/app.log
```

---

## Appendix: Quick Reference

### API Endpoint Summary

| Category | Method | Endpoint | Description |
|----------|--------|----------|-------------|
| **Health** | GET | `/api/v1/health` | Health check |
| **Instances** | GET | `/api/v1/instances` | List instances |
| | POST | `/api/v1/instances` | Create instance |
| | GET | `/api/v1/instances/:id` | Get instance |
| | PUT | `/api/v1/instances/:id` | Update instance |
| | DELETE | `/api/v1/instances/:id` | Delete instance |
| | POST | `/api/v1/instances/test/connection` | Test connection |
| | POST | `/api/v1/instances/:id/refresh` | Manual refresh |
| | POST | `/api/v1/instances/:id/analyzer/toggle` | Toggle analyzer |
| **Watchlists** | GET | `/api/v1/watchlists` | List watchlists |
| | POST | `/api/v1/watchlists` | Create watchlist |
| | GET | `/api/v1/watchlists/:id` | Get watchlist |
| | POST | `/api/v1/watchlists/:id/symbols` | Add symbol |
| | POST | `/api/v1/watchlists/:id/instances` | Assign instance |
| **Orders** | GET | `/api/v1/orders` | List orders |
| | POST | `/api/v1/orders` | Place order |
| | POST | `/api/v1/orders/batch` | Place multiple |
| | POST | `/api/v1/orders/:id/cancel` | Cancel order |
| | POST | `/api/v1/orders/cancel-all` | Cancel all |
| **Positions** | GET | `/api/v1/positions/:instanceId` | Get positions |
| | GET | `/api/v1/positions/aggregate/pnl` | Aggregate P&L |
| | POST | `/api/v1/positions/:instanceId/close` | Close positions |
| **Symbols** | GET | `/api/v1/symbols/search` | Search symbols |
| | POST | `/api/v1/symbols/validate` | Validate symbol |
| | POST | `/api/v1/symbols/quotes` | Get quotes |
| **Polling** | GET | `/api/v1/polling/status` | Polling status |
| | POST | `/api/v1/polling/market-data/start` | Start market data |
| | POST | `/api/v1/polling/market-data/stop` | Stop market data |

### OpenAlgo Endpoint Categories

| Category | Endpoints Count | Key Endpoints |
|----------|----------------|---------------|
| Account | 7 | ping, funds, holdings, analyzer |
| Orders | 9 | placeorder, placesmartorder, cancelorder, orderbook |
| Positions | 3 | positionbook, openposition, closeposition |
| Trades | 1 | tradebook |
| Market Data | 3 | quotes, depth, search |
| Options | 3 | expiry, strikes, optionchain |
| Historical | 2 | intervals, history |
| Margin | 2 | margin, basketmargin |
| Contract Info | 4 | contractinfo, symbolmaster, indexlist |
| GTT | 3 | placegtt, gttorders, cancelgtt |
| SIP | 3 | placesip, siporders, cancelsip |

### Database Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| users | User accounts | id, email, is_admin |
| instances | OpenAlgo instances | id, name, host_url, api_key, total_pnl |
| watchlists | Watchlist definitions | id, name, description |
| watchlist_symbols | Symbols in watchlists | id, watchlist_id, exchange, symbol |
| watchlist_instances | Watchlist-instance mapping | watchlist_id, instance_id |
| watchlist_orders | Order tracking | id, instance_id, symbol, status, order_id |
| watchlist_positions | Position tracking | id, instance_id, symbol, quantity, pnl |
| market_data | Cached quotes | exchange, symbol, ltp, ohlc, volume |
| system_alerts | System alerts | id, type, severity, message |
| symbol_search_cache | Symbol search cache | query, symbol, exchange, metadata |
| websocket_sessions | WebSocket tracking | id, instance_id, status |

---

## Document Version History

- **v1.0.0** (2025-11-12): Initial comprehensive documentation
  - Architecture overview
  - Complete API reference
  - OpenAlgo integration details
  - Services documentation
  - Database schema
  - Polling strategy
  - Development workflow

---

**End of Document**

For questions or contributions, please refer to the project README.md or submit an issue on GitHub.
