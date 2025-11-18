/**
 * Quick Order Service
 * Handles direct trading from watchlist with position-aware order placement
 * Supports EQUITY, FUTURES, and OPTIONS trade modes
 */

import { log } from '../core/logger.js';
import db from '../core/database.js';
import openalgoClient from '../integrations/openalgo/client.js';
import optionsResolutionService from './options-resolution.service.js';
import expiryManagementService from './expiry-management.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';

const NSE_INDEX_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
const BSE_INDEX_UNDERLYINGS = new Set(['SENSEX', 'BANKEX']);

class QuickOrderService {
  constructor() {
    this.symbolResolutionCache = new Map();
    this.symbolResolutionCacheTtl = 60 * 1000;
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
      strikePolicy,
      stepLots,
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

    // Determine order strategy based on action
    const strategy = this._determineOrderStrategy(action, tradeMode);

    // Execute order based on strategy
    const results = await this._executeOrderStrategy(
      strategy,
      symbol,
      instances,
      { action, tradeMode, quantity, product, orderType, price, expiry, optionsLeg, operatingMode, strikePolicy, stepLots }
    );

    log.info('Quick order completed', {
      symbolId,
      action,
      tradeMode,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });

    return {
      success: results.every(r => r.success),
      results,
      summary: {
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      },
    };
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
      'BUY', 'SELL', 'EXIT',  // Direct/Futures actions
      'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL',  // Existing options actions
      'REDUCE_CE', 'REDUCE_PE',  // Buyer mode: reduce longs
      'INCREASE_CE', 'INCREASE_PE',  // Writer mode: cover shorts
      'CLOSE_ALL_CE', 'CLOSE_ALL_PE'  // Type-specific close
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
         WHERE wi.watchlist_id = ? AND i.is_active = 1 AND i.order_placement_enabled = 1`,
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

      // Allow order placement even in analyzer mode
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
    if (action === 'BUY' || action === 'SELL') {
      return 'DIRECT_ORDER';
    }

    throw new ValidationError(`Unsupported action/tradeMode combination: ${action}/${tradeMode}`);
  }

  /**
   * Execute order strategy
   * @private
   */
  async _executeOrderStrategy(strategy, symbol, instances, orderParams) {
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

    const perInstanceTasks = instances.map(async (instance) => {
      try {
        let result;

        switch (strategy) {
          case 'DIRECT_ORDER':
            result = await this._executeDirectOrder(instance, symbol, orderParams);
            break;

          case 'OPTIONS_WITH_RECONCILIATION':
            result = await this._executeOptionsOrder(
              instance,
              symbol,
              orderParams,
              preResolvedOptionSymbol
            );
            break;

          case 'CLOSE_POSITIONS':
            result = await this._closePositions(instance, symbol, orderParams);
            break;

          default:
            throw new ValidationError(`Unknown strategy: ${strategy}`);
        }

        return {
          success: true,
          instance_id: instance.id,
          instance_name: instance.name,
          ...result,
        };
      } catch (error) {
        log.error('Failed to execute order on instance', error, {
          instance_id: instance.id,
          symbol_id: symbol.id,
        });

        return {
          success: false,
          instance_id: instance.id,
          instance_name: instance.name,
          error: error.message,
        };
      }
    });

    return Promise.all(perInstanceTasks);
  }

  /**
   * Execute direct order (EQUITY/FUTURES BUY/SELL)
   * @private
   */
  async _executeDirectOrder(instance, symbol, orderParams) {
    const { action, tradeMode, quantity, product, orderType, price, expiry } = orderParams;

    // Determine final symbol based on trade mode
    let finalSymbol = symbol.symbol;
    let finalExchange = symbol.exchange;
    let resolvedLotSize = symbol.lot_size;

    if (tradeMode === 'FUTURES') {
      const derivativeExchange = symbol.symbol_type === 'FUTURES'
        ? symbol.exchange
        : this._getDerivativeExchange(symbol.exchange);
      const underlying =
        (symbol.underlying_symbol || symbol.name || symbol.symbol || '').toUpperCase();

      if (expiry) {
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

        const futuresSymbol = await this._resolveFuturesSymbol(
          instance,
          underlying,
          derivativeExchange,
          expiry
        );

        finalSymbol = futuresSymbol.symbol;
        finalExchange = derivativeExchange;
        resolvedLotSize = futuresSymbol.lot_size || symbol.lot_size;

        log.info('Futures symbol resolved', {
          symbol: finalSymbol,
          exchange: finalExchange,
          lotSize: resolvedLotSize,
        });
      } else if (symbol.symbol_type === 'FUTURES') {
        // Fall back to the watchlist contract if no expiry was picked
        finalSymbol = symbol.symbol;
        finalExchange = symbol.exchange;
      } else {
        throw new ValidationError('Expiry is required for FUTURES trading on this symbol');
      }
    }

    // Get current position size (signed: positive for long, negative for short)
    const currentPosition = await this._getCurrentPositionSize(
      instance,
      finalSymbol,
      finalExchange,
      product
    );

    // Calculate trade quantity based on symbol type and trade mode
    // ONLY EQUITY symbols in EQUITY mode use actual quantity
    // Everything else (FUTURES, OPTIONS, derivatives on EQUITY/INDEX) uses lots
    let tradeQuantity;
    let lotSize;

    if (symbol.symbol_type === 'EQUITY' && tradeMode === 'EQUITY') {
      // EQUITY symbols in EQUITY mode: quantity is actual quantity
      lotSize = 1;
      tradeQuantity = quantity;
    } else {
      // All other cases: quantity is number of lots (multiply by lot_size)
      // - Direct FUTURES symbols: lots * lot_size
      // - Direct OPTIONS symbols: lots * lot_size
      // - INDEX with FUTURES/OPTIONS mode: lots * lot_size
      // - EQUITY with FUTURES/OPTIONS mode: lots * lot_size
      // Use resolvedLotSize if futures symbol was resolved, otherwise use symbol.lot_size
      lotSize = resolvedLotSize || symbol.lot_size || 1;
      tradeQuantity = quantity * lotSize;
    }

    log.info('Calculated trade quantity', {
      symbolType: symbol.symbol_type,
      tradeMode,
      inputQuantity: quantity,
      lotSize,
      tradeQuantity,
    });

    // Calculate target position_size based on action
    let targetPosition;
    let algoAction;

    if (action === 'BUY') {
      // BUY: Increase position (or reduce short position)
      algoAction = 'BUY';
      targetPosition = currentPosition + tradeQuantity;
    } else if (action === 'SELL') {
      // SELL: Decrease position (or increase short position)
      algoAction = 'SELL';
      targetPosition = currentPosition - tradeQuantity;
      // Ensure target position doesn't go below 0 for now (no shorting for simplicity)
      if (targetPosition < 0) targetPosition = 0;
    } else if (action === 'EXIT') {
      // EXIT: Close current position completely
      targetPosition = 0;
      if (currentPosition > 0) {
        // Close long position - SELL
        algoAction = 'SELL';
      } else if (currentPosition < 0) {
        // Close short position - BUY
        algoAction = 'BUY';
      } else {
        // No position to exit
        throw new ValidationError('No open position to exit');
      }
    } else {
      throw new ValidationError(`Invalid action: ${action}`);
    }

    log.info('Calculated position for order', {
      action,
      currentPosition,
      tradeQuantity,
      targetPosition,
      algoAction,
      lotSize,
    });

    // Place order using placesmartorder
    const orderResult = await openalgoClient.placeSmartOrder(instance, {
      strategy: symbol.watchlist_name || 'default',
      exchange: finalExchange,
      symbol: finalSymbol,
      action: algoAction,
      quantity: tradeQuantity,
      position_size: targetPosition,
      product,
      pricetype: orderType,
      price: price.toString(),
    });

    // Record order in database
    await this._recordQuickOrder({
      watchlist_id: symbol.watchlist_id,
      symbol_id: symbol.id,
      instance_id: instance.id,
      underlying: symbol.underlying_symbol || symbol.symbol,
      symbol: finalSymbol,
      exchange: finalExchange,
      action: algoAction,
      trade_mode: tradeMode,
      quantity: tradeQuantity,
      product,
      order_type: orderType,
      price,
      order_id: orderResult.orderid,
      status: orderResult.status,
      message: orderResult.message || 'Order placed successfully',
    });

    this._invalidateInstanceCaches(instance.id);

    return {
      order_id: orderResult.orderid,
      status: orderResult.status,
      symbol: finalSymbol,
      quantity: tradeQuantity,
      action: algoAction,
    };
  }

  /**
   * Execute options order with Buyer/Writer position-aware targeting
   * Implements Options Mode Implementation Guide v1.4
   * @private
   */
  async _executeOptionsOrder(instance, symbol, orderParams, preResolvedOptionSymbol = null) {
    const {
      action,
      product,
      orderType,
      price,
      operatingMode = 'BUYER',
      strikePolicy = 'FLOAT_OFS',
      stepLots = 1,
    } = orderParams;

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
    const derivativeExchange = this._getDerivativeExchange(symbol.exchange);

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
        product
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

      // Calculate Qstep = step_lots × lotsize
      const lotSize = optionSymbol.lot_size || symbol.lot_size || 1;
      const Qstep = stepLots * lotSize;

      log.info('FLOAT_OFS REDUCE/INCREASE: Calculating per-position reductions', {
        Qstep,
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

      const orderPromises = ordersToPlace.map(async order => {
        const orderDataToSend = {
          strategy: symbol.watchlist_name || 'default',
          exchange: derivativeExchange,
          symbol: order.symbol,
          action: order.action,
          quantity: order.quantity,
          position_size: order.position_size,
          product,
          pricetype: orderType,
          price: price.toString(),
        };

        log.info('FLOAT_OFS: Placing order for strike', {
          strike: order.strike,
          symbol: order.symbol,
          action: order.action,
          quantity: order.quantity,
          position_size: order.position_size,
        });

        const orderResult = await openalgoClient.placeSmartOrder(instance, orderDataToSend);

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
          product
        );

        await this._recordQuickOrder({
          watchlist_id: symbol.watchlist_id,
          symbol_id: symbol.id,
          instance_id: instance.id,
          underlying,
          symbol: order.symbol,
          exchange: derivativeExchange,
          action: order.action,
          trade_mode: 'OPTIONS',
          options_leg: symbol.options_strike_selection,
          quantity: order.quantity,
          product,
          order_type: orderType,
          price,
          resolved_symbol: optionSymbol.symbol,
          strike_price: order.strike,
          option_type: optionType,
          expiry_date: expiry,
          order_id: orderResult.orderid,
          status: orderResult.status,
          message: orderResult.message || `${operatingMode} mode: ${action} executed successfully`,
        });

        return {
          order_id: orderResult.orderid,
          status: orderResult.status,
          symbol: order.symbol,
          strike: order.strike,
          quantity: order.quantity,
          action: order.action,
        };
      });

      const orderResults = await Promise.all(orderPromises);

      log.info('FLOAT_OFS REDUCE/INCEASE: All orders placed successfully', {
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
      currentPosition = await this._getCurrentPositionSize(
        instance,
        optionSymbol.symbol,
        derivativeExchange,
        product
      );
      log.info('Using LEG-scoped position', {
        symbol: optionSymbol.symbol,
        currentPosition,
      });
    }

    // Calculate Qstep = step_lots × lotsize
    const lotSize = optionSymbol.lot_size || symbol.lot_size || 1;
    const Qstep = stepLots * lotSize;

    log.info('Calculated Qstep', {
      stepLots,
      lotSize,
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

    // Prepare order data for OpenAlgo
    const orderDataToSend = {
      strategy: symbol.watchlist_name || 'default',
      exchange: derivativeExchange,
      symbol: optionSymbol.symbol,
      action: algoAction,
      quantity,
      position_size: targetPosition,
      product,
      pricetype: orderType,
      price: price.toString(),
    };

    log.info('Data being sent to OpenAlgo placesmartorder', orderDataToSend);

    // Place order using placesmartorder
    const orderResult = await openalgoClient.placeSmartOrder(instance, orderDataToSend);

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
      product
    );

    // Record order in database
    await this._recordQuickOrder({
      watchlist_id: symbol.watchlist_id,
      symbol_id: symbol.id,
      instance_id: instance.id,
      underlying,
      symbol: optionSymbol.symbol,
      exchange: derivativeExchange,
      action: algoAction,
      trade_mode: 'OPTIONS',
      options_leg: symbol.options_strike_selection,
      quantity,
      product,
      order_type: orderType,
      price,
      resolved_symbol: optionSymbol.symbol,
      strike_price: strike,
      option_type: optionType,
      expiry_date: expiry,
      order_id: orderResult.orderid,
      status: orderResult.status,
      message: orderResult.message || `${operatingMode} mode: ${action} executed successfully`,
    });

    this._invalidateInstanceCaches(instance.id);

    return {
      order_id: orderResult.orderid,
      status: orderResult.status,
      symbol: optionSymbol.symbol,
      strike,
      option_type: optionType,
      quantity,
      action: algoAction,
      operating_mode: operatingMode,
      strike_policy: strikePolicy,
      current_position: currentPosition,
      target_position: targetPosition,
    };
  }

  /**
   * Close positions (EXIT or EXIT_ALL)
   * @private
   */
  async _closePositions(instance, symbol, orderParams) {
    const { action, tradeMode, product, expiry: userExpiry } = orderParams;

    const underlying = this._getUnderlyingForClosing(symbol);

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
        product
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
        product
      );

      const pePositions = await this._getOpenOptionsPositions(
        instance,
        underlying,
        expiry,
        'PE',
        product
      );

      positionsToClose = [...cePositions, ...pePositions];
    } else {
      // Close position for specific symbol
      const positions = await this._getOpenPositionsForSymbol(
        instance,
        symbol.symbol,
        symbol.exchange,
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
        const orderResult = await openalgoClient.placeSmartOrder(instance, {
          strategy: symbol.watchlist_name || 'default',
          exchange: position.exchange,
          symbol: position.symbol,
          action: closeAction,
          quantity: closeQuantity,
          position_size: 0,  // Target position is 0 (close completely)
          product,
          pricetype: 'MARKET',
          price: '0',
        });

        closeResults.push({
          success: true,
          symbol: position.symbol,
          quantity: closeQuantity,
          order_id: orderResult.orderid,
        });

        // Record order
        await this._recordQuickOrder({
          watchlist_id: symbol.watchlist_id,
          symbol_id: symbol.id,
          instance_id: instance.id,
          underlying,
          symbol: position.symbol,
          exchange: position.exchange,
          action: closeAction,
          trade_mode: tradeMode,
          quantity: closeQuantity,
          product,
          order_type: 'MARKET',
          order_id: orderResult.orderid,
          status: orderResult.status,
          message: `Position closed: ${position.symbol}`,
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

  /**
   * Reconcile options positions (close opposite positions)
   * @private
   */
  async _reconcileOptionsPositions(instance, positions, side, optionType, product, strategy) {
    const positionsToClose = [];

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

        const orderResult = await openalgoClient.placeSmartOrder(instance, {
          strategy: strategy || 'default',
          exchange: position.exchange,
          symbol: position.symbol,
          action: closeAction,
          quantity: closeQuantity,
          position_size: position.quantity,
          product,
          pricetype: 'MARKET',
          price: '0',
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
  async _getPositionBook(instance) {
    const cache = marketDataFeedService.getPositionSnapshot(instance.id);
    if (cache?.data) {
      return cache.data;
    }

    const positionBook = await openalgoClient.getPositionBook(instance);
    marketDataFeedService.setPositionSnapshot(instance.id, positionBook);
    return positionBook;
  }

  /**
   * Get current position size for a symbol
   * @private
   */
  async _getCurrentPositionSize(instance, symbol, exchange, product) {
    try {
      const positionBook = await this._getPositionBook(instance);
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
      log.warn('Failed to determine current position size from cache', {
        instance_id: instance.id,
        symbol,
        exchange,
        product,
        error: error.message,
      });
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
      expiry: params.expiry || null,
    };

    return this._closePositions(instance, symbolPayload, orderParams);
  }

  /**
   * Get open options positions for underlying and expiry
   * @private
   */
  async _getOpenOptionsPositions(instance, underlying, expiry, optionType, product) {
    try {
      const positionBook = await this._getPositionBook(instance);
      const targetUnderlying = (underlying || '').toUpperCase();
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
          const matchesUnderlying = parsed.underlying
            ? parsed.underlying === targetUnderlying
            : symbol.includes(targetUnderlying);

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
      const positionBook = await this._getPositionBook(instance);

      const positions = positionBook.filter(p => {
        const matchesSymbol = p.symbol === symbol;
        const hasQuantity = p.quantity && p.quantity !== '0' && parseInt(p.quantity) !== 0;

        return matchesSymbol && hasQuantity;
      });

      return positions.map(p => ({
        symbol: p.symbol,
        exchange: p.exchange,
        quantity: parseIntSafe(p.quantity, 0),
        product: p.product,
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
   * Get underlying LTP
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

      const cachedQuote = this._findQuoteInSnapshot(
        marketDataFeedService.getQuoteSnapshot(instance.id),
        exchange,
        underlying
      );

      if (cachedQuote) {
        const cachedLtp = this._extractLtpFromQuote(cachedQuote);
        if (cachedLtp) {
          log.debug('Using cached LTP for underlying', {
            instance_id: instance.id,
            underlying,
            ltp: cachedLtp,
            source: 'cache',
          });
          return cachedLtp;
        }
      }

      const quotes = await openalgoClient.getQuotes(instance, [
        { exchange, symbol: underlying },
      ]);

      if (!quotes || quotes.length === 0) {
        throw new NotFoundError(`No quote found for ${underlying}`);
      }

      const ltp = this._extractLtpFromQuote(quotes[0]);

      if (!ltp) {
        throw new ValidationError(`Invalid LTP received for ${underlying}`);
      }

      log.debug('LTP fetched successfully', {
        instance_id: instance.id,
        underlying,
        ltp,
        source: 'live',
      });

      return ltp;
    } catch (error) {
      log.error('Failed to get underlying LTP', error, {
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
      await db.run(
        `INSERT INTO quick_orders (
          watchlist_id, symbol_id, instance_id, underlying, symbol, exchange,
          action, trade_mode, options_leg, quantity, product, order_type,
          price, trigger_price, resolved_symbol, strike_price, option_type,
          expiry_date, status, order_id, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          orderData.watchlist_id,
          orderData.symbol_id,
          orderData.instance_id,
          orderData.underlying,
          orderData.symbol,
          orderData.exchange,
          orderData.action,
          orderData.trade_mode,
          orderData.options_leg || null,
          orderData.quantity,
          orderData.product,
          orderData.order_type,
          orderData.price || null,
          orderData.trigger_price || null,
          orderData.resolved_symbol || null,
          orderData.strike_price || null,
          orderData.option_type || null,
          orderData.expiry_date || null,
          orderData.status,
          orderData.order_id,
          orderData.message,
        ]
      );

