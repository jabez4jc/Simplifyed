/**
 * Shared CSV import: an explicit column allowlist per table, cell coercion, and an upsert by
 * natural key. Instance and watchlist imports used to carry their own copies of all three.
 *
 * The allowlists are deliberately written out, not read from the table: a column added to a table
 * later (a runtime counter, a broker-verified flag) must not become importable by accident.
 * Identity, timestamps, runtime P&L/health/probe state and the analyzer flag are never imported.
 */

export const IMPORT_COLUMNS = {
  instances: [
    'name', 'host_url', 'api_key', 'strategy_tag', 'broker', 'order_placement_enabled', 'is_active',
    'websocket_url', 'market_data_enabled', 'supports_multiquotes', 'supports_option_chain', 'use_ws_quotes',
    'session_target_profit', 'session_max_loss', 'disable_quotes', 'disable_multiquotes', 'disable_optionchain',
    'multiplier',
  ],
  watchlists: ['name', 'description', 'is_active', 'type', 'webhook_slug'],
  watchlist_symbols: [
    'watchlist_id', 'exchange', 'symbol', 'token', 'lot_size', 'qty_type', 'qty_value', 'product_type', 'order_type',
    'max_position_size', 'max_instances', 'tradable_equity', 'tradable_futures', 'tradable_options', 'underlying_symbol',
    'options_strike_selection', 'options_expiry_mode', 'trading_symbol', 'symbol_type', 'expiry', 'strike',
    'option_type', 'instrumenttype', 'name', 'tick_size', 'brsymbol', 'brexchange', 'is_enabled', 'operating_mode',
    'strike_policy', 'step_lots', 'writer_guard_enabled',
    'target_points_direct', 'stoploss_points_direct', 'trailing_stoploss_points_direct', 'trailing_activation_points_direct',
    'target_points_futures', 'stoploss_points_futures', 'trailing_stoploss_points_futures', 'trailing_activation_points_futures',
    'target_points_options', 'stoploss_points_options', 'trailing_stoploss_points_options', 'trailing_activation_points_options',
    'limit_buffer_points', 'margin_sizing_enabled', 'margin_utilization_pct', 'max_margin_per_trade', 'exit_mechanism',
    'exit_unit_direct', 'exit_unit_futures', 'exit_unit_options', 'auto_roll',
  ],
  watchlist_instances: ['watchlist_id', 'instance_id', 'assigned_by'],
};

/** 'true'/'false' -> 1/0, a number -> Number, anything else as text; blank -> undefined. */
export function csvValue(val) {
  if (val === undefined || val === null || val === '') return undefined;
  const lowered = String(val).toLowerCase();
  if (lowered === 'true' || lowered === 'false') return lowered === 'true' ? 1 : 0;
  if (!Number.isNaN(Number(val))) return Number(val);
  return val;
}

/** One CSV row -> { column: value } for the allowlisted columns of `table` only. */
export function rowPayload(table, headers, row) {
  const allowed = new Set(IMPORT_COLUMNS[table]);
  const payload = {};
  headers.forEach((header, i) => {
    if (!allowed.has(header)) return;
    const value = csvValue(row[i]);
    if (value !== undefined) payload[header] = value;
  });
  return payload;
}

/**
 * Update the row of `table` whose `keyCols` equal payload's, or insert one.
 * @returns {Promise<{action: 'inserted'|'updated'|'skipped', id: number|null}>}
 */
export async function upsertByKey(db, table, keyCols, payload, { stampColumn = 'updated_at' } = {}) {
  if (keyCols.some((col) => payload[col] === undefined)) return { action: 'skipped', id: null };

  const existing = await db.get(
    `SELECT id FROM ${table} WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')} LIMIT 1`,
    keyCols.map((c) => payload[c])
  );
  const fields = Object.keys(payload);
  if (existing) {
    if (!fields.length) return { action: 'skipped', id: existing.id };
    await db.run(
      `UPDATE ${table} SET ${fields.map((f) => `${f} = ?`).join(', ')}, ${stampColumn} = CURRENT_TIMESTAMP WHERE id = ?`,
      [...fields.map((f) => payload[f]), existing.id]
    );
    return { action: 'updated', id: existing.id };
  }
  const result = await db.run(
    `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    fields.map((f) => payload[f])
  );
  return { action: 'inserted', id: result?.lastID ?? null };
}
