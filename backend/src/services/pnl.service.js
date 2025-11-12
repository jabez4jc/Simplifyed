/**
 * P&L Calculation Service
 * Handles realized, unrealized, and total P&L calculations
 */

import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { parseFloatSafe } from '../utils/sanitizers.js';

class PnLService {
  /**
   * Calculate realized P&L from tradebook
   * Groups trades by symbol and calculates closed position P&L
   *
   * @param {Array} trades - Tradebook array from OpenAlgo
   * @returns {Object} - { symbolPnL: {}, totalRealized: number }
   */
  calculateRealizedPnL(trades) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { symbolPnL: {}, totalRealized: 0 };
    }

    const symbolPnL = {};
    let totalRealized = 0;

    // Group trades by symbol
    const tradesBySymbol = {};
    for (const trade of trades) {
      const symbol = trade.symbol || trade.tradingsymbol;
      if (!symbol) continue;

      if (!tradesBySymbol[symbol]) {
        tradesBySymbol[symbol] = [];
      }
      tradesBySymbol[symbol].push(trade);
    }

    // Calculate P&L per symbol
    for (const [symbol, symbolTrades] of Object.entries(tradesBySymbol)) {
      const pnl = this._calculateSymbolRealizedPnL(symbolTrades);
      symbolPnL[symbol] = pnl;
      totalRealized += pnl;
    }

    return { symbolPnL, totalRealized };
  }

  /**
   * Calculate realized P&L for a single symbol
   * Uses FIFO (First In First Out) matching
   *
   * @private
   * @param {Array} trades - Trades for a single symbol
   * @returns {number} - Realized P&L
   */
  _calculateSymbolRealizedPnL(trades) {
    // If trades already have pnl field, sum them up
    const hasPnlField = trades.some(t => t.pnl !== undefined);
    if (hasPnlField) {
      return trades.reduce((sum, trade) => {
        const pnl = parseFloatSafe(trade.pnl, 0);
        return sum + pnl;
      }, 0);
    }

    // Otherwise, calculate using FIFO matching
    const buyQueue = [];
    const sellQueue = [];
    let realizedPnL = 0;

    // Sort trades by time
    const sortedTrades = [...trades].sort((a, b) => {
      const timeA = new Date(a.time || a.timestamp || 0).getTime();
      const timeB = new Date(b.time || b.timestamp || 0).getTime();
      return timeA - timeB;
    });

    // Process trades
    for (const trade of sortedTrades) {
      const side = (trade.side || trade.transaction_type || '').toUpperCase();
      const quantity = parseFloatSafe(trade.quantity || trade.qty, 0);
      const price = parseFloatSafe(trade.price || trade.average_price, 0);

      if (quantity <= 0 || price <= 0) continue;

      if (side === 'BUY') {
        // Check if we have pending sells to match
        while (sellQueue.length > 0 && quantity > 0) {
          const sell = sellQueue[0];
          const matchQty = Math.min(quantity, sell.quantity);

          // Calculate P&L for matched quantity
          realizedPnL += matchQty * (sell.price - price);

          // Update quantities
          sell.quantity -= matchQty;
          if (sell.quantity <= 0) {
            sellQueue.shift();
          }
        }

        // If quantity remains, add to buy queue
        if (quantity > 0) {
          buyQueue.push({ quantity, price });
        }
      } else if (side === 'SELL') {
        // Check if we have pending buys to match
        while (buyQueue.length > 0 && quantity > 0) {
          const buy = buyQueue[0];
          const matchQty = Math.min(quantity, buy.quantity);

          // Calculate P&L for matched quantity
          realizedPnL += matchQty * (price - buy.price);

          // Update quantities
          buy.quantity -= matchQty;
          if (buy.quantity <= 0) {
            buyQueue.shift();
          }
        }

        // If quantity remains, add to sell queue
        if (quantity > 0) {
          sellQueue.push({ quantity, price });
        }
      }
    }

    return realizedPnL;
  }

  /**
   * Calculate unrealized P&L from positionbook
   *
   * @param {Array} positions - Positionbook array from OpenAlgo
   * @returns {Object} - { symbolPnL: {}, totalUnrealized: number }
   */
  calculateUnrealizedPnL(positions) {
    if (!Array.isArray(positions) || positions.length === 0) {
      return { symbolPnL: {}, totalUnrealized: 0 };
    }

    const symbolPnL = {};
    let totalUnrealized = 0;

    for (const position of positions) {
      const symbol = position.symbol || position.tradingsymbol;
      if (!symbol) continue;

      // Check if position is open
      const quantity = parseFloatSafe(
        position.quantity || position.netqty || position.net_quantity,
        0
      );

      if (quantity === 0) continue;

      // Get P&L from position data
      const pnl = parseFloatSafe(
        position.pnl || position.unrealized_pnl || position.mtm,
        0
      );

      symbolPnL[symbol] = (symbolPnL[symbol] || 0) + pnl;
      totalUnrealized += pnl;
    }

    return { symbolPnL, totalUnrealized };
  }

  /**
   * Get complete P&L data for an instance
   * Fetches tradebook and positionbook, calculates all P&L metrics
   *
   * @param {Object} instance - Instance object with host_url and api_key
   * @returns {Promise<Object>} - Complete P&L breakdown
   */
  async getInstancePnL(instance) {
    try {
      // Fetch data from OpenAlgo
      const [tradebook, positionbook, funds] = await Promise.all([
        openalgoClient.getTradeBook(instance).catch(() => []),
        openalgoClient.getPositionBook(instance).catch(() => []),
        openalgoClient.getFunds(instance).catch(() => null),
      ]);

      // Calculate realized P&L
      const realized = this.calculateRealizedPnL(tradebook);

      // Calculate unrealized P&L
      const unrealized = this.calculateUnrealizedPnL(positionbook);

      // Combine symbol-level P&L
      const symbolBreakdown = {};
      const allSymbols = new Set([
        ...Object.keys(realized.symbolPnL),
        ...Object.keys(unrealized.symbolPnL),
      ]);

      for (const symbol of allSymbols) {
        symbolBreakdown[symbol] = {
          realized: realized.symbolPnL[symbol] || 0,
          unrealized: unrealized.symbolPnL[symbol] || 0,
          total: (realized.symbolPnL[symbol] || 0) + (unrealized.symbolPnL[symbol] || 0),
        };
      }

      // Account totals
      const totalPnL = realized.totalRealized + unrealized.totalUnrealized;

      // Get current balance from funds
      const currentBalance = funds
        ? parseFloatSafe(funds.availablecash, 0)
        : 0;

      return {
        accountTotals: {
          realized_pnl: realized.totalRealized,
          unrealized_pnl: unrealized.totalUnrealized,
          total_pnl: totalPnL,
          current_balance: currentBalance,
        },
        symbolBreakdown,
        metadata: {
          total_symbols: allSymbols.size,
          open_positions: positionbook.filter(p => {
            const qty = parseFloatSafe(
              p.quantity || p.netqty || p.net_quantity,
              0
            );
            return qty !== 0;
          }).length,
          total_trades: tradebook.length,
        },
      };
    } catch (error) {
      log.error('Failed to get instance P&L', error, {
        instance_id: instance.id,
        instance_name: instance.name,
      });
      throw error;
    }
  }

  /**
   * Get aggregated P&L across multiple instances
   *
   * @param {Array} instances - Array of instance objects
   * @returns {Promise<Object>} - Aggregated P&L data
   */
  async getAggregatedPnL(instances) {
    if (!Array.isArray(instances) || instances.length === 0) {
      return {
        totalPnL: {
          realized_pnl: 0,
          unrealized_pnl: 0,
          total_pnl: 0,
          current_balance: 0,
        },
        instanceBreakdown: {},
        symbolBreakdown: {},
        metadata: {
          total_instances: 0,
          active_instances: 0,
          total_symbols: 0,
          total_positions: 0,
          total_trades: 0,
        },
      };
    }

    try {
      // Fetch P&L for all instances in parallel
      const results = await Promise.allSettled(
        instances.map(instance => this.getInstancePnL(instance))
      );

      const totalPnL = {
        realized_pnl: 0,
        unrealized_pnl: 0,
        total_pnl: 0,
        current_balance: 0,
      };

      const instanceBreakdown = {};
      const symbolBreakdown = {};
      let totalSymbols = new Set();
      let totalPositions = 0;
      let totalTrades = 0;
      let activeInstances = 0;

      // Aggregate results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const instance = instances[i];

        if (result.status === 'fulfilled') {
          const pnl = result.value;
          activeInstances++;

          // Add to totals
          totalPnL.realized_pnl += pnl.accountTotals.realized_pnl;
          totalPnL.unrealized_pnl += pnl.accountTotals.unrealized_pnl;
          totalPnL.total_pnl += pnl.accountTotals.total_pnl;
          totalPnL.current_balance += pnl.accountTotals.current_balance;

          // Store instance breakdown
          instanceBreakdown[instance.id] = {
            name: instance.name,
            ...pnl.accountTotals,
            metadata: pnl.metadata,
          };

          // Aggregate symbol breakdown
          for (const [symbol, symbolPnl] of Object.entries(pnl.symbolBreakdown)) {
            if (!symbolBreakdown[symbol]) {
              symbolBreakdown[symbol] = {
                realized: 0,
                unrealized: 0,
                total: 0,
                instances: [],
              };
            }

            symbolBreakdown[symbol].realized += symbolPnl.realized;
            symbolBreakdown[symbol].unrealized += symbolPnl.unrealized;
            symbolBreakdown[symbol].total += symbolPnl.total;
            symbolBreakdown[symbol].instances.push({
              id: instance.id,
              name: instance.name,
              pnl: symbolPnl.total,
            });

            totalSymbols.add(symbol);
          }

          // Aggregate metadata
          totalPositions += pnl.metadata.open_positions;
          totalTrades += pnl.metadata.total_trades;
        } else {
          log.warn('Failed to fetch P&L for instance', {
            instance_id: instance.id,
            instance_name: instance.name,
            error: result.reason?.message,
          });

          // Add failed instance with zero P&L
          instanceBreakdown[instance.id] = {
            name: instance.name,
            realized_pnl: 0,
            unrealized_pnl: 0,
            total_pnl: 0,
            current_balance: 0,
            error: result.reason?.message || 'Failed to fetch P&L',
          };
        }
      }

      return {
        totalPnL,
        instanceBreakdown,
        symbolBreakdown,
        metadata: {
          total_instances: instances.length,
          active_instances: activeInstances,
          total_symbols: totalSymbols.size,
          total_positions: totalPositions,
          total_trades: totalTrades,
        },
      };
    } catch (error) {
      log.error('Failed to get aggregated P&L', error);
      throw error;
    }
  }

  /**
   * Check if instance has hit target profit or loss
   *
   * @param {Object} instance - Instance with target_profit and target_loss
   * @param {number} totalPnL - Current total P&L
   * @returns {Object} - { hitTarget: boolean, targetType: 'profit'|'loss'|null, action: string }
   */
  checkTargets(instance, totalPnL) {
    const targetProfit = parseFloatSafe(instance.target_profit, null);
    const targetLoss = parseFloatSafe(instance.target_loss, null);

    // Check profit target
    if (targetProfit !== null && totalPnL >= targetProfit) {
      return {
        hitTarget: true,
        targetType: 'profit',
        target: targetProfit,
        current: totalPnL,
        action: 'Switch to analyzer mode to lock profits',
      };
    }

    // Check loss target
    if (targetLoss !== null && totalPnL <= -Math.abs(targetLoss)) {
      return {
        hitTarget: true,
        targetType: 'loss',
        target: -Math.abs(targetLoss),
        current: totalPnL,
        action: 'Switch to analyzer mode to prevent further losses',
      };
    }

    return {
      hitTarget: false,
      targetType: null,
      target: null,
      current: totalPnL,
      action: null,
    };
  }
}

// Export singleton instance
export default new PnLService();
export { PnLService };
