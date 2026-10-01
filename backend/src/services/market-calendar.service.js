import { log } from '../core/logger.js';
import marketDataInstanceService from './market-data-instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { toISTDate } from '../utils/time.js';
import { isCryptoBroker } from '../utils/broker-type.util.js';

const TIMINGS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const HOLIDAYS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Index segments trade under a real exchange's session, but OpenAlgo's market/timings and
 * market/holidays endpoints have never heard of NSE_INDEX or BSE_INDEX - they answer for NSE,
 * BSE, NFO, BFO, MCX, BCD, CDS, NCO, CRYPTO only. An exact-string match therefore NEVER finds
 * an entry for an index segment, `isExchangeOpen` returns false unconditionally, and
 * `filterOpenSymbols` drops every index symbol from the WS subscription list permanently -
 * regardless of instance, regardless of the time of day. Observed live: NIFTY and BANKNIFTY
 * were never subscribed on any instance, so their cached quotes could only get older.
 *
 * The underlying's index runs on the same clock as its own cash segment, so the timings
 * question for NSE_INDEX is answered by NSE's session.
 */
const CALENDAR_EXCHANGE_ALIASES = { NSE_INDEX: 'NSE', BSE_INDEX: 'BSE' };

function calendarExchange(exchange) {
  const ex = (exchange || '').toUpperCase();
  return CALENDAR_EXCHANGE_ALIASES[ex] || ex;
}

class MarketCalendarService {
  constructor() {
    this.timingsCache = new Map(); // date -> { data, fetchedAt }
    this.holidaysCache = new Map(); // year -> { byDate: Map, fetchedAt }
  }

  _formatDate(date = new Date()) {
    const d = toISTDate(date);
    const pad = (n) => String(n).padStart(2, '0');
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    return `${year}-${month}-${day}`;
  }

  _getYear(date = new Date()) {
    return toISTDate(date).getFullYear();
  }

  _normalizeDate(value) {
    if (!value || typeof value !== 'string') return null;
    const match = value.match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
  }

  /** The market-data instance, else `via` - any OpenAlgo host answers the calendar endpoints. */
  async _getInstance(via = null) {
    try {
      return await marketDataInstanceService.getMarketDataInstance();
    } catch (err) {
      if (via) return via;
      log.warn('No market data instance available for calendar checks', { error: err.message });
      return null;
    }
  }

  async getMarketTimings(dateStr, via = null) {
    const cached = this.timingsCache.get(dateStr);
    if (cached && Date.now() - cached.fetchedAt < TIMINGS_CACHE_TTL_MS) {
      return cached.data || [];
    }

    const instance = await this._getInstance(via);
    if (!instance) return cached?.data || [];

    try {
      const data = await openalgoClient.getMarketTimings(instance, dateStr);
      const timings = Array.isArray(data) ? data : [];
      this.timingsCache.set(dateStr, { data: timings, fetchedAt: Date.now() });
      return timings;
    } catch (err) {
      log.warn('Failed to load market timings', { date: dateStr, error: err.message });
      return cached?.data || [];
    }
  }

  async getMarketHolidays(year, via = null) {
    const cached = this.holidaysCache.get(year);
    if (cached && Date.now() - cached.fetchedAt < HOLIDAYS_CACHE_TTL_MS) {
      return cached.byDate;
    }

    const instance = await this._getInstance(via);
    if (!instance) return cached?.byDate || new Map();

    try {
      const data = await openalgoClient.getMarketHolidays(instance, year);
      const byDate = new Map();
      if (Array.isArray(data)) {
        data.forEach((row) => {
          if (typeof row === 'string') {
            const parsed = this._normalizeDate(row);
            if (parsed) {
              byDate.set(parsed, {
                date: parsed,
                holiday_type: 'TRADING_HOLIDAY',
                closedExchanges: new Set(),
                openExchanges: new Map(),
              });
            }
            return;
          }
          if (row && typeof row === 'object') {
            const candidate =
              row.date ||
              row.holiday_date ||
              row.trading_date ||
              row.holiday ||
              row.day;
            const parsed = this._normalizeDate(candidate);
            if (!parsed) return;
            const closed = Array.isArray(row.closed_exchanges)
              ? row.closed_exchanges.map((e) => String(e).toUpperCase())
              : [];
            const open = Array.isArray(row.open_exchanges) ? row.open_exchanges : [];
            const openMap = new Map();
            open.forEach((entry) => {
              const ex = (entry?.exchange || '').toUpperCase();
              if (!ex) return;
              const start = Number(entry.start_time ?? entry.startTime ?? entry.start ?? 0);
              const end = Number(entry.end_time ?? entry.endTime ?? entry.end ?? 0);
              openMap.set(ex, { start, end });
            });
            byDate.set(parsed, {
              date: parsed,
              holiday_type: row.holiday_type || row.type || 'TRADING_HOLIDAY',
              closedExchanges: new Set(closed),
              openExchanges: openMap,
            });
          }
        });
      }
      this.holidaysCache.set(year, { byDate, fetchedAt: Date.now() });
      return byDate;
    } catch (err) {
      log.warn('Failed to load market holidays', { year, error: err.message });
      return cached?.byDate || new Map();
    }
  }

  async getHolidayInfo(date = new Date(), via = null) {
    const dateStr = this._formatDate(date);
    const year = this._getYear(date);
    const holidays = await this.getMarketHolidays(year, via);
    if (!holidays || holidays.size === 0) return null;
    return holidays.get(dateStr) || null;
  }

