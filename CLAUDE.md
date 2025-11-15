# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🎯 Project Overview

Simplifyed Admin V2 is a Node.js/Express backend for a trading dashboard that manages multiple OpenAlgo trading instances. The backend is **fully functional** with 40+ OpenAlgo API endpoints, smart polling (15s for instances, 5s for market data), P&L calculations, and Google OAuth authentication.

## 🏗️ Architecture

The project uses a clean layered architecture:

1. **Core Infrastructure** (`src/core/`): Configuration, logging (Winston), database wrapper (SQLite), and custom errors
2. **Integrations** (`src/integrations/openalgo/`): HTTP client with retry logic for all OpenAlgo API endpoints
3. **Services** (`src/services/`): Business logic for instances, watchlists, orders, positions, P&L calculations, and polling orchestration
4. **Routes** (`src/routes/v1/`): REST API endpoints organized by resource
5. **Middleware** (`src/middleware/`): Authentication (Google OAuth + test mode), error handling, request logging

## 🚀 Common Commands

```bash
# Install dependencies
npm install

# Run database migrations
npm run migrate

# Start development server (with watch mode)
npm run dev

# Start production server
npm start

# Run tests
npm test                    # All tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:coverage      # With coverage report

# Code quality
npm run lint               # ESLint
npm run format             # Prettier

# Migration management
npm run migrate:rollback   # Rollback last migration
```

**Environment Setup:**
```bash
cd backend
cp .env.example .env
# Edit .env with your configuration
```

## 📂 Key Files & Components

