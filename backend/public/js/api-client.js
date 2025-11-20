/**
 * API Client
 * Handles all HTTP requests to the backend REST API
 */

class APIClient {
  constructor(baseURL = '/api/v1') {
    this.baseURL = baseURL;
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

    if (options.body) {
      config.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, config);

      // Handle empty responses
      if (response.status === 204) {
        return { status: 'success' };
      }

      const data = await response.json();

      if (!response.ok) {
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
      throw new APIError(
        'Network error. Please check your connection.',
        0,
        'NETWORK_ERROR'
      );
    }
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
  async getDashboardMetrics() {
    return this.request('/dashboard/metrics');
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

  async getOrderbook(status = '') {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    return this.request(`/orders/orderbook?${params.toString()}`);
  }

  async getTradebook() {
    return this.request('/trades/tradebook');
  }

  // Position APIs
  async getAllPositions(onlyOpen = false) {
    const params = new URLSearchParams({ onlyOpen: onlyOpen.toString() });
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

  // Auth APIs
  async getCurrentUser() {
    return this.request('/user', { baseURL: '/api' });
  }

  async logout() {
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
