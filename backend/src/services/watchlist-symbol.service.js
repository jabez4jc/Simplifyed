/**
 * Watchlist Symbol Service
 * Encapsulates CRUD/search logic for watchlist symbols.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../core/errors.js';
import {
  sanitizeSymbol,
  sanitizeExchange,
  parseFloatSafe,
  parseIntSafe,
  parseBooleanSafe,
} from '../utils/sanitizers.js';

class WatchlistSymbolService {
  async addSymbol(watchlistId, symbolData) {
    const normalized = this._normalizeSymbolData(symbolData);

    const existing = await db.get(
      `SELECT id FROM watchlist_symbols
       WHERE watchlist_id = ? AND exchange = ? AND symbol = ?`,
      [watchlistId, normalized.exchange, normalized.symbol]
    );

    if (existing) {
      throw new ConflictError(
        `Symbol ${normalized.symbol} already exists in this watchlist`
      );
    }

    const insertColumns = Object.keys(normalized).concat(['watchlist_id']);
    const placeholders = insertColumns.map(() => '?').join(', ');
    const values = insertColumns.map((column) =>
      column === 'watchlist_id' ? watchlistId : normalized[column]
    );

    const result = await db.run(
      `INSERT INTO watchlist_symbols (${insertColumns.join(', ')}) VALUES (${placeholders})`,
      values
    );

    const symbol = await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [
      result.lastID,
    ]);

    log.info('Symbol added to watchlist', {
      watchlist_id: watchlistId,
      symbol: normalized.symbol,
      exchange: normalized.exchange,
    });

    return symbol;
  }

  async updateSymbol(symbolId, updates) {
    const existing = await db.get(
      'SELECT * FROM watchlist_symbols WHERE id = ?',
      [symbolId]
    );

    if (!existing) {
      throw new NotFoundError('Symbol');
    }

    const normalized = this._normalizeSymbolData(updates, true);

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
    values.push(symbolId);

    await db.run(
      `UPDATE watchlist_symbols SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    const symbol = await db.get(
      'SELECT * FROM watchlist_symbols WHERE id = ?',
      [symbolId]
    );

    log.info('Symbol updated', { id: symbolId, updates: Object.keys(normalized) });

    return symbol;
  }

  async removeSymbol(symbolId) {
    const existing = await db.get(
      'SELECT * FROM watchlist_symbols WHERE id = ?',
      [symbolId]
    );

    if (!existing) {
      throw new NotFoundError('Symbol');
    }

    await db.run('DELETE FROM watchlist_symbols WHERE id = ?', [symbolId]);

    log.info('Symbol removed', { id: symbolId, symbol: existing.symbol });
  }

  async getSymbolsByWatchlist(watchlistId) {
    return db.all(
      'SELECT * FROM watchlist_symbols WHERE watchlist_id = ? ORDER BY created_at',
      [watchlistId]
    );
  }

  async searchSymbolsByWatchlist(filters = {}) {
    const {
      watchlistId,
      exchange,
      symbol,
      isEnabled,
      tradableEquity,
      tradableFutures,
      tradableOptions,
    } = filters;

    let query = `
      SELECT
        ws.*,
        w.name AS watchlist_name
      FROM watchlist_symbols ws
      JOIN watchlists w ON ws.watchlist_id = w.id
      WHERE 1=1
    `;
    const params = [];

    if (watchlistId) {
      query += ' AND ws.watchlist_id = ?';
      params.push(watchlistId);
    }

    if (exchange) {
      query += ' AND ws.exchange = ?';
      params.push(exchange);
    }

    if (symbol) {
      query += ' AND ws.symbol LIKE ?';
      params.push(`%${symbol}%`);
    }

    if (isEnabled !== undefined) {
      query += ' AND ws.is_enabled = ?';
      params.push(isEnabled ? 1 : 0);
    }

    if (tradableEquity !== undefined) {
      query += ' AND ws.tradable_equity = ?';
      params.push(tradableEquity ? 1 : 0);
    }

    if (tradableFutures !== undefined) {
      query += ' AND ws.tradable_futures = ?';
      params.push(tradableFutures ? 1 : 0);
    }

    if (tradableOptions !== undefined) {
      query += ' AND ws.tradable_options = ?';
      params.push(tradableOptions ? 1 : 0);
    }

    query += ' ORDER BY ws.watchlist_id, ws.created_at';

    return db.all(query, params);
  }

  _normalizeSymbolData(data, isPartial = false) {
    const normalized = {};

    const applyOrNull = (key, value) => {
      if (value === undefined) return;
      normalized[key] = value === null ? null : value;
    };

    if (!isPartial || data.exchange !== undefined) {
      normalized.exchange = sanitizeExchange(data.exchange);
      if (!normalized.exchange) {
        throw new ValidationError('Exchange is required');
      }
    }

    if (!isPartial || data.symbol !== undefined) {
      normalized.symbol = sanitizeSymbol(data.symbol);
      if (!normalized.symbol) {
        throw new ValidationError('Symbol is required');
      }
    }

    applyOrNull('token', data.token);
    applyOrNull('symbol_type', data.symbol_type || data.instrumenttype || null);
    applyOrNull('instrumenttype', data.instrumenttype || data.symbol_type || null);
    applyOrNull('name', data.name || null);
    applyOrNull('underlying_symbol', data.underlying_symbol || null);
    applyOrNull('expiry', data.expiry || null);
    applyOrNull('option_type', data.option_type || null);
    applyOrNull('brsymbol', data.brsymbol || null);
    applyOrNull('brexchange', data.brexchange || null);

    normalized.lot_size = parseIntSafe(data.lot_size, 1);
    normalized.qty_type = data.qty_type || 'LOTS';
    normalized.qty_value = parseFloatSafe(data.qty_value, null);
    normalized.product_type = data.product_type || 'MIS';
    normalized.order_type = data.order_type || 'MARKET';
    normalized.max_position_size = parseFloatSafe(data.max_position_size, null);

    normalized.tradable_equity = parseBooleanSafe(
      data.tradable_equity,
      false
    )
      ? 1
      : 0;
    normalized.tradable_futures = parseBooleanSafe(
      data.tradable_futures,
      false
    )
      ? 1
      : 0;
    normalized.tradable_options = parseBooleanSafe(
      data.tradable_options,
      false
    )
      ? 1
      : 0;

    normalized.is_enabled = parseBooleanSafe(data.is_enabled, true) ? 1 : 0;

    const numericalFields = [
      'target_points_direct',
      'stoploss_points_direct',
      'trailing_stoploss_points_direct',
      'trailing_activation_points_direct',
      'target_points_futures',
      'stoploss_points_futures',
      'trailing_stoploss_points_futures',
      'trailing_activation_points_futures',
      'target_points_options',
      'stoploss_points_options',
      'trailing_stoploss_points_options',
      'trailing_activation_points_options',
    ];

    for (const field of numericalFields) {
      applyOrNull(field, parseFloatSafe(data[field], null));
    }

    applyOrNull('strike', parseFloatSafe(data.strike, null));
    applyOrNull('tick_size', parseFloatSafe(data.tick_size, null));

    return normalized;
  }
}

const watchlistSymbolService = new WatchlistSymbolService();
export default watchlistSymbolService;
