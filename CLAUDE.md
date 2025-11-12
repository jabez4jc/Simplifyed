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
- **migrations/**: Database migrations (currently 6 migrations creating 11 tables with 40+ indexes)
- **src/integrations/openalgo/client.js**: HTTP client with retry logic for OpenAlgo API (566 lines)
- **src/services/**: Business logic services handling all trading operations
  - `instance.service.js`: Instance CRUD and health checks (507 lines)
  - `watchlist.service.js`: Watchlist management (720+ lines)
  - `order.service.js`: Order placement using placesmartorder (460+ lines)
  - `pnl.service.js`: P&L calculations (460+ lines)
  - `polling.service.js`: Smart polling orchestration (380+ lines)
- **src/routes/v1/**: REST API endpoints for frontend integration
- **migrations/migrate.js**: Migration runner with up/down/status commands

## 🔌 API Endpoints

All endpoints are prefixed with `/api/v1`:

- `/instances` - Instance CRUD, health checks
- `/watchlists` - Watchlist management and symbol assignment
- `/orders` - Order placement and tracking
- `/positions` - Position queries and updates
- `/symbols` - Symbol search and validation
- `/polling` - Manual refresh and polling control

## 🔄 Smart Polling Strategy

The system uses two polling intervals:
- **Instance Polling** (15 seconds): P&L data, account balance, order status, health checks
- **Market Data Polling** (5 seconds): Only when watchlist page is active, stops when inactive

## 🗄️ Database

SQLite with WAL mode enabled:
- **Path**: `./database/simplifyed.db` (configurable via `DATABASE_PATH`)
- **Migrations**: Located in `/migrations/` directory
- **Core Tables**: `instances`, `watchlists`, `watchlist_symbols`, `watchlist_orders`, `watchlist_positions`, `users`, plus role-based access tables

## 🔐 Authentication

- **Google OAuth 2.0**: Production authentication via `/auth/google`
- **Test Mode**: Development mode enabled via `TEST_MODE=true` for bypassing OAuth
- **Session-based**: Express-session with Passport.js

## 🔌 OpenAlgo Integration

Complete integration with 40+ OpenAlgo endpoints including:
- Market data: ping, analyzer, positionbook, orderbook, tradebook
- Trading: placeorder (uses placesmartorder), cancelorder, cancelallorder, closeposition
- Account: funds, holdings
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
