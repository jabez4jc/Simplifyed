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
import marketDataInstanceService, { tradesSegment } from './market-data-instance.service.js';
import derivativeResolutionService from './derivative-resolution.service.js';
import orderPlacementService from './order-placement.service.js';
import orderPayloadFactory from './order-payload.factory.js';
import openalgoClient from '../integrations/openalgo/client.js';
import orderService from './order.service.js';
import quickOrderHistoryService from './quick-order-history.service.js';
import quickOrderQuotesService from './quick-order-quotes.service.js';
import telegramService from './telegram.service.js';
import limitPriceService from './limit-price.service.js';
import pnlSnapshotService from './pnl-snapshot.service.js';
import brokerCapabilitiesService from './broker-capabilities.service.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import { contractExpiry, isContractExpired, resolveOptionsUnderlyingKey } from '../utils/underlying.util.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import instrumentsService from './instruments.service.js';
import { toISTDate, toISTISOString } from '../utils/time.js';
import { isDerivativeExchange } from '../utils/broker-type.util.js';
import {
  getUnderlyingQuoteExchange,
  getUnderlyingQuoteSymbol,
  getUnderlyingForClosing,
  parseFuturesSymbol,
  getFuturesUnderlying,
  expiryMatchesSymbol,
  parseOptionSymbol,
  normalizeSymbolKey,
  normalizeExchange,
  normalizeProduct,
  normalizeExpiryInput,
  getOptionTypeFromAction,
} from '../utils/symbol-parsing.util.js';

class QuickOrderService {
  constructor() {
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

    // Only instances that trade this symbol's segment - a crypto broker asked for NIFTY's option
    // chain fails, and the preview then fell back to stale cached data.
    const row = await db.get('SELECT exchange FROM watchlist_symbols WHERE id = ?', [symbolId]);
    const pool = await marketDataInstanceService.getMarketDataPool(row?.exchange || null);
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

    const instance = await marketDataInstanceService.getRoundRobinInstance(row?.exchange || null);
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
      price = 0,
      expiry = null,  // User-selected expiry date
      optionsLeg = null,  // User-selected options leg (ITM2, ATM, OTM1, etc.)
      operatingMode = 'BUYER',  // Buyer or Writer mode for OPTIONS
      stepLots = 1,  // Step size in lots for OPTIONS
      contract = null, // { exchange, symbol } - trade THIS option contract, not a resolved strike
      triggerType = null,
      correlationId = null,
      requestId = null,
      userId = null,
      source = null,
    } = params;

