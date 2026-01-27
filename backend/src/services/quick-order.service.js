/**
 * Quick Order Service
 * Handles direct trading from watchlist with position-aware order placement
 * Supports EQUITY, FUTURES, and OPTIONS trade modes
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import optionsResolutionService from './options-resolution.service.js';
import expiryManagementService from './expiry-management.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import derivativeResolutionService, { NSE_INDEX_UNDERLYINGS, BSE_INDEX_UNDERLYINGS } from './derivative-resolution.service.js';
import orderPlacementService from './order-placement.service.js';
import orderPayloadFactory from './order-payload.factory.js';
import openalgoClient from '../integrations/openalgo/client.js';
import orderRepository from './order-repository.js';
import orderService from './order.service.js';
import telegramService from './telegram.service.js';
import limitPriceService from './limit-price.service.js';
import pnlSnapshotService from './pnl-snapshot.service.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import instrumentsService from './instruments.service.js';
import { toISTDate, toISTISOString } from '../utils/time.js';

class QuickOrderService {
  constructor() {
    this.symbolResolutionCache = new Map();
    this.symbolResolutionCacheTtl = 5 * 60 * 1000; // 5 minutes
    this.symbolResolutionCacheMaxSize = 2000; // bounded cache
    this.optionChainQuoteCache = new Map(); // key: inst|exch|underlying|expiry -> { map, fetchedAt }
    this.optionChainQuoteTtlMs = 20000; // retain option chain quotes for 20s to avoid blanks
    this.optionPreviewQuoteCache = new Map(); // key: exch::symbol -> { ltp, changePercent, fetchedAt }
    this.optionPreviewQuoteTtlMs = 60000; // keep last-good preview quotes for 60s
    this.optionPreviewStaleMs = 15000; // mark UI as stale after 15s
    this.optionPreviewInstanceCache = new Map(); // symbolId -> { instanceId, ts }
  }

  async _getStableMarketDataInstanceForPreview(symbolId) {
    const cacheKey = String(symbolId || '');
    if (!cacheKey) {
      return marketDataInstanceService.getMarketDataInstance();
    }

    const pool = await marketDataInstanceService.getMarketDataPool();
    if (!pool.length) {
      return marketDataInstanceService.getMarketDataInstance();
    }

    const cached = this.optionPreviewInstanceCache.get(cacheKey);
    if (cached) {
      const match = pool.find(inst => inst.id === cached.instanceId);
      if (match) {
        return match;
      }
      this.optionPreviewInstanceCache.delete(cacheKey);
    }

    const instance = await marketDataInstanceService.getMarketDataInstance();
    if (instance) {
      this.optionPreviewInstanceCache.set(cacheKey, { instanceId: instance.id, ts: Date.now() });
    }
    return instance;
  }
  /**
   * Place quick order from watchlist
   * @param {Object} params - Order parameters
   * @param {number} params.symbolId - Watchlist symbol ID
   * @param {number} params.instanceId - Instance ID (or 'ALL' for broadcast)
   * @param {string} params.action - BUY, SELL, EXIT, BUY_CE, SELL_CE, BUY_PE, SELL_PE, EXIT_ALL
   * @param {string} params.tradeMode - EQUITY, FUTURES, OPTIONS
   * @param {number} params.quantity - Quantity (in lots for F&O)
   * @param {string} params.product - MIS, CNC, NRML
   * @param {string} params.orderType - MARKET, LIMIT
   * @param {number} params.price - Price (for LIMIT orders)
   * @returns {Promise<Object>} Order result
   */
  async placeQuickOrder(params) {
    const startedAt = Date.now();
    const latencyThresholds = { EQUITY: 4000, FUTURES: 5000, OPTIONS: 7000, DEFAULT: 5000 };
    const {
      symbolId,
      instanceId,
      action,
      tradeMode,
      quantity,
      product = 'MIS',
      orderType = 'MARKET',
      price = 0,
      expiry = null,  // User-selected expiry date
      optionsLeg = null,  // User-selected options leg (ITM2, ATM, OTM1, etc.)
      operatingMode = 'BUYER',  // Buyer or Writer mode for OPTIONS
      strikePolicy = 'FLOAT_OFS',  // FLOAT_OFS or ANCHOR_OFS for OPTIONS
      stepLots = 1,  // Step size in lots for OPTIONS
      triggerType = null,
      correlationId = null,
      requestId = null,
      userId = null,
      source = null,
    } = params;
    const effectiveOrderType = 'LIMIT';

    log.info('Placing quick order', {
      symbolId,
      instanceId,
      action,
      tradeMode,
      quantity,
      expiry,
      optionsLeg,
      operatingMode,
      strikePolicy,
      stepLots,
      triggerType,
      correlationId,
      requestId,
      userId,
      source,
    });

    // Validate inputs
    this._validateOrderParams(params);

    // Get symbol configuration
    const symbol = await this._getSymbolConfig(symbolId);

    // Validate OPTIONS actions require a symbol that supports options trading
    const optionsActions = [
      'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL',
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE',
      'CLOSE_ALL_CE', 'CLOSE_ALL_PE',
    ];
    if (optionsActions.includes(action)) {
      const supportsOptions =
        symbol.symbol_type === 'OPTIONS' ||
        symbol.tradable_options === 1 ||
        (await this._ensureOptionsTradability(symbol));

      if (!supportsOptions) {
        throw new ValidationError(
          `Symbol ${symbol.symbol} (type: ${symbol.symbol_type}) does not support options trading. ` +
            `Enable options trading in the watchlist symbol settings or map it to an OPTIONS instrument.`
        );
      }
    }

    // Validate FUTURES mode symbols
    if (tradeMode === 'FUTURES') {
      const supportsFutures =
        symbol.symbol_type === 'FUTURES' ||
        symbol.tradable_futures === 1 ||
        (await this._ensureFuturesTradability(symbol));

      if (!supportsFutures) {
        throw new ValidationError(
          `Symbol ${symbol.symbol} (type: ${symbol.symbol_type}) does not support futures trading. ` +
            `Enable futures trading in the watchlist symbol settings or map it to a futures instrument.`
        );
      }
    }

    // Get instances (single or all assigned)
    const instances = await this._getTargetInstances(instanceId, symbol.watchlist_id);

    const resolvedProduct = this._resolveProductForOrder(product, tradeMode, symbol);

    // Determine order strategy based on action
    const strategy = this._determineOrderStrategy(action, tradeMode);

    // Execute order based on strategy
    const results = await this._executeOrderStrategy(
      strategy,
      symbol,
      instances,
      {
        action,
        tradeMode,
        quantity,
        product: resolvedProduct,
        orderType: effectiveOrderType,
        price,
        expiry,
        optionsLeg,
        operatingMode,
        strikePolicy,
        stepLots,
        triggerType,
        correlationId,
        requestId,
        userId,
        source,
      }
    );

    log.info('Quick order completed', {
      symbolId,
      action,
      tradeMode,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      duration_ms: Date.now() - startedAt,
    });

    // Send a single Telegram summary for the broadcast
    const successCount = results.filter(r => r.success).length;
    const uncertainCount = results.filter(r => r.uncertain).length;
    const failureCount = results.length - successCount - uncertainCount;
    const instanceNames = instances.map(i => i.name).filter(Boolean);
    const summaryTriggerType = params.triggerType || 'Manual';
    const buttonLabel = params.button_label || action;
    const sideForSummary = this._deriveSideForSummary(action);
    const successInstances = results.filter(r => r.success).map(r => r.instance_name).filter(Boolean);
    const failureInstances = results.filter(r => !r.success).map(r => r.instance_name).filter(Boolean);
    const { summarySymbol, summaryExchange } = this._pickSummaryInstrument(
      results,
      symbol.symbol,
      symbol.exchange
    );
    const summaryPayload = {
      title: 'ORDER SUMMARY',
      trigger_type: summaryTriggerType,
      button_label: buttonLabel,
      trade_mode: tradeMode,
      side: sideForSummary,
      symbol: summarySymbol,
      exchange: summaryExchange,
      product: resolvedProduct,
      order_type: effectiveOrderType,
      quantity,
      instances: instanceNames,
      success_count: successCount,
      failure_count: failureCount,
      success_instances: successInstances,
      failure_instances: failureInstances,
    };
    telegramService
      .sendOrderSummary(summaryPayload)
      .catch(err => log.warn('telegram_summary_notify_failed', { error: err.message }));

    // Latency guardrail logging
    const durationMs = Date.now() - startedAt;
    const threshold = latencyThresholds[tradeMode] || latencyThresholds.DEFAULT;
    if (durationMs > threshold) {
      log.warn('Quick order latency threshold exceeded', {
        tradeMode,
        duration_ms: durationMs,
        threshold_ms: threshold,
        instances: instances.map(i => i.name),
      });
    }

    // Metrics-style hook for observability (can be scraped/parsed from logs)
    log.info('metrics.quickorder', {
      trade_mode: tradeMode,
      action,
      duration_ms: durationMs,
      instances: instances.map(i => i.name),
      total_orders: results.length,
      success_count: successCount,
      failure_count: failureCount,
      unknown_count: uncertainCount,
    });

    const sideForCount = this._deriveSideForSummary(action);
    if (sideForCount === 'BUY' || sideForCount === 'SELL') {
      const liveInstanceIds = new Set(
        instances.filter(instance => !instance.is_analyzer_mode).map(instance => instance.id)
      );
      const counts = sideForCount === 'BUY'
        ? { manual_buy_signals: 1 }
        : { manual_sell_signals: 1 };
      const updates = results
        .filter(result => result.success && liveInstanceIds.has(result.instance_id))
        .map(result => pnlSnapshotService.incrementSignalCounts(result.instance_id, counts));
      if (updates.length) {
        Promise.allSettled(updates).catch(() => {});
      }
    }

    return {
      success: results.every(r => r.success),
      results,
      summary: {
        total: results.length,
        successful: successCount,
        failed: failureCount,
        uncertain: uncertainCount,
      },
    };
  }

  async _captureFallbackEntryPrice(instance, exchange, symbol) {
    try {
      const quote = await openalgoClient.getQuote(instance, symbol, exchange);
      const ltp = Array.isArray(quote) ? quote[0]?.ltp || quote[0]?.last_price : quote?.ltp || quote?.last_price;
      if (ltp && ltp > 0) {
        marketDataFeedService.setFallbackEntryPrice(instance.id, exchange, symbol, ltp, 'manual_order_quote');
      }
    } catch (err) {
      // best effort only
    }
  }

  /**
   * Validate order parameters
   * @private
   */
  _validateOrderParams(params) {
    const { symbolId, action, tradeMode, quantity } = params;

    if (!symbolId) {
      throw new ValidationError('symbolId is required');
    }

    if (!action) {
      throw new ValidationError('action is required');
    }

    const validActions = [
      // Direct/Futures actions
      'BUY', 'SELL', 'SHORT', 'COVER', 'EXIT',
      // Options actions
      'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL',
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE', 'CLOSE_ALL_CE', 'CLOSE_ALL_PE'
    ];
    if (!validActions.includes(action)) {
      throw new ValidationError(`action must be one of: ${validActions.join(', ')}`);
    }

    if (!tradeMode) {
      throw new ValidationError('tradeMode is required');
    }

    const validTradeModes = ['EQUITY', 'FUTURES', 'OPTIONS'];
    if (!validTradeModes.includes(tradeMode)) {
      throw new ValidationError(`tradeMode must be one of: ${validTradeModes.join(', ')}`);
    }

    if (!quantity || quantity <= 0) {
      throw new ValidationError('quantity must be greater than 0');
    }

    // Validate action compatibility with trade mode
    const optionsActions = [
      'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL',
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE',
      'CLOSE_ALL_CE', 'CLOSE_ALL_PE'
    ];
    if (optionsActions.includes(action) && tradeMode !== 'OPTIONS') {
      throw new ValidationError(`Action ${action} is only valid for OPTIONS trade mode`);
    }

    const directActions = ['BUY', 'SELL', 'SHORT', 'COVER', 'EXIT'];
    if (directActions.includes(action) && tradeMode === 'OPTIONS') {
      throw new ValidationError(`Action ${action} is not valid for OPTIONS trade mode`);
    }

    // NEW: Validate that the symbol supports options trading if using OPTIONS actions
    // This check is deferred to _getSymbolConfig which has access to symbol details
  }

  /**
   * Get symbol configuration from database
   * @private
   */
  async _getSymbolConfig(symbolId) {
    const symbol = await db.get(
      `SELECT ws.*, w.name as watchlist_name
       FROM watchlist_symbols ws
       JOIN watchlists w ON ws.watchlist_id = w.id
       WHERE ws.id = ?`,
      [symbolId]
    );

    if (!symbol) {
      throw new NotFoundError(`Symbol with ID ${symbolId} not found`);
    }

    return symbol;
  }

  /**
   * Get target instances for order execution
   * @private
   */
  async _getTargetInstances(instanceId, watchlistId) {
    // If no instanceId provided or instanceId is 'ALL', broadcast to all assigned instances
    if (!instanceId || instanceId === 'ALL') {
      // Get all assigned instances (including analyzer mode instances)
      const instances = await db.all(
        `SELECT i.* FROM instances i
         JOIN watchlist_instances wi ON i.id = wi.instance_id
         WHERE wi.watchlist_id = ?
           AND i.is_active = 1
           AND i.order_placement_enabled = 1`,
        [watchlistId]
      );

      if (instances.length === 0) {
        throw new NotFoundError('No active instances available for order placement');
      }

      log.info(`Broadcasting order to ${instances.length} assigned instance(s)`);
      return instances;
    } else {
      // Get specific instance
      const instance = await db.get(
        'SELECT * FROM instances WHERE id = ? AND is_active = 1',
        [instanceId]
      );

      if (!instance) {
        throw new NotFoundError(`Instance with ID ${instanceId} not found or inactive`);
      }

      if (!instance.order_placement_enabled) {
        throw new ValidationError('Order placement is disabled for this instance');
      }

      return [instance];
    }
  }

  /**
   * Determine order strategy based on action and trade mode
   * @private
   */
  _determineOrderStrategy(action, tradeMode) {
    // Exit actions always close positions
    if (action === 'EXIT' || action === 'EXIT_ALL') {
      return 'CLOSE_POSITIONS';
    }

    // Type-specific close actions (CLOSE_ALL_CE, CLOSE_ALL_PE)
    if (action.startsWith('CLOSE_ALL_')) {
      return 'CLOSE_POSITIONS';
    }

    // All OPTIONS mode actions (including Buyer/Writer paradigm)
    if (tradeMode === 'OPTIONS' && [
      'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE',
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE'
    ].includes(action)) {
      return 'OPTIONS_WITH_RECONCILIATION';
    }

    // Direct/Futures BUY/SELL actions
    if (tradeMode !== 'OPTIONS' && ['BUY', 'SELL', 'SHORT', 'COVER'].includes(action)) {
      return 'DIRECT_ORDER';
    }

    throw new ValidationError(`Unsupported action/tradeMode combination: ${action}/${tradeMode}`);
  }

  /**
   * Execute order strategy
   * @private
   *
   * OPTIMIZATIONS:
   * - Pre-fetch all instance positions in PARALLEL before processing orders
   * - Enables position-aware order sizing without N sequential API calls
   */
  async _executeOrderStrategy(strategy, symbol, instances, orderParams) {
    const { action } = orderParams;

    // For OPTIONS strategy, resolve option symbol ONCE using primary market data instance
    let preResolvedOptionSymbol = null;
    if (strategy === 'OPTIONS_WITH_RECONCILIATION') {
      const marketDataInstance = await this._getMarketDataInstance(instances);
      preResolvedOptionSymbol = await this._preResolveOptionSymbol(
        marketDataInstance,
        symbol,
        orderParams
      );
      log.info('Pre-resolved option symbol for all instances', {
        symbol: preResolvedOptionSymbol.optionSymbol.symbol,
        strike: preResolvedOptionSymbol.optionSymbol.strike,
        instances: instances.map(i => i.name),
      });
    }

    // Pre-fetch all instance positions in PARALLEL
    // For entry/adjust flows, force live positions for accurate sizing.
    const isCloseAction = strategy === 'CLOSE_POSITIONS' ||
                          ['EXIT', 'EXIT_ALL', 'CLOSE_ALL_CE', 'CLOSE_ALL_PE'].includes(action);

    let preloadedPositions = null;
    if (!isCloseAction) {
      const forceLive = true;
      log.info('Pre-fetching positions', {
        instanceCount: instances.length,
        strategy,
        forceLive,
      });
      preloadedPositions = await marketDataFeedService.fetchPositionsForInstances(instances, {
        forceLive,
      });
    }

    // Track broadcast results for transaction logging
    const broadcastTransaction = {
      transactionId: `broadcast_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      strategy,
      action,
      symbol: symbol.symbol,
      instanceCount: instances.length,
      startedAt: Date.now(),
      results: [],
    };

    const perInstanceTasks = instances.map(async (instance) => {
      const instanceResult = {
        instanceId: instance.id,
        instanceName: instance.name,
        startedAt: Date.now(),
      };

      try {
        let result;

        switch (strategy) {
          case 'DIRECT_ORDER':
            result = await this._executeDirectOrder(instance, symbol, orderParams, {
              preloadedPositions,
            });
            break;

          case 'OPTIONS_WITH_RECONCILIATION':
            result = await this._executeOptionsOrder(
              instance,
              symbol,
              orderParams,
              preResolvedOptionSymbol,
              { preloadedPositions }
            );
            break;

        case 'CLOSE_POSITIONS':
          // Close/Exit orders should use live positions for accuracy
          result = await this._closePositions(instance, symbol, orderParams, {
            useCachedPositions: false,
          });
          await this._forceCloseSymbolIfNeeded(instance, symbol, orderParams);
          break;

          default:
            throw new ValidationError(`Unknown strategy: ${strategy}`);
        }

        instanceResult.success = true;
        instanceResult.completedAt = Date.now();
        instanceResult.durationMs = instanceResult.completedAt - instanceResult.startedAt;
        broadcastTransaction.results.push({ ...instanceResult, ...result });

        return {
          success: true,
          instance_id: instance.id,
          instance_name: instance.name,
          ...result,
        };
      } catch (error) {
        const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : null;
        const isServerFailure =
          (statusCode !== null && statusCode >= 500) ||
          (statusCode === null && (error?.name === 'OpenAlgoError' || error?.name === 'ExternalAPIError'));
        log.error('Failed to execute order on instance', error, {
          instance_id: instance.id,
          symbol_id: symbol.id,
        });
        await this._recordFailedQuickOrder({
          instance,
          symbol,
          orderParams,
          error,
        });

        instanceResult.success = false;
        if (isServerFailure) {
          instanceResult.uncertain = true;
        }
        instanceResult.error = error.message;
        instanceResult.completedAt = Date.now();
        instanceResult.durationMs = instanceResult.completedAt - instanceResult.startedAt;
        broadcastTransaction.results.push(instanceResult);

        return {
          success: false,
          uncertain: isServerFailure,
          instance_id: instance.id,
          instance_name: instance.name,
          error: error.message,
        };
      }
    });

    // CRITICAL FIX: Use Promise.allSettled to capture partial results
    // If any instance fails, we still need to record which orders succeeded
    const settledResults = await Promise.allSettled(perInstanceTasks);
    const results = settledResults.map(result => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const statusCode = Number.isFinite(result.reason?.statusCode) ? result.reason.statusCode : null;
      const uncertain =
        (statusCode !== null && statusCode >= 500) ||
        (statusCode === null && (result.reason?.name === 'OpenAlgoError' || result.reason?.name === 'ExternalAPIError'));
      return {
        success: false,
        uncertain,
        error: result.reason?.message || 'Unknown error',
      };
    });

    // Log broadcast transaction for reconciliation
    broadcastTransaction.completedAt = Date.now();
    broadcastTransaction.totalDurationMs = broadcastTransaction.completedAt - broadcastTransaction.startedAt;
    broadcastTransaction.successCount = results.filter(r => r.success).length;
    broadcastTransaction.failureCount = results.filter(r => !r.success).length;

    if (broadcastTransaction.failureCount > 0) {
      log.warn('Broadcast transaction completed with failures', {
        transactionId: broadcastTransaction.transactionId,
        strategy,
        action,
        symbol: symbol.symbol,
        successCount: broadcastTransaction.successCount,
        failureCount: broadcastTransaction.failureCount,
        failedInstances: broadcastTransaction.results
          .filter(r => !r.success)
          .map(r => ({ name: r.instanceName, error: r.error })),
      });

      // For close/exit orders, retry failed instances
      if (isCloseAction && broadcastTransaction.failureCount > 0) {
        const failedInstances = instances.filter(inst =>
          results.find(r => r.instance_id === inst.id && !r.success)
        );

        if (failedInstances.length > 0) {
          log.info('Retrying failed close/exit orders', {
            instanceCount: failedInstances.length,
          });

          const retryResults = await this._retryFailedCloseOrders(
            failedInstances,
            symbol,
            orderParams
          );

          // Merge retry results
          for (const retryResult of retryResults) {
            const idx = results.findIndex(r => r.instance_id === retryResult.instance_id);
            if (idx >= 0 && retryResult.success) {
              results[idx] = retryResult;
              broadcastTransaction.successCount++;
              broadcastTransaction.failureCount--;
            }
          }
        }
      }
    } else {
      log.info('Broadcast transaction completed successfully', {
        transactionId: broadcastTransaction.transactionId,
        strategy,
        instanceCount: instances.length,
        totalDurationMs: broadcastTransaction.totalDurationMs,
      });
    }

    return results;
  }

  /**
   * Retry failed close/exit orders with exponential backoff
   * @private
   */
  async _retryFailedCloseOrders(failedInstances, symbol, orderParams, maxRetries = 2) {
    const results = [];
    // Create a mutable copy to track remaining instances
    let remaining = [...failedInstances];

    for (let attempt = 1; attempt <= maxRetries && remaining.length > 0; attempt++) {
      const backoffMs = Math.pow(2, attempt) * 500; // 1s, 2s
      await new Promise(resolve => setTimeout(resolve, backoffMs));

      // Process all remaining instances and build new remaining list
      const stillFailing = [];

      for (const instance of remaining) {
        try {
          await this._cancelAllOrdersForRetry(instance, symbol, orderParams);
          const result = await this._closePositions(instance, symbol, orderParams, {
            useCachedPositions: false, // Use live positions for retry
          });

          results.push({
            success: true,
            instance_id: instance.id,
            instance_name: instance.name,
            retryAttempt: attempt,
            ...result,
          });
          // Successfully retried - don't add to stillFailing
        } catch (error) {
          log.warn('Retry failed for close/exit order', {
            instanceId: instance.id,
            attempt,
            error: error.message,
          });

          if (attempt === maxRetries) {
            // Final attempt failed - record failure
            await this._recordFailedQuickOrder({
              instance,
              symbol,
              orderParams,
              error,
              attempt,
            });
            results.push({
              success: false,
              instance_id: instance.id,
              instance_name: instance.name,
              retryAttempt: attempt,
              error: error.message,
            });
          } else {
            // Not final attempt - add to stillFailing for next retry
            stillFailing.push(instance);
          }
        }
      }

      // Update remaining list for next iteration
      remaining = stillFailing;
    }

    return results;
  }

  async _cancelAllOrdersForRetry(instance, symbol, orderParams) {
    if (!instance?.id) return;
    const strategies = new Set();
    if (orderParams?.strategy) strategies.add(orderParams.strategy);
    if (symbol?.watchlist_name) strategies.add(symbol.watchlist_name);
    if (instance?.strategy_tag) strategies.add(instance.strategy_tag);
    if (strategies.size === 0) strategies.add('default');

    for (const tag of strategies) {
      try {
        await orderService.cancelAllOrders(instance.id, tag);
      } catch (error) {
        log.warn('Failed to cancel open orders before close/exit retry', {
          instance_id: instance.id,
          strategy: tag,
          error: error.message,
        });
      }
    }
  }

  /**
   * Execute direct order (EQUITY/FUTURES BUY/SELL)
   * @private
   * @param {Object} options - Options
   * @param {Map} options.preloadedPositions - Pre-fetched positions map (instanceId -> positions[])
   */
  async _executeDirectOrder(instance, symbol, orderParams, options = {}) {
    const {
      action,
      tradeMode,
      quantity,
      product,
      expiry,
      triggerType,
      correlationId,
      requestId,
      userId,
      source,
    } = orderParams;
    const { preloadedPositions } = options;

    // Determine final symbol based on trade mode
    let finalSymbol = symbol.symbol;
    let finalExchange = symbol.exchange;
    let resolvedLotSize = symbol.lot_size || symbol.lotsize;
    let resolvedTickSize = symbol.tick_size;

    if (tradeMode === 'FUTURES') {
      const derivativeExchange = symbol.symbol_type === 'FUTURES'
        ? symbol.exchange
        : derivativeResolutionService.getDerivativeExchange(symbol.exchange);
      const underlying = this._getFuturesUnderlying(symbol);

      if (expiry) {
        const matchesWatchlistExpiry = symbol.symbol_type === 'FUTURES'
          && this._expiryMatchesSymbol(expiry, symbol);

        if (matchesWatchlistExpiry) {
          finalSymbol = symbol.symbol;
          finalExchange = symbol.exchange;
          resolvedLotSize = symbol.lot_size || symbol.lotsize || symbol.lotSize;
        } else {
          if (!underlying) {
            throw new ValidationError(
              'Underlying symbol is required to resolve futures contracts. Set it in the watchlist symbol settings.'
            );
          }

          log.info('Resolving futures symbol for selected expiry', {
            underlying,
            expiry,
            derivativeExchange,
          });

          const futuresSymbol = await derivativeResolutionService.resolveFuturesSymbol(
            instance,
            underlying,
            derivativeExchange,
            expiry
          );

          finalSymbol = futuresSymbol.symbol;
          finalExchange = derivativeExchange;
          resolvedLotSize = futuresSymbol.lot_size || symbol.lot_size;
          resolvedTickSize = futuresSymbol.tick_size || resolvedTickSize;

          log.info('Futures symbol resolved', {
            symbol: finalSymbol,
            exchange: finalExchange,
            lotSize: resolvedLotSize,
          });
        }
      } else if (symbol.symbol_type === 'FUTURES') {
        // Fall back to the watchlist contract if no expiry was picked
        finalSymbol = symbol.symbol;
        finalExchange = symbol.exchange;
      } else {
        throw new ValidationError('Expiry is required for FUTURES trading on this symbol');
      }
    }

    // Get current position size (signed: positive for long, negative for short)
    // OPTIMIZATION: Use preloaded positions if available (from parallel pre-fetch)
    let rawPosition;
    if (preloadedPositions && preloadedPositions.has(instance.id)) {
      const preloaded = preloadedPositions.get(instance.id);
      // Only use preloaded positions if fetch was successful
      if (preloaded.success) {
        rawPosition = this._extractPositionFromBook(preloaded.positions, finalSymbol, finalExchange, product);
        log.debug('Using preloaded position', {
          instanceId: instance.id,
          symbol: finalSymbol,
          position: rawPosition,
          fromCache: preloaded.fromCache,
        });
      } else {
        // Prefetch failed - fall back to live fetch with strict error handling
        log.warn('Preloaded position fetch failed, falling back to live fetch', {
          instanceId: instance.id,
          error: preloaded.error,
        });
        rawPosition = await this._getCurrentPositionSize(
          instance,
          finalSymbol,
          finalExchange,
          product,
          { forceLive: true, failOnError: true }
        );
      }
    } else {
      rawPosition = await this._getCurrentPositionSize(
        instance,
        finalSymbol,
        finalExchange,
        product,
        { forceLive: true, failOnError: true }
      );
    }
    const baseLotSize = resolvedLotSize || symbol.lot_size || symbol.lotsize || 1;
    const lotSize = await this._resolveLotSize(
      finalSymbol,
      finalExchange,
      baseLotSize,
      instance
    );
    if (!lotSize || lotSize <= 0) {
      throw new ValidationError(`Unable to resolve lot size for ${finalExchange}:${finalSymbol}`);
    }

    const currentPosition = rawPosition;
    const instanceMultiplier = Math.min(
      Math.max(parseIntSafe(instance.multiplier, 1), 1),
      999
    );
    const baseLots = quantity;
    const tradeLots = baseLots * instanceMultiplier;
    const baseQuantity = baseLots * lotSize;
    const tradeQuantity = tradeLots * lotSize;
    const currentLots = lotSize > 0 ? currentPosition / lotSize : currentPosition;

    log.info('Calculated trade quantity', {
      symbolType: symbol.symbol_type,
      tradeMode,
      inputQuantity: baseLots,
      lotSize,
      baseQuantity,
      instanceMultiplier,
      tradeQuantity,
      rawPosition,
      normalizedPosition: currentPosition,
      instance_id: instance.id,
      instance_name: instance.name,
      instance_multiplier: instanceMultiplier,
      exchange: finalExchange,
      symbol: finalSymbol,
    });

    // Calculate target position_size based on action
    let targetPosition;
    let targetLots;
    let algoAction;

    if (action === 'BUY') {
      // If already long or flat, add; if short, flip to desired long size
      algoAction = 'BUY';
      targetLots = currentLots >= 0
        ? currentLots + tradeLots
        : tradeLots;
    } else if (action === 'SELL') {
      if (currentPosition <= 0) {
        return {
          order_id: null,
          status: 'noop',
          symbol: finalSymbol,
          quantity: 0,
          action: 'SELL',
          message: 'No long position to reduce',
        };
      }
      algoAction = 'SELL';
      targetLots = Math.max(currentLots - tradeLots, 0);
    } else if (action === 'SHORT') {
      // If already short or flat, add; if long, flip to desired short size
      algoAction = 'SELL';
      targetLots = currentLots <= 0
        ? currentLots - tradeLots
        : -tradeLots;
    } else if (action === 'COVER') {
      if (currentPosition >= 0) {
        return {
          order_id: null,
          status: 'noop',
          symbol: finalSymbol,
          quantity: 0,
          action: 'COVER',
          message: 'No short position to cover',
        };
      }
      algoAction = 'BUY';
      targetLots = Math.min(currentLots + tradeLots, 0);
    } else if (action === 'EXIT') {
      // Always send an EXIT to enforce position_size = 0, even if currently flat
      targetLots = 0;
      algoAction = currentPosition > 0 ? 'SELL' : 'BUY';
    } else {
      throw new ValidationError(`Invalid action: ${action}`);
    }

    if (targetLots === undefined) {
      targetLots = currentLots;
    }

    targetPosition = lotSize > 0 ? targetLots * lotSize : targetLots;
    const repeatUntilClosed = this._shouldRepeatToTarget(currentPosition, targetPosition)
      || this._isRepeatExitAction(action);

    log.info('Calculated position for order', {
      action,
      currentPosition,
      tradeQuantity,
      targetLots,
      targetPosition,
      algoAction,
      lotSize,
    });

    // Place order using placesmartorder
    const orderQuantity = Math.abs(targetPosition - currentPosition);
    if (!orderQuantity && action !== 'EXIT') {
      return {
        order_id: null,
        status: 'noop',
        symbol: finalSymbol,
        quantity: 0,
        action: algoAction,
        message: 'No position change required',
      };
    }

    // Final product enforcement (force NRML for any derivative/futures trade)
    const finalProduct = this._resolveProductForOrder(product, tradeMode, {
      symbol_type: 'FUTURES',
      exchange: finalExchange,
    });

    const orderPayload = orderPayloadFactory.buildEquityOrder({
      strategy: symbol.watchlist_name || 'default',
      exchange: finalExchange,
      symbol: finalSymbol,
      action: algoAction,
      quantity: orderQuantity,
      position_size: targetPosition,
      product: finalProduct,
      pricetype: 'LIMIT',
      price: (await limitPriceService.resolveLimitPrice({
        exchange: finalExchange,
        symbol: finalSymbol,
        side: algoAction,
        bufferPoints: symbol.limit_buffer_points || 0,
        tickSize: resolvedTickSize,
      })).price,
    });

    // Best-effort capture of entry LTP for manual orders (fallback for auto-exit)
    this._captureFallbackEntryPrice(instance, finalExchange, finalSymbol).catch(() => {});

    const orderResult = await orderPlacementService.placeSmartOrder(instance, orderPayload, {
      request_type: 'DIRECT',
      trade_mode: tradeMode,
      base_symbol: symbol.symbol,
      expiry: expiry || null,
      correlation_id: correlationId,
      limitBufferPoints: symbol.limit_buffer_points || 0,
      tickSize: resolvedTickSize,
      strategy: orderPayload.strategy,
      repeatUntilClosed,
      ignoreSlippage: repeatUntilClosed,
      skipRateLimit: true,
    });

    // Verify final position using live positionbook (fire-and-forget to avoid blocking response)
    const verifyPosition = async () => {
      try {
        const finalPosition = await this._getCurrentPositionSize(
          instance,
          finalSymbol,
          finalExchange,
          finalProduct,
          { forceLive: true, failOnError: true }
        );
        if (finalPosition !== targetPosition) {
          log.warn('Post-trade position mismatch', {
            instance_id: instance.id,
            instance_name: instance.name,
            symbol: finalSymbol,
            expected: targetPosition,
            actual: finalPosition,
            action,
          });
        }
      } catch (verifyErr) {
        log.warn('Failed to verify final position post-trade', {
          instance_id: instance.id,
          instance_name: instance.name,
          symbol: finalSymbol,
          error: verifyErr.message,
        });
      }
    };
    verifyPosition().catch(() => {});

    // Record order in database
    await this._recordQuickOrder({
      watchlist_id: symbol.watchlist_id,
      symbol_id: symbol.id,
      instance_id: instance.id,
      instance_name: instance.name,
      underlying: symbol.underlying_symbol || symbol.symbol,
      symbol: finalSymbol,
      exchange: finalExchange,
      action: algoAction,
      trade_mode: tradeMode,
      quantity: tradeQuantity,
      product: finalProduct,
      order_type: 'LIMIT',
      price: orderPayload.price,
      order_id: orderResult.orderid,
      status: orderResult.status,
      message: orderResult.message || 'Order placed successfully',
      user_id: userId,
      source: source,
      trigger_type: triggerType,
      request_id: requestId,
      correlation_id: correlationId,
    });

    this._invalidateInstanceCaches(instance.id);

    return {
      order_id: orderResult.orderid,
      status: orderResult.status,
      symbol: finalSymbol,
      quantity: tradeQuantity,
      action: algoAction,
      final_position: finalPosition,
    };
  }

  /**
   * Execute options order with Buyer/Writer position-aware targeting
   * Implements Options Mode Implementation Guide v1.4
   * @private
   * @param {Object} options - Options
   * @param {Map} options.preloadedPositions - Pre-fetched positions map (instanceId -> positions[])
   */
  async _executeOptionsOrder(instance, symbol, orderParams, preResolvedOptionSymbol = null, options = {}) {
    const {
      action,
      product,
      operatingMode = 'BUYER',
      strikePolicy = 'FLOAT_OFS',
      stepLots = 1,
      triggerType,
      correlationId,
      requestId,
      userId,
      source,
    } = orderParams;
    const { preloadedPositions } = options;
    const bufferPoints = Number.isFinite(symbol.limit_buffer_points) ? symbol.limit_buffer_points : 0;
    const instanceMultiplier = Math.min(
      Math.max(parseIntSafe(instance.multiplier, 1), 1),
      999
    );

    // Get writer guard from symbol configuration (optional)
    const writerGuard = symbol.writer_guard_enabled !== 0;  // Default true

    log.info('Executing options order with Buyer/Writer mode', {
      action,
      operatingMode,
      strikePolicy,
      stepLots,
      writerGuard,
    });

    // Determine option type from action
    const optionType = this._getOptionTypeFromAction(action);

    // Use pre-resolved option symbol if provided (multi-instance case)
    // Otherwise resolve it now (single-instance case)
    // EXCEPTION: For REDUCE/INCREASE actions in FLOAT_OFS mode, resolve per-instance
    // to target the ACTUAL open strikes instead of a new resolved strike
    const isReduceAction = ['REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE'].includes(action);
    const shouldSkipPreResolution = isReduceAction && strikePolicy === 'FLOAT_OFS';

    let optionSymbol;
    let expiry;
    let underlying;
    let strike;

    if (preResolvedOptionSymbol && !shouldSkipPreResolution) {
      // Multi-instance: use pre-resolved symbol (for BUY/SELL actions)
      optionSymbol = preResolvedOptionSymbol.optionSymbol;
      expiry = preResolvedOptionSymbol.expiry;
      underlying = preResolvedOptionSymbol.underlying;
      strike = optionSymbol.targetStrike || optionSymbol.strike;

      log.debug('Using pre-resolved option symbol', {
        instance_id: instance.id,
        symbol: optionSymbol.symbol,
        strike,
      });
    } else {
      // Single-instance OR REDUCE in FLOAT_OFS mode: resolve now
      log.info('Resolving option symbol per-instance', {
        action,
        isReduceAction,
        strikePolicy,
        shouldSkipPreResolution,
        instance_id: instance.id,
      });
      // For ANCHOR_OFS, check if strike is already anchored
      const anchoredStrike = strikePolicy === 'ANCHOR_OFS'
        ? await this._manageAnchoredStrike(symbol.id, optionType, orderParams.expiry || null)
        : null;

      if (anchoredStrike) {
        // Use anchored strike - resolve symbol with specific strike
        log.info('Using anchored strike', { optionType, strike: anchoredStrike });
        // TODO: Implement strike-specific resolution
        // For now, resolve normally and we'll anchor after first resolution
      }

      const resolution = await this._resolveOptionSymbolForInstance(instance, symbol, orderParams);
      optionSymbol = resolution.optionSymbol;
      expiry = resolution.expiry;
      underlying = resolution.underlying;
      strike = optionSymbol.targetStrike || optionSymbol.strike;

      // For ANCHOR_OFS on first add action, anchor this strike
      if (strikePolicy === 'ANCHOR_OFS' && !anchoredStrike &&
          (action === 'BUY_CE' || action === 'BUY_PE' || action === 'SELL_CE' || action === 'SELL_PE')) {
        await this._manageAnchoredStrike(symbol.id, optionType, expiry, strike, true);
        log.info('Anchored strike for ANCHOR_OFS', { optionType, strike, expiry });
      }
    }

    // Determine the correct derivatives exchange
    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(symbol.exchange);
    const finalProduct = this._resolveProductForOrder(
      product,
      'OPTIONS',
      { symbol_type: 'OPTIONS', exchange: derivativeExchange }
    );

    // Determine scope: TYPE-level or LEG-level position calculation
    // FLOAT_OFS + reduce/close actions → TYPE scope (aggregate across strikes)
    // ANCHOR_OFS or add actions → LEG scope (single strike)
    const isReduceOrClose = [
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE',
      'CLOSE_ALL_CE', 'CLOSE_ALL_PE', 'EXIT_ALL'
    ].includes(action);
    const useTypeScope = strikePolicy === 'FLOAT_OFS' && isReduceOrClose;

    // For REDUCE/INCREASE in FLOAT_OFS mode, handle each open position separately
    if (strikePolicy === 'FLOAT_OFS' && isReduceOrClose) {
      log.info('FLOAT_OFS REDUCE/INCREASE: Handling each open position separately', {
        action,
        optionType,
        expiry,
        underlying,
      });

      // Get all open positions for this underlying+expiry+optionType
      const allOpenPositions = await this._getAllOpenPositions(
        instance,
        underlying,
        expiry,
        optionType,
        finalProduct
      );

      if (allOpenPositions.length === 0) {
        log.warn('No open positions found for REDUCE/INCREASE', {
          action,
          underlying,
          expiry,
          optionType,
        });
        throw new ValidationError(`No open ${optionType} positions found to ${action.split('_')[0].toLowerCase()}`);
      }

      // Calculate Qstep = step_lots × lotsize × multiplier
      const lotSize = optionSymbol.lot_size || symbol.lot_size || 1;
      const baseQstep = stepLots * lotSize;
      const Qstep = baseQstep * instanceMultiplier;

      log.info('FLOAT_OFS REDUCE/INCREASE: Calculating per-position reductions', {
        Qstep,
        baseQstep,
        instanceMultiplier,
        stepLots,
        lotSize,
        openPositionCount: allOpenPositions.length,
      });

      // For each open position, determine how much to reduce/increase
      const ordersToPlace = [];

      for (const position of allOpenPositions) {
        const currentStrikePosition = position.netQty;
        const targetStrikePosition = this._computeTarget(currentStrikePosition, action, Qstep, writerGuard);

        if (targetStrikePosition !== currentStrikePosition) {
          const algoAction = this._determineAlgoAction(currentStrikePosition, targetStrikePosition);
          const quantity = Math.abs(targetStrikePosition - currentStrikePosition);
          const parsed = this._parseOptionSymbol(position.symbol || '');

          log.info('FLOAT_OFS Order per strike', {
            symbol: position.symbol,
            currentPosition: currentStrikePosition,
            targetPosition: targetStrikePosition,
            action: algoAction,
            quantity,
          });

          ordersToPlace.push({
            symbol: position.symbol,
            action: algoAction,
            quantity,
            position_size: targetStrikePosition,
            currentPosition: currentStrikePosition,
            strike: parsed.strike,
          });
        } else {
          log.debug('Skipping position - no change needed', {
            symbol: position.symbol,
            currentPosition: currentStrikePosition,
            targetPosition: currentStrikePosition,
          });
        }
      }

      if (ordersToPlace.length === 0) {
        log.warn('No orders to place - all positions already at target', { action });
        throw new ValidationError('No position change needed - all positions already at target');
      }

      // Fast path: if all orders are for the same strike (duplicate rows), collapse into one
      const uniqueSymbols = new Set(ordersToPlace.map(o => o.symbol));
      if (uniqueSymbols.size === 1 && ordersToPlace.length > 1) {
        const primary = ordersToPlace[0];
        const mergedQty = ordersToPlace.reduce((sum, o) => sum + o.quantity, 0);
        const mergedTarget = ordersToPlace.reduce((_, o) => o.position_size, primary.position_size);
        log.info('FLOAT_OFS: Collapsing duplicate-strike orders into single request', {
          symbol: primary.symbol,
          mergedQty,
          orderCount: ordersToPlace.length,
        });
        ordersToPlace.splice(0, ordersToPlace.length, {
          ...primary,
          quantity: mergedQty,
          position_size: mergedTarget,
        });
      }

      const orderPromises = ordersToPlace.map(async order => {
        const floatProduct = this._resolveProductForOrder(
          product,
          'OPTIONS',
          { symbol_type: 'OPTIONS', exchange: derivativeExchange }
        );

        // Capture fallback entry price per strike (best effort)
        this._captureFallbackEntryPrice(instance, derivativeExchange, order.symbol).catch(() => {});

        const orderDataToSend = orderPayloadFactory.buildOptionsOrder({
          strategy: symbol.watchlist_name || 'default',
          exchange: derivativeExchange,
          symbol: order.symbol,
          action: order.action,
          quantity: order.quantity,
          position_size: order.position_size,
          product: floatProduct,
          pricetype: 'LIMIT',
          price: (await limitPriceService.resolveLimitPrice({
            exchange: derivativeExchange,
            symbol: order.symbol,
            side: order.action,
            bufferPoints,
            tickSize: optionSymbol?.tick_size || symbol.tick_size,
          })).price,
        });

        log.info('FLOAT_OFS: Placing order for strike', {
          strike: order.strike,
          symbol: order.symbol,
          action: order.action,
          quantity: order.quantity,
          position_size: order.position_size,
        });

        const orderResult = await orderPlacementService.placeSmartOrder(instance, orderDataToSend, {
          request_type: 'OPTIONS_FLOAT',
          trade_mode: 'OPTIONS',
          base_symbol: symbol.symbol,
          underlying,
          expiry,
          option_type: optionType,
          strike: order.strike,
          correlation_id: correlationId,
          limitBufferPoints: bufferPoints,
          tickSize: optionSymbol?.tick_size || symbol.tick_size,
          strategy: orderDataToSend.strategy,
          repeatUntilClosed: this._isRepeatExitAction(action),
          ignoreSlippage: this._isRepeatExitAction(action),
          skipRateLimit: true,
        });

        await this._syncOptionsState(
          symbol.watchlist_id,
          symbol.id,
          instance.id,
          underlying,
          expiry,
          optionType,
          order.strike,
          order.position_size,
          0,
          floatProduct
        );

        await this._recordQuickOrder({
          watchlist_id: symbol.watchlist_id,
          symbol_id: symbol.id,
          instance_id: instance.id,
          instance_name: instance.name,
          underlying,
          symbol: order.symbol,
          exchange: derivativeExchange,
          action: order.action,
          trade_mode: 'OPTIONS',
          options_leg: symbol.options_strike_selection,
          quantity: order.quantity,
          product: floatProduct,
          order_type: 'LIMIT',
          price: orderDataToSend.price,
          resolved_symbol: optionSymbol.symbol,
          strike_price: order.strike,
          option_type: optionType,
          expiry_date: expiry,
          order_id: orderResult.orderid,
          status: orderResult.status,
          message: orderResult.message || `${operatingMode} mode: ${action} executed successfully`,
          user_id: userId,
          source: source,
          trigger_type: triggerType,
          request_id: requestId,
          correlation_id: correlationId,
        });

        return {
          order_id: orderResult.orderid,
          status: orderResult.status,
          symbol: order.symbol,
          resolved_symbol: optionSymbol.symbol,
          exchange: derivativeExchange,
          strike: order.strike,
          quantity: order.quantity,
          action: order.action,
          instance_name: instance.name,
        };
      });

      // CRITICAL FIX: Use Promise.allSettled to handle partial failures
      // If any order fails, we still want to record which orders succeeded
      const settledOrders = await Promise.allSettled(orderPromises);
      const orderResults = [];
      const failedOrders = [];

      settledOrders.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          orderResults.push(result.value);
        } else {
          failedOrders.push({
            order: ordersToPlace[index],
            error: result.reason?.message || 'Unknown error'
          });
        }
      });

      if (failedOrders.length > 0) {
        log.error('FLOAT_OFS: Some orders failed', {
          action,
          successCount: orderResults.length,
          failureCount: failedOrders.length,
          failures: failedOrders
        });
      }

      log.info('FLOAT_OFS REDUCE/INCEASE: Orders placed', {
        action,
        orderCount: orderResults.length,
        orders: orderResults,
      });
      this._invalidateInstanceCaches(instance.id);

      return {
        orders: orderResults,
        action,
        operating_mode: operatingMode,
        strike_policy: strikePolicy,
        position_count: allOpenPositions.length,
        orders_placed: orderResults.length,
      };
    }

    // For all other cases (BUY/SELL actions, ANCHOR_OFS, CLOSE_ALL in FLOAT_OFS), use legacy logic
    // Get current position
    let currentPosition;
    if (useTypeScope) {
      // Aggregate across all strikes for this TYPE and expiry
      currentPosition = await this._getAggregatedTypePosition(
        instance,
        underlying,
        expiry,
        optionType,
        product
      );
      log.info('Using TYPE-scoped position (FLOAT_OFS)', {
        optionType,
        expiry,
        currentPosition,
      });
    } else {
      // Single leg position
      // Use preloaded positions if available to avoid additional API call
      if (preloadedPositions && preloadedPositions.has(instance.id)) {
        const preloaded = preloadedPositions.get(instance.id);
        // Only use preloaded positions if fetch was successful
        if (preloaded.success) {
          currentPosition = this._extractPositionFromBook(
            preloaded.positions,
            optionSymbol.symbol,
            derivativeExchange,
            product
          );
          log.debug('Using preloaded position for options', {
            instanceId: instance.id,
            symbol: optionSymbol.symbol,
            position: currentPosition,
            fromCache: preloaded.fromCache,
          });
        } else {
          // Prefetch failed - fall back to live fetch
          log.warn('Preloaded position fetch failed for options, falling back to live fetch', {
            instanceId: instance.id,
            error: preloaded.error,
          });
          currentPosition = await this._getCurrentPositionSize(
            instance,
            optionSymbol.symbol,
            derivativeExchange,
            product,
            { forceLive: true, failOnError: true }
          );
        }
      } else {
        currentPosition = await this._getCurrentPositionSize(
          instance,
          optionSymbol.symbol,
          derivativeExchange,
          product
        );
      }
      log.info('Using LEG-scoped position', {
        symbol: optionSymbol.symbol,
        currentPosition,
      });
    }

    // Calculate Qstep = step_lots × lotsize × multiplier
    const lotSize = optionSymbol.lot_size || symbol.lot_size || 1;
    const baseQstep = stepLots * lotSize;
    const Qstep = baseQstep * instanceMultiplier;

    log.info('Calculated Qstep', {
      stepLots,
      lotSize,
      baseQstep,
      instanceMultiplier,
      Qstep,
    });

    // Compute target position using Implementation Guide algorithm
    const targetPosition = this._computeTarget(currentPosition, action, Qstep, writerGuard);

    log.info('Computed target position', {
      action,
      currentPosition,
      Qstep,
      targetPosition,
      delta: targetPosition - currentPosition,
    });

    // Check if there's any position change needed
    if (targetPosition === currentPosition) {
      log.warn('No position change needed - target equals current', {
        action,
        currentPosition,
        targetPosition,
      });
      throw new ValidationError('No position change needed - already at target position');
    }

    // Determine OpenAlgo action (BUY/SELL) from delta
    const algoAction = this._determineAlgoAction(currentPosition, targetPosition);
    const quantity = Math.abs(targetPosition - currentPosition);

    log.info('Order - Full calculation details', {
      action,
      algoAction,
      currentPosition,
      targetPosition,
      quantity: Math.abs(targetPosition - currentPosition),
      symbol: optionSymbol.symbol,
      strike,
      position_size: targetPosition,
    });

    log.info('Order details', {
      algoAction,
      quantity,
      targetPosition,
      symbol: optionSymbol.symbol,
      strike,
    });
    const repeatUntilClosed = this._shouldRepeatToTarget(currentPosition, targetPosition);

    // Prepare order data for OpenAlgo
    const orderDataToSend = orderPayloadFactory.buildOptionsOrder({
      strategy: symbol.watchlist_name || 'default',
      exchange: derivativeExchange,
      symbol: optionSymbol.symbol,
      action: algoAction,
      quantity,
      position_size: targetPosition,
      product: finalProduct,
      pricetype: 'LIMIT',
      price: (await limitPriceService.resolveLimitPrice({
        exchange: derivativeExchange,
        symbol: optionSymbol.symbol,
        side: algoAction,
        bufferPoints,
        tickSize: optionSymbol.tick_size || symbol.tick_size,
      })).price,
    });

    log.info('Data being sent to OpenAlgo placesmartorder', orderDataToSend);

    // Place order using placesmartorder
    const orderResult = await orderPlacementService.placeSmartOrder(instance, orderDataToSend, {
      request_type: 'OPTIONS_STANDARD',
      trade_mode: 'OPTIONS',
      base_symbol: symbol.symbol,
      underlying,
      expiry,
      option_type: optionType,
      strike,
      correlation_id: correlationId,
      limitBufferPoints: bufferPoints,
      tickSize: optionSymbol.tick_size || symbol.tick_size,
      strategy: orderDataToSend.strategy,
      repeatUntilClosed,
      ignoreSlippage: repeatUntilClosed,
      skipRateLimit: true,
    });

    // Sync position to watchlist_options_state table
    await this._syncOptionsState(
      symbol.watchlist_id,
      symbol.id,
      instance.id,
      underlying,
      expiry,
      optionType,
      strike,
      targetPosition,  // New net position
      0,  // We don't have avg price yet, will be updated by polling
      finalProduct
    );

    // Record order in database
    await this._recordQuickOrder({
      watchlist_id: symbol.watchlist_id,
      symbol_id: symbol.id,
      instance_id: instance.id,
      instance_name: instance.name,
      underlying,
      symbol: optionSymbol.symbol,
      exchange: derivativeExchange,
      action: algoAction,
      trade_mode: 'OPTIONS',
      options_leg: symbol.options_strike_selection,
      quantity,
      product: finalProduct,
      order_type: 'LIMIT',
      price: orderDataToSend.price,
      resolved_symbol: optionSymbol.symbol,
      strike_price: strike,
      option_type: optionType,
      expiry_date: expiry,
      order_id: orderResult.orderid,
      status: orderResult.status,
      message: orderResult.message || `${operatingMode} mode: ${action} executed successfully`,
      user_id: userId,
      source: source,
      trigger_type: triggerType,
      request_id: requestId,
      correlation_id: correlationId,
    });

    // Verify final position post-trade
    let finalPosition = null;
    try {
      if (useTypeScope) {
        finalPosition = await this._getAggregatedTypePosition(
          instance,
          underlying,
          expiry,
          optionType,
          finalProduct
        );
      } else {
        finalPosition = await this._getCurrentPositionSize(
          instance,
          optionSymbol.symbol,
          derivativeExchange,
          finalProduct,
          { forceLive: true, failOnError: true }
        );
      }
      if (finalPosition !== targetPosition) {
        log.warn('Post-trade position mismatch (options)', {
          instance_id: instance.id,
          symbol: optionSymbol.symbol,
          expected: targetPosition,
          actual: finalPosition,
          scope: useTypeScope ? 'TYPE' : 'LEG',
        });
      }
    } catch (verifyErr) {
      log.warn('Failed to verify final options position', {
        instance_id: instance.id,
        symbol: optionSymbol.symbol,
        error: verifyErr.message,
      });
    }

    this._invalidateInstanceCaches(instance.id);

    return {
      order_id: orderResult.orderid,
      status: orderResult.status,
      symbol: optionSymbol.symbol,
      resolved_symbol: optionSymbol.symbol,
      exchange: derivativeExchange,
      strike,
      option_type: optionType,
      quantity,
      action: algoAction,
      operating_mode: operatingMode,
      strike_policy: strikePolicy,
      current_position: currentPosition,
      target_position: targetPosition,
      final_position: finalPosition,
      instance_name: instance.name,
    };
  }

  /**
   * Close positions (EXIT or EXIT_ALL)
   * @private
   * @param {Object} options - Options
   * @param {boolean} options.useCachedPositions - Use cached positions instead of live fetch
   *
   * OPTIMIZATION: Close/Exit orders can use cached positions because:
   * - We're closing to position_size=0, so exact current quantity isn't critical
   * - The broker handles the actual quantity calculation based on position_size
   * - This saves 1 API call per close order
   */
  async _closePositions(instance, symbol, orderParams, options = {}) {
    const {
      action,
      tradeMode,
      product,
      expiry: userExpiry,
      triggerType,
      correlationId,
      requestId,
      userId,
      source,
    } = orderParams;
    const { useCachedPositions = false } = options;
    const bufferPoints = Number.isFinite(symbol.limit_buffer_points) ? symbol.limit_buffer_points : 0;

    let underlying = this._getUnderlyingForClosing(symbol);

    let positionsToClose = [];

    const closeAllTypeMap = {
      CLOSE_ALL_CE: 'CE',
      CLOSE_ALL_PE: 'PE',
    };

    if (closeAllTypeMap[action] && tradeMode === 'OPTIONS') {
      const optionType = closeAllTypeMap[action];
      let expiry = userExpiry ? this._normalizeExpiryInput(userExpiry) : null;
      if (!expiry) {
        expiry = await expiryManagementService.getNearestExpiry(
          underlying,
          symbol.exchange,
          instance
        );
      }
      if (expiry) {
        expiry = this._normalizeExpiryInput(expiry);
      }
      log.info('Using expiry for close-all', { action, expiry });

      if (!expiry) {
        throw new ValidationError('Unable to determine expiry for close-all action');
      }

      const typePositions = await this._getOpenOptionsPositions(
        instance,
        underlying,
        expiry,
        optionType,
        product,
        { useCached: useCachedPositions }
      );

      if (!expiry) {
        throw new ValidationError('Unable to determine expiry for close-all action');
      }

      positionsToClose = typePositions;
    } else if (action === 'EXIT_ALL' && tradeMode === 'OPTIONS') {
      let expiry = userExpiry ? this._normalizeExpiryInput(userExpiry) : null;
      if (!expiry) {
        expiry = await expiryManagementService.getNearestExpiry(
          underlying,
          symbol.exchange,
          instance
        );
      }
      if (expiry) {
        expiry = this._normalizeExpiryInput(expiry);
      }
      log.info('Using expiry for EXIT_ALL', { expiry });

      if (!expiry) {
        throw new ValidationError('Unable to determine expiry for EXIT_ALL');
      }

      const cePositions = await this._getOpenOptionsPositions(
        instance,
        underlying,
        expiry,
        'CE',
        product,
        { useCached: useCachedPositions }
      );

      const pePositions = await this._getOpenOptionsPositions(
        instance,
        underlying,
        expiry,
        'PE',
        product,
        { useCached: useCachedPositions }
      );

      positionsToClose = [...cePositions, ...pePositions];
    } else {
      // Close position for specific symbol
      let targetSymbol = symbol.symbol;
      let targetExchange = symbol.exchange;

      if (tradeMode === 'FUTURES') {
        const derivativeExchange = symbol.symbol_type === 'FUTURES'
          ? symbol.exchange
          : derivativeResolutionService.getDerivativeExchange(symbol.exchange);

        // Try to parse the symbol if it's already a futures symbol (e.g., NATGASMINI24NOV25FUT)
        const symbolStr = symbol.symbol || symbol.trading_symbol || '';
        const parsed = this._parseFuturesSymbol(symbolStr);

        underlying = parsed.underlying || this._getUnderlyingForClosing(symbol);
        let expiryInput = userExpiry ? this._normalizeExpiryInput(userExpiry) : null;

        // If we parsed expiry from the symbol, use it
        if (!expiryInput && parsed.expiry) {
          expiryInput = this._normalizeExpiryInput(parsed.expiry);
          log.info('Extracted expiry from futures symbol', {
            symbol: symbolStr,
            underlying,
            expiry: expiryInput
          });
        }

        if (!underlying) {
          throw new ValidationError('Underlying symbol is required to close futures positions.');
        }

        // Fallback to nearest expiry if not provided (similar to OPTIONS mode)
        if (!expiryInput) {
          expiryInput = await expiryManagementService.getNearestExpiry(
            underlying,
            derivativeExchange,
            instance
          );
          if (expiryInput) {
            expiryInput = this._normalizeExpiryInput(expiryInput);
          }
          log.info('Using fallback expiry for futures close', { underlying, expiry: expiryInput });
        }

        if (!expiryInput) {
          throw new ValidationError('Unable to determine expiry for closing futures position. Please specify an expiry.');
        }

        const futuresSymbol = await derivativeResolutionService.resolveFuturesSymbol(
          instance,
          underlying,
          derivativeExchange,
          expiryInput
        );
        targetSymbol = futuresSymbol.symbol;
        targetExchange = derivativeExchange;
      }

      const positions = await this._getOpenPositionsForSymbol(
        instance,
        targetSymbol,
        targetExchange,
        product
      );

      positionsToClose = positions;
    }

    if (positionsToClose.length === 0) {
      return {
        message: 'No open positions to close',
        closed_count: 0,
      };
    }

    // Close each position
    const closeResults = [];
    for (const position of positionsToClose) {
      try {
        const closeAction = position.quantity > 0 ? 'SELL' : 'BUY';
        const closeQuantity = Math.abs(position.quantity);

        // For EXIT/EXIT_ALL, position_size should be 0 to close completely
        const strategyTag = orderParams.strategy || symbol.watchlist_name || 'default';
        const orderPayload = orderPayloadFactory.buildExitOrder({
          strategy: strategyTag,
          exchange: position.exchange,
          symbol: position.symbol,
          action: closeAction,
          quantity: closeQuantity,
          product,
          pricetype: 'LIMIT',
          price: (await limitPriceService.resolveLimitPrice({
            exchange: position.exchange,
            symbol: position.symbol,
            side: closeAction,
            bufferPoints,
            tickSize: symbol.tick_size,
            bypassSpreadCheck: true,
            forceLtp: true,
          })).price,
        });
        const orderResult = await orderPlacementService.placeSmartOrder(instance, orderPayload, {
          request_type: 'EXIT_POSITION',
          trade_mode: orderParams.tradeMode || 'DIRECT',
          base_symbol: symbol.symbol,
          closing_symbol: position.symbol,
          correlation_id: correlationId,
          limitBufferPoints: bufferPoints,
          tickSize: symbol.tick_size,
          strategy: orderPayload.strategy,
          repeatUntilClosed: true,
          ignoreSlippage: true,
          skipRateLimit: true,
        });

        closeResults.push({
          success: true,
          symbol: position.symbol,
          resolved_symbol: position.symbol,
          quantity: closeQuantity,
          order_id: orderResult.orderid,
        });

        // Record order
        await this._recordQuickOrder({
          watchlist_id: symbol.watchlist_id,
          symbol_id: symbol.id,
          instance_id: instance.id,
          instance_name: instance.name,
          underlying,
          symbol: position.symbol,
          exchange: position.exchange,
          action: closeAction,
          trade_mode: tradeMode,
          quantity: closeQuantity,
          product,
          order_type: 'LIMIT',
          price: orderPayload.price,
          order_id: orderResult.orderid,
          status: orderResult.status,
          message: `Position closed: ${position.symbol}`,
          user_id: userId,
          source: source,
          trigger_type: triggerType,
          request_id: requestId,
          correlation_id: correlationId,
        });
      } catch (error) {
        log.error('Failed to close position', error, { symbol: position.symbol });
        closeResults.push({
          success: false,
          symbol: position.symbol,
          error: error.message,
        });
      }
    }

    this._invalidateInstanceCaches(instance.id);

    return {
      message: `Closed ${closeResults.filter(r => r.success).length} position(s)`,
      closed_count: closeResults.filter(r => r.success).length,
      details: closeResults,
    };
  }

  async _forceCloseSymbolIfNeeded(instance, symbol, orderParams) {
    const { action, tradeMode, strategy } = orderParams;
    if (action !== 'EXIT' || (tradeMode || '').toUpperCase() === 'OPTIONS') {
      return;
    }

    const strategyTag = strategy || symbol.watchlist_name || 'default';

    try {
      log.info('Cancelling hanging orders for EXIT symbol', {
        instance_id: instance.id,
        symbol: symbol.symbol,
        strategy: strategyTag,
      });
      const result = await orderService.cancelPendingOrdersForSymbol(instance.id, symbol.symbol);
      log.info('Pending symbol orders cancelled', {
        instance_id: instance.id,
        symbol: symbol.symbol,
        cancelled: result.cancelled,
        total: result.total,
      });
    } catch (error) {
      log.warn('Failed to cancel pending orders for EXIT symbol', {
        instance_id: instance.id,
        symbol: symbol.symbol,
        error: error.message,
      });
    }
  }

  /**
   * Reconcile options positions (close opposite positions)
   * @private
   */
  async _reconcileOptionsPositions(instance, positions, side, optionType, product, strategy, correlationId = null) {
    const positionsToClose = [];
    const bufferPoints = 0;

    if (side === 'BUY') {
      // Closing all short positions (negative quantity)
      positionsToClose.push(...positions.filter(p => p.quantity < 0));
    } else if (side === 'SELL') {
      // Closing all long positions (positive quantity)
      positionsToClose.push(...positions.filter(p => p.quantity > 0));
    }

    const closeResults = [];

    for (const position of positionsToClose) {
      try {
        const closeAction = position.quantity > 0 ? 'SELL' : 'BUY';
        const closeQuantity = Math.abs(position.quantity);

        const orderPayload = orderPayloadFactory.buildExitOrder({
          strategy: strategy || 'default',
          exchange: position.exchange,
          symbol: position.symbol,
          action: closeAction,
          quantity: closeQuantity,
          product,
          pricetype: 'LIMIT',
          price: (await limitPriceService.resolveLimitPrice({
            exchange: position.exchange,
            symbol: position.symbol,
            side: closeAction,
            bufferPoints,
            tickSize: null,
            bypassSpreadCheck: true,
            forceLtp: true,
          })).price,
        });
        const orderResult = await orderPlacementService.placeSmartOrder(instance, orderPayload, {
          request_type: 'OPTIONS_RECONCILE',
          trade_mode: 'OPTIONS',
          base_symbol: position.symbol,
          option_type: optionType,
          position_side: side,
          correlation_id: correlationId,
          limitBufferPoints: bufferPoints,
          tickSize: null,
          strategy: orderPayload.strategy,
          skipRateLimit: true,
        });

        closeResults.push({
          success: true,
          symbol: position.symbol,
          closed_quantity: closeQuantity,
        });

        log.info('Closed opposite position for reconciliation', {
          symbol: position.symbol,
          quantity: closeQuantity,
        });
      } catch (error) {
        log.error('Failed to close position during reconciliation', error);
        closeResults.push({
          success: false,
          symbol: position.symbol,
          error: error.message,
        });
      }
    }

    return closeResults;
  }

  /**
   * Get cached position book for an instance (fallback to OpenAlgo if cache missing)
   * @private
   */
  async _getPositionBook(instance, { forceLive = true } = {}) {
    // Always prefer live fetch per requirement; cache only as fallback for failures if needed later
    const positionBook = await openalgoClient.getPositionBook(instance);
    marketDataFeedService.setPositionSnapshot(instance.id, positionBook);
    return positionBook;
  }

  async _resolveLotSize(symbol, exchange, fallbackLotSize, instance = null) {
    const fallback = fallbackLotSize && fallbackLotSize > 0 ? fallbackLotSize : 1;
    try {
      const instrument = await instrumentsService.findInstrument(symbol, exchange);
      if (instrument) {
        const resolved =
          instrument.lot_size ||
          instrument.lotsize ||
          instrument.contract_size ||
          instrument.lotSize;
        if (resolved && resolved > 0) {
          return resolved;
        }
      }
    } catch (error) {
      log.warn('Lot size resolution fallback hit', { symbol, exchange, error: error.message });
    }
    // Position quantity cannot be used to infer lot size (it's total contracts, not lot size)
    // Always use fallback if instruments database lookup fails
    return fallback;
  }

  /**
   * Get current position size for a symbol
   * @private
   */
  async _getCurrentPositionSize(instance, symbol, exchange, product, opts = {}) {
    try {
      const positionBook = await this._getPositionBook(instance, { ...opts, forceLive: true });
      const targetSymbol = this._normalizeSymbolKey(symbol);
      const targetExchange = this._normalizeExchange(exchange);
      const targetProduct = this._normalizeProduct(product);

      return positionBook.reduce((total, pos) => {
        const posSymbol = this._normalizeSymbolKey(
          pos.symbol || pos.trading_symbol || pos.tradingsymbol
        );
        if (!posSymbol || posSymbol !== targetSymbol) {
          return total;
        }

        const posExchange = this._normalizeExchange(pos.exchange || pos.exch);
        if (targetExchange && posExchange && posExchange !== targetExchange) {
          return total;
        }

        const posProduct = this._normalizeProduct(pos.product || pos.producttype);
        if (targetProduct && posProduct && posProduct !== targetProduct) {
          return total;
        }

        const qty =
          parseIntSafe(pos.quantity) ||
          parseIntSafe(pos.netqty) ||
          parseIntSafe(pos.net_quantity) ||
          parseIntSafe(pos.net) ||
          parseIntSafe(pos.netQty) ||
          0;

        return total + qty;
      }, 0);
    } catch (error) {
      log.warn('Failed to determine current position size', {
        instance_id: instance.id,
        symbol,
        exchange,
        product,
        error: error.message,
      });
      if (opts.failOnError) {
        throw error;
      }
      return 0;
    }
  }

  /**
   * Close a single position by symbol
   * @param {Object} instance - Instance object
   * @param {Object} symbol - Minimal symbol metadata (symbol, exchange)
   * @param {Object} params - Additional order params (tradeMode, product)
   * @returns {Promise<Object>}
   */
  async closePosition(instance, symbol, params = {}) {
    const symbolPayload = {
      ...symbol,
      watchlist_name: params.watchlist_name || 'manual-close',
    };

    const orderParams = {
      action: 'EXIT',
      tradeMode: params.tradeMode || 'FUTURES',
      product: params.product || 'MIS',
      strategy: params.strategy,
      expiry: params.expiry || null,
    };

    return this._closePositions(instance, symbolPayload, orderParams);
  }

  /**
   * Get open options positions for underlying and expiry
   * @private
   * @param {Object} options - Options
   * @param {boolean} options.useCached - Use cached positions instead of live fetch
   */
  async _getOpenOptionsPositions(instance, underlying, expiry, optionType, product, options = {}) {
    const { useCached = false } = options;
    try {
      // Use cached positions if requested (for close/exit operations where exact quantity is less critical)
      let positionBook;
      if (useCached) {
        const cached = marketDataFeedService.getPositionSnapshot(instance.id);
        positionBook = cached?.data || [];
        log.debug('Using cached positions for options lookup', {
          instanceId: instance.id,
          positionCount: positionBook.length,
        });
      } else {
        positionBook = await this._getPositionBook(instance, { forceLive: true });
      }
      const targetUnderlying = (underlying || '').toUpperCase();
      const canonicalTarget = targetUnderlying.replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '');
      const targetOptionType = (optionType || '').toUpperCase();

      const positions = positionBook
        .filter(p => {
          const rawSymbol = p.symbol || '';
          if (!rawSymbol) return false;

          const symbol = rawSymbol.toUpperCase();
          const quantity =
            parseIntSafe(p.quantity) ||
            parseIntSafe(p.netqty) ||
            parseIntSafe(p.net_quantity) ||
            parseIntSafe(p.net) ||
            parseIntSafe(p.netQty) ||
            0;

          if (quantity === 0) return false;

          const parsed = this._parseOptionSymbol(symbol);
          const candidateUnderlying = parsed.underlying
            ? parsed.underlying.toUpperCase()
            : symbol;
          const canonicalCandidate = candidateUnderlying
            .replace(/[^A-Z0-9]/g, '')
            .replace(/\d+$/, '');
          const matchesUnderlying = canonicalCandidate === canonicalTarget;

          if (!matchesUnderlying) return false;

          const matchesExpiry = parsed.expiry ? parsed.expiry === expiry : true;
          if (!matchesExpiry) return false;

          const parsedType = parsed.type ? parsed.type.toUpperCase() : null;
          const matchesType = parsedType
            ? parsedType === targetOptionType
            : symbol.includes(targetOptionType);

          return matchesType;
        })
        .map(p => ({
          symbol: p.symbol,
          exchange: p.exchange,
          quantity:
            parseIntSafe(p.quantity) ||
            parseIntSafe(p.netqty) ||
            parseIntSafe(p.net_quantity) ||
            parseIntSafe(p.net) ||
            parseIntSafe(p.netQty) ||
            0,
          product: p.product || product,
        }));

      return positions;
    } catch (error) {
      log.error('Failed to get options positions', error);
      return [];
    }
  }

  /**
   * Get open positions for specific symbol
   * @private
   */
  async _getOpenPositionsForSymbol(instance, symbol, exchange, product) {
    try {
      const positionBook = await this._getPositionBook(instance, { forceLive: true });
      const targetSymbol = this._normalizeSymbolKey(symbol);
      const targetExchange = this._normalizeExchange(exchange);
      const targetProduct = this._normalizeProduct(product);

      const positions = positionBook.filter(p => {
        const posSymbol = this._normalizeSymbolKey(
          p.symbol || p.trading_symbol || p.tradingsymbol
        );
        const posExchange = this._normalizeExchange(p.exchange || p.exch);
        const posProduct = this._normalizeProduct(p.product || p.producttype);
        const qty =
          parseIntSafe(p.quantity) ||
          parseIntSafe(p.netqty) ||
          parseIntSafe(p.net_quantity) ||
          parseIntSafe(p.net) ||
          parseIntSafe(p.netQty) ||
          0;
        const hasQuantity = qty !== 0;

        const symbolMatch = posSymbol === targetSymbol;
        const exchangeMatch = !targetExchange || !posExchange || posExchange === targetExchange;
        const productMatch = !targetProduct || !posProduct || posProduct === targetProduct;

        return symbolMatch && exchangeMatch && productMatch && hasQuantity;
      });

      return positions.map(p => ({
        symbol: p.symbol || p.trading_symbol || p.tradingsymbol,
        exchange: p.exchange || p.exch,
        quantity:
          parseIntSafe(p.quantity) ||
          parseIntSafe(p.netqty) ||
          parseIntSafe(p.net_quantity) ||
          parseIntSafe(p.net) ||
          parseIntSafe(p.netQty) ||
          0,
        product: p.product || p.producttype || product,
      }));
    } catch (error) {
      log.error('Failed to get positions for symbol', error);
      return [];
    }
  }

  /**
   * Get underlying LTP using primary/secondary market data instances with failover
   * Uses the designated primary or secondary instance for market data, not the order instance
   * @private
   */
  async _getUnderlyingLTPWithFallback(instance, underlying, exchange) {
    const marketDataInstanceService = (await import('./market-data-instance.service.js')).default;

    try {
      // Get the designated market data instance (primary with failover to secondary)
      const marketDataInstance = await marketDataInstanceService.getMarketDataInstance();

      log.debug('Using market data instance for LTP', {
        order_instance_id: instance.id,
        order_instance_name: instance.name,
        market_data_instance_id: marketDataInstance.id,
        market_data_instance_name: marketDataInstance.name,
        market_data_role: marketDataInstance.market_data_role,
        underlying,
        exchange,
      });

      // Fetch LTP from the market data instance
      const ltp = await this._getUnderlyingLTP(marketDataInstance, underlying, exchange);

      log.debug('Successfully fetched LTP from market data instance', {
        market_data_instance: marketDataInstance.name,
        market_data_role: marketDataInstance.market_data_role,
        underlying,
        ltp,
      });

      return ltp;
    } catch (error) {
      log.error('Failed to get LTP from market data instances', {
        order_instance_id: instance.id,
        order_instance_name: instance.name,
        underlying,
        exchange,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get underlying LTP with aggressive retry logic
   * LTP is critical for order placement and derivatives resolution
   * @private
   */
  async _getUnderlyingLTP(instance, underlying, exchange) {
    try {
      log.debug('Fetching LTP for underlying', {
        instance_id: instance.id,
        instance_name: instance.name,
        underlying,
        exchange,
      });

      const result = await marketDataFeedService.fetchLtpForSymbol(exchange, underlying, {
        maxRounds: 2,
      });

      if (result?.ltp && result.ltp > 0) {
        log.debug('LTP fetched successfully', {
          instance_id: instance.id,
          underlying,
          ltp: result.ltp,
          source: result.source,
          attempts: result.attempts,
        });
        return result.ltp;
      }

      throw new Error('No LTP returned');
    } catch (error) {
      log.error('Failed to get underlying LTP after retries', error, {
        instance_id: instance.id,
        instance_name: instance.name,
        underlying,
        exchange,
      });
      throw new ValidationError(`Unable to get LTP for ${underlying}: ${error.message}`);
    }
  }

  /**
   * Record quick order in database
   * @private
   */
  async _recordQuickOrder(orderData) {
    try {
      await orderRepository.insertQuickOrder(orderData);

      log.debug('Quick order recorded in database', {
        order_id: orderData.order_id,
        symbol: orderData.symbol,
      });

    } catch (error) {
      log.error('Failed to record quick order', error);
      // Non-fatal - order was still placed
    }
  }

  _buildFailurePayloadSummary(orderParams = {}, symbol = {}) {
    return {
      action: orderParams.action,
      trade_mode: orderParams.tradeMode,
      order_type: orderParams.orderType || 'LIMIT',
      quantity: orderParams.quantity ?? null,
      product: orderParams.product ?? null,
      price: orderParams.price ?? null,
      expiry: orderParams.expiry ?? null,
      options_leg: orderParams.optionsLeg ?? symbol.options_strike_selection ?? null,
      operating_mode: orderParams.operatingMode ?? null,
      strike_policy: orderParams.strikePolicy ?? null,
      step_lots: orderParams.stepLots ?? null,
      trigger_type: orderParams.triggerType ?? null,
    };
  }

  _extractErrorCode(error) {
    if (!error) return null;
    return (
      error.code ||
      error.errorCode ||
      error.statusCode ||
      error.name ||
      null
    );
  }

  async _recordFailedQuickOrder({ instance, symbol, orderParams, error, attempt = null }) {
    try {
      const errorCode = this._extractErrorCode(error);
      const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : null;
      const payloadSummary = this._buildFailurePayloadSummary(orderParams, symbol);
      const metadata = {
        payload_summary: payloadSummary,
        instance: {
          id: instance?.id ?? null,
          name: instance?.name ?? null,
        },
        error_code: errorCode,
        status_code: statusCode,
        attempt,
      };

      await this._recordQuickOrder({
        watchlist_id: symbol?.watchlist_id ?? null,
        symbol_id: symbol?.id ?? null,
        instance_id: instance?.id,
        underlying: symbol?.underlying_symbol || symbol?.symbol || 'UNKNOWN',
        symbol: symbol?.symbol || 'UNKNOWN',
        exchange: symbol?.exchange || 'UNKNOWN',
        action: orderParams?.action || 'UNKNOWN',
        trade_mode: orderParams?.tradeMode || 'UNKNOWN',
        options_leg: orderParams?.optionsLeg ?? symbol?.options_strike_selection ?? null,
        quantity: orderParams?.quantity ?? 0,
        product: orderParams?.product ?? null,
        order_type: orderParams?.orderType || 'LIMIT',
        price: orderParams?.price ?? null,
        trigger_price: null,
        resolved_symbol: null,
        strike_price: null,
        option_type: null,
        expiry_date: orderParams?.expiry ?? null,
        status: 'failed',
        order_id: null,
        message: error?.message || 'Order failed',
        error_details: JSON.stringify({
          code: errorCode,
          statusCode,
          message: error?.message || null,
        }),
        metadata,
        user_id: orderParams?.userId ?? null,
        source: orderParams?.source ?? null,
        trigger_type: orderParams?.triggerType ?? null,
        request_id: orderParams?.requestId ?? null,
        correlation_id: orderParams?.correlationId ?? null,
      });
    } catch (recordError) {
      log.warn('Failed to persist failed quick order', {
        instance_id: instance?.id,
        symbol_id: symbol?.id,
        error: recordError?.message,
      });
    }
  }

  /**
   * Map action/button to a human-friendly BUY/SELL side for summaries.
   */
  _deriveSideForSummary(action = '') {
    const act = (action || '').toUpperCase();
    const buyActions = new Set([
      'BUY',
      'COVER', // close short -> buy
      'BUY_CE',
      'BUY_PE',
      'INCREASE_CE',
      'INCREASE_PE',
    ]);
    const sellActions = new Set([
      'SELL',
      'SHORT',
      'EXIT', // flatten -> sell from perspective of summary
      'EXIT_ALL',
      'CLOSE_ALL_CE',
      'CLOSE_ALL_PE',
      'REDUCE_CE',
      'REDUCE_PE',
      'SELL_CE',
      'SELL_PE',
    ]);

    if (buyActions.has(act)) return 'BUY';
    if (sellActions.has(act)) return 'SELL';
    return act || 'UNKNOWN';
  }

  /**
   * Pick the best symbol/exchange to display in the summary.
   * Priority:
   * 1) first success with resolved_symbol
   * 2) first success with symbol
   * 3) any result with resolved_symbol
   * 4) any result with symbol
   * 5) fallback to watchlist symbol/exchange
   */
  _pickSummaryInstrument(results, fallbackSymbol, fallbackExchange) {
    const pick = (arr, key) => {
      const hit = arr.find(r => r && r[key]);
      return hit ? hit[key] : null;
    };

    const successes = results.filter(r => r && r.success);
    const any = results || [];

    const symResolvedSuccess = pick(successes, 'resolved_symbol');
    const symSuccess = pick(successes, 'symbol');
    const symResolvedAny = pick(any, 'resolved_symbol');
    const symAny = pick(any, 'symbol');

    const exchResolvedSuccess = pick(successes, 'exchange');
    const exchSuccess = pick(successes, 'exchange');
    const exchResolvedAny = pick(any, 'exchange');
    const exchAny = pick(any, 'exchange');

    return {
      summarySymbol: symResolvedSuccess || symSuccess || symResolvedAny || symAny || fallbackSymbol,
      summaryExchange: exchResolvedSuccess || exchSuccess || exchResolvedAny || exchAny || fallbackExchange,
    };
  }

  /**
   * Get quick orders with filters
   * @param {Object} filters - Query filters
   * @param {number} filters.instanceId - Filter by instance ID
   * @param {string} filters.symbol - Filter by symbol
   * @param {string} filters.tradeMode - Filter by trade mode
   * @param {string} filters.action - Filter by action
   * @param {number} filters.limit - Limit results
   * @param {number} filters.offset - Offset for pagination
   * @returns {Promise<Array<Object>>} Quick orders
   */
  async getQuickOrders(filters = {}) {
    try {
      let query = 'SELECT * FROM quick_orders WHERE 1=1';
      const params = [];

      if (filters.instanceId) {
        query += ' AND instance_id = ?';
        params.push(filters.instanceId);
      }

      if (filters.symbol) {
        query += ' AND underlying = ?';
        params.push(filters.symbol);
      }

      if (filters.tradeMode) {
        query += ' AND trade_mode = ?';
        params.push(filters.tradeMode);
      }

      if (filters.action) {
        query += ' AND action = ?';
        params.push(filters.action);
      }

      if (filters.exchange) {
        query += ' AND exchange = ?';
        params.push(filters.exchange);
      }

      query += ' ORDER BY created_at DESC';

      if (filters.limit) {
        query += ' LIMIT ?';
        params.push(filters.limit);
      }

      if (filters.offset) {
        query += ' OFFSET ?';
        params.push(filters.offset);
      }

      const orders = await db.all(query, params);

      log.debug('Retrieved quick orders', {
        count: orders.length,
        filters,
      });

      return orders;
    } catch (error) {
      log.error('Failed to get quick orders', error);
      throw error;
    }
  }

  async syncQuickOrdersForInstance(instanceId, { days = 7 } = {}) {
    const parsedDays = Number.isFinite(days) ? days : parseInt(days, 10);
    const windowDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
    const snapshot = await marketDataFeedService.getOrderbookSnapshot(instanceId, { force: true });
    const payload = snapshot?.data || [];
    const orders = Array.isArray(payload) ? payload : payload.orders || payload.data || [];

    const normalizeStatus = (value) => {
      const normalized = (value || '').toString().toLowerCase();
      if (!normalized) return null;
      if (['open', 'pending'].includes(normalized)) return normalized;
      if (['complete', 'completed', 'filled'].includes(normalized)) return 'complete';
      if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
      if (['rejected'].includes(normalized)) return 'rejected';
      return normalized;
    };

    const statusMap = new Map();
    for (const order of orders) {
      const orderId = order?.orderid || order?.order_id || order?.id;
      if (!orderId) continue;
      const rawStatus = order?.order_status || order?.status || order?.orderStatus || null;
      statusMap.set(String(orderId), {
        broker_status: rawStatus ? String(rawStatus) : null,
        status: normalizeStatus(rawStatus),
      });
    }

    const rows = await db.all(
      `SELECT id, order_id, status
       FROM quick_orders
       WHERE instance_id = ?
         AND order_id IS NOT NULL
         AND created_at >= datetime('now', ?)`,
      [instanceId, `-${windowDays} days`]
    );

    let updated = 0;
    for (const row of rows) {
      const entry = statusMap.get(String(row.order_id));
      if (!entry) continue;
      const nextStatus = entry.status || row.status;
      await db.run(
        `UPDATE quick_orders
         SET broker_status = ?, status = ?, last_sync_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [entry.broker_status, nextStatus, row.id]
      );
      updated += 1;
    }

    return {
      instance_id: instanceId,
      total_checked: rows.length,
      updated,
      skipped: rows.length - updated,
      fetched_at: snapshot?.fetchedAt || Date.now(),
    };
  }

  /**
   * Get quick order by ID
   * @param {number} id - Quick order ID
   * @returns {Promise<Object>} Quick order
   */
  async getQuickOrderById(id) {
    try {
      const order = await db.get(
        'SELECT * FROM quick_orders WHERE id = ?',
        [id]
      );

      if (!order) {
        throw new NotFoundError(`Quick order with ID ${id} not found`);
      }

      log.debug('Retrieved quick order', { id });

      return order;
    } catch (error) {
      log.error('Failed to get quick order by ID', error);
      throw error;
    }
  }

  /**
   * Get quick order statistics
   * @param {Object} filters - Query filters
   * @param {number} filters.instanceId - Filter by instance ID
   * @param {string} filters.symbol - Filter by symbol
   * @param {number} filters.days - Number of days to include (default: 7)
   * @returns {Promise<Object>} Statistics
   */
  async getQuickOrderStats(filters = {}) {
    try {
      const days = filters.days || 7;
      const sinceDate = toISTDate();
      sinceDate.setDate(sinceDate.getDate() - days);
      const sinceDateStr = toISTISOString(sinceDate);

      let query = `
        SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_orders,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_orders,
          COUNT(DISTINCT instance_id) as instances_used,
          COUNT(DISTINCT underlying) as unique_symbols,
          trade_mode,
          COUNT(*) as count
        FROM quick_orders
        WHERE created_at >= ?
      `;
      const params = [sinceDateStr];

      if (filters.instanceId) {
        query += ' AND instance_id = ?';
        params.push(filters.instanceId);
      }

      if (filters.symbol) {
        query += ' AND underlying = ?';
        params.push(filters.symbol);
      }

      query += ' GROUP BY trade_mode';

      const tradeModeCounts = await db.all(query, params);

      // Get overall stats
      let overallQuery = `
        SELECT
          COUNT(*) as total_orders,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_orders,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_orders,
          COUNT(DISTINCT instance_id) as instances_used,
          COUNT(DISTINCT underlying) as unique_symbols
        FROM quick_orders
        WHERE created_at >= ?
      `;
      const overallParams = [sinceDateStr];

      if (filters.instanceId) {
        overallQuery += ' AND instance_id = ?';
        overallParams.push(filters.instanceId);
      }

      if (filters.symbol) {
        overallQuery += ' AND underlying = ?';
        overallParams.push(filters.symbol);
      }

      const overall = await db.get(overallQuery, overallParams);

      // Get action breakdown
      let actionQuery = `
        SELECT
          action,
          COUNT(*) as count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed
        FROM quick_orders
        WHERE created_at >= ?
      `;
      const actionParams = [sinceDateStr];

      if (filters.instanceId) {
        actionQuery += ' AND instance_id = ?';
        actionParams.push(filters.instanceId);
      }

      if (filters.symbol) {
        actionQuery += ' AND underlying = ?';
        actionParams.push(filters.symbol);
      }

      actionQuery += ' GROUP BY action ORDER BY count DESC';

      const actionBreakdown = await db.all(actionQuery, actionParams);

      const stats = {
        period: {
          days,
          since: sinceDateStr,
        },
        overall: {
          total: overall.total_orders || 0,
          successful: overall.successful_orders || 0,
          failed: overall.failed_orders || 0,
          successRate:
            overall.total_orders > 0
              ? ((overall.successful_orders / overall.total_orders) * 100).toFixed(2)
              : '0.00',
          instancesUsed: overall.instances_used || 0,
          uniqueSymbols: overall.unique_symbols || 0,
        },
        byTradeMode: tradeModeCounts.map(tm => ({
          tradeMode: tm.trade_mode,
          count: tm.count,
        })),
        byAction: actionBreakdown.map(ab => ({
          action: ab.action,
          count: ab.count,
          successful: ab.successful,
          failed: ab.failed,
          successRate: ab.count > 0 ? ((ab.successful / ab.count) * 100).toFixed(2) : '0.00',
        })),
      };

      log.debug('Retrieved quick order stats', { days, filters });

      return stats;
    } catch (error) {
      log.error('Failed to get quick order stats', error);
      throw error;
    }
  }

  /**
   * Map cash market exchange to derivative exchange
   * @private
   */
  _getUnderlyingQuoteExchange(symbol = {}) {
    const exchange = (symbol.exchange || '').toUpperCase();
    const instrumentType = (symbol.instrumenttype || symbol.symbol_type || '').toUpperCase();
    const brexchange = (symbol.brexchange || '').toUpperCase();
    const underlying = derivativeResolutionService.getDerivativeUnderlying(symbol);

    if (BSE_INDEX_UNDERLYINGS.has(underlying)) {
      return 'BSE_INDEX';
    }
    if (NSE_INDEX_UNDERLYINGS.has(underlying)) {
      return 'NSE_INDEX';
    }

    if (exchange === 'BSE_INDEX' || brexchange === 'BSE_INDEX') {
      return 'BSE_INDEX';
    }
    if (exchange === 'NSE_INDEX' || brexchange === 'NSE_INDEX') {
      return 'NSE_INDEX';
    }

    if (instrumentType === 'INDEX') {
      return brexchange && brexchange.startsWith('BSE') ? 'BSE_INDEX' : 'NSE_INDEX';
    }

    if (symbol.exchange?.toUpperCase().includes('MCX') || brexchange === 'MCX' || instrumentType === 'COMMODITY') {
      return 'MCX';
    }

    if (exchange === 'BFO') return 'BSE';
    if (exchange === 'NFO') return 'NSE';

    return exchange || brexchange || 'NSE';
  }

  _getUnderlyingQuoteSymbol(symbol = {}) {
    const exchange = (symbol.exchange || '').toUpperCase();
    if (exchange === 'MCX') {
      return (symbol.symbol || symbol.trading_symbol || '').toUpperCase();
    }

    return (symbol.underlying_symbol || symbol.symbol || symbol.name || '').toUpperCase();
  }

  _getUnderlyingForClosing(symbol = {}) {
    return derivativeResolutionService.getUnderlyingForClosing(symbol);
  }

  /**
   * Parse futures symbol to extract underlying and expiry
   * Format: SYMBOL + DDMMMYY + FUT (e.g., NATGASMINI24NOV25FUT)
   * @private
   */
  _parseFuturesSymbol(symbolStr) {
    if (!symbolStr) {
      return { underlying: null, expiry: null };
    }

    const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

    // Normalize: uppercase, remove exchange prefix
    let normalized = symbolStr.toUpperCase();
    if (normalized.includes(':')) {
      normalized = normalized.split(':').pop();
    }

    // Match: UNDERLYING + DDMMMYY + FUT
    const match = normalized.match(/^([A-Z][A-Z0-9\-]*)(\d{2})([A-Z]{3})(\d{2})FUT$/);
    if (!match) {
      return { underlying: null, expiry: null };
    }

    const [, underlying, day, monthStr, year] = match;

    const monthIndex = MONTH_NAMES.indexOf(monthStr);
    if (monthIndex === -1) {
      return { underlying: null, expiry: null };
    }

    // 2-digit year assumed to be 2000-2099
    const expiry = `20${year}-${String(monthIndex + 1).padStart(2, '0')}-${day}`;

    return { underlying, expiry };
  }

  _getFuturesUnderlying(symbol = {}) {
    const parsed = this._parseFuturesSymbol(symbol.symbol || symbol.trading_symbol || symbol.name);
    return parsed.underlying || derivativeResolutionService.getDerivativeUnderlying(symbol);
  }

  _getSymbolExpiryVariants(symbol = {}) {
    const variants = new Set();
    const direct = symbol.expiry;
    if (direct) {
      derivativeResolutionService.expandExpiryFormats(direct)
        .forEach((value) => variants.add(value));
    }
    const parsed = this._parseFuturesSymbol(symbol.symbol || symbol.trading_symbol || symbol.name);
    if (parsed.expiry) {
      derivativeResolutionService.expandExpiryFormats(parsed.expiry)
        .forEach((value) => variants.add(value));
    }
    return variants;
  }

  _expiryMatchesSymbol(expiry, symbol = {}) {
    const selected = derivativeResolutionService.expandExpiryFormats(expiry);
    if (!selected.length) {
      return false;
    }
    const symbolVariants = this._getSymbolExpiryVariants(symbol);
    return selected.some((value) => symbolVariants.has(value));
  }

  /**
   * Get market data instance from list of instances
   * Uses round-robin across enabled market data instances
   * @private
   */
  async _getMarketDataInstance(instances) {
    const rr = await marketDataInstanceService.getRoundRobinInstance();
    if (rr) {
      log.debug('Using round-robin market data instance', {
        instance_id: rr.id,
        name: rr.name,
      });
      return rr;
    }
    // Fallback: use provided instances list if any
    if (instances && instances.length > 0) {
      log.warn('Round-robin market data pool empty, using fallback instance list', {
        instance_id: instances[0].id,
        name: instances[0].name,
      });
      return instances[0];
    }
    throw new Error('No market data instance available');
  }

  /**
   * Pre-resolve option symbol once for all instances
   * @private
   */
  async _preResolveOptionSymbol(marketDataInstance, symbol, orderParams) {
    const resolution = await this._resolveOptionSymbolForInstance(
      marketDataInstance,
      symbol,
      orderParams
    );
    log.info('Option symbol resolved for multi-instance broadcast', {
      underlying: resolution.underlying,
      expiry: resolution.expiry,
      symbol: resolution.optionSymbol.symbol,
      strike: resolution.optionSymbol.strike,
    });
    return resolution;
  }

  /**
   * Ensure a symbol is marked tradable for OPTIONS by checking instruments table
   * @param {Object} symbol - Watchlist symbol record
   * @returns {Promise<boolean>}
   * @private
   */
  async _ensureOptionsTradability(symbol) {
    if (symbol.symbol_type === 'OPTIONS' || symbol.tradable_options === 1) {
      return true;
    }

    const underlying = derivativeResolutionService.getDerivativeUnderlying(symbol);
    if (!underlying) {
      return false;
    }

    const row = await db.get(
      `SELECT 1 FROM instruments
       WHERE name = ? AND instrumenttype IN ('CE', 'PE') LIMIT 1`,
      [underlying]
    );

    if (row) {
      await db.run(
        `UPDATE watchlist_symbols
         SET tradable_options = 1, underlying_symbol = COALESCE(underlying_symbol, ?)
         WHERE id = ?`,
        [underlying, symbol.id]
      );
      symbol.tradable_options = 1;
      if (!symbol.underlying_symbol) {
        symbol.underlying_symbol = underlying;
      }
      return true;
    }

    return false;
  }

  /**
   * Ensure a symbol is marked tradable for FUTURES by checking instruments table
   * @param {Object} symbol - Watchlist symbol record
   * @returns {Promise<boolean>}
   * @private
   */
  async _ensureFuturesTradability(symbol) {
    if (symbol.symbol_type === 'FUTURES' || symbol.tradable_futures === 1) {
      return true;
    }

    const underlying = derivativeResolutionService.getDerivativeUnderlying(symbol);
    if (!underlying) {
      return false;
    }

    const row = await db.get(
      `SELECT 1 FROM instruments
       WHERE name = ? AND instrumenttype = 'FUT' LIMIT 1`,
      [underlying]
    );

    if (row) {
      await db.run(
        `UPDATE watchlist_symbols
         SET tradable_futures = 1, underlying_symbol = COALESCE(underlying_symbol, ?)
         WHERE id = ?`,
        [underlying, symbol.id]
      );
      symbol.tradable_futures = 1;
      if (!symbol.underlying_symbol) {
        symbol.underlying_symbol = underlying;
      }
      return true;
    }

    return false;
  }

  /**
   * Resolve option symbol for a single instance
   * @private
   */
  async _resolveOptionSymbolForInstance(instance, symbol, orderParams) {
    const { action, expiry: userExpiry, optionsLeg: userOptionsLeg } = orderParams;
    const optionType = this._getOptionTypeFromAction(action);

    const underlying = symbol.underlying_symbol || symbol.symbol;
    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(symbol.exchange);
    const baseExchange = this._getUnderlyingQuoteExchange(symbol);
    const quoteSymbol = this._getUnderlyingQuoteSymbol(symbol);

    const strikeOffset = userOptionsLeg || symbol.options_strike_selection || 'ATM';
    const cacheKey = this._buildResolutionCacheKey(
      symbol.id,
      derivativeExchange,
      optionType,
      userExpiry || '',
      strikeOffset
    );

    const now = Date.now();
    const cached = this.symbolResolutionCache.get(cacheKey);
    if (cached && now - cached.ts < this.symbolResolutionCacheTtl) {
      log.debug('Using cached option resolution', { cacheKey });
      return cached.value;
    }

    await this._ensureQuoteAvailableForSymbol(instance, baseExchange, quoteSymbol);

    const [ltp, expiry] = await Promise.all([
      this._getUnderlyingLTPWithFallback(instance, quoteSymbol, baseExchange),
      this._resolveExpiryForOption(instance, underlying, derivativeExchange, userExpiry),
    ]);

    if (!expiry) {
      throw new ValidationError('Unable to determine expiry for options resolution');
    }

    log.info('Resolving option symbol', {
      underlying,
      expiry,
      optionType,
      strikeOffset,
      baseExchange,
      quoteSymbol,
    });

    const optionSymbol = await optionsResolutionService.resolveOptionSymbol({
      underlying,
      exchange: derivativeExchange,
      expiry,
      optionType,
      strikeOffset,
      ltp,
      instance,
    });

    const resolution = { underlying, expiry, optionSymbol };

    // CRITICAL FIX: Clean up cache before adding new entry to prevent memory leak
    this._cleanupSymbolResolutionCache();
    this.symbolResolutionCache.set(cacheKey, { value: resolution, ts: now });

    return resolution;
  }

  /**
   * Clean up expired entries and enforce max cache size
   * CRITICAL: Prevents memory leak from unbounded cache growth
   * @private
   */
  _cleanupSymbolResolutionCache() {
    const now = Date.now();

    // First pass: Remove expired entries
    for (const [key, entry] of this.symbolResolutionCache.entries()) {
      if (now - entry.ts >= this.symbolResolutionCacheTtl) {
        this.symbolResolutionCache.delete(key);
      }
    }

    // Second pass: If still over limit, remove oldest entries
    if (this.symbolResolutionCache.size >= this.symbolResolutionCacheMaxSize) {
      const entries = Array.from(this.symbolResolutionCache.entries())
        .sort((a, b) => a[1].ts - b[1].ts); // Sort by timestamp ascending (oldest first)

      const toRemove = entries.slice(0, Math.floor(this.symbolResolutionCacheMaxSize * 0.1)); // Remove oldest 10%
      toRemove.forEach(([key]) => this.symbolResolutionCache.delete(key));

      log.debug('Symbol resolution cache cleanup performed', {
        removed: toRemove.length,
        currentSize: this.symbolResolutionCache.size,
        maxSize: this.symbolResolutionCacheMaxSize
      });
    }
  }

  /**
   * Provide option symbol + LTP preview for UI display
   */
  async getOptionsPreview({ symbolId, expiry = null, optionsLeg = null }) {
    if (!symbolId) {
      throw new ValidationError('symbolId is required for options preview');
    }

    const symbol = await this._getSymbolConfig(symbolId);

    const supportsOptions =
      symbol.symbol_type === 'OPTIONS' ||
      symbol.tradable_options === 1 ||
      (await this._ensureOptionsTradability(symbol));

    if (!supportsOptions) {
      throw new ValidationError(
        `Symbol ${symbol.symbol} is not enabled for options trading. Enable the options flag in the watchlist symbol configuration.`
      );
    }

    const underlying = derivativeResolutionService.getDerivativeUnderlying(symbol);
    if (!underlying) {
      throw new ValidationError(
        'Underlying symbol is required to preview options strikes. Please set it in the watchlist symbol settings.'
      );
    }

    const strikeOffset = (optionsLeg || symbol.options_strike_selection || 'ATM').toUpperCase();
    const validOffsets = ['ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3'];
    if (!validOffsets.includes(strikeOffset)) {
      throw new ValidationError(
        `optionsLeg must be one of ${validOffsets.join(', ')}. Received "${strikeOffset}".`
      );
    }

    const normalizedExpiry = expiry ? this._normalizeExpiryInput(expiry) : null;

    const marketDataInstance = await this._getStableMarketDataInstanceForPreview(symbolId);

    let effectiveExpiry =
      normalizedExpiry ||
      await expiryManagementService.getNearestExpiry(
        underlying,
        symbol.exchange,
        marketDataInstance
      );

    // Never use past expiries: if user-supplied expiry is stale, fall back to nearest future
    const todayIso = (() => {
      const d = toISTDate();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();
    if (effectiveExpiry && effectiveExpiry < todayIso) {
      effectiveExpiry = await expiryManagementService.getNearestExpiry(
        underlying,
        symbol.exchange,
        marketDataInstance,
        true
      );
    }

    if (!effectiveExpiry) {
      throw new ValidationError(
        'Unable to determine an expiry for options preview. Please pick an expiry in the UI.'
      );
    }

    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(symbol.exchange);
    const baseExchange = this._getUnderlyingQuoteExchange(symbol);
    const quoteSymbol = this._getUnderlyingQuoteSymbol(symbol);
    const underlyingLtp = await this._getUnderlyingLTP(
      marketDataInstance,
      quoteSymbol,
      baseExchange
    );

    const optionChain = await optionsResolutionService.getOptionChainSnapshot({
      underlying,
      exchange: derivativeExchange,
      expiry: effectiveExpiry,
      instance: marketDataInstance,
    });

    if (!optionChain) {
      throw new ValidationError('Unable to fetch option strikes for preview. Please try again.');
    }

    const resolveParamsBase = {
      underlying,
      exchange: derivativeExchange,
      expiry: effectiveExpiry,
      strikeOffset,
      ltp: underlyingLtp,
      instance: marketDataInstance,
      optionChain,
    };

    const [ceResolution, peResolution] = await Promise.all([
      optionsResolutionService.resolveOptionSymbol({
        ...resolveParamsBase,
        optionType: 'CE',
      }),
      optionsResolutionService.resolveOptionSymbol({
        ...resolveParamsBase,
        optionType: 'PE',
      }),
    ]);

    const atmStrike = ceResolution?.atmStrike ?? peResolution?.atmStrike ?? null;

    const strikePreview = await optionsResolutionService.buildStrikePreview({
      underlying,
      exchange: derivativeExchange,
      expiry: effectiveExpiry,
      ltp: underlyingLtp,
      instance: marketDataInstance,
      optionChain,
    });

    const quoteRequests = [];
    if (ceResolution?.symbol) {
      quoteRequests.push({ exchange: derivativeExchange, symbol: ceResolution.symbol });
    }
    if (peResolution?.symbol) {
      quoteRequests.push({ exchange: derivativeExchange, symbol: peResolution.symbol });
    }

    const requestedKeys = quoteRequests
      .map(req => this._buildQuoteMatchKey(req.exchange || derivativeExchange, req.symbol))
      .filter(Boolean);

    const wsQuotes = await this._getQuotesPreferWs(quoteRequests);
    const wsHasAll = this._hasAllQuotes(wsQuotes, requestedKeys, true);

    let optionChainQuotes = null;
    let fallbackQuotes = null;
    if (!wsHasAll) {
      optionChainQuotes = await this._getOptionChainQuotesMap({
        instance: marketDataInstance,
        underlying,
        expiry: effectiveExpiry,
        exchange: derivativeExchange,
        minStrikeCount: 5,
      });
      const chainHasAll = this._hasAllQuotes(optionChainQuotes, requestedKeys, true);
      fallbackQuotes = chainHasAll ? null : await this._getQuotesFromCache(marketDataInstance, quoteRequests);
    }

    let quotesMap = this._mergeQuoteMaps(wsQuotes, optionChainQuotes);
    quotesMap = this._mergeQuoteMaps(quotesMap, fallbackQuotes);
    const now = Date.now();

    // Use a longer-lived symbol cache to reduce blanks when live fetches miss.
    const staleEntries = marketDataFeedService.getCachedQuoteEntriesForSymbols(
      quoteRequests,
      { ttlMs: this.optionPreviewQuoteTtlMs }
    );
    if (staleEntries?.cached?.length) {
      const staleMap = new Map();
      staleEntries.cached.forEach((entry) => {
        const key = this._buildQuoteMatchKey(
          entry.quote?.exchange || entry.quote?.exch,
          entry.quote?.symbol || entry.quote?.trading_symbol || entry.quote?.tradingsymbol
        );
        if (key) {
          staleMap.set(key, { ...entry.quote, fetchedAt: entry.fetchedAt });
        }
      });
      quotesMap = this._mergeQuoteMaps(quotesMap, staleMap);
    }

    // Refresh last-good preview quotes and trim expired entries.
    this.optionPreviewQuoteCache.forEach((entry, key) => {
      if (!entry?.fetchedAt || now - entry.fetchedAt > this.optionPreviewQuoteTtlMs) {
        this.optionPreviewQuoteCache.delete(key);
      }
    });
    requestedKeys.forEach((key) => {
      const quote = quotesMap.get(key);
      if (!quote) return;
      const ltpValue = this._extractLtpFromQuote(quote);
      if (ltpValue === null) return;
      this.optionPreviewQuoteCache.set(key, {
        ltp: ltpValue,
        changePercent: this._extractChangePercentFromQuote(quote),
        fetchedAt: quote.fetchedAt || now,
      });
    });

    const buildLegResponse = (resolution) => {
      if (!resolution?.symbol) {
        return null;
      }

      const quoteKey = this._buildQuoteMatchKey(derivativeExchange, resolution.symbol);
      let quote = quoteKey ? quotesMap.get(quoteKey) : null;
      let ltp = quote ? this._extractLtpFromQuote(quote) : null;
      let changePercent = quote ? this._extractChangePercentFromQuote(quote) : null;
      let fetchedAt = quote?.fetchedAt || null;

      if (ltp === null && quoteKey) {
        const cached = this.optionPreviewQuoteCache.get(quoteKey);
        if (cached && cached.fetchedAt && now - cached.fetchedAt <= this.optionPreviewQuoteTtlMs) {
          ltp = cached.ltp;
          changePercent = cached.changePercent ?? null;
          fetchedAt = cached.fetchedAt;
          quote = cached;
        }
      }
      const quoteStale = fetchedAt ? now - fetchedAt > this.optionPreviewStaleMs : false;
      const quoteSource = quote?._source || quote?.source || (quote ? 'rest' : null);

      return {
        symbol: resolution.symbol,
        tradingSymbol: resolution.trading_symbol || resolution.symbol,
        strike: resolution.targetStrike ?? resolution.strike,
        optionType: resolution.optionType,
        lotSize: resolution.lot_size || symbol.lot_size || symbol.lotsize || 1,
        tickSize: resolution.tick_size || 0.05,
        token: resolution.token || null,
        ltp,
        changePercent,
        quoteStale,
        quoteSource,
      };
    };

    return {
      symbolId,
      watchlistId: symbol.watchlist_id,
      expiry: effectiveExpiry,
      strikeOffset,
      derivativeExchange,
      updatedAt: toISTISOString(),
      atmStrike,
      strikePreview,
      underlying: {
        symbol: underlying,
        exchange: symbol.exchange,
        ltp: underlyingLtp,
      },
      ce: buildLegResponse(ceResolution),
      pe: buildLegResponse(peResolution),
    };
  }

  /**
   * Provide futures symbol + quote preview for UI display
   */
  async getFuturesPreview({ symbolId, expiry = null }) {
    if (!symbolId) {
      throw new ValidationError('symbolId is required for futures preview');
    }

    const symbol = await this._getSymbolConfig(symbolId);

    const supportsFutures =
      symbol.symbol_type === 'FUTURES' ||
      symbol.tradable_futures === 1 ||
      (await this._ensureFuturesTradability(symbol));

    if (!supportsFutures) {
      throw new ValidationError(
        `Symbol ${symbol.symbol} is not enabled for futures trading. Enable the futures flag in the watchlist symbol configuration.`
      );
    }

    const normalizedExpiry = expiry ? this._normalizeExpiryInput(expiry) : null;
    if (!normalizedExpiry) {
      throw new ValidationError('Select an expiry to preview futures quotes.');
    }

    const derivativeExchange = symbol.symbol_type === 'FUTURES'
      ? symbol.exchange
      : derivativeResolutionService.getDerivativeExchange(symbol.exchange);

    const marketDataInstance = await this._getStableMarketDataInstanceForPreview(symbolId);

    // Prevent using past expiries; if stale, switch to nearest future
    const todayIso = (() => {
      const d = toISTDate();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();
    const fallbackUnderlying = this._getFuturesUnderlying(symbol);
    const chosenExpiry = (normalizedExpiry && normalizedExpiry < todayIso && fallbackUnderlying)
      ? await expiryManagementService.getNearestExpiry(
        fallbackUnderlying,
        derivativeExchange,
        marketDataInstance,
        true
      )
      : normalizedExpiry;

    let futuresResolution;
    const matchesWatchlistExpiry = symbol.symbol_type === 'FUTURES'
      && this._expiryMatchesSymbol(chosenExpiry, symbol);

    if (matchesWatchlistExpiry) {
      futuresResolution = {
        symbol: symbol.symbol,
        trading_symbol: symbol.trading_symbol || symbol.symbol,
        lot_size: symbol.lot_size || symbol.lotsize || 1,
        tick_size: symbol.tick_size || 0.05,
        expiry: symbol.expiry || chosenExpiry,
      };
    } else {
      const underlying = fallbackUnderlying;
      if (!underlying) {
        throw new ValidationError(
          'Underlying symbol is required to preview futures contracts. Please set it in the watchlist symbol settings.'
        );
      }

      futuresResolution = await derivativeResolutionService.resolveFuturesSymbol(
        marketDataInstance,
        underlying,
        derivativeExchange,
        chosenExpiry
      );
    }

    const quotesMap = await this._getQuotesPreferWs([
      {
        exchange: derivativeExchange,
        symbol: futuresResolution.symbol,
      },
    ]);

    const quoteKey = this._buildQuoteMatchKey(derivativeExchange, futuresResolution.symbol);
    const quote = quoteKey ? quotesMap.get(quoteKey) : null;
    const fetchedAt = quote?.fetchedAt || Date.now();
    const quoteSource = quote?._source || quote?.source || (quote ? 'rest' : null);

    return {
      symbolId,
      watchlistId: symbol.watchlist_id,
      expiry: futuresResolution.expiry || chosenExpiry,
      derivativeExchange,
      futuresSymbol: futuresResolution.symbol,
      tradingSymbol: futuresResolution.trading_symbol || futuresResolution.symbol,
      lotSize: futuresResolution.lot_size || symbol.lot_size || symbol.lotsize || 1,
      tickSize: futuresResolution.tick_size || 0.05,
      quote: quote
        ? {
            ltp: this._extractLtpFromQuote(quote),
            changePercent: this._extractChangePercentFromQuote(quote),
            fetchedAt,
            source: quoteSource,
          }
        : null,
      updatedAt: toISTISOString(),
    };
  }

  /**
   * Compute target position based on action (Implementation Guide Section 14)
   * @param {number} current - Current position (signed: +ve long, -ve short)
   * @param {string} action - Button action
   * @param {number} Qstep - Quantity step (step_lots × lotsize)
   * @param {boolean} writerGuard - Enable writer guard (clamp at 0 when covering shorts)
   * @returns {number} - Target position
   * @private
   */
  _computeTarget(current, action, Qstep, writerGuard = true) {
    // Writer actions (short premium)
    if (action === 'SELL_CE' || action === 'SELL_PE') {
      return current - Qstep;  // More negative (add short)
    }

    if (action === 'INCREASE_CE' || action === 'INCREASE_PE') {
      const target = current + Qstep;  // Less negative (reduce short)
      return writerGuard ? Math.min(0, target) : target;  // Clamp at 0 if guard enabled
    }

    // Buyer actions (long premium)
    if (action === 'BUY_CE' || action === 'BUY_PE') {
      return current + Qstep;  // Add longs
    }

    if (action === 'REDUCE_CE' || action === 'REDUCE_PE') {
      return Math.max(0, current - Qstep);  // Reduce longs, don't go negative
    }

    // Close actions
    if (action === 'CLOSE_ALL_CE' || action === 'CLOSE_ALL_PE' || action === 'EXIT_ALL') {
      return 0;
    }

    // Unknown action
    throw new ValidationError(`Unknown action for target calculation: ${action}`);
  }

  /**
   * Get aggregated position for all strikes of a TYPE (CE/PE) for selected expiry
   * Required for FLOAT_OFS mode where multiple strikes may be held
   * @param {Object} instance - Instance object
   * @param {string} underlying - Underlying symbol
   * @param {string} expiry - Expiry date (YYYY-MM-DD)
   * @param {string} optionType - CE or PE
   * @param {string} product - Product type (MIS, NRML)
   * @returns {Promise<number>} - Total net position across all strikes
   * @private
   */
  async _getAggregatedTypePosition(instance, underlying, expiry, optionType, product) {
    try {
      // Query watchlist_options_state for aggregated position
      const rows = await db.all(`
        SELECT SUM(net_qty) as total_qty
        FROM watchlist_options_state
        WHERE instance_id = ?
          AND underlying = ?
          AND expiry = ?
          AND option_type = ?
          AND product = ?
      `, [instance.id, underlying, expiry, optionType, product]);

      const totalQty = rows && rows[0] && rows[0].total_qty ? parseIntSafe(rows[0].total_qty) : 0;

      log.debug('Aggregated TYPE position', {
        instance_id: instance.id,
        underlying,
        expiry,
        optionType,
        product,
        totalQty,
      });

      return totalQty;
    } catch (error) {
      log.warn('Failed to get aggregated position from state, falling back to 0', error);
      return 0;
    }
  }

  /**
   * Get ALL open positions for all strikes of a TYPE (CE/PE) for selected expiry
   * Required for FLOAT_OFS REDUCE/INCREASE actions to target each open strike
   * @param {Object} instance - Instance object
   * @param {string} underlying - Underlying symbol
   * @param {string} expiry - Expiry date (YYYY-MM-DD)
   * @param {string} optionType - CE or PE
   * @param {string} product - Product type (MIS, NRML)
   * @returns {Promise<Array>} - Array of positions with symbol, strike, and quantity
   * @private
   */
  /**
   * Construct option symbol from components (OpenAlgo format)
   * Format: UNDERLYING + DDMMMYY + STRIKE + CE/PE
   * Example: NIFTY + 18NOV25 + 26000 + CE → NIFTY18NOV2526000CE
   * @see https://docs.openalgo.in/symbol-format
   * @private
   */
  _constructOptionSymbol(underlying, expiry, optionType, strike) {
    // Parse expiry YYYY-MM-DD
    const date = new Date(expiry);
    const day = String(date.getDate()).padStart(2, '0');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = months[date.getMonth()];
    const year = String(date.getFullYear()).slice(-2);  // Use 2-digit year (OpenAlgo format)

    // Construct symbol: NIFTY18NOV2526000CE (OpenAlgo format: SYMBOL + DATE + STRIKE + TYPE)
    return `${underlying}${day}${month}${year}${strike}${optionType}`;
  }

  async _getAllOpenPositions(instance, underlying, expiry, optionType, product) {
    try {
      log.info('Querying position book from OpenAlgo', {
        instance_id: instance.id,
        underlying,
        expiry,
        optionType,
        product,
      });

      const positionBook = await this._getPositionBook(instance);

      const targetUnderlying = (underlying || '').toUpperCase();
      const targetOptionType = (optionType || '').toUpperCase();

      const positions = positionBook
        .filter(pos => {
          const rawSymbol = pos.symbol || '';
          if (!rawSymbol) return false;

          const symbol = rawSymbol.toUpperCase();

          const quantity =
            parseIntSafe(pos.quantity) ||
            parseIntSafe(pos.netqty) ||
            parseIntSafe(pos.net_quantity) ||
            parseIntSafe(pos.net) ||
            parseIntSafe(pos.netQty) ||
            0;

          if (quantity === 0) {
            return false;
          }

          const parsed = this._parseOptionSymbol(symbol);
          const matchesUnderlying = parsed.underlying
            ? parsed.underlying === targetUnderlying
            : symbol.includes(targetUnderlying);

          if (!matchesUnderlying) return false;

          const matchesExpiry = parsed.expiry ? parsed.expiry === expiry : true;
          if (!matchesExpiry) return false;

          const parsedType = parsed.type ? parsed.type.toUpperCase() : null;
          const matchesOptionType = parsedType
            ? parsedType === targetOptionType
            : symbol.includes(targetOptionType);

          return matchesOptionType;
        })
        .map(pos => ({
          symbol: pos.symbol,
          netQty:
            parseIntSafe(pos.quantity) ||
            parseIntSafe(pos.netqty) ||
            parseIntSafe(pos.net_quantity) ||
            parseIntSafe(pos.net) ||
            parseIntSafe(pos.netQty) ||
            0,
          avgPrice: parseFloatSafe(pos.avgprice || pos.average_price),
          product: pos.product || product,
        }));

      log.info('Retrieved all open positions from OpenAlgo positionbook', {
        instance_id: instance.id,
        underlying,
        expiry,
        optionType,
        product,
        positionCount: positions.length,
        positions: positions.map(p => ({ symbol: p.symbol, qty: p.netQty, avgPrice: p.avgPrice })),
      });

      return positions;
    } catch (error) {
      log.warn('Failed to get open positions from positionbook, returning empty array', error);
      return [];
    }
  }

  /**
   * Parse option symbol string to extract components
   * Example: "NIFTY05DEC25C22450" → { underlying: "NIFTY", expiry: "2025-12-05", type: "CE", strike: 22450 }
   * @param {string} symbol - Option symbol string
   * @returns {Object} - Parsed components
   * @private
   */
  _parseOptionSymbol(symbol) {
    if (!symbol) {
      return {
        underlying: null,
        expiry: null,
        type: null,
        strike: null,
      };
    }

    // Normalize symbol: uppercase, drop exchange prefixes (e.g., NFO:, MCX:)
    let normalized = symbol.toUpperCase();
    if (normalized.includes(':')) {
      normalized = normalized.split(':').pop();
    }

    // Expected format: UNDERLYING + DDMMMYY + STRIKE + CE/PE
    const match = normalized.match(/^([A-Z]+)(\d{2}[A-Z]{3}\d{2})(\d+)([CP]E?)$/);
    if (!match) {
      log.warn('Failed to parse option symbol', { symbol });
      return {
        underlying: null,
        expiry: null,
        type: null,
        strike: null,
      };
    }

    const [, underlying, dateStr, strikeStr, rawType] = match;

    const monthMap = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04',
      MAY: '05', JUN: '06', JUL: '07', AUG: '08',
      SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };

    const day = dateStr.substring(0, 2);
    const monthAbbr = dateStr.substring(2, 5);
    const year = '20' + dateStr.substring(5, 7);
    const month = monthMap[monthAbbr] || '01';
    const expiry = `${year}-${month}-${day}`;

    const type = rawType.startsWith('C') ? 'CE' : 'PE';

    return {
      underlying,
      expiry,
      type,
      strike: parseInt(strikeStr, 10),
    };
  }

  /**
   * Determine OpenAlgo action (BUY/SELL) based on target position change
   * @param {number} currentPosition - Current position
   * @param {number} targetPosition - Target position
   * @returns {string} - 'BUY' or 'SELL'
   * @private
   */
  _determineAlgoAction(currentPosition, targetPosition) {
    const delta = targetPosition - currentPosition;

    if (delta > 0) {
      // Increasing position → BUY
      return 'BUY';
    } else if (delta < 0) {
      // Decreasing position → SELL
      return 'SELL';
    } else {
      // No change (shouldn't happen in normal flow)
      throw new ValidationError('No position change - delta is zero');
    }
  }

  _buildResolutionCacheKey(symbolId, exchange, optionType, expiry, strikeOffset) {
    return `${symbolId}::${exchange}::${optionType}::${expiry || 'AUTO'}::${strikeOffset || 'ATM'}`;
  }

  async _resolveExpiryForOption(instance, underlying, derivativeExchange, userExpiry) {
    if (userExpiry) {
      return this._normalizeExpiryInput(userExpiry);
    }
    const expiry = await expiryManagementService.getNearestExpiry(
      underlying,
      derivativeExchange,
      instance
    );
    return expiry ? this._normalizeExpiryInput(expiry) : null;
  }

  async _ensureQuoteAvailableForSymbol(instance, exchange, symbol) {
    const snapshot = marketDataFeedService.getQuoteSnapshot(instance.id);
    const cached = this._findQuoteInSnapshot(snapshot, exchange, symbol);
    if (cached) return;
    try {
      await marketDataFeedService.fetchLtpForSymbol(exchange, symbol, { maxRounds: 1 });
      return;
    } catch (_) {
      // fallback to REST refresh
    }
    await marketDataFeedService.refreshQuotes({ force: true });
  }

  /**
   * Get or create anchored strike for ANCHOR_OFS policy
   * @param {number} symbolId - Watchlist symbol ID
   * @param {string} optionType - CE or PE
   * @param {string} expiry - Expiry date
   * @param {number} strike - Strike price (if setting anchor)
   * @param {boolean} setAnchor - Whether to set/update the anchor
   * @returns {Promise<number|null>} - Anchored strike or null
   * @private
   */
  async _manageAnchoredStrike(symbolId, optionType, expiry, strike = null, setAnchor = false) {
    const columnName = optionType === 'CE' ? 'anchored_ce_strike' : 'anchored_pe_strike';

    if (setAnchor && strike) {
      // Set or update anchored strike
      await db.run(`
        UPDATE watchlist_symbols
        SET ${columnName} = ?, anchored_expiry = ?
        WHERE id = ?
      `, [strike, expiry, symbolId]);

      log.info('Anchored strike set', { symbolId, optionType, strike, expiry });
      return strike;
    } else {
      // Get existing anchored strike
      const row = await db.get(`
        SELECT ${columnName} as strike, anchored_expiry
        FROM watchlist_symbols
        WHERE id = ?
      `, [symbolId]);

      // Only return anchored strike if expiry matches
      if (row && row.anchored_expiry === expiry) {
        return row.strike ? parseIntSafe(row.strike) : null;
      }

      return null;
    }
  }

  /**
   * Clear anchored strikes (when expiry or offset changes)
   * @param {number} symbolId - Watchlist symbol ID
   * @param {string} optionType - CE, PE, or null for both
   * @private
   */
  async _clearAnchoredStrikes(symbolId, optionType = null) {
    if (optionType === 'CE') {
      await db.run('UPDATE watchlist_symbols SET anchored_ce_strike = NULL WHERE id = ?', [symbolId]);
    } else if (optionType === 'PE') {
      await db.run('UPDATE watchlist_symbols SET anchored_pe_strike = NULL WHERE id = ?', [symbolId]);
    } else {
      // Clear both
      await db.run('UPDATE watchlist_symbols SET anchored_ce_strike = NULL, anchored_pe_strike = NULL, anchored_expiry = NULL WHERE id = ?', [symbolId]);
    }

    log.info('Cleared anchored strikes', { symbolId, optionType: optionType || 'both' });
  }

  /**
   * Sync position to watchlist_options_state table
   * @param {number} watchlistId - Watchlist ID
   * @param {number} symbolId - Symbol ID
   * @param {number} instanceId - Instance ID
   * @param {string} underlying - Underlying symbol
   * @param {string} expiry - Expiry date
   * @param {string} optionType - CE or PE
   * @param {number} strike - Strike price
   * @param {number} netQty - Net quantity
   * @param {number} avgPrice - Average price
   * @param {string} product - Product type
   * @private
   */
  async _syncOptionsState(watchlistId, symbolId, instanceId, underlying, expiry, optionType, strike, netQty, avgPrice, product) {
    try {
      await db.run(`
        INSERT INTO watchlist_options_state
          (watchlist_id, symbol_id, instance_id, underlying, expiry, option_type, strike, net_qty, avg_price, product, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(instance_id, underlying, expiry, option_type, strike)
        DO UPDATE SET
          net_qty = ?,
          avg_price = ?,
          last_updated = CURRENT_TIMESTAMP
      `, [
        watchlistId, symbolId, instanceId, underlying, expiry, optionType, strike,
        netQty, avgPrice, product,
        netQty, avgPrice
      ]);

      log.debug('Synced options state', {
        instance_id: instanceId,
        underlying,
        expiry,
        optionType,
        strike,
        netQty,
      });
    } catch (error) {
      log.error('Failed to sync options state', error, {
        instance_id: instanceId,
        underlying,
        expiry,
        optionType,
        strike,
      });
    }
  }

  /**
   * Invalidate all instance caches after order placement
   * Uses centralized cache invalidation from market-data-feed service
   * @private
   */
  _invalidateInstanceCaches(instanceId, options = {}) {
    const {
      refresh = true,
      feeds = ['positions', 'funds', 'orderbook', 'tradebook']
    } = options;

    // Use centralized cache invalidation
    marketDataFeedService.invalidateInstanceCaches(instanceId, { refresh, feeds })
      .catch(error => log.warn('Failed to invalidate instance caches', {
        instance_id: instanceId,
        error: error.message,
      }));
  }

  /**
   * Extract position size from a position book array
   * Used to get position from preloaded positions without additional API calls
   * @private
   */
  _extractPositionFromBook(positionBook, symbol, exchange, product) {
    if (!positionBook || !Array.isArray(positionBook)) {
      return 0;
    }

    const targetSymbol = this._normalizeSymbolKey(symbol);
    const targetExchange = this._normalizeExchange(exchange);
    const targetProduct = this._normalizeProduct(product);

    return positionBook.reduce((total, pos) => {
      const posSymbol = this._normalizeSymbolKey(
        pos.symbol || pos.trading_symbol || pos.tradingsymbol
      );
      if (!posSymbol || posSymbol !== targetSymbol) {
        return total;
      }

      const posExchange = this._normalizeExchange(pos.exchange || pos.exch);
      if (targetExchange && posExchange && posExchange !== targetExchange) {
        return total;
      }

      const posProduct = this._normalizeProduct(pos.product || pos.producttype);
      if (targetProduct && posProduct && posProduct !== targetProduct) {
        return total;
      }

      const qty =
        parseIntSafe(pos.quantity) ||
        parseIntSafe(pos.netqty) ||
        parseIntSafe(pos.net_quantity) ||
        parseIntSafe(pos.net) ||
        parseIntSafe(pos.netQty) ||
        0;

      return total + qty;
    }, 0);
  }

  _mergeQuoteMaps(primary, secondary) {
    const merged = new Map();
    if (secondary) {
      secondary.forEach((value, key) => merged.set(key, value));
    }
    if (primary) {
      primary.forEach((value, key) => {
        const existing = merged.get(key);
        const hasExistingLtp = existing && this._extractLtpFromQuote(existing) !== null;
        const hasNewLtp = this._extractLtpFromQuote(value) !== null;

        // Prefer the option chain quote when it has an LTP; otherwise keep the richer entry
        if (!existing || (hasNewLtp || !hasExistingLtp)) {
          merged.set(key, value);
        }
      });
    }
    return merged;
  }

  _hasAllQuotes(map, keys = [], requirePrice = false) {
    if (!keys || keys.length === 0) return true;
    if (!map || typeof map.get !== 'function') return false;
    return keys.every((k) => {
      const q = map.get(k);
      if (!q) return false;
      if (!requirePrice) return true;
      return this._extractLtpFromQuote(q) !== null;
    });
  }

  async _getOptionChainQuotesMap({
    instance,
    underlying,
    expiry,
    exchange,
    minStrikeCount = 5,
  }) {
    if (!instance || !instance.supports_option_chain) {
      return null;
    }

    const cacheKey = `${instance.id || 'INSTANCE'}|${(exchange || '').toUpperCase()}|${(underlying || '').toUpperCase()}|${expiry || ''}`;
    const cached = this.optionChainQuoteCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= this.optionChainQuoteTtlMs) {
      return cached.map;
    }

    try {
      const strikeCount = Math.max(parseIntSafe(minStrikeCount) || 0, 5);
      const chain = await openalgoClient.getOptionChain(
        instance,
        underlying,
        expiry,
        exchange,
        { strikeCount, skipBackoff: true }
      );

      const quotes = this._extractQuotesFromOptionChain(chain, exchange);
      const map = this._quotesArrayToMap(quotes, now);
      this.optionChainQuoteCache.set(cacheKey, { map, fetchedAt: now });
      return map;
    } catch (error) {
      log.warn('Option chain quote fetch failed; falling back to multiquotes', {
        instance_id: instance?.id,
        underlying,
        expiry,
        exchange,
        error: error?.message,
      });
      if (cached) {
        return cached.map;
      }
      return null;
    }
  }

  _extractQuotesFromOptionChain(chainData, exchange) {
    const rows = Array.isArray(chainData?.chain) ? chainData.chain : [];
    const quotes = [];

    for (const row of rows) {
      const strike = parseFloatSafe(row.strike, null);
      const ce = row.ce || row.CE;
      const pe = row.pe || row.PE;

      if (ce && ce.symbol) {
        quotes.push({
          exchange,
          symbol: ce.symbol || ce.trading_symbol || ce.tradingsymbol,
          strike,
          option_type: 'CE',
          ltp: this._extractLtpFromQuote(ce),
          changePercent: this._extractChangePercentFromQuote(ce),
        });
      }

      if (pe && pe.symbol) {
        quotes.push({
          exchange,
          symbol: pe.symbol || pe.trading_symbol || pe.tradingsymbol,
          strike,
          option_type: 'PE',
          ltp: this._extractLtpFromQuote(pe),
          changePercent: this._extractChangePercentFromQuote(pe),
        });
      }
    }

    return quotes;
  }

  _quotesArrayToMap(quotes = [], fetchedAt = Date.now()) {
    const map = new Map();
    for (const quote of quotes) {
      const key = this._buildQuoteMatchKey(quote.exchange, quote.symbol);
      if (!key) continue;
      map.set(key, { ...quote, fetchedAt });
    }
    return map;
  }

  async _getQuotesFromCache(instance, requests = []) {
    if (!Array.isArray(requests) || requests.length === 0) {
      return new Map();
    }

    const results = new Map();
    const missing = [];
    const snapshot = marketDataFeedService.getQuoteSnapshot(instance.id);

    for (const request of requests) {
      const key = this._buildQuoteMatchKey(request.exchange, request.symbol);
      if (!key) continue;

      const cachedQuote = this._findQuoteInSnapshot(snapshot, request.exchange, request.symbol);
      if (cachedQuote) {
        const withTimestamp = snapshot?.fetchedAt
          ? { ...cachedQuote, fetchedAt: snapshot.fetchedAt }
          : cachedQuote;
        results.set(key, withTimestamp);
      } else {
        missing.push({
          exchange: request.exchange,
          symbol: request.symbol,
        });
      }
    }

    if (missing.length > 0) {
      const liveQuotes = await openalgoClient.getQuotes(instance, missing);
      if (Array.isArray(liveQuotes)) {
        const fetchedAt = Date.now();
        const merged = Array.isArray(snapshot?.data) ? [...snapshot.data] : [];
        for (const quote of liveQuotes) {
          const key = this._buildQuoteMatchKey(
            quote.exchange || quote.exch,
            quote.symbol || quote.trading_symbol || quote.tradingsymbol
          );
          if (key) {
            const enriched = { ...quote, fetchedAt };
            results.set(key, enriched);
            merged.push(enriched);
          }
        }
        // Update cache so resolved futures/options become part of global polling
        marketDataFeedService.setQuoteSnapshot(instance.id, merged, { fetchedAt });
      }
    }

    return results;
  }

  async _getQuotesPreferWs(requests = []) {
    if (!Array.isArray(requests) || requests.length === 0) {
      return new Map();
    }

    const results = new Map();
    const now = Date.now();

    await Promise.all(requests.map(async (request) => {
      try {
        const res = await marketDataFeedService.fetchLtpForSymbol(
          request.exchange,
          request.symbol,
          { maxRounds: 1 }
        );
        if (!res) return;
        const quote = res.quote || {
          exchange: request.exchange,
          symbol: request.symbol,
          ltp: res.ltp,
        };
        if (!quote._source && res.source) {
          quote._source = res.source;
        }
        const key = this._buildQuoteMatchKey(
          quote.exchange || quote.exch || request.exchange,
          quote.symbol || quote.trading_symbol || quote.tradingsymbol || request.symbol
        );
        if (key) {
          const fetchedAt = quote.fetchedAt || now;
          results.set(key, { ...quote, fetchedAt });
        }
      } catch (_) {
        // best effort; fallback handled by callers
      }
    }));

    return results;
  }

  _findQuoteInSnapshot(snapshot, exchange, symbol) {
    if (!snapshot?.data || snapshot.data.length === 0) {
      return null;
    }

    const targetKey = this._buildQuoteMatchKey(exchange, symbol);
    if (!targetKey) {
      return null;
    }

    for (const quote of snapshot.data) {
      const candidateKey = this._buildQuoteMatchKey(
        quote.exchange || quote.exch,
        quote.symbol || quote.trading_symbol || quote.tradingsymbol
      );

      if (candidateKey && candidateKey === targetKey) {
        return quote;
      }
    }

    return null;
  }

  _buildQuoteMatchKey(exchange, symbol) {
    const normalizedSymbol = this._normalizeSymbolKey(symbol);
    if (!normalizedSymbol) {
      return null;
    }

    const normalizedExchange = this._normalizeExchange(exchange) || 'DEFAULT';
    return `${normalizedExchange}::${normalizedSymbol}`;
  }

  _shouldRepeatToTarget(currentPosition, targetPosition) {
    if (!Number.isFinite(currentPosition) || !Number.isFinite(targetPosition)) {
      return false;
    }
    if (currentPosition === 0) return false;
    if (targetPosition === 0) return true;
    if (Math.sign(currentPosition) !== Math.sign(targetPosition)) return true;
    return Math.abs(targetPosition) < Math.abs(currentPosition);
  }

  _isRepeatExitAction(action) {
    return ['REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE']
      .includes((action || '').toUpperCase());
  }

  _normalizeSymbolKey(symbol) {
    if (!symbol) return null;
    return String(symbol)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  _normalizeExchange(exchange) {
    if (!exchange) return null;
    return String(exchange).trim().toUpperCase();
  }

  _normalizeProduct(product) {
    if (!product) return null;
    return String(product).trim().toUpperCase();
  }

  _extractLtpFromQuote(quote) {
    if (!quote) return null;
    const candidates = [
      quote.ltp,
      quote.LTP,
      quote.last_price,
      quote.lastPrice,
      quote.last_traded_price,
      quote.lastTradedPrice,
      quote.close,
    ];

    for (const value of candidates) {
      const parsed = parseFloatSafe(value, null);
      if (parsed !== null && !Number.isNaN(parsed) && parsed !== 0) {
        return parsed;
      }
    }

    return null;
  }

  _extractChangePercentFromQuote(quote) {
    if (!quote) return null;
    const candidates = [
      quote.percent_change,
      quote.pchange,
      quote.change_percent,
      quote.change,
    ];

    for (const value of candidates) {
      const parsed = parseFloatSafe(value, null);
      if (parsed !== null && !Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  _resolveProductForOrder(product, tradeMode, symbol) {
    const normalizedProduct = this._normalizeProduct(product) || 'MIS';
    const trade = String(tradeMode || '').toUpperCase();
    const symbolType = String(symbol.symbol_type || '').toUpperCase();
    const exch = String(symbol.exchange || symbol.brexchange || '').toUpperCase();

    const isDerivativeTrade = trade === 'FUTURES' || trade === 'OPTIONS';
    const isDerivativeSymbol = symbolType === 'FUTURES' || symbolType === 'OPTIONS';
    const isDerivativeExchange = ['NFO', 'BFO', 'MCX'].includes(exch);

    if (isDerivativeTrade || isDerivativeSymbol || isDerivativeExchange) {
      return 'NRML';
    }

    return normalizedProduct;
  }

  /**
   * Normalize expiry input to YYYY-MM-DD
   * @private
   */
  _normalizeExpiryInput(expiry) {
    if (!expiry) return null;
    const trimmed = String(expiry).trim().toUpperCase();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(trimmed)) {
      const [day, monthStr, year] = trimmed.split('-');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const monthIndex = monthNames.indexOf(monthStr);
      if (monthIndex === -1) {
        throw new ValidationError(`Unknown expiry month: ${monthStr}`);
      }
      const paddedMonth = String(monthIndex + 1).padStart(2, '0');
      return `20${year}-${paddedMonth}-${day}`;
    }

    return trimmed;
  }

  /**
   * Determine option type (CE/PE) based on action keyword
   * @private
   */
  _getOptionTypeFromAction(action = '') {
    const ceActions = new Set([
      'BUY_CE', 'SELL_CE',
      'REDUCE_CE', 'INCREASE_CE',
      'CLOSE_ALL_CE',
    ]);

    const peActions = new Set([
      'BUY_PE', 'SELL_PE',
      'REDUCE_PE', 'INCREASE_PE',
      'CLOSE_ALL_PE',
    ]);

    if (ceActions.has(action)) return 'CE';
    if (peActions.has(action)) return 'PE';

    // EXIT_ALL should not rely on option type, default to CE for compatibility
    return 'CE';
  }
}

// Export singleton instance
export default new QuickOrderService();
export { QuickOrderService };
