/**
 * API Client
 * Handles all HTTP requests to the backend REST API
 */

class APIClient {
  constructor(baseURL = '/api/v1') {
    this.baseURL = baseURL;
  }

  _getToken() {
    try {
      return localStorage.getItem('auth_token');
    } catch (e) {
      return null;
    }
  }

  /**
   * Generic request handler
   */
  async request(endpoint, options = {}) {
    // Allow per-request baseURL override
    const baseURL = options.baseURL || this.baseURL;
    const url = `${baseURL}${endpoint}`;

    const config = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include', // Include cookies for session
    };

    const token = this._getToken();
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body) {
      config.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, config);

      // Handle empty responses
      if (response.status === 204) {
        return { status: 'success' };
      }

      let data = null;
      const contentType = response.headers.get('content-type') || '';
      const looksJson = contentType.includes('application/json');
      const responseClone = response.clone();

      if (looksJson) {
        try {
          data = await response.json();
        } catch (error) {
          let text = '';
          try {
            text = await responseClone.text();
          } catch (textError) {
            text = '';
          }
          throw new APIError(
            `Invalid JSON response (HTTP ${response.status}): ${text.substring(0, 200)}`,
            response.status,
            'INVALID_JSON'
          );
        }
      } else {
        const text = await response.text();
        throw new APIError(
          `Non-JSON response (HTTP ${response.status}): ${text.substring(0, 200)}`,
          response.status,
          'NON_JSON_RESPONSE'
        );
      }

      if (!response.ok) {
        // If not authenticated, redirect to Google OAuth flow
        if (response.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        // If access is pending, send the user to the holding page
        if (response.status === 403 && data?.code === 'ACCESS_PENDING') {
          window.location.href = '/access-pending.html';
          return;
        }
        throw new APIError(
          data.message || 'Request failed',
          response.status,
          data.code,
          data.errors
        );
      }

      return data;
    } catch (error) {
      if (error instanceof APIError) {
        throw error;
      }

      // Network error
      const message = error?.message || 'Network error. Please check your connection.';
      throw new APIError(message, 0, 'NETWORK_ERROR');
    }
  }

  async getPublicConfig() {
    return this.request('/public-config');
  }

  // Instance APIs
  async getInstances(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/instances?${params}`);
  }

  async getInstanceById(id) {
    return this.request(`/instances/${id}`);
  }

  async createInstance(data) {
    return this.request('/instances', {
      method: 'POST',
      body: data,
    });
  }

  async updateInstance(id, data) {
    return this.request(`/instances/${id}`, {
      method: 'PUT',
      body: data,
    });
  }
  async getNotifications() {
    return this.request('/notifications');
  }

  async getAuditLogs(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/audit?${params}`);
  }
  async markNotificationRead(id) {
    return this.request(`/notifications/${id}/read`, { method: 'POST' });
  }

  async getInstanceHealthTests() {
    return this.request('/settings/instance-health-tests/config');
  }

  async updateInstanceHealthTests(body) {
    return this.request('/settings/instance-health-tests/config', {
      method: 'PUT',
      body,
    });
  }

  async deleteInstance(id) {
    return this.request(`/instances/${id}`, {
      method: 'DELETE',
    });
  }

  async refreshInstance(id) {
    return this.request(`/instances/${id}/refresh`, {
      method: 'POST',
    });
  }

  async updateHealth(id) {
    return this.request(`/instances/${id}/health`, {
      method: 'POST',
    });
  }

  async updatePnL(id) {
    return this.request(`/instances/${id}/pnl`, {
      method: 'POST',
    });
  }

  async toggleAnalyzer(id, mode) {
    return this.request(`/instances/${id}/analyzer/toggle`, {
      method: 'POST',
      body: { mode },
    });
  }

  async testConnection(host_url, api_key) {
    return this.request('/instances/test/connection', {
      method: 'POST',
      body: { host_url, api_key },
    });
  }

  async testApiKey(host_url, api_key) {
    return this.request('/instances/test/apikey', {
      method: 'POST',
      body: { host_url, api_key },
    });
  }

  async bulkUpdateInstances(data) {
    return this.request('/instances/bulk-update', {
      method: 'POST',
      body: data,
    });
  }

  // Market Data Instance APIs
  async getMarketDataInstance() {
    return this.request('/instances/market-data/instance');
  }

  async getAllMarketDataInstances() {
    return this.request('/instances/market-data/all');
  }

  // Dashboard APIs
  async getDashboardMetrics(options = {}) {
    const params = new URLSearchParams();
    if (options.refresh) {
      params.set('refresh', 'true');
    }
    const query = params.toString();
    return this.request(`/dashboard/metrics${query ? `?${query}` : ''}`);
  }

  // Telemetry + snapshots
  async getTelemetryRateLimits() {
    return this.request('/telemetry/rate-limits');
  }

  async getTelemetryCacheStatus() {
    return this.request('/telemetry/cache-status');
  }

  async getQuoteSnapshots(params = {}) {
    const search = new URLSearchParams(params);
    return this.request(`/snapshots/quotes?${search.toString()}`);
  }

  async getPositionSnapshot(instanceId, params = {}) {
    const search = new URLSearchParams(params);
    return this.request(`/snapshots/positions/${instanceId}?${search.toString()}`);
  }

  async getOrderSnapshot(instanceId, params = {}) {
    const search = new URLSearchParams(params);
    return this.request(`/snapshots/orders/${instanceId}?${search.toString()}`);
  }

  async getTradeSnapshot(instanceId, params = {}) {
    const search = new URLSearchParams(params);
    return this.request(`/snapshots/trades/${instanceId}?${search.toString()}`);
  }

  // Watchlist APIs
  async getWatchlists(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/watchlists?${params}`);
  }

  async getWatchlistById(id) {
    return this.request(`/watchlists/${id}`);
  }

  async createWatchlist(data) {
    return this.request('/watchlists', {
      method: 'POST',
      body: data,
    });
  }

  async updateWatchlist(id, data) {
    return this.request(`/watchlists/${id}`, {
      method: 'PUT',
      body: data,
    });
  }

  async deleteWatchlist(id) {
    return this.request(`/watchlists/${id}`, {
      method: 'DELETE',
    });
  }

  async cloneWatchlist(id, name) {
    return this.request(`/watchlists/${id}/clone`, {
      method: 'POST',
      body: { name },
    });
  }

  async getWatchlistSymbols(id) {
    return this.request(`/watchlists/${id}/symbols`);
  }

  // --- Strategy Builder ---

  async getStrategies(watchlistId) {
    return this.request(`/strategies?watchlist_id=${watchlistId}`);
  }

  async getStrategy(id) {
    return this.request(`/strategies/${id}`);
  }

  async createStrategy(data) {
    return this.request('/strategies', { method: 'POST', body: data });
  }

  async updateStrategy(id, data) {
    return this.request(`/strategies/${id}`, { method: 'PUT', body: data });
  }

  async deleteStrategy(id) {
    return this.request(`/strategies/${id}`, { method: 'DELETE' });
  }

  async addStrategyLeg(strategyId, data) {
    return this.request(`/strategies/${strategyId}/legs`, { method: 'POST', body: data });
  }

  async updateStrategyLeg(legId, data) {
    return this.request(`/strategies/legs/${legId}`, { method: 'PUT', body: data });
  }

  async deleteStrategyLeg(legId) {
    return this.request(`/strategies/legs/${legId}`, { method: 'DELETE' });
  }

  // instanceId is optional - omit to target every instance assigned to the strategy's watchlist.
  // legId is optional - omit to enter every leg, pass it to enter just that one.
  async executeStrategy(id, { instanceId = null, legId = null } = {}) {
    return this.request(`/strategies/${id}/execute`, {
      method: 'POST',
      body: { ...(instanceId ? { instanceId } : {}), ...(legId ? { legId } : {}) },
    });
  }

  async previewStrategyLeg(legId, instanceId) {
    return this.request(`/strategies/legs/${legId}/preview?instanceId=${instanceId}`);
  }

  // instanceId is optional - omit to close every still-open leg across every instance assigned
  // to the strategy's watchlist. legId is optional - omit to close every open leg, pass it to
  // close just that one.
  async exitStrategy(id, { instanceId = null, legId = null } = {}) {
    return this.request(`/strategies/${id}/exit`, {
      method: 'POST',
      body: { ...(instanceId ? { instanceId } : {}), ...(legId ? { legId } : {}) },
    });
  }

  async getStrategyStatus(id) {
    return this.request(`/strategies/${id}/status`);
  }

  async getOptionGreeks({ symbol, exchange, instanceId, underlyingSymbol, underlyingExchange }) {
    const params = new URLSearchParams({ symbol, exchange, instanceId });
    if (underlyingSymbol) params.set('underlyingSymbol', underlyingSymbol);
    if (underlyingExchange) params.set('underlyingExchange', underlyingExchange);
    return this.request(`/symbols/greeks?${params}`);
  }

  async addSymbol(watchlistId, data) {
    return this.request(`/watchlists/${watchlistId}/symbols`, {
      method: 'POST',
      body: data,
    });
  }

  async updateSymbol(watchlistId, symbolId, data) {
    return this.request(`/watchlists/${watchlistId}/symbols/${symbolId}`, {
      method: 'PUT',
      body: data,
    });
  }

  async removeSymbol(watchlistId, symbolId) {
    return this.request(`/watchlists/${watchlistId}/symbols/${symbolId}`, {
      method: 'DELETE',
    });
  }

  async assignInstance(watchlistId, instanceId) {
    return this.request(`/watchlists/${watchlistId}/instances`, {
      method: 'POST',
      body: { instanceId },
    });
  }

  async unassignInstance(watchlistId, instanceId) {
    return this.request(`/watchlists/${watchlistId}/instances/${instanceId}`, {
      method: 'DELETE',
    });
  }

  // Order APIs
  async getOrders(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/orders?${params}`);
  }

  async getOrderById(id) {
    return this.request(`/orders/${id}`);
  }

  async placeOrder(data) {
    return this.request('/orders', {
      method: 'POST',
      body: data,
    });
  }

  async placeMultipleOrders(orders) {
    return this.request('/orders/batch', {
      method: 'POST',
      body: { orders },
    });
  }

  async cancelOrder(id) {
    return this.request(`/orders/${id}/cancel`, {
      method: 'POST',
    });
  }

  async cancelAllOrders(instanceId, strategy = null) {
    return this.request('/orders/cancel-all', {
      method: 'POST',
      body: { instanceId, strategy },
    });
  }

  async syncOrderStatus(instanceId) {
    return this.request(`/orders/sync/${instanceId}`, {
      method: 'POST',
    });
  }

  async getOrderbook(status = '', options = {}) {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (options.refresh === true) params.append('refresh', 'true');
    return this.request(`/orders/orderbook?${params.toString()}`);
  }

  async getTradebook() {
    return this.request('/trades/tradebook');
  }

  // Position APIs
  async getAllPositions(options = false) {
    const resolved = typeof options === 'object' ? options : { onlyOpen: !!options };
    const params = new URLSearchParams({
      onlyOpen: String(Boolean(resolved.onlyOpen)),
    });
    if (resolved.refresh === false) {
      params.append('refresh', 'false');
    }
    return this.request(`/positions/all?${params}`);
  }

  async getPositions(instanceId) {
    return this.request(`/positions/${instanceId}`);
  }

  async getPositionPnL(instanceId) {
    return this.request(`/positions/${instanceId}/pnl`);
  }

  async getAggregatedPnL() {
    return this.request('/positions/aggregate/pnl');
  }

  async getDailyPnlSnapshots(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/pnl-snapshots?${params}`);
  }

  async closePositions(instanceId) {
    return this.request(`/positions/${instanceId}/close`, {
      method: 'POST',
    });
  }

  async closePosition(instanceId, payload) {
    return this.request(`/positions/${instanceId}/close/position`, {
      method: 'POST',
      body: payload,
    });
  }

  // Symbol APIs
  async searchSymbols(query, instanceId = null) {
    const params = new URLSearchParams({ query });
    if (instanceId) params.append('instanceId', instanceId);
    return this.request(`/symbols/search?${params}`);
  }

  async validateSymbol(symbol, exchange, instanceId = null) {
    return this.request('/symbols/validate', {
      method: 'POST',
      body: { symbol, exchange, instanceId },
    });
  }

  /**
   * Get quotes for multiple symbols
   * @param {Array<{exchange: string, symbol: string}>} symbols - Array of symbol objects
   * @param {number} instanceId - Instance ID to fetch quotes from
   * @returns {Promise<Object>} - Quotes data
   */
  async getQuotes(symbols, instanceId) {
    return this.request('/symbols/quotes', {
      method: 'POST',
      body: { symbols, instanceId },
    });
  }

  async getMarketData(exchange, symbol) {
    return this.request(`/symbols/market-data/${exchange}/${symbol}`);
  }

  /**
   * Symbol utility operations - consolidates frontend/backend logic
   * @param {string} operation - Operation name (getDerivativeExchange, extractUnderlying, formatExpiry, normalizeExpiry, classifySymbol, batch)
   * @param {Object} params - Operation parameters
   * @returns {Promise<Object>} - Operation result
   */
  async symbolUtils(operation, params = {}) {
    return this.request('/symbols/utils', {
      method: 'POST',
      body: { operation, params },
    });
  }

  /**
   * Batch symbol utility operations
   * @param {Array<{operation: string, params: Object}>} operations - Array of operations
   * @returns {Promise<Object>} - Array of results
   */
  async symbolUtilsBatch(operations) {
    return this.request('/symbols/utils', {
      method: 'POST',
      body: { operation: 'batch', operations },
    });
  }

  /**
   * Get derivative exchange for a given exchange
   * @param {string} exchange - Cash exchange (NSE, BSE, etc.)
   * @returns {Promise<string>} - Derivative exchange (NFO, BFO, etc.)
   */
  async getDerivativeExchange(exchange) {
    const result = await this.symbolUtils('getDerivativeExchange', { exchange });
    return result.data?.exchange;
  }

  /**
   * Extract underlying symbol from derivative symbol
   * @param {string} symbol - Full symbol name
   * @param {string} exchange - Exchange
   * @param {string} symbol_type - Symbol type
   * @returns {Promise<string>} - Underlying symbol
   */
  async extractUnderlying(symbol, exchange, symbol_type) {
    const result = await this.symbolUtils('extractUnderlying', { symbol, exchange, symbol_type });
    return result.data?.underlying;
  }

  /**
   * Format expiry from ISO to OpenAlgo format
   * @param {string} expiry - Expiry in YYYY-MM-DD format
   * @returns {Promise<string>} - Expiry in DD-MMM-YY format
   */
  async formatExpiry(expiry) {
    const result = await this.symbolUtils('formatExpiry', { expiry });
    return result.data?.expiry;
  }

  /**
   * Normalize expiry from OpenAlgo to ISO format
   * @param {string} expiry - Expiry in DD-MMM-YY format
   * @returns {Promise<string>} - Expiry in YYYY-MM-DD format
   */
  async normalizeExpiry(expiry) {
    const result = await this.symbolUtils('normalizeExpiry', { expiry });
    return result.data?.expiry;
  }

  /**
   * Build option symbol in OpenAlgo format
   * @param {string} underlying - Underlying symbol (e.g., NIFTY)
   * @param {string} expiry - Expiry date (YYYY-MM-DD or DD-MMM-YY)
   * @param {number|string} strike - Strike price
   * @param {string} optionType - CE or PE
   * @returns {Promise<string>} - Option symbol (e.g., NIFTY28NOV2524000CE)
   * @see https://docs.openalgo.in/symbol-format
   */
  async buildOptionSymbol(underlying, expiry, strike, optionType) {
    const result = await this.symbolUtils('buildOptionSymbol', { underlying, expiry, strike, optionType });
    return result.data?.symbol;
  }

  /**
   * Build futures symbol in OpenAlgo format
   * @param {string} underlying - Underlying symbol (e.g., NIFTY)
   * @param {string} expiry - Expiry date (YYYY-MM-DD or DD-MMM-YY)
   * @returns {Promise<string>} - Futures symbol (e.g., NIFTY28NOV25FUT)
   * @see https://docs.openalgo.in/symbol-format
   */
  async buildFuturesSymbol(underlying, expiry) {
    const result = await this.symbolUtils('buildFuturesSymbol', { underlying, expiry });
    return result.data?.symbol;
  }

  /**
   * Parse option symbol to extract components
   * @param {string} symbol - Option symbol (e.g., NIFTY28NOV2524000CE)
   * @returns {Promise<Object>} - { underlying, expiry, strike, optionType }
   */
  async parseOptionSymbol(symbol) {
    const result = await this.symbolUtils('parseOptionSymbol', { symbol });
    return result.data;
  }

  /**
   * Parse futures symbol to extract components
   * @param {string} symbol - Futures symbol (e.g., NIFTY28NOV25FUT)
   * @returns {Promise<Object>} - { underlying, expiry }
   */
  async parseFuturesSymbol(symbol) {
    const result = await this.symbolUtils('parseFuturesSymbol', { symbol });
    return result.data;
  }

  /**
   * Consolidated quote subscription - fetches quotes for multiple symbol sources
   * Deduplicates and batches requests to avoid fetching same symbol multiple times
   * @param {Object} sources - Symbol sources
   * @param {Array<{exchange, symbol}>} sources.watchlistSymbols - Watchlist symbols
   * @param {Array<{exchange, symbol}>} sources.positionSymbols - Position symbols
   * @param {Array<{exchange, symbol}>} sources.additionalSymbols - Additional symbols
   * @param {boolean} orderCritical - Use aggressive TTL for order-critical operations
   * @returns {Promise<Object>} - Quotes with source tags
   */
  async subscribeQuotes(sources = {}, orderCritical = false) {
    return this.request('/symbols/quotes/subscribe', {
      method: 'POST',
      body: {
        watchlistSymbols: sources.watchlistSymbols || [],
        positionSymbols: sources.positionSymbols || [],
        additionalSymbols: sources.additionalSymbols || [],
        orderCritical,
      },
    });
  }

  async getExpiry(symbol, options = {}) {
    const {
      exchange = 'NFO',
      instanceId = null,
      instrumentTypes = null,
      matchField = null,
    } = options;
    const params = new URLSearchParams({ symbol, exchange });
    if (instanceId) {
      params.append('instanceId', instanceId);
    }
    if (instrumentTypes && (Array.isArray(instrumentTypes) ? instrumentTypes.length : true)) {
      const value = Array.isArray(instrumentTypes)
        ? instrumentTypes.join(',')
        : instrumentTypes;
      params.append('instrumenttype', value);
    }
    if (matchField && typeof matchField === 'string') {
      params.append('matchField', matchField);
    }
    return this.request(`/symbols/expiry?${params}`);
  }

  async getOptionChain(symbol, expiry, options = {}) {
    const {
      exchange = 'NFO',
      type = null,
      includeQuotes = false,
      strikeWindow = null,
    } = options;

    const params = new URLSearchParams({
      symbol,
      expiry,
      exchange,
    });

    if (type) {
      params.append('type', type);
    }
    if (includeQuotes) {
      params.append('include_quotes', 'true');
    }
    if (strikeWindow != null) {
      params.append('strike_window', String(strikeWindow));
    }

    return this.request(`/symbols/option-chain?${params}`);
  }

  // Polling APIs
  async getPollingStatus() {
    return this.request('/polling/status');
  }

  async startPolling() {
    return this.request('/polling/start', {
      method: 'POST',
    });
  }

  async stopPolling() {
    return this.request('/polling/stop', {
      method: 'POST',
    });
  }

  async startMarketDataPolling(watchlistId) {
    return this.request('/polling/market-data/start', {
      method: 'POST',
      body: { watchlistId },
    });
  }

  async stopMarketDataPolling() {
    return this.request('/polling/market-data/stop', {
      method: 'POST',
    });
  }

  // Quick Order APIs
  async placeQuickOrder(data) {
    return this.request('/quickorders', {
      method: 'POST',
      body: data,
    });
  }

  async getQuickOrderOptionsPreview({ symbolId, expiry, optionsLeg } = {}) {
    if (!symbolId) {
      throw new Error('symbolId is required for options preview');
    }

    const params = new URLSearchParams({ symbolId: String(symbolId) });
    if (expiry) params.append('expiry', expiry);
    if (optionsLeg) params.append('optionsLeg', optionsLeg);

    return this.request(`/quickorders/options/preview?${params}`);
  }

  async getQuickOrderFuturesPreview({ symbolId, expiry } = {}) {
    if (!symbolId) {
      throw new Error('symbolId is required for futures preview');
    }

    const params = new URLSearchParams({ symbolId: String(symbolId) });
    if (expiry) params.append('expiry', expiry);

    return this.request(`/quickorders/futures/preview?${params}`);
  }

  async getQuickOrders(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/quickorders?${params}`);
  }

  async getQuickOrderById(id) {
    return this.request(`/quickorders/${id}`);
  }

  async getQuickOrdersBySymbol(symbol, filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/quickorders/symbol/${symbol}?${params}`);
  }

  async getQuickOrderStats(filters = {}) {
    const params = new URLSearchParams(filters);
    return this.request(`/quickorders/stats/summary?${params}`);
  }

  async syncQuickOrders(instanceId, days = 7) {
    const params = new URLSearchParams({ days: String(days) });
    return this.request(`/quickorders/sync/${instanceId}?${params.toString()}`, {
      method: 'POST',
    });
  }

  // Auth APIs
  async getCurrentUser() {
    return this.request('/user', { baseURL: '/api' });
  }

  async logout() {
    try {
      // Clear locally stored auth token (Supabase access token)
      localStorage.removeItem('auth_token');

      // Clear Supabase persisted sessions (keys start with "sb-" or legacy prefix)
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('sb-') || key.startsWith('supabase.auth.'))) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    } catch (_) {
      // ignore localStorage errors (private mode, etc.)
    }

    return fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  }
}

/**
 * Custom API Error class
 */
class APIError extends Error {
  constructor(message, statusCode, code, errors = []) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
  }
}

// Export singleton instance
const api = new APIClient();
