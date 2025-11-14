/**
 * OpenAlgo API Client
 * HTTP client with exponential backoff retry logic
 */

import { ProxyAgent } from 'undici';
import { log } from '../../core/logger.js';
import { OpenAlgoError } from '../../core/errors.js';
import config from '../../core/config.js';
import { maskApiKey } from '../../utils/sanitizers.js';

/**
 * OpenAlgo HTTP Client
 */
class OpenAlgoClient {
  constructor() {
    this.timeout = config.openalgo.requestTimeout;
    // Store both critical and non-critical retry configs
    this.criticalRetries = config.openalgo.critical.maxRetries;
    this.criticalRetryDelay = config.openalgo.critical.retryDelay;
    this.nonCriticalRetries = config.openalgo.nonCritical.maxRetries;
    this.nonCriticalRetryDelay = config.openalgo.nonCritical.retryDelay;

    // Create undici ProxyAgent that uses environment proxy
    // TLS verification can be disabled via PROXY_TLS_REJECT_UNAUTHORIZED=false (development only)
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY ||
                     process.env.http_proxy || process.env.HTTP_PROXY;

    // Parse TLS verification setting (defaults to true for security)
    const rejectUnauthorized = process.env.PROXY_TLS_REJECT_UNAUTHORIZED !== 'false';

    if (proxyUrl) {
      try {
        // Parse URL to safely extract host info without credentials
        const proxyUrlObj = new URL(proxyUrl);
        log.info('Using proxy for OpenAlgo requests', {
          proxy: `${proxyUrlObj.protocol}//${proxyUrlObj.host}`,
          tlsVerification: rejectUnauthorized
        });

        if (!rejectUnauthorized) {
          log.warn('TLS certificate verification is DISABLED for proxy connections. Use only in development!');
        }

        this.dispatcher = new ProxyAgent({
          uri: proxyUrl,
          requestTls: {
            rejectUnauthorized,
          },
        });
      } catch (error) {
        log.error('Invalid proxy URL, proceeding without proxy', { error: error.message });
        this.dispatcher = null;
      }
    } else {
      log.info('No proxy configured for OpenAlgo requests');
      this.dispatcher = null;
    }
  }

