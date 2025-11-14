/**
 * Order Monitor Service
 * Monitors positions and triggers exits when targets/SL/TSL are hit
 * Phase 1: Analyzer mode only, single target monitoring
 */

import db from '../core/database.js';
import log from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import telegramService from './telegram.service.js';
import { parseIntSafe, parseFloatSafe } from '../utils/sanitizers.js';

class OrderMonitorService {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.checkedPositions = new Map(); // Prevent duplicate triggers
    this.monitorIntervalMs = 5000; // 5 seconds
  }

  /**
   * Start monitoring
   */
  async start() {
    if (this.isMonitoring) {
      log.warn('Order monitor already running');
      return;
    }

    this.isMonitoring = true;

    // Run monitoring loop
    this.monitorInterval = setInterval(
      () => this.monitorAllPositions(),
      this.monitorIntervalMs
    );

    log.info('Order monitor started', {
      interval_ms: this.monitorIntervalMs,
    });

    // Run immediately on start
    await this.monitorAllPositions();
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isMonitoring = false;
    log.info('Order monitor stopped');
  }

  /**
   * Main monitoring loop
   */
  async monitorAllPositions() {
    try {
      const startTime = Date.now();

      // Phase 1: Only monitor ANALYZER mode instances
      const instances = await db.all(`
        SELECT * FROM instances
        WHERE is_active = 1 AND is_analyzer_mode = 1
      `);

      if (instances.length === 0) {
        log.debug('No analyzer instances to monitor');
        return;
      }

      log.debug('Monitoring analyzer instances', { count: instances.length });

      // Monitor each instance
      for (const instance of instances) {
        await this.monitorInstance(instance);
      }

      const duration = Date.now() - startTime;
      log.debug('Monitor cycle completed', {
        instances: instances.length,
        duration_ms: duration,
      });
    } catch (error) {
      log.error('Monitor loop failed', error);
    }
  }

  /**
   * Monitor single instance
   */
  async monitorInstance(instance) {
    try {
      // Fetch position book from broker
      const positionsResponse = await openalgoClient.getPositionBook(instance);

      if (!positionsResponse || !positionsResponse.data) {
        log.debug('No positions data', { instance: instance.id });
        return;
      }

      const positions = positionsResponse.data;

      // Filter only open positions
      const openPositions = positions.filter((p) => {
        const qty = this._getPositionQuantity(p);
        return qty !== 0;
      });

      log.debug('Monitoring positions', {
        instance: instance.id,
        total: positions.length,
        open: openPositions.length,
      });

      // Check each position
      for (const position of openPositions) {
        await this.checkPosition(instance, position);
      }
    } catch (error) {
      log.error('Instance monitor failed', {
        instance: instance.id,
        error: error.message,
      });
    }
  }

  /**
   * Check single position for triggers
   */
  async checkPosition(instance, position) {
    try {
      // Normalize position data
      const symbol = position.symbol || position.tradingsymbol;
      const exchange = position.exchange;
      const quantity = this._getPositionQuantity(position);
      const entryPrice = parseFloat(
        position.average_price || position.avgprice || position.avg_price || 0
      );
      const currentPrice = parseFloat(
        position.ltp || position.last_price || position.lastprice || 0
      );

      if (!symbol || !exchange) {
        log.debug('Invalid position data (missing symbol/exchange)');
        return;
      }

      if (entryPrice === 0 || currentPrice === 0) {
        log.debug('Invalid price data', { symbol, entryPrice, currentPrice });
        return;
      }

      // Try to match to watchlist symbol
      const watchlistSymbol = await this.matchToWatchlist(symbol, exchange);

      if (!watchlistSymbol) {
        // Not in watchlist, skip
        return;
      }

      // Check if target configured
      if (
        watchlistSymbol.target_type === 'NONE' ||
        !watchlistSymbol.target_value
      ) {
        // No target set, skip
        return;
      }

      // Create position key to prevent duplicate triggers
      const positionKey = `${instance.id}:${symbol}:${exchange}`;

      // Check if already triggered (within last hour)
      if (this.checkedPositions.has(positionKey)) {
        const triggeredAt = this.checkedPositions.get(positionKey);
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        if (triggeredAt > oneHourAgo) {
          // Already triggered recently, skip
          return;
        }
      }

      // Determine position side (LONG or SHORT)
      const side = quantity > 0 ? 'LONG' : 'SHORT';

      // Evaluate target
      const targetHit = this.evaluateTarget(
        entryPrice,
        currentPrice,
        watchlistSymbol.target_type,
        watchlistSymbol.target_value,
        side
      );

      if (targetHit) {
        log.info('Target hit detected', {
          instance: instance.id,
          symbol,
          exchange,
          entry: entryPrice,
          current: currentPrice,
          target_type: watchlistSymbol.target_type,
          target_value: watchlistSymbol.target_value,
        });

        // Mark as checked
        this.checkedPositions.set(positionKey, Date.now());

        // Execute simulated exit
        await this.simulateExit(
          instance,
          position,
          watchlistSymbol,
          currentPrice,
          side
        );

        // Clean up old checked positions
        this.cleanupCheckedPositions();
      }
    } catch (error) {
      log.error('Check position failed', {
        error: error.message,
        instance: instance.id,
      });
    }
  }

  /**
   * Evaluate if target is hit
   */
  evaluateTarget(entryPrice, currentPrice, targetType, targetValue, side) {
    let targetPrice;

    if (targetType === 'POINTS') {
      targetPrice =
        side === 'LONG' ? entryPrice + targetValue : entryPrice - targetValue;
    } else if (targetType === 'PERCENTAGE') {
      targetPrice =
        side === 'LONG'
          ? entryPrice * (1 + targetValue / 100)
          : entryPrice * (1 - targetValue / 100);
    } else {
      return false;
    }

    // Check if target hit
    if (side === 'LONG') {
      return currentPrice >= targetPrice;
    } else {
      return currentPrice <= targetPrice;
    }
  }

  /**
   * Simulate exit in analyzer mode
   */
  async simulateExit(instance, position, watchlistSymbol, exitPrice, side) {
    const symbol = position.symbol || position.tradingsymbol;
    const exchange = position.exchange;
    const quantity = Math.abs(this._getPositionQuantity(position));
    const entryPrice = parseFloat(
      position.average_price || position.avgprice || position.avg_price || 0
    );

    // Calculate P&L
    const pnl =
      side === 'LONG'
        ? (exitPrice - entryPrice) * quantity
        : (entryPrice - exitPrice) * quantity;

    // Log to order_monitor_log
    await db.run(
      `
      INSERT INTO order_monitor_log
      (instance_id, symbol, exchange, trigger_type, entry_price, trigger_price,
       target_value, exit_quantity, is_analyzer_mode, simulated_pnl, exit_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        instance.id,
        symbol,
        exchange,
        'TARGET',
        entryPrice,
        exitPrice,
        watchlistSymbol.target_value,
        quantity,
        1, // is_analyzer_mode
        pnl,
        'SIMULATED',
      ]
    );

    // Log to analyzer_trades
    await db.run(
      `
      INSERT INTO analyzer_trades
      (instance_id, symbol, exchange, side, quantity, price, trade_type, pnl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        instance.id,
        symbol,
        exchange,
        side === 'LONG' ? 'SELL' : 'BUY', // Exit side
        quantity,
        exitPrice,
        'TARGET',
        pnl,
      ]
    );

    // Send Telegram notification
    await this.sendTelegramAlert(instance, {
      type: 'TARGET_HIT',
      position: {
        symbol,
        exchange,
        side,
        quantity,
        entry_price: entryPrice,
        instance_name: instance.name,
      },
      trigger: {
        exit_price: exitPrice,
        exit_quantity: quantity,
      },
      pnl,
    });

    log.info('Target hit - simulated exit', {
      instance: instance.id,
      symbol,
      exchange,
      side,
      entry: entryPrice,
      exit: exitPrice,
      quantity,
      pnl: pnl.toFixed(2),
    });
  }

  /**
   * Send Telegram alert for triggered exit
   */
  async sendTelegramAlert(instance, alert) {
    try {
      // Get first admin user (Phase 1: single user)
      // TODO: In Phase 2, send to all users with access to this instance
      const user = await db.get(
        'SELECT * FROM users WHERE is_admin = 1 LIMIT 1'
      );

      if (!user) {
        log.warn('No admin user found for Telegram alert');
        return;
      }

      await telegramService.sendAlert(user.id, alert);
    } catch (error) {
      log.error('Telegram alert failed', { error: error.message });
    }
  }

  /**
   * Match position to watchlist symbol
   */
  async matchToWatchlist(symbol, exchange) {
    // Try exact match first
    let match = await db.get(
      `
      SELECT * FROM watchlist_symbols
      WHERE symbol = ? AND exchange = ?
      AND is_enabled = 1
      LIMIT 1
    `,
      [symbol, exchange]
    );

    if (match) {
      return match;
    }

    // TODO: Phase 2 - Add fuzzy matching for broker-specific symbol variations
    // For now, only exact match

    return null;
  }

  /**
   * Clean up old checked positions
   */
  cleanupCheckedPositions() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [key, timestamp] of this.checkedPositions.entries()) {
      if (timestamp < oneHourAgo) {
        this.checkedPositions.delete(key);
      }
    }
  }

  /**
   * Get normalized quantity from position
   */
  _getPositionQuantity(pos) {
    const rawQty =
      pos.quantity ??
      pos.netqty ??
      pos.net_quantity ??
      pos.netQty ??
      pos.net ??
      0;
    return parseIntSafe(rawQty, 0);
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      is_monitoring: this.isMonitoring,
      interval_ms: this.monitorIntervalMs,
      checked_positions_count: this.checkedPositions.size,
    };
  }
}

export default new OrderMonitorService();
