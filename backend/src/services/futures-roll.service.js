/**
 * Futures auto-roll
 *
 * Indian exchanges list no perpetual futures, so a watchlist row pinned to one dated contract goes
 * stale at expiry. A row with `auto_roll` set follows a series instead:
 *   1  the nearest live contract    (TradingView's NIFTY1!)
 *   2  the contract after that      (TradingView's NIFTY2!)
 *
 * Futures on NSE, BSE and MCX are monthly (or the exchange's own cycle); weekly expiries exist for
 * OPTIONS only. So the FUT list below never holds a weekly, and series 1 is the current month.
 *
 * A roll rewrites the row's contract columns in place (symbol, token, expiry, lot size...). The row
 * keeps its id and settings, and every reader of watchlist_symbols - feed, quotes, orders,
 * auto-exit - keeps working on a real contract without knowing about series.
 *
 * When: after expiry (the purge crons at 17:50 and 00:05 IST, and startup - see
 * instrumentsService.purgeExpired). By then any position in the old contract has settled. The
 * `futures.roll_days_before_expiry` setting rolls earlier, for MCX tender periods and physically
 * settled stock futures, but ONLY when no mapped instance holds the old contract: the row is what
 * the EXIT button and auto-exit act on, so moving it off an open position would orphan it.
 * Positions are never rolled - closing one contract and opening the next is a trading decision.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import settingsService from './settings.service.js';
import { notify } from './notify.service.js';
import { settingDefault } from '../config/settings-registry.js';
import derivativeResolutionService from './derivative-resolution.service.js';
import { upcomingExpiries, isContractExpired } from '../utils/underlying.util.js';
import { parseExpiry, toDisplay } from '../utils/expiry.js';
import { isCryptoExchange } from '../utils/broker-type.util.js';
import { toISTDate } from '../utils/time.js';

export const EARLY_ROLL_SETTING = 'futures.roll_days_before_expiry';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'NIFTY1!' -> { underlying: 'NIFTY', series: 1 }; anything else -> null. */
export function parseContinuousSymbol(symbol) {
  const m = /^([A-Z0-9&_-]+?)([12])!$/.exec(String(symbol || '').trim().toUpperCase());
  return m ? { underlying: m[1], series: Number(m[2]) } : null;
}


function daysToExpiry(raw, now) {
  const ist = toISTDate(now);
  const today = Date.UTC(ist.getFullYear(), ist.getMonth(), ist.getDate());
  return Math.round((parseExpiry(raw) - today) / DAY_MS);
}

/**
 * Which contract a series points at, from live futures sorted nearest first.
 * earlyDays > 0 treats a front contract that close to expiry as already gone (`early: true`).
 * Pure, so the rule is testable without a database.
 * @returns {{ contract: Object|null, early: boolean }}
 */
export function pickContract(futures, series, now = new Date(), earlyDays = 0) {
  const early = earlyDays > 0 && futures.length > 0 && daysToExpiry(futures[0].expiry, now) <= earlyDays;
  const list = early ? futures.slice(1) : futures;
  return { contract: list[series - 1] || null, early };
}

class FuturesRollService {
  /** Live futures for an underlying on one exchange, nearest first, from the instruments cache. */
  async listFutures(exchange, underlying, now = new Date()) {
    const rows = await db.all(
      `SELECT * FROM instruments
        WHERE exchange = ? AND underlying_key = ? AND instrumenttype = 'FUT'`,
      [exchange, String(underlying || '').toUpperCase()]
    );
    // The cache stores text expiries - sorting them in SQL orders by day-of-month, not by date.
    const byExpiry = new Map(rows.map((r) => [r.expiry, r]));
    return upcomingExpiries(rows.map((r) => r.expiry), now).map((e) => byExpiry.get(e));
  }

  async earlyRollDays() {
    try {
      const setting = await settingsService.getSetting(EARLY_ROLL_SETTING);
      const days = parseInt(setting?.rawValue ?? setting?.value, 10);
      return Number.isFinite(days) && days > 0 ? days : 0;
    } catch {
      return Number(settingDefault(EARLY_ROLL_SETTING)) || 0; // row missing
    }
  }

  /**
   * A webhook symbol such as NIFTY1! resolved to the contract it means today, or the symbol
   * unchanged when it is not a continuous one. Pure series - no early roll: an alert carries no
   * position bookkeeping, and TradingView's own 1! also rolls at expiry.
   */
  async resolveContinuousSymbol(exchange, symbol, now = new Date()) {
    const parsed = parseContinuousSymbol(symbol);
    if (!parsed) return symbol;
    const futures = await this.listFutures(exchange, parsed.underlying, now);
    const { contract } = pickContract(futures, parsed.series, now);
    return contract ? contract.symbol : null;
  }

