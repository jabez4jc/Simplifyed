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
    // Track snapshot success separately from position value to enable dedup for new positions
    let initialPosition = null;
    let initialPositionFetched = false;
    if (isOrderPlacement) {
      try {
        initialPosition = await this._getPositionForOrder(instance, data);
        initialPositionFetched = true; // Snapshot succeeded (position may be null for new positions)
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

        // Don't retry on client errors (4xx) - these indicate bad requests
        if (error.statusCode >= 400 && error.statusCode < 500) {
          log.error('OpenAlgo API Client Error (4xx) - not retrying', error, {
            endpoint,
            statusCode: error.statusCode,
            isCritical
          });
          throw error;
        }

        // Log 5xx server errors that will be retried
        if (error.statusCode >= 500) {
          log.warn('OpenAlgo API Server Error (5xx) - will retry', {
            endpoint,
            statusCode: error.statusCode,
            attempt: attempt + 1,
            maxRetries,
            isCritical,
            error: error.message
          });
        }

        // For order placement requests, check if order was actually placed before retrying
        if (isOrderPlacement && attempt < maxRetries && initialPositionFetched) {
          try {
            const currentPosition = await this._getPositionForOrder(instance, data);

            // Check if position changed (order was likely placed)
            if (this._hasPositionChanged(initialPosition, currentPosition, data)) {
              // Use consistent field access for logging (handle both netqty and net_qty)
              const getNetQty = (pos) => pos?.netqty || pos?.net_qty || 0;

              // Fetch actual order ID from order book
              let actualOrderId = null;
              try {
                actualOrderId = await this._findOrderIdFromOrderBook(instance, data);
              } catch (orderIdError) {
                log.warn('Could not fetch actual order ID from order book', {
                  symbol: data.symbol,
                  error: orderIdError.message,
                });
              }

              // Only deduplicate if we successfully found the actual order ID
              // Otherwise, continue with normal retry logic to avoid breaking downstream workflows
              if (actualOrderId) {
                log.info('Order appears to have been placed despite error - skipping retry', {
                  endpoint,
                  symbol: data.symbol,
                  exchange: data.exchange,
                  initialQty: getNetQty(initialPosition),
                  currentQty: getNetQty(currentPosition),
                  expectedChange: data.quantity || 0,
                  action: data.action,
                  foundOrderId: actualOrderId,
                });

                // Return success response with actual order ID
                return {
                  status: 'success',
                  orderid: actualOrderId,
                  message: 'Order placed successfully (verified via position check)',
                };
              } else {
                // Position changed but couldn't find order ID - log and continue with retry
                log.warn('Position changed but order ID not found in order book - continuing with retry', {
                  endpoint,
                  symbol: data.symbol,
                  exchange: data.exchange,
                  initialQty: getNetQty(initialPosition),
                  currentQty: getNetQty(currentPosition),
                  expectedChange: data.quantity || 0,
                  action: data.action,
                });
              }
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
   * Get instruments list (all available symbols from broker)
   * This is a browser-accessible GET endpoint with query parameters
   * @param {Object} instance - Instance configuration
   * @param {string} [exchange] - Optional exchange filter (NSE, BSE, NFO, BFO, BCD, CDS, MCX, NSE_INDEX, BSE_INDEX)
   * @returns {Promise<Array>} - Array of instrument objects with symbol, name, exchange, token, lotsize, instrumenttype, etc.
   */
  async getInstruments(instance, exchange = null) {
    const { host_url, api_key } = instance;

    if (!host_url || !api_key) {
      throw new OpenAlgoError('Instance host_url and api_key are required', 'instruments');
    }

    // Build query parameters
    const params = new URLSearchParams({
      apikey: api_key,
      format: 'json'
    });

    if (exchange) {
      params.append('exchange', exchange);
    }

    const url = `${host_url}/api/v1/instruments?${params.toString()}`;

    const maxRetries = this.nonCriticalRetries;
    const baseRetryDelay = this.nonCriticalRetryDelay;
    let startTime;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        startTime = Date.now();

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(this.timeout),
          dispatcher: this.dispatcher,
        });

        const duration = Date.now() - startTime;

        // Handle non-200 responses
        if (!response.ok) {
          const errorText = await response.text();
          log.warn('Instruments API returned non-200 status', {
            endpoint: 'instruments',
            status: response.status,
            statusText: response.statusText,
            exchange: exchange || 'ALL'
          });

          throw new OpenAlgoError(
            `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
            'instruments',
            response.status
          );
        }

        // Parse JSON response
        let data;
        try {
          const text = await response.text();
          data = JSON.parse(text);
        } catch (parseError) {
          throw new OpenAlgoError(
            `Invalid JSON response: ${parseError.message}`,
            'instruments'
          );
        }

        log.info('OpenAlgo API Call', {
          method: 'GET',
          endpoint: 'instruments',
          duration: `${duration}ms`,
          success: true,
          exchange: exchange || 'ALL',
          count: Array.isArray(data) ? data.length : (data.data ? data.data.length : 0)
        });

        // Handle response format - could be direct array or wrapped in {data: [...]}
        if (Array.isArray(data)) {
          return data;
        } else if (data.data && Array.isArray(data.data)) {
          return data.data;
        } else {
          throw new OpenAlgoError('Unexpected response format: expected array of instruments', 'instruments');
        }

      } catch (error) {
        const duration = Date.now() - startTime;

        // Handle OpenAlgo API errors
        if (error instanceof OpenAlgoError) {
          // Don't retry on 4xx client errors (bad request, auth, etc.)
          if (error.statusCode >= 400 && error.statusCode < 500) {
            log.error('OpenAlgo API Client Error (4xx) - not retrying', error, {
              method: 'GET',
              endpoint: 'instruments',
              duration: `${duration}ms`,
              statusCode: error.statusCode,
              exchange: exchange || 'ALL'
            });
            throw error;
          }

          // Retry on 5xx server errors (transient failures)
          if (error.statusCode >= 500 && attempt < maxRetries) {
            const delay = baseRetryDelay * Math.pow(2, attempt);
            log.warn('OpenAlgo API Server Error (5xx) - retrying', {
              method: 'GET',
              endpoint: 'instruments',
              statusCode: error.statusCode,
              attempt: attempt + 1,
              maxRetries,
              retryDelay: `${delay}ms`,
              error: error.message,
              exchange: exchange || 'ALL'
            });

            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // All retries exhausted or non-retryable error
          log.error('OpenAlgo API Error', error, {
            method: 'GET',
            endpoint: 'instruments',
            duration: `${duration}ms`,
            statusCode: error.statusCode,
            exchange: exchange || 'ALL'
          });
          throw error;
        }

        // Retry on network/timeout errors
        if (attempt < maxRetries) {
          const delay = baseRetryDelay * Math.pow(2, attempt);
          log.warn('Instruments fetch failed, retrying', {
            endpoint: 'instruments',
            attempt: attempt + 1,
            maxRetries,
            retryDelay: `${delay}ms`,
            error: error.message,
            exchange: exchange || 'ALL'
          });

          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // All retries exhausted
        log.error('Instruments fetch failed after retries', error, {
          method: 'GET',
          endpoint: 'instruments',
          attempts: maxRetries + 1,
          exchange: exchange || 'ALL'
        });

        throw new OpenAlgoError(
          `Failed after ${maxRetries + 1} attempts: ${error.message}`,
          'instruments'
        );
      }
    }
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

      // Find position matching this order's symbol, exchange, and product
      // Product matching is critical because brokers maintain separate positions
      // for different product types (e.g., RELIANCE-MIS vs RELIANCE-CNC)
      const position = positions.find(
        (pos) =>
          pos.symbol === orderData.symbol &&
          pos.exchange === orderData.exchange &&
          pos.product === (orderData.product || 'MIS') // Default to MIS if not specified
      );

      return position || null;
    } catch (error) {
      log.warn('Failed to fetch position for order validation', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        product: orderData.product,
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
    // Validate action is strictly BUY or SELL
    if (orderData.action !== 'BUY' && orderData.action !== 'SELL') {
      log.warn('Invalid order action for position deduplication', {
        action: orderData.action,
        symbol: orderData.symbol,
      });
      return false;
    }

    // Validate quantity is a positive integer
    const orderQty = parseInt(orderData.quantity, 10);
    if (isNaN(orderQty) || orderQty <= 0) {
      log.warn('Invalid order quantity for position deduplication', {
        quantity: orderData.quantity,
        symbol: orderData.symbol,
      });
      return false;
    }

    // Handle different position field names (netqty vs net_qty)
    const getNetQty = (pos) => {
      if (!pos) return 0;
      return pos.netqty || pos.net_qty || 0;
    };

    const initialQty = getNetQty(initialPosition);
    const currentQty = getNetQty(currentPosition);

    // Calculate expected change based on action
    let expectedChange = 0;

    if (orderData.action === 'BUY') {
      expectedChange = orderQty;
    } else if (orderData.action === 'SELL') {
      expectedChange = -orderQty;
    }

    // Check if actual change matches expected change
    const actualChange = currentQty - initialQty;

    // Enforce that position movement direction matches expected direction
    if (expectedChange !== 0 && actualChange !== 0) {
      if (Math.sign(actualChange) !== Math.sign(expectedChange)) {
        log.debug('Position changed in opposite direction - not deduplicating', {
          symbol: orderData.symbol,
          exchange: orderData.exchange,
          action: orderData.action,
          expectedChange,
          actualChange,
        });
        return false;
      }
    }

    // Allow for some tolerance in case of partial fills or broker-specific handling
    // Consider position changed if actual change is at least 80% of expected
    const tolerance = 0.8;
    const minExpectedChange = Math.abs(expectedChange) * tolerance;

    const positionChanged = Math.abs(actualChange) >= minExpectedChange;

    // Calculate fill percentage for logging
    const fillPercentage = Math.abs(expectedChange) > 0
      ? (Math.abs(actualChange) / Math.abs(expectedChange)) * 100
      : 0;

    if (positionChanged) {
      // Warn if partial fill is between 50-80% threshold
      if (fillPercentage >= 50 && fillPercentage < 80) {
        log.warn('Partial fill detected near deduplication threshold', {
          symbol: orderData.symbol,
          exchange: orderData.exchange,
          action: orderData.action,
          orderQty,
          actualChange,
          expectedChange,
          fillPercentage: fillPercentage.toFixed(2) + '%',
          message: 'Order may have been partially filled - potential for duplicate on retry',
        });
      }

      log.debug('Position change detected', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        action: orderData.action,
        orderQty,
        initialQty,
        currentQty,
        actualChange,
        expectedChange,
        fillPercentage: fillPercentage.toFixed(2) + '%',
      });
    }

    return positionChanged;
  }

  /**
   * Find actual order ID from order book for deduplication
   * Fetches the most recent matching order from order book
   * @private
   * @param {Object} instance - Instance configuration
   * @param {Object} orderData - Order data (symbol, exchange, product, action, quantity)
   * @returns {Promise<string|null>} - Order ID or null if not found
   */
  async _findOrderIdFromOrderBook(instance, orderData) {
    try {
      const orderBookResponse = await this.getOrderBook(instance);
      const orders = orderBookResponse?.orders || orderBookResponse || [];

      if (!Array.isArray(orders) || orders.length === 0) {
        log.warn('Order book empty or invalid for order ID lookup', {
          symbol: orderData.symbol,
        });
        return null;
      }

      // Parse order quantity for validation
      const requestedQty = parseInt(orderData.quantity, 10);
      if (isNaN(requestedQty) || requestedQty <= 0) {
        log.warn('Invalid quantity in order data for order ID lookup', {
          quantity: orderData.quantity,
        });
        return null;
      }

      // Calculate time window (60 seconds) for filtering recent orders only
      const now = Date.now();
      const timeWindowMs = 60 * 1000; // 60 seconds
      const earliestAllowedTime = now - timeWindowMs;

      // Invalid order statuses that should be excluded
      const invalidStatuses = ['CANCELLED', 'REJECTED', 'FAILED', 'cancelled', 'rejected', 'failed'];

      // Filter orders matching this order's characteristics
      // Include quantity validation with tolerance for partial fills (20% variance)
      // Only match orders placed within the last 60 seconds
      // Exclude orders with invalid statuses
      const quantityTolerance = 0.2; // 20% tolerance
      const matchingOrders = orders.filter((order) => {
        const orderQty = parseInt(order.quantity, 10) || 0;
        const qtyDiff = Math.abs(orderQty - requestedQty);
        const qtyWithinTolerance = qtyDiff <= requestedQty * quantityTolerance;

        // Check if order is within time window
        const orderTime = new Date(order.timestamp || 0).getTime();
        const withinTimeWindow = orderTime >= earliestAllowedTime;

        // Check if order status is valid (not cancelled/rejected/failed)
        const orderStatus = (order.order_status || '').toLowerCase();
        const hasValidStatus = !invalidStatuses.some(status => status.toLowerCase() === orderStatus);

        return (
          order.symbol === orderData.symbol &&
          order.exchange === orderData.exchange &&
          order.product === (orderData.product || 'MIS') &&
          order.action === orderData.action &&
          qtyWithinTolerance &&
          withinTimeWindow &&
          hasValidStatus
        );
      });

      if (matchingOrders.length === 0) {
        log.warn('No matching orders found in order book', {
          symbol: orderData.symbol,
          exchange: orderData.exchange,
          action: orderData.action,
          product: orderData.product || 'MIS',
          quantity: requestedQty,
          timeWindowSeconds: 60,
          totalOrdersInBook: orders.length,
        });
        return null;
      }

      // Sort by timestamp descending (most recent first)
      // Handle various timestamp formats
      matchingOrders.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA; // Descending order
      });

      // Return the most recent order ID
      const mostRecentOrder = matchingOrders[0];

      log.debug('Found matching order ID from order book', {
        orderid: mostRecentOrder.orderid,
        symbol: mostRecentOrder.symbol,
        exchange: mostRecentOrder.exchange,
        action: mostRecentOrder.action,
        quantity: mostRecentOrder.quantity,
        order_status: mostRecentOrder.order_status,
        timestamp: mostRecentOrder.timestamp,
        matchingOrdersCount: matchingOrders.length,
        timeWindowSeconds: 60,
        filtersApplied: ['symbol', 'exchange', 'product', 'action', 'quantity±20%', 'time≤60s', 'validStatus'],
      });

      return mostRecentOrder.orderid || null;
    } catch (error) {
      log.warn('Failed to fetch order ID from order book', {
        symbol: orderData.symbol,
        exchange: orderData.exchange,
        error: error.message,
      });
      return null;
    }
  }
}

// Export singleton instance
export default new OpenAlgoClient();
export { OpenAlgoClient };
