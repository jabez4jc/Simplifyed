/**
 * Watchlist Management Service
 * Handles watchlist CRUD, symbol management, and instance assignments
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../core/errors.js';
import { sanitizeString, parseBooleanSafe } from '../utils/sanitizers.js';
import watchlistSymbolService from './watchlist-symbol.service.js';

class WatchlistService {
  /**
   * Get all watchlists
   * @param {Object} filters - Optional filters (is_active)
   * @returns {Promise<Array>} - List of watchlists with symbol counts
   */
  async getAllWatchlists(filters = {}) {
    try {
      let query = `
        SELECT
          w.*,
          COUNT(DISTINCT ws.id) as symbol_count,
          COUNT(DISTINCT wi.instance_id) as instance_count
        FROM watchlists w
        LEFT JOIN watchlist_symbols ws ON w.id = ws.watchlist_id
        LEFT JOIN watchlist_instances wi ON w.id = wi.watchlist_id
        WHERE 1=1
      `;
      const params = [];

      if (filters.is_active !== undefined) {
        query += ' AND w.is_active = ?';
        params.push(filters.is_active ? 1 : 0);
      }

      query += ' GROUP BY w.id ORDER BY w.created_at DESC';

      const watchlists = await db.all(query, params);
      return watchlists;
    } catch (error) {
      log.error('Failed to get watchlists', error);
      throw error;
    }
  }

  /**
   * Get watchlist by ID with symbols and instances
   * @param {number} id - Watchlist ID
   * @returns {Promise<Object>} - Watchlist with symbols and instances
   */
  async getWatchlistById(id) {
    try {
      const watchlist = await db.get(
        'SELECT * FROM watchlists WHERE id = ?',
        [id]
      );

      if (!watchlist) {
        throw new NotFoundError('Watchlist');
      }

      // Get symbols
      const symbols = await watchlistSymbolService.getSymbolsByWatchlist(id);

      // Get assigned instances (only active instances)
      const instances = await db.all(
        `SELECT i.*
         FROM instances i
         JOIN watchlist_instances wi ON i.id = wi.instance_id
         WHERE wi.watchlist_id = ? AND i.is_active = 1`,
        [id]
      );

      return {
        ...watchlist,
        symbols,
        instances,
      };
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to get watchlist', error, { id });
      throw error;
    }
  }

  /**
   * Create new watchlist
   * @param {Object} data - Watchlist data
   * @returns {Promise<Object>} - Created watchlist
   */
  async createWatchlist(data) {
    try {
      const normalized = this._normalizeWatchlistData(data);

      // Check for duplicate name
      const existing = await db.get(
        'SELECT id FROM watchlists WHERE name = ?',
        [normalized.name]
      );

      if (existing) {
        throw new ConflictError('Watchlist with this name already exists');
      }

      // Create watchlist
      const result = await db.run(
        `INSERT INTO watchlists (name, description, is_active)
         VALUES (?, ?, ?)`,
        [normalized.name, normalized.description, normalized.is_active ? 1 : 0]
      );

      const watchlist = await this.getWatchlistById(result.lastID);

      log.info('Watchlist created', { id: watchlist.id, name: watchlist.name });

      return watchlist;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to create watchlist', error, { data });
      throw error;
    }
  }

  /**
   * Update watchlist
   * @param {number} id - Watchlist ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated watchlist
   */
  async updateWatchlist(id, updates) {
    try {
      // Check if watchlist exists
      await this.getWatchlistById(id);

      const normalized = this._normalizeWatchlistData(updates, true);

      // Build update query
      const fields = [];
      const values = [];

      for (const [key, value] of Object.entries(normalized)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }

      if (fields.length === 0) {
        throw new ValidationError('No valid fields to update');
      }

      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      await db.run(
        `UPDATE watchlists SET ${fields.join(', ')} WHERE id = ?`,
        values
      );

      const watchlist = await this.getWatchlistById(id);

      log.info('Watchlist updated', { id, updates: Object.keys(normalized) });

      return watchlist;
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        error instanceof ValidationError ||
        error instanceof ConflictError
      ) {
        throw error;
      }
      log.error('Failed to update watchlist', error, { id, updates });
      throw error;
    }
  }

  /**
   * Delete watchlist
   * @param {number} id - Watchlist ID
   */
  async deleteWatchlist(id) {
    try {
      // Check if watchlist exists
      await this.getWatchlistById(id);

      // Delete in transaction (cascade will handle related records)
      await db.transaction(async () => {
        await db.run('DELETE FROM watchlist_symbols WHERE watchlist_id = ?', [id]);
        await db.run('DELETE FROM watchlist_instances WHERE watchlist_id = ?', [id]);
        await db.run('DELETE FROM watchlist_orders WHERE watchlist_id = ?', [id]);
        await db.run('DELETE FROM watchlist_positions WHERE watchlist_id = ?', [id]);
        await db.run('DELETE FROM watchlists WHERE id = ?', [id]);
      });

      log.info('Watchlist deleted', { id });
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to delete watchlist', error, { id });
      throw error;
    }
  }

  /**
   * Clone watchlist
   * @param {number} id - Source watchlist ID
   * @param {string} newName - Name for cloned watchlist
   * @returns {Promise<Object>} - Cloned watchlist
   */
  async cloneWatchlist(id, newName) {
    try {
      const source = await this.getWatchlistById(id);

      // Create new watchlist
      const cloned = await this.createWatchlist({
        name: newName,
        description: source.description
          ? `${source.description} (cloned)`
          : 'Cloned watchlist',
        is_active: false, // Start inactive
      });

      // Clone symbols
      for (const symbol of source.symbols) {
        await watchlistSymbolService.addSymbol(cloned.id, { ...symbol });
      }

      // Clone instance assignments
      for (const instance of source.instances) {
        await this.assignInstance(cloned.id, instance.id);
      }

      log.info('Watchlist cloned', {
        source_id: id,
        cloned_id: cloned.id,
        name: newName,
      });

      return await this.getWatchlistById(cloned.id);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) {
        throw error;
      }
      log.error('Failed to clone watchlist', error, { id, newName });
      throw error;
    }
  }

  /**
   * Add symbol to watchlist
   * @param {number} watchlistId - Watchlist ID
   * @param {Object} symbolData - Symbol configuration
   * @returns {Promise<Object>} - Added symbol
   */
  async addSymbol(watchlistId, symbolData) {
    try {
      await this.getWatchlistById(watchlistId);
      return await watchlistSymbolService.addSymbol(watchlistId, symbolData);
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        error instanceof ConflictError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      log.error('Failed to add symbol', error, { watchlistId, symbolData });
      throw error;
    }
  }

  /**
   * Update symbol in watchlist
   * @param {number} symbolId - Symbol ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} - Updated symbol
   */
  async updateSymbol(symbolId, updates) {
    try {
      return await watchlistSymbolService.updateSymbol(symbolId, updates);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        throw error;
      }
      log.error('Failed to update symbol', error, { symbolId, updates });
      throw error;
    }
  }

  /**
   * Remove symbol from watchlist
   * @param {number} symbolId - Symbol ID
   */
  async removeSymbol(symbolId) {
    try {
      await watchlistSymbolService.removeSymbol(symbolId);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to remove symbol', error, { symbolId });
      throw error;
    }
  }

  /**
   * Assign instance to watchlist
   * @param {number} watchlistId - Watchlist ID
   * @param {number} instanceId - Instance ID
   * @returns {Promise<Object>} - Assignment record
   */
  async assignInstance(watchlistId, instanceId) {
    try {
      // Validate watchlist exists
      await this.getWatchlistById(watchlistId);

      // Validate instance exists
      const instance = await db.get('SELECT id FROM instances WHERE id = ?', [
        instanceId,
      ]);

      if (!instance) {
        throw new NotFoundError('Instance');
      }

      // Check for existing assignment
      const existing = await db.get(
        `SELECT * FROM watchlist_instances
         WHERE watchlist_id = ? AND instance_id = ?`,
        [watchlistId, instanceId]
      );

      if (existing) {
        throw new ConflictError('Instance already assigned to this watchlist');
      }

      // Create assignment
      const result = await db.run(
        `INSERT INTO watchlist_instances (watchlist_id, instance_id)
         VALUES (?, ?)`,
        [watchlistId, instanceId]
      );

      const assignment = await db.get(
        'SELECT * FROM watchlist_instances WHERE id = ?',
        [result.lastID]
      );

      log.info('Instance assigned to watchlist', { watchlistId, instanceId });

      return assignment;
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) {
        throw error;
      }
      log.error('Failed to assign instance', error, { watchlistId, instanceId });
      throw error;
    }
  }

  /**
   * Unassign instance from watchlist
   * @param {number} watchlistId - Watchlist ID
   * @param {number} instanceId - Instance ID
   */
  async unassignInstance(watchlistId, instanceId) {
    try {
      // Check if assignment exists
      const existing = await db.get(
        `SELECT * FROM watchlist_instances
         WHERE watchlist_id = ? AND instance_id = ?`,
        [watchlistId, instanceId]
      );

      if (!existing) {
        throw new NotFoundError('Instance assignment');
      }

      await db.run(
        `DELETE FROM watchlist_instances
         WHERE watchlist_id = ? AND instance_id = ?`,
        [watchlistId, instanceId]
      );

      log.info('Instance unassigned from watchlist', { watchlistId, instanceId });
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      log.error('Failed to unassign instance', error, { watchlistId, instanceId });
      throw error;
    }
  }

  /**
   * Get watchlist symbols with latest quotes
   * @param {number} watchlistId - Watchlist ID
   * @returns {Promise<Array>} - Symbols with market data
   */
  async getSymbolsWithQuotes(watchlistId) {
    try {
      const symbols = await db.all(
        `SELECT
          ws.*,
          md.ltp,
          md.open,
          md.high,
          md.low,
          md.close,
          md.volume,
          md.change_percent,
          md.updated_at as quote_updated_at
         FROM watchlist_symbols ws
         LEFT JOIN market_data md ON
           ws.exchange = md.exchange AND ws.symbol = md.symbol
         WHERE ws.watchlist_id = ?
         ORDER BY ws.created_at`,
        [watchlistId]
      );

      return symbols;
    } catch (error) {
      log.error('Failed to get symbols with quotes', error, { watchlistId });
      throw error;
    }
  }

  /**
   * Get distinct symbols being tracked across active watchlists
   * Used by the market data feed service to know which quotes to poll
   * @param {Object} options - Filter options
   * @param {boolean} options.onlyActiveWatchlists - Require parent watchlist to be active
   * @param {boolean} options.onlyEnabledSymbols - Require the symbol row to be enabled
   * @param {boolean} options.requireAssignedInstances - Require at least one active instance assignment
   * @returns {Promise<Array<{exchange: string, symbol: string}>>}
   */
  async getTrackedSymbols(options = {}) {
    const {
      onlyActiveWatchlists = true,
      onlyEnabledSymbols = true,
      requireAssignedInstances = false,
    } = options;

    try {
      let query = `
        SELECT DISTINCT
          UPPER(ws.exchange) as exchange,
          UPPER(ws.symbol) as symbol
        FROM watchlist_symbols ws
        JOIN watchlists w ON ws.watchlist_id = w.id
      `;

      const conditions = [
        "ws.symbol IS NOT NULL AND ws.symbol != ''",
        "ws.exchange IS NOT NULL AND ws.exchange != ''",
      ];

      if (requireAssignedInstances) {
        query += `
          JOIN watchlist_instances wi ON wi.watchlist_id = ws.watchlist_id
          JOIN instances inst ON inst.id = wi.instance_id
        `;
        conditions.push('inst.is_active = 1');
      }

      if (onlyActiveWatchlists) {
        conditions.push('w.is_active = 1');
      }

      if (onlyEnabledSymbols) {
        conditions.push('ws.is_enabled = 1');
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ' ORDER BY exchange, symbol';

      return await db.all(query);
    } catch (error) {
      log.error('Failed to get tracked symbols', error);
      return [];
    }
  }

  async getSymbolsWithAutoExitConfig() {
    try {
      const rows = await db.all(`
        SELECT *
        FROM watchlist_symbols
        WHERE
          target_points_direct IS NOT NULL OR
          stoploss_points_direct IS NOT NULL OR
          trailing_stoploss_points_direct IS NOT NULL OR
          target_points_futures IS NOT NULL OR
          stoploss_points_futures IS NOT NULL OR
          trailing_stoploss_points_futures IS NOT NULL OR
          target_points_options IS NOT NULL OR
          stoploss_points_options IS NOT NULL OR
          trailing_stoploss_points_options IS NOT NULL
      `);
      return rows;
    } catch (error) {
      log.error('Failed to load auto-exit symbols', error);
      return [];
    }
  }

  /**
   * Normalize and validate watchlist data
   * @private
   */
  _normalizeWatchlistData(data, isUpdate = false) {
    const normalized = {};
    const errors = [];

    // Name
    if (data.name !== undefined) {
      const name = sanitizeString(data.name);
      if (!name && !isUpdate) {
        errors.push({ field: 'name', message: 'Name is required' });
      } else if (name) {
        normalized.name = name;
      }
    }

    // Description
    if (data.description !== undefined) {
      normalized.description = sanitizeString(data.description) || null;
    }

    // Is Active
    if (data.is_active !== undefined) {
      normalized.is_active = parseBooleanSafe(data.is_active, true);
    }

    if (errors.length > 0) {
      throw new ValidationError('Watchlist validation failed', errors);
    }

    return normalized;
  }

}

// Export singleton instance
export default new WatchlistService();
export { WatchlistService };
