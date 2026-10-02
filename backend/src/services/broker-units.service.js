/**
 * Broker quantity units.
 *
 * The app works in ONE unit: the instruments cache's lot size (canonical). Brokers do not all
 * agree - Kotak counts MCX GOLDM in grams (lot 100) where Fyers counts price units (lot 10), GOLD
 * as 1 vs 100, ALUMINIUM/LEAD/ZINC as 5 vs 5000. Sending one fanned-out quantity to both would
 * be rejected at one broker, or worse, filled 100x oversize.
 *
 * So the conversion lives at the broker boundary, in both directions (see openalgo client
 * `request`): order quantities go OUT in the broker's units, and position/order/trade quantities
 * come IN converted back to canonical. Everything between - targets, closes, auto-exit, P&L -
 * only ever sees canonical units, so a position's quantity can be re-sent without being scaled
 * twice.
 *
 * Each broker's lot is read from its own OpenAlgo instance (`symbol` endpoint), cached for the
 * IST day and persisted (broker_lot_sizes, migration 063) for restarts and slow brokers.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import { toISTISOString } from '../utils/time.js';

// Cash segments trade in units of 1 at every broker - never worth a lookup.
const CASH_EXCHANGES = new Set(['NSE', 'BSE', 'NSE_INDEX', 'BSE_INDEX']);
const ORDER_ROWS = {
  placeorder: (d) => [d],
  placesmartorder: (d) => [d],
  splitorder: (d) => [d],
  modifyorder: (d) => [d],
  basketorder: (d) => (Array.isArray(d?.orders) ? d.orders : []),
  placegttorder: (d) => [d],
  margin: (d) => (Array.isArray(d?.positions) ? d.positions : []),
};
// Endpoints whose payload carries its rows in an array that must be copied before it is edited.
const ROW_ARRAYS = { basketorder: 'orders', margin: 'positions' };
const OUT_FIELDS = ['quantity', 'position_size', 'splitsize'];
const IN_FIELDS = ['quantity', 'netqty', 'net_qty', 'net_quantity', 'filled_quantity', 'pending_quantity', 'filledqty'];

const upper = (v) => String(v || '').trim().toUpperCase();
const today = () => toISTISOString().slice(0, 10);

class BrokerUnitsService {
  constructor() {
    this.cache = new Map(); // broker|EX|SYM -> { canonical, broker, day } | { none: true, day }
    this.inflight = new Map();
    this.tableCheck = null;
  }

  /**
   * Is broker_lot_sizes (migration 063) there? Checked once; a miss THROWS. Without the table a
   * lot-size lookup would silently skip rescaling, and an unscaled quantity is filled at the wrong
   * size (Kotak MCX is 10x-100x off) - so every order, margin or position read that needs a
   * conversion fails with the fix in the message until the migration has run.
   */
  _hasTable() {
    if (!this.tableCheck) {
      this.tableCheck = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broker_lot_sizes'")
        .then((row) => {
          if (!row) throw new Error('broker_lot_sizes table missing - broker lot sizes cannot be converted. Run: npm run migrate');
          return true;
        })
        .catch((error) => { this.tableCheck = null; throw error; });
    }
    return this.tableCheck;
  }

  /** { canonical, broker } lot sizes, or null when there is nothing to convert or it is unknown. */
  async lotInfo(instance, exchange, symbol, client) {
    const ex = upper(exchange);
    const sym = upper(symbol);
    const broker = String(instance?.broker || '').toLowerCase();
    if (!broker || !sym || !ex || CASH_EXCHANGES.has(ex)) return null;

    const key = `${broker}|${ex}|${sym}`;
    const hit = this.cache.get(key);
    if (hit && hit.day === today()) return hit.none ? null : hit;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const pending = this._resolve(instance, broker, ex, sym, client)
      .then((info) => { this.cache.set(key, { ...(info || { none: true }), day: today() }); return info; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async _resolve(instance, broker, ex, sym, client) {
    const row = await db.get('SELECT lotsize FROM instruments WHERE exchange = ? AND symbol = ? LIMIT 1', [ex, sym])
      .catch(() => null);
    const canonical = Number(row?.lotsize);
    if (!(canonical > 0)) return null; // not in the cache - nothing to convert against

    try {
      const res = await client.request(instance, 'symbol', { symbol: sym, exchange: ex }, 'POST', { ignoreCircuit: true });
      const brokerLot = Number(res?.data?.lotsize);
      if (!(brokerLot > 0)) throw new Error(`no lotsize in ${JSON.stringify(res?.data)?.slice(0, 120)}`);
      await this._hasTable();
      await db.run(
        `INSERT OR REPLACE INTO broker_lot_sizes (broker, exchange, symbol, broker_lotsize, canonical_lotsize, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [broker, ex, sym, brokerLot, canonical, toISTISOString()]
      ).catch(() => {});
      if (brokerLot !== canonical) {
        log.warn('Broker lot size differs from the instruments cache - quantities will be rescaled', {
          instance_name: instance.name, exchange: ex, symbol: sym, reason: `${broker} ${brokerLot} vs cache ${canonical}`,
        });
      }
      return { canonical, broker: brokerLot };
    } catch (error) {
      await this._hasTable();
      const saved = await db.get(
        'SELECT broker_lotsize FROM broker_lot_sizes WHERE broker = ? AND exchange = ? AND symbol = ?',
        [broker, ex, sym]
      ).catch(() => null);
      if (saved?.broker_lotsize > 0) return { canonical, broker: Number(saved.broker_lotsize) };
      log.warn('Broker lot size unknown - sending canonical quantity unchanged', {
        instance_name: instance.name, exchange: ex, symbol: sym, error: error.message,
      });
      return null;
    }
  }

  /** Outbound: a copy of the order payload with quantities in this broker's units. */
  async toBroker(instance, endpoint, data, client) {
    const rowsOf = ORDER_ROWS[endpoint];
    if (!rowsOf || !data) return data;
    const arrayKey = ROW_ARRAYS[endpoint];
    const out = arrayKey
      ? { ...data, [arrayKey]: (data[arrayKey] || []).map((o) => ({ ...o })) }
      : { ...data };
    for (const row of rowsOf(out)) {
      const info = await this.lotInfo(instance, row.exchange, row.symbol, client);
      if (!info || info.broker === info.canonical) continue;
      for (const field of OUT_FIELDS) {
        if (row[field] === undefined || row[field] === null || row[field] === '') continue;
        const qty = Number(row[field]);
        const lots = qty / info.canonical;
        if (!Number.isFinite(lots) || Math.abs(lots - Math.round(lots)) > 1e-9) {
          throw new ValidationError(
            `${field} ${qty} for ${row.exchange}:${row.symbol} is not whole lots of ${info.canonical} - cannot convert to ${instance.name}'s lot of ${info.broker}`
          );
        }
        row[field] = Math.round(lots) * info.broker;
      }
      log.info('Order quantity converted to broker units', {
        instance_name: instance.name, exchange: row.exchange, symbol: row.symbol,
        reason: `lot ${info.canonical} -> ${info.broker}`,
      });
    }
    return out;
  }

  /** Inbound: one broker row's quantity fields, rescaled to canonical in place. */
  async fromBrokerRow(instance, row, client, fallback = {}) {
    if (!row || typeof row !== 'object') return row;
    const info = await this.lotInfo(instance, row.exchange || fallback.exchange, row.symbol || row.tradingsymbol || fallback.symbol, client);
    if (!info || info.broker === info.canonical) return row;
    for (const field of IN_FIELDS) {
      if (row[field] === undefined || row[field] === null || row[field] === '') continue;
      const qty = Number(row[field]);
      if (Number.isFinite(qty)) row[field] = (qty / info.broker) * info.canonical;
    }
    return row;
  }

  /** Inbound: rescale the quantities in a broker response to canonical units, in place. */
  async fromBroker(instance, endpoint, requestData, response, client) {
    const data = response?.data;
    let rows = [];
    if (endpoint === 'positionbook' || endpoint === 'tradebook') rows = Array.isArray(data) ? data : [];
    else if (endpoint === 'orderbook') rows = Array.isArray(data?.orders) ? data.orders : (Array.isArray(data) ? data : []);
    else if (endpoint === 'orderstatus') rows = data && typeof data === 'object' ? [data] : [];
    else if (endpoint === 'openposition') {
      const holder = data && typeof data === 'object' && 'quantity' in data ? data : response;
      if (holder && 'quantity' in holder) {
        const row = { exchange: requestData?.exchange, symbol: requestData?.symbol, quantity: holder.quantity };
        await this.fromBrokerRow(instance, row, client);
        holder.quantity = row.quantity;
      }
      return response;
    }
    for (const row of rows) await this.fromBrokerRow(instance, row, client);
    return response;
  }
}

export default new BrokerUnitsService();