      log.debug('Quick order recorded in database', {
        order_id: orderData.order_id,
        symbol: orderData.symbol,
      });
    } catch (error) {
      log.error('Failed to record quick order', error);
      // Non-fatal - order was still placed
    }
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
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const sinceDateStr = sinceDate.toISOString();

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
  /**
   * Resolve futures symbol from underlying and expiry
   * @private
   */
  async _resolveFuturesSymbol(instance, underlying, exchange, expiry) {
    try {
      // Convert expiry to OpenAlgo format (DD-MMM-YY)
      const openalgoExpiry = this._convertExpiryToOpenAlgoFormat(expiry);

      log.debug('Searching for futures symbol', {
        underlying,
        exchange,
        expiry: openalgoExpiry,
      });

      // Search for futures symbol matching underlying and expiry
      const searchResults = await openalgoClient.searchSymbols(instance, underlying);

      const futuresSymbols = searchResults.filter(result => {
        const isFutures = (result.instrumenttype || '').toUpperCase().startsWith('FUT');
        const matchesUnderlying = (result.name || '').toUpperCase() === underlying.toUpperCase();
        const matchesExpiry = result.expiry === openalgoExpiry;
        const matchesExchange =
          (result.exchange || '').toUpperCase() === (exchange || '').toUpperCase();
        return isFutures && matchesUnderlying && matchesExpiry && matchesExchange;
      });

      if (futuresSymbols.length === 0) {
        throw new NotFoundError(
          `No futures contract found for ${underlying} with expiry ${openalgoExpiry}`
        );
      }

      const futuresSymbol = futuresSymbols[0];

      log.info('Futures symbol found', {
        symbol: futuresSymbol.symbol,
        lotSize: futuresSymbol.lotsize || futuresSymbol.lot_size,
        expiry: futuresSymbol.expiry,
      });

      return {
        symbol: futuresSymbol.symbol,
        trading_symbol: futuresSymbol.tradingsymbol || futuresSymbol.symbol,
        lot_size: futuresSymbol.lotsize || futuresSymbol.lot_size || 1,
        tick_size: futuresSymbol.tick_size || 0.05,
        token: futuresSymbol.token,
        expiry: futuresSymbol.expiry,
      };
    } catch (error) {
      log.error('Failed to resolve futures symbol', error);
      throw new NotFoundError(
        `Unable to find futures contract for ${underlying} with expiry ${expiry}: ${error.message}`
      );
    }
  }

  /**
   * Convert expiry from YYYY-MM-DD to DD-MMM-YY format (OpenAlgo format)
   * @private
   */
  _convertExpiryToOpenAlgoFormat(expiry) {
    if (!expiry) return null;

    // If already in DD-MMM-YY format, return as-is
    if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
      return expiry;
    }

    // Convert YYYY-MM-DD to DD-MMM-YY
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      const date = new Date(expiry);
      const day = String(date.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames[date.getMonth()];
      const year = String(date.getFullYear()).slice(-2);
      return `${day}-${month}-${year}`;
    }

    return expiry;
  }

  _getDerivativeExchange(exchange) {
    const exchangeMap = {
      'NSE': 'NFO',         // NSE equity -> NSE F&O
      'NSE_INDEX': 'NFO',   // NSE indices -> NSE F&O
      'BSE': 'BFO',         // BSE equity -> BSE F&O
      'BSE_INDEX': 'BFO',   // BSE indices -> BSE F&O
      'NFO': 'NFO',         // Already derivative exchange
      'BFO': 'BFO',         // Already derivative exchange
      'MCX': 'MCX',         // Commodities
      'CDS': 'CDS',         // Currency derivatives
    };

    return exchangeMap[exchange] || exchange;
  }

  _getUnderlyingQuoteExchange(symbol = {}) {
    const exchange = (symbol.exchange || '').toUpperCase();
    const instrumentType = (symbol.instrumenttype || symbol.symbol_type || '').toUpperCase();
    const brexchange = (symbol.brexchange || '').toUpperCase();
    const underlying = (symbol.underlying_symbol || symbol.name || symbol.symbol || '').toUpperCase();

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
    if (symbol.underlying_symbol) {
      return symbol.underlying_symbol.toUpperCase();
    }
    if (symbol.name) {
      return symbol.name.toUpperCase();
    }
    const candidate = (symbol.symbol || symbol.trading_symbol || '').toUpperCase();
    const match = candidate.match(/^([A-Z]+)/);
    return match ? match[1] : candidate;
  }

  /**
   * Get market data instance from list of instances
   * Prefers instances with market_data_role='primary', falls back to first instance
   * @private
   */
  async _getMarketDataInstance(instances) {
    // Try to find primary market data instance
    const primaryInstance = instances.find(i => i.market_data_role === 'primary');
    if (primaryInstance) {
      log.debug('Using primary market data instance', {
        instance_id: primaryInstance.id,
        name: primaryInstance.name,
      });
      return primaryInstance;
    }

    // Fallback to first instance
    log.debug('No primary market data instance, using first instance', {
      instance_id: instances[0].id,
      name: instances[0].name,
    });
    return instances[0];
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

    const underlying = (symbol.underlying_symbol || symbol.symbol || '').trim().toUpperCase();
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

    const underlying = (symbol.underlying_symbol || symbol.symbol || '').trim().toUpperCase();
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
    const derivativeExchange = this._getDerivativeExchange(symbol.exchange);
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
    this.symbolResolutionCache.set(cacheKey, { value: resolution, ts: now });
    return resolution;
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

    const underlying = (symbol.underlying_symbol || symbol.symbol || '').trim().toUpperCase();
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

    const marketDataInstanceService = (await import('./market-data-instance.service.js')).default;
    const marketDataInstance = await marketDataInstanceService.getMarketDataInstance();

    const effectiveExpiry =
      normalizedExpiry ||
      await expiryManagementService.getNearestExpiry(
        underlying,
        symbol.exchange,
        marketDataInstance
      );

    if (!effectiveExpiry) {
      throw new ValidationError(
        'Unable to determine an expiry for options preview. Please pick an expiry in the UI.'
      );
    }

    const derivativeExchange = this._getDerivativeExchange(symbol.exchange);
    const baseExchange = this._getUnderlyingQuoteExchange(symbol);
    const quoteSymbol = this._getUnderlyingQuoteSymbol(symbol);
    const underlyingLtp = await this._getUnderlyingLTP(
      marketDataInstance,
      quoteSymbol,
      baseExchange
    );

    const resolveParamsBase = {
      underlying,
      exchange: derivativeExchange,
      expiry: effectiveExpiry,
      strikeOffset,
      ltp: underlyingLtp,
      instance: marketDataInstance,
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

    const quoteRequests = [];
    if (ceResolution?.symbol) {
      quoteRequests.push({ exchange: derivativeExchange, symbol: ceResolution.symbol });
    }
    if (peResolution?.symbol) {
      quoteRequests.push({ exchange: derivativeExchange, symbol: peResolution.symbol });
    }

    const quotesMap = await this._getQuotesFromCache(marketDataInstance, quoteRequests);

    const buildLegResponse = (resolution) => {
      if (!resolution?.symbol) {
        return null;
      }

      const quoteKey = this._buildQuoteMatchKey(derivativeExchange, resolution.symbol);
      const quote = quoteKey ? quotesMap.get(quoteKey) : null;
      const ltp = quote ? this._extractLtpFromQuote(quote) : null;
      const changePercent = quote ? this._extractChangePercentFromQuote(quote) : null;

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
      };
    };

    return {
      symbolId,
      watchlistId: symbol.watchlist_id,
      expiry: effectiveExpiry,
      strikeOffset,
      derivativeExchange,
      updatedAt: new Date().toISOString(),
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
   * Construct option symbol from components
   * Format: UNDERLYING + DD + MMM + YYYY + CE/PE + STRIKE
   * Example: NIFTY + 18 + NOV + 2025 + CE + 26000 → NIFTY18NOV2526000CE
   * @private
   */
  _constructOptionSymbol(underlying, expiry, optionType, strike) {
    // Parse expiry YYYY-MM-DD
    const date = new Date(expiry);
    const day = String(date.getDate()).padStart(2, '0');
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = months[date.getMonth()];
    const year = String(date.getFullYear());  // Use FULL year, not just last 2 digits

    // Construct symbol: NIFTY18NOV2526000CE
    return `${underlying}${day}${month}${year}${optionType}${strike}`;
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

  _invalidateInstanceCaches(instanceId, options = {}) {
    const { positions = true, funds = true, orderbook = true } = options;

    if (positions) {
      marketDataFeedService.invalidatePositions(instanceId, { refresh: true })
        .catch(error => log.warn('Failed to refresh position cache', {
          instance_id: instanceId,
          error: error.message,
      }));
    }

    if (orderbook) {
      marketDataFeedService.invalidateOrderbook(instanceId);
    }

    if (funds) {
      marketDataFeedService.invalidateFunds(instanceId, { refresh: true })
        .catch(error => log.warn('Failed to refresh funds cache', {
          instance_id: instanceId,
          error: error.message,
        }));
    }
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
        results.set(key, cachedQuote);
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
        for (const quote of liveQuotes) {
          const key = this._buildQuoteMatchKey(
            quote.exchange || quote.exch,
            quote.symbol || quote.trading_symbol || quote.tradingsymbol
          );
          if (key) {
            results.set(key, quote);
          }
        }
      }
    }

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

  _normalizeSymbolKey(symbol) {
    if (!symbol) return null;
    return String(symbol).trim().toUpperCase().replace(/\s+/g, '');
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
