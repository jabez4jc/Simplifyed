/**
 * Strategy Service
 * Multi-leg strategy CRUD + execution. A strategy is a named group of legs (e.g. sell ATM CE +
 * sell ATM PE) scoped to a watchlist. Execution reuses the existing single-leg primitives
 * (quickOrderService.placeQuickOrder, options/derivative resolution already inside it) rather
 * than reimplementing order placement, and reuses the existing AutoExitService/RiskControlsService
 * polling loop for exits by upserting a per-leg watchlist_symbols row carrying that leg's own
 * target/stoploss/trailing config against the leg's *resolved* trading symbol (see executeStrategy).
 */

import crypto from 'crypto';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { sanitizeSymbol, sanitizeExchange, parseFloatSafe, parseIntSafe } from '../utils/sanitizers.js';
import watchlistSymbolService from './watchlist-symbol.service.js';
import watchlistService from './watchlist.service.js';
import quickOrderService from './quick-order.service.js';
import marketDataFeedService from './market-data-feed.service.js';
import marginSizingService from './margin-sizing.service.js';
import riskEventsService from './risk-events.service.js';
import instanceService from './instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import orderRepository from './order-repository.js';
import gttService from './gtt.service.js';

const VALID_EXIT_MECHANISMS = ['POLLING', 'GTT'];

const VALID_ENTRY_TRIGGERS = ['MANUAL', 'WEBHOOK'];
const VALID_ACTIONS = ['BUY', 'SELL'];
const VALID_OPTION_TYPES = ['CE', 'PE'];
const VALID_STRIKE_POLICIES = ['FLOAT_OFS', 'ANCHOR_OFS'];
const VALID_QTY_TYPES = ['LOTS', 'FIXED', 'MARGIN_BASED'];

class StrategyService {
  async listStrategies(watchlistId) {
    return db.all(
      `SELECT s.*, (SELECT COUNT(*) FROM strategy_legs WHERE strategy_id = s.id) as leg_count
       FROM strategies s
       WHERE s.watchlist_id = ?
       ORDER BY s.created_at DESC`,
      [watchlistId]
    );
  }

  async getStrategyWithLegs(strategyId) {
    const strategy = await db.get('SELECT * FROM strategies WHERE id = ?', [strategyId]);
    if (!strategy) {
      throw new NotFoundError('Strategy');
    }
    const legs = await db.all(
      'SELECT * FROM strategy_legs WHERE strategy_id = ? ORDER BY leg_order ASC, id ASC',
      [strategyId]
    );
    return { ...strategy, legs };
  }