  /**
   * Point one row at the contract its series means now.
   * @param {Object} row watchlist_symbols row
   * @param {Object} opts
   * @param {boolean} [opts.checkPositions=true] refuse to leave a live contract that a mapped
   *   instance still holds. False only for a row that was just inserted.
   * @returns {Promise<{status: string, message?: string, from?: string, to?: string}>}
   *   status: rolled | unchanged | off | no-contract | position-open | duplicate
   */
  async rollRow(row, { now = new Date(), earlyDays = null, checkPositions = true } = {}) {
    const series = Number(row?.auto_roll) || 0;
    if (!series || isCryptoExchange(row.exchange)) return { status: 'off' };

    const underlying = derivativeResolutionService.getDerivativeUnderlying(row);
    const futures = await this.listFutures(row.exchange, underlying, now);
    const days = earlyDays ?? (await this.earlyRollDays());
    const { contract } = pickContract(futures, series, now, days);

    if (!contract) {
      return { status: 'no-contract', message: `No live ${row.exchange} future found for ${underlying}` };
    }
    if (contract.symbol === row.symbol) return { status: 'unchanged' };

    const duplicate = await db.get(
      'SELECT id FROM watchlist_symbols WHERE watchlist_id = ? AND exchange = ? AND symbol = ? AND id != ?',
      [row.watchlist_id, row.exchange, contract.symbol, row.id]
    );
    if (duplicate) {
      return { status: 'duplicate', message: `${contract.symbol} is already a separate row in this watchlist` };
    }

    if (checkPositions && !isContractExpired(row, now)) {
      let held;
      try {
        held = await this._isHeld(row);
      } catch (error) {
        held = true; // an unreadable position book is not "flat"
        log.warn('Futures roll: could not read positions, not rolling', { exchange: row.exchange, symbol: row.symbol, error: error.message });
      }
      if (held) {
        return { status: 'position-open', message: `${row.symbol} has an open position - close it before the row moves to ${contract.symbol}` };
      }
    }

    await db.run(
      `UPDATE watchlist_symbols
          SET symbol = ?, trading_symbol = NULL, token = ?, expiry = ?, lot_size = ?, tick_size = ?,
              brsymbol = ?, brexchange = ?, name = ?, instrumenttype = 'FUT', symbol_type = 'FUTURES',
              underlying_symbol = ?, is_enabled = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [
        contract.symbol, contract.token, toDisplay(contract.expiry) || contract.expiry || null, contract.lotsize || 1,
        contract.tick_size, contract.brsymbol, contract.brexchange, contract.name || underlying,
        underlying, row.id,
      ]
    );
    log.info('Futures row rolled', { exchange: row.exchange, symbol: contract.symbol, reason: `rolled from ${row.symbol}` });
    return { status: 'rolled', from: row.symbol, to: contract.symbol };
  }

  /** Roll every auto-roll row that is due. Never throws - the expiry purge must still run. */
  async rollAll(now = new Date()) {
    const rows = await db.all('SELECT * FROM watchlist_symbols WHERE auto_roll > 0').catch(() => []);
    if (rows.length === 0) return [];
    const earlyDays = await this.earlyRollDays();
    const outcomes = [];
    for (const row of rows) {
      try {
        const result = await this.rollRow(row, { now, earlyDays });
        if (result.status === 'unchanged' || result.status === 'off') continue;
        // A live row with nothing to roll onto yet (cache not refreshed) is fine until it expires.
        if (result.status === 'no-contract' && !isContractExpired(row, now)) continue;
        outcomes.push({ row, ...result });
      } catch (error) {
        log.error('Futures roll failed', error, { exchange: row.exchange, symbol: row.symbol });
      }
    }
    await this._announce(outcomes);
    return outcomes;
  }

  /** Does any active instance mapped to the row's watchlist hold the row's contract? */
  async _isHeld(row) {
    // Imported late: quick-order and the feed import instruments.service, which imports this.
    const { default: marketDataFeedService } = await import('./market-data-feed.service.js');
    const { default: quickOrderService } = await import('./quick-order.service.js');
    // Watchlist instances, plus instances assigned directly to a strategy on this watchlist - a
    // strategy's base contract is traded on those.
    const instances = await db.all(
      `SELECT i.* FROM instances i
        WHERE i.is_active = 1
          AND (i.id IN (SELECT instance_id FROM watchlist_instances WHERE watchlist_id = ?)
            OR i.id IN (SELECT si.instance_id FROM strategy_instances si
                          JOIN strategies s ON s.id = si.strategy_id
                         WHERE s.watchlist_id = ?))`,
      [row.watchlist_id, row.watchlist_id]
    );
    for (const instance of instances) {
      if (!marketDataFeedService._tradesExchange(instance, row.exchange)) continue;
      const open = await quickOrderService._getOpenPositionsForSymbol(instance, row.symbol, row.exchange, null);
      if (open.length > 0) return true;
    }
    return false;
  }

  /**
   * Tell open dashboards to refetch, and the operator what moved or is stuck. A blocked row is
   * re-announced on every cron until it clears, which is intended - it needs a decision.
   */
  async _announce(outcomes) {
    if (outcomes.length === 0) return;
    // warn also lands in the app's notifications list, which is where the operator should see it.
    for (const o of outcomes) {
      log.warn(o.status === 'rolled' ? 'Watchlist future rolled to next contract' : 'Watchlist future not rolled', {
        exchange: o.row.exchange,
        symbol: o.status === 'rolled' ? o.to : o.row.symbol,
        reason: o.status === 'rolled' ? `from ${o.from}` : o.message,
      });
    }
    const { default: wsGatewayService } = await import('./ws-gateway.service.js');
    await wsGatewayService.broadcast('watchlists:update', {
      reason: 'futures_roll',
      rows: outcomes.map((o) => ({ id: o.row.id, watchlist_id: o.row.watchlist_id, status: o.status })),
    });

    const lines = outcomes.map((o) => (o.status === 'rolled'
      ? `${o.row.exchange}: ${o.from} -> ${o.to}`
      : `${o.row.exchange}: ${o.row.symbol} not rolled - ${o.message}`));
    await notify(outcomes.some((o) => o.status !== 'rolled') ? 'Futures roll blocked' : 'Futures rolled', lines.join('; '));
    const { default: telegramService } = await import('./telegram.service.js');
    await telegramService
      .broadcastText(`*FUTURES ROLL*\n${lines.join('\n')}`)
      .catch((error) => log.warn('Futures roll: Telegram notice failed', { error: error.message }));
  }
}

export default new FuturesRollService();
