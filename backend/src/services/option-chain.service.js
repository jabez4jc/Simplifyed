/**
 * Option Chain Service
 * Builds option chains from instruments data
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

class OptionChainService {
  /**
   * Get all underlyings that have options
   * @param {string} type - Optional filter: 'index' or 'stock'
   * @returns {Promise<Object>} - List of indices and stocks
   */
  async getUnderlyings(type = null) {
    try {
      // Get index underlyings from NSE_INDEX exchange
      const indices = await db.all(`
        SELECT DISTINCT symbol as name, symbol, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        ORDER BY symbol
      `);

      // Get stock underlyings from both BFO and NFO exchanges
      const stocks = await db.all(`
        SELECT DISTINCT name, name as symbol, 'stock' as type
        FROM instruments
        WHERE exchange IN ('BFO', 'NFO')
        AND instrumenttype IN ('CE', 'PE')
        AND name NOT IN (
          SELECT symbol FROM instruments WHERE exchange = 'NSE_INDEX' AND instrumenttype = 'INDEX'
        )
        ORDER BY name
      `);

      return {
        indices,
        stocks
      };
    } catch (error) {
      log.error('Failed to get underlyings', error);
      throw error;
    }
  }

  /**
   * Get available expiries for an underlying
   * @param {string} underlying - Underlying symbol
   * @param {string} type - Optional type: 'index' or 'stock'
   * @returns {Promise<Object>} - Underlying info with expiries
   */
  async getExpiries(underlying, type = null) {
    try {
      // Check if it's an index (from NSE_INDEX exchange)
      const indexCheck = await db.get(`
        SELECT DISTINCT symbol as underlying, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        AND symbol = ?
        LIMIT 1
      `, [underlying]);

      // Check if it's a stock (from BFO or NFO exchange)
      const stockCheck = await db.get(`
        SELECT DISTINCT name as underlying, 'stock' as type, exchange
        FROM instruments
        WHERE exchange IN ('BFO', 'NFO')
        AND instrumenttype IN ('CE', 'PE')
        AND name = ?
        LIMIT 1
      `, [underlying]);

      const underlyingCheck = indexCheck || stockCheck;

      if (!underlyingCheck) {
        throw new ValidationError(`Underlying ${underlying} not found or has no options`);
      }

      const exchange = underlyingCheck.exchange || (underlyingCheck.type === 'index' ? 'NSE_INDEX' : 'BFO');

      // Get all expiries for this underlying
      const expiries = await db.all(`
        SELECT DISTINCT expiry
        FROM instruments
        WHERE exchange IN ('${exchange}', 'NFO', 'BFO')
        AND instrumenttype IN ('CE', 'PE')
        AND name = ?
        ORDER BY expiry
      `, [underlying]);

      return {
        underlying,
        type: underlyingCheck.type,
        exchange: underlyingCheck.type === 'index' ? 'NFO' : 'BFO,NFO',
        expiries: expiries.map(row => row.expiry)
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to get expiries', error, { underlying });
      throw error;
    }
  }

  /**
   * Get option chain for underlying + expiry
   * @param {string} underlying - Underlying symbol
   * @param {string} expiry - Expiry date
   * @param {string} type - Optional type: 'index' or 'stock'
   * @param {boolean} includeQuotes - Whether to include quotes
   * @param {number} strikeWindow - Optional window around ATM
   * @returns {Promise<Object>} - Option chain
   */
  async getOptionChain(underlying, expiry, type = null, includeQuotes = false, strikeWindow = null) {
    try {
      // Determine if it's an index or stock
      const indexCheck = await db.get(`
        SELECT symbol, 'index' as type
        FROM instruments
        WHERE exchange = 'NSE_INDEX'
        AND instrumenttype = 'INDEX'
        AND symbol = ?
        LIMIT 1
      `, [underlying]);

      const isIndex = !!indexCheck;
      const exchangeList = isIndex ? 'NFO' : 'BFO,NFO';

      // Validate underlying and expiry
      const expiryCheck = await db.get(`
        SELECT DISTINCT expiry
        FROM instruments
        WHERE exchange IN (${isIndex ? "'NFO'" : "'BFO', 'NFO'"})
        AND instrumenttype IN ('CE', 'PE')
        AND name = ?
        AND expiry = ?
      `, [underlying, expiry]);

      if (!expiryCheck) {
        throw new ValidationError(`No options found for ${underlying} ${expiry}`);
      }

      // Get all CE and PE for this underlying + expiry
      const options = await db.all(`
        SELECT symbol, name, strike, lotsize, instrumenttype, exchange
        FROM instruments
        WHERE exchange IN (${isIndex ? "'NFO'" : "'BFO', 'NFO'"})
        AND instrumenttype IN ('CE', 'PE')
        AND name = ?
        AND expiry = ?
        AND strike > 0
        ORDER BY strike
      `, [underlying, expiry]);

      // Pivot into chain rows
      const strikesMap = new Map();

      for (const option of options) {
        const strike = option.strike;
        if (!strikesMap.has(strike)) {
          strikesMap.set(strike, {
            strike: strike,
            call_symbol: null,
            call_lotsize: null,
            put_symbol: null,
            put_lotsize: null
          });
        }

        const row = strikesMap.get(strike);
        if (option.instrumenttype === 'CE') {
          row.call_symbol = option.symbol;
          row.call_lotsize = option.lotsize;
        } else if (option.instrumenttype === 'PE') {
          row.put_symbol = option.symbol;
          row.put_lotsize = option.lotsize;
        }
      }

      // Convert to array and sort by strike
      let rows = Array.from(strikesMap.values()).sort((a, b) => a.strike - b.strike);

      // TODO: Implement ATM calculation and strike window filtering
      // This requires getting the underlying spot price

      return {
        underlying,
        type: isIndex ? 'index' : 'stock',
        exchange: isIndex ? 'NFO' : 'BFO,NFO',
        expiry,
        has_quotes: includeQuotes,
        rows
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to get option chain', error, { underlying, expiry });
      throw error;
    }
  }

  /**
   * Build a sample option chain for testing
   * @param {string} underlying - Underlying symbol
   * @returns {Promise<Object>} - Sample chain with sample data
   */
  async getSampleChain(underlying) {
    try {
      const chain = await this.getOptionChain(underlying, '27-NOV-25', 'stock', false, null);

      // Add sample quotes for demonstration
      chain.rows = chain.rows.map(row => {
        const sampleRow = { ...row };

        if (row.call_symbol) {
          sampleRow.call_quote = {
            ltp: Math.random() * 100,
            bid_price: Math.random() * 100,
            bid_qty: Math.floor(Math.random() * 500),
            ask_price: Math.random() * 100,
            ask_qty: Math.floor(Math.random() * 500),
            oi: Math.floor(Math.random() * 200000),
            volume: Math.floor(Math.random() * 5000),
            iv: 10 + Math.random() * 10
          };
        }

        if (row.put_symbol) {
          sampleRow.put_quote = {
            ltp: Math.random() * 100,
            bid_price: Math.random() * 100,
            bid_qty: Math.floor(Math.random() * 500),
            ask_price: Math.random() * 100,
            ask_qty: Math.floor(Math.random() * 500),
            oi: Math.floor(Math.random() * 200000),
            volume: Math.floor(Math.random() * 5000),
            iv: 10 + Math.random() * 10
          };
        }

        return sampleRow;
      });

      chain.has_quotes = true;
      chain.spot = 24000 + Math.random() * 1000;
      chain.atm_strike = chain.rows[Math.floor(chain.rows.length / 2)].strike;
      chain.strike_window = 5;

      return chain;
    } catch (error) {
      log.error('Failed to get sample chain', error, { underlying });
      throw error;
    }
  }
}

export default new OptionChainService();
export { OptionChainService };
