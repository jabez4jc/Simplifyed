/**
 * Simplifyed Admin V2 - Dashboard: API Playground view.
 */

const API_PLAYGROUND_PRESETS = [
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
      { label: 'POST /api/v1/orders', method: 'POST', path: '/api/v1/orders', headers: { 'Content-Type': 'application/json' }, body: '{\n  "instanceId": 1,\n  "symbol": "NIFTY23DEC24000CE",\n  "action": "BUY",\n  "quantity": 50,\n  "request_id": "manual-001"\n}', description: 'Place a single order (manual payload).' },
      { label: 'POST /api/v1/orders/batch', method: 'POST', path: '/api/v1/orders/batch', headers: { 'Content-Type': 'application/json' }, body: '{\n  "request_id": "batch-001",\n  "orders": []\n}', description: 'Place batch orders.' },
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
      { label: 'POST /api/v1/quickorders', method: 'POST', path: '/api/v1/quickorders', headers: { 'Content-Type': 'application/json' }, body: '{\n  "symbolId": 1,\n  "instanceId": "ALL",\n  "action": "BUY",\n  "tradeMode": "EQUITY",\n  "quantity": 1,\n  "orderType": "LIMIT",\n  "request_id": "quick-001"\n}', description: 'Place a quick order (auto-resolved symbols).' },
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

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  async renderApiPlaygroundView() {
    const contentArea = document.getElementById('content-area');

    if (!this.hasPermission('pages.api_playground.view')) {
      contentArea.innerHTML = `
        <div class="p-6">
          <div class="alert alert-warning">
            <div>
              <h3 class="font-semibold">Access required</h3>
              <p class="text-sm text-neutral-600">You do not have permission to use the API Playground.</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const presetOptions = [
      '<option value="">Select a preset (optional)</option>',
      ...API_PLAYGROUND_PRESETS.map((p, idx) => `<option value="${idx}">${Utils.escapeHTML(p.label)}</option>`),
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
      const preset = API_PLAYGROUND_PRESETS[index];
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
}.prototype));
