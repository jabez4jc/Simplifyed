# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🎯 Project Overview

Simplifyed Admin V2 is a Node.js/Express backend for a trading dashboard that manages multiple OpenAlgo trading instances. The backend is **fully functional** with 40+ OpenAlgo API endpoints, smart polling (15s for instances, 5s for market data), P&L calculations, and Google OAuth authentication.

## 🏗️ Architecture

The project uses a clean layered architecture:

### Backend (Node.js/Express)
1. **Core Infrastructure** (`src/core/`): Configuration, logging (Winston), database wrapper (SQLite), and custom errors
2. **Integrations** (`src/integrations/openalgo/`): HTTP client with retry logic for all OpenAlgo API endpoints
3. **Services** (`src/services/`): Business logic for instances, watchlists, orders, positions, P&L calculations, polling orchestration, and instruments cache
4. **Routes** (`src/routes/v1/`): REST API endpoints organized by resource
5. **Middleware** (`src/middleware/`): Authentication, error handling, request logging, instruments auto-refresh

### Frontend (Vanilla JavaScript)
- **Dashboard** (`public/js/dashboard.js`): Main application with view management and polling
- **Quick Order** (`public/js/quick-order.js`): Inline trading controls in watchlists
- **Settings** (`public/js/settings.js`): Application configuration management
- **API Client** (`public/js/api-client.js`): HTTP client for backend communication
- **Utils** (`public/js/utils.js`): Utility functions for formatting, validation, UI helpers
- **Polling Strategy**: View-specific polling (watchlists: 10s, positions: 10s, others: 15s auto-refresh skipped for watchlists to prevent flickering)

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