  /**
   * Make HTTP request to OpenAlgo API
   * @param {Object} instance - Instance configuration
   * @param {string} endpoint - API endpoint (e.g., 'ping', 'placeorder')
   * @param {Object} data - Request payload (apikey will be added)
   * @param {string} method - HTTP method (default: POST)
   * @param {Object} options - Request options
   * @param {boolean} options.isCritical - Whether this is a critical operation (default: false)
   * @returns {Promise<Object>} - API response
   */
  async request(instance, endpoint, data = {}, method = 'POST', options = {}) {
    const { host_url, api_key } = instance;
    const { isCritical = false } = options;

    if (!host_url || !api_key) {
      throw new OpenAlgoError('Instance host_url and api_key are required', endpoint);
    }

    const url = `${host_url}/api/v1/${endpoint}`;
    const payload = { ...data, apikey: api_key };
    const maskedPayload = { ...data, apikey: maskApiKey(api_key) };

    // Select retry configuration based on operation type
    const maxRetries = isCritical ? this.criticalRetries : this.nonCriticalRetries;
    const baseRetryDelay = isCritical ? this.criticalRetryDelay : this.nonCriticalRetryDelay;

    // Check if this is an order placement endpoint
    const isOrderPlacement = ['placeorder', 'placesmartorder'].includes(endpoint);

    // Store initial position for order placement requests
    let initialPosition = null;
    if (isOrderPlacement) {
      try {
        initialPosition = await this._getPositionForOrder(instance, data);
      } catch (error) {
        log.warn('Could not fetch initial position for order retry check', {
          endpoint,
          symbol: data.symbol,
          exchange: data.exchange,
          error: error.message,
        });
      }
    }

    log.debug('OpenAlgo API Request', {
      endpoint,
      url,
      payload: maskedPayload,
      isCritical,
      maxRetries,
      baseRetryDelay
    });

    // Retry with exponential backoff
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const response = await this._makeRequest(url, method, payload);
        const duration = Date.now() - startTime;

        log.openalgo(method, endpoint, duration, true);

        return response;
      } catch (error) {
        lastError = error;

        // Don't retry on client errors (4xx)
        if (error.statusCode >= 400 && error.statusCode < 500) {
          throw error;
        }

        // For order placement requests, check if order was actually placed before retrying
        if (isOrderPlacement && attempt < maxRetries && initialPosition !== null) {
          try {
            const currentPosition = await this._getPositionForOrder(instance, data);

            // Check if position changed (order was likely placed)
            if (this._hasPositionChanged(initialPosition, currentPosition, data)) {
              log.info('Order appears to have been placed despite error - skipping retry', {
                endpoint,
                symbol: data.symbol,
                exchange: data.exchange,
                initialQty: initialPosition?.netqty || 0,
                currentQty: currentPosition?.netqty || 0,
                expectedChange: data.quantity || 0,
                action: data.action,
              });

              // Return a synthetic success response
              return {
                status: 'success',
                orderid: 'DEDUPED',
                message: 'Order placed successfully (verified via position check)',
              };
            }
          } catch (posCheckError) {
            log.warn('Position check failed during retry, proceeding with retry', {
              endpoint,
              error: posCheckError.message,
            });
          }
        }

        // Log retry attempt
        if (attempt < maxRetries) {
          const delay = baseRetryDelay * Math.pow(2, attempt);
          log.warn('OpenAlgo request failed, retrying', {
            endpoint,
            attempt: attempt + 1,
            maxRetries,
            delay,
            isCritical,
            error: error.message,
          });

          await this._sleep(delay);
        }
      }
    }

    // All retries failed
    log.error('OpenAlgo request failed after retries', lastError, {
      endpoint,
      maxRetries,
      isCritical,
    });

    throw lastError;
  }

  /**
   * Make HTTP request with timeout
   * @private
   */
  async _makeRequest(url, method, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const fetchOptions = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      };

      // Use proxy dispatcher if configured
      if (this.dispatcher) {
        fetchOptions.dispatcher = this.dispatcher;
      }

      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);

      // Clone response so we can read it twice if JSON parsing fails
      const responseClone = response.clone();

      // Parse response
      let responseData;
      try {
        responseData = await response.json();
      } catch (error) {
        // Use the cloned response to get text for error message
        let responseText;
        try {
          responseText = await responseClone.text();
        } catch (textError) {
          responseText = 'Unable to read response body';
        }
        throw new OpenAlgoError(
          `Invalid JSON response: ${responseText.substring(0, 200)}`,
          url,
          response.status
        );
      }

      // Check if request was successful
      if (!response.ok) {
        throw new OpenAlgoError(
          responseData.message || `HTTP ${response.status}: ${response.statusText}`,
          url,
          response.status
        );
      }

      // Check OpenAlgo response status
      if (responseData.status === 'error') {
        throw new OpenAlgoError(
          responseData.message || 'OpenAlgo API returned error status',
          url,
          response.status
        );
      }

      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new OpenAlgoError(
          `Request timeout after ${this.timeout}ms`,
          url
        );
      }

      if (error instanceof OpenAlgoError) {
        throw error;
      }

      throw new OpenAlgoError(
        `Network error: ${error.message}`,
        url
      );
    }
  }

  /**
   * Sleep for specified milliseconds
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================
  // Account APIs
  // ==========================================

  /**
   * Test connection to OpenAlgo instance
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { broker, message }
   */
  async ping(instance) {
    const response = await this.request(instance, 'ping');
    return response.data;
  }

  /**
   * Get analyzer mode status
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { mode, analyze_mode, total_logs }
   */
  async getAnalyzerStatus(instance) {
    const response = await this.request(instance, 'analyzer');
    return response.data;
  }

  /**
   * Toggle analyzer mode
   * @param {Object} instance - Instance configuration
   * @param {boolean} mode - true for analyze, false for live
   * @returns {Promise<Object>} - Updated analyzer status
   */
  async toggleAnalyzer(instance, mode) {
    const response = await this.request(instance, 'analyzer/toggle', { mode });
    return response.data;
  }

  /**
   * Get account funds
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Fund details
   */
  async getFunds(instance) {
    const response = await this.request(instance, 'funds');
    return response.data;
  }

  /**
   * Get holdings
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Holdings list
   */
  async getHoldings(instance) {
    const response = await this.request(instance, 'holdings');
    return response.data?.holdings || [];
  }

  // ==========================================
  // Order APIs
  // ==========================================

  /**
   * Get order book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - { orders, statistics }
   */
  async getOrderBook(instance) {
    const response = await this.request(instance, 'orderbook');
    return response.data;
  }

  /**
   * Place smart order (position-aware)
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order parameters
   * @returns {Promise<Object>} - { orderid }
   */
  async placeSmartOrder(instance, orderData) {
    const response = await this.request(instance, 'placesmartorder', orderData, 'POST', { isCritical: true });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
    };
  }

  /**
   * Cancel order
   * @param {Object} instance - Instance configuration
   * @param {string} orderid - Order ID to cancel
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - { orderid, status }
   */
  async cancelOrder(instance, orderid, strategy) {
    const response = await this.request(instance, 'cancelorder', {
      orderid,
      strategy,
    }, 'POST', { isCritical: true });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
    };
  }

  /**
   * Cancel all orders
   * @param {Object} instance - Instance configuration
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - { canceled_orders, failed_cancellations }
   */
  async cancelAllOrders(instance, strategy) {
    const response = await this.request(instance, 'cancelallorder', {
      strategy,
    }, 'POST', { isCritical: true });
    return response.data || response;
  }

  // ==========================================
  // Position APIs
  // ==========================================

  /**
   * Get position book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Positions list
   */
  async getPositionBook(instance) {
    const response = await this.request(instance, 'positionbook');
    return response.data || [];
  }

  /**
   * Close all positions
   * @param {Object} instance - Instance configuration
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - Result
   */
  async closePosition(instance, strategy) {
    const response = await this.request(instance, 'closeposition', {
      strategy,
    }, 'POST', { isCritical: true });
    return response.data || response;
  }

  /**
   * Get open position for specific symbol
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code
   * @param {string} product - Product type
   * @param {string} strategy - Strategy tag
   * @returns {Promise<Object>} - { quantity }
   */
  async getOpenPosition(instance, symbol, exchange, product, strategy) {
    const response = await this.request(instance, 'openposition', {
      symbol,
      exchange,
      product,
      strategy,
    });
    return response;
  }

  // ==========================================
  // Trade APIs
  // ==========================================

  /**
   * Get trade book
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Array>} - Trades list
   */
  async getTradeBook(instance) {
    const response = await this.request(instance, 'tradebook');
    return response.data || [];
  }

  // ==========================================
  // Market Data APIs
  // ==========================================

  /**
   * Get quotes for symbols
   * @param {Object} instance - Instance configuration
   * @param {Array<Object>} symbols - Array of {exchange, symbol}
   * @returns {Promise<Array>} - Quotes list
   */
  async getQuotes(instance, symbols) {
    // OpenAlgo quotes API expects one symbol at a time
    // Make parallel requests for all symbols
    const quotePromises = symbols.map(async ({ exchange, symbol }) => {
      try {
        const response = await this.request(instance, 'quotes', {
          exchange,
          symbol,
        });

        // Return quote data with exchange and symbol for matching
        return {
          exchange,
          symbol,
          ...response.data,
        };
      } catch (error) {
        log.warn('Failed to fetch quote', error, { exchange, symbol });
        return null;
      }
    });

    const results = await Promise.all(quotePromises);

    // Filter out failed requests
    return results.filter(quote => quote !== null);
  }

  /**
   * Get market depth
   * @param {Object} instance - Instance configuration
   * @param {string} exchange - Exchange code
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} - Market depth data
   */
  async getDepth(instance, exchange, symbol) {
    const response = await this.request(instance, 'depth', {
      exchange,
      symbol,
    });
    return response.data;
  }

  /**
   * Search symbols
   * @param {Object} instance - Instance configuration
   * @param {string} query - Search query
   * @returns {Promise<Array>} - Symbol list
   */
  async searchSymbols(instance, query) {
    const response = await this.request(instance, 'search', {
      query,
    });
    return response.data || [];
  }

  /**
   * Get symbol details (point lookup for validation)
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code (NSE, NFO, BSE, BFO, etc.)
   * @returns {Promise<Object>} - Symbol metadata with instrumenttype, expiry, strike, lotsize, etc.
   */
  async getSymbol(instance, symbol, exchange) {
    const response = await this.request(instance, 'symbol', {
      symbol,
      exchange,
    });
    return response.data || response;
  }

  /**
   * Place split order (splits large order into smaller chunks)
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order parameters with splitsize
   * @returns {Promise<Object>} - { success_orders, failed_orders }
   */
  async placeSplitOrder(instance, orderData) {
    const response = await this.request(instance, 'splitorder', orderData, 'POST', { isCritical: true });
    return response.data || response;
  }

  /**
   * Modify existing order
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Modified order parameters
   * @returns {Promise<Object>} - { orderid, status }
   */
  async modifyOrder(instance, orderData) {
    const response = await this.request(instance, 'modifyorder', orderData, 'POST', { isCritical: true });
    return {
      orderid: response.orderid || response.data?.orderid,
      status: response.status,
    };
  }

  // ==========================================
  // Options & Derivatives APIs
  // ==========================================

  /**
   * Get expiry dates for symbol
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Underlying symbol (e.g., NIFTY, BANKNIFTY)
   * @param {string} exchange - Exchange code (default: NFO)
   * @returns {Promise<Array>} - Array of expiry dates
   */
  async getExpiry(instance, symbol, exchange = 'NFO') {
    const response = await this.request(instance, 'expiry', {
      symbol,
      exchange,
      instrumenttype: 'options',
    });
    return response.expiry_list || response.data || [];
  }

  /**
   * Get option chain
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Underlying symbol
   * @param {string} expiry - Expiry date
   * @param {string} exchange - Exchange code
   * @returns {Promise<Object>} - Option chain data
   */
  async getOptionChain(instance, symbol, expiry, exchange = 'NFO') {
    const response = await this.request(instance, 'optionchain', {
      symbol,
      expiry,
      exchange,
    });
    return response.data || response;
  }

  // ==========================================
  // Historical Data APIs
  // ==========================================

  /**
   * Get supported intervals for historical data
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Supported intervals by timeframe
   */
  async getIntervals(instance) {
    const response = await this.request(instance, 'intervals');
    return response.data;
  }

  /**
   * Get historical data
   * @param {Object} instance - Instance configuration
   * @param {string} symbol - Trading symbol
   * @param {string} exchange - Exchange code
   * @param {string} interval - Time interval
   * @param {string} start_date - Start date (YYYY-MM-DD)
   * @param {string} end_date - End date (YYYY-MM-DD)
   * @returns {Promise<Array>} - Historical OHLCV data
   */
  async getHistory(instance, symbol, exchange, interval, start_date, end_date) {
    const response = await this.request(instance, 'history', {
      symbol,
      exchange,
      interval,
      start_date,
      end_date,
    });
    return response.data || [];
  }

  // ==========================================
  // Margin Calculator APIs
  // ==========================================

  /**
   * Calculate margin requirement
   * @param {Object} instance - Instance configuration
   * @param {Array<Object>} positions - Array of position objects
   * @returns {Promise<Object>} - Margin calculation
   */
  async calculateMargin(instance, positions) {
    const response = await this.request(instance, 'margin', {
      positions,
    });
    return response.data;
  }

  // ==========================================
  // Contract Info APIs
  // ==========================================

  /**
   * Get contract information
   * @param {Object} instance - Instance configuration
   * @param {string} exchange - Exchange code
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object>} - Contract details
   */
  async getContractInfo(instance, exchange, symbol) {
    const response = await this.request(instance, 'contractinfo', {
      exchange,
      symbol,
    });
    return response.data || response;
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Validate instance connection
   * @param {Object} instance - Instance configuration
   * @returns {Promise<boolean>} - true if connection is valid
   */
  async validateConnection(instance) {
    try {
      await this.ping(instance);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get comprehensive account summary
   * @param {Object} instance - Instance configuration
   * @returns {Promise<Object>} - Complete account data
   */
  async getAccountSummary(instance) {
    try {
      const [funds, holdings, positions, orders, trades] = await Promise.all([
        this.getFunds(instance),
        this.getHoldings(instance),
        this.getPositionBook(instance),
        this.getOrderBook(instance),
        this.getTradeBook(instance),
      ]);

      return {
        funds,
        holdings,
        positions,
        orders,
        trades,
      };
    } catch (error) {
      throw new OpenAlgoError(
        `Failed to fetch account summary: ${error.message}`,
        'account_summary'
      );
    }
  }

  // ==========================================
  // Private Helper Methods for Order Deduplication
  // ==========================================

  /**
   * Get position for order validation
   * Fetches the specific position that would be affected by this order
   * @private
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order data (symbol, exchange, action, quantity)
   * @returns {Promise<Object|null>} - Position object or null if not found
   */
  async _getPositionForOrder(instance, orderData) {
    try {
      const positions = await this.getPositionBook(instance);

      // Find position matching this order's symbol and exchange
      const position = positions.find(
        (pos) => pos.symbol === orderData.symbol && pos.exchange === orderData.exchange
      );

      return position || null;
    } catch (error) {
      log.warn('Failed to fetch position for order validation', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if position changed based on order execution
   * Compares initial and current positions to detect if order was placed
   * @private
   * @param {Object|null} initialPosition - Position before order attempt
   * @param {Object|null} currentPosition - Position after order attempt
   * @param {Object} orderData - Order data (action, quantity)
   * @returns {boolean} - true if position changed consistent with order execution
   */
  _hasPositionChanged(initialPosition, currentPosition, orderData) {
    // Handle different position field names (netqty vs net_qty)
    const getNetQty = (pos) => {
      if (!pos) return 0;
      return pos.netqty || pos.net_qty || 0;
    };

    const initialQty = getNetQty(initialPosition);
    const currentQty = getNetQty(currentPosition);

    // Calculate expected change based on action
    const orderQty = parseInt(orderData.quantity, 10) || 0;
    let expectedChange = 0;

    if (orderData.action === 'BUY') {
      expectedChange = orderQty;
    } else if (orderData.action === 'SELL') {
      expectedChange = -orderQty;
    }

    // Check if actual change matches expected change
    const actualChange = currentQty - initialQty;

    // Allow for some tolerance in case of partial fills or broker-specific handling
    // Consider position changed if actual change is at least 80% of expected
    const tolerance = 0.8;
    const minExpectedChange = Math.abs(expectedChange) * tolerance;

    const positionChanged = Math.abs(actualChange) >= minExpectedChange;

    if (positionChanged) {
      log.debug('Position change detected', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        action: orderData.action,
        orderQty,
        initialQty,
        currentQty,
        actualChange,
        expectedChange,
      });
    }

    return positionChanged;
  }
}

// Export singleton instance
export default new OpenAlgoClient();
export { OpenAlgoClient };
