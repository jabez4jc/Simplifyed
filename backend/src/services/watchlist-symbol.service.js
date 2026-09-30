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
import { isContractExpired } from '../utils/underlying.util.js';

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

  /**
   * @param {number} symbolId
   * @param {object} updates
   * @param {number|null} watchlistId  When given, the symbol must belong to this watchlist.
   *   The HTTP routes always pass it: they are addressed as
   *   /watchlists/:id/symbols/:symbolId, and without the scope the :id segment was decorative -
   *   any symbol id could be edited through any watchlist. These rows carry quantity and product
   *   type, so that is a live trading parameter being changed under another watchlist's name.
   *   Internal callers that already hold the row omit it.
   */
  async updateSymbol(symbolId, updates, watchlistId = null) {
    const existing = await db.get(
      'SELECT * FROM watchlist_symbols WHERE id = ?',
      [symbolId]
    );

    if (!existing || (watchlistId !== null && Number(existing.watchlist_id) !== Number(watchlistId))) {
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

  /** @param {number|null} watchlistId - see updateSymbol; scopes the delete to one watchlist. */
  async removeSymbol(symbolId, watchlistId = null) {
    const existing = await db.get(
      'SELECT * FROM watchlist_symbols WHERE id = ?',
      [symbolId]
    );

    if (!existing || (watchlistId !== null && Number(existing.watchlist_id) !== Number(watchlistId))) {
      throw new NotFoundError('Symbol');
    }

    await db.run('DELETE FROM watchlist_symbols WHERE id = ?', [symbolId]);

    log.info('Symbol removed', { id: symbolId, symbol: existing.symbol });
  }

  async getSymbolsByWatchlist(watchlistId) {
    const rows = await db.all(
      'SELECT * FROM watchlist_symbols WHERE watchlist_id = ? ORDER BY created_at',
      [watchlistId]
    );
    // An expired contract stays listed so the operator can see and remove it, but is flagged:
    // the UI disables it and the backend makes no broker calls for it.
    return rows.map((row) => ({ ...row, is_expired: isContractExpired(row) }));
  }

  async findSymbolByWatchlist(watchlistId, exchange, symbol) {
    const cleanExchange = sanitizeExchange(exchange);
    const cleanSymbol = sanitizeSymbol(symbol);
    if (!watchlistId || !cleanExchange || !cleanSymbol) return null;

    return db.get(
      `SELECT * FROM watchlist_symbols
       WHERE watchlist_id = ? AND exchange = ? AND symbol = ?
       LIMIT 1`,
      [watchlistId, cleanExchange, cleanSymbol]
    );
  }

  /**
   * Find a strategy's anchor row by underlying rather than exact symbol - on exchanges with no
   * bare/index-style symbol (e.g. MCX commodities, where only dated contracts like
   * NATGASMINI28JUL26FUT exist), the anchor's own `symbol` is a resolved dated contract, not the
   * underlying name the strategy was created with, so a plain findSymbolByWatchlist(underlying)
   * would never match it. Matches on `underlying_symbol` (set explicitly by
   * strategyService.createStrategy's anchor auto-seed) OR `symbol` (covers the common case where
   * they're the same, e.g. NIFTY/NSE_INDEX, and older anchor rows seeded before underlying_symbol
   * was set here).
   */
  async findAnchorByWatchlist(watchlistId, exchange, underlying) {
    const cleanExchange = sanitizeExchange(exchange);
    const cleanUnderlying = sanitizeSymbol(underlying);
    if (!watchlistId || !cleanExchange || !cleanUnderlying) return null;

    const rows = await db.all(
      `SELECT * FROM watchlist_symbols
       WHERE watchlist_id = ? AND exchange = ? AND (underlying_symbol = ? OR symbol = ?)
       ORDER BY id`,
      [watchlistId, cleanExchange, cleanUnderlying, cleanUnderlying]
    );
    // Prefer a live contract: once the operator adds the new month's future, a strategy anchored
    // by underlying rolls onto it instead of staying stuck on the expired row. With only expired
    // rows, the expired one is returned so the caller can say why it cannot trade.
    return rows.find((row) => !isContractExpired(row)) || rows[0] || null;
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

    const lotSizeInput = data.lot_size ?? data.lotsize ?? data.lotSize;
    normalized.lot_size = parseIntSafe(lotSizeInput, 1);
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

    if (!isPartial || data.margin_sizing_enabled !== undefined) {
      normalized.margin_sizing_enabled = parseBooleanSafe(data.margin_sizing_enabled, false) ? 1 : 0;
    }

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
      'limit_buffer_points',
      'margin_utilization_pct',
      'max_margin_per_trade',
    ];

    // On a partial update, a field that was not sent is left alone. It used to be parsed first -
    // parseFloatSafe(undefined, null) is null - and written, so editing only a target through the
    // API wiped the stored stop-loss, trailing stop and every other exit setting.
    const sent = (field) => !isPartial || data[field] !== undefined;
    for (const field of numericalFields) {
      if (sent(field)) applyOrNull(field, parseFloatSafe(data[field], null));
    }

    // Unit of each mode's target/stop/trailing values: POINTS (default) or PERCENT of entry.
    for (const field of ['exit_unit_direct', 'exit_unit_futures', 'exit_unit_options']) {
      if (data[field] !== undefined) {
        normalized[field] = String(data[field]).trim().toUpperCase() === 'PERCENT' ? 'PERCENT' : 'POINTS';
      } else if (!isPartial) {
        normalized[field] = 'POINTS';
      }
    }

    if (sent('strike')) applyOrNull('strike', parseFloatSafe(data.strike, null));
    if (sent('tick_size')) applyOrNull('tick_size', parseFloatSafe(data.tick_size, null));

    // A partial update changes ONLY the fields it was given. Everything above fills defaults for a
    // full insert (lot_size 1, MIS, tradable_* off, is_enabled on, symbol_type null...), and those
    // defaults used to be written on every partial update too: updateSymbol(id, { is_enabled: 0 })
    // - which strategy exits call - reset the row's lot size, product, contract type and tradable
    // flags, and an API edit of one exit value cleared the others.
    if (isPartial) {
      const aliases = {
        lot_size: ['lot_size', 'lotsize', 'lotSize'],
        symbol_type: ['symbol_type', 'instrumenttype'],
        instrumenttype: ['instrumenttype', 'symbol_type'],
      };
      for (const key of Object.keys(normalized)) {
        const sources = aliases[key] || [key];
        if (!sources.some((k) => data[k] !== undefined)) delete normalized[key];
      }
    }

    return normalized;
  }
}

const watchlistSymbolService = new WatchlistSymbolService();
export default watchlistSymbolService;
