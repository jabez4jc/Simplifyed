/**
 * Quote Router Service
 * Fetches market quotes and routes them to appropriate legs for risk calculations
 *
 * Responsibilities:
 * - Poll quotes from OpenAlgo instances every 200ms
 * - Route quotes to correct price field (option premium vs underlying)
 * - Update leg_state.best_favorable_price for TSL tracking
 * - Handle multiple instances in parallel
 * - Determine correct price based on instrument type
 *
 * Features:
 * - Fast polling (200ms for real-time updates)
 * - Instrument-type aware routing
 * - Per-leg quote management
 * - Best price tracking for trailing stops
 * - Restart-safe (rebuilds from leg_state)
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { config } from '../core/config.js';
import openalgoClient from '../integrations/openalgo/client.js';

class QuoteRouterService {
  constructor() {
    this.pollingInterval = null;
    this.isRunning = false;
    this.quoteCache = new Map(); // Cache for last known quotes
  }

  /**
   * Start quote polling
   * @param {number} intervalMs - Polling interval in milliseconds (default: 200)
   */
  start(intervalMs = 200) {
    if (this.isRunning) {
      log.warn('Quote router already running');
      return;
    }

    if (!config.features.enableRiskEngine) {
      log.warn('Quote router disabled by feature flag');
      return;
    }

    this.isRunning = true;

    log.info('Starting quote router', { interval_ms: intervalMs });

    // Initial sync
    this.syncAllQuotes().catch(err => {
      log.error('Initial quote sync failed', err);
    });

    // Start polling
    this.pollingInterval = setInterval(() => {
      this.syncAllQuotes().catch(err => {
        log.error('Quote sync failed', err);
      });
    }, intervalMs);

    log.info('Quote router started', { interval_ms: intervalMs });
  }

  /**
   * Stop quote polling
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunning = false;
    this.quoteCache.clear();
    log.info('Quote router stopped');
  }

  /**
   * Sync quotes for all active legs with risk enabled
   */
  async syncAllQuotes() {
    try {
      // Get all active legs with risk enabled
      const activeLegs = await db.all(
        'SELECT * FROM leg_state WHERE is_active = 1 AND risk_enabled = 1'
      );

      if (activeLegs.length === 0) {
        return;
      }

      // Group legs by instance to minimize API calls
      const legsByInstance = this._groupLegsByInstance(activeLegs);

      // Fetch quotes for each instance in parallel
      const quotePromises = [];
      for (const [instanceId, legs] of Object.entries(legsByInstance)) {
        quotePromises.push(
          this.fetchAndRouteQuotes(parseInt(instanceId), legs).catch(err => {
            log.error('Failed to fetch quotes for instance', err, {
              instance_id: instanceId,
            });
            return null;
          })
        );
      }

      await Promise.all(quotePromises);
    } catch (error) {
      log.error('Failed to sync all quotes', error);
    }
  }

  /**
   * Fetch quotes for an instance and route to legs
   * @param {number} instanceId - Instance ID
   * @param {Array} legs - Array of leg_state records
   */
  async fetchAndRouteQuotes(instanceId, legs) {
    try {
      // Get instance
      const instance = await db.get(
        'SELECT * FROM instances WHERE id = ?',
        [instanceId]
      );

      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      // Skip if analyzer mode
      if (instance.is_analyzer_mode) {
        return { skipped: true, reason: 'analyzer_mode' };
      }

      // Build unique list of symbols we need quotes for
      const symbolRequests = this._buildSymbolRequests(legs);

      // Fetch quotes from OpenAlgo (batch request if supported)
      const quotes = await this._fetchQuotes(instance, symbolRequests);

      if (!quotes || quotes.length === 0) {
        log.debug('No quotes received', { instance_id: instanceId });
        return { success: false, error: 'no_quotes' };
      }

      // Route quotes to appropriate legs and update best_favorable_price
      await this._routeQuotesToLegs(legs, quotes);

      log.debug('Quotes routed for instance', {
        instance_id: instanceId,
        legs_count: legs.length,
        quotes_count: quotes.length,
      });

      return {
        success: true,
        instance_id: instanceId,
        legs_updated: legs.length,
        quotes_received: quotes.length,
      };
    } catch (error) {
      log.error('Failed to fetch and route quotes', error, { instanceId });
      throw error;
    }
  }

  /**
   * Route quotes to legs and update prices
   * @private
   * @param {Array} legs - Array of leg_state records
   * @param {Array} quotes - Array of quote objects
   */
  async _routeQuotesToLegs(legs, quotes) {
    // Build quote lookup map by symbol:exchange
    const quoteMap = new Map();
    for (const quote of quotes) {
      const key = `${quote.exchange}:${quote.symbol}`;
      quoteMap.set(key, quote);
    }

    // Update each leg with appropriate price
    const updatePromises = [];
    for (const leg of legs) {
      const key = `${leg.exchange}:${leg.symbol}`;
      const quote = quoteMap.get(key);

      if (!quote) {
        log.debug('No quote found for leg', {
          leg_id: leg.id,
          symbol: leg.symbol,
          exchange: leg.exchange,
        });
        continue;
      }

      // Determine which price to use based on instrument type
      const currentPrice = this._selectPriceForInstrument(leg, quote);

      if (!currentPrice || currentPrice <= 0) {
        log.warn('Invalid price for leg', {
          leg_id: leg.id,
          symbol: leg.symbol,
          current_price: currentPrice,
        });
        continue;
      }

      // Update leg with new price and best_favorable_price
      updatePromises.push(
        this.updateLegPrice(leg, currentPrice, quote)
      );
    }

    await Promise.all(updatePromises);
  }

  /**
   * Update leg with current price and best_favorable_price for TSL
   * @param {Object} leg - Leg state record
   * @param {number} currentPrice - Current market price
   * @param {Object} quote - Full quote object for additional data
   */
  async updateLegPrice(leg, currentPrice, quote) {
    try {
      const isLong = leg.net_qty > 0;
      const isShort = leg.net_qty < 0;

      // Calculate new best_favorable_price for TSL tracking
      let newBestPrice = leg.best_favorable_price;

      if (isLong) {
        // For long positions, track highest price
        if (!newBestPrice || currentPrice > newBestPrice) {
          newBestPrice = currentPrice;
        }
      } else if (isShort) {
        // For short positions, track lowest price
        if (!newBestPrice || currentPrice < newBestPrice) {
          newBestPrice = currentPrice;
        }
      }

      // Update leg_state with current price and best price
      await db.run(
        `UPDATE leg_state SET
          current_ltp = ?,
          best_favorable_price = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [currentPrice, newBestPrice, leg.id]
      );

      // Update cache
      const cacheKey = `${leg.exchange}:${leg.symbol}`;
      this.quoteCache.set(cacheKey, {
        price: currentPrice,
        timestamp: Date.now(),
        quote: quote,
      });

      log.debug('Leg price updated', {
        leg_id: leg.id,
        symbol: leg.symbol,
        current_price: currentPrice,
        best_favorable_price: newBestPrice,
        is_long: isLong,
      });
    } catch (error) {
      log.error('Failed to update leg price', error, {
        leg_id: leg.id,
        symbol: leg.symbol,
      });
      throw error;
    }
  }

  /**
   * Get current quote for a symbol from cache
   * @param {string} symbol - Symbol
   * @param {string} exchange - Exchange
   * @returns {Object|null} - Cached quote or null
   */
  getCachedQuote(symbol, exchange) {
    const key = `${exchange}:${symbol}`;
    const cached = this.quoteCache.get(key);

    if (!cached) {
      return null;
    }

    // Check if cache is stale (older than 5 seconds)
    const age = Date.now() - cached.timestamp;
    if (age > 5000) {
      this.quoteCache.delete(key);
      return null;
    }

    return cached;
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /**
   * Group legs by instance ID
   * @private
   */
  _groupLegsByInstance(legs) {
    const grouped = {};

    for (const leg of legs) {
      const instanceId = leg.instance_id;

      if (!grouped[instanceId]) {
        grouped[instanceId] = [];
      }

      grouped[instanceId].push(leg);
    }

    return grouped;
  }

  /**
   * Build list of unique symbols to request quotes for
   * @private
   */
  _buildSymbolRequests(legs) {
    const requests = new Map();

    for (const leg of legs) {
      const key = `${leg.exchange}:${leg.symbol}`;

      if (!requests.has(key)) {
        requests.set(key, {
          symbol: leg.symbol,
          exchange: leg.exchange,
          token: leg.token,
          instrument_type: leg.instrument_type,
        });
      }
    }

    return Array.from(requests.values());
  }

  /**
   * Fetch quotes from OpenAlgo instance
   * @private
   * @param {Object} instance - Instance record
   * @param {Array} symbolRequests - Array of symbol request objects
   * @returns {Promise<Array>} - Array of quote objects
   */
  async _fetchQuotes(instance, symbolRequests) {
    try {
      // OpenAlgo quotes endpoint accepts multiple symbols
      // For now, we'll make individual requests (can batch later)
      const quotePromises = symbolRequests.map(async (request) => {
        try {
          const quote = await openalgoClient.getQuote(instance, {
            exchange: request.exchange,
            symbol: request.symbol,
          });

          return {
            ...quote,
            symbol: request.symbol,
            exchange: request.exchange,
            instrument_type: request.instrument_type,
          };
        } catch (error) {
          log.debug('Failed to fetch quote for symbol', {
            symbol: request.symbol,
            exchange: request.exchange,
            error: error.message,
          });
          return null;
        }
      });

      const quotes = await Promise.all(quotePromises);

      // Filter out null results (failed requests)
      return quotes.filter(q => q !== null);
    } catch (error) {
      log.error('Failed to fetch quotes from instance', error, {
        instance_id: instance.id,
      });
      return [];
    }
  }

  /**
   * Select appropriate price field based on instrument type
   * @private
   * @param {Object} leg - Leg state record
   * @param {Object} quote - Quote object
   * @returns {number} - Selected price
   */
  _selectPriceForInstrument(leg, quote) {
    const instrumentType = (leg.instrument_type || '').toUpperCase();

    // For options: use option premium (LTP)
    if (instrumentType === 'OPTIDX' || instrumentType === 'OPTSTK' ||
        instrumentType === 'CE' || instrumentType === 'PE') {
      return parseFloat(quote.ltp || quote.last_price || 0);
    }

    // For futures: use futures LTP
    if (instrumentType === 'FUTIDX' || instrumentType === 'FUTSTK') {
      return parseFloat(quote.ltp || quote.last_price || 0);
    }

    // For equity: use stock LTP
    if (instrumentType === 'EQ' || instrumentType === 'EQUITY') {
      return parseFloat(quote.ltp || quote.last_price || 0);
    }

    // Default: use LTP
    return parseFloat(quote.ltp || quote.last_price || 0);
  }

  /**
   * Determine if quote is for an option instrument
   * @private
   */
  _isOptionInstrument(instrumentType) {
    const type = (instrumentType || '').toUpperCase();
    return type === 'OPTIDX' || type === 'OPTSTK' ||
           type === 'CE' || type === 'PE';
  }

  /**
   * Determine if quote is for a futures instrument
   * @private
   */
  _isFuturesInstrument(instrumentType) {
    const type = (instrumentType || '').toUpperCase();
    return type === 'FUTIDX' || type === 'FUTSTK';
  }
}

// Export singleton instance
export default new QuoteRouterService();
export { QuoteRouterService };
