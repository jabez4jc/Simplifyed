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
import { ValidationError, NotFoundError } from '../core/errors.js';
import { parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';

class QuickOrderService {
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
    } = params;

    log.info('Placing quick order', { symbolId, instanceId, action, tradeMode, quantity, expiry, optionsLeg });

    // Validate inputs
    this._validateOrderParams(params);

    // Get symbol configuration
    const symbol = await this._getSymbolConfig(symbolId);

    // Get instances (single or all assigned)
    const instances = await this._getTargetInstances(instanceId, symbol.watchlist_id);

    // Determine order strategy based on action
    const strategy = this._determineOrderStrategy(action, tradeMode);

    // Execute order based on strategy
    const results = await this._executeOrderStrategy(
      strategy,
      symbol,
      instances,
      { action, tradeMode, quantity, product, orderType, price, expiry, optionsLeg }
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

    const validActions = ['BUY', 'SELL', 'EXIT', 'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL'];
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
    const optionsActions = ['BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE', 'EXIT_ALL'];
    if (optionsActions.includes(action) && tradeMode !== 'OPTIONS') {
      throw new ValidationError(`Action ${action} is only valid for OPTIONS trade mode`);
    }
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
      // Get all assigned instances
      const instances = await db.all(
        `SELECT i.* FROM instances i
         JOIN watchlist_instances wi ON i.id = wi.instance_id
         WHERE wi.watchlist_id = ? AND i.is_active = 1 AND i.order_placement_enabled = 1
         AND i.is_analyzer_mode = 0`,
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

      if (instance.is_analyzer_mode) {
        throw new ValidationError('Instance is in analyzer mode, cannot place orders');
      }

      return [instance];
    }
  }

  /**
   * Determine order strategy based on action and trade mode
   * @private
   */
  _determineOrderStrategy(action, tradeMode) {
    if (action === 'EXIT' || action === 'EXIT_ALL') {
      return 'CLOSE_POSITIONS';
    }

    if (tradeMode === 'OPTIONS' && ['BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE'].includes(action)) {
      return 'OPTIONS_WITH_RECONCILIATION';
    }

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
    const results = [];

    for (const instance of instances) {
      try {
        let result;

        switch (strategy) {
          case 'DIRECT_ORDER':
            result = await this._executeDirectOrder(instance, symbol, orderParams);
            break;

          case 'OPTIONS_WITH_RECONCILIATION':
            result = await this._executeOptionsOrder(instance, symbol, orderParams);
            break;

          case 'CLOSE_POSITIONS':
            result = await this._closePositions(instance, symbol, orderParams);
            break;

          default:
            throw new ValidationError(`Unknown strategy: ${strategy}`);
        }

        results.push({
          success: true,
          instance_id: instance.id,
          instance_name: instance.name,
          ...result,
        });
      } catch (error) {
        log.error('Failed to execute order on instance', error, {
          instance_id: instance.id,
          symbol_id: symbol.id,
        });

        results.push({
          success: false,
          instance_id: instance.id,
          instance_name: instance.name,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Execute direct order (EQUITY/FUTURES BUY/SELL)
   * @private
   */
  async _executeDirectOrder(instance, symbol, orderParams) {
    const { action, tradeMode, quantity, product, orderType, price } = orderParams;

    // Determine final symbol based on trade mode
    let finalSymbol = symbol.symbol;
    let finalExchange = symbol.exchange;

    if (tradeMode === 'FUTURES') {
      // For futures, we need to get the futures symbol
      // This could be the symbol itself if it's a futures symbol
      // or we need to resolve it from the underlying
      if (symbol.symbol_type === 'FUTURES') {
        finalSymbol = symbol.symbol;
      } else {
        // Need to get futures symbol (this would require additional logic)
        throw new ValidationError('Futures symbol resolution not yet implemented for this symbol');
      }
    }

    // Get current position size
    const positionSize = await this._getCurrentPositionSize(
      instance,
      finalSymbol,
      finalExchange,
      product
    );

    // Calculate lot size
    const lotSize = symbol.lot_size || 1;
    const finalQuantity = tradeMode === 'EQUITY' ? quantity : quantity * lotSize;

    // Map action to OpenAlgo action
    const algoAction = action; // BUY or SELL

    // Place order using placesmartorder
    const orderResult = await openalgoClient.placeSmartOrder(instance, {
      strategy: symbol.watchlist_name || 'default',
      exchange: finalExchange,
      symbol: finalSymbol,
      action: algoAction,
      quantity: finalQuantity,
      position_size: positionSize,
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
      quantity: finalQuantity,
      product,
      order_type: orderType,
      price,
      order_id: orderResult.orderid,
      status: orderResult.status,
      message: orderResult.message || 'Order placed successfully',
    });

    return {
      order_id: orderResult.orderid,
      status: orderResult.status,
      symbol: finalSymbol,
      quantity: finalQuantity,
      action: algoAction,
    };
  }

  /**
   * Execute options order with position reconciliation
   * @private
   */
  async _executeOptionsOrder(instance, symbol, orderParams) {
    const { action, quantity, product, orderType, price, expiry: userExpiry, optionsLeg: userOptionsLeg } = orderParams;

    // Parse action to determine option type and side
    const optionType = action.includes('CE') ? 'CE' : 'PE';
    const side = action.startsWith('BUY') ? 'BUY' : 'SELL';

    // Get underlying symbol and current LTP
    const underlying = symbol.underlying_symbol || symbol.symbol;
    const ltp = await this._getUnderlyingLTP(instance, underlying, symbol.exchange);

    // Get expiry - use user-selected expiry if provided, otherwise auto-select nearest
    let expiry = userExpiry;
    if (!expiry) {
      expiry = await expiryManagementService.getNearestExpiry(
        underlying,
        symbol.exchange,
        instance
      );
      log.info('Auto-selected nearest expiry', { expiry });
    } else {
      log.info('Using user-selected expiry', { expiry });
    }

    // Get strike offset - use user-selected options leg if provided, otherwise use symbol default
    const strikeOffset = userOptionsLeg || symbol.options_strike_selection || 'ATM';
    log.info('Using strike offset', { strikeOffset, userSelected: !!userOptionsLeg });

    // Resolve option symbol
    const optionSymbol = await optionsResolutionService.resolveOptionSymbol({
      underlying,
      exchange: symbol.exchange,
      expiry,
      optionType,
      strikeOffset,
      ltp,
      instance,
    });

    // Determine the correct derivatives exchange
    // INDEX symbols are on NSE_INDEX but their options trade on NFO
    const derivativeExchange = this._getDerivativeExchange(symbol.exchange);
    log.info('Exchange mapping for options', {
      originalExchange: symbol.exchange,
      derivativeExchange
    });

    // Get open positions for this underlying and expiry
    const openPositions = await this._getOpenOptionsPositions(
      instance,
      underlying,
      expiry,
      optionType,
      product
    );

    // Reconcile positions (close opposite positions)
    const closeResults = await this._reconcileOptionsPositions(
      instance,
      openPositions,
      side,
      optionType,
      product,
      symbol.watchlist_name
    );

    // Calculate final quantity (in lots)
    const lotSize = optionSymbol.lot_size || symbol.lot_size || 1;
    const finalQuantity = quantity * lotSize;

    // Get position size after reconciliation
    const positionSize = await this._getCurrentPositionSize(
      instance,
      optionSymbol.symbol,
      derivativeExchange,  // Use derivative exchange
      product
    );

    // Place new order
    const orderResult = await openalgoClient.placeSmartOrder(instance, {
      strategy: symbol.watchlist_name || 'default',
      exchange: derivativeExchange,  // Use derivative exchange (NFO, not NSE_INDEX)
      symbol: optionSymbol.symbol,
      action: side,
      quantity: finalQuantity,
      position_size: positionSize,
      product,
      pricetype: orderType,
      price: price.toString(),
    });

    // Record order in database
    await this._recordQuickOrder({
      watchlist_id: symbol.watchlist_id,
      symbol_id: symbol.id,
      instance_id: instance.id,
      underlying,
      symbol: optionSymbol.symbol,
      exchange: derivativeExchange,  // Use derivative exchange
      action: side,
      trade_mode: 'OPTIONS',
      options_leg: symbol.options_strike_selection,
      quantity: finalQuantity,
      product,
      order_type: orderType,
      price,
      resolved_symbol: optionSymbol.symbol,
      strike_price: optionSymbol.targetStrike,
      option_type: optionType,
      expiry_date: expiry,
      order_id: orderResult.orderid,
      status: orderResult.status,
      message: orderResult.message || 'Options order placed successfully',
    });

    return {
      order_id: orderResult.orderid,
      status: orderResult.status,
      symbol: optionSymbol.symbol,
      strike: optionSymbol.targetStrike,
      option_type: optionType,
      quantity: finalQuantity,
      action: side,
      closed_positions: closeResults.length,
    };
  }

  /**
   * Close positions (EXIT or EXIT_ALL)
   * @private
   */
  async _closePositions(instance, symbol, orderParams) {
    const { action, tradeMode, product, expiry: userExpiry } = orderParams;

    const underlying = symbol.underlying_symbol || symbol.symbol;

    let positionsToClose = [];

    if (action === 'EXIT_ALL' && tradeMode === 'OPTIONS') {
      // Close all CE and PE positions for the underlying
      // Use user-selected expiry if provided, otherwise auto-select nearest
      let expiry = userExpiry;
      if (!expiry) {
        expiry = await expiryManagementService.getNearestExpiry(
          underlying,
          symbol.exchange,
          instance
        );
        log.info('Auto-selected nearest expiry for EXIT_ALL', { expiry });
      } else {
        log.info('Using user-selected expiry for EXIT_ALL', { expiry });
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

        const orderResult = await openalgoClient.placeSmartOrder(instance, {
          strategy: symbol.watchlist_name || 'default',
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
   * Get current position size for a symbol
   * @private
   */
  async _getCurrentPositionSize(instance, symbol, exchange, product) {
    try {
      const position = await openalgoClient.getOpenPosition(
        instance,
        symbol,
        exchange,
        product,
        'default'
      );

      return parseIntSafe(position.quantity, 0);
    } catch (error) {
      // No position or error fetching - return 0
      return 0;
    }
  }

  /**
   * Get open options positions for underlying and expiry
   * @private
   */
  async _getOpenOptionsPositions(instance, underlying, expiry, optionType, product) {
    try {
      const positionBook = await openalgoClient.getPositionBook(instance);

      // Filter positions matching underlying, expiry, and option type
      const positions = positionBook.filter(p => {
        const matchesType = p.symbol.includes(optionType);
        const matchesUnderlying = p.symbol.startsWith(underlying);
        const hasQuantity = p.quantity && p.quantity !== '0' && parseInt(p.quantity) !== 0;

        return matchesType && matchesUnderlying && hasQuantity;
      });

      return positions.map(p => ({
        symbol: p.symbol,
        exchange: p.exchange,
        quantity: parseIntSafe(p.quantity, 0),
        product: p.product,
      }));
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
      const positionBook = await openalgoClient.getPositionBook(instance);

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
   * Get underlying LTP
   * @private
   */
  async _getUnderlyingLTP(instance, underlying, exchange) {
    try {
      const quotes = await openalgoClient.getQuotes(instance, [
        { exchange, symbol: underlying },
      ]);

      if (quotes.length === 0) {
        throw new NotFoundError(`No quote found for ${underlying}`);
      }

      return parseFloatSafe(quotes[0].ltp || quotes[0].last_price, 0);
    } catch (error) {
      log.error('Failed to get underlying LTP', error);
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
}

// Export singleton instance
export default new QuickOrderService();
export { QuickOrderService };