- **server.js**: Express application entry point with middleware setup and route registration
- **migrations/**: Database migrations (currently 9+ migrations creating instruments cache with FTS5)
- **src/integrations/openalgo/client.js**: HTTP client with retry logic for OpenAlgo API (40+ endpoints)
- **src/services/**: Business logic services handling all trading operations
  - `instance.service.js`: Instance CRUD and health checks
  - `watchlist.service.js`: Watchlist management (720+ lines)
  - `order.service.js`: Order placement using placesmartorder
  - `pnl.service.js`: P&L calculations
  - `polling.service.js`: Smart polling orchestration
  - `instruments.service.js`: **NEW** - Broker instruments cache with daily refresh and SQLite FTS5 search
- **src/routes/v1/**: REST API endpoints for frontend integration
- **src/middleware/instruments-refresh.middleware.js**: **NEW** - Automatic daily refresh on first login
- **migrations/migrate.js**: Migration runner with up/down/status commands

## 🔌 API Endpoints

All endpoints are prefixed with `/api/v1`:

- `/instances` - Instance CRUD, health checks
- `/watchlists` - Watchlist management and symbol assignment
- `/orders` - Order placement and tracking
- `/positions` - Position queries and updates
- `/symbols` - Symbol search and validation (with intelligent caching)
- `/instruments` - Broker instruments cache management, fast search, option chains
- `/polling` - Manual refresh and polling control

## 🔄 Smart Polling Strategy

The system uses two polling intervals:
- **Instance Polling** (15 seconds): P&L data, account balance, order status, health checks
- **Market Data Polling** (5 seconds): Only when watchlist page is active, stops when inactive

## 🎯 Instruments Cache (NEW)

**High-performance symbol search with automatic daily refresh**

### Overview
The app maintains a local cache of all broker instruments (typically 50K-500K symbols) to provide:
- **Instant symbol search** using SQLite FTS5 full-text search (no API calls)
- **Fast option chain building** from cached data
- **Automatic daily refresh** on first user login each day
- **Intelligent fallback** to OpenAlgo API if cache is empty

### Key Features
1. **Daily Auto-Refresh**: Middleware checks on first authenticated request each day
2. **SQLite FTS5 Search**: Full-text search across symbol names with sub-50ms response times
3. **Option Chain Builder**: Instant option chain construction from cached strikes
4. **Smart Fallback**: Symbol search automatically falls back to API if cache is unavailable
5. **Background Refresh**: Refresh runs asynchronously without blocking user requests

### Database Tables
- `instruments`: Stores all broker instruments (symbol, exchange, token, lotsize, etc.)
- `instruments_refresh_log`: Tracks refresh history and status
- `instruments_fts`: SQLite FTS5 virtual table for full-text search (auto-synced via triggers)

### API Endpoints
- `GET /api/v1/instruments/search` - Fast cached symbol search
- `GET /api/v1/instruments/option-chain` - Build option chain for symbol/expiry
- `GET /api/v1/instruments/expiries` - Get available expiries for a symbol
- `GET /api/v1/instruments/stats` - Cache statistics and status
- `POST /api/v1/instruments/refresh` - Manually trigger refresh
- `GET /api/v1/instruments/needs-refresh` - Check if refresh is needed
- `GET /api/v1/instruments/:exchange/:symbol` - Get specific instrument

### Usage Example
```javascript
// Symbol search - uses cache first, falls back to API
GET /api/v1/symbols/search?query=NIFTY
// Returns instantly from cache with ~50ms response time

// Option chain - built from cache
GET /api/v1/instruments/option-chain?symbol=NIFTY&expiry=2024-01-25
// Returns complete CE/PE option chain instantly

// Manual refresh (admin only recommended)
POST /api/v1/instruments/refresh
// Returns 202 Accepted for long-running refresh
```

### Performance Benefits
- **Symbol Search**: Reduced from ~500ms (API call) to ~50ms (cache lookup)
- **API Call Reduction**: 95%+ reduction in symbol search API calls
- **Option Chains**: Instant building vs multiple API calls
- **Network Independence**: Works offline once cache is populated

## 🗄️ Database

SQLite with WAL mode enabled:
- **Path**: `./database/simplifyed.db` (configurable via `DATABASE_PATH`)
- **Migrations**: Located in `/migrations/` directory
- **Core Tables**: `instances`, `watchlists`, `watchlist_symbols`, `watchlist_orders`, `watchlist_positions`, `users`, `instruments` (NEW), `instruments_refresh_log` (NEW), plus FTS5 virtual tables
- **Full-Text Search**: SQLite FTS5 for instruments search (auto-synced via triggers)

## 🔐 Authentication

- **Google OAuth 2.0**: Production authentication via `/auth/google`
- **Test Mode**: Development mode enabled via `TEST_MODE=true` for bypassing OAuth
- **Session-based**: Express-session with Passport.js

## 🔌 OpenAlgo Integration

Complete integration with 40+ OpenAlgo endpoints including:
- **Market data**: ping, analyzer, positionbook, orderbook, tradebook, **instruments** (NEW)
- **Trading**: placeorder (uses placesmartorder), cancelorder, cancelallorder, closeposition
- **Account**: funds, holdings
- **Symbols**: search, symbol, quotes, depth, expiry, optionchain
- Request timeout: 15s, Max retries: 3, Retry delay: 1s

## 🧪 Testing

Test framework is set up (Node.js built-in test runner) but tests are **pending implementation**:
- Unit tests: `tests/unit/` (services, integrations, utils)
- Integration tests: `tests/integration/` (API routes, database)
- Test script for instance CRUD: `test-instance-crud.js` (can be run directly with `node test-instance-crud.js`)

## 📝 Development Notes

- **Node Version**: Requires Node.js >= 18.0.0
- **ES Modules**: Uses `type: "module"` throughout
- **Logging**: Winston with structured JSON logs (configurable log level)
- **Error Handling**: Custom error classes in `src/core/errors.js`
- **Input Validation**: Joi for request validation, sanitizers in `src/utils/sanitizers.js`
- **Security**: Helmet, CORS, compression configured in server.js

## ⚙️ Configuration

Key environment variables (see `.env.example`):
- `NODE_ENV`: development/production
- `PORT`: Server port (default: 3000)
- `DATABASE_PATH`: SQLite database file path
- `SESSION_SECRET`: Secure session secret
- `GOOGLE_CLIENT_ID/SECRET`: OAuth credentials
- `TEST_MODE`: Enable test authentication
- `INSTANCE_POLL_INTERVAL_MS`: 15000 (default)
- `MARKET_DATA_POLL_INTERVAL_MS`: 5000 (default)
- `OPENALGO_REQUEST_TIMEOUT_MS`: 15000 (default)
- `LOG_LEVEL`: info (default)

## 🎯 Current Status

**Backend Status**: ✅ Complete and functional
- All core infrastructure implemented
- All OpenAlgo endpoints integrated
- Smart polling system active
- REST API with comprehensive error handling
- Authentication system working
- Database migrations complete

**Frontend Status**: ⏳ Pending implementation
- Backend serves static files from `/public/` directory
- Frontend application needs to be built

## 📖 Additional Documentation

- **README.md**: Comprehensive architecture documentation, database schema, progress tracker
- **Requirements/OpenAlgo_v1_Developer_Reference_Clean.md**: OpenAlgo API reference (155KB)
- **Requirements/Simplifyed_Watchlist_Enhancement_Spec_v1.1.md**: Watchlist feature specifications
- **Requirements/openalgo-symbol-classification.md**: Symbol classification details
