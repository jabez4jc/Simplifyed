/**
 * Simplifyed Admin V2 - Dashboard Application
 * Main application logic
 */

class DashboardApp {
  constructor() {
    this.defaultView = 'dashboard';
    this.currentView = null;
    this.currentUser = null;
    this.instances = [];
    this.watchlists = [];
    this.pollingInterval = null;
    // Track watchlist quote polling intervals
    this.watchlistPollers = new Map();
    // Track positions polling interval (10 seconds)
    this.positionsPollingInterval = null;
    // Cache for quote data to prevent unnecessary DOM updates
    // Structure: { watchlistId_symbolId: { ltp, changePercent, volume } }
    this.quoteCache = new Map();
    // Shared LTP cache (exchange|symbol -> { ltp, ts })
    this.latestLtpByKey = new Map();
    this.ltpCacheTtlMs = 10000;
    // Track latest quote snapshot timestamp per watchlist
    this.watchlistQuoteSnapshots = new Map();
    this.isSidebarCollapsed = false;
    this.quickOrder = window.quickOrder || null;
    this.validViews = ['dashboard', 'instances', 'watchlists', 'orders', 'trades', 'positions', 'settings', 'notifications', 'api-playground'];
    this.suppressHashChange = false;
    this._throttledWatchlistRefresh = Utils.throttle((opts = {}) => {
      this.refreshWatchlistPositions(opts);
    }, 2000);
    this.watchlistPositionsExpanded = new Set();
    this.latestWatchlistPositionsData = null;
    this.currentOrderFilter = '';
    this.instanceSearchQuery = '';
    this.autoExitModes = [
      { key: 'direct', label: 'Direct Trading' },
      { key: 'futures', label: 'Futures Trading' },
      { key: 'options', label: 'Options Trading' },
    ];
    this.symbolConfigContext = null;
    this.tradesPollingInterval = null;
    this.tradesLastUpdatedAt = null;
    this.tradesPayload = null;
    this.tradesInstanceStore = new Map();
    this.positionsInstanceStore = new Map();
    // Track expanded instances in positions view; default is collapsed
    this.positionsExpanded = new Set();
    this.expandedWatchlists = new Set();
    this.isPaused = false; // default running; user can pause manually
    // Telemetry auto-refresh
    this.telemetryInterval = null;
    this.lastTelemetry = { circuits: 0, stale: 0 };
    // Snapshot auto-resync
    this.snapshotResyncInterval = null;
    this.lastSnapshotResyncAt = 0;
    this.isSnapshotResyncing = false;
    this.autoSnapshotResyncEnabled = this.loadSnapshotResyncPreference();
    // Symbol lookup for streaming updates
    this.watchlistSymbolIndex = new Map(); // exchange|symbol -> [{ watchlistId, symbolId }]
    this.watchlistSymbolIndexByWatchlist = new Map(); // watchlistId -> [{ key, symbolId }]
    // WebSocket streaming (optional)
    this.wsGatewayEnabled = false;
    this.wsGatewayPath = '/stream';
    this.wsTopics = ['quotes:update', 'positions:update', 'funds:update'];
    this.useWsGateway = this.loadWsPreference();
    this.ws = null;
    this.wsLastSeq = 0;
    this.wsReconnectDelay = 500;
    this.wsReconnectTimer = null;
    this.wsRefreshDashboard = Utils.debounce(() => this.renderDashboardView(), 1200);
    this.wsRefreshPositions = Utils.debounce(() => this.renderPositionsView(), 1200);
    this.wsRefreshWatchlists = Utils.debounce(() => this._throttledWatchlistRefresh({ showLoader: false }), 800);
    // Theme (light-only)
    this.theme = 'light';
    this.apiPlaygroundPresets = [
      // Root/health
      { label: 'GET /api/v1/health', method: 'GET', path: '/api/v1/health', headers: {}, description: 'Basic health probe for the service.' },
      { label: 'GET /api/v1/ready', method: 'GET', path: '/api/v1/ready', headers: {}, description: 'Readiness probe showing instruments refresh status.' },
      { label: 'GET /api/v1/public-config', method: 'GET', path: '/api/v1/public-config', headers: {}, description: 'Supabase public config for the UI.' },

      // Instances
      { label: 'GET /api/v1/instances', method: 'GET', path: '/api/v1/instances', headers: {}, description: 'List active instances with metadata and funds.' },
      { label: 'GET /api/v1/instances/admin/instances', method: 'GET', path: '/api/v1/instances/admin/instances', headers: {}, description: 'Admin-only list of all instances (including inactive).' },
      { label: 'GET /api/v1/instances/market-data/instance', method: 'GET', path: '/api/v1/instances/market-data/instance', headers: {}, description: 'Resolve the preferred instance for market data.' },
      { label: 'GET /api/v1/instances/market-data/all', method: 'GET', path: '/api/v1/instances/market-data/all', headers: {}, description: 'List all market-data-capable instances.' },
      { label: 'GET /api/v1/instances/:id', method: 'GET', path: '/api/v1/instances/1', headers: {}, description: 'Get a specific instance by ID.' },
      { label: 'POST /api/v1/instances', method: 'POST', path: '/api/v1/instances', headers: { 'Content-Type': 'application/json' }, body: '{\n  "name": "Demo",\n  "broker": "openalgo",\n  "api_key": "XXXX",\n  "secret": "YYYY"\n}', description: 'Create a new instance.' },
      { label: 'PUT /api/v1/instances/:id', method: 'PUT', path: '/api/v1/instances/1', headers: { 'Content-Type': 'application/json' }, body: '{\n  "is_active": true\n}', description: 'Update instance configuration.' },
      { label: 'DELETE /api/v1/instances/:id', method: 'DELETE', path: '/api/v1/instances/1', headers: {}, description: 'Delete an instance.' },
      { label: 'POST /api/v1/instances/test/connection', method: 'POST', path: '/api/v1/instances/test/connection', headers: { 'Content-Type': 'application/json' }, body: '{\n  "api_key": "XXXX",\n  "secret": "YYYY"\n}', description: 'Test broker connection credentials.' },
      { label: 'POST /api/v1/instances/test/apikey', method: 'POST', path: '/api/v1/instances/test/apikey', headers: { 'Content-Type': 'application/json' }, body: '{\n  "api_key": "XXXX"\n}', description: 'Validate API key format/availability.' },
      { label: 'POST /api/v1/instances/bulk-update', method: 'POST', path: '/api/v1/instances/bulk-update', headers: { 'Content-Type': 'application/json' }, body: '{\n  "instanceIds": [1,2],\n  "is_active": true\n}', description: 'Bulk edit instances.' },
      { label: 'POST /api/v1/instances/:id/refresh', method: 'POST', path: '/api/v1/instances/1/refresh', headers: {}, description: 'Refresh tokens/metadata for an instance.' },
      { label: 'POST /api/v1/instances/:id/health', method: 'POST', path: '/api/v1/instances/1/health', headers: {}, description: 'Run on-demand health check for an instance.' },
      { label: 'GET /api/v1/instances/:id/circuit-breaker', method: 'GET', path: '/api/v1/instances/1/circuit-breaker', headers: {}, description: 'Inspect circuit breaker state for an instance.' },
      { label: 'POST /api/v1/instances/:id/pnl', method: 'POST', path: '/api/v1/instances/1/pnl', headers: {}, description: 'Fetch P&L snapshot for an instance.' },
      { label: 'POST /api/v1/instances/:id/analyzer/toggle', method: 'POST', path: '/api/v1/instances/1/analyzer/toggle', headers: {}, description: 'Toggle analyzer mode for an instance.' },
      { label: 'GET /api/v1/instances/export/csv', method: 'GET', path: '/api/v1/instances/export/csv', headers: {}, description: 'Export instances as CSV (admin).' },
      { label: 'POST /api/v1/instances/import/csv', method: 'POST', path: '/api/v1/instances/import/csv', headers: {}, description: 'Import instances from CSV (admin, multipart form-data).' },

      // Watchlists
      { label: 'GET /api/v1/watchlists', method: 'GET', path: '/api/v1/watchlists', headers: {}, description: 'List watchlists.' },
      { label: 'GET /api/v1/watchlists/:id', method: 'GET', path: '/api/v1/watchlists/1', headers: {}, description: 'Get watchlist detail.' },
      { label: 'POST /api/v1/watchlists', method: 'POST', path: '/api/v1/watchlists', headers: { 'Content-Type': 'application/json' }, body: '{\n  "name": "My WL",\n  "description": "test"\n}', description: 'Create watchlist.' },
      { label: 'PUT /api/v1/watchlists/:id', method: 'PUT', path: '/api/v1/watchlists/1', headers: { 'Content-Type': 'application/json' }, body: '{\n  "name": "Renamed WL"\n}', description: 'Update watchlist.' },
      { label: 'DELETE /api/v1/watchlists/:id', method: 'DELETE', path: '/api/v1/watchlists/1', headers: {}, description: 'Delete watchlist.' },
      { label: 'POST /api/v1/watchlists/:id/clone', method: 'POST', path: '/api/v1/watchlists/1/clone', headers: {}, description: 'Clone a watchlist.' },
      { label: 'GET /api/v1/watchlists/:id/symbols', method: 'GET', path: '/api/v1/watchlists/1/symbols', headers: {}, description: 'List symbols in a watchlist.' },
      { label: 'POST /api/v1/watchlists/:id/symbols', method: 'POST', path: '/api/v1/watchlists/1/symbols', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbol": "NIFTY",\n  "exchange": "NSE",\n  "tradable_options": 1\n}', description: 'Add symbol to watchlist.' },
      { label: 'PUT /api/v1/watchlists/:id/symbols/:symbolId', method: 'PUT', path: '/api/v1/watchlists/1/symbols/1', headers: { 'Content-Type': 'application/json' }, body: '{\n  "tradable_options": 1\n}', description: 'Update a watchlist symbol.' },
      { label: 'DELETE /api/v1/watchlists/:id/symbols/:symbolId', method: 'DELETE', path: '/api/v1/watchlists/1/symbols/1', headers: {}, description: 'Remove a symbol from watchlist.' },
      { label: 'POST /api/v1/watchlists/:id/instances', method: 'POST', path: '/api/v1/watchlists/1/instances', headers: { 'Content-Type': 'application/json' }, body: '{\n  "instance_ids": [1,2]\n}', description: 'Assign instances to watchlist.' },
      { label: 'DELETE /api/v1/watchlists/:id/instances/:instanceId', method: 'DELETE', path: '/api/v1/watchlists/1/instances/1', headers: {}, description: 'Unassign an instance from watchlist.' },
      { label: 'GET /api/v1/watchlists/export/csv', method: 'GET', path: '/api/v1/watchlists/export/csv', headers: {}, description: 'Export watchlists as CSV (admin).' },
      { label: 'POST /api/v1/watchlists/import/csv', method: 'POST', path: '/api/v1/watchlists/import/csv', headers: {}, description: 'Import watchlists CSV (admin, multipart form-data).' },

      // Orders
      { label: 'GET /api/v1/orders', method: 'GET', path: '/api/v1/orders?limit=20', headers: {}, description: 'List recent orders with filters.' },
      { label: 'GET /api/v1/orders/orderbook', method: 'GET', path: '/api/v1/orders/orderbook', headers: {}, description: 'Fetch consolidated orderbook snapshot.' },
      { label: 'GET /api/v1/orders/:id', method: 'GET', path: '/api/v1/orders/1', headers: {}, description: 'Get a single order by ID.' },
      { label: 'POST /api/v1/orders', method: 'POST', path: '/api/v1/orders', headers: { 'Content-Type': 'application/json' }, body: '{\n  "instanceId": 1,\n  "symbol": "NIFTY23DEC24000CE",\n  "action": "BUY",\n  "quantity": 50\n}', description: 'Place a single order (manual payload).' },
      { label: 'POST /api/v1/orders/batch', method: 'POST', path: '/api/v1/orders/batch', headers: { 'Content-Type': 'application/json' }, body: '{\n  "orders": []\n}', description: 'Place batch orders.' },
      { label: 'POST /api/v1/orders/:id/cancel', method: 'POST', path: '/api/v1/orders/1/cancel', headers: {}, description: 'Cancel a specific order.' },
      { label: 'POST /api/v1/orders/cancel-all', method: 'POST', path: '/api/v1/orders/cancel-all', headers: {}, description: 'Cancel all open orders across instances.' },
      { label: 'POST /api/v1/orders/sync/:instanceId', method: 'POST', path: '/api/v1/orders/sync/1', headers: {}, description: 'Force sync orderbook from broker for an instance.' },

      // Positions
      { label: 'GET /api/v1/positions/all', method: 'GET', path: '/api/v1/positions/all', headers: {}, description: 'Aggregated positions across instances.' },
      { label: 'GET /api/v1/positions/aggregate/pnl', method: 'GET', path: '/api/v1/positions/aggregate/pnl', headers: {}, description: 'Aggregate PnL across positions.' },
      { label: 'GET /api/v1/positions/:instanceId', method: 'GET', path: '/api/v1/positions/1', headers: {}, description: 'Positions for a specific instance.' },
      { label: 'GET /api/v1/positions/:instanceId/pnl', method: 'GET', path: '/api/v1/positions/1/pnl', headers: {}, description: 'PnL for a specific instance.' },
      { label: 'POST /api/v1/positions/:instanceId/close', method: 'POST', path: '/api/v1/positions/1/close', headers: {}, description: 'Close all positions for an instance.' },
      { label: 'POST /api/v1/positions/:instanceId/close/position', method: 'POST', path: '/api/v1/positions/1/close/position', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbol": "NIFTY23DEC24000CE",\n  "quantity": 50\n}', description: 'Close a specific position.' },

      // Quick Orders
      { label: 'POST /api/v1/quickorders', method: 'POST', path: '/api/v1/quickorders', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbolId": 1,\n  "instanceId": "ALL",\n  "action": "BUY",\n  "tradeMode": "EQUITY",\n  "quantity": 1,\n  "orderType": "MARKET"\n}', description: 'Place a quick order (auto-resolved symbols).' },
      { label: 'GET /api/v1/quickorders/options/preview', method: 'GET', path: '/api/v1/quickorders/options/preview?symbolId=1&expiry=YYYY-MM-DD&optionsLeg=ATM', headers: {}, description: 'Preview CE/PE symbols + quotes for a watchlist symbol.' },
      { label: 'GET /api/v1/quickorders/futures/preview', method: 'GET', path: '/api/v1/quickorders/futures/preview?symbolId=1&expiry=YYYY-MM-DD', headers: {}, description: 'Preview futures contract + quote for a watchlist symbol.' },
      { label: 'GET /api/v1/quickorders', method: 'GET', path: '/api/v1/quickorders?limit=20', headers: {}, description: 'List quick order history.' },
      { label: 'GET /api/v1/quickorders/:id', method: 'GET', path: '/api/v1/quickorders/1', headers: {}, description: 'Get a quick order by ID.' },
      { label: 'GET /api/v1/quickorders/symbol/:symbol', method: 'GET', path: '/api/v1/quickorders/symbol/NIFTY', headers: {}, description: 'List quick orders for a symbol.' },
      { label: 'GET /api/v1/quickorders/stats/summary', method: 'GET', path: '/api/v1/quickorders/stats/summary', headers: {}, description: 'Summary stats for quick orders.' },

      // Symbols + utilities
      { label: 'GET /api/v1/symbols/search', method: 'GET', path: '/api/v1/symbols/search?query=NIFTY', headers: {}, description: 'Search tradable symbols.' },
      { label: 'POST /api/v1/symbols/validate', method: 'POST', path: '/api/v1/symbols/validate', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbol": "NIFTY23DEC24000CE"\n}', description: 'Validate a symbol string.' },
      { label: 'POST /api/v1/symbols/quotes', method: 'POST', path: '/api/v1/symbols/quotes', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbols": [\n    { "exchange": "NSE", "symbol": "NIFTY" }\n  ]\n}', description: 'Fetch quotes for arbitrary symbols.' },
      { label: 'GET /api/v1/symbols/market-data/:exchange/:symbol', method: 'GET', path: '/api/v1/symbols/market-data/NSE/NIFTY', headers: {}, description: 'Fetch market data for a symbol.' },
      { label: 'GET /api/v1/symbols/expiry', method: 'GET', path: '/api/v1/symbols/expiry?underlying=NIFTY&exchange=NFO', headers: {}, description: 'List expiries for an underlying.' },
      { label: 'GET /api/v1/symbols/option-chain', method: 'GET', path: '/api/v1/symbols/option-chain?underlying=NIFTY&exchange=NFO&expiry=YYYY-MM-DD', headers: {}, description: 'Build option chain from instruments cache.' },
      { label: 'POST /api/v1/symbols/utils', method: 'POST', path: '/api/v1/symbols/utils', headers: { 'Content-Type': 'application/json' }, body: '{\n  "action": "buildOptionSymbol",\n  "params": {\n    "underlying": "NIFTY",\n    "expiry": "YYYY-MM-DD",\n    "strike": 20000,\n    "optionType": "CE"\n  }\n}', description: 'Utility helpers (build/parse symbols, etc.).' },
      { label: 'POST /api/v1/symbols/quotes/subscribe', method: 'POST', path: '/api/v1/symbols/quotes/subscribe', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbols": [\n    { "exchange": "NSE", "symbol": "NIFTY" }\n  ]\n}', description: 'Subscribe symbols for live quote polling.' },

      // Instruments
      { label: 'GET /api/v1/instruments/search', method: 'GET', path: '/api/v1/instruments/search?query=NIFTY', headers: {}, description: 'Search instruments DB.' },
      { label: 'GET /api/v1/instruments/option-chain', method: 'GET', path: '/api/v1/instruments/option-chain?underlying=NIFTY&exchange=NFO&expiry=YYYY-MM-DD', headers: {}, description: 'Option chain via instruments DB (no quotes).' },
      { label: 'GET /api/v1/instruments/expiries', method: 'GET', path: '/api/v1/instruments/expiries?underlying=NIFTY&exchange=NFO', headers: {}, description: 'List expiries from instruments DB.' },
      { label: 'GET /api/v1/instruments/stats', method: 'GET', path: '/api/v1/instruments/stats', headers: {}, description: 'Instrument DB stats.' },
      { label: 'GET /api/v1/instruments/needs-refresh', method: 'GET', path: '/api/v1/instruments/needs-refresh', headers: {}, description: 'Check if instruments refresh is required.' },
      { label: 'POST /api/v1/instruments/refresh', method: 'POST', path: '/api/v1/instruments/refresh', headers: {}, description: 'Trigger instruments refresh (admin permission).' },
      { label: 'POST /api/v1/instruments/upload', method: 'POST', path: '/api/v1/instruments/upload', headers: {}, description: 'Upload instruments CSV (multipart).' },
      { label: 'GET /api/v1/instruments/fetch-status/:instanceId', method: 'GET', path: '/api/v1/instruments/fetch-status/1', headers: {}, description: 'Fetch instrument load status for instance.' },
      { label: 'POST /api/v1/instruments/fetch-from-instance', method: 'POST', path: '/api/v1/instruments/fetch-from-instance', headers: { 'Content-Type': 'application/json' }, body: '{\n  "instanceId": 1\n}', description: 'Pull instruments directly from a broker instance.' },
      { label: 'GET /api/v1/instruments/:exchange/:symbol', method: 'GET', path: '/api/v1/instruments/NFO/NIFTY', headers: {}, description: 'Get instrument record by exchange/symbol.' },

      // Option chain service
      { label: 'GET /api/v1/option-chain/underlyings', method: 'GET', path: '/api/v1/option-chain/underlyings', headers: {}, description: 'List underlyings with option chain data.' },
      { label: 'GET /api/v1/option-chain/expiries', method: 'GET', path: '/api/v1/option-chain/expiries?underlying=NIFTY', headers: {}, description: 'List expiries for an underlying (option-chain service).' },
      { label: 'GET /api/v1/option-chain', method: 'GET', path: '/api/v1/option-chain?underlying=NIFTY&expiry=YYYY-MM-DD&include_quotes=true', headers: {}, description: 'Option chain via instruments + quotes.' },
      { label: 'GET /api/v1/option-chain/sample/:underlying', method: 'GET', path: '/api/v1/option-chain/sample/NIFTY', headers: {}, description: 'Sample option chain payload for testing.' },

      // Telemetry/monitoring
      { label: 'GET /api/v1/telemetry/rate-limits', method: 'GET', path: '/api/v1/telemetry/rate-limits', headers: {}, description: 'Rate-limit headroom snapshot per instance.' },
      { label: 'GET /api/v1/telemetry/cache-status', method: 'GET', path: '/api/v1/telemetry/cache-status', headers: {}, description: 'Cache staleness snapshot (quotes/positions/etc.).' },
      { label: 'GET /api/v1/monitor/status', method: 'GET', path: '/api/v1/monitor/status', headers: {}, description: 'Background monitor status (pollers/feeds).' },
      { label: 'GET /api/v1/monitor/history', method: 'GET', path: '/api/v1/monitor/history', headers: {}, description: 'Historical monitor events.' },
      { label: 'GET /api/v1/monitor/analyzer-trades', method: 'GET', path: '/api/v1/monitor/analyzer-trades', headers: {}, description: 'Analyzer-mode trades monitor.' },
      { label: 'GET /api/v1/dashboard/metrics', method: 'GET', path: '/api/v1/dashboard/metrics', headers: {}, description: 'Dashboard funds/PnL metrics.' },
      { label: 'POST /api/v1/health-check/run', method: 'POST', path: '/api/v1/health-check/run', headers: {}, description: 'Run full health check (admin permission).' },

      // Trades
      { label: 'GET /api/v1/trades/tradebook', method: 'GET', path: '/api/v1/trades/tradebook', headers: {}, description: 'Tradebook snapshot grouped by instance.' },

      // Polling controls
      { label: 'GET /api/v1/polling/status', method: 'GET', path: '/api/v1/polling/status', headers: {}, description: 'Check global polling status.' },
      { label: 'POST /api/v1/polling/start', method: 'POST', path: '/api/v1/polling/start', headers: {}, description: 'Start global polling (needs permission).' },
      { label: 'POST /api/v1/polling/stop', method: 'POST', path: '/api/v1/polling/stop', headers: {}, description: 'Stop global polling (needs permission).' },
      { label: 'POST /api/v1/polling/market-data/start', method: 'POST', path: '/api/v1/polling/market-data/start', headers: {}, description: 'Start market data polling.' },
      { label: 'POST /api/v1/polling/market-data/stop', method: 'POST', path: '/api/v1/polling/market-data/stop', headers: {}, description: 'Stop market data polling.' },

      // Settings / RBAC
      { label: 'GET /api/v1/settings', method: 'GET', path: '/api/v1/settings', headers: {}, description: 'All settings (admin).' },
      { label: 'GET /api/v1/settings/categories', method: 'GET', path: '/api/v1/settings/categories', headers: {}, description: 'List setting categories (admin).' },
      { label: 'GET /api/v1/settings/:category', method: 'GET', path: '/api/v1/settings/general', headers: {}, description: 'Settings by category (admin).' },
      { label: 'GET /api/v1/settings/key/:key', method: 'GET', path: '/api/v1/settings/key/example', headers: {}, description: 'Get a setting by key (admin).' },
      { label: 'PUT /api/v1/settings/:key', method: 'PUT', path: '/api/v1/settings/example', headers: { 'Content-Type': 'application/json' }, body: '{\n  "value": "new-value"\n}', description: 'Update a setting by key (admin).' },
      { label: 'GET /api/v1/settings/instance-health-tests/config', method: 'GET', path: '/api/v1/settings/instance-health-tests/config', headers: {}, description: 'View instance health test config (admin).' },
      { label: 'PUT /api/v1/settings/instance-health-tests/config', method: 'PUT', path: '/api/v1/settings/instance-health-tests/config', headers: { 'Content-Type': 'application/json' }, body: '{\n  "enabled": true\n}', description: 'Update instance health test config (admin).' },
      { label: 'PUT /api/v1/settings', method: 'PUT', path: '/api/v1/settings', headers: { 'Content-Type': 'application/json' }, body: '{\n  "some_key": "some_value"\n}', description: 'Bulk update settings (admin).' },
      { label: 'POST /api/v1/settings/:key/reset', method: 'POST', path: '/api/v1/settings/example/reset', headers: {}, description: 'Reset a setting to default (admin).' },

      { label: 'GET /api/v1/rbac/roles', method: 'GET', path: '/api/v1/rbac/roles', headers: {}, description: 'List RBAC roles (admin permission).' },
      { label: 'PUT /api/v1/rbac/roles/:roleName/permissions', method: 'PUT', path: '/api/v1/rbac/roles/ADMIN/permissions', headers: { 'Content-Type': 'application/json' }, body: '{\n  "permissions": ["orders.place"]\n}', description: 'Set permissions for a role.' },
      { label: 'GET /api/v1/rbac/permissions', method: 'GET', path: '/api/v1/rbac/permissions', headers: {}, description: 'List available permissions.' },
      { label: 'GET /api/v1/rbac/users', method: 'GET', path: '/api/v1/rbac/users', headers: {}, description: 'List users with roles.' },
      { label: 'PUT /api/v1/rbac/users/:userId/role', method: 'PUT', path: '/api/v1/rbac/users/1/role', headers: { 'Content-Type': 'application/json' }, body: '{\n  "role": "ADMIN"\n}', description: 'Assign a role to a user.' },

      // Notifications
      { label: 'GET /api/v1/notifications', method: 'GET', path: '/api/v1/notifications', headers: {}, description: 'List notifications.' },
      { label: 'POST /api/v1/notifications/:id/read', method: 'POST', path: '/api/v1/notifications/1/read', headers: {}, description: 'Mark a notification as read.' },

      // Telemetry snapshots
      { label: 'GET /api/v1/snapshots/quotes', method: 'GET', path: '/api/v1/snapshots/quotes', headers: {}, description: 'Quote snapshot (persisted) across instances.' },
      { label: 'GET /api/v1/snapshots/positions/:instanceId', method: 'GET', path: '/api/v1/snapshots/positions/1', headers: {}, description: 'Position snapshot for an instance.' },
      { label: 'GET /api/v1/snapshots/orders/:instanceId', method: 'GET', path: '/api/v1/snapshots/orders/1', headers: {}, description: 'Order snapshot for an instance.' },
      { label: 'GET /api/v1/snapshots/trades/:instanceId', method: 'GET', path: '/api/v1/snapshots/trades/1', headers: {}, description: 'Trade snapshot for an instance.' },

      // Trades + order/position books via symbols/instruments
      { label: 'GET /api/v1/trades/tradebook (duplicate shortcut)', method: 'GET', path: '/api/v1/trades/tradebook', headers: {}, description: 'Tradebook snapshot (same as above).' },

      // Option chain / instruments convenience
      { label: 'GET /api/v1/instruments/option-chain (no quotes)', method: 'GET', path: '/api/v1/instruments/option-chain?underlying=NIFTY&exchange=NFO&expiry=YYYY-MM-DD', headers: {}, description: 'Option chain (DB only, no quotes).' },
      { label: 'GET /api/v1/symbols/option-chain (DB)', method: 'GET', path: '/api/v1/symbols/option-chain?underlying=NIFTY&exchange=NFO&expiry=YYYY-MM-DD', headers: {}, description: 'Option chain via symbol route (DB).' },
      { label: 'GET /api/v1/option-chain (quotes)', method: 'GET', path: '/api/v1/option-chain?underlying=NIFTY&expiry=YYYY-MM-DD&include_quotes=true', headers: {}, description: 'Option chain including quotes and spot/forward.' },
    ];
  }

  async renderNotificationsView() {
    const contentArea = document.getElementById('content-area');
    try {
      const res = await api.getNotifications();
      const rows = res.data || [];
      const fmtDate = (ts) => Utils.formatDateTime(ts, true);
      const items = rows.length
        ? rows
            .map(
              (n) => `
          <div class="flex items-start gap-3 p-3 rounded-lg ${n.read ? 'bg-base-200' : 'bg-base-100'} border border-base-200">
            <div class="text-sm font-semibold">${n.title}</div>
            <div class="ml-auto text-xs text-neutral-500">${fmtDate(n.created_at)}</div>
            <div class="text-xs text-neutral-600 w-full">${n.body || ''}</div>
            ${n.read ? '' : `<button class="btn btn-xs btn-outline" onclick="app.markNotificationRead(${n.id})">Mark read</button>`}
          </div>`
            )
            .join('')
        : '<p class="text-sm text-neutral-600">No notifications.</p>';

      contentArea.innerHTML = `
        <div class="p-4 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">Notifications</h3>
            <p class="text-sm text-neutral-500">Endpoint health and system alerts</p>
          </div>
          <div class="space-y-2">${items}</div>
          <div class="flex gap-2">
            <button class="btn btn-buy btn-sm" onclick="app.markAllNotificationsRead()">Mark all read</button>
            <button class="btn btn-neutral btn-outline btn-sm" onclick="app.renderNotificationsView()">Refresh</button>
            <button class="btn btn-outline btn-sm" onclick="app.triggerHealthCheck()">Run health check now</button>
          </div>
        </div>
      `;
    } catch (err) {
      contentArea.innerHTML = `<p class="text-error text-sm">Failed to load notifications: ${err.message}</p>`;
    }
  }

  async markNotificationRead(id) {
    try {
      await api.markNotificationRead(id);
      await this.renderNotificationsView();
    } catch (err) {
      Utils.showToast('Failed to mark notification read', 'error');
    }
  }

  async markAllNotificationsRead() {
    try {
      const res = await api.getNotifications();
      const rows = res.data || [];
      await Promise.all(rows.filter((n) => !n.read).map((n) => api.markNotificationRead(n.id)));
      await this.renderNotificationsView();
    } catch (err) {
      Utils.showToast('Failed to mark all read', 'error');
    }
  }

  async triggerHealthCheck() {
    try {
      await api.request('/health-check/run', { method: 'POST' });
      Utils.showToast('Health check triggered', 'success');
      await this.renderNotificationsView();
    } catch (err) {
      Utils.showToast('Failed to trigger health check', 'error');
    }
  }

  /**
   * Render Admin API Playground
   */
  async renderApiPlaygroundView() {
    const contentArea = document.getElementById('content-area');

    if (!this.isAdmin()) {
      contentArea.innerHTML = `
        <div class="p-6">
          <div class="alert alert-warning">
            <div>
              <h3 class="font-semibold">Admin access required</h3>
              <p class="text-sm text-neutral-600">Only admins can use the API Playground.</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const presetOptions = [
      '<option value="">Select a preset (optional)</option>',
      ...this.apiPlaygroundPresets.map((p, idx) => `<option value="${idx}">${Utils.escapeHTML(p.label)}</option>`),
    ].join('');

    contentArea.innerHTML = `
      <div class="p-4 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-xl font-semibold">API Playground (Admin only)</h2>
            <p class="text-sm text-neutral-600">Exercise any internal API quickly to validate edge cases after changes.</p>
            <p class="text-xs text-neutral-500 mt-1">Pick a preset to auto-fill method, path, headers, and body. Edit only what you need (e.g., instanceId or symbolId). All JSON fields must be valid JSON.</p>
          </div>
          <span class="badge badge-primary badge-outline">Admin</span>
        </div>

        <div class="card p-4 space-y-3">
          <form id="api-playground-form" class="space-y-4">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label class="form-control w-full">
                <div class="label"><span class="label-text">Preset</span></div>
                <select id="api-playground-preset" class="select select-bordered w-full">
                  ${presetOptions}
                </select>
                <p id="api-playground-desc" class="text-xs text-neutral-500 mt-1">Select a preset to auto-fill method, path, headers, and body.</p>
              </label>
              <label class="form-control w-full">
                <div class="label"><span class="label-text">Method</span></div>
                <select id="api-playground-method" class="select select-bordered w-full">
                  <option>GET</option>
                  <option>POST</option>
                  <option>PUT</option>
                  <option>PATCH</option>
                  <option>DELETE</option>
                </select>
              </label>
              <label class="form-control md:col-span-2">
                <div class="label"><span class="label-text">Path (relative)</span></div>
                <input id="api-playground-path" type="text" class="input input-bordered w-full font-mono text-sm" placeholder="/api/v1/quickorders/options/preview">
              </label>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label class="form-control">
                <div class="label">
                  <span class="label-text">Headers (JSON)</span>
                  <span class="label-text-alt text-neutral-500 text-xs">Auto-adds bearer token if available. Example: {"Content-Type": "application/json"}</span>
                </div>
                <textarea id="api-playground-headers" class="textarea textarea-bordered font-mono text-xs" rows="4" placeholder='{"Content-Type": "application/json"}'>{}</textarea>
              </label>
              <label class="form-control">
                <div class="label">
                  <span class="label-text">Body (JSON for non-GET)</span>
                  <span class="label-text-alt text-neutral-500 text-xs">Auto-filled from preset. Leave blank for GET/HEAD.</span>
                </div>
                <textarea id="api-playground-body" class="textarea textarea-bordered font-mono text-xs" rows="6" placeholder="{}"></textarea>
              </label>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button type="submit" class="btn btn-primary">Send request</button>
              <button type="button" id="api-playground-clear" class="btn btn-outline">Clear body</button>
              <span id="api-playground-status" class="text-xs text-neutral-500"></span>
            </div>
          </form>
        </div>

        <div class="card p-4 space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">Response</h3>
            <span id="api-playground-meta" class="text-xs text-neutral-500"></span>
          </div>
          <pre id="api-playground-response" class="bg-base-200 rounded p-3 text-xs overflow-auto min-h-[120px] whitespace-pre-wrap">Awaiting request…</pre>
        </div>
      </div>
    `;

    const presetSelect = document.getElementById('api-playground-preset');
    const methodSelect = document.getElementById('api-playground-method');
    const pathInput = document.getElementById('api-playground-path');
    const headersInput = document.getElementById('api-playground-headers');
    const bodyInput = document.getElementById('api-playground-body');
    const statusEl = document.getElementById('api-playground-status');
    const metaEl = document.getElementById('api-playground-meta');
    const responseEl = document.getElementById('api-playground-response');
    const descEl = document.getElementById('api-playground-desc');

    const applyPreset = (index) => {
      const preset = this.apiPlaygroundPresets[index];
      if (!preset) return;
      methodSelect.value = preset.method || 'GET';
      pathInput.value = preset.path || '';
      const headersVal = preset.headers ? JSON.stringify(preset.headers, null, 2) : '';
      headersInput.value = headersVal || '{}';
      if (preset.body) {
        bodyInput.value = preset.body;
      } else if (['GET', 'HEAD'].includes((preset.method || '').toUpperCase())) {
        bodyInput.value = '';
      } else {
        bodyInput.value = '{}';
      }
      if (descEl) {
        descEl.textContent = preset.description || 'Preset loaded.';
      }
    };

    presetSelect.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      if (!Number.isNaN(idx)) {
        applyPreset(idx);
      } else if (descEl) {
        descEl.textContent = 'Select a preset to auto-fill method, path, headers, and body.';
      }
    });

    document.getElementById('api-playground-clear').addEventListener('click', () => {
      bodyInput.value = '';
    });

    const setResponse = (text, meta = '') => {
      responseEl.textContent = text;
      metaEl.textContent = meta;
    };

    const parseJsonSafely = (text) => {
      if (!text || !text.trim()) return null;
      return JSON.parse(text);
    };

    document.getElementById('api-playground-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const method = methodSelect.value || 'GET';
      let path = pathInput.value.trim();
      if (!path) {
        Utils.showToast('Path is required', 'error');
        return;
      }
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }

      let headers = {};
      if (headersInput.value.trim()) {
        try {
          headers = parseJsonSafely(headersInput.value) || {};
        } catch (err) {
          Utils.showToast('Headers must be valid JSON', 'error');
          return;
        }
      }

      const token = api._getToken && api._getToken();
      if (token && !headers.Authorization) {
        headers.Authorization = `Bearer ${token}`;
      }

      let body = null;
      const bodyText = bodyInput.value.trim();
      if (!['GET', 'HEAD'].includes(method.toUpperCase()) && bodyText) {
        try {
          body = parseJsonSafely(bodyText);
          headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        } catch (err) {
          Utils.showToast('Body must be valid JSON', 'error');
          return;
        }
      }

      statusEl.textContent = 'Sending...';
      setResponse('Awaiting response…');

      const started = performance.now();
      try {
        const res = await fetch(path, {
          method,
          headers,
          credentials: 'include',
          body: body ? JSON.stringify(body) : undefined,
        });
        const duration = Math.round(performance.now() - started);
        const text = await res.text();

        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          parsed = text;
        }

        const pretty = typeof parsed === 'string'
          ? parsed
          : JSON.stringify(parsed, null, 2);

        setResponse(pretty, `Status ${res.status} · ${duration} ms`);
        statusEl.textContent = `Completed (${res.status})`;
      } catch (err) {
        const duration = Math.round(performance.now() - started);
        setResponse(String(err.message || err), `Error · ${duration} ms`);
        statusEl.textContent = 'Request failed';
      }
    });
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
    this.loadSidebarState();
    this.applySidebarState();
    this.applyTheme();
      this.quickOrder = window.quickOrder || null;

      // Load current user
      await this.loadCurrentUser();
      await this.loadPublicConfig();

      if (this.useWsGateway) {
        if (this.wsGatewayEnabled) {
          this.startWsStream();
        } else {
          Utils.showToast('Live streaming disabled on server; using polling.', 'info');
        }
      }

      // Setup navigation and route listeners
      this.setupNavigation();
      window.addEventListener('hashchange', () => this.handleHashChange());

      // Load initial view based on stored state or hash
      const initialView = this.determineInitialView();
      this.switchView(initialView, { updateHash: false, forceReload: true });
      this.updatePauseButtonUI();

      // Note: Auto-refresh disabled to prevent page flicker
      // Individual polling mechanisms (quotes, positions) handle their own updates
      // this.startAutoRefresh();

      // debug removed
    } catch (error) {
      console.error('Failed to initialize dashboard:', error);
      Utils.showToast('Failed to initialize dashboard', 'error');
    }
  }

  loadSidebarState() {
    const stored = localStorage.getItem('sidebarCollapsed');
    this.isSidebarCollapsed = stored === 'true';
  }

  applyTheme() {
    const theme = 'light';
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    this.updateThemeButtonUI();
  }

  toggleTheme() {
    this.theme = 'light';
    this.applyTheme();
  }

  updateThemeButtonUI() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    btn.textContent = `Theme: light`;
  }

  loadWsPreference() {
    try {
      const stored = localStorage.getItem('useWsGateway');
      return stored === 'true';
    } catch (_) {
      return false;
    }
  }

  saveWsPreference(enabled) {
    try {
      localStorage.setItem('useWsGateway', enabled ? 'true' : 'false');
    } catch (_) {
      // ignore
    }
  }

  loadSnapshotResyncPreference() {
    try {
      const stored = localStorage.getItem('autoSnapshotResyncEnabled');
      if (stored === 'false') return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  persistSnapshotResyncPreference(enabled) {
    try {
      localStorage.setItem('autoSnapshotResyncEnabled', enabled ? 'true' : 'false');
    } catch (_) {
      // ignore
    }
  }

  applySidebarState() {
    document.body.classList.toggle('sidebar-collapsed', this.isSidebarCollapsed);
    const drawerRoot = document.querySelector('.drawer');
    if (drawerRoot) {
      drawerRoot.classList.toggle('sidebar-collapsed', this.isSidebarCollapsed);
    }

    const toggleBtn = document.getElementById('sidebar-collapse-btn');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', this.isSidebarCollapsed);
      toggleBtn.setAttribute(
        'title',
        this.isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
      );
    }
  }

  toggleSidebarCollapse() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    this.applySidebarState();
    localStorage.setItem('sidebarCollapsed', this.isSidebarCollapsed ? 'true' : 'false');
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    this.updatePauseButtonUI();
    if (this.isPaused) {
      Utils.showToast('Paused all background data fetching', 'info');
      this.stopAllWatchlistPolling();
      this.stopTradesPolling();
      this.stopPositionsPolling();
      if (this.pollingInterval) {
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }
      // Stop backend polling
      api.stopPolling().catch(() => {});
      api.stopMarketDataPolling().catch(() => {});
    } else {
      Utils.showToast('Resumed data fetching', 'success');
      // Resume backend polling
      api.startPolling().catch(() => {});
      this.refreshCurrentView(true);
      this.startAutoRefresh();
    }
  }

  updatePauseButtonUI() {
    const btn = document.getElementById('pause-toggle-btn');
    const path = document.getElementById('pause-play-path');
    if (!btn || !path) return;
    if (this.isPaused) {
      // show play icon
      path.setAttribute('d', 'M8 5v14l11-7z');
      btn.setAttribute('title', 'Resume data fetching');
      btn.setAttribute('aria-label', 'Resume data fetching');
    } else {
      // show pause icon
      path.setAttribute('d', 'M6 4h4v16H6zM14 4h4v16h-4z');
      btn.setAttribute('title', 'Pause data fetching');
      btn.setAttribute('aria-label', 'Pause data fetching');
    }
  }

  /**
   * Load current user
   */
  async loadCurrentUser() {
    try {
      const response = await api.getCurrentUser();
      if (!response || !response.data) {
        // API client may have redirected for pending access
        throw new Error('ACCESS_PENDING');
      }
      this.currentUser = response.data;

      // Update UI
      const emailElement = document.getElementById('current-user-email');
      if (emailElement) {
        emailElement.textContent = this.currentUser.email;
      }

      // Update avatar
      const avatarElement = document.getElementById('user-avatar');
      if (avatarElement) {
        avatarElement.textContent = this.currentUser.email.charAt(0).toUpperCase();
      }

      this.applyAdminVisibility();

      // If no role assigned, show message and halt further loading
      if (!this.currentUser.role && !this.currentUser.is_admin) {
        Utils.showToast('No role assigned. An admin will review your access.', 'warning');
        const contentArea = document.getElementById('content-area');
        if (contentArea) {
          contentArea.innerHTML = `
            <div class="p-6">
              <div class="alert alert-warning">
                <div>
                  <h3 class="font-semibold">Access pending</h3>
                  <p>Your account has been created but no role is assigned yet. An admin will review your request and grant access.</p>
                </div>
              </div>
            </div>
          `;
        }
        throw new Error('NO_ROLE_ASSIGNED');
      }
    } catch (error) {
      console.error('Failed to load user:', error);
      if (error.message === 'NO_ROLE_ASSIGNED') {
        throw error;
      }
      if (error.statusCode === 403 || error.message === 'ACCESS_PENDING') {
        window.location.href = '/access-pending.html';
        return;
      }
    }
  }

  async loadPublicConfig() {
    try {
      const res = await api.getPublicConfig();
      const cfg = res?.data || {};
      this.wsGatewayEnabled = Boolean(cfg.wsGatewayEnabled);
      this.wsGatewayPath = cfg.wsGatewayPath || '/stream';
      if (cfg.webhookToken) {
        window.WEBHOOK_TOKEN = cfg.webhookToken;
        window.appConfig = { ...(window.appConfig || {}), webhookToken: cfg.webhookToken };
      }
    } catch (err) {
      this.wsGatewayEnabled = false;
    }
  }

  isAdmin() {
    return (this.currentUser?.role || '').toUpperCase() === 'ADMIN' || this.currentUser?.is_admin === true;
  }

  applyAdminVisibility() {
    const adminOnly = document.querySelectorAll('[data-admin-only="true"]');
    const show = this.isAdmin();
    adminOnly.forEach((el) => {
      el.style.display = show ? '' : 'none';
    });
  }

  startWsStream() {
    if (!this.wsGatewayEnabled) return;
    this.useWsGateway = true;
    this.saveWsPreference(true);
    this.wsReconnectDelay = 500;
    if (!this.ws) {
      this.connectWsStream();
    }
  }

  stopWsStream(reason = '') {
    this.useWsGateway = false;
    this.saveWsPreference(false);
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    if (reason === 'user') {
      Utils.showToast('Live streaming turned off. Using polling only.', 'info');
    }
  }

  scheduleWsReconnect() {
    if (!this.useWsGateway || !this.wsGatewayEnabled) return;
    const delay = Math.min(this.wsReconnectDelay, 8000);
    this.wsReconnectDelay = Math.min(delay * 2, 8000);
    this.wsReconnectTimer = setTimeout(() => this.connectWsStream(), delay);
  }

  connectWsStream() {
    if (!this.useWsGateway || !this.wsGatewayEnabled) return;
    if (this.ws) return;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${window.location.host}${this.wsGatewayPath}?topics=${this.wsTopics.join(',')}&last_seq=${this.wsLastSeq || 0}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.wsReconnectDelay = 500;
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleWsMessage(message);
        } catch (err) {
          console.warn('WS message parse failed', err);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        this.ws = null;
        this.scheduleWsReconnect();
      };
    } catch (err) {
      console.warn('WS connect failed', err);
      this.scheduleWsReconnect();
    }
  }

  handleWsMessage(msg) {
    if (!msg) return;
    if (typeof msg.seq === 'number') {
      if (this.wsLastSeq > 0 && msg.seq > this.wsLastSeq + 1) {
        this.triggerSnapshotResync();
      }
      this.wsLastSeq = Math.max(this.wsLastSeq, msg.seq);
    }

    switch (msg.topic) {
      case 'quotes:update': {
        if (this.currentView === 'watchlists') {
          this.handleQuoteStreamPayload(msg.payload || {});
        } else {
          this.wsRefreshWatchlists();
        }
        break;
      }
      case 'positions:update': {
        if (this.currentView === 'positions') {
          this.wsRefreshPositions();
        }
        if (this.currentView === 'dashboard') {
          this.wsRefreshDashboard();
        }
        break;
      }
      case 'funds:update': {
        if (this.currentView === 'dashboard') {
          this.wsRefreshDashboard();
        }
        break;
      }
      default:
        break;
    }
  }

  toggleStreamPreference() {
    if (this.useWsGateway) {
      this.stopWsStream('user');
    } else {
      this.useWsGateway = true;
      this.saveWsPreference(true);
      if (this.wsGatewayEnabled) {
        this.startWsStream();
        Utils.showToast('Live streaming enabled (quotes/positions/funds)', 'success');
      } else {
        Utils.showToast('Server streaming is disabled. Continuing with polling.', 'warning');
      }
    }

    if (this.currentView === 'settings') {
      settings.renderSettingsView();
    }
  }

  getStreamPreference() {
    return this.useWsGateway;
  }

  /**
   * Setup navigation
   */
  setupNavigation() {
    const navItems = document.querySelectorAll('[data-view]');

    navItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();

        const view = item.dataset.view;
        this.switchView(view);
      });
    });
  }

  /**
   * Determine the initial view to render
   */
  determineInitialView() {
    const hashView = this.parseViewFromHash();
    if (hashView) {
      return hashView;
    }

    const storedView = localStorage.getItem('lastView');
    if (this.isValidView(storedView)) {
      return storedView;
    }

    return this.defaultView;
  }

  /**
   * Parse view from the URL hash
   */
  parseViewFromHash() {
    if (!window.location.hash) {
      return null;
    }

    const viewName = window.location.hash.replace('#', '').trim();
    return this.isValidView(viewName) ? viewName : null;
  }

  /**
   * Handle hash change events (browser navigation)
   */
  handleHashChange() {
    if (this.suppressHashChange) {
      this.suppressHashChange = false;
      return;
    }

    const viewFromHash = this.parseViewFromHash();
    if (!viewFromHash) {
      return;
    }

    this.switchView(viewFromHash, { updateHash: false });
  }

  isValidView(viewName) {
    return typeof viewName === 'string' && this.validViews.includes(viewName);
  }

  persistViewState(viewName) {
    localStorage.setItem('lastView', viewName);
  }

  updateHash(viewName) {
    const targetHash = `#${viewName}`;
    if (window.location.hash !== targetHash) {
      this.suppressHashChange = true;
      window.location.hash = viewName;
    }
  }

  /**
   * Switch view
   */
  switchView(viewName, options = {}) {
    const { updateHash = true, forceReload = false } = options;

    if (!this.isValidView(viewName)) {
      return;
    }

    if (viewName === 'api-playground' && !this.isAdmin()) {
      Utils.showToast('API Playground is restricted to admins.', 'warning');
      return;
    }

    // Avoid duplicate loads unless forced
    if (!forceReload && this.currentView === viewName) {
      if (updateHash) {
        this.updateHash(viewName);
      }
      this.persistViewState(viewName);
      return;
    }

    this.persistViewState(viewName);
    if (updateHash) {
      this.updateHash(viewName);
    }

    // Update active state
    const navItems = document.querySelectorAll('[data-view]');
    navItems.forEach((item) => {
      if (item.dataset.view === viewName) {
        item.classList.add('active', 'bg-primary', 'text-primary-content');
        item.classList.remove('hover:bg-base-200');
      } else {
        item.classList.remove('active', 'bg-primary', 'text-primary-content');
        item.classList.add('hover:bg-base-200');
      }
    });

    // Close drawer on mobile
    const drawerToggle = document.getElementById('drawer-toggle');
    if (drawerToggle) {
      drawerToggle.checked = false;
    }

    // Load view
    this.loadView(viewName);
  }

  /**
   * Load view
   */
  async loadView(viewName, { force = false } = {}) {
    if (this.isPaused && !force) return;
    // Clean up watchlist pollers when leaving watchlists view
    if (this.currentView === 'watchlists' && viewName !== 'watchlists') {
      this.stopAllWatchlistPolling();
      this.stopPositionsPolling();
      if (window.quickOrder && typeof window.quickOrder.stopAllOptionPreviewPolling === 'function') {
        window.quickOrder.stopAllOptionPreviewPolling();
      }
      if (window.quickOrder && typeof window.quickOrder.stopAllFuturesPreviewPolling === 'function') {
        window.quickOrder.stopAllFuturesPreviewPolling();
      }
    }

    if (this.currentView === 'trades' && viewName !== 'trades') {
      this.stopTradesPolling();
    }

    if (this.currentView === 'dashboard' && viewName !== 'dashboard') {
      this.stopTelemetryRefresh();
    }

    if (['watchlists', 'positions'].includes(this.currentView) && !['watchlists', 'positions'].includes(viewName)) {
      this.stopSnapshotResync();
    }

    this.currentView = viewName;

    // Update title
    const titles = {
      dashboard: 'Dashboard',
      instances: 'Instances',
      watchlists: 'Watchlists',
      orders: 'Orders',
      trades: 'Trades',
      positions: 'Positions',
      settings: 'Settings',
      notifications: 'Notifications',
      'api-playground': 'API Playground',
    };

    document.getElementById('view-title').textContent =
      titles[viewName] || viewName;

    // Show loading
    const contentArea = document.getElementById('content-area');
    Utils.showLoading(contentArea);
    this.updateThemeButtonUI();

    // Load view content
    try {
      switch (viewName) {
        case 'dashboard':
          await this.renderDashboardView();
          break;
        case 'instances':
          await this.renderInstancesView();
          break;
        case 'watchlists':
          await this.renderWatchlistsView();
          this.startSnapshotResync('watchlists');
          break;
        case 'orders':
          await this.renderOrdersView();
          break;
        case 'trades':
          await this.renderTradesView();
          break;
        case 'positions':
          await this.renderPositionsView();
          this.startSnapshotResync('positions');
          break;
        case 'settings':
          await settings.renderSettingsView();
          break;
        case 'notifications':
          await this.renderNotificationsView();
          break;
        case 'api-playground':
          await this.renderApiPlaygroundView();
          break;
        default:
          contentArea.innerHTML = '<p>View not found</p>';
      }
    } catch (error) {
      console.error(`Failed to load ${viewName} view:`, error);
      contentArea.innerHTML = `
        <div class="card">
          <p class="text-loss">Failed to load ${viewName}: ${error.message}</p>
        </div>
      `;
    }
  }

  /**
   * Render Dashboard View
   */
  async renderDashboardView() {
    const contentArea = document.getElementById('content-area');

    // Fetch data
    const [instancesRes, metricsRes, telemetryRateRes, cacheStatusRes] = await Promise.all([
      api.getInstances({ is_active: true }),
      api.getDashboardMetrics().catch(() => ({
        data: {
          live: {
            instances: [],
            total_available_balance: 0,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_pnl: 0,
          },
          analyzer: {
            instances: [],
            total_available_balance: 0,
            total_realized_pnl: 0,
            total_unrealized_pnl: 0,
            total_pnl: 0,
          },
        },
      })),
      api.getTelemetryRateLimits().catch(() => ({ data: [] })),
      api.getTelemetryCacheStatus().catch(() => ({ data: { entries: [] } })),
    ]);

    this.instances = instancesRes.data;
    const metrics = metricsRes.data;

    // Merge fund balance data into instances
    const allMetricsInstances = [...metrics.live.instances, ...metrics.analyzer.instances];
    const fundsMap = new Map();
    allMetricsInstances.forEach(mi => {
      fundsMap.set(mi.instance_id, {
        available_balance: mi.available_balance,
        realized_pnl: mi.realized_pnl,
        unrealized_pnl: mi.unrealized_pnl,
        total_pnl: mi.total_pnl,
      });
    });

    // Add fund data to instances
    this.instances = this.instances.map(instance => ({
      ...instance,
      ...(fundsMap.get(instance.id) || {
        available_balance: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        total_pnl: 0,
      }),
    }));

    // Telemetry summary
    const rateEntries = telemetryRateRes?.data || [];
    const cacheEntries = cacheStatusRes?.data?.entries || [];
    const telemetrySnapshot = this.computeTelemetrySnapshot(rateEntries, cacheEntries);
    this.lastTelemetry = {
      circuits: telemetrySnapshot.openCircuits,
      stale: telemetrySnapshot.staleCaches,
    };

    const telemetryCards = `
      <div class="flex flex-nowrap gap-3 mb-4 overflow-x-auto">
        <div class="stat-card min-w-[240px]" id="telemetry-card-circuits">
          <div class="stat-label">Circuits Open</div>
          <div class="stat-value" id="telemetry-circuits">${telemetrySnapshot.openCircuits}</div>
          <div class="stat-subtext text-xs text-neutral-500">Feeds paused due to failures</div>
        </div>
        <div class="stat-card min-w-[240px]" id="telemetry-card-stale">
          <div class="stat-label">Stale Caches</div>
          <div class="stat-value" id="telemetry-stale">${telemetrySnapshot.staleCaches}</div>
          <div class="stat-subtext text-xs text-neutral-500">Quotes/positions beyond TTL</div>
        </div>
        <div class="stat-card min-w-[240px]">
          <div class="stat-label">Orders/sec Headroom</div>
          <div class="stat-value" id="telemetry-orders-headroom">${telemetrySnapshot.minOrdersRemaining ?? 'n/a'}</div>
          <div class="stat-subtext text-xs text-neutral-500">Lowest remaining across instances</div>
        </div>
        <div class="stat-card min-w-[240px]">
          <div class="stat-label">RPS Headroom</div>
          <div class="stat-value" id="telemetry-rps-headroom">${telemetrySnapshot.minRpsRemaining ?? 'n/a'}</div>
          <div class="stat-subtext text-xs text-neutral-500">Lowest remaining across instances</div>
        </div>
      </div>
    `;

    // Render
    contentArea.innerHTML = `
      ${telemetryCards}
      <!-- Live Mode Stats (Primary) -->
      <div class="mb-4">
        <div class="flex items-center mb-2">
          <h2 class="text-xl font-semibold">Live Trading</h2>
          <span class="ml-2 px-2 py-1 text-xs font-semibold bg-green-100 text-green-800 rounded">LIVE</span>
        </div>
      <div class="stats-grid">
        <div class="stat-card pnl-card ${Utils.getPnLBgClass(metrics.live.total_pnl)}">
            <div class="stat-label">Total P&L</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_pnl)}">
              ${Utils.formatCurrency(metrics.live.total_pnl)}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Realized P&L</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_realized_pnl)}">
              ${Utils.formatCurrency(metrics.live.total_realized_pnl)}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Unrealized P&L</div>
            <div class="stat-value ${Utils.getPnLColorClass(metrics.live.total_unrealized_pnl)}">
              ${Utils.formatCurrency(metrics.live.total_unrealized_pnl)}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Available Balance</div>
            <div class="stat-value">
              ${Utils.formatCurrency(metrics.live.total_available_balance)}
            </div>
          </div>
        </div>
      </div>

      <!-- Analyzer Mode Stats (Secondary) -->
      ${metrics.analyzer.instances.length > 0 ? `
        <div class="mb-6">
          <div class="flex items-center mb-2">
            <h2 class="text-xl font-semibold text-neutral-600">Analyzer Mode</h2>
            <span class="ml-2 px-2 py-1 text-xs font-semibold bg-gray-200 text-gray-700 rounded">SIMULATION</span>
          </div>
          <div class="stats-grid opacity-75">
            <div class="stat-card bg-gray-50">
              <div class="stat-label">Total P&L</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_pnl)}">
                ${Utils.formatCurrency(metrics.analyzer.total_pnl)}
              </div>
            </div>

            <div class="stat-card bg-gray-50">
              <div class="stat-label">Realized P&L</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_realized_pnl)}">
                ${Utils.formatCurrency(metrics.analyzer.total_realized_pnl)}
              </div>
            </div>

            <div class="stat-card bg-gray-50">
              <div class="stat-label">Unrealized P&L</div>
              <div class="stat-value ${Utils.getPnLColorClass(metrics.analyzer.total_unrealized_pnl)}">
                ${Utils.formatCurrency(metrics.analyzer.total_unrealized_pnl)}
              </div>
            </div>

            <div class="stat-card bg-gray-50">
              <div class="stat-label">Available Balance</div>
              <div class="stat-value">
                ${Utils.formatCurrency(metrics.analyzer.total_available_balance)}
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- Instances Table -->
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Active Instances</h3>
          <button class="btn btn-buy btn-sm" onclick="app.showAddInstanceModal()">
            + Add Instance
          </button>
        </div>
        <div class="table-container">
          ${this.renderInstancesTable(this.instances)}
        </div>
      </div>
    `;

    this.applyTelemetrySnapshot(telemetrySnapshot);
    this.stopTelemetryRefresh();
    this.startTelemetryRefresh();
  }

  computeTelemetrySnapshot(rateEntries = [], cacheEntries = []) {
    const openCircuits = cacheEntries.filter((e) => e.circuitOpen).length;
    const staleCaches = cacheEntries.filter((e) => e.stale === true).length;
    const ordersRemaining = rateEntries
      .map((e) => e.budget?.remaining?.orders)
      .filter((v) => v !== null && v !== undefined);
    const rpsRemaining = rateEntries
      .map((e) => e.budget?.remaining?.rps)
      .filter((v) => v !== null && v !== undefined);

    return {
      openCircuits,
      staleCaches,
      minOrdersRemaining: ordersRemaining.length ? Math.min(...ordersRemaining) : null,
      minRpsRemaining: rpsRemaining.length ? Math.min(...rpsRemaining) : null,
    };
  }

  applyTelemetrySnapshot(snapshot) {
    const circuitsEl = document.getElementById('telemetry-circuits');
    const staleEl = document.getElementById('telemetry-stale');
    const ordersEl = document.getElementById('telemetry-orders-headroom');
    const rpsEl = document.getElementById('telemetry-rps-headroom');
    const cardCircuits = document.getElementById('telemetry-card-circuits');
    const cardStale = document.getElementById('telemetry-card-stale');

    if (circuitsEl) {
      circuitsEl.textContent = snapshot.openCircuits;
    }
    if (staleEl) {
      staleEl.textContent = snapshot.staleCaches;
    }
    if (ordersEl) {
      ordersEl.textContent =
        snapshot.minOrdersRemaining !== null && snapshot.minOrdersRemaining !== undefined
          ? snapshot.minOrdersRemaining
          : 'n/a';
    }
    if (rpsEl) {
      rpsEl.textContent =
        snapshot.minRpsRemaining !== null && snapshot.minRpsRemaining !== undefined
          ? snapshot.minRpsRemaining
          : 'n/a';
    }

    if (cardCircuits) {
      cardCircuits.classList.toggle('bg-warning/10', snapshot.openCircuits > 0);
      cardCircuits.classList.toggle('border-warning', snapshot.openCircuits > 0);
      cardCircuits.querySelector('.stat-value')?.classList.toggle('text-warning', snapshot.openCircuits > 0);
    }
    if (cardStale) {
      cardStale.classList.toggle('bg-error/10', snapshot.staleCaches > 0);
      cardStale.classList.toggle('border-error', snapshot.staleCaches > 0);
      cardStale.querySelector('.stat-value')?.classList.toggle('text-error', snapshot.staleCaches > 0);
    }
  }

  async refreshTelemetryCards() {
    if (this.currentView !== 'dashboard') {
      return;
    }
    try {
      const [rateRes, cacheRes] = await Promise.all([
        api.getTelemetryRateLimits().catch(() => ({ data: [] })),
        api.getTelemetryCacheStatus().catch(() => ({ data: { entries: [] } })),
      ]);
      const snapshot = this.computeTelemetrySnapshot(rateRes?.data || [], cacheRes?.data?.entries || []);
      this.applyTelemetrySnapshot(snapshot);

      if (snapshot.openCircuits > 0 && this.lastTelemetry.circuits === 0) {
        Utils.showToast(`Feed circuits opened (${snapshot.openCircuits})`, 'warning');
      }
      if (snapshot.staleCaches > 0 && this.lastTelemetry.stale === 0) {
        Utils.showToast(`Stale caches detected (${snapshot.staleCaches})`, 'error');
        // Opportunistic resync if on a data-heavy view
        if (['watchlists', 'positions'].includes(this.currentView)) {
          this.triggerSnapshotResync();
        }
      }
      this.lastTelemetry = {
        circuits: snapshot.openCircuits,
        stale: snapshot.staleCaches,
      };
    } catch (err) {
      console.warn('Telemetry refresh failed', err);
    }
  }

  startTelemetryRefresh() {
    this.stopTelemetryRefresh();
    this.telemetryInterval = setInterval(() => this.refreshTelemetryCards(), 20000);
  }

  stopTelemetryRefresh() {
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }

  /**
   * Render Instances View
   */
  async renderInstancesView() {
    const contentArea = document.getElementById('content-area');

    // Fetch instances and metrics
    const [instancesRes, metricsRes] = await Promise.all([
      api.getInstances(),
      api.getDashboardMetrics().catch(() => ({
        data: {
          live: { instances: [] },
          analyzer: { instances: [] },
        },
      })),
    ]);

    this.instances = instancesRes.data;
    const metrics = metricsRes.data;

    // Merge fund balance data into active instances only
    const allMetricsInstances = [...metrics.live.instances, ...metrics.analyzer.instances];
    const fundsMap = new Map();
    allMetricsInstances.forEach(mi => {
      fundsMap.set(mi.instance_id, {
        available_balance: mi.available_balance,
        realized_pnl: mi.realized_pnl,
        unrealized_pnl: mi.unrealized_pnl,
        total_pnl: mi.total_pnl,
      });
    });

    // Add fund data to active instances
    this.instances = this.instances.map(instance => ({
      ...instance,
      ...(instance.is_active && fundsMap.has(instance.id)
        ? fundsMap.get(instance.id)
        : {
            available_balance: null, // null indicates no data for inactive instances
            realized_pnl: instance.realized_pnl || 0,
            unrealized_pnl: instance.unrealized_pnl || 0,
            total_pnl: instance.total_pnl || 0,
          }),
    }));

    const searchValue = (this.instanceSearchQuery || '').toLowerCase();
    const filteredInstances = this.instances.filter(instance => {
      const haystack = [
        instance.name,
        instance.broker,
        instance.host_url,
        instance.market_data_role,
      ].join(' ').toLowerCase();
      return haystack.includes(searchValue);
    });

    contentArea.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">All Instances</h3>
          <button class="btn btn-buy" onclick="app.showAddInstanceModal()">
            + Add Instance
          </button>
        </div>
        <div class="p-4 flex items-center gap-3">
          <input
            type="text"
            class="form-input w-full max-w-md"
            placeholder="Search instances by name, broker, URL, or role..."
            value="${Utils.escapeHTML(this.instanceSearchQuery || '')}"
            oninput="app.handleInstanceSearch(this.value)"
          />
          <button class="btn btn-outline btn-sm" onclick="app.renderInstancesView()">Reset</button>
        </div>

        <!-- Bulk Actions Bar -->
        <div id="bulk-actions-bar" class="p-4 bg-neutral-50 border-b border-neutral-200" style="display: none;">
          <div class="flex items-center gap-4">
            <span id="selected-count" class="text-sm font-medium">0 selected</span>
            <div class="flex gap-2">
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.bulkSetActive(true)">
                Set Active
              </button>
              <button class="btn btn-neutral btn-outline btn-sm" onclick="app.bulkSetActive(false)">
                Set Inactive
              </button>
              <button class="btn btn-buy btn-sm" onclick="app.bulkSetAnalyzerMode(false)">
                Set Live Mode
              </button>
              <button class="btn btn-warning btn-sm" onclick="app.bulkSetAnalyzerMode(true)">
                Set Analyzer Mode
              </button>
            </div>
          </div>
        </div>

        <div class="table-container">
          ${this.renderInstancesTable(filteredInstances, true)}
        </div>
      </div>
    `;
  }

  /**
   * Render instances table
   */
  renderInstancesTable(instances, showBulkActions = false) {
    if (instances.length === 0) {
      return '<p class="text-center text-neutral-600">No instances found</p>';
    }

    // Fixed widths for consistent alignment (15 cols without bulk checkbox)
    // [Name, Broker, Status, Health, Mode, Limits, Live P&L, Analyzer P&L, Balance, Total P&L, Realized, Unrealized, Session Limits, Cutoff Reason, Actions]
    const baseColWidths = ['170px','120px','90px','90px','100px','100px','110px','110px','110px','110px','110px','110px','190px','110px','140px'];
    const colWidths = showBulkActions ? ['40px', ...baseColWidths] : baseColWidths;

    return `
      <table class="table instances-table">
        <colgroup>
          ${colWidths.map(w => `<col style="width:${w};">`).join('')}
        </colgroup>
        <thead>
            <tr>
              ${showBulkActions ? '<th><input type="checkbox" id="select-all-instances" onchange="app.toggleSelectAllInstances(this.checked)"></th>' : ''}
              <th>Name</th>
              <th>Broker</th>
              <th>Status</th>
              <th>Health</th>
              <th>Mode</th>
              <th>Limits</th>
              <th class="text-right">Live P&L</th>
              <th class="text-right">Analyzer P&L</th>
              <th class="text-right">Balance</th>
              <th class="text-right">Total P&L</th>
              <th class="text-right">Realized</th>
              <th class="text-right">Unrealized</th>
              <th>Session Limits</th>
              <th>Cutoff Reason</th>
              <th>Actions</th>
            </tr>
        </thead>
        <tbody>
          ${instances.map(instance => `
            <tr>
              ${showBulkActions ? `<td><input type="checkbox" class="instances-bulk-checkbox" data-instance-id="${instance.id}" onchange="app.updateBulkActionsState()"></td>` : ''}
              <td class="font-medium">${Utils.escapeHTML(instance.name)}</td>
              <td>${Utils.escapeHTML(instance.broker || 'N/A')}</td>
              <td>
                ${instance.is_active
                  ? '<span class="badge badge-success">Active</span>'
                  : '<span class="badge badge-neutral">Inactive</span>'}
              </td>
              <td>${Utils.getStatusBadge(instance.health_status || 'unknown')}</td>
              <td>
                ${instance.is_analyzer_mode
                  ? '<span class="badge badge-warning">Analyzer</span>'
                  : '<span class="badge badge-success">Live</span>'}
              </td>
              <td>${this.renderLimitBadge(instance.limit_metrics)}</td>
              <td class="text-right ${Utils.getPnLColorClass(instance.last_live_total_pnl)}">
                ${instance.last_live_total_pnl != null
                  ? Utils.formatCurrency(instance.last_live_total_pnl)
                  : '<span class="text-neutral-400">-</span>'}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.is_analyzer_mode ? instance.total_pnl : 0)}">
                ${instance.is_analyzer_mode
                  ? Utils.formatCurrency(instance.total_pnl || 0)
                  : '<span class="text-neutral-400">-</span>'}
              </td>
              <td class="text-right">
                ${instance.available_balance != null
                  ? Utils.formatCurrency(instance.available_balance)
                  : '<span class="text-neutral-400">-</span>'}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.total_pnl)}">
                ${Utils.formatCurrency(instance.total_pnl || 0)}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.realized_pnl)}">
                ${Utils.formatCurrency(instance.realized_pnl || 0)}
              </td>
              <td class="text-right ${Utils.getPnLColorClass(instance.unrealized_pnl)}">
                ${Utils.formatCurrency(instance.unrealized_pnl || 0)}
              </td>
              <td>
                <div class="text-sm">
                  <div><span class="text-neutral-500">Target:</span> ${instance.session_target_profit != null ? Utils.formatCurrency(instance.session_target_profit) : '—'}</div>
                  <div><span class="text-neutral-500">Max Loss:</span> ${instance.session_max_loss != null ? Utils.formatCurrency(instance.session_max_loss) : '—'}</div>
                </div>
              </td>
              <td>
                ${instance.session_cutoff_reason
                  ? `<div class="text-[11px] text-neutral-500 mt-1">${Utils.escapeHTML(instance.session_cutoff_reason.replace(/_/g, ' '))}</div>`
                  : '<span class="text-neutral-400">—</span>'}
              </td>
              <td>
                <div class="flex gap-2">
                  <button class="btn btn-neutral btn-outline btn-sm"
                          onclick="app.refreshInstance(${instance.id})"
                          title="Refresh">
                    🔄
                  </button>
                  <button class="btn btn-neutral btn-outline btn-sm"
                          onclick="app.showEditInstanceModal(${instance.id})">
                    Edit
                  </button>
                  <button class="btn btn-${instance.is_analyzer_mode ? 'success' : 'warning'} btn-sm"
                          onclick="app.toggleAnalyzerMode(${instance.id}, ${!instance.is_analyzer_mode})">
                    ${instance.is_analyzer_mode ? 'Go Live' : 'Analyzer'}
                  </button>
                  <button class="btn btn-exit btn-sm"
                          onclick="app.deleteInstance(${instance.id})">
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  renderLimitBadge(metrics) {
    if (!metrics) return '<span class="text-neutral-400">-</span>';
    const max404 = 20;
    const maxInvalid = 10;
    const { errors = {}, rate = {} } = metrics;
    const backoffActive = errors.backoffUntil && Date.now() < errors.backoffUntil;
    const near404 = errors.count404 >= max404 - 2;
    const nearInvalid = errors.countInvalid >= maxInvalid - 1;
    const hotRate = rate.rps >= 4 || rate.orders >= 8 || rate.rpm >= 250 || rate.globalRpm >= 280;

    let badgeClass = 'badge badge-success';
    let label = 'OK';
    const parts = [];
    parts.push(`404s: ${errors.count404 ?? 0}/${max404}`);
    parts.push(`Invalid: ${errors.countInvalid ?? 0}/${maxInvalid}`);
    parts.push(`RPS: ${rate.rps ?? 0}/5`);
    parts.push(`Orders/s: ${rate.orders ?? 0}/10`);

    if (backoffActive) {
      badgeClass = 'badge badge-error';
      label = 'Backoff';
    } else if (near404 || nearInvalid || hotRate) {
      badgeClass = 'badge badge-warning';
      label = 'Watch';
    }

    const title = parts.join(' • ');
    return `<span class="${badgeClass}" title="${Utils.escapeHTML(title)}">${label}</span>`;
  }

  /**
   * Render Watchlists View (Compact Redesigned Layout)
   */
  async renderWatchlistsView() {
    const contentArea = document.getElementById('content-area');

    if (window.quickOrder && typeof window.quickOrder.stopAllOptionPreviewPolling === 'function') {
      window.quickOrder.stopAllOptionPreviewPolling();
    }
    if (window.quickOrder && typeof window.quickOrder.stopAllFuturesPreviewPolling === 'function') {
      window.quickOrder.stopAllFuturesPreviewPolling();
    }

    this.stopPositionsPolling();

    try {
      // Fetch watchlists + instances in parallel to reduce latency
      const [watchlistsRes, instancesRes] = await Promise.all([
        api.getWatchlists(),
        api.getInstances(),
      ]);
      this.watchlists = watchlistsRes.data;
      this.resetWatchlistSymbolIndex();
      // Default to collapsed watchlists; user opt-in to load quotes/expansions
      this.expandedWatchlists = new Set();
      this.instances = instancesRes.data;
    } catch (error) {
      console.error('Failed to load watchlists view:', error);
      contentArea.innerHTML = `
        <div class="card">
          <div class="p-4 space-y-2">
            <h3 class="text-lg font-semibold text-loss">Unable to load watchlists</h3>
            <p class="text-sm text-neutral-600">${Utils.escapeHTML(error?.message || 'Network error')}</p>
            <button class="btn btn-buy btn-sm" onclick="app.renderWatchlistsView()">Retry</button>
          </div>
        </div>
      `;
      return;
    }

    contentArea.innerHTML = `
      <section class="watchlists-page-compact">
        <!-- Compact Toolbar -->
        <div class="watchlists-compact-toolbar">
          <div class="watchlists-toolbar-left">
            <h2 class="watchlists-title">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Watchlists
            </h2>
            <span class="watchlists-count">${this.watchlists.length} lists</span>
          </div>
          <div class="watchlists-toolbar-right">
            <button class="btn-icon" onclick="app.resyncQuotesFromSnapshots()" title="Resync quotes (snapshot)">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.5 12A7.5 7.5 0 116 6.75M6 6.75V3m0 3.75h3.75" />
              </svg>
            </button>
            <button class="btn btn-neutral btn-sm" onclick="app.showWsSubscriptions()" title="View WebSocket subscriptions">
              WS Subs
            </button>
            <button class="btn btn-outline btn-sm" onclick="app.toggleSnapshotResync()" title="Toggle auto snapshot resync">
              Auto Resync: ${this.autoSnapshotResyncEnabled ? 'On' : 'Off'}
            </button>
            <button class="btn-icon" onclick="app.renderWatchlistsView()" title="Refresh data">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h4M20 20v-5h-4M5 9a7 7 0 0112-4M19 15a7 7 0 01-12 4" />
              </svg>
            </button>
            <button class="btn-icon" onclick="app.togglePositionsPanel()" title="Toggle positions panel" id="toggle-positions-btn">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2-2v2m8 0V6a2 2 0 012 2v6a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2h8z" />
              </svg>
            </button>
            <button class="btn btn-buy btn-compact" onclick="app.showAddWatchlistModal()">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              Add Watchlist
            </button>
          </div>
        </div>

        <!-- Collapsible Positions Panel -->
        <div id="positions-panel-compact" class="positions-panel-compact collapsed">
          <div class="positions-panel-header">
            <div class="positions-panel-title">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2-2v2m8 0V6a2 2 0 012 2v6a2 2 0 01-2 2H8a2 2 0 01-2-2V8a2 2 0 012-2h8z" />
              </svg>
              Open Positions
            </div>
            <div id="positions-summary-inline" class="positions-summary-compact">
              <span class="text-neutral-500 text-xs">Loading…</span>
            </div>
            <div class="positions-panel-actions">
              <button class="btn-icon btn-sm" onclick="app.requestWatchlistRefresh({ showLoader: true, force: true })" title="Refresh">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h4M20 20v-5h-4M5 9a7 7 0 0112-4M19 15a7 7 0 01-12 4" />
                </svg>
              </button>
              <button class="btn btn-exit btn-sm btn-icon-only" onclick="app.closeAllOpenPositions()" title="Close All">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div id="watchlist-positions-panel" class="positions-panel-content">
            <div class="p-3 text-center text-neutral-500 text-sm">Loading positions...</div>
          </div>
        </div>

        <!-- Watchlists Grid -->
        <div id="watchlists-container" class="watchlists-grid-compact">
          ${await this.renderWatchlistsAccordion(this.watchlists, true)}
        </div>
      </section>
    `;

    const toggleBtn = document.getElementById('toggle-positions-btn');
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.setAttribute('aria-controls', 'positions-panel-compact');
    }

    // Populate positions summary once so the inline panel is not empty
    this.refreshWatchlistPositions({ showLoader: false });
    // Begin polling when the user expands the panel
  }

  /**
   * Render watchlists as accordion cards
   */
  async renderWatchlistsAccordion(watchlists, setupListeners = false) {
    if (watchlists.length === 0) {
      return `
        <div class="watchlists-empty">
          <h4 class="text-lg font-semibold">No watchlists yet</h4>
          <p>Create your first watchlist to start tracking instruments.</p>
          <button class="btn btn-buy btn-sm mt-2" onclick="app.showAddWatchlistModal()">
            + Create Watchlist
          </button>
        </div>
      `;
    }

    const cardsHTML = [];
    for (const wl of watchlists) {
      const isExpanded = this.expandedWatchlists.has(wl.id);
      cardsHTML.push(await this.renderWatchlistCard(wl, isExpanded));
    }

    const html = cardsHTML.join('');

    // If requested, setup listeners for expanded watchlists
    if (setupListeners) {
      setTimeout(() => {
        watchlists.forEach(wl => {
          if (this.expandedWatchlists.has(wl.id)) {
            this.setupExpansionToggleListeners(wl.id);
          }
        });
      }, 100);
    }

    return html;
  }

  isBroadcastWatchlist(watchlist) {
    if (!watchlist) return false;
    const type = (watchlist.type || '').toLowerCase();
    return Boolean(watchlist.is_broadcast || type === 'broadcast');
  }

  /**
   * Render individual watchlist card with compact layout
   */
  async renderWatchlistCard(wl, isExpanded) {
    const statusColor = wl.is_active ? 'success' : 'neutral';
    const isBroadcast = this.isBroadcastWatchlist(wl);
    const typeBadge = isBroadcast ? '<span class="watchlist-card-compact__badge info">Broadcast</span>' : '';
    const metaText = isBroadcast
      ? `${wl.instance_count || 0} instances • TradingView webhook`
      : `${wl.symbol_count || 0} symbols • ${wl.instance_count || 0} instances`;

    return `
      <article class="watchlist-card-compact" data-watchlist-id="${wl.id}">
        <div class="watchlist-card-compact__header">
          <button
            id="watchlist-toggle-${wl.id}"
            class="watchlist-card-compact__toggle ${isExpanded ? 'is-open' : ''}"
            aria-expanded="${isExpanded}"
            onclick="app.toggleWatchlist(${wl.id})"
            title="Expand/Collapse"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div class="watchlist-card-compact__info">
            <div class="watchlist-card-compact__title-row">
              <h4 class="watchlist-card-compact__name">${Utils.escapeHTML(wl.name)}</h4>
              <span class="watchlist-card-compact__badge ${statusColor}">
                ${wl.is_active ? 'Active' : 'Paused'}
              </span>
              ${typeBadge}
              <span class="watchlist-card-compact__meta">
                ${metaText}
              </span>
            </div>
            ${wl.description ? `<p class="watchlist-card-compact__desc">${Utils.escapeHTML(wl.description)}</p>` : ''}
          </div>
          <div class="watchlist-card-compact__actions">
            ${isBroadcast ? '' : `
              <button class="btn-icon-compact" onclick="app.showAddSymbolModal(${wl.id})" title="Add Symbol">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                </svg>
              </button>
            `}
            <button class="btn-icon-compact" onclick="app.showEditWatchlistModal(${wl.id})" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="btn-icon-compact" onclick="app.manageWatchlistInstances(${wl.id})" title="Instances">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </button>
            <button class="btn-icon-compact danger" onclick="app.deleteWatchlist(${wl.id})" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>

        <div id="watchlist-content-${wl.id}" class="watchlist-card-compact__body ${isExpanded ? 'is-visible' : ''}">
          <div id="watchlist-symbols-${wl.id}">
            ${isExpanded ? await this.renderWatchlistSymbols(wl.id) : '<p class="text-neutral-600 text-sm p-3">Loading...</p>'}
          </div>
        </div>
      </article>
    `;
  }

  /**
   * Toggle positions panel visibility
   */
  togglePositionsPanel() {
    const panel = document.getElementById('positions-panel-compact');
    const btn = document.getElementById('toggle-positions-btn');
    if (panel) {
      const isCollapsed = panel.classList.toggle('collapsed');
      if (btn) {
        btn.classList.toggle('active', !isCollapsed);
        btn.setAttribute('aria-expanded', String(!isCollapsed));
        btn.setAttribute('aria-controls', 'positions-panel-compact');
      }
      if (!isCollapsed) {
        this.startPositionsPolling({ immediate: true });
      } else {
        this.stopPositionsPolling();
      }
    }
  }

  async resyncQuotesFromSnapshots() {
    try {
      await api.getQuoteSnapshots({ refresh: true });
      const expandedIds = Array.from(this.expandedWatchlists || []);
      for (const wlId of expandedIds) {
        await this.updateWatchlistQuotes(wlId, { force: true });
      }
      Utils.showToast('Quotes resynced from snapshots', 'success');
    } catch (error) {
      console.error('Failed to resync quotes', error);
      Utils.showToast('Failed to resync quotes', 'error');
    }
  }

  async triggerSnapshotResync() {
    if (this.isSnapshotResyncing) return;
    this.isSnapshotResyncing = true;
    try {
      if (this.currentView === 'watchlists') {
        await this.resyncQuotesFromSnapshots();
      } else if (this.currentView === 'positions') {
        await this.resyncAllPositionsFromSnapshots();
      }
      this.lastSnapshotResyncAt = Date.now();
    } finally {
      this.isSnapshotResyncing = false;
    }
  }

  startSnapshotResync(viewName) {
    this.stopSnapshotResync();
    // Only start for targeted views
    if (!['watchlists', 'positions'].includes(viewName)) return;
    if (!this.autoSnapshotResyncEnabled) return;
    const intervalMs = 60000; // 60s gentle resync
    this.snapshotResyncInterval = setInterval(() => {
      // Avoid hammering while paused or busy
      if (this.isPaused || this.isSnapshotResyncing) return;
      this.triggerSnapshotResync();
    }, intervalMs);
  }

  stopSnapshotResync() {
    if (this.snapshotResyncInterval) {
      clearInterval(this.snapshotResyncInterval);
      this.snapshotResyncInterval = null;
    }
  }

  /**
   * Toggle watchlist expansion
   */
  async toggleWatchlist(watchlistId) {
    const contentDiv = document.getElementById(`watchlist-content-${watchlistId}`);
    const symbolsDiv = document.getElementById(`watchlist-symbols-${watchlistId}`);
    const toggleButton = document.getElementById(`watchlist-toggle-${watchlistId}`);

    if (!contentDiv || !toggleButton) return;

    if (this.expandedWatchlists.has(watchlistId)) {
      // Collapse
      this.expandedWatchlists.delete(watchlistId);
      contentDiv.classList.remove('is-visible');
      toggleButton.classList.remove('is-open');
      toggleButton.setAttribute('aria-expanded', 'false');

      // Stop polling for this watchlist
      this.stopWatchlistPolling(watchlistId);
    } else {
      // Expand
      this.expandedWatchlists.add(watchlistId);
      contentDiv.classList.add('is-visible');
      toggleButton.classList.add('is-open');
      toggleButton.setAttribute('aria-expanded', 'true');

      // Render symbols if not already rendered
      if (symbolsDiv && symbolsDiv.innerHTML.includes('Loading...')) {
        symbolsDiv.innerHTML = await this.renderWatchlistSymbols(watchlistId);
        // Setup event listeners for expansion toggles after symbols are rendered
        this.setupExpansionToggleListeners(watchlistId);
      }

      // Start polling after DOM is ready
      if (!this.isBroadcastWatchlist((this.watchlists || []).find((w) => w.id === watchlistId))) {
        this.startWatchlistPolling(watchlistId);
      }
    }
  }

  /**
   * Render symbols for a watchlist
   */
  async renderWatchlistSymbols(watchlistId) {
    try {
      const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
      if (this.isBroadcastWatchlist(watchlist)) {
        return await this.renderBroadcastWatchlist(watchlistId);
      }

      const response = await api.getWatchlistSymbols(watchlistId);
      const symbols = response.data;
      this.registerWatchlistSymbols(watchlistId, symbols);

      if (symbols.length === 0) {
        return '<p class="text-neutral-600 text-sm">No symbols added yet</p>';
      }

      return `
        <div class="watchlist-feed-meta-compact" data-watchlist-meta="${watchlistId}">
          <span class="text-xs text-neutral-500">Quotes auto-refresh</span>
          <span class="text-xs text-neutral-500" data-watchlist-last-update="${watchlistId}">waiting…</span>
          <span class="text-xs text-neutral-500" data-watchlist-feed-source="${watchlistId}">—</span>
          <span class="text-xs text-neutral-500" data-watchlist-feed-coverage="${watchlistId}"></span>
        </div>
        <div class="watchlist-table-wrapper">
          <table class="watchlist-table-compact" id="watchlist-table-${watchlistId}">
            <thead>
              <tr>
                <th class="col-expand"></th>
                <th class="col-symbol">Symbol</th>
                <th class="col-exchange">Exch</th>
                <th class="col-type">Type</th>
                <th class="col-expiry">Expiry</th>
                <th class="col-strike">Strike</th>
                <th class="col-lot">Lot</th>
                <th class="col-ltp">LTP</th>
                <th class="col-change">Change</th>
                <th class="col-volume">Vol</th>
                <th class="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${symbols.map(sym => `
                <tr class="symbol-row-compact"
                    data-symbol-id="${sym.id}"
                    data-symbol="${Utils.escapeHTML(sym.symbol)}"
                    data-exchange="${Utils.escapeHTML(sym.exchange)}"
                    data-symbol-type="${Utils.escapeHTML(sym.symbol_type || 'UNKNOWN')}"
                    data-trading-symbol="${Utils.escapeHTML(sym.trading_symbol || sym.tradingsymbol || '')}"
                    data-tradable-equity="${sym.tradable_equity ? 1 : 0}"
                    data-tradable-futures="${sym.tradable_futures ? 1 : 0}"
                    data-tradable-options="${sym.tradable_options ? 1 : 0}"
                    data-underlying="${Utils.escapeHTML(sym.underlying_symbol || sym.name || sym.symbol)}">
                  <td class="col-expand">
                    <button
                      class="btn-expand-compact"
                      data-watchlist-id="${watchlistId}"
                      data-symbol-id="${sym.id}"
                      data-toggle-symbol="${sym.id}"
                      type="button"
                      title="Expand trading controls">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </td>
                  <td class="col-symbol">${Utils.escapeHTML(sym.symbol)}</td>
                  <td class="col-exchange">${Utils.escapeHTML(sym.exchange)}</td>
                  <td class="col-type">
                    <span class="badge-compact ${this.getSymbolTypeBadgeClass(sym.symbol_type || 'UNKNOWN')}">
                      ${sym.symbol_type || 'UNKNOWN'}
                    </span>
                  </td>
                  <td class="col-expiry">${sym.expiry ? Utils.escapeHTML(sym.expiry) : '-'}</td>
                  <td class="col-strike">${sym.strike ? sym.strike : '-'}</td>
                  <td class="col-lot">${sym.lot_size || 1}</td>
                  <td class="col-ltp ltp-cell" data-symbol-id="${sym.id}">
                    <span class="text-neutral-500">-</span>
                  </td>
                  <td class="col-change change-cell" data-symbol-id="${sym.id}">
                    <span class="text-neutral-500">-</span>
                  </td>
                  <td class="col-volume volume-cell" data-symbol-id="${sym.id}">
                    <span class="text-neutral-500">-</span>
                  </td>
                  <td class="col-actions">
                    <div class="actions-group">
                      <button class="btn-icon-table" onclick="app.showEditSymbolModal(${watchlistId}, ${sym.id})" title="Edit">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button class="btn-icon-table danger" onclick="app.removeSymbol(${watchlistId}, ${sym.id})" title="Remove">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
                <tr id="expansion-row-${sym.id}" class="expansion-row-compact" style="display: none;">
                  <td colspan="11" class="expansion-cell-compact">
                    <div id="expansion-content-${sym.id}" class="expansion-content" data-loaded="false">
                      <p class="text-neutral-500 text-sm">Loading...</p>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (error) {
      const message = Utils.escapeHTML(error?.message || 'Unknown error');
      return `<p class="text-error">Failed to load symbols: ${message}</p>`;
    }
  }

  async showWsSubscriptions() {
    try {
      const res = await api.request('/telemetry/ws-subscriptions');
      const subs = res?.data || [];
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      const content = subs.map((s) => `
        <details class="border border-base-200 rounded-lg p-3 bg-base-100">
          <summary class="flex items-center justify-between gap-2 cursor-pointer">
            <div>
              <div class="font-semibold">${Utils.escapeHTML(s.instanceName || `Instance ${s.instanceId}`)}</div>
              <div class="text-xs text-neutral-500">${Utils.escapeHTML(s.websocketUrl || 'ws unavailable')}</div>
            </div>
            <div class="text-xs text-neutral-500">${s.subscriptionCount || 0} symbols · ${s.connected ? 'Connected' : 'Disconnected'}</div>
          </summary>
          ${s.symbols && s.symbols.length ? `
            <div class="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              ${s.symbols.slice(0, 200).map(sym => `<span class="badge badge-neutral">${Utils.escapeHTML(sym.exchange || '')}:${Utils.escapeHTML(sym.symbol || '')}</span>`).join('')}
            </div>
            ${s.symbols.length > 200 ? `<p class="text-xs text-neutral-500 mt-2">+${s.symbols.length - 200} more…</p>` : ''}
          ` : '<p class="text-xs text-neutral-500 mt-2">No symbols subscribed</p>'}
        </details>
      `).join('');

      modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
          <div class="modal-header">
            <h3>WebSocket Subscriptions</h3>
          </div>
          <div class="modal-body space-y-3" style="max-height: 70vh; overflow-y: auto;">
            ${content || '<p class="text-neutral-600 text-sm">No WebSocket subscriptions found.</p>'}
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">Close</button>
          </div>
        </div>
      `;

      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });
      document.body.appendChild(modal);
    } catch (err) {
      Utils.showToast(err?.message || 'Failed to load WS subscriptions', 'error');
    }
  }

  async renderBroadcastWatchlist(watchlistId) {
    const { data: watchlist } = await api.getWatchlistById(watchlistId);
    const instances = watchlist.instances || [];
    const token = (window.WEBHOOK_TOKEN || '') || (window.appConfig?.webhookToken || '');
    const baseUrl = window.location.origin.replace(/\/$/, '');
    const cleanUrl = watchlist.webhook_url || `${baseUrl}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;
    const webhookUrl = token ? `${cleanUrl}?token=${encodeURIComponent(token)}` : cleanUrl;

    const instanceList = instances.length
      ? `
        <ul class="list">
          ${instances.map((inst) => `
            <li class="list-item">
              <div>
                <div class="font-medium">${Utils.escapeHTML(inst.name || inst.host_url)}</div>
                <div class="text-xs text-neutral-500">${Utils.escapeHTML(inst.host_url)}</div>
              </div>
              <span class="badge ${inst.is_active ? 'badge-success' : 'badge-neutral'}">
                ${inst.is_active ? 'Active' : 'Paused'}
              </span>
            </li>
          `).join('')}
        </ul>
      `
      : '<p class="text-neutral-600 text-sm">No instances assigned yet.</p>';

    const samplePayload = `{
  "strategy": "tv-broadcast",
  "exchange": "NFO",
  "symbol": "NIFTY23DEC2525900CE",
  "action": "BUY",
  "position_size": 1,
  "quantity": 1
}`;

    return `
      <div class="card p-4 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm text-neutral-500">TradingView Broadcast Webhook</p>
            <h4 class="text-lg font-semibold">Fan-out to ${instances.length} instance${instances.length === 1 ? '' : 's'}</h4>
         </div>
         <span class="badge badge-info">Broadcast</span>
        </div>

        <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs text-neutral-500">Webhook URL${token ? ' (token included via query)' : ''}</p>
              <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
            </div>
            <button class="btn btn-neutral btn-sm" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs text-neutral-500">Watchlist Slug</p>
              <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
            </div>
            ${watchlist.webhook_slug ? `<button class="btn btn-neutral btn-sm" onclick="Utils.copyToClipboard('${watchlist.webhook_slug}')">Copy Slug</button>` : ''}
          </div>
          <p class="text-xs text-neutral-500">Send TradingView alerts to this URL${token ? ' (token query included)' : ' and include header X-Webhook-Token'}.</p>
        </div>

        <div class="grid md:grid-cols-2 gap-4">
          <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
            <div class="flex items-center justify-between">
              <h5 class="font-semibold">Assigned Instances</h5>
              <button class="btn btn-outline btn-sm" onclick="app.manageWatchlistInstances(${watchlistId})">Manage</button>
            </div>
            ${instanceList}
          </div>
          <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
            <div class="flex items-center justify-between">
              <h5 class="font-semibold">Sample Payload</h5>
              <button class="btn btn-neutral btn-sm" onclick="Utils.copyToClipboard('${samplePayload.replace(/\n/g, '\\n').replace(/\"/g, '\\\"')}')">Copy JSON</button>
            </div>
            <pre class="code-block" style="white-space: pre-wrap;">${samplePayload}</pre>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Get badge class for symbol type with pastel highlights
   */
  getSymbolTypeBadgeClass(type) {
    const classes = {
      INDEX: 'badge badge-info',       // Indices - light blue pastel
      EQUITY: 'badge badge-buy',        // Equity stocks - light green pastel
      FUTURES: 'badge badge-sell',      // Futures contracts - light orange pastel
      OPTIONS: 'badge badge-neutral',   // Options contracts - light purple/neutral pastel
      UNKNOWN: 'badge badge-neutral',   // Unknown/unclassified
    };
    return classes[type] || 'badge badge-neutral';
  }

  /**
   * Setup event listeners for watchlist expansion toggles
   */
  setupExpansionToggleListeners(watchlistId) {
    // Use event delegation on the table for better performance
    const table = document.getElementById(`watchlist-table-${watchlistId}`);
    if (!table) return;

    // Remove existing listener if present to avoid duplicates
    if (table._expansionListener) {
      table.removeEventListener('click', table._expansionListener);
    }

    table._expansionListener = (event) => {
      const button = event.target.closest('.btn-toggle-expansion, .btn-expand-compact');
      if (button) {
        const wlId = parseInt(button.dataset.watchlistId);
        const symId = parseInt(button.dataset.symbolId);
      // debug removed
        this.handleSymbolToggle(wlId, symId);
      }
    };

    table.addEventListener('click', table._expansionListener);
  }

  handleSymbolToggle(watchlistId, symbolId) {
    // Best-effort cache warmup for quotes/positions to reduce first-click latency
    try {
      const row = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      const symbol = row?.dataset?.symbol;
      const exchange = row?.dataset?.exchange;
      if (symbol && exchange && window.api && typeof api.getMarketData === 'function') {
        api.getMarketData(exchange, symbol).catch(() => {});
      }
    } catch (_) {
      // non-blocking
    }

    const handler = window.quickOrder;
    if (!handler || typeof handler.toggleRowExpansion !== 'function') {
      console.error('[Watchlist] quickOrder handler not ready', { watchlistId, symbolId });
      if (window.Utils && typeof Utils.showToast === 'function') {
        Utils.showToast('Trading controls not ready yet. Please reload the page.', 'error');
      }
      return;
    }

    try {
      handler.toggleRowExpansion(watchlistId, symbolId);
    } catch (error) {
      console.error('Failed to toggle symbol expansion', { watchlistId, symbolId, error });
      if (window.Utils && typeof Utils.showToast === 'function') {
        Utils.showToast(`Failed to open trading controls: ${error.message}`, 'error');
      }
    }
  }

  /**
   * Start polling quotes for a watchlist
   */
  async startWatchlistPolling(watchlistId) {
    const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
    if (this.isBroadcastWatchlist(watchlist)) return;
    if (this.isPaused) return;
    // Stop existing poller if any
    this.stopWatchlistPolling(watchlistId);

    // Fetch quotes immediately
    await this.updateWatchlistQuotes(watchlistId, { force: true });

    // Start 10-second polling
    const intervalId = setInterval(async () => {
      if (this.isPaused) return;
      await this.updateWatchlistQuotes(watchlistId);
    }, 10000);

    this.watchlistPollers.set(watchlistId, intervalId);
  }

  /**
   * Stop polling quotes for a watchlist
   */
  stopWatchlistPolling(watchlistId) {
    if (this.watchlistPollers.has(watchlistId)) {
      clearInterval(this.watchlistPollers.get(watchlistId));
      this.watchlistPollers.delete(watchlistId);
    }
    // Clear quote cache for this watchlist
    this.clearWatchlistQuoteCache(watchlistId);
    this.watchlistQuoteSnapshots.delete(watchlistId);
    this.updateWatchlistQuoteMeta(watchlistId, { statusText: 'Quotes paused' });
  }

  /**
   * Stop all watchlist polling intervals
   */
  stopAllWatchlistPolling() {
    this.watchlistPollers.forEach((intervalId, watchlistId) => {
      clearInterval(intervalId);
    });
    this.watchlistPollers.clear();
    // Clear all quote caches
    this.quoteCache.clear();
  }

  /**
   * Clear quote cache for a specific watchlist
   */
  clearWatchlistQuoteCache(watchlistId) {
    // Remove all cache entries for this watchlist
    const keysToDelete = [];
    for (const key of this.quoteCache.keys()) {
      if (key.startsWith(`${watchlistId}_`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.quoteCache.delete(key));
  }

  startPositionsPolling({ immediate = false } = {}) {
    if (this.positionsPollingInterval) return;
    if (immediate) {
      this.requestWatchlistRefresh({ showLoader: true, force: true });
    }
    this.positionsPollingInterval = setInterval(() => {
      this.requestWatchlistRefresh();
    }, 10000);
  }

  stopPositionsPolling() {
    if (this.positionsPollingInterval) {
      clearInterval(this.positionsPollingInterval);
      this.positionsPollingInterval = null;
    }
  }

  requestWatchlistRefresh({ showLoader = false, force = false } = {}) {
    if (this.isPaused && !force) {
      return;
    }
    if (force) {
      this.refreshWatchlistPositions({ showLoader });
      return;
    }

    this._throttledWatchlistRefresh({ showLoader });
  }

  async updateWatchlistQuotes(watchlistId, { force = false } = {}) {
    if (this.isPaused && !force) return;
    try {
      // Check if watchlist table exists in DOM (view might be re-rendering)
      const table = document.getElementById(`watchlist-table-${watchlistId}`);
      if (!table) {
      // debug removed
        return;
      }

      // Get watchlist symbols
      const response = await api.getWatchlistSymbols(watchlistId);
      const symbols = response.data;

      if (symbols.length === 0) {
        this.updateWatchlistQuoteMeta(watchlistId, { statusText: 'No symbols configured' });
        return;
      }

      // Get pooled market data instances (global, not watchlist bound)
      const mdResp = await api.getAllMarketDataInstances();
      const mdInstances = (mdResp.data || []).filter(inst => inst.is_active);
      if (mdInstances.length === 0) {
        this.updateWatchlistQuoteMeta(watchlistId, {
          statusText: 'No market data instances available',
          source: null,
          total: symbols.length,
          filled: 0,
        });
        return;
      }

      // Prepare symbols array for quotes API
      const symbolsForQuotes = symbols.map(s => ({
        exchange: s.exchange,
        symbol: s.symbol
      }));

      // Batch and distribute across instances (3–5 per request, round-robin)
      const batchSize = Math.max(3, Math.min(5, Math.ceil(symbolsForQuotes.length / mdInstances.length)));
      const chunks = this.chunkArray(symbolsForQuotes, batchSize);
      let allQuotes = [];
      for (let i = 0; i < chunks.length; i++) {
        const inst = mdInstances[i % mdInstances.length];
        try {
          const resp = await api.getQuotes(chunks[i], inst.id);
          if (resp?.data?.length) {
            allQuotes = allQuotes.concat(resp.data);
          }
        } catch (err) {
          console.warn('Quote batch failed for instance', inst.name, err.message);
        }
      }

      const snapshotTimestamp = Date.now();

      this.updateWatchlistQuoteMeta(watchlistId, {
        timestamp: snapshotTimestamp,
        source: 'live',
        total: symbols.length,
        filled: allQuotes.length,
      });

      const lastSnapshotTs = this.watchlistQuoteSnapshots.get(watchlistId);
      if (!force && lastSnapshotTs && snapshotTimestamp && snapshotTimestamp <= lastSnapshotTs) {
        return;
      }

      this.watchlistQuoteSnapshots.set(watchlistId, snapshotTimestamp);

      // Update UI for each symbol
      allQuotes.forEach(quote => {
        const hydratedQuote = this.hydrateQuoteWithLtp(quote, snapshotTimestamp);
        const normalizedQuoteSymbol = this.normalizeQuoteSymbol(hydratedQuote.symbol);
        const symbol = symbols.find(s => {
          const exactMatch = s.exchange === hydratedQuote.exchange;
          const normalizedMatch =
            this.normalizeExchange(s.exchange) === this.normalizeExchange(hydratedQuote.exchange);

          return (exactMatch || normalizedMatch) && s.symbol === normalizedQuoteSymbol;
        });

        if (symbol) {
          this.updateSymbolQuote(watchlistId, symbol.id, hydratedQuote);
        }
      });
    } catch (error) {
      console.error('Failed to update watchlist quotes', error);
      this.updateWatchlistQuoteMeta(watchlistId, {
        statusText: 'Quote refresh failed',
      });
    }
  }

  normalizeExchange(exchange = '') {
    const normalized = (exchange || '').trim().toUpperCase();
    if (!normalized) return '';
    if (normalized.endsWith('_INDEX')) {
      return normalized.replace('_INDEX', '');
    }
    return normalized;
  }

  normalizeQuoteSymbol(symbol = '') {
    if (!symbol) return '';
    const normalized = symbol.toUpperCase();
    if (normalized.includes(':')) {
      return normalized.split(':').pop();
    }
    return normalized;
  }

  buildWatchlistSymbolKey(exchange, symbol) {
    const segmentMap = {
      1: 'NSE',
      2: 'NFO',
      3: 'BSE',
      4: 'BFO',
      5: 'MCX',
    };
    let exchInput = exchange;
    if (typeof exchInput === 'number') {
      exchInput = segmentMap[exchInput] || String(exchInput);
    }
    const exch = this.normalizeExchange(exchInput);
    const sym = this.normalizeQuoteSymbol(symbol);
    if (!exch || !sym) return null;
    return `${exch}|${sym}`;
  }

  extractQuoteKeys(quote = {}) {
    const exchange = quote.exchange || quote.exch || quote.exchange_segment || quote.exchangeSegment;
    const candidateSymbols = [
      quote.symbol,
      quote.trading_symbol,
      quote.tradingSymbol,
      quote.tradingsymbol,
    ];
    const keys = new Set();
    candidateSymbols.forEach((sym) => {
      const key = this.buildWatchlistSymbolKey(exchange, sym);
      if (key) keys.add(key);
    });
    return Array.from(keys);
  }

  cacheQuoteLtp(keys = [], ltp, ts = Date.now()) {
    if (typeof ltp !== 'number' || Number.isNaN(ltp)) return;
    keys.forEach((key) => {
      this.latestLtpByKey.set(key, { ltp, ts });
    });
  }

  resolveFreshLtp(keys = [], now = Date.now()) {
    for (const key of keys) {
      const entry = this.latestLtpByKey.get(key);
      if (!entry) continue;
      const isNumber = typeof entry.ltp === 'number' && !Number.isNaN(entry.ltp);
      const isFresh = entry.ts && now - entry.ts <= this.ltpCacheTtlMs;
      if (isNumber && isFresh) {
        return entry;
      }
      if (!isFresh) {
        this.latestLtpByKey.delete(key);
      }
    }
    return null;
  }

  hydrateQuoteWithLtp(quote = {}, receivedAt = Date.now()) {
    const hydrated = { ...quote };
    const keys = this.extractQuoteKeys(quote);
    if (!keys.length) return hydrated;

    const hasLtp = typeof hydrated.ltp === 'number' && !Number.isNaN(hydrated.ltp);
    if (hasLtp) {
      this.cacheQuoteLtp(keys, hydrated.ltp, receivedAt);
      hydrated.ltpTs = receivedAt;
      return hydrated;
    }

    const fallback = this.resolveFreshLtp(keys, receivedAt);
    if (fallback) {
      hydrated.ltp = fallback.ltp;
      hydrated.ltpTs = fallback.ts;
    }
    return hydrated;
  }

  resetWatchlistSymbolIndex() {
    this.watchlistSymbolIndex = new Map();
    this.watchlistSymbolIndexByWatchlist = new Map();
  }

  registerWatchlistSymbols(watchlistId, symbols = []) {
    if (!watchlistId) return;
    const previousEntries = this.watchlistSymbolIndexByWatchlist.get(watchlistId) || [];
    previousEntries.forEach(({ key, symbolId }) => {
      const list = this.watchlistSymbolIndex.get(key);
      if (!list) return;
      const filtered = list.filter((entry) => entry.watchlistId !== watchlistId || entry.symbolId !== symbolId);
      if (filtered.length) {
        this.watchlistSymbolIndex.set(key, filtered);
      } else {
        this.watchlistSymbolIndex.delete(key);
      }
    });

    const newEntries = [];
    symbols.forEach((sym) => {
      const candidates = [
        this.buildWatchlistSymbolKey(sym.exchange, sym.symbol),
        this.buildWatchlistSymbolKey(sym.exchange, sym.trading_symbol || sym.tradingsymbol),
      ].filter(Boolean);

      candidates.forEach((key) => {
        const existing = this.watchlistSymbolIndex.get(key) || [];
        if (!existing.find((e) => e.watchlistId === watchlistId && e.symbolId === sym.id)) {
          existing.push({ watchlistId, symbolId: sym.id });
          this.watchlistSymbolIndex.set(key, existing);
          newEntries.push({ key, symbolId: sym.id });
        }
      });
    });

    this.watchlistSymbolIndexByWatchlist.set(watchlistId, newEntries);
  }

  chunkArray(arr = [], size = 5) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Update quote display for a specific symbol
   * Uses caching to prevent unnecessary DOM updates and adds visual highlights on changes
   */
  updateSymbolQuote(watchlistId, symbolId, quote) {
    // Find the table cells for this symbol
    const ltpCell = document.querySelector(
      `#watchlist-table-${watchlistId} .ltp-cell[data-symbol-id="${symbolId}"]`
    );
    const changeCell = document.querySelector(
      `#watchlist-table-${watchlistId} .change-cell[data-symbol-id="${symbolId}"]`
    );
    const volumeCell = document.querySelector(
      `#watchlist-table-${watchlistId} .volume-cell[data-symbol-id="${symbolId}"]`
    );

    if (!ltpCell || !changeCell || !volumeCell) return;

    // Create cache key
    const cacheKey = `${watchlistId}_${symbolId}`;
    const cached = this.quoteCache.get(cacheKey) || {};
    const now = Date.now();

    // Calculate change percent
    let changePercent = null;
    if (quote.ltp !== undefined && quote.prev_close !== undefined && quote.prev_close > 0) {
      changePercent = ((quote.ltp - quote.prev_close) / quote.prev_close) * 100;
    }

    // Helper to check if cell has placeholder or is empty
    const hasPlaceholder = (cell) => {
      const text = cell.textContent.trim();
      return text === '-' || text === '' || text === '—';
    };

    // Helper to add highlight animation
    const addHighlight = (cell, animationClass) => {
      cell.classList.remove('value-updated', 'value-profit-updated', 'value-loss-updated');
      // Force reflow to restart animation
      void cell.offsetWidth;
      cell.classList.add(animationClass);
    };

    // Helper to get or create span element
    const getOrCreateSpan = (cell, className = '') => {
      let span = cell.querySelector('span');
      if (!span) {
        span = document.createElement('span');
        if (className) span.className = className;
        cell.innerHTML = '';
        cell.appendChild(span);
      }
      return span;
    };

    const ltpIsNumber = typeof quote.ltp === 'number' && !Number.isNaN(quote.ltp);
    let resolvedLtp = ltpIsNumber ? quote.ltp : null;
    let resolvedLtpTs = typeof quote.ltpTs === 'number' ? quote.ltpTs : now;

    if (resolvedLtp === null) {
      const cachedFresh = cached.ltpTs && now - cached.ltpTs <= this.ltpCacheTtlMs;
      const cachedIsNumber = typeof cached.ltp === 'number' && !Number.isNaN(cached.ltp);
      if (cachedFresh && cachedIsNumber) {
        resolvedLtp = cached.ltp;
        resolvedLtpTs = cached.ltpTs;
      } else if (cached.ltpTs && now - cached.ltpTs > this.ltpCacheTtlMs) {
        cached.ltp = undefined;
        cached.ltpTs = undefined;
      }
    }

    // Update LTP if changed OR cell is empty/placeholder
    if (resolvedLtp !== null && resolvedLtp !== undefined && (cached.ltp !== resolvedLtp || hasPlaceholder(ltpCell))) {
      const valueChanged = cached.ltp !== resolvedLtp && !hasPlaceholder(ltpCell);
      const span = getOrCreateSpan(ltpCell, 'font-medium');
      span.textContent = `₹${Utils.formatNumber(resolvedLtp)}`;

      // Add highlight animation if value actually changed
      if (valueChanged) {
        addHighlight(ltpCell, 'value-updated');
      }

      cached.ltp = resolvedLtp;
      cached.ltpTs = resolvedLtpTs;
    } else if (resolvedLtp === null || resolvedLtp === undefined) {
      ltpCell.textContent = '-';
      cached.ltp = undefined;
      cached.ltpTs = undefined;
    }

    // Update % change if changed OR cell is empty/placeholder
    if (changePercent !== null && (cached.changePercent !== changePercent || hasPlaceholder(changeCell))) {
      const valueChanged = cached.changePercent !== changePercent && !hasPlaceholder(changeCell);
      const changeClass = changePercent >= 0 ? 'text-profit' : 'text-loss';
      const changeSymbol = changePercent >= 0 ? '+' : '';
      const span = getOrCreateSpan(changeCell, `${changeClass} font-medium`);
      span.className = `${changeClass} font-medium`; // Update class for color change
      span.textContent = `${changeSymbol}${changePercent.toFixed(2)}%`;

      // Add color-coded highlight animation if value actually changed
      if (valueChanged) {
        const animClass = changePercent >= 0 ? 'value-profit-updated' : 'value-loss-updated';
        addHighlight(changeCell, animClass);
      }

      cached.changePercent = changePercent;
    }

    // Update volume if changed OR cell is empty/placeholder
    if (quote.volume !== undefined && (cached.volume !== quote.volume || hasPlaceholder(volumeCell))) {
      const valueChanged = cached.volume !== quote.volume && !hasPlaceholder(volumeCell);
      const span = getOrCreateSpan(volumeCell);
      span.textContent = Utils.formatNumber(quote.volume);

      // Add highlight animation if value actually changed
      if (valueChanged) {
        addHighlight(volumeCell, 'value-updated');
      }

      cached.volume = quote.volume;
    }

    // Update cache
    this.quoteCache.set(cacheKey, cached);
  }

  handleQuoteStreamPayload(payload = {}) {
    const quotes = Array.isArray(payload.data) ? payload.data : [];
    if (!quotes.length) return;

    const updatedWatchlists = new Set();
    const ts = Date.now();

    quotes.forEach((quote) => {
      const hydratedQuote = this.hydrateQuoteWithLtp(quote, ts);
      const exchange = hydratedQuote.exchange || hydratedQuote.exch || hydratedQuote.exchange_segment || hydratedQuote.exchangeSegment;
      const candidateSymbols = [
        hydratedQuote.symbol,
        hydratedQuote.trading_symbol,
        hydratedQuote.tradingSymbol,
        hydratedQuote.tradingsymbol,
      ];

      const keys = new Set();
      candidateSymbols.forEach((sym) => {
        const key = this.buildWatchlistSymbolKey(exchange, sym);
        if (key) keys.add(key);
      });

      keys.forEach((key) => {
        const mappings = this.watchlistSymbolIndex.get(key);
        if (!mappings || !mappings.length) return;
        mappings.forEach(({ watchlistId, symbolId }) => {
          this.updateSymbolQuote(watchlistId, symbolId, hydratedQuote);
          updatedWatchlists.add(watchlistId);
        });
      });

      if (this.quickOrder && typeof this.quickOrder.applyQuoteUpdate === 'function') {
        this.quickOrder.applyQuoteUpdate(hydratedQuote);
      }
    });

    updatedWatchlists.forEach((watchlistId) => {
      this.updateWatchlistQuoteMeta(watchlistId, {
        timestamp: ts,
        source: 'stream',
      });
    });
  }

  updateWatchlistQuoteMeta(
    watchlistId,
    {
      timestamp = null,
      source = null,
      total = null,
      filled = null,
      statusText = null,
    } = {}
  ) {
    const lastUpdateEl = document.querySelector(
      `[data-watchlist-last-update="${watchlistId}"]`
    );
    const sourceEl = document.querySelector(
      `[data-watchlist-feed-source="${watchlistId}"]`
    );
    const coverageEl = document.querySelector(
      `[data-watchlist-feed-coverage="${watchlistId}"]`
    );

    if (lastUpdateEl) {
      if (statusText) {
        lastUpdateEl.textContent = statusText;
        lastUpdateEl.removeAttribute('title');
      } else if (timestamp) {
        const parsedTs = typeof timestamp === 'number'
          ? timestamp
          : Date.parse(timestamp);
        if (!Number.isNaN(parsedTs)) {
          const iso = new Date(parsedTs).toISOString();
          lastUpdateEl.textContent = `Last update: ${Utils.formatRelativeTime(iso)}`;
          lastUpdateEl.title = `Cached at ${Utils.formatDateTime(iso, true)}`;
        } else {
          lastUpdateEl.textContent = 'Last update: waiting for feed…';
          lastUpdateEl.removeAttribute('title');
        }
      } else {
        lastUpdateEl.textContent = 'Last update: waiting for feed…';
        lastUpdateEl.removeAttribute('title');
      }
    }

    if (sourceEl) {
      if (statusText) {
        sourceEl.textContent = 'Source: —';
      } else if (source === 'cache') {
        sourceEl.textContent = 'Source: Shared feed cache';
      } else if (source) {
        sourceEl.textContent = 'Source: Live broker fallback';
      } else {
        sourceEl.textContent = 'Source: —';
      }
    }

    if (coverageEl) {
      if (statusText && statusText.toLowerCase().includes('paused')) {
        coverageEl.textContent = '';
      } else if (typeof total === 'number') {
        const updatedCount = typeof filled === 'number' ? filled : 0;
        coverageEl.textContent = `Symbols updated: ${updatedCount}/${total}`;
      } else {
        coverageEl.textContent = '';
      }
    }
  }

  /**
   * Render Orders View
   */
  async renderOrdersView() {
    const contentArea = document.getElementById('content-area');
    this.currentOrderFilter = this.currentOrderFilter || '';

    contentArea.innerHTML = `
      <div class="space-y-4">
        <div class="card">
          <div class="card-header flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="card-title">Orders</h3>
              <p class="text-sm text-neutral-600">Live view of every OpenAlgo order grouped by instance category.</p>
            </div>
            <div class="flex items-center gap-2">
              <select id="orders-filter" class="form-select" onchange="app.filterOrders(this.value)">
                <option value="">All Status</option>
                <option value="pending">Pending</option>
                <option value="open">Open</option>
                <option value="complete">Complete</option>
                <option value="cancelled">Cancelled</option>
                <option value="rejected">Rejected</option>
              </select>
              <button class="btn btn-outline btn-sm" onclick="app.loadOrders()">
                Refresh
              </button>
              <button class="btn btn-exit btn-sm" onclick="app.cancelAllOpenOrdersGlobal()">
                Cancel All Open
              </button>
            </div>
          </div>
          <div class="p-4" id="orders-panel">
            <div class="text-center text-neutral-500">Loading orders…</div>
          </div>
        </div>
      </div>
    `;

    await this.loadOrders(this.currentOrderFilter);
  }

  async loadOrders(status = '') {
    try {
      const params = {};
      if (status) params.status = status;
      const response = await api.getOrderbook(status);
      const payload = response.data || {};
      this.orderbookPayload = payload;
      this.renderOrdersPanel(payload);
      const select = document.getElementById('orders-filter');
      if (select) select.value = status || '';
    } catch (error) {
      console.error('Failed to load orders:', error);
      const panel = document.getElementById('orders-panel');
      if (panel) {
        panel.innerHTML = `<p class="text-error text-center">${error.message}</p>`;
      }
    }
  }

  renderOrdersPanel(orders = []) {
    const panel = document.getElementById('orders-panel');
    if (!panel) return;

    if (!orders || (!orders.liveInstances?.length && !orders.analyzerInstances?.length)) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No orders found</p>';
      return;
    }

    panel.innerHTML = `
      <div class="space-y-5">
        ${this.renderOrdersSummary(orders)}
        ${this.renderOrdersSection('Live Instances', orders.liveInstances)}
        ${this.renderOrdersSection('Analyzer Mode Instances', orders.analyzerInstances)}
      </div>
    `;
  }

  renderOrdersSummary(payload) {
    const stats = payload.statistics || {};
    const liveOrders = payload.liveInstances?.flatMap(inst => inst.orders || []) || [];
    const analyzerOrders = payload.analyzerInstances?.flatMap(inst => inst.orders || []) || [];
    const allOrders = [...liveOrders, ...analyzerOrders];
    const total = allOrders.length;
    const statusCounts = {};
    allOrders.forEach(order => {
      statusCounts[order.status || 'unknown'] = (statusCounts[order.status || 'unknown'] || 0) + 1;
    });

    const badgeOrder = ['pending', 'open', 'complete', 'cancelled', 'rejected'];
    const badges = badgeOrder
      .filter(status => statusCounts[status])
      .map(status => `
        <span class="badge badge-sm ${status === 'open' ? 'badge-info' : status === 'pending' ? 'badge-warning' : status === 'complete' ? 'badge-success' : 'badge-neutral'}">
          ${status}: ${statusCounts[status]}
        </span>
      `).join(' ');

    return `
      <div class="card border border-base-200 bg-base-100 p-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-neutral-600 uppercase tracking-wide">Total orders</div>
            <div class="text-2xl font-semibold">${total}</div>
          </div>
            <div class="flex flex-wrap gap-2">
              ${badges}
            </div>
        </div>
      </div>
    `;
  }

  renderOrdersSection(title, instances = []) {
    if (!instances.length) {
      return `
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">${title}</h3>
              <p class="text-sm text-neutral-600">No orders in this category.</p>
            </div>
            <span class="badge">0</span>
          </div>
        </div>
      `;
    }

    const totalOrders = instances.reduce((acc, inst) => acc + (inst.orders?.length || 0), 0);

    return `
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="text-sm text-neutral-600">Orders executed per instance (live/analyzer)</p>
          </div>
          <span class="badge">${totalOrders}</span>
        </div>
        <div class="p-4 space-y-4">
          ${instances.map(instance => this.renderOrderInstanceCard(instance)).join('')}
        </div>
      </div>
    `;
  }

  renderOrderInstanceCard(instanceEntry) {
    const title = Utils.escapeHTML(instanceEntry.instance_name || `Instance ${instanceEntry.instance_id}`);
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const orders = instanceEntry.orders || [];
    const openOrders = orders.filter(o => ['open', 'pending'].includes(o.status)).length;

    return `
      <details class="rounded-lg border border-base-200 bg-base-100">
        <summary class="flex flex-wrap cursor-pointer items-center justify-between gap-4 px-4 py-4">
          <div>
            <h4 class="font-semibold text-lg">${title}</h4>
            <div class="text-sm text-neutral-600 flex gap-4 flex-wrap">
              <span>Broker: ${broker}</span>
              <span>Total orders: ${orders.length}</span>
              <span>Open/pending: ${openOrders}</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="btn btn-exit btn-sm"
              onclick="event.stopPropagation(); app.cancelAllOrders(${instanceEntry.instance_id})"
            >
              Cancel All Open Orders
            </button>
          </div>
        </summary>
        <div class="border-t border-base-200 p-4">
          ${this.renderOrdersTable(orders)}
        </div>
      </details>
    `;
  }

  renderOrdersTable(orders) {
    const rows = orders.map(order => {
      const safeValue = (...keys) => {
        for (const key of keys) {
          const parts = key.split('.');
          let value = order;
          for (const part of parts) {
            if (value && Object.prototype.hasOwnProperty.call(value, part)) {
              value = value[part];
            } else {
              value = undefined;
              break;
            }
          }

          if (value !== undefined && value !== null && value !== '') {
            return value;
          }
        }
        return '-';
      };

      const action = safeValue('action');
      const cancelable = ['pending', 'open'].includes(order.status);
      const orderId = order.id ? order.id.toString().replace(/'/g, "\\'") : '';
      const exchange = Utils.escapeHTML(safeValue('exchange', 'metadata.exchange'));
      const priceValue = safeValue('price', 'metadata.price', 'metadata.average_price');
      const priceDisplay = priceValue !== '-' ? Utils.formatNumber(priceValue) : '-';
      const strategy = Utils.escapeHTML(safeValue('strategy', 'metadata.strategy')) || '-';
      const timestamp = safeValue('timestamp', 'metadata.timestamp', 'metadata.placed_at');
      const placedAt = timestamp && timestamp !== '-' ? Utils.formatDateTime(timestamp, true) : '-';
      const statusValue = (safeValue('status', 'metadata.order_status') || 'unknown').toLowerCase();
      const rejectionReason = safeValue('metadata.rejection_reason', 'metadata.rejectionReason');
      const resolvedSymbol = safeValue('resolved_symbol', 'metadata.resolved_symbol', 'metadata.symbol');
      let statusBadge = Utils.getStatusBadge(statusValue);
      if (statusValue === 'rejected' && rejectionReason) {
        const escapedReason = Utils.escapeHTML(rejectionReason);
        statusBadge = statusBadge.replace('>', ` title="${escapedReason}">`);
      }
      const rejectionLine = statusValue === 'rejected' && rejectionReason
        ? `<div class="text-xs text-neutral-500 mt-1">${Utils.escapeHTML(rejectionReason)}</div>`
        : '';

      return `
        <tr>
          <td>${Utils.escapeHTML(safeValue('symbol', 'metadata.symbol'))}</td>
          <td class="text-xs text-neutral-600">${Utils.escapeHTML(resolvedSymbol)}</td>
          <td>${exchange}</td>
          <td>
            <span class="badge ${action === 'BUY' ? 'badge-success' : 'badge-error'}">
              ${action}
            </span>
          </td>
          <td>${priceDisplay !== '-' ? `₹${priceDisplay}` : priceDisplay}</td>
          <td>${safeValue('quantity', 'metadata.quantity')}</td>
          <td>${Utils.escapeHTML(safeValue('product', 'product_type', 'metadata.product'))}</td>
          <td>${Utils.escapeHTML(safeValue('order_type', 'metadata.pricetype'))}</td>
          <td>${strategy}</td>
          <td>${statusBadge}${rejectionLine}</td>
          <td class="text-right">${placedAt}</td>
          <td class="text-center">
            ${cancelable ? `
              <button class="btn btn-sm btn-outline"
                      onclick="app.cancelOrder('${orderId}')">
                Cancel
              </button>
            ` : '-'}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Resolved</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Type</th>
              <th>Strategy</th>
              <th>Status</th>
              <th class="text-right">Timestamp</th>
              <th class="text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  stopTradesPolling() {
    if (this.tradesPollingInterval) {
      clearInterval(this.tradesPollingInterval);
      this.tradesPollingInterval = null;
    }
  }

  updateTradesLastUpdatedDisplay(timestamp) {
    const label = document.getElementById('trades-last-updated');
    if (!label) return;
    if (!timestamp) {
      label.textContent = 'Waiting for updates…';
      return;
    }
    label.textContent = `Updated ${Utils.formatRelativeTime(new Date(timestamp).toISOString())}`;
  }

  /**
   * Render Trades View
   */
  async renderTradesView() {
    const contentArea = document.getElementById('content-area');
    this.stopTradesPolling();

    contentArea.innerHTML = `
      <div class="space-y-4">
        <div class="card">
          <div class="card-header flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="card-title">Trades</h3>
              <p class="text-sm text-neutral-600">Live tradebook snapshot grouped by instance. Auto-refreshes every 5 seconds.</p>
            </div>
            <div class="flex items-center gap-3 flex-wrap text-sm text-neutral-500">
              <span id="trades-last-updated">Waiting for updates…</span>
              <button class="btn btn-outline btn-sm" onclick="app.loadTrades()">
                Refresh
              </button>
            </div>
          </div>
          <div class="p-4" id="trades-panel">
            <div class="text-center text-neutral-500">Loading trades…</div>
          </div>
        </div>
      </div>
    `;

    await this.loadTrades();
    if (!this.isPaused) {
      this.tradesPollingInterval = setInterval(() => this.loadTrades(true), 5000);
    }
  }

  async loadTrades(isAuto = false) {
    try {
      const response = await api.getTradebook();
      this.tradesPayload = response.data || {};
      this.tradesLastUpdatedAt = this.tradesPayload.fetchedAt || Date.now();
      this.renderTradesPanel(this.tradesPayload);
      this.updateTradesLastUpdatedDisplay(this.tradesLastUpdatedAt);
    } catch (error) {
      const panel = document.getElementById('trades-panel');
      if (panel) {
        panel.innerHTML = `<p class="text-center text-error-600">${Utils.escapeHTML(error.message)}</p>`;
      }
      if (!isAuto) {
        Utils.showToast(`Failed to load trades: ${error.message}`, 'error');
      }
    }
  }

  renderTradesPanel(payload = {}) {
    // Ensure caches are always initialized even if constructor did not run as expected
    if (!this.tradesInstanceStore) {
      this.tradesInstanceStore = new Map();
    }
    const panel = document.getElementById('trades-panel');
    if (!panel) return;

    const liveInstances = payload.liveInstances || [];
    const analyzerInstances = payload.analyzerInstances || [];

    if (!liveInstances.length && !analyzerInstances.length) {
      panel.innerHTML = '<p class="text-center text-neutral-600">No trades available.</p>';
      return;
    }

    this.ensureTradesLayout(panel);
    this.updateTradesSummary(payload.statistics);
    this.updateTradesSection('live', liveInstances);
    this.updateTradesSection('analyzer', analyzerInstances);
  }

  ensureTradesLayout(panel) {
    if (panel.dataset.initialized === 'true') return;
    panel.innerHTML = `
      <div class="space-y-5">
        <div id="trades-summary"></div>
        <div id="trades-live" class="trades-section"></div>
        <div id="trades-analyzer" class="trades-section"></div>
      </div>
    `;
    panel.dataset.initialized = 'true';
  }

  updateTradesSummary(stats = {}) {
    const totalTrades = stats.total_trades || 0;
    const buyTrades = stats.total_buy_trades || 0;
    const sellTrades = stats.total_sell_trades || 0;
    const notional = stats.total_value || 0;
    const summary = document.getElementById('trades-summary');
    if (!summary) return;
    summary.innerHTML = `
      <div class="card bg-base-100 border border-base-200">
        <div class="card-header">
          <h3 class="card-title">Trades Summary</h3>
        </div>
        <div class="p-6">
          <div class="grid grid-cols-3 gap-4">
            <div class="border border-base-200 rounded-lg p-4 text-center">
              <div class="text-sm text-neutral-600 mb-1">Total Trades</div>
              <div class="text-3xl font-semibold">${totalTrades}</div>
            </div>
            <div class="border border-base-200 rounded-lg p-4 text-center">
              <div class="text-sm text-neutral-600 mb-1">Buy / Sell</div>
              <div class="text-2xl font-semibold">${buyTrades} / ${sellTrades}</div>
            </div>
            <div class="border border-base-200 rounded-lg p-4 text-center">
              <div class="text-sm text-neutral-600 mb-1">Notional Value</div>
              <div class="text-2xl font-semibold">${Utils.formatCurrency(notional)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  updateTradesSection(type, instances = []) {
    const container = document.getElementById(type === 'live' ? 'trades-live' : 'trades-analyzer');
    if (!container) return;
    const title = type === 'live' ? 'Live Instances' : 'Analyzer Mode Instances';
    const existingOpen = new Set(
      Array.from(container.querySelectorAll('details[data-instance-id][open]')).map(el => el.dataset.instanceId)
    );
    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    const totalTrades = sorted.reduce((acc, inst) => acc + (inst.trades?.length || 0), 0);

    const header = `
      <div class="card-header">
        <div>
          <h3 class="card-title">${title}</h3>
          <p class="text-sm text-neutral-600">${totalTrades} trades</p>
        </div>
        <span class="badge badge-outline">${totalTrades}</span>
      </div>
    `;

    const body = sorted.map(inst => {
      this.tradesInstanceStore.set(String(inst.instance_id), inst.trades || []);
      const isOpen = existingOpen.has(String(inst.instance_id));
      return this.buildTradesInstance(inst, isOpen, !isOpen);
    }).join('');
    container.innerHTML = `
      <div class="card">
        ${header}
        <div class="divide-y divide-base-200">
          ${body || `<div class="p-4 text-neutral-500">No trades in this category.</div>`}
        </div>
      </div>
    `;
  }

  buildTradesInstance(instanceEntry, preserveOpen = false, collapseByDefault = false) {
    const trades = instanceEntry.trades || [];
    const broker = Utils.escapeHTML(instanceEntry.broker || 'N/A');
    const latestTrade = trades[0];
    const lastTradeTime = latestTrade
      ? (latestTrade.timestamp_iso
        ? Utils.formatDateTime(latestTrade.timestamp_iso, true)
        : Utils.escapeHTML(latestTrade.timestamp || ''))
      : '-';
    const bodyRows = this.renderTradesRows(trades);

    const shouldOpen = preserveOpen && trades.length && !collapseByDefault;

    return `
      <details class="instance-section" data-instance-id="${instanceEntry.instance_id}" ${shouldOpen ? 'open' : ''}>
        <summary class="flex flex-wrap cursor-pointer items-center justify-between gap-4 px-4 py-4">
          <div>
            <h4 class="font-semibold text-lg">${Utils.escapeHTML(instanceEntry.instance_name)}</h4>
            <div class="text-sm text-neutral-600 flex gap-4 flex-wrap">
              <span>Broker: ${broker}</span>
              <span>Total trades: ${trades.length}</span>
              <span>Last trade: ${lastTradeTime || '-'}</span>
            </div>
          </div>
        </summary>
        <div class="border-t border-base-200 p-4" id="trades-body-${instanceEntry.instance_id}" data-loaded="${shouldOpen || !collapseByDefault}">
          ${trades.length && shouldOpen ? this.renderTradesTableShell(bodyRows) : '<p class="text-neutral-500">Expand to view trades.</p>'}
        </div>
      </details>
    `;
  }

  attachTradesToggles(container) {
    const detailsList = container.querySelectorAll('details.instance-section');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        if (details.open) {
          const body = details.querySelector('[id^="trades-body-"]');
          if (body && body.dataset.loaded !== 'true') {
            const instanceId = details.dataset.instanceId;
            const trades = this.tradesInstanceStore.get(String(instanceId)) || [];
            body.innerHTML = trades.length
              ? this.renderTradesTableShell(this.renderTradesRows(trades))
              : '<p class="text-neutral-500">No trades yet.</p>';
            body.dataset.loaded = 'true';
          }
        }
      });
    });
  }

  renderTradesRows(trades = []) {
    return trades.map(trade => {
      const action = trade.action;
      const badgeClass = action === 'BUY'
        ? 'badge-success'
        : action === 'SELL'
          ? 'badge-error'
          : 'badge-neutral';
      const timestampDisplay = trade.timestamp_iso
        ? Utils.formatDateTime(trade.timestamp_iso, true)
        : Utils.escapeHTML(trade.timestamp || '-');
      const avgPriceDisplay = (trade.average_price ?? null) !== null
        ? Utils.formatNumber(trade.average_price)
        : '-';
      const tradeValueDisplay = (trade.trade_value ?? null) !== null
        ? Utils.formatCurrency(trade.trade_value)
        : '-';

      return `
        <tr>
          <td>${Utils.escapeHTML(trade.symbol || '-')}</td>
          <td>${Utils.escapeHTML(trade.exchange || '-')}</td>
          <td>
            <span class="badge ${badgeClass}">${action || '-'}</span>
          </td>
          <td>${trade.quantity ?? '-'}</td>
          <td>${Utils.escapeHTML(trade.product || '-')}</td>
          <td>${avgPriceDisplay}</td>
          <td>${tradeValueDisplay}</td>
          <td class="text-right">${timestampDisplay}</td>
        </tr>
      `;
    }).join('');
  }

  renderTradesTableShell(rowsHtml) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Exchange</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Product</th>
              <th>Avg Price</th>
              <th>Trade Value</th>
              <th class="text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="8" class="text-center text-neutral-500">No trades</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Render Positions View
   */
  async renderPositionsView() {
    const contentArea = document.getElementById('content-area');
    if (!this.positionsInstanceStore) {
      this.positionsInstanceStore = new Map();
    }

    try {
      // Fetch ALL positions from all active instances (including closed)
      const response = await api.getAllPositions(false); // onlyOpen = false
      const data = response.data;
      this.latestAllPositionsData = data;

      if (data.instances.length === 0) {
        contentArea.innerHTML = `
          <div class="card">
            <p class="text-center text-neutral-600">No active instances found</p>
          </div>
        `;
        return;
      }

      if (!contentArea.dataset.positionsInitialized) {
        contentArea.innerHTML = `
          <!-- Overall Summary Card -->
          <div class="card mb-6">
            <div class="card-header">
              <h3 class="card-title">All Positions Summary</h3>
            </div>
            <div class="p-4" id="positions-summary"></div>
          </div>
          <div class="space-y-5" id="positions-layout">
            <div id="positions-live"></div>
            <div id="positions-analyzer"></div>
          </div>
        `;
        contentArea.dataset.positionsInitialized = 'true';
      }

      this.updatePositionsSummary(data);
      const instances = Array.isArray(data.instances) ? data.instances : [];
      const liveInstances = instances.filter(inst => !inst.is_analyzer_mode);
      const analyzerInstances = instances.filter(inst => inst.is_analyzer_mode);
      this.updatePositionsSection('live', liveInstances);
      this.updatePositionsSection('analyzer', analyzerInstances);
    } catch (error) {
      contentArea.innerHTML = `
        <div class="card">
          <p class="text-center text-error-600">Failed to load positions: ${error.message}</p>
        </div>
      `;
    }
  }

  updatePositionsSummary(data) {
    const container = document.getElementById('positions-summary');
    if (!container) return;
    container.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="grid grid-cols-3 gap-4 flex-1 min-w-[280px]">
          <div class="text-center">
            <div class="text-sm text-neutral-600 mb-1">Open Positions</div>
            <div class="text-2xl font-semibold">${data.overall_open_positions}</div>
          </div>
          <div class="text-center">
            <div class="text-sm text-neutral-600 mb-1">Closed Positions</div>
            <div class="text-2xl font-semibold">${data.overall_closed_positions}</div>
          </div>
          <div class="text-center">
            <div class="text-sm text-neutral-600 mb-1">Overall P&L</div>
            <div class="text-2xl font-semibold ${Utils.getPnLColorClass(data.overall_total_pnl)}">
              ${Utils.formatCurrency(data.overall_total_pnl)}
            </div>
          </div>
        </div>
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-outline btn-sm" onclick="app.renderPositionsView()">
              Refresh
            </button>
          <button class="btn btn-outline btn-sm" onclick="app.toggleSnapshotResync()">
            Auto Resync: ${this.autoSnapshotResyncEnabled ? 'On' : 'Off'}
          </button>
          <button class="btn btn-outline btn-sm" onclick="app.resyncAllPositionsFromSnapshots()">
            Resync snapshots
          </button>
            <button class="btn btn-exit btn-sm" onclick="app.closeAllPositionsGlobal()">
              Close All Positions
            </button>
          </div>
        </div>
    `;
  }

  updatePositionsSection(type, instances = []) {
    const container = document.getElementById(type === 'live' ? 'positions-live' : 'positions-analyzer');
    if (!container) return;
    const title = type === 'live' ? 'Live Instances' : 'Analyzer Mode Instances';
    const sorted = [...instances].sort((a, b) => (a.instance_name || '').localeCompare(b.instance_name || ''));
    const totalPositions = sorted.reduce((acc, inst) => {
      const count = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length;
      return acc + count;
    }, 0);

    container.innerHTML = `
      <div class="card">
        <div class="card-header items-center justify-between">
          <div>
            <h3 class="card-title">${title}</h3>
            <p class="text-sm text-neutral-600">${totalPositions} open positions</p>
          </div>
          <span class="badge badge-outline">${totalPositions}</span>
        </div>
        <div class="divide-y divide-base-200">
          ${sorted.map(inst => {
            const id = String(inst.instance_id);
            const isOpen = this.positionsExpanded.has(id);
            this.positionsInstanceStore.set(id, inst.positions || []);
            return this.buildPositionsInstance(inst, isOpen);
          }).join('') || `<div class="p-4 text-neutral-500">No positions in this category.</div>`}
        </div>
      </div>
    `;

    this.attachPositionsToggles(container);
  }

  buildPositionsInstance(inst, isOpen) {
    const header = `
      <summary class="card-header flex items-center justify-between gap-3 px-4 py-4">
        <div>
          <h3 class="card-title">${Utils.escapeHTML(inst.instance_name)}</h3>
          <div class="flex gap-4 mt-1 text-sm text-neutral-600">
            <span>Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
            <span>Open: <span class="font-medium">${inst.open_positions_count}</span></span>
            <span>Closed: <span class="font-medium">${inst.closed_positions_count}</span></span>
            <span>P&L: <span class="font-medium ${Utils.getPnLColorClass(inst.total_pnl)}">${Utils.formatCurrency(inst.total_pnl)}</span></span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-outline btn-sm"
                  onclick="event.stopPropagation(); app.resyncPositionsFromSnapshot(${inst.instance_id})">
            Resync
          </button>
          <button class="btn btn-exit btn-sm"
                  onclick="event.stopPropagation(); app.closeAllPositions(${inst.instance_id})">
            Close All Positions
          </button>
        </div>
      </summary>
    `;

    const positions = inst.positions || [];

    return `
      <details class="card" data-instance-id="${inst.instance_id}" ${isOpen ? 'open' : ''}>
        ${header}
        <div class="p-4 instance-positions-body" data-loaded="${isOpen}">
          ${isOpen ? this.renderPositionsBody(positions, inst) : '<p class="text-neutral-500">Expand to view positions.</p>'}
        </div>
      </details>
    `;
  }

  renderPositionsBody(positions, inst) {
    if (inst.error) {
      return `<p class="text-center text-error-600 p-4">${Utils.escapeHTML(inst.error)}</p>`;
    }
    if (!positions || positions.length === 0) {
      return '<p class="text-center text-neutral-600 p-4">No positions</p>';
    }
    return this.renderPositionsTable(positions, inst.instance_id);
  }

  attachPositionsToggles(container) {
    const detailsList = container.querySelectorAll('details.card');
    detailsList.forEach(details => {
      details.addEventListener('toggle', () => {
        const instanceId = details.dataset.instanceId;
        if (details.open) {
          this.positionsExpanded.add(String(instanceId));
          const body = details.querySelector('.instance-positions-body');
          if (body && body.dataset.loaded !== 'true') {
            const positions = this.positionsInstanceStore.get(String(instanceId)) || [];
            body.innerHTML = this.renderPositionsBody(positions, { instance_id: instanceId });
            body.dataset.loaded = 'true';
          }
        } else {
          this.positionsExpanded.delete(String(instanceId));
        }
      });
    });
  }

  async resyncPositionsFromSnapshot(instanceId) {
    try {
      const res = await api.getPositionSnapshot(instanceId, { refresh: true });
      const positions = res?.data?.positions || [];
      this.positionsInstanceStore.set(String(instanceId), positions);
      const body = document.querySelector(
        `details.card[data-instance-id="${instanceId}"] .instance-positions-body`
      );
      if (body) {
        body.innerHTML = this.renderPositionsBody(positions, { instance_id: instanceId });
        body.dataset.loaded = 'true';
      }
      Utils.showToast(`Positions resynced for instance ${instanceId}`, 'success');
    } catch (error) {
      console.error('Failed to resync positions snapshot', error);
      Utils.showToast('Failed to resync positions snapshot', 'error');
    }
  }

  async resyncAllPositionsFromSnapshots() {
    try {
      const instances = (this.latestAllPositionsData?.instances || []).map((i) => i.instance_id);
      if (!instances.length) {
        await this.renderPositionsView();
        return;
      }
      await Promise.all(
        instances.map((id) => api.getPositionSnapshot(id, { refresh: true }).catch(() => null))
      );
      await this.renderPositionsView();
      Utils.showToast('Positions resynced from snapshots', 'success');
    } catch (error) {
      console.error('Failed to resync all positions snapshots', error);
      Utils.showToast('Failed to resync all positions snapshots', 'error');
    }
  }

  toggleSnapshotResync() {
    this.autoSnapshotResyncEnabled = !this.autoSnapshotResyncEnabled;
    this.persistSnapshotResyncPreference(this.autoSnapshotResyncEnabled);
    Utils.showToast(`Auto snapshot resync ${this.autoSnapshotResyncEnabled ? 'enabled' : 'disabled'}`, 'info');
    // Restart interval if applicable
    if (['watchlists', 'positions'].includes(this.currentView)) {
      this.startSnapshotResync(this.currentView);
    }
    // Refresh UI buttons to reflect state
    if (this.currentView === 'positions') {
      this.renderPositionsView();
    } else if (this.currentView === 'watchlists') {
      this.renderWatchlistsView();
    }
  }

  /**
   * Show add instance modal
   */
  showAddInstanceModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay symbol-search-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Instance</h3>
        </div>
        <div class="modal-body">
          <form id="add-instance-form">
            <div class="form-group">
              <label class="form-label">Instance Name *</label>
              <input type="text" name="name" class="form-input" required>
            </div>

            <div class="form-group">
              <label class="form-label">Host URL *</label>
              <input type="url" name="host_url" id="instance-host-url" class="form-input"
                     placeholder="http://localhost:5000" required>
            </div>

            <div class="form-group">
              <label class="form-label">API Key *</label>
              <input type="text" name="api_key" id="instance-api-key" class="form-input" required>
            </div>

            <div class="form-group">
              <label class="form-label">Broker (auto-detected)</label>
              <div style="display: flex; gap: 0.5rem; align-items: center;">
                <input type="text" name="broker" id="instance-broker" class="form-input" readonly
                       placeholder="Click 'Test Connection' to detect">
                <button type="button" class="btn btn-neutral btn-outline btn-sm"
                        onclick="app.testInstanceConnection()">
                  Test Connection
                </button>
              </div>
              <small id="connection-status" class="form-help" style="display: block; margin-top: 0.25rem;"></small>
            </div>

            <div class="form-group">
              <label class="form-label">Verify API Key</label>
              <button type="button" class="btn btn-neutral btn-outline btn-sm" style="width: 100%;"
                      onclick="app.testInstanceApiKey()">
                Test API Key with Funds Endpoint
              </button>
              <small id="apikey-status" class="form-help" style="display: block; margin-top: 0.25rem;"></small>
            </div>

            <div class="form-group">
              <label class="form-label">Market Data</label>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="market_data_enabled" class="form-checkbox">
                <span>Use this instance for market data</span>
              </label>
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Enabled instances will be pooled and load-balanced for quotes/LTP/depth.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Broker WebSocket Quotes</label>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="use_ws_quotes" class="form-checkbox">
                <span>Use broker WebSocket for quotes/LTP (only if this instance supports it)</span>
              </label>
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Only enable if the broker/OpenAlgo instance provides WS quotes; otherwise leave off to stay on REST polling.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">MultiQuotes (optional)</label>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="supports_multiquotes" class="form-checkbox">
                <span>Instance supports <a href="https://docs.openalgo.in/api-documentation/v1/data-api/multiquotes" target="_blank" rel="noopener">OpenAlgo MultiQuotes</a></span>
              </label>
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                When enabled, watchlist polling uses batched requests (max 1 every 5 seconds) instead of one call per symbol.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Option Chain API (optional)</label>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" name="supports_option_chain" class="form-checkbox">
                <span>Instance supports OpenAlgo Option Chain endpoint (limited strikes with LTP)</span>
              </label>
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                When enabled, options resolution fetches up to 15 strikes with live quotes directly from the broker.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Strategy Tag</label>
              <input type="text" name="strategy_tag" class="form-input" value="default">
            </div>

            <div class="form-group">
              <label class="form-label">Session Target Profit</label>
              <input type="number" name="session_target_profit" class="form-input" step="0.01" placeholder="5000">
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Auto-switch to Analyze when this profit is reached within a session.
              </small>
            </div>

            <div class="form-group">
              <label class="form-label">Session Max Loss</label>
              <input type="number" name="session_max_loss" class="form-input" step="0.01" placeholder="2000">
              <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                Auto-switch to Analyze when this loss is hit within a session.
              </small>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.submitAddInstance()">
            Add Instance
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  /**
   * Submit add instance form
   */
  async submitAddInstance() {
    const form = document.getElementById('add-instance-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    data.market_data_enabled = form.querySelector('input[name="market_data_enabled"]').checked;
    data.use_ws_quotes = form.querySelector('input[name="use_ws_quotes"]').checked;
    data.supports_multiquotes = form.querySelector('input[name="supports_multiquotes"]').checked;
    data.supports_option_chain = form.querySelector('input[name="supports_option_chain"]').checked;

    try {
      await api.createInstance(data);
      Utils.showToast('Instance added successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Test connection to OpenAlgo instance
   */
  async testInstanceConnection() {
    const hostUrl = document.getElementById('instance-host-url').value;
    const apiKey = document.getElementById('instance-api-key').value;
    const statusEl = document.getElementById('connection-status');
    const brokerField = document.getElementById('instance-broker');

    if (!hostUrl || !apiKey) {
      statusEl.textContent = '⚠️ Please enter Host URL and API Key first';
      statusEl.style.color = 'var(--color-warning)';
      return;
    }

    statusEl.textContent = '⏳ Testing connection...';
    statusEl.style.color = 'var(--color-info)';

    try {
      const response = await api.testConnection(hostUrl, apiKey);

      if (response.status === 'success' && response.data?.broker) {
        brokerField.value = response.data.broker;
        statusEl.textContent = `✅ Connection successful! Broker: ${response.data.broker}`;
        statusEl.style.color = 'var(--color-profit)';
        Utils.showToast(`Connected successfully to ${response.data.broker}`, 'success');
      } else {
        statusEl.textContent = '❌ ' + (response.message || 'Connection failed');
        statusEl.style.color = 'var(--color-loss)';
        Utils.showToast(response.message || 'Connection test failed', 'error');
      }
    } catch (error) {
      statusEl.textContent = '❌ ' + error.message;
      statusEl.style.color = 'var(--color-loss)';
      Utils.showToast('Connection test failed: ' + error.message, 'error');
    }
  }

  /**
   * Test connection in edit modal
   */
  async testEditInstanceConnection() {
    const hostUrlInput = document.getElementById('edit-instance-host-url');
    const apiKeyInput = document.getElementById('edit-instance-api-key');
    const statusEl = document.getElementById('edit-connection-status');
    const brokerField = document.getElementById('edit-instance-broker');

    if (!hostUrlInput || !apiKeyInput || !statusEl || !brokerField) {
      console.warn('Edit instance connection fields missing');
      return;
    }

    const hostUrl = hostUrlInput.value;
    const apiKey = apiKeyInput.value;

    if (!hostUrl || !apiKey) {
      statusEl.textContent = '⚠️ Please enter Host URL and API Key first';
      statusEl.style.color = 'var(--color-warning)';
      return;
    }

    statusEl.textContent = '⏳ Testing connection...';
    statusEl.style.color = 'var(--color-info)';

    try {
      const response = await api.testConnection(hostUrl, apiKey);

      if (response.status === 'success' && response.data?.broker) {
        brokerField.value = response.data.broker;
        statusEl.textContent = `✅ Connection successful! Broker: ${response.data.broker}`;
        statusEl.style.color = 'var(--color-profit)';
        Utils.showToast(`Connected successfully to ${response.data.broker}`, 'success');
      } else {
        statusEl.textContent = '❌ ' + (response.message || 'Connection failed');
        statusEl.style.color = 'var(--color-loss)';
        Utils.showToast(response.message || 'Connection test failed', 'error');
      }
    } catch (error) {
      statusEl.textContent = '❌ ' + error.message;
      statusEl.style.color = 'var(--color-loss)';
      Utils.showToast('Connection test failed: ' + error.message, 'error');
    }
  }

  /**
   * Test API key validity with funds endpoint
   */
  async testInstanceApiKey() {
    const hostUrl = document.getElementById('instance-host-url').value;
    const apiKey = document.getElementById('instance-api-key').value;
    const statusEl = document.getElementById('apikey-status');

    if (!hostUrl || !apiKey) {
      statusEl.textContent = '⚠️ Please enter Host URL and API Key first';
      statusEl.style.color = 'var(--color-warning)';
      return;
    }

    statusEl.textContent = '⏳ Validating API key with funds endpoint...';
    statusEl.style.color = 'var(--color-info)';

    try {
      const response = await api.testApiKey(hostUrl, apiKey);

      if (response.status === 'success') {
        const funds = response.data?.funds;
        const cash = funds?.availablecash || 'N/A';
        statusEl.textContent = `✅ API Key valid! Available Cash: ₹${cash}`;
        statusEl.style.color = 'var(--color-profit)';
        Utils.showToast('API key validated successfully', 'success');
      } else {
        statusEl.textContent = '❌ ' + (response.message || 'Invalid API key');
        statusEl.style.color = 'var(--color-loss)';
        Utils.showToast(response.message || 'API key validation failed', 'error');
      }
    } catch (error) {
      statusEl.textContent = '❌ ' + error.message;
      statusEl.style.color = 'var(--color-loss)';
      Utils.showToast('API key validation failed: ' + error.message, 'error');
    }
  }

  /**
   * Show add watchlist modal
   */
  showAddWatchlistModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay symbol-search-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Watchlist</h3>
        </div>
        <div class="modal-body">
          <form id="add-watchlist-form">
            <div class="form-group">
              <label class="form-label">Watchlist Name *</label>
              <input type="text" name="name" class="form-input" required>
            </div>

            <div class="form-group">
              <label class="form-label">Type</label>
              <div class="flex flex-col gap-2">
                <label class="form-radio">
                  <input type="radio" name="type" value="standard" checked>
                  <span>Standard (symbols + quick orders)</span>
                </label>
                <label class="form-radio">
                  <input type="radio" name="type" value="broadcast">
                  <span>Broadcast (TradingView webhook fan-out; no symbols)</span>
                </label>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea name="description" class="form-input" rows="3"></textarea>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.submitAddWatchlist()">
            Add Watchlist
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  /**
   * Submit add watchlist form
   */
  async submitAddWatchlist() {
    const form = document.getElementById('add-watchlist-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    data.type = data.type || 'standard';

    try {
      await api.createWatchlist(data);
      Utils.showToast('Watchlist added successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Refresh instance
   */
  async refreshInstance(instanceId) {
    try {
      Utils.showToast('Refreshing instance...', 'info', 2000);
      await api.refreshInstance(instanceId);
      Utils.showToast('Instance refreshed', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Toggle analyzer mode
   */
  async toggleAnalyzerMode(instanceId, mode) {
    const confirmed = await Utils.confirm(
      `Are you sure you want to ${mode ? 'enable' : 'disable'} analyzer mode?`,
      'Confirm Analyzer Mode Toggle'
    );

    if (!confirmed) return;

    try {
      Utils.showToast('Toggling analyzer mode...', 'info', 2000);
      await api.toggleAnalyzer(instanceId, mode);
      Utils.showToast(`Analyzer mode ${mode ? 'enabled' : 'disabled'}`, 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Delete instance
   */
  async deleteInstance(instanceId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to delete this instance? This action cannot be undone.',
      'Confirm Delete'
    );

    if (!confirmed) return;

    try {
      await api.deleteInstance(instanceId);
      Utils.showToast('Instance deleted', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Toggle select all instances checkbox
   */
  toggleSelectAllInstances(checked) {
    const checkboxes = document.querySelectorAll('.instances-bulk-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.checked = checked;
    });
    this.updateBulkActionsState();
  }

  /**
   * Update bulk actions bar visibility and count
   */
  updateBulkActionsState() {
    const checkboxes = document.querySelectorAll('.instances-bulk-checkbox:checked');
    const count = checkboxes.length;
    const bulkActionsBar = document.getElementById('bulk-actions-bar');
    const selectedCount = document.getElementById('selected-count');

    if (bulkActionsBar && selectedCount) {
      if (count > 0) {
        bulkActionsBar.style.display = 'block';
        selectedCount.textContent = `${count} selected`;
      } else {
        bulkActionsBar.style.display = 'none';
      }
    }

    // Update select-all checkbox state
    const selectAllCheckbox = document.getElementById('select-all-instances');
    const allCheckboxes = document.querySelectorAll('.instances-bulk-checkbox');
    if (selectAllCheckbox && allCheckboxes.length > 0) {
      selectAllCheckbox.checked = checkboxes.length === allCheckboxes.length;
      selectAllCheckbox.indeterminate = checkboxes.length > 0 && checkboxes.length < allCheckboxes.length;
    }
  }

  /**
   * Get selected instance IDs
   */
  getSelectedInstanceIds() {
    const checkboxes = document.querySelectorAll('.instances-bulk-checkbox:checked');
    return Array.from(checkboxes).map(cb => parseInt(cb.dataset.instanceId));
  }

  /**
   * Bulk set active/inactive status
   */
  async bulkSetActive(isActive) {
    const instanceIds = this.getSelectedInstanceIds();
    if (instanceIds.length === 0) {
      Utils.showToast('No instances selected', 'warning');
      return;
    }

    const action = isActive ? 'activate' : 'deactivate';
    const confirmed = await Utils.confirm(
      `Are you sure you want to ${action} ${instanceIds.length} instance(s)?`,
      `Confirm ${action.charAt(0).toUpperCase() + action.slice(1)}`
    );

    if (!confirmed) return;

    try {
      await api.bulkUpdateInstances({
        instance_ids: instanceIds,
        is_active: isActive,
      });
      Utils.showToast(`${instanceIds.length} instance(s) ${isActive ? 'activated' : 'deactivated'}`, 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Bulk set analyzer mode
   */
  async bulkSetAnalyzerMode(isAnalyzerMode) {
    const instanceIds = this.getSelectedInstanceIds();
    if (instanceIds.length === 0) {
      Utils.showToast('No instances selected', 'warning');
      return;
    }

    const mode = isAnalyzerMode ? 'Analyzer' : 'Live';
    const confirmed = await Utils.confirm(
      `Are you sure you want to set ${instanceIds.length} instance(s) to ${mode} mode?`,
      `Confirm Set ${mode} Mode`
    );

    if (!confirmed) return;

    try {
      await api.bulkUpdateInstances({
        instance_ids: instanceIds,
        is_analyzer_mode: isAnalyzerMode,
      });
      Utils.showToast(`${instanceIds.length} instance(s) set to ${mode} mode`, 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Show add symbol modal with search
   */
  async showAddSymbolModal(watchlistId) {
    const watchlist = (this.watchlists || []).find((w) => w.id === watchlistId);
    if (this.isBroadcastWatchlist(watchlist)) {
      Utils.showToast('Broadcast watchlists do not support symbols. Assign instances and use the webhook.', 'warning');
      return;
    }

    this.currentWatchlistId = watchlistId;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay symbol-search-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 700px;">
        <div class="modal-header">
          <h3>Add Symbol to Watchlist</h3>
        </div>
        <div class="modal-body">
          <!-- Symbol Search -->
          <div class="form-group">
            <label class="form-label">Search Symbol</label>
            <input type="text" id="symbol-search-input" class="form-input"
                   placeholder="Type symbol name (e.g., RELIANCE, NIFTY, BANKNIFTY)"
                   oninput="app.debounceSymbolSearch(this.value)">
          </div>

          <!-- Search Results -->
          <div id="symbol-search-results" class="mt-4"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="app.closeSymbolSearchModal()">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.symbolSearchModal = modal;
    document.getElementById('symbol-search-input').focus();
  }

  closeSymbolSearchModal() {
    const modal = this.symbolSearchModal || document.querySelector('.symbol-search-modal');
    if (modal) {
      modal.remove();
    }
    this.symbolSearchModal = null;
  }

  /**
   * Debounce symbol search
   */
  debounceSymbolSearch(query) {
    clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.searchSymbols(query), 300);
  }

  /**
   * Search symbols with classification
   */
  async searchSymbols(query) {
    if (!query || query.length < 2) {
      document.getElementById('symbol-search-results').innerHTML = '';
      return;
    }

    const resultsContainer = document.getElementById('symbol-search-results');
    resultsContainer.innerHTML = '<p class="text-neutral-600">Searching...</p>';

    try {
      const response = await api.searchSymbols(query);
      const results = response.data;

      if (results.length === 0) {
        resultsContainer.innerHTML = '<p class="text-neutral-600">No results found</p>';
        return;
      }

      const enrichedResults = results.map(sym => ({
        ...sym,
        underlying_symbol: sym.underlying_symbol || sym.name || sym.symbol,
      }));

      resultsContainer.innerHTML = `
        <div class="space-y-2">
          <p class="text-sm text-neutral-700 font-semibold">${results.length} results found:</p>
          <div class="max-h-96 overflow-y-auto space-y-2">
              ${enrichedResults.map(sym => `
              <div class="p-3 border rounded cursor-pointer hover:bg-neutral-100"
                   data-symbol="${encodeURIComponent(JSON.stringify(sym))}"
                   onclick="app.selectSymbol(this.dataset.symbol)">
                <div class="flex items-center justify-between">
                  <div>
                    <span class="font-semibold">${Utils.escapeHTML(sym.tradingsymbol || sym.symbol)}</span>
                    <span class="text-sm text-neutral-600 ml-2">${Utils.escapeHTML(sym.exchange)}</span>
                  </div>
                  <span class="badge ${this.getSymbolTypeBadgeClass(sym.symbol_type)}">
                    ${sym.symbol_type}
                  </span>
                </div>
                ${sym.name ? `<p class="text-sm text-neutral-600 mt-1">${Utils.escapeHTML(sym.name)}</p>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    } catch (error) {
      resultsContainer.innerHTML = `<p class="text-error">Search failed: ${error.message}</p>`;
    }
  }

  /**
   * Select symbol from search results and open configuration
   */
  selectSymbol(encodedSymbol) {
    let symbolData;
    try {
      symbolData = JSON.parse(decodeURIComponent(encodedSymbol));
    } catch (error) {
      console.error('Failed to decode symbol', error);
      Utils.showToast('Failed to parse selected symbol', 'error');
      return;
    }

    symbolData.underlying_symbol = symbolData.underlying_symbol || symbolData.name || symbolData.symbol;

    this.pendingSymbolData = symbolData;
    this.closeSymbolSearchModal();
    this.showSymbolConfigModal(symbolData);
  }

  getSymbolTradableDefaults(symbolData) {
    const type = (symbolData.symbol_type || '').toUpperCase();
    return {
      equity:
        symbolData.tradable_equity === true ||
        type === 'EQUITY' ||
        type === 'EQUITY_FNO' ||
        type === 'UNKNOWN',
      futures:
        symbolData.tradable_futures === true ||
        type === 'FUTURES' ||
        type === 'EQUITY_FNO' ||
        type === 'INDEX',
      options:
        symbolData.tradable_options === true ||
        type === 'OPTIONS' ||
        type === 'INDEX',
    };
  }

  showSymbolConfigModal(symbolData, options = {}) {
    const defaults = this.getSymbolTradableDefaults(symbolData);
    const mode = options.mode || 'add';
    const watchlistId = options.watchlistId || this.currentWatchlistId;
    const symbolId = options.symbolId || symbolData.id || null;
    this.symbolConfigContext = { mode, watchlistId, symbolId };
    this.pendingSymbolData = symbolData;

    const tradableEquityChecked =
      symbolData.tradable_equity !== undefined
        ? Boolean(symbolData.tradable_equity)
        : defaults.equity;
    const tradableFuturesChecked =
      symbolData.tradable_futures !== undefined
        ? Boolean(symbolData.tradable_futures)
        : defaults.futures;
    const tradableOptionsChecked =
      symbolData.tradable_options !== undefined
        ? Boolean(symbolData.tradable_options)
        : defaults.options;

    const autoExitValue = (field) => {
      const value = symbolData[field];
      return value !== undefined && value !== null ? value : '';
    };
    const formatAutoExitValue = (field) => {
      const raw = autoExitValue(field);
      if (raw === '') return '';
      return Utils.escapeHTML(String(raw));
    };

    const autoExitFieldsHtml = this.autoExitModes
      .map((modeConfig) => `
        <div class="border rounded-lg p-3 bg-white shadow-sm">
          <div class="text-sm font-semibold mb-2">${modeConfig.label} auto exits</div>
        <div class="grid gap-2 sm:grid-cols-4">
          <div class="form-group">
            <label class="form-label">Target (points)</label>
            <input type="number" name="target_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`target_points_${modeConfig.key}`)}"
                   placeholder="e.g., 20">
          </div>
          <div class="form-group">
            <label class="form-label">Stop loss (points)</label>
            <input type="number" name="stoploss_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`stoploss_points_${modeConfig.key}`)}"
                   placeholder="e.g., 15">
          </div>
          <div class="form-group">
            <label class="form-label">Trailing SL (points)</label>
            <input type="number" name="trailing_stoploss_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`trailing_stoploss_points_${modeConfig.key}`)}"
                   placeholder="e.g., 10">
          </div>
          <div class="form-group">
            <label class="form-label">Trail activation (points)</label>
            <input type="number" name="trailing_activation_points_${modeConfig.key}"
                   class="form-input" step="0.01" min="0"
                   value="${formatAutoExitValue(`trailing_activation_points_${modeConfig.key}`)}"
                   placeholder="e.g., 0">
          </div>
        </div>
        </div>
      `)
      .join('');
    const modalTitle = mode === 'edit' ? 'Edit Symbol Configuration' : 'Configure Symbol';
    const saveLabel = mode === 'edit' ? 'Save Changes' : 'Add Symbol';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 560px;">
        <div class="modal-header">
          <h3>${modalTitle}</h3>
        </div>
        <div class="modal-body">
          <p class="text-sm text-neutral-600 mb-4">
            Choose which trade modes should be enabled for <strong>${Utils.escapeHTML(symbolData.tradingsymbol || symbolData.symbol)}</strong>.
          </p>
          <form id="symbol-config-form" class="space-y-4">
            <div class="p-3 border rounded-lg bg-neutral-50">
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-semibold">${Utils.escapeHTML(symbolData.tradingsymbol || symbolData.symbol)}</p>
                  <p class="text-sm text-neutral-600">${Utils.escapeHTML(symbolData.exchange || '')}</p>
                </div>
                <span class="badge ${this.getSymbolTypeBadgeClass(symbolData.symbol_type || 'UNKNOWN')}">
                  ${(symbolData.symbol_type || 'UNKNOWN').toUpperCase()}
                </span>
              </div>
            </div>

            <div class="space-y-3">
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_equity" ${tradableEquityChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Direct Trading</p>
                  <p class="text-sm text-neutral-600">Use BUY/SELL/EXIT buttons directly for this symbol (spot, futures, or options).</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_futures" ${tradableFuturesChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Futures Trading</p>
                  <p class="text-sm text-neutral-600">Route BUY/SELL/EXIT to futures contracts.</p>
                </div>
              </label>
              <label class="flex items-center gap-3 p-3 border rounded cursor-pointer hover:bg-neutral-50">
                <input type="checkbox" name="tradable_options" ${tradableOptionsChecked ? 'checked' : ''}>
                <div>
                  <p class="font-semibold">Enable Options Trading</p>
                  <p class="text-sm text-neutral-600">Show the documented Options workflow.</p>
                </div>
              </label>
            </div>

            <div class="form-group">
              <label class="form-label">Underlying Symbol (for derivatives)</label>
              <input type="text" name="underlying_symbol" class="form-input"
                     value="${Utils.escapeHTML(symbolData.underlying_symbol || symbolData.symbol || '')}"
                     placeholder="e.g., NIFTY, BANKNIFTY">
              <p class="text-xs text-neutral-500 mt-1">
                Used to resolve futures/options via the instruments cache or option-chain API.
              </p>
            </div>
            <div class="border rounded-lg bg-neutral-50 p-4 space-y-3">
              <p class="text-sm font-semibold text-neutral-600">
                Optional auto-exit thresholds (points)
              </p>
              <div class="space-y-3">
                ${autoExitFieldsHtml}
              </div>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="app.cancelSymbolConfig()">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.confirmAddSymbol()">
            ${saveLabel}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.symbolConfigModal = modal;
  }

  async showEditSymbolModal(watchlistId, symbolId) {
    try {
      const response = await api.getWatchlistSymbols(watchlistId);
      const symbol = response.data.find((row) => row.id === symbolId);
      if (!symbol) {
        throw new Error('Symbol not found in this watchlist');
      }
      this.currentWatchlistId = watchlistId;
      this.pendingSymbolData = symbol;
      this.showSymbolConfigModal(symbol, {
        mode: 'edit',
        watchlistId,
        symbolId,
      });
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  cancelSymbolConfig() {
    if (this.symbolConfigModal) {
      this.symbolConfigModal.remove();
      this.symbolConfigModal = null;
    }
    this.pendingSymbolData = null;
    this.symbolConfigContext = null;
  }

  async confirmAddSymbol() {
    const form = document.getElementById('symbol-config-form');
    if (!form || !this.pendingSymbolData) {
      Utils.showToast('No symbol selected', 'error');
      return;
    }

    const tradableEquity = form.tradable_equity.checked;
    const tradableFutures = form.tradable_futures.checked;
    const tradableOptions = form.tradable_options.checked;
    const underlyingSymbol =
      form.underlying_symbol.value.trim() ||
      this.pendingSymbolData.underlying_symbol ||
      this.pendingSymbolData.name ||
      this.pendingSymbolData.tradingsymbol ||
      this.pendingSymbolData.symbol;

    const readAutoExitValue = (fieldName) => {
      if (!form[fieldName]) {
        return null;
      }
      const value = form[fieldName].value.trim();
      if (!value) {
        return null;
      }
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const autoExitData = {};
    this.autoExitModes.forEach((mode) => {
      autoExitData[`target_points_${mode.key}`] = readAutoExitValue(`target_points_${mode.key}`);
      autoExitData[`stoploss_points_${mode.key}`] = readAutoExitValue(`stoploss_points_${mode.key}`);
      autoExitData[`trailing_stoploss_points_${mode.key}`] =
        readAutoExitValue(`trailing_stoploss_points_${mode.key}`);
      autoExitData[`trailing_activation_points_${mode.key}`] =
        readAutoExitValue(`trailing_activation_points_${mode.key}`);
    });

    const context = this.symbolConfigContext || {};
    const targetWatchlistId = context.watchlistId || this.currentWatchlistId;

    try {
      Utils.showToast(
        context.mode === 'edit' ? 'Saving changes...' : 'Adding symbol...',
        'info'
      );
      const payload = {
        symbol: this.pendingSymbolData.tradingsymbol || this.pendingSymbolData.symbol,
        exchange: this.pendingSymbolData.exchange,
        token: this.pendingSymbolData.token,
        lotsize: this.pendingSymbolData.lotsize || this.pendingSymbolData.lot_size || 1,
        symbol_type: this.pendingSymbolData.symbol_type,
        expiry: this.pendingSymbolData.expiry || null,
        strike: this.pendingSymbolData.strike || null,
        option_type: this.pendingSymbolData.option_type || null,
        instrumenttype: this.pendingSymbolData.instrumenttype || null,
        name: this.pendingSymbolData.name || null,
        tick_size: this.pendingSymbolData.tick_size || this.pendingSymbolData.tickSize || null,
        brsymbol: this.pendingSymbolData.brsymbol || null,
        brexchange: this.pendingSymbolData.brexchange || null,
        tradable_equity: tradableEquity,
        tradable_futures: tradableFutures,
        tradable_options: tradableOptions,
        underlying_symbol: underlyingSymbol,
        ...autoExitData,
      };

      if (context.mode === 'edit' && context.symbolId) {
        await api.updateSymbol(targetWatchlistId, context.symbolId, payload);
        Utils.showToast('Symbol updated successfully', 'success');
      } else {
        await api.addSymbol(targetWatchlistId, payload);
        Utils.showToast('Symbol added successfully', 'success');
      }

      if (this.symbolConfigModal) {
        this.symbolConfigModal.remove();
        this.symbolConfigModal = null;
      }
      this.pendingSymbolData = null;
      this.symbolConfigContext = null;

      await this.renderWatchlistsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Remove symbol from watchlist
   */
  async removeSymbol(watchlistId, symbolId) {
    const confirmed = await Utils.confirm(
      'Remove this symbol from the watchlist?',
      'Confirm Remove'
    );

    if (!confirmed) return;

    try {
      await api.removeSymbol(watchlistId, symbolId);
      // Clear quote cache for this symbol
      const cacheKey = `${watchlistId}_${symbolId}`;
      this.quoteCache.delete(cacheKey);
      Utils.showToast('Symbol removed', 'success');
      await this.renderWatchlistsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Manage watchlist instances
   */
  async manageWatchlistInstances(watchlistId) {
    // Fetch watchlist and all instances
    const [watchlistResponse, instancesResponse] = await Promise.all([
      api.getWatchlistById(watchlistId),
      api.getInstances(),
    ]);

    const watchlist = watchlistResponse.data;
    const allInstances = instancesResponse.data;
    const assignedIds = new Set((watchlist.instances || []).map(i => i.id));

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Manage Instances - ${Utils.escapeHTML(watchlist.name)}</h3>
        </div>
        <div class="modal-body">
          <p class="text-sm text-neutral-700 mb-4">
            Select instances to assign to this watchlist:
          </p>
          <div class="space-y-2" id="instance-checkboxes">
            ${allInstances.map(inst => `
              <label class="flex items-center gap-3 p-2 border rounded hover:bg-neutral-50 cursor-pointer">
                <input type="checkbox"
                       class="instance-checkbox"
                       data-instance-id="${inst.id}"
                       ${assignedIds.has(inst.id) ? 'checked' : ''}>
                <div class="flex-1">
                  <span class="font-semibold">${Utils.escapeHTML(inst.name)}</span>
                  <span class="text-sm text-neutral-600 ml-2">(${Utils.escapeHTML(inst.broker || 'N/A')})</span>
                </div>
                <span class="badge badge-${inst.health_status === 'healthy' ? 'success' : 'warning'}">
                  ${inst.health_status || 'unknown'}
                </span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
            Cancel
          </button>
          <button class="btn btn-buy" onclick="app.submitInstanceAssignments(${watchlistId})">
            Save Assignments
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  /**
   * Submit instance assignments
   */
  async submitInstanceAssignments(watchlistId) {
    try {
      const checkboxes = document.querySelectorAll('.instance-checkbox');
      const selectedIds = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.instanceId));

      // Fetch current assignments
      const watchlistResponse = await api.getWatchlistById(watchlistId);
      const currentIds = new Set((watchlistResponse.data.instances || []).map(i => i.id));

      // Determine adds and removes
      const toAdd = selectedIds.filter(id => !currentIds.has(id));
      const toRemove = Array.from(currentIds).filter(id => !selectedIds.includes(id));

      // Execute assignments
      for (const instanceId of toAdd) {
        await api.assignInstance(watchlistId, instanceId);
      }

      for (const instanceId of toRemove) {
        await api.unassignInstance(watchlistId, instanceId);
      }

      Utils.showToast('Instance assignments updated', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.renderWatchlistsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Delete watchlist
   */
  async deleteWatchlist(watchlistId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to delete this watchlist?',
      'Confirm Delete'
    );

    if (!confirmed) return;

    try {
      await api.deleteWatchlist(watchlistId);
      Utils.showToast('Watchlist deleted', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to cancel this order?',
      'Confirm Cancel'
    );

    if (!confirmed) return;

    try {
      await api.cancelOrder(orderId);
      Utils.showToast('Order cancelled', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async cancelAllOrders(instanceId) {
    const confirmed = await Utils.confirm(
      'Cancel all pending/open orders for this instance?',
      'Confirm Cancel All'
    );

    if (!confirmed) return;

    try {
      await api.cancelAllOrders(instanceId);
      Utils.showToast('Cancel-all request sent', 'success');
      await this.loadOrders(this.currentOrderFilter);
    } catch (error) {
      Utils.showToast('Failed to cancel orders: ' + error.message, 'error');
    }
  }

  async cancelAllOpenOrdersGlobal() {
    const payload = this.orderbookPayload;
    const allInstances = [
      ...(payload?.liveInstances || []),
      ...(payload?.analyzerInstances || []),
    ];
    const instancesWithOpen = allInstances
      .filter(inst => (inst.orders || []).some(order => {
        const status = (order.status || '').toLowerCase();
        return status === 'pending' || status === 'open';
      }));

    if (instancesWithOpen.length === 0) {
      Utils.showToast('No open/pending orders to cancel.', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Cancel open/pending orders across ${instancesWithOpen.length} instance(s)?`,
      'Confirm Global Cancel All'
    );
    if (!confirmed) return;

    try {
      const results = await Promise.allSettled(
        instancesWithOpen.map(inst => api.cancelAllOrders(inst.instance_id))
      );
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        Utils.showToast(`Some instances failed to cancel orders: ${failures.length}`, 'warning');
      } else {
        Utils.showToast('Cancel-all sent for all instances', 'success');
      }
      await this.loadOrders(this.currentOrderFilter);
    } catch (error) {
      Utils.showToast('Failed to cancel orders: ' + error.message, 'error');
    }
  }

  /**
   * Close all positions
   */
  async closeAllPositions(instanceId) {
    const confirmed = await Utils.confirm(
      'Are you sure you want to close ALL positions for this instance?',
      'Confirm Close All'
    );

    if (!confirmed) return;

    try {
      await api.closePositions(instanceId);
      Utils.showToast('Close positions request sent', 'success');
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Refresh current view
   */
  async refreshCurrentView(force = false) {
    if (this.isPaused && !force) return;
    await this.loadView(this.currentView, { force });
  }

  handleInstanceSearch(value) {
    this.instanceSearchQuery = value || '';
    this.renderInstancesView();
  }

  /**
   * Start auto-refresh
   * Note: Does not refresh watchlists view to avoid conflicts with watchlist polling
   */
  startAutoRefresh() {
    // Clear existing interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    if (this.isPaused) return;

    // Refresh every 15 seconds, but skip watchlists view
    // to avoid conflicts with independent watchlist polling
    this.pollingInterval = setInterval(() => {
      // Only refresh if not on watchlists view
      // Watchlists view has its own polling mechanism
      if (this.currentView !== 'watchlists') {
        this.refreshCurrentView();
      }
    }, 15000);
  }

  async refreshWatchlistPositions({ showLoader = false } = {}) {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel) return;

    if (showLoader) {
      positionsPanel.innerHTML = '<div class="p-4"><p class="text-center text-neutral-600">Loading positions…</p></div>';
    }

    try {
      // Fetch the same aggregate payload as the Positions page
      const response = await api.getAllPositions(false);
      const normalized = this.prepareWatchlistPositions(response.data);
      console.debug('[Watchlists] Positions payload', {
        instances: response.data?.instances?.length,
        normalizedLive: normalized.liveInstances.length,
        normalizedAnalyzer: normalized.analyzerInstances.length,
        rawSample: response.data?.instances?.slice?.(0, 2) || [],
      });
      this.latestWatchlistPositionsData = normalized;
      this.updateWatchlistPositionsSummary(normalized);
      positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(normalized);
    } catch (error) {
      console.error('Failed to refresh watchlist positions:', error);
      const message = Utils.escapeHTML(error?.message || 'Unknown error');
      positionsPanel.innerHTML = `<div class="p-4"><p class="text-center text-error-600">Failed to load positions: ${message}</p></div>`;
    }
  }

  renderWatchlistPositionsPanel() {
    const positionsPanel = document.getElementById('watchlist-positions-panel');
    if (!positionsPanel || !this.latestWatchlistPositionsData) return;
    positionsPanel.innerHTML = this.renderWatchlistPositionsMarkup(this.latestWatchlistPositionsData);
  }

  toggleWatchlistPositionInstance(instanceId) {
    if (this.watchlistPositionsExpanded.has(instanceId)) {
      this.watchlistPositionsExpanded.delete(instanceId);
    } else {
      this.watchlistPositionsExpanded.add(instanceId);
    }
    this.renderWatchlistPositionsPanel();
  }

  updateWatchlistPositionsSummary({ overallOpen, overallPnl, refreshedAt }) {
    const summaryEl = document.getElementById('positions-summary-inline');
    if (!summaryEl) return;

    const relativeText = refreshedAt ? `Updated ${Utils.formatRelativeTime(refreshedAt)}` : 'Updated just now';
    summaryEl.innerHTML = `
      <div class="flex items-center">
        <div class="flex items-center gap-3">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Total Open:</span>
          <span class="text-sm font-semibold text-neutral-900">${overallOpen}</span>
        </div>
        <div style="width: 4rem;"></div>
        <div class="w-px h-4 bg-neutral-300"></div>
        <div style="width: 4rem;"></div>
        <div class="flex items-center gap-3">
          <span class="text-[0.65rem] uppercase tracking-[0.25em] text-neutral-500">Overall P&L:</span>
          <span class="text-sm font-semibold ${Utils.getPnLColorClass(overallPnl)}">
            ${Utils.formatCurrency(overallPnl)}
          </span>
        </div>
      </div>
      <span class="text-xs text-neutral-400 whitespace-nowrap">${relativeText}</span>
    `;
  }

  async closeAllOpenPositions() {
    if (!this.latestWatchlistPositionsData) {
      Utils.showToast('Positions not loaded yet', 'warning');
      return;
    }

    const instances = (this.latestWatchlistPositionsData.allInstances || []).filter(
      inst => (inst.positions && inst.positions.length > 0) ||
        (typeof inst.open_positions_count === 'number' && inst.open_positions_count > 0)
    );

    if (instances.length === 0) {
      Utils.showToast('No open positions to close', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Are you sure you want to close all open positions across ${instances.length} instance(s)?`,
      'Confirm Global Close'
    );
    if (!confirmed) return;

    try {
      const responses = await Promise.allSettled(
        instances.map(inst => api.closePositions(inst.instance_id))
      );

      const successes = responses.filter(r => r.status === 'fulfilled').length;
      const failures = responses
        .map((result, idx) => (result.status === 'rejected'
          ? { name: instances[idx].instance_name, error: result.reason?.message || 'Failed' }
          : null))
        .filter(Boolean);

      if (failures.length > 0) {
        Utils.showToast(
          `Closed ${successes} instance(s); ${failures.length} failed (e.g., ${failures[0].name})`,
          'warning',
          5000
        );
      } else {
        Utils.showToast(`Close-all request sent to ${successes} instance(s)`, 'success');
      }
      this.requestWatchlistRefresh({ showLoader: true, force: true });
    } catch (error) {
      Utils.showToast('Failed to close all positions: ' + error.message, 'error');
    }
  }

  async closeAllPositionsGlobal() {
    const data = this.latestAllPositionsData;
    if (!data || !Array.isArray(data.instances)) {
      Utils.showToast('Positions not loaded yet', 'warning');
      return;
    }

    const instances = data.instances.filter(inst => {
      const openCount = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : (inst.positions || []).length;
      return openCount > 0;
    });

    if (instances.length === 0) {
      Utils.showToast('No open positions to close', 'info');
      return;
    }

    const confirmed = await Utils.confirm(
      `Close all open positions across ${instances.length} instance(s)?`,
      'Confirm Global Close All'
    );
    if (!confirmed) return;

    try {
      const responses = await Promise.allSettled(
        instances.map(inst => api.closePositions(inst.instance_id))
      );
      const failures = responses.filter(r => r.status === 'rejected');
      if (failures.length > 0) {
        Utils.showToast(`Some instances failed to close positions: ${failures.length}`, 'warning');
      } else {
        Utils.showToast('Close-all sent for all instances', 'success');
      }
      await this.renderPositionsView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async closePosition(instanceId, encodedSymbol, encodedExchange, encodedProduct) {
    const symbol = decodeURIComponent(encodedSymbol || '');
    const exchange = decodeURIComponent(encodedExchange || '');
    const product = decodeURIComponent(encodedProduct || 'MIS');

    if (!symbol || !exchange) {
      Utils.showToast('Unable to determine symbol/exchange for closing position', 'error');
      return;
    }

    const tradeMode = this.getTradeModeFromSymbol(symbol);
    const confirmed = await Utils.confirm(
      `Close position for ${symbol} on instance ${instanceId}?`,
      'Confirm Close'
    );
    if (!confirmed) return;

    try {
      await api.closePosition(instanceId, {
        symbol,
        exchange,
        tradeMode,
        product,
      });
      Utils.showToast(`Close request submitted for ${symbol}`, 'success');
      await this.refreshWatchlistPositions({ showLoader: false });
    } catch (error) {
      Utils.showToast(`Failed to close ${symbol}: ${error.message}`, 'error');
    }
  }

  getTradeModeFromSymbol(symbol) {
    const normalized = (symbol || '').toUpperCase();
    if (normalized.includes('CE') || normalized.includes('PE')) {
      return 'OPTIONS';
    }
    if (normalized.includes('FUT')) {
      return 'FUTURES';
    }
    return 'EQUITY';
  }

  prepareWatchlistPositions(data = {}) {
    const instances = (data.instances || []).map(inst => {
      const rawPositions = Array.isArray(inst.positions) ? inst.positions : [];
      let openPositions = rawPositions.filter(pos => this.getNormalizedPositionQty(pos) !== 0);

      const serverReportedOpen = typeof inst.open_positions_count === 'number'
        ? inst.open_positions_count
        : openPositions.length;

      if (openPositions.length === 0 && serverReportedOpen > 0) {
        openPositions = rawPositions;
      }

      return {
        ...inst,
        positions: openPositions,
        open_positions_count: serverReportedOpen,
      };
    });

    const liveInstances = instances
      .filter(inst => !inst.is_analyzer_mode && inst.positions.length > 0);

    const analyzerInstances = instances
      .filter(inst => inst.is_analyzer_mode && inst.positions.length > 0);

    const totalOpen = typeof data.overall_open_positions === 'number'
      ? data.overall_open_positions
      : instances.reduce(
          (sum, inst) => sum + (inst.open_positions_count ?? inst.positions.length),
          0
        );

    return {
      overallOpen: totalOpen,
      overallPnl: data.overall_total_pnl ?? 0,
      liveInstances,
      analyzerInstances,
      refreshedAt: data.refreshed_at || new Date().toISOString(),
      allInstances: instances,
    };
  }

  renderWatchlistPositionsMarkup({ overallOpen, overallPnl, liveInstances, analyzerInstances, refreshedAt }) {
    if (liveInstances.length === 0 && analyzerInstances.length === 0) {
      return '<div class="p-4"><p class="text-center text-neutral-600">No open positions across any instance.</p></div>';
    }

    return `
      <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        ${this.renderPositionsSection(
          'Live Market Instances',
          'Instances actively executing trades',
          liveInstances
        )}
        ${this.renderPositionsSection(
          'Analyzer Mode Instances',
          'Instances running in analyzer/paper mode',
          analyzerInstances
        )}
      </div>
    `;
  }

  renderPositionsSection(title, subtitle, instances) {
    if (!instances || instances.length === 0) {
      return `
        <div class="card">
          <div class="card-header-compact">
            <div>
              <h3 class="card-title-compact">${title}</h3>
              <p style="font-size: 0.688rem;" class="text-neutral-600">${subtitle}</p>
            </div>
            <span class="badge-count-compact">0</span>
          </div>
          <div style="padding: 0.5rem;">
            <p style="font-size: 0.688rem;" class="text-neutral-500">No open positions in this category.</p>
          </div>
        </div>
      `;
    }

    return `
      <div class="card">
        <div class="card-header-compact">
          <div>
            <h3 class="card-title-compact">${title}</h3>
            <p style="font-size: 0.688rem;" class="text-neutral-600">${subtitle}</p>
          </div>
          <span class="badge-count-compact">${instances.length}</span>
        </div>
        <div style="padding: 0.375rem; display: flex; flex-direction: column; gap: 0.375rem;">
          ${instances.map(inst => this.renderPositionsInstanceCard(inst)).join('')}
        </div>
      </div>
    `;
  }

  renderPositionsInstanceCard(inst) {
    const positions = inst.positions || [];
    const openCount = typeof inst.open_positions_count === 'number'
      ? inst.open_positions_count
      : positions.length;
    const isExpanded = this.watchlistPositionsExpanded.has(inst.instance_id);

    return `
      <div class="position-instance-card-compact">
        <div class="position-instance-header-compact">
          <button
            class="position-instance-toggle"
            onclick="app.toggleWatchlistPositionInstance(${inst.instance_id})"
            aria-expanded="${isExpanded}"
            aria-controls="positions-body-${inst.instance_id}"
          >
            <span class="toggle-icon ${isExpanded ? 'rotate-90' : ''}">▸</span>
            <span class="instance-name">${Utils.escapeHTML(inst.instance_name)}</span>
            <span class="instance-meta">Broker: <span class="font-medium">${Utils.escapeHTML(inst.broker || 'N/A')}</span></span>
            <span class="instance-meta">Open: <span class="font-medium">${openCount}</span></span>
            <span class="instance-meta">P&L:
              <span class="font-semibold ${Utils.getPnLColorClass(inst.total_pnl)}">
                ${Utils.formatCurrency(inst.total_pnl)}
              </span>
            </span>
          </button>
          <button class="btn-close-all-compact" onclick="app.closeAllPositions(${inst.instance_id})">
            Close All
          </button>
        </div>
        <div id="positions-body-${inst.instance_id}" class="${isExpanded ? 'block' : 'hidden'} border-t border-base-200">
          <div style="padding: 0.25rem;">
            ${positions.length > 0
              ? this.renderPositionsTable(positions, inst.instance_id)
              : '<p style="font-size: 0.688rem;" class="text-neutral-500">No open positions for this instance.</p>'}
          </div>
        </div>
      </div>
    `;
  }

  renderPositionsTable(positions, instanceId = null) {
    return `
      <div class="table-container overflow-x-auto">
        <table class="positions-table-compact" style="table-layout: fixed; width: 100%;">
          <colgroup>
            <col style="width: 24%;">
            <col style="width: 12%;">
            <col style="width: 12%;">
            <col style="width: 14%;">
            <col style="width: 14%;">
            <col style="width: 12%;">
            <col style="width: 12%;">
          </colgroup>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Quantity</th>
              <th>Product</th>
              <th class="text-left">Entry</th>
              <th class="text-left">LTP</th>
              <th class="text-left">P&L</th>
              <th class="text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${positions.map(pos => {
              const qty = this.getNormalizedPositionQty(pos);
              const entry = Number(
                pos.entry_price ??
                pos.average_price ??
                pos.avg_price ??
                pos.net_avg_price ??
                0
              ) || 0;
              const entrySourceRaw = pos.entry_price_source || pos.entryPriceSource || null;
              const entrySourceLabel = (() => {
                if (!entrySourceRaw) return (pos.average_price || pos.avg_price) ? 'BROKER' : '-';
                const base = entrySourceRaw.split(':')[0];
                const map = {
                  broker_avg: 'BROKER',
                  fallback_cache: 'FALLBACK (ORDER)',
                  positionbook_fallback: 'POSITIONBOOK Fallback',
                  median_ltp: 'Median LTP',
                };
                return map[base] || base.replace(/_/g, ' ').toUpperCase();
              })();

              const ltp = Number(
                pos.ltp_resolved ??
                pos.ltp ??
                pos.last_price ??
                pos.lastprice ??
                0
              ) || 0;
              const pnl = pos.pnl_derived != null
                ? pos.pnl_derived
                : (() => {
                    if (entry && ltp && qty !== 0) {
                      return qty > 0 ? (ltp - entry) * qty : (entry - ltp) * Math.abs(qty);
                    }
                    return parseFloat(pos.pnl || pos.unrealized_pnl || pos.mtm || 0);
                  })();
              return `
                <tr>
                  <td class="font-medium">${Utils.escapeHTML(pos.symbol || pos.tradingsymbol || '-')}</td>
                  <td>${qty}</td>
                  <td>${Utils.escapeHTML(pos.product || pos.product_type || '-')}</td>
                  <td class="text-left">
                    ${Utils.formatCurrency(entry)}
                    <div class="text-2xs text-neutral-500">Source: ${Utils.escapeHTML(entrySourceLabel)}</div>
                  </td>
                  <td class="text-left">${Utils.formatCurrency(ltp)}</td>
                  <td class="text-left ${Utils.getPnLColorClass(pnl)}">${Utils.formatCurrency(pnl)}</td>
                  <td class="text-left">
                    ${instanceId ? `
                      <button
                        class="btn-close-position-compact"
                        onclick="app.closePosition(${instanceId}, '${encodeURIComponent(pos.symbol || '')}', '${encodeURIComponent(pos.exchange || '')}', '${encodeURIComponent(pos.product || 'MIS')}')"
                      >
                        Close
                      </button>
                    ` : '-'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  getNormalizedPositionQty(pos) {
    if (!pos) return 0;
    const rawQty =
      pos.quantity ??
      pos.netqty ??
      pos.net_quantity ??
      pos.netQty ??
      pos.net ??
      0;
    const parsed = parseInt(rawQty, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Logout
   */
  async logout() {
    const confirmed = await Utils.confirm('Are you sure you want to logout?');

    if (confirmed) {
      this.stopWsStream();
      await api.logout();
      window.location.href = '/login.html';
    }
  }

  // Placeholder methods
  /**
   * Show edit instance modal
   */
  async showEditInstanceModal(id) {
    try {
      // Fetch instance data
      const response = await api.getInstanceById(id);
      const instance = response.data;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>Edit Instance: ${Utils.escapeHTML(instance.name)}</h3>
          </div>
          <div class="modal-body">
            <form id="edit-instance-form">
              <input type="hidden" name="instance_id" value="${instance.id}">

              <div class="form-group">
                <label class="form-label">Instance Name *</label>
                <input type="text" name="name" class="form-input"
                       value="${Utils.escapeHTML(instance.name)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">Host URL *</label>
                <input type="url" name="host_url" id="edit-instance-host-url" class="form-input"
                       value="${Utils.escapeHTML(instance.host_url)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">API Key *</label>
                <input type="text" name="api_key" id="edit-instance-api-key" class="form-input"
                       value="${Utils.escapeHTML(instance.api_key)}" required>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Update API key if credentials have changed
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Broker (auto-detected, read-only)</label>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                  <input type="text" name="broker" id="edit-instance-broker" class="form-input" readonly
                        value="${Utils.escapeHTML(instance.broker || 'N/A')}"
                        style="background-color: var(--color-neutral-100); cursor: not-allowed;">
                  <button type="button" class="btn btn-neutral btn-outline btn-sm"
                          onclick="app.testEditInstanceConnection()">
                    Test Connection
                  </button>
                </div>
                <small id="edit-connection-status" class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Broker is auto-detected from the OpenAlgo ping response
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Market Data</label>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="market_data_enabled" class="form-checkbox"
                         ${instance.market_data_enabled ? 'checked' : ''}>
                  <span>Use this instance for market data</span>
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Enabled instances are pooled and load-balanced for quotes/LTP/depth.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Broker WebSocket Quotes</label>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="use_ws_quotes" class="form-checkbox"
                         ${instance.use_ws_quotes ? 'checked' : ''}>
                  <span>Use broker WebSocket for quotes/LTP (only if supported)</span>
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Turn on only if the broker/OpenAlgo instance exposes WS quotes. Otherwise keep disabled.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">MultiQuotes (optional)</label>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="supports_multiquotes" class="form-checkbox"
                         ${instance.supports_multiquotes ? 'checked' : ''}>
                  <span>Instance supports <a href="https://docs.openalgo.in/api-documentation/v1/data-api/multiquotes" target="_blank" rel="noopener">OpenAlgo MultiQuotes</a></span>
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  When enabled, watchlist polling uses batched requests (max 1 every 5 seconds) instead of one call per symbol.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Option Chain API (optional)</label>
                <label class="inline-flex items-center gap-2">
                  <input type="checkbox" name="supports_option_chain" class="form-checkbox"
                         ${instance.supports_option_chain ? 'checked' : ''}>
                  <span>Instance supports OpenAlgo Option Chain endpoint (limited strikes with LTP)</span>
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  When enabled, options resolution fetches up to 15 strikes with live quotes directly from the broker.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Strategy Tag</label>
                <input type="text" name="strategy_tag" class="form-input"
                       value="${Utils.escapeHTML(instance.strategy_tag || 'default')}">
              </div>

              <div class="form-group">
                <label class="form-label">Session Target Profit</label>
                <input type="number" name="session_target_profit" class="form-input" step="0.01"
                       value="${instance.session_target_profit ?? ''}">
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Auto-switch to Analyze when this profit is reached within a session.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">Session Max Loss</label>
                <input type="number" name="session_max_loss" class="form-input" step="0.01"
                       value="${instance.session_max_loss ?? ''}">
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Auto-switch to Analyze when this loss is hit within a session.
                </small>
              </div>

              <div class="form-group">
                <label class="form-label">
                  <input type="checkbox" name="is_active"
                         ${instance.is_active ? 'checked' : ''}>
                  Active Instance
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem; color: var(--color-neutral-600);">
                  Inactive instances won't be polled or used for trading
                </small>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Cancel
            </button>
            <button class="btn btn-buy" onclick="app.submitEditInstance()">
              Update Instance
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load instance: ' + error.message, 'error');
    }
  }

  /**
   * Submit edit instance form
   */
  async submitEditInstance() {
    const form = document.getElementById('edit-instance-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Extract instance ID
    const instanceId = parseInt(data.instance_id);
    delete data.instance_id;

    // Convert checkbox to boolean
    data.is_active = form.querySelector('input[name="is_active"]').checked;

    // Remove broker field - it's immutable
    delete data.broker;

    data.market_data_enabled = form.querySelector('input[name="market_data_enabled"]').checked;
    data.use_ws_quotes = form.querySelector('input[name="use_ws_quotes"]').checked;
    data.supports_multiquotes = form.querySelector('input[name="supports_multiquotes"]').checked;
    data.supports_option_chain = form.querySelector('input[name="supports_option_chain"]').checked;

    try {
      await api.updateInstance(instanceId, data);
      Utils.showToast('Instance updated successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * Show edit watchlist modal
   */
  async showEditWatchlistModal(id) {
    try {
      // Fetch watchlist data
      const response = await api.getWatchlistById(id);
      const watchlist = response.data;
      const isBroadcast = this.isBroadcastWatchlist(watchlist);
      const webhookUrl = watchlist.webhook_url || `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>Edit Watchlist: ${Utils.escapeHTML(watchlist.name)}</h3>
          </div>
          <div class="modal-body">
            <form id="edit-watchlist-form">
              <input type="hidden" name="watchlist_id" value="${watchlist.id}">

              <div class="form-group">
                <label class="form-label">Watchlist Name *</label>
                <input type="text" name="name" class="form-input"
                       value="${Utils.escapeHTML(watchlist.name)}" required>
              </div>

              <div class="form-group">
                <label class="form-label">Type</label>
                <div class="flex flex-col gap-2">
                  <label class="form-radio">
                    <input type="radio" name="type" value="standard" ${isBroadcast ? '' : 'checked'}>
                    <span>Standard (symbols + quick orders)</span>
                  </label>
                  <label class="form-radio">
                    <input type="radio" name="type" value="broadcast" ${isBroadcast ? 'checked' : ''}>
                    <span>Broadcast (TradingView webhook fan-out)</span>
                  </label>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Description</label>
                <textarea name="description" class="form-input" rows="3">${Utils.escapeHTML(watchlist.description || '')}</textarea>
              </div>

              <div class="form-group">
                <label class="form-label">
                  <input type="checkbox" name="is_active"
                         ${watchlist.is_active ? 'checked' : ''}>
                  Active Watchlist
                </label>
                <small class="form-help" style="display: block; margin-top: 0.25rem;">
                  Inactive watchlists won't be used for trading
                </small>
              </div>

              ${isBroadcast ? `
                <div class="form-group">
                  <label class="form-label">Webhook</label>
                  <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-xs text-neutral-500">Slug</p>
                        <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
                      </div>
                      ${watchlist.webhook_slug ? `<button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${watchlist.webhook_slug}')">Copy</button>` : ''}
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p class="text-xs text-neutral-500">Webhook URL</p>
                        <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
                      </div>
                      <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
                    </div>
                    <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. Targets are the instances assigned to this watchlist.</p>
                  </div>
                </div>
              ` : ''}
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Cancel
            </button>
            <button class="btn btn-buy" onclick="app.submitEditWatchlist()">
              Update Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load watchlist: ' + error.message, 'error');
    }
  }

  /**
   * Submit edit watchlist form
   */
  async submitEditWatchlist() {
    const form = document.getElementById('edit-watchlist-form');
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Extract watchlist ID
    const watchlistId = parseInt(data.watchlist_id);
    delete data.watchlist_id;

    // Convert checkbox to boolean
    data.is_active = form.querySelector('input[name="is_active"]').checked;
    data.type = form.querySelector('input[name="type"]:checked')?.value || 'standard';

    try {
      await api.updateWatchlist(watchlistId, data);
      Utils.showToast('Watchlist updated successfully', 'success');

      // Close modal
      document.querySelector('.modal-overlay').remove();

      // Refresh view
      await this.refreshCurrentView();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  /**
   * View watchlist details with symbols
   */
  async viewWatchlistDetails(id) {
    try {
      // Fetch watchlist and its symbols
      const [watchlistResponse, symbolsResponse] = await Promise.all([
        api.getWatchlistById(id),
        api.getWatchlistSymbols(id)
      ]);

      const watchlist = watchlistResponse.data;
      const symbols = symbolsResponse.data || [];
      const isBroadcast = this.isBroadcastWatchlist(watchlist);
      const webhookUrl = watchlist.webhook_url || `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${watchlist.webhook_slug || ''}`;

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px;">
          <div class="modal-header">
            <div>
              <h3>Watchlist Details: ${Utils.escapeHTML(watchlist.name)}</h3>
              <p style="margin-top: 0.5rem; color: var(--color-neutral-600); font-size: 0.875rem;">
                ${Utils.escapeHTML(watchlist.description || 'No description')}
              </p>
            </div>
          </div>
          <div class="modal-body">
            <div class="mb-4">
              <h4 class="font-semibold mb-2">Watchlist Information</h4>
              <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem;">
                <div>
                  <span class="text-neutral-600">Status:</span>
                  ${Utils.getStatusBadge(watchlist.is_active ? 'active' : 'inactive')}
                </div>
                <div>
                  <span class="text-neutral-600">Type:</span>
                  <strong>${isBroadcast ? 'Broadcast' : 'Standard'}</strong>
                </div>
                <div>
                  <span class="text-neutral-600">Created:</span>
                  ${Utils.formatRelativeTime(watchlist.created_at)}
                </div>
                <div>
                  <span class="text-neutral-600">Last Updated:</span>
                  ${Utils.formatRelativeTime(watchlist.updated_at)}
                </div>
                ${isBroadcast ? `
                  <div>
                    <span class="text-neutral-600">Instances:</span>
                    <strong>${(watchlist.instances || []).length}</strong>
                  </div>
                  <div>
                    <span class="text-neutral-600">Slug:</span>
                    <code class="code-inline">${Utils.escapeHTML(watchlist.webhook_slug || 'not-set')}</code>
                  </div>
                ` : `
                  <div>
                    <span class="text-neutral-600">Total Symbols:</span>
                    <strong>${symbols.length}</strong>
                  </div>
                  <div></div>
                `}
              </div>
            </div>

            ${isBroadcast ? `
              <div class="mb-4">
                <h4 class="font-semibold mb-2">TradingView Webhook</h4>
                <div class="broadcast-card compact">
                  <div class="broadcast-card__row">
                    <div>
                      <p class="text-xs text-neutral-500">Webhook URL</p>
                      <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
                    </div>
                    <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
                  </div>
                  <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. Targets are the active instances assigned to this watchlist.</p>
                </div>
              </div>
              <div class="mb-4">
                <h4 class="font-semibold mb-2">Assigned Instances (${(watchlist.instances || []).length})</h4>
                ${(watchlist.instances || []).length === 0 ? '<p class="text-neutral-600 text-sm">No instances assigned.</p>' : `
                  <ul class="list">
                    ${(watchlist.instances || []).map(inst => `
                      <li class="list-item">
                        <div>
                          <div class="font-medium">${Utils.escapeHTML(inst.name || inst.host_url)}</div>
                          <div class="text-xs text-neutral-500">${Utils.escapeHTML(inst.host_url)}</div>
                        </div>
                        <span class="badge ${inst.is_active ? 'badge-success' : 'badge-neutral'}">
                          ${inst.is_active ? 'Active' : 'Paused'}
                        </span>
                      </li>
                    `).join('')}
                  </ul>
                `}
              </div>
            ` : `
              <div class="mb-4">
                <h4 class="font-semibold mb-2">Symbols (${symbols.length})</h4>
                ${symbols.length === 0 ? `
                  <p class="text-center text-neutral-600" style="padding: 2rem;">
                    No symbols in this watchlist
                  </p>
                ` : `
                  <div class="table-container" style="max-height: 400px; overflow-y: auto;">
                    <table class="table">
                      <thead>
                        <tr>
                          <th>Exchange</th>
                          <th>Symbol</th>
                          <th>Quantity Type</th>
                          <th>Quantity</th>
                          <th>Product</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${symbols.map(s => `
                          <tr>
                            <td><span class="badge badge-neutral">${Utils.escapeHTML(s.exchange)}</span></td>
                            <td class="font-medium">${Utils.escapeHTML(s.symbol)}</td>
                            <td>${Utils.escapeHTML(s.qty_type || 'FIXED')}</td>
                            <td>${s.qty_value || 1}</td>
                            <td><span class="badge badge-info">${Utils.escapeHTML(s.product_type || 'MIS')}</span></td>
                            <td>${s.is_enabled ?
                              '<span class="badge badge-success">Enabled</span>' :
                              '<span class="badge badge-neutral">Disabled</span>'
                            }</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `}
              </div>
            `}
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" onclick="this.closest('.modal-overlay').remove()">
              Close
            </button>
            <button class="btn btn-buy" onclick="this.closest('.modal-overlay').remove(); app.showEditWatchlistModal(${id})">
              Edit Watchlist
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Close on overlay click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
    } catch (error) {
      Utils.showToast('Failed to load watchlist details: ' + error.message, 'error');
    }
  }

  /**
   * Filter orders by status
   */
  async filterOrders(status) {
    this.currentOrderFilter = status || '';
    await this.loadOrders(this.currentOrderFilter);
  }

  renderPausedPlaceholder() {}
}

// Initialize app when DOM is ready and expose globally for inline handlers
window.app = new DashboardApp();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.app.init());
} else {
  window.app.init();
}