  async createStrategy(data) {
    const watchlistId = parseIntSafe(data.watchlist_id, null);
    if (!watchlistId) {
      throw new ValidationError('watchlist_id is required');
    }
    const name = (data.name || '').trim();
    if (!name) {
      throw new ValidationError('name is required');
    }
    const underlying = sanitizeSymbol(data.underlying);
    if (!underlying) {
      throw new ValidationError('underlying is required');
    }
    const exchange = sanitizeExchange(data.exchange);
    if (!exchange) {
      throw new ValidationError('exchange is required');
    }
    const entryTrigger = VALID_ENTRY_TRIGGERS.includes(data.entry_trigger) ? data.entry_trigger : 'MANUAL';

    let webhookSlug = null;
    if (entryTrigger === 'WEBHOOK') {
      // Webhook entry only makes sense on a watchlist that's actually wired to receive
      // TradingView alerts - mirrors the same gate regular (non-strategy) webhook alerts
      // already enforce in watchlistService.getBroadcastTargets.
      const watchlist = await watchlistService.getWatchlistById(watchlistId);
      if (!watchlist) {
        throw new NotFoundError('Watchlist');
      }
      if (!watchlistService._isBroadcast(watchlist)) {
        throw new ValidationError(
          'Only TradingView-webhook-enabled watchlists can use WEBHOOK entry trigger'
        );
      }
      webhookSlug = await this._generateUniqueSlug();
    }

    const result = await db.run(
      `INSERT INTO strategies (watchlist_id, name, underlying, exchange, is_active, entry_trigger, webhook_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [watchlistId, name, underlying, exchange, 1, entryTrigger, webhookSlug]
    );

    log.info('Strategy created', { id: result.lastID, name, watchlistId });
    return this.getStrategyWithLegs(result.lastID);
  }

  async updateStrategy(strategyId, updates) {
    const existing = await db.get('SELECT * FROM strategies WHERE id = ?', [strategyId]);
    if (!existing) {
      throw new NotFoundError('Strategy');
    }

    // entry_trigger is intentionally not editable here - if that changes, re-apply the same
    // broadcast-watchlist gate createStrategy enforces before allowing WEBHOOK.
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push((updates.name || '').trim());
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(updates.is_active ? 1 : 0);
    }

    if (!fields.length) {
      return this.getStrategyWithLegs(strategyId);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(strategyId);
    await db.run(`UPDATE strategies SET ${fields.join(', ')} WHERE id = ?`, values);

    return this.getStrategyWithLegs(strategyId);
  }

  async deleteStrategy(strategyId) {
    const existing = await db.get('SELECT id FROM strategies WHERE id = ?', [strategyId]);
    if (!existing) {
      throw new NotFoundError('Strategy');
    }
    await db.run('DELETE FROM strategies WHERE id = ?', [strategyId]);
  }

  async addLeg(strategyId, legData) {
    const strategy = await db.get('SELECT id FROM strategies WHERE id = ?', [strategyId]);
    if (!strategy) {
      throw new NotFoundError('Strategy');
    }

    const normalized = this._normalizeLegData(legData);
    const legOrder = parseIntSafe(legData.leg_order, null);
    const resolvedOrder = legOrder ?? (await this._nextLegOrder(strategyId));

    const result = await db.run(
      `INSERT INTO strategy_legs (
        strategy_id, leg_order, option_type, action, strike_policy, strike_offset,
        qty_type, qty_value, product_type,
        target_points, stoploss_points, trailing_stoploss_points, trailing_activation_points,
        exit_mechanism
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategyId,
        resolvedOrder,
        normalized.option_type,
        normalized.action,
        normalized.strike_policy,
        normalized.strike_offset,
        normalized.qty_type,
        normalized.qty_value,
        normalized.product_type,
        normalized.target_points,
        normalized.stoploss_points,
        normalized.trailing_stoploss_points,
        normalized.trailing_activation_points,
        normalized.exit_mechanism,
      ]
    );

    return db.get('SELECT * FROM strategy_legs WHERE id = ?', [result.lastID]);
  }