    log.info('Placing quick order', {
      symbolId,
      instanceId,
      action,
      tradeMode,
      quantity,
      expiry,
      optionsLeg,
      operatingMode,
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

    if (isContractExpired(symbol)) {
      throw new ValidationError(`${symbol.exchange}:${symbol.symbol} expired on ${contractExpiry(symbol)} - it no longer exists at the broker`);
    }

    const contractRow = contract ? await this._validateOptionContract(symbol, contract, action, tradeMode) : null;

    // Get instances (single or all assigned)
    const instances = await this._getTargetInstances(instanceId, symbol.watchlist_id);
    const effectiveOrderType = await this._resolveBroadcastOrderType(instances);

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
        stepLots,
        contractRow,
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

      // Also called by the read-only /quickorders/targets preview, so this says nothing about
      // an order being sent.
      log.info('Resolved assigned target instances', { count: instances.length });
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

      // A symbol trades only on the instances mapped to its watchlist - naming another one
      // used to send the order anyway.
      const mapped = await db.get(
        'SELECT 1 FROM watchlist_instances WHERE watchlist_id = ? AND instance_id = ?',
        [watchlistId, instance.id]
      );
      if (!mapped) {
        throw new ValidationError(`Instance "${instance.name}" is not mapped to this watchlist`);
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

  async _resolveOrderTypeForInstance(instance) {
    const supportsMarketOrders = await brokerCapabilitiesService.supportsMarketOrders(instance?.broker);
    return supportsMarketOrders ? 'MARKET' : 'LIMIT';
  }

  async _resolveBroadcastOrderType(instances) {
    if (!Array.isArray(instances) || instances.length === 0) {
      return 'LIMIT';
    }

    const supportFlags = await Promise.all(
      instances.map((instance) => brokerCapabilitiesService.supportsMarketOrders(instance?.broker))
    );

    if (supportFlags.every(Boolean)) return 'MARKET';
    if (supportFlags.some(Boolean)) return 'MIXED';
    return 'LIMIT';
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

    // For OPTIONS strategy, resolve option symbol ONCE using a market data instance
    let preResolvedOptionSymbol = null;
    if (strategy === 'OPTIONS_WITH_RECONCILIATION') {
      const marketDataInstance = await this._getMarketDataInstance(instances, symbol.exchange);
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
        // Only definite failures are retried. An uncertain one (timeout, 5xx, outcome unknown)
        // may have closed the position already; with the book lagging the fill, a re-sent
        // exit sells again and leaves a short (seen live on Fyers and Kotak).
        const failedInstances = instances.filter(inst =>
          results.find(r => r.instance_id === inst.id && !r.success && !r.uncertain)
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

  // Cancels only the open orders for THIS close's own contract. cancelAllOrders is account-wide
  // at the broker (the `strategy` param is a label only), so calling it here used to cancel every
  // resting order on the account - including protective SL stops on unrelated symbols - whenever
  // one close/exit retry ran. A contract row (set for a named-contract CLOSE) takes priority over
  // the watchlist row's own symbol/exchange, which may describe an underlying rather than the
  // actual traded leg.
  async _cancelAllOrdersForRetry(instance, symbol, orderParams) {
    if (!instance?.id) return;
    const targetSymbolRaw = orderParams?.contractRow?.symbol || symbol?.symbol;
    const targetExchangeRaw = orderParams?.contractRow?.exchange || symbol?.exchange;
    if (!targetSymbolRaw || !targetExchangeRaw) return;

    const targetSymbol = this._normalizeSymbolKey(targetSymbolRaw);
    const targetExchange = this._normalizeExchange(targetExchangeRaw);
    const targetProduct = this._normalizeProduct(orderParams?.product);
    const openStatuses = new Set(['open', 'pending', 'trigger pending', 'trigger_pending', 'partial', 'partially filled', 'partially_filled']);

    const snapshot = await marketDataFeedService.getOrderbookSnapshot(instance.id, { force: true });
    const raw = snapshot?.data || [];
    const orders = Array.isArray(raw) ? raw : raw.orders || raw.data || [];
    const strategyTag = orderParams?.strategy || symbol?.watchlist_name || 'default';

    for (const order of orders) {
      const orderSymbol = this._normalizeSymbolKey(order.symbol || order.tradingsymbol || order.trading_symbol);
      const orderExchange = this._normalizeExchange(order.exchange || order.exch || order.brexchange);
      if (orderSymbol !== targetSymbol || orderExchange !== targetExchange) continue;
      if (targetProduct) {
        const orderProduct = this._normalizeProduct(order.product || order.producttype);
        if (orderProduct && orderProduct !== targetProduct) continue;
      }
      const status = (order.order_status || order.status || '').toString().toLowerCase();
      if (!openStatuses.has(status)) continue;
      const id = order.orderid || order.order_id || order.id;
      if (!id) continue;
      try {
        await openalgoClient.cancelOrder(instance, id, strategyTag);
      } catch (error) {
        log.warn('Failed to cancel open order before close/exit retry', {
          instance_id: instance.id,
          order_id: id,
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
        // A perpetual (BTCUSDFUT) has no expiry: the row IS the contract, whatever was sent.
        const matchesWatchlistExpiry = symbol.symbol_type === 'FUTURES'
          && (!contractExpiry(symbol) || this._expiryMatchesSymbol(expiry, symbol));

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

    // Final product enforcement (force NRML for any derivative/futures trade). An EQUITY trade
    // keeps the chosen product: labelling it FUTURES here sent every watchlist stock order as
    // NRML, which NSE/BSE reject for the equity segment.
    const finalProduct = this._resolveProductForOrder(product, tradeMode, {
      symbol_type: tradeMode === 'EQUITY' ? (symbol.symbol_type || 'EQUITY') : 'FUTURES',
      exchange: finalExchange,
    });

    const orderType = await this._resolveOrderTypeForInstance(instance);
    const { pricetype: effectiveOrderType, price: orderPrice } = orderType === 'LIMIT'
      ? await limitPriceService.resolveMarketablePricing({
        instanceId: instance?.id,
        exchange: finalExchange,
        symbol: finalSymbol,
        side: algoAction,
        bufferPoints: symbol.limit_buffer_points || 0,
        tickSize: resolvedTickSize,
      })
      : { pricetype: orderType, price: 0 };

    const orderPayload = orderPayloadFactory.buildEquityOrder({
      strategy: symbol.watchlist_name || 'default',
      exchange: finalExchange,
      symbol: finalSymbol,
      action: algoAction,
      quantity: orderQuantity,
      position_size: targetPosition,
      product: finalProduct,
      pricetype: effectiveOrderType,
      price: orderPrice,
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
      order_type: effectiveOrderType,
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
      // null, not the verified position: verifyPosition() above is deliberately fire-and-forget
      // so it cannot block the response, and its `finalPosition` is scoped to that closure.
      // Referencing it here threw ReferenceError and failed the whole order *after* it had been
      // sent to the broker. The sibling options path already returns null here for the same
      // reason; no consumer reads this field.
      final_position: null,
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
      stepLots = 1,
      triggerType,
      correlationId,
      requestId,
      userId,
      source,
    } = orderParams;
    const { preloadedPositions } = options;
    const bufferPoints = Number.isFinite(symbol.limit_buffer_points) ? symbol.limit_buffer_points : 0;
    const orderType = await this._resolveOrderTypeForInstance(instance);
    const instanceMultiplier = Math.min(
      Math.max(parseIntSafe(instance.multiplier, 1), 1),
      999
    );

    // Get writer guard from symbol configuration (optional)
    const writerGuard = symbol.writer_guard_enabled !== 0;  // Default true

    log.info('Executing options order with Buyer/Writer mode', {
      action,
      operatingMode,
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
    // A named contract pins every action to that one leg - no fanning out across strikes.
    const legPinned = Boolean(orderParams.contractRow);
    const shouldSkipPreResolution = isReduceAction && !legPinned;

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
        shouldSkipPreResolution,
        instance_id: instance.id,
      });
      const resolution = await this._resolveOptionSymbolForInstance(instance, symbol, orderParams);
      optionSymbol = resolution.optionSymbol;
      expiry = resolution.expiry;
      underlying = resolution.underlying;
      strike = optionSymbol.targetStrike || optionSymbol.strike;
    }

    // Determine the correct derivatives exchange
    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(symbol.exchange);
    let finalProduct = this._resolveProductForOrder(
      product,
      'OPTIONS',
      { symbol_type: 'OPTIONS', exchange: derivativeExchange }
    );

    // Determine scope: TYPE-level or LEG-level position calculation
    // reduce/close actions → TYPE scope (aggregate across strikes)
    // add actions → LEG scope (single strike)
    const isReduceOrClose = [
      'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE',
      'CLOSE_ALL_CE', 'CLOSE_ALL_PE', 'EXIT_ALL'
    ].includes(action);
    const useTypeScope = isReduceOrClose && !legPinned;

    // For REDUCE/INCREASE in FLOAT_OFS mode, handle each open position separately
    if (isReduceOrClose && !legPinned) {
      log.info('REDUCE/INCREASE: Handling each open position separately', {
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
            // REDUCE/INCREASE adjusts an EXISTING position, so it trades in that position's
            // product - an MIS position reduced "as NRML" would open an opposite NRML position.
            product: this._normalizeProduct(position.product) || null,
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

      // Fast path: duplicate rows for the same strike AND product collapse into one order. An
      // MIS row and an NRML row of the same strike are separate positions at the broker, so each
      // keeps its own order in its own product.
      const uniqueSymbols = new Set(ordersToPlace.map(o => `${o.symbol}|${o.product || ''}`));
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

      const orderType = await this._resolveOrderTypeForInstance(instance);
      const orderPromises = ordersToPlace.map(async order => {
        const floatProduct = order.product || this._resolveProductForOrder(
          product,
          'OPTIONS',
          { symbol_type: 'OPTIONS', exchange: derivativeExchange }
        );

        // Capture fallback entry price per strike (best effort)
        this._captureFallbackEntryPrice(instance, derivativeExchange, order.symbol).catch(() => {});

        const { pricetype: effectiveOrderType, price: orderPrice } = orderType === 'LIMIT'
          ? await limitPriceService.resolveMarketablePricing({
            instanceId: instance?.id,
            exchange: derivativeExchange,
            symbol: order.symbol,
            side: order.action,
            bufferPoints,
            tickSize: optionSymbol?.tick_size || symbol.tick_size,
          })
          : { pricetype: orderType, price: 0 };

        const orderDataToSend = orderPayloadFactory.buildOptionsOrder({
          strategy: symbol.watchlist_name || 'default',
          exchange: derivativeExchange,
          symbol: order.symbol,
          action: order.action,
          quantity: order.quantity,
          position_size: order.position_size,
          product: floatProduct,
          pricetype: effectiveOrderType,
          price: orderPrice,
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
          order_type: effectiveOrderType,
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
        position_count: allOpenPositions.length,
        orders_placed: orderResults.length,
      };
    }

    // For all other cases (BUY/SELL actions, CLOSE_ALL), use legacy logic
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
      // Reducing or closing acts on the position that EXISTS. If it is held in the other
      // product (an NRML position with MIS selected), trade it in its own product - otherwise
      // the lookup finds nothing and the close reports "no change needed" while it stays open.
      if (isReduceOrClose && currentPosition === 0) {
        const held = (await this._getPositionBook(instance)).filter((p) =>
          this._normalizeSymbolKey(p.symbol || p.tradingsymbol) === this._normalizeSymbolKey(optionSymbol.symbol)
          && (parseIntSafe(p.quantity) || parseIntSafe(p.netqty) || 0) !== 0);
        if (held.length === 1) {
          finalProduct = this._normalizeProduct(held[0].product || held[0].producttype) || finalProduct;
          currentPosition = parseIntSafe(held[0].quantity) || parseIntSafe(held[0].netqty) || 0;
        }
      }
      log.info('Using LEG-scoped position', {
        symbol: optionSymbol.symbol,
        currentPosition,
        product: finalProduct,
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
    const { pricetype: effectiveOrderType, price: orderPrice } = orderType === 'LIMIT'
      ? await limitPriceService.resolveMarketablePricing({
        instanceId: instance?.id,
        exchange: derivativeExchange,
        symbol: optionSymbol.symbol,
        side: algoAction,
        bufferPoints,
        tickSize: optionSymbol.tick_size || symbol.tick_size,
      })
      : { pricetype: orderType, price: 0 };

    const orderDataToSend = orderPayloadFactory.buildOptionsOrder({
      strategy: symbol.watchlist_name || 'default',
      exchange: derivativeExchange,
      symbol: optionSymbol.symbol,
      action: algoAction,
      quantity,
      position_size: targetPosition,
      product: finalProduct,
      pricetype: effectiveOrderType,
      price: orderPrice,
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
      order_type: effectiveOrderType,
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

    // Verify final position post-trade (fire-and-forget to avoid blocking the response - this
    // is a live forceLive position-book round trip whose only purpose is a mismatch warning log,
    // same pattern already used in the futures/equity order path above).
    const verifyFinalOptionsPosition = async () => {
      try {
        const finalPosition = useTypeScope
          ? await this._getAggregatedTypePosition(instance, underlying, expiry, optionType, finalProduct)
          : await this._getCurrentPositionSize(
              instance,
              optionSymbol.symbol,
              derivativeExchange,
              finalProduct,
              { forceLive: true, failOnError: true }
            );
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
    };
    verifyFinalOptionsPosition().catch(() => {});

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
      current_position: currentPosition,
      target_position: targetPosition,
      // No longer available synchronously - verifyFinalOptionsPosition() above now runs
      // fire-and-forget so this call doesn't wait on an extra live position-book round trip.
      final_position: null,
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
    const orderType = await this._resolveOrderTypeForInstance(instance);

    let underlying = this._getUnderlyingForClosing(symbol);

    let positionsToClose = [];

    const closeAllTypeMap = {
      CLOSE_ALL_CE: 'CE',
      CLOSE_ALL_PE: 'PE',
    };

    if (closeAllTypeMap[action] && tradeMode === 'OPTIONS' && orderParams.contractRow) {
      // CLOSE on a named contract closes that contract - every product it is held in.
      const c = orderParams.contractRow;
      positionsToClose = await this._getOpenPositionsForSymbol(instance, c.symbol, c.exchange, null);
    } else if (closeAllTypeMap[action] && tradeMode === 'OPTIONS') {
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

      // The row is itself the futures contract to close: a perpetual (no expiry - BTCUSDFUT
      // used to be "resolved" to a dated BTC future that does not exist, so it could be bought
      // but never exited), or a dated future when no other expiry was asked for.
      const rowIsTheContract = tradeMode === 'FUTURES'
        && (symbol.symbol_type === 'FUTURES' || /FUT$/i.test(symbol.symbol || ''))
        && (!contractExpiry(symbol) || !userExpiry || this._expiryMatchesSymbol(userExpiry, symbol));

      if (rowIsTheContract) {
        targetSymbol = symbol.symbol;
        targetExchange = symbol.exchange;
      } else if (tradeMode === 'FUTURES') {
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
            instance,
            { kind: 'FUTURES' }
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

      // Every product: a manual EXIT closes the symbol. Filtered by the requested product, an EXIT
      // sent as NRML found no MIS position and reported "No open positions to close". A risk exit
      // (onlyProduct) was triggered by one product row, so it closes that row only.
      const positions = await this._getOpenPositionsForSymbol(
        instance,
        targetSymbol,
        targetExchange,
        orderParams.onlyProduct ? product : null
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
        const { pricetype: effectiveOrderType, price: orderPrice } = orderType === 'LIMIT'
          ? await limitPriceService.resolveMarketablePricing({
            instanceId: instance?.id,
            exchange: position.exchange,
            symbol: position.symbol,
            side: closeAction,
            bufferPoints,
            tickSize: symbol.tick_size,
            bypassSpreadCheck: true,
            forceLtp: true,
          })
          : { pricetype: orderType, price: 0 };

        // Close in the position's own product - brokers track MIS and NRML separately, so a
        // close in the other product would open an opposite position instead of flattening.
        const closeProduct = this._normalizeProduct(position.product) || product;
        const orderPayload = orderPayloadFactory.buildExitOrder({
          strategy: strategyTag,
          exchange: position.exchange,
          symbol: position.symbol,
          action: closeAction,
          quantity: closeQuantity,
          product: closeProduct,
          pricetype: effectiveOrderType,
          price: orderPrice,
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
          product: closeProduct,
          order_type: effectiveOrderType,
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
          statusCode: error.statusCode,
        });
      }
    }

    this._invalidateInstanceCaches(instance.id);

    // A close that failed is a failed exit. It used to come back as "Closed 0 position(s)" with
    // the caller reporting success - the UI showed the exit done, a strategy leg was marked
    // closed, and auto-exit stood down for its cooldown while the position stayed open.
    const failures = closeResults.filter((r) => !r.success);
    if (failures.length > 0) {
      const err = new Error(
        `Could not close ${failures.length} of ${closeResults.length} position(s): `
        + failures.map((f) => `${f.symbol}: ${f.error}`).join('; ')
      );
      // A failure with no HTTP status (timeout, network) or a 5xx may have closed the position:
      // it stays uncertain (5xx) so nothing re-sends the exit blind.
      const unknown = failures.find((f) => !Number.isFinite(f.statusCode) || f.statusCode >= 500);
      err.statusCode = unknown ? (unknown.statusCode >= 500 ? unknown.statusCode : 504) : failures[0].statusCode;
      err.details = closeResults;
      throw err;
    }

    return {
      message: `Closed ${closeResults.length} position(s)`,
      closed_count: closeResults.length,
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
   * Get cached position book for an instance (fallback to OpenAlgo if cache missing)
   * @private
   */
  async _getPositionBook(instance) {
    // Always prefer live fetch per requirement; cache only as fallback for failures if needed later
    const positionBook = await openalgoClient.getPositionBook(instance);
    marketDataFeedService.setPositionSnapshot(instance.id, positionBook);
    return positionBook;
  }

  async _resolveLotSize(symbol, exchange, fallbackLotSize) {
    const fallback = fallbackLotSize && fallbackLotSize > 0 ? fallbackLotSize : 1;
    try {
      const instrument = await instrumentsService.getInstrument(symbol, exchange);
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
      // Risk exits (auto-exit, exit levels) act on ONE product row; a manual EXIT closes the symbol.
      onlyProduct: params.onlyProduct === true,
    };

    return this._closePositions(instance, symbolPayload, orderParams);
  }

  /**
   * Exit PART of one position row: `exitQty` units out of a signed `position.quantity`, in the
   * row's own product, leaving the rest open. Priced like every exit (LIMIT on Indian exchanges,
   * off the market; MARKET where the broker allows it). Sent ONCE - no repeat-until-target: a
   * position-targeted retry against a lagging position book has sold twice before (Fyers).
   * @param {Object} instance
   * @param {{ symbol: string, exchange: string, product: string, quantity: number }} position
   * @param {number} exitQty units to exit (> 0)
   * @returns {Promise<{ order_id: string|null, status: string }>}
   */
  async exitPartOfPosition(instance, position, exitQty, { strategy = 'EXIT_LEVEL' } = {}) {
    const held = Number(position.quantity) || 0;
    const qty = Math.min(Math.abs(held), Math.abs(Number(exitQty) || 0));
    if (!held || !qty) throw new ValidationError(`Nothing to exit on ${position.symbol}`);
    const action = held > 0 ? 'SELL' : 'BUY';
    const remaining = Math.sign(held) * (Math.abs(held) - qty);
    const orderType = await this._resolveOrderTypeForInstance(instance);
    const { pricetype, price } = orderType === 'LIMIT'
      ? await limitPriceService.resolveMarketablePricing({
        instanceId: instance?.id,
        exchange: position.exchange,
        symbol: position.symbol,
        side: action,
        bufferPoints: 0,
        bypassSpreadCheck: true,
        forceLtp: true,
      })
      : { pricetype: orderType, price: 0 };
    const payload = orderPayloadFactory.buildExitOrder({
      strategy,
      exchange: position.exchange,
      symbol: position.symbol,
      action,
      quantity: qty,
      position_size: remaining,
      product: this._normalizeProduct(position.product) || 'MIS',
      pricetype,
      price,
    });
    const result = await orderPlacementService.placeSmartOrder(instance, payload, {
      request_type: 'EXIT_POSITION',
      closing_symbol: position.symbol,
      strategy,
      repeatUntilClosed: false,
      ignoreSlippage: true,
    });
    return { order_id: result?.orderid || null, status: result?.status || 'unknown' };
  }

  /**
   * Close every open position on an instance, one symbol at a time through the exit path
   * above: LIMIT orders on Indian exchanges (SEBI), priced from depth and chased until filled.
   * OpenAlgo's own closeposition squares off at MARKET, so this app never calls it.
   * Used by Close All, the switch to analyzer mode and the kill switch.
   * @returns {Promise<{closed: number, errors: string[], stillOpen: string[]}>}
   */
  async closeAllPositions(instance, { strategy = 'CLOSE_ALL' } = {}) {
    const quantityOf = (p) => Number(p.quantity ?? p.netqty ?? p.net_quantity ?? p.netQty ?? 0) || 0;
    const openPositions = async () => (await openalgoClient.getPositionBook(instance) || [])
      .filter((p) => quantityOf(p) !== 0);

    const result = { closed: 0, errors: [], stillOpen: [] };
    const seen = new Set();
    for (const position of await openPositions()) {
      const symbol = position.symbol || position.tradingsymbol || position.trading_symbol;
      const exchange = position.exchange || position.exch;
      const key = `${exchange}:${symbol}`;
      if (seen.has(key)) continue; // one exit closes every product row of the symbol
      seen.add(key);
      try {
        // tradeMode EQUITY = close this exact symbol, with no underlying/expiry resolution.
        const closed = await this.closePosition(instance, { symbol, exchange }, { tradeMode: 'EQUITY', strategy });
        result.closed += closed?.closed_count || 0;
      } catch (error) {
        result.errors.push(`${symbol}: ${error.message}`);
      }
    }
    result.stillOpen = (await openPositions())
      .map((p) => `${p.symbol || p.tradingsymbol} ${quantityOf(p)}`);
    return result;
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
      // Never "nothing open": an exit that cannot read the book must fail, not report success.
      log.error('Failed to get options positions', error);
      throw error;
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
      // Never "nothing open": an exit that cannot read the book must fail, not report success.
      log.error('Failed to get positions for symbol', error);
      throw error;
    }
  }

  // Delegated to quick-order-quotes.service.js (LTP/quote fetch+cache cluster, owns its own
  // optionChainQuoteCache) - names/signatures kept identical so every existing internal call
  // site keeps working unmodified.
  async _getUnderlyingLTPWithFallback(instance, underlying, exchange) {
    return quickOrderQuotesService.getUnderlyingLTPWithFallback(instance, underlying, exchange);
  }

  async _getUnderlyingLTP(instance, underlying, exchange) {
    return quickOrderQuotesService.getUnderlyingLTP(instance, underlying, exchange);
  }

  /**
   * Record quick order in database
   * @private
   */
  // Delegated to quick-order-history.service.js (pure DB CRUD + summary-formatting helpers, no
  // shared state with the rest of this class) - names/signatures kept identical so every
  // existing internal and external call site keeps working unmodified.
  async _recordQuickOrder(orderData) {
    return quickOrderHistoryService.recordQuickOrder(orderData);
  }


  async _recordFailedQuickOrder(params) {
    return quickOrderHistoryService.recordFailedQuickOrder(params);
  }

  _deriveSideForSummary(action = '') {
    return quickOrderHistoryService.deriveSideForSummary(action);
  }

  _pickSummaryInstrument(results, fallbackSymbol, fallbackExchange) {
    return quickOrderHistoryService.pickSummaryInstrument(results, fallbackSymbol, fallbackExchange);
  }

  async getQuickOrders(filters = {}) {
    return quickOrderHistoryService.getQuickOrders(filters);
  }

  async syncQuickOrdersForInstance(instanceId, options = {}) {
    return quickOrderHistoryService.syncQuickOrdersForInstance(instanceId, options);
  }

  async getQuickOrderById(id) {
    return quickOrderHistoryService.getQuickOrderById(id);
  }

  async getQuickOrderStats(filters = {}) {
    return quickOrderHistoryService.getQuickOrderStats(filters);
  }

  // Delegated to utils/symbol-parsing.util.js (pure functions, no shared state) - names/
  // signatures kept identical so every existing internal call site keeps working unmodified.
  // MCX note: _getUnderlyingQuoteSymbol's MCX branch is load-bearing for the MCX options
  // workaround - see the doc comment on the util module before touching it.
  _getUnderlyingQuoteExchange(symbol = {}) {
    return getUnderlyingQuoteExchange(symbol);
  }

  _getUnderlyingQuoteSymbol(symbol = {}) {
    return getUnderlyingQuoteSymbol(symbol);
  }

  _getUnderlyingForClosing(symbol = {}) {
    return getUnderlyingForClosing(symbol);
  }

  _parseFuturesSymbol(symbolStr) {
    return parseFuturesSymbol(symbolStr);
  }

  _getFuturesUnderlying(symbol = {}) {
    return getFuturesUnderlying(symbol);
  }


  _expiryMatchesSymbol(expiry, symbol = {}) {
    return expiryMatchesSymbol(expiry, symbol);
  }

  /**
   * Get market data instance from list of instances
   * Uses round-robin across enabled market data instances
   * @private
   */
  /** A market-data instance that trades `exchange`'s segment (see getMarketDataPool). */
  async _getMarketDataInstance(instances, exchange = null) {
    const rr = await marketDataInstanceService.getRoundRobinInstance(exchange);
    if (rr) {
      log.debug('Using round-robin market data instance', {
        instance_id: rr.id,
        name: rr.name,
      });
      return rr;
    }
    // Fallback: the order's own instances, again only those that trade this segment
    const usable = (instances || []).filter((inst) => !exchange || tradesSegment(inst, exchange));
    if (usable.length > 0) {
      log.warn('Round-robin market data pool empty, using fallback instance list', {
        instance_id: usable[0].id,
        name: usable[0].name,
      });
      return usable[0];
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
   * A contract named by the caller (the chart's CE/PE pane) must be a live option of THIS row's
   * underlying, of the type the action trades - never trust the client with an arbitrary symbol.
   * @returns {Promise<Object>} the instruments row
   * @private
   */
  async _validateOptionContract(symbol, contract, action, tradeMode) {
    if (tradeMode !== 'OPTIONS') throw new ValidationError('A named contract is only accepted for OPTIONS orders');
    const exchange = String(contract?.exchange || '').trim().toUpperCase();
    const name = String(contract?.symbol || '').trim().toUpperCase();
    if (!exchange || !name) throw new ValidationError('contract needs exchange and symbol');
    const row = await db.get(
      "SELECT * FROM instruments WHERE UPPER(exchange) = ? AND UPPER(symbol) = ? AND instrumenttype IN ('CE','PE') LIMIT 1",
      [exchange, name]
    );
    if (!row) throw new ValidationError(`${exchange}:${name} is not a known option contract`);
    const key = await resolveOptionsUnderlyingKey(symbol);
    if (!key || String(row.underlying_key || '').toUpperCase() !== String(key).toUpperCase()) {
      throw new ValidationError(`${name} is not an option on ${symbol.symbol}`);
    }
    const wantType = this._getOptionTypeFromAction(action);
    if (wantType && row.instrumenttype !== wantType) {
      throw new ValidationError(`${action} trades ${wantType}, but ${name} is a ${row.instrumenttype}`);
    }
    if (isContractExpired(row)) throw new ValidationError(`${name} has expired`);
    return row;
  }

  /**
   * Resolve option symbol for a single instance
   * @private
   */
  async _resolveOptionSymbolForInstance(instance, symbol, orderParams) {
    const { action, expiry: userExpiry, optionsLeg: userOptionsLeg } = orderParams;

    // A named contract (the chart's displayed one) is used as-is on every instance.
    if (orderParams.contractRow) {
      const c = orderParams.contractRow;
      return {
        underlying: derivativeResolutionService.getDerivativeUnderlying(symbol),
        expiry: this._normalizeExpiryInput(c.expiry),
        optionSymbol: {
          symbol: c.symbol, trading_symbol: c.symbol, strike: c.strike, targetStrike: c.strike,
          option_type: c.instrumenttype, lot_size: c.lotsize || 1, tick_size: c.tick_size || 0.05,
          exchange: c.exchange, token: c.token || null,
        },
      };
    }
    const optionType = this._getOptionTypeFromAction(action);

    // Use the shared, normalized underlying derivation (strips embedded date/strike/CE/PE/FUT
    // suffixes) rather than a raw underlying_symbol||symbol fallback - watchlist rows for
    // commodity/futures contracts often have underlying_symbol populated with the full contract
    // identifier rather than the plain name, which would otherwise break expiry/option-chain
    // lookups (this is what "MCX options not resolving" traced back to).
    const underlying = derivativeResolutionService.getDerivativeUnderlying(symbol);
    const derivativeExchange = derivativeResolutionService.getDerivativeExchange(symbol.exchange);
    const baseExchange = this._getUnderlyingQuoteExchange(symbol);
    const quoteSymbol = this._getUnderlyingQuoteSymbol(symbol);

    const strikeOffset = userOptionsLeg || symbol.options_strike_selection || 'ATM';
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

    // Not cached: the strike follows the live LTP, so a stale entry trades the wrong strike (H10).
    return { underlying, expiry, optionSymbol };
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
        marketDataInstance
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
    // A watchlist symbol that's already itself the tradable contract (a dated future
    // added directly, or a non-expiring instrument like a crypto perpetual) has no
    // separate expiry-dated series to resolve - trade the anchor symbol as-is unless the
    // user picked a different expiry.
    const isDirectContract = symbol.symbol_type === 'FUTURES' && (!symbol.expiry || !normalizedExpiry);
    if (!normalizedExpiry && !isDirectContract) {
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
        { kind: 'FUTURES' }
      )
      : normalizedExpiry;

    let futuresResolution;
    const matchesWatchlistExpiry = symbol.symbol_type === 'FUTURES'
      && (isDirectContract || this._expiryMatchesSymbol(chosenExpiry, symbol));

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
      // Writer action: buy back part of a SHORT. It has nothing to do on a long - the old
      // min(0, current + Qstep) turned a long of +65 into a target of 0 and squared it off.
      if (current >= 0) return current;
      const target = current + Qstep;  // Less negative (reduce short)
      return writerGuard ? Math.min(0, target) : target;  // Clamp at 0 if guard enabled
    }

    // Buyer actions (long premium)
    if (action === 'BUY_CE' || action === 'BUY_PE') {
      return current + Qstep;  // Add longs
    }

    if (action === 'REDUCE_CE' || action === 'REDUCE_PE') {
      // Buyer action: sell part of a LONG. Nothing to do on a short - max(0, current - Qstep)
      // would have turned a short of -65 into 0 and squared it off.
      if (current <= 0) return current;
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
      // Never "nothing open": a reduce/close that cannot read the book must fail, not no-op.
      log.warn('Failed to get open positions from positionbook', error);
      throw error;
    }
  }

  _parseOptionSymbol(symbol) {
    return parseOptionSymbol(symbol);
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

  // Delegated to quick-order-quotes.service.js - names/signatures kept identical so every
  // existing internal call site keeps working unmodified.
  _mergeQuoteMaps(primary, secondary) {
    return quickOrderQuotesService.mergeQuoteMaps(primary, secondary);
  }

  _hasAllQuotes(map, keys = [], requirePrice = false) {
    return quickOrderQuotesService.hasAllQuotes(map, keys, requirePrice);
  }

  async _getOptionChainQuotesMap(params) {
    return quickOrderQuotesService.getOptionChainQuotesMap(params);
  }


  _quotesArrayToMap(quotes = [], fetchedAt = Date.now()) {
    return quickOrderQuotesService.quotesArrayToMap(quotes, fetchedAt);
  }

  async _getQuotesFromCache(instance, requests = []) {
    return quickOrderQuotesService.getQuotesFromCache(instance, requests);
  }

  async _getQuotesPreferWs(requests = []) {
    return quickOrderQuotesService.getQuotesPreferWs(requests);
  }

  _findQuoteInSnapshot(snapshot, exchange, symbol) {
    return quickOrderQuotesService.findQuoteInSnapshot(snapshot, exchange, symbol);
  }

  _buildQuoteMatchKey(exchange, symbol) {
    return quickOrderQuotesService.buildQuoteMatchKey(exchange, symbol);
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
    return normalizeSymbolKey(symbol);
  }

  _normalizeExchange(exchange) {
    return normalizeExchange(exchange);
  }

  _normalizeProduct(product) {
    return normalizeProduct(product);
  }

  _extractLtpFromQuote(quote) {
    return quickOrderQuotesService.extractLtpFromQuote(quote);
  }

  _extractChangePercentFromQuote(quote) {
    return quickOrderQuotesService.extractChangePercentFromQuote(quote);
  }

  _resolveProductForOrder(product, tradeMode, symbol) {
    const normalizedProduct = this._normalizeProduct(product) || 'MIS';
    const trade = String(tradeMode || '').toUpperCase();
    const symbolType = String(symbol.symbol_type || '').toUpperCase();
    const exch = String(symbol.exchange || symbol.brexchange || '').toUpperCase();

    const isDerivativeTrade = trade === 'FUTURES' || trade === 'OPTIONS';
    const isDerivativeSymbol = symbolType === 'FUTURES' || symbolType === 'OPTIONS';

    // F&O takes MIS (intraday) or NRML (carry-forward) - the operator's choice is kept. Only CNC,
    // which is delivery and does not exist for derivatives, becomes NRML. Every F&O order used to
    // be forced to NRML, overriding an MIS choice (and its intraday margin and auto square-off).
    if (isDerivativeTrade || isDerivativeSymbol || isDerivativeExchange(exch)) {
      return normalizedProduct === 'MIS' ? 'MIS' : 'NRML';
    }

    return normalizedProduct;
  }

  _normalizeExpiryInput(expiry) {
    return normalizeExpiryInput(expiry);
  }

  _getOptionTypeFromAction(action = '') {
    return getOptionTypeFromAction(action);
  }
}

// Export singleton instance
export default new QuickOrderService();