### Backend
- **server.js**: Express application entry point with middleware setup and route registration
- **migrations/**: Database migrations (9+ migrations including instruments cache with FTS5)
- **migrations/migrate.js**: Migration runner with up/down/status commands
- **src/integrations/openalgo/client.js**: HTTP client with retry logic for OpenAlgo API (40+ endpoints)
- **src/services/**: Business logic services
  - `instance.service.js`: Instance CRUD and health checks
  - `watchlist.service.js`: Watchlist management
  - `order.service.js`: Order placement using placesmartorder
  - `pnl.service.js`: P&L calculations
  - `polling.service.js`: Smart polling orchestration
  - `instruments.service.js`: Broker instruments cache with daily refresh and SQLite FTS5 search
- **src/routes/v1/**: REST API endpoints for frontend integration
- **src/middleware/**: Authentication, error handling, request logging, instruments auto-refresh

### Frontend
- **public/dashboard.html**: Main HTML structure with sidebar navigation and tabbed interface
- **public/js/dashboard.js**: Main application (2000+ lines) - view management, polling, watchlist rendering
- **public/js/quick-order.js**: Inline trading controls, expandable row UI for watchlists
- **public/js/settings.js**: Settings management and configuration UI
- **public/js/api-client.js**: HTTP client for backend API communication
- **public/js/utils.js**: Utility functions for formatting, validation, UI helpers (toasts, modals)
- **public/css/styles.css**: Complete design system with trading-specific colors and components

### Testing
- **e2e/watchlist-flicker.spec.js**: Playwright E2E tests for watchlist polling (verifies fix for flickering)
- **playwright.config.js**: Playwright configuration with 60s webServer timeout
- **test-instance-crud.js**: Standalone test script for instance CRUD operations

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

### High-performance symbol search with automatic daily refresh

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

### Production Mode
- **Google OAuth 2.0**: Production authentication via `/auth/google`
- **Session-based**: Express-session with Passport.js

### Test Mode (Development)
Test mode allows development without Google OAuth configuration by automatically setting a test user.

**Enabling Test Mode:**
Test mode is automatically enabled when Google OAuth is **not configured** (i.e., `GOOGLE_CLIENT_ID` is missing from environment). Alternatively, can be explicitly enabled via `TEST_MODE=true` environment variable.

**Configuration:**
```bash
# In .env file
TEST_MODE=true
TEST_USER_EMAIL=test@simplifyed.in
```

**Test Mode Behavior:**
- All requests use test user: `test@simplifyed.in` (ID: 1, admin)
- Skips instruments refresh (no broker connection needed in test mode)
- API calls return empty/mock data where appropriate
- All authentication middleware checks bypassed
- Server starts successfully without OAuth credentials

**Implementation Details:**
- **Detection**: Uses `config.testMode.enabled` consistently across all components
- **Middleware**: `src/middleware/instruments-refresh.middleware.js` - Skips instruments refresh
- **Service**: `src/services/instruments.service.js` - Returns early with skipped status
- **Client**: `src/integrations/openalgo/client.js` - Enhanced error handling for test instances

**Note:** Test mode is intended for development only. Production deployments must configure Google OAuth.

## 🔌 OpenAlgo Integration

Complete integration with 40+ OpenAlgo endpoints including:
- **Market data**: ping, analyzer, positionbook, orderbook, tradebook, **instruments** (NEW)
- **Trading**: placeorder (uses placesmartorder), cancelorder, cancelallorder, closeposition
- **Account**: funds, holdings
- **Symbols**: search, symbol, quotes, depth, expiry, optionchain
- Request timeout: 15s, Max retries: 3, Retry delay: 1s

## 🎯 Watchlist Flickering Fix

### Problem
The watchlist view experienced flickering due to **conflicting polling mechanisms**:
- Auto-refresh (15s) re-rendered entire watchlists view
- Watchlist polling (10s) independently updated DOM elements
- Race condition caused DOM elements to be destroyed while being updated

### Solution
**File**: `backend/public/js/dashboard.js`

**Fix 1**: Skip auto-refresh for watchlists view (lines 1570-1589)
```javascript
this.pollingInterval = setInterval(() => {
  if (this.currentView !== 'watchlists') {
    this.refreshCurrentView();
  }
}, 15000);
```

**Fix 2**: Add DOM existence check before quote updates (lines 612-625)
```javascript
const table = document.getElementById(`watchlist-table-${watchlistId}`);
if (!table) {
  console.log(`Watchlist table ${watchlistId} not found in DOM, skipping quote update`);
  return;
}
```

### Result
- ✅ Separated concerns: non-watchlist views use 15s auto-refresh, watchlists use dedicated 10s poller
- ✅ No more flickering in watchlist quotes
- ✅ Smooth, professional user experience
- ✅ Clean console logs

See `WATCHLIST_FLICKER_FIX.md` for detailed documentation.

## 🧪 Testing

### Backend Testing
Test framework is set up (Node.js built-in test runner) but tests are **pending implementation**:
- Unit tests: `tests/unit/` (services, integrations, utils)
- Integration tests: `tests/integration/` (API routes, database)
- Test script for instance CRUD: `test-instance-crud.js` (can be run directly with `node test-instance-crud.js`)

### Frontend Testing (Playwright)
Playwright is configured for E2E testing:
```bash
# Run Playwright tests
npx playwright test                    # All tests
npx playwright test --reporter=line    # Run with line reporter
npx playwright test --headed           # Run in headed mode
npx playwright show-report             # Show HTML report
```

**Key E2E Test**: `e2e/watchlist-flicker.spec.js`
- Tests the watchlist quotes flickering fix
- Monitors for 25 seconds to catch polling conflicts
- Verifies DOM stability and console errors
- Uses `#current-user-email` selector for reliable login detection
- Tests view transitions between different dashboard sections

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
- Smart polling system active (15s for instances, 10s for watchlists/positions)
- REST API with comprehensive error handling
- Authentication system working (Google OAuth + test mode)
- Database migrations complete with instruments cache (FTS5)
- Playwright E2E testing configured

**Frontend Status**: ✅ Complete and functional
- Vanilla JavaScript dashboard with view management
- Watchlist with real-time quote updates (10s polling, no flickering)
- Inline quick-order trading interface
- Settings management
- Tabbed interface for positions and orders
- No flickering - polling conflicts resolved
- Static files served from `/public/` directory

## 📖 Additional Documentation

- **README.md**: Comprehensive architecture documentation, database schema, progress tracker
- **WATCHLIST_FLICKER_FIX.md**: Detailed documentation of the watchlist quotes flickering fix
- **Requirements/OpenAlgo_v1_Developer_Reference_Clean.md**: OpenAlgo API reference (155KB)
- **Requirements/Simplifyed_Watchlist_Enhancement_Spec_v1.1.md**: Watchlist feature specifications
- **Requirements/openalgo-symbol-classification.md**: Symbol classification details