  async isHoliday(date = new Date()) {
    const info = await this.getHolidayInfo(date);
    return !!info;
  }

  /** true/false, or null when today's timings could not be loaded (callers decide how to fail). */
  async isExchangeOpen(exchange, date = new Date(), via = null) {
    const ex = calendarExchange(exchange);
    if (!ex) return false;

    const dateStr = this._formatDate(date);

    const holidayInfo = await this.getHolidayInfo(date, via);
    if (holidayInfo) {
      if (holidayInfo.openExchanges?.has(ex)) {
        const window = holidayInfo.openExchanges.get(ex);
        if (!window || !window.start || !window.end) return false;
        const nowMs = Date.now();
        return nowMs >= window.start && nowMs <= window.end;
      }
      if (holidayInfo.closedExchanges?.has(ex)) {
        return false;
      }
      // If holiday exists but exchange not explicitly closed/open, fall back to timings.
    }

    const timings = await this.getMarketTimings(dateStr, via);
    if (!Array.isArray(timings) || timings.length === 0) {
      // Loaded-but-empty is a real answer (weekend/holiday: closed). Never loaded at all is
      // UNKNOWN - null, not false - so risk monitors can fail open instead of going blind.
      return this.timingsCache.has(dateStr) ? false : null;
    }

    const entry = timings.find((t) => (t.exchange || '').toUpperCase() === ex);
    if (!entry) {
      return false;
    }

    const start = Number(entry.start_time ?? entry.startTime ?? entry.start ?? 0);
    const end = Number(entry.end_time ?? entry.endTime ?? entry.end ?? 0);
    if (!start || !end) {
      return false;
    }

    const nowMs = Date.now();
    return nowMs >= start && nowMs <= end;
  }

  /**
   * Is any market this instance trades open right now? Gates background polling (order sync,
   * P&L, positions, funds) so nothing hits the broker after hours. Crypto brokers never close.
   * NFO/BFO keep NSE/BSE hours, so four exchanges cover every Indian segment; MCX runs latest.
   * Fails open when today's timings could not be loaded - better an idle poll than a missed fill.
   */
  async isInstanceMarketOpen(instance, date = new Date()) {
    if (isCryptoBroker(instance?.broker)) return true;
    for (const ex of ['NSE', 'BSE', 'CDS', 'MCX']) {
      if (await this.isExchangeOpen(ex, date, instance)) return true;
    }
    const dateStr = this._formatDate(date);
    await this.getMarketTimings(dateStr, instance); // a holiday short-circuits isExchangeOpen before this
    return !this.timingsCache.has(dateStr);
  }

  async getNextSessionOpen(exchange, fromDate = new Date(), { maxDays = 7 } = {}) {
    const ex = calendarExchange(exchange);
    if (!ex) return null;

    const base = toISTDate(fromDate);
    const nowMs = new Date(fromDate).getTime();
    const lookahead = Math.max(1, Math.min(30, Number(maxDays) || 7));

    for (let offset = 0; offset <= lookahead; offset += 1) {
      const date = new Date(base);
      date.setHours(0, 0, 0, 0);
      date.setDate(base.getDate() + offset);
      const dateStr = this._formatDate(date);

      let holidayInfo = null;
      try {
        holidayInfo = await this.getHolidayInfo(date);
      } catch (err) {
        log.warn('Failed to resolve holiday info for session open lookup', {
          exchange: ex,
          date: dateStr,
          error: err.message,
        });
      }

      const holidayWindow =
        holidayInfo?.openExchanges?.has(ex) ? holidayInfo.openExchanges.get(ex) : null;
      if (holidayInfo?.closedExchanges?.has(ex) && !holidayWindow) {
        continue;
      }

      if (holidayWindow && holidayWindow.start && holidayWindow.end) {
        if (offset === 0) {
          if (nowMs < holidayWindow.start) return holidayWindow.start;
          if (nowMs >= holidayWindow.end) continue;
          // In-session: next open is the next trading window.
          continue;
        }
        return holidayWindow.start;
      }

      const timings = await this.getMarketTimings(dateStr);
      if (!Array.isArray(timings) || timings.length === 0) continue;
      const entry = timings.find((t) => (t.exchange || '').toUpperCase() === ex);
      if (!entry) continue;

      const start = Number(entry.start_time ?? entry.startTime ?? entry.start ?? 0);
      const end = Number(entry.end_time ?? entry.endTime ?? entry.end ?? 0);
      if (!start || !end) continue;

      if (offset === 0) {
        if (nowMs < start) return start;
        if (nowMs >= end) continue;
        // In-session: next open is the next trading window.
        continue;
      }
      return start;
    }

    return null;
  }

  async filterOpenSymbols(symbols = []) {
    if (!Array.isArray(symbols) || symbols.length === 0) return [];

    const results = [];
    const cache = new Map();

    for (const s of symbols) {
      // Cached under the RAW exchange (a symbol still carries NSE_INDEX downstream), even
      // though the open/closed question is answered against the aliased one.
      const raw = (s.exchange || '').toUpperCase();
      if (!raw) continue;
      if (!cache.has(raw)) {
        cache.set(raw, await this.isExchangeOpen(raw));
      }
      if (cache.get(raw)) {
        results.push(s);
      }
    }

    return results;
  }
}

export default new MarketCalendarService();