  async updateLeg(legId, updates) {
    const existing = await db.get('SELECT * FROM strategy_legs WHERE id = ?', [legId]);
    if (!existing) {
      throw new NotFoundError('Strategy leg');
    }
    const normalized = this._normalizeLegData({ ...existing, ...updates });

    await db.run(
      `UPDATE strategy_legs SET
        option_type = ?, action = ?, strike_policy = ?, strike_offset = ?,
        qty_type = ?, qty_value = ?, product_type = ?,
        target_points = ?, stoploss_points = ?, trailing_stoploss_points = ?, trailing_activation_points = ?,
        exit_mechanism = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        normalized.option_type,
        normalized.action,
        normalized.strike_policy,
        normalized.strike_offset,
        normalized.qty_type,
        normalized.qty_value,
        normalized.product_type,
        normalized.target_points,
        normalized.stoploss_points,
        normalized.trailing_stoploss_points,
        normalized.trailing_activation_points,
        normalized.exit_mechanism,
        legId,
      ]
    );

    return db.get('SELECT * FROM strategy_legs WHERE id = ?', [legId]);
  }

  async deleteLeg(legId) {
    const existing = await db.get('SELECT id FROM strategy_legs WHERE id = ?', [legId]);
    if (!existing) {
      throw new NotFoundError('Strategy leg');
    }
    await db.run('DELETE FROM strategy_legs WHERE id = ?', [legId]);
  }

  async findByWebhookSlug(slug) {
    return db.get('SELECT * FROM strategies WHERE webhook_slug = ?', [slug]);
  }

  /**
   * Resolve a single leg's exact tradable symbol WITHOUT placing an order or requiring a full
   * execution - used by the UI to preview Greeks for an option leg before executing. Reuses
   * _resolveLeg directly, the same primitive basket execution uses.
   */
  async previewLeg(legId, instanceId) {
    const leg = await db.get('SELECT * FROM strategy_legs WHERE id = ?', [legId]);
    if (!leg) {
      throw new NotFoundError('Strategy leg');
    }
    const strategy = await db.get('SELECT * FROM strategies WHERE id = ?', [leg.strategy_id]);
    if (!strategy) {
      throw new NotFoundError('Strategy');
    }
    const anchorSymbol = await watchlistSymbolService.findSymbolByWatchlist(
      strategy.watchlist_id, strategy.exchange, strategy.underlying
    );
    if (!anchorSymbol) {
      throw new ValidationError(`Underlying ${strategy.exchange}:${strategy.underlying} must first be added as a symbol in this watchlist`);
    }
    const instance = await this._getSingleActiveInstance(instanceId);
    const resolved = await this._resolveLeg({ leg, anchorSymbol, instance });
    return { legId, ...resolved };
  }

  /**
   * Execute every leg of a strategy. If instanceId is omitted, targets every active,
   * order-enabled instance assigned to the strategy's watchlist (same broadcast convention as
   * quickOrderService._getTargetInstances) rather than requiring the caller to pick one.
   *
   * Legs are resolved to their exact tradable symbol first (reusing quickOrderService's private
   * resolution primitives directly - see _resolveLeg - so MCX/NFO/BFO handling and the
   * broker-then-DB-cache option-chain fallback are identical to manual quick orders), then all
   * legs for a given instance are placed in a single openalgoClient.placeBasketOrder call instead
   * of N sequential placeQuickOrder calls.
   */
  async executeStrategy(strategyId, { instanceId = null, userId = null, source = 'strategy' } = {}) {
    const strategy = await this.getStrategyWithLegs(strategyId);
    if (!strategy.legs.length) {
      throw new ValidationError('Strategy has no legs configured');
    }
    if (!strategy.is_active) {
      throw new ValidationError('Strategy is not active');
    }

    // Anchor symbol: the underlying must already exist as a watchlist symbol in this watchlist
    // (with options/futures trading enabled as appropriate) - strategy execution resolves legs
    // off it rather than bootstrapping new underlying rows.
    const anchorSymbol = await watchlistSymbolService.findSymbolByWatchlist(
      strategy.watchlist_id,
      strategy.exchange,
      strategy.underlying
    );
    if (!anchorSymbol) {
      throw new ValidationError(
        `Underlying ${strategy.exchange}:${strategy.underlying} must first be added as a symbol in this watchlist`
      );
    }

    const instances = instanceId
      ? [await this._getSingleActiveInstance(instanceId)]
      : await this._getWatchlistInstances(strategy.watchlist_id);

    const executionId = `strategy-${strategyId}-${Date.now()}`;

    const settled = await Promise.allSettled(
      instances.map((instance) =>
        this._executeStrategyForInstance({ strategy, anchorSymbol, instance, executionId, userId, source })
      )
    );

    const instanceResults = settled.map((result, idx) => {
      const instance = instances[idx];
      if (result.status === 'fulfilled') {
        return { instanceId: instance.id, instanceName: instance.name, ...result.value };
      }
      log.error('Strategy execution failed for instance', {
        strategyId, instanceId: instance.id, error: result.reason?.message,
      });
      return {
        instanceId: instance.id,
        instanceName: instance.name,
        success: false,
        error: result.reason?.message || 'Execution failed',
        legs: [],
      };
    });

    return {
      strategyId,
      executionId,
      success: instanceResults.every((r) => r.success),
      instances: instanceResults,
    };
  }

  /**
   * Close every still-open leg of a strategy (per strategy_leg_executions - the ledger
   * executeStrategy writes to) across the same instance-targeting rules executeStrategy uses:
   * a single instanceId override, or every active/order-enabled instance assigned to the
   * strategy's watchlist. Reuses quickOrderService.closePosition (the same square-off path the
   * regular EXIT/EXIT_ALL watchlist buttons already use) rather than placing new orders by hand.
   */
  async exitStrategy(strategyId, { instanceId = null, userId = null, source = 'strategy' } = {}) {
    const strategy = await this.getStrategyWithLegs(strategyId);

    const instances = instanceId
      ? [await this._getSingleActiveInstance(instanceId)]
      : await this._getWatchlistInstances(strategy.watchlist_id);

    const settled = await Promise.allSettled(
      instances.map((instance) => this._exitStrategyForInstance({ strategy, instance, userId, source }))
    );

    const instanceResults = settled.map((result, idx) => {
      const instance = instances[idx];
      if (result.status === 'fulfilled') {
        return { instanceId: instance.id, instanceName: instance.name, ...result.value };
      }
      log.error('Strategy exit failed for instance', {
        strategyId, instanceId: instance.id, error: result.reason?.message,
      });
      return {
        instanceId: instance.id,
        instanceName: instance.name,
        success: false,
        error: result.reason?.message || 'Exit failed',
        legs: [],
      };
    });

    return {
      strategyId,
      success: instanceResults.every((r) => r.success),
      instances: instanceResults,
    };
  }

  async _exitStrategyForInstance({ strategy, instance, userId, source }) {
    const openExecutions = await db.all(
      `SELECT * FROM strategy_leg_executions
       WHERE strategy_id = ? AND instance_id = ? AND entry_status = 'PLACED' AND closed_at IS NULL`,
      [strategy.id, instance.id]
    );

    if (!openExecutions.length) {
      return { success: true, legs: [] };
    }

    const legById = new Map(strategy.legs.map((leg) => [leg.id, leg]));
    const legOutcomes = [];

    for (const execRow of openExecutions) {
      const leg = legById.get(execRow.strategy_leg_id);
      try {
        const closeResult = await quickOrderService.closePosition(
          instance,
          { symbol: execRow.resolved_symbol, exchange: execRow.resolved_exchange },
          {
            product: execRow.product,
            tradeMode: leg?.option_type ? 'OPTIONS' : 'FUTURES',
            strategy: `strategy-${strategy.id}`,
          }
        );
        // closePosition -> _closePositions returns {message, closed_count, details:[{success,
        // symbol, order_id}]} (or {message:'No open positions to close', closed_count:0} when
        // the broker already shows it flat) - not a {success, results} shape.
        const detail = Array.isArray(closeResult?.details) ? closeResult.details[0] : null;
        const closeSuccess = closeResult?.closed_count === 0 ? true : Boolean(detail?.success);
        const exitOrderId = detail?.order_id || null;

        await db.run(
          `UPDATE strategy_leg_executions
           SET exit_order_id = ?, exit_status = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [exitOrderId, closeSuccess ? 'CLOSED' : 'FAILED', closeSuccess ? new Date().toISOString() : null, execRow.id]
        );

        if (execRow.exit_mechanism === 'GTT') {
          const gttRow = await db.get(
            `SELECT trigger_id FROM gtt_orders WHERE strategy_leg_id = ? AND instance_id = ? AND status = 'active'`,
            [execRow.strategy_leg_id, instance.id]
          );
          if (gttRow?.trigger_id) {
            try {
              await gttService.cancelGtt(instance.id, gttRow.trigger_id);
            } catch (error) {
              log.warn('Failed to cancel GTT while exiting strategy leg', {
                strategyId: strategy.id, legId: execRow.strategy_leg_id, error: error.message,
              });
            }
          }
        } else {
          const symbolRow = await watchlistSymbolService.findSymbolByWatchlist(
            strategy.watchlist_id, execRow.resolved_exchange, execRow.resolved_symbol
          );
          if (symbolRow) {
            await watchlistSymbolService.updateSymbol(symbolRow.id, { is_enabled: 0 });
          }
        }

        await riskEventsService.record({
          instanceId: instance.id,
          watchlistId: strategy.watchlist_id,
          exchange: execRow.resolved_exchange,
          symbol: execRow.resolved_symbol,
          eventType: 'STRATEGY_LEG_EXIT',
          metadata: { strategyId: strategy.id, legId: execRow.strategy_leg_id, userId, source },
        });

        legOutcomes.push({
          legId: execRow.strategy_leg_id,
          success: closeSuccess,
          resolvedSymbol: execRow.resolved_symbol,
          exitOrderId,
          error: closeSuccess ? null : 'Exit order failed',
        });
      } catch (error) {
        log.warn('Failed to exit strategy leg', { strategyId: strategy.id, legId: execRow.strategy_leg_id, error: error.message });
        legOutcomes.push({ legId: execRow.strategy_leg_id, success: false, error: error.message });
      }
    }

    return {
      success: legOutcomes.every((l) => l.success),
      legs: legOutcomes,
    };
  }

  /**
   * Live execution status for a strategy: every leg execution row (open + recently-closed),
   * joined with cached position/quote data for P&L - no new polling, just reads of caches
   * marketDataFeedService already keeps warm.
   */
  async getExecutionStatus(strategyId) {
    const strategy = await this.getStrategyWithLegs(strategyId);
    const rows = await db.all(
      `SELECT sle.*, i.name AS instance_name
       FROM strategy_leg_executions sle
       JOIN instances i ON i.id = sle.instance_id
       WHERE sle.strategy_id = ?
       ORDER BY sle.created_at DESC
       LIMIT 200`,
      [strategyId]
    );

    const legById = new Map(strategy.legs.map((leg) => [leg.id, leg]));

    const executions = rows.map((row) => {
      const leg = legById.get(row.strategy_leg_id);
      const isOpen = !row.closed_at;
      let ltp = null;
      let pnl = null;

      if (isOpen) {
        const position = marketDataFeedService.getCachedPositionForSymbol(
          row.instance_id, row.resolved_symbol, row.resolved_exchange
        );
        if (position) {
          ltp = parseFloatSafe(position.ltp ?? position.last_price, null);
          pnl = parseFloatSafe(position.pnl ?? position.unrealised_pnl ?? position.unrealisedPnl, null);
        }
      }

      return {
        legId: row.strategy_leg_id,
        legAction: leg?.action || null,
        legOptionType: leg?.option_type || null,
        instanceId: row.instance_id,
        instanceName: row.instance_name,
        resolvedSymbol: row.resolved_symbol,
        resolvedExchange: row.resolved_exchange,
        quantity: row.quantity,
        product: row.product,
        entryOrderId: row.entry_order_id,
        entryStatus: row.entry_status,
        exitOrderId: row.exit_order_id,
        exitStatus: row.exit_status,
        exitMechanism: row.exit_mechanism,
        ltp,
        pnl,
        isOpen,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
      };
    });

    return {
      strategyId,
      hasExecutions: executions.length > 0,
      hasOpenLegs: executions.some((e) => e.isOpen),
      executions,
    };
  }

  async _getSingleActiveInstance(instanceId) {
    const instance = await instanceService.getInstanceById(instanceId);
    if (!instance || !instance.is_active) {
      throw new ValidationError('Instance not found or inactive');
    }
    return instance;
  }

  // Mirrors quickOrderService._getTargetInstances(null, watchlistId) - same broadcast convention
  // used by manual quick orders and TradingView webhook broadcasts.
  async _getWatchlistInstances(watchlistId) {
    const instances = await db.all(
      `SELECT i.* FROM instances i
       JOIN watchlist_instances wi ON i.id = wi.instance_id
       WHERE wi.watchlist_id = ?
         AND i.is_active = 1
         AND i.order_placement_enabled = 1`,
      [watchlistId]
    );
    if (!instances.length) {
      throw new ValidationError('No active, order-enabled instances assigned to this watchlist');
    }
    return instances;
  }

  /**
   * Resolve every leg, batch-place via basketorder, then apply the same per-leg side effects
   * (exit-config upsert, risk-event logging, order-history row) as the previous per-leg
   * placeQuickOrder path.
   */
  async _executeStrategyForInstance({ strategy, anchorSymbol, instance, executionId, userId, source }) {
    // Resolve phase - no order placement yet.
    const resolved = [];
    for (const leg of strategy.legs) {
      try {
        const r = await this._resolveLeg({ leg, anchorSymbol, instance });
        resolved.push({ leg, ...r, error: null });
      } catch (error) {
        resolved.push({ leg, error: error.message });
      }
    }

    // Quantity phase.
    for (const r of resolved) {
      if (r.error) continue;
      try {
        r.quantity = await this._resolveLegQuantity({
          leg: r.leg,
          anchorSymbol: { ...anchorSymbol, lot_size: r.lot_size || anchorSymbol.lot_size },
          instance,
          strategy,
        });
        if (!r.quantity || r.quantity <= 0) {
          r.error = 'Resolved quantity is zero';
        }
      } catch (error) {
        r.error = error.message;
      }
    }

    const orderable = resolved.filter((r) => !r.error);
    const unresolved = resolved.filter((r) => r.error);

    if (!orderable.length) {
      return {
        success: false,
        legs: resolved.map((r) => ({ legId: r.leg.id, success: false, error: r.error })),
      };
    }

    // Margin preview - batches all resolved legs into ONE calculateMargin call (the existing
    // /margin endpoint already supports up to 50 positions with hedging benefits; there is no
    // separate "basket margin" endpoint). Best-effort: a preview failure doesn't block execution.
    let marginPreview = null;
    try {
      const positions = orderable.map((r) => ({
        symbol: r.symbol,
        exchange: r.exchange,
        action: r.leg.action,
        quantity: r.quantity,
        product: r.product,
        pricetype: 'MARKET',
      }));
      marginPreview = await openalgoClient.calculateMargin(instance, positions);
    } catch (error) {
      log.warn('Strategy margin preview failed', { strategyId: strategy.id, instanceId: instance.id, error: error.message });
    }

    // Batch placement - one broker call for every resolved leg on this instance.
    const basketOrders = orderable.map((r) => ({
      symbol: r.symbol,
      exchange: r.exchange,
      action: r.leg.action,
      quantity: r.quantity,
      pricetype: 'MARKET',
      product: r.product,
    }));

    const basketResponse = await openalgoClient.placeBasketOrder(instance, {
      strategy: `strategy-${strategy.id}`,
      orders: basketOrders,
    });
    const basketResults = Array.isArray(basketResponse?.results) ? basketResponse.results : [];

    const legOutcomes = [];
    for (let i = 0; i < orderable.length; i++) {
      const r = orderable[i];
      // OpenAlgo's basketorder response preserves request order, so results[i] corresponds to
      // orders[i] - matching positionally rather than by symbol avoids ambiguity when the same
      // symbol legitimately appears in two legs (e.g. a calendar spread).
      const basketResult = basketResults[i];
      const legSuccess = basketResult?.status === 'success';
      const isOption = Boolean(r.leg.option_type);

      if (legSuccess) {
        if (r.leg.exit_mechanism === 'GTT') {
          await this._placeLegExitGtt({
            strategy, leg: r.leg, instance, exchange: r.exchange, symbol: r.symbol,
            quantity: r.quantity, product: r.product, orderId: basketResult?.orderid,
            watchlistId: strategy.watchlist_id, anchorSymbol,
          });
        } else {
          await this._upsertLegExitConfig({
            watchlistId: strategy.watchlist_id,
            exchange: r.exchange,
            symbol: r.symbol,
            symbolType: isOption ? 'OPTIONS' : (anchorSymbol.symbol_type === 'FUTURES' ? 'FUTURES' : 'EQUITY'),
            underlyingSymbol: strategy.underlying,
            leg: r.leg,
          });
        }

        await riskEventsService.record({
          instanceId: instance.id,
          watchlistId: strategy.watchlist_id,
          symbolId: anchorSymbol.id,
          exchange: r.exchange,
          symbol: r.symbol,
          eventType: 'STRATEGY_LEG_ENTRY',
          metadata: { strategyId: strategy.id, legId: r.leg.id, action: r.leg.action, quantity: r.quantity, executionId },
        });
      }

      // Preserve order-history visibility parity with the old placeQuickOrder path, which wrote
      // to watchlist_orders internally - basketorder bypasses that pipeline entirely, so record
      // it here.
      try {
        await orderRepository.insertWatchlistOrder({
          watchlistId: strategy.watchlist_id,
          instanceId: instance.id,
          symbolId: anchorSymbol.id,
          exchange: r.exchange,
          symbol: r.symbol,
          side: r.leg.action,
          quantity: r.quantity,
          orderType: 'MARKET',
          productType: r.product,
          price: 0,
          trigger_price: 0,
          status: legSuccess ? 'open' : 'rejected',
          orderId: basketResult?.orderid || null,
          message: basketResult?.message || null,
          metadata: { strategyId: strategy.id, legId: r.leg.id, executionId, source: 'basketorder' },
          user_id: userId,
          source,
          trigger_type: 'Strategy',
          correlation_id: executionId,
        });
      } catch (error) {
        log.warn('Failed to record strategy leg order history', { strategyId: strategy.id, legId: r.leg.id, error: error.message });
      }

      // Durable per-leg-per-instance execution ledger - the source of truth exitStrategy and
      // the status view read from (watchlist_orders/risk_events only carry this loosely inside
      // a metadata JSON blob, not as an indexed/FK-joinable column).
      try {
        await db.run(
          `INSERT INTO strategy_leg_executions
             (strategy_id, strategy_leg_id, instance_id, execution_id, resolved_symbol, resolved_exchange,
              quantity, product, entry_order_id, entry_status, exit_mechanism, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            strategy.id, r.leg.id, instance.id, executionId, r.symbol, r.exchange,
            r.quantity, r.product, basketResult?.orderid || null,
            legSuccess ? 'PLACED' : 'FAILED', r.leg.exit_mechanism || 'POLLING',
            legSuccess ? new Date().toISOString() : null,
          ]
        );
      } catch (error) {
        log.warn('Failed to record strategy leg execution ledger row', { strategyId: strategy.id, legId: r.leg.id, error: error.message });
      }

      legOutcomes.push({
        legId: r.leg.id,
        success: legSuccess,
        resolvedSymbol: r.symbol,
        resolvedExchange: r.exchange,
        quantity: r.quantity,
        orderId: basketResult?.orderid || null,
        error: legSuccess ? null : (basketResult?.message || 'Order failed'),
      });
    }

    for (const u of unresolved) {
      legOutcomes.push({ legId: u.leg.id, success: false, error: u.error });
    }

    return {
      success: legOutcomes.every((l) => l.success),
      marginPreview,
      legs: legOutcomes,
    };
  }

  /**
   * Resolve a leg to its exact tradable {symbol, exchange, lot_size, product} WITHOUT placing an
   * order. Reuses quickOrderService's internal resolution primitives directly (not a
   * reimplementation) so MCX/NFO/BFO exchange handling and the broker-then-DB-cache option-chain
   * fallback stay in exactly one place. Non-option legs (equity/futures) need no runtime
   * resolution at all - the anchor watchlist_symbols row already IS the tradable instrument.
   */
  async _resolveLeg({ leg, anchorSymbol, instance }) {
    const isOption = Boolean(leg.option_type);

    if (!isOption) {
      const tradeMode = anchorSymbol.symbol_type === 'FUTURES' ? 'FUTURES' : 'EQUITY';
      return {
        symbol: anchorSymbol.symbol,
        exchange: anchorSymbol.exchange,
        lot_size: anchorSymbol.lot_size,
        product: quickOrderService._resolveProductForOrder(leg.product_type, tradeMode, anchorSymbol),
      };
    }

    const resolution = await quickOrderService._resolveOptionSymbolForInstance(instance, anchorSymbol, {
      action: `${leg.action}_${leg.option_type}`,
      expiry: null,
      optionsLeg: leg.strike_offset,
    });
    const optionSymbol = resolution.optionSymbol;
    if (!optionSymbol?.symbol) {
      throw new Error('Unable to resolve option contract for this leg');
    }

    return {
      symbol: optionSymbol.symbol,
      exchange: optionSymbol.exchange,
      lot_size: optionSymbol.lot_size,
      product: quickOrderService._resolveProductForOrder(leg.product_type, 'OPTIONS', {
        symbol_type: 'OPTIONS',
        exchange: optionSymbol.exchange,
      }),
    };
  }

  async _resolveLegQuantity({ leg, anchorSymbol, instance, strategy }) {
    // For MARGIN_BASED legs, qty_value doubles as the margin_utilization_pct (0-1)
    // rather than a lot/fixed count, since strategy_legs has no separate column for it.
    if (leg.qty_type === 'MARGIN_BASED') {
      const { quantity } = await marginSizingService.computeLotQuantity({
        instance,
        symbolConfig: { ...anchorSymbol, margin_utilization_pct: leg.qty_value },
        orderContext: {
          exchange: strategy.exchange,
          symbol: strategy.underlying,
          action: leg.action,
          product: leg.product_type,
        },
        watchlistId: strategy.watchlist_id,
      });
      if (!quantity || quantity <= 0) {
        throw new Error('Insufficient margin to size this leg');
      }
      return quantity;
    }

    const lotSize = Number(anchorSymbol.lot_size) > 0 ? Number(anchorSymbol.lot_size) : 1;
    const qtyValue = Number(leg.qty_value) > 0 ? Number(leg.qty_value) : 1;
    return leg.qty_type === 'FIXED' ? qtyValue : qtyValue * lotSize;
  }

  /**
   * Place a broker-side GTT exit for a leg instead of upserting the polling-based exit config.
   * Needs the actual fill price (not the pre-fill quote) to compute accurate trigger prices, so
   * this looks up the just-placed order's status first. Best-effort: on any failure this logs a
   * warning and leaves the leg without an automated exit rather than failing the whole execution
   * (the entry order has already gone through by this point) - the leg can be re-armed via a
   * manual GTT placement or switched back to 'POLLING' and edited with target/stop config.
   */
  async _placeLegExitGtt({ strategy, leg, instance, exchange, symbol, quantity, product, orderId, watchlistId, anchorSymbol }) {
    if (!leg.target_points && !leg.stoploss_points) {
      return; // nothing configured to protect with a GTT
    }
    if (!orderId) {
      log.warn('Skipping GTT exit - no order id from basket placement', { strategyId: strategy.id, legId: leg.id });
      return;
    }

    try {
      const status = await openalgoClient.getOrderStatus(instance, { orderid: orderId, strategy: `strategy-${strategy.id}` });
      const entryPrice = parseFloatSafe(status?.average_price, null);
      if (!entryPrice || entryPrice <= 0) {
        log.warn('Skipping GTT exit - could not resolve fill price', { strategyId: strategy.id, legId: leg.id, orderId });
        return;
      }

      await gttService.placeExitGtt(instance, {
        strategy: `strategy-${strategy.id}`,
        exchange,
        symbol,
        action: leg.action,
        product,
        quantity,
        entryPrice,
        stoplossPoints: leg.stoploss_points,
        targetPoints: leg.target_points,
        watchlistId,
        symbolId: anchorSymbol.id,
        strategyLegId: leg.id,
      });
    } catch (error) {
      log.warn('Failed to place GTT exit for strategy leg', { strategyId: strategy.id, legId: leg.id, error: error.message });
    }
  }

  /**
   * Upsert a watchlist_symbols row for the leg's resolved instrument, carrying this leg's own
   * target/stoploss/trailing config. This is what lets the existing AutoExitService polling loop
   * (which matches live broker positions against watchlist_symbols by exact symbol, or by
   * underlying prefix) manage this leg's exit without any changes to that loop.
   */
  async _upsertLegExitConfig({ watchlistId, exchange, symbol, symbolType, underlyingSymbol, leg }) {
    const modeSuffix = symbolType === 'OPTIONS' ? 'options' : symbolType === 'FUTURES' ? 'futures' : 'direct';
    const exitConfig = {
      [`target_points_${modeSuffix}`]: leg.target_points,
      [`stoploss_points_${modeSuffix}`]: leg.stoploss_points,
      [`trailing_stoploss_points_${modeSuffix}`]: leg.trailing_stoploss_points,
      [`trailing_activation_points_${modeSuffix}`]: leg.trailing_activation_points,
    };

    const hasAnyExitConfig = Object.values(exitConfig).some((v) => v !== null && v !== undefined);
    if (!hasAnyExitConfig) {
      return;
    }

    const existing = await watchlistSymbolService.findSymbolByWatchlist(watchlistId, exchange, symbol);
    if (existing) {
      await watchlistSymbolService.updateSymbol(existing.id, exitConfig);
      return;
    }

    await watchlistSymbolService.addSymbol(watchlistId, {
      exchange,
      symbol,
      symbol_type: symbolType,
      underlying_symbol: underlyingSymbol,
      lot_size: 1,
      qty_type: 'FIXED',
      qty_value: 1,
      is_enabled: 1,
      ...exitConfig,
    });
  }

  async _nextLegOrder(strategyId) {
    const row = await db.get(
      'SELECT COALESCE(MAX(leg_order), -1) as maxOrder FROM strategy_legs WHERE strategy_id = ?',
      [strategyId]
    );
    return (row?.maxOrder ?? -1) + 1;
  }

  async _generateUniqueSlug() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const slug = `strat-${crypto.randomBytes(6).toString('hex')}`;
      const existing = await db.get('SELECT id FROM strategies WHERE webhook_slug = ?', [slug]);
      if (!existing) return slug;
    }
  }

  _normalizeLegData(data) {
    const action = data.action;
    if (!VALID_ACTIONS.includes(action)) {
      throw new ValidationError(`action must be one of: ${VALID_ACTIONS.join(', ')}`);
    }

    const optionType = data.option_type || null;
    if (optionType && !VALID_OPTION_TYPES.includes(optionType)) {
      throw new ValidationError(`option_type must be one of: ${VALID_OPTION_TYPES.join(', ')}`);
    }

    const strikePolicy = data.strike_policy && VALID_STRIKE_POLICIES.includes(data.strike_policy)
      ? data.strike_policy
      : 'FLOAT_OFS';

    const qtyType = data.qty_type && VALID_QTY_TYPES.includes(data.qty_type) ? data.qty_type : 'LOTS';
    const exitMechanism = VALID_EXIT_MECHANISMS.includes(data.exit_mechanism) ? data.exit_mechanism : 'POLLING';
    if (exitMechanism === 'GTT' && String(data.product_type || '').toUpperCase() === 'MIS') {
      throw new ValidationError('GTT exit mechanism is not supported for MIS product - use NRML/CNC or switch to POLLING');
    }

    return {
      option_type: optionType,
      action,
      strike_policy: strikePolicy,
      strike_offset: optionType ? (data.strike_offset || 'ATM') : null,
      qty_type: qtyType,
      qty_value: parseFloatSafe(data.qty_value, 1),
      product_type: data.product_type || 'MIS',
      target_points: parseFloatSafe(data.target_points, null),
      stoploss_points: parseFloatSafe(data.stoploss_points, null),
      trailing_stoploss_points: parseFloatSafe(data.trailing_stoploss_points, null),
      trailing_activation_points: parseFloatSafe(data.trailing_activation_points, null),
      exit_mechanism: exitMechanism,
    };
  }
}

const strategyService = new StrategyService();
export default strategyService;
