/**
 * Historical Candle Routes
 *
 * Read-only. Serves OHLCV for the chart and nothing else - no order placement, no position
 * mutation. Guarded by `pages.watchlists.view` rather than a new permission key so existing
 * roles work unchanged; charting a symbol is the same class of access as seeing it in a
 * watchlist.
 */

import express from 'express';
import candleService from '../../services/candle.service.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { ValidationError } from '../../core/errors.js';
import db from '../../core/database.js';
import riskControlsService from '../../services/risk-controls.service.js';
import { resolveOptionsUnderlyingKey, upcomingExpiries } from '../../utils/underlying.util.js';

const router = express.Router();
router.use(requireAuth);

const VIEW = requirePermission('pages.watchlists.view');

/**
 * GET /api/v1/history/timeframes?exchange=NSE
 * Timeframes the serving broker supports for this exchange.
 * Declared before /:something routes so the literal path is not shadowed.
 */
router.get('/timeframes', VIEW, async (req, res, next) => {
  try {
    const { exchange = 'NSE' } = req.query;
    res.json({ status: 'success', data: await candleService.getSupportedTimeframes(exchange) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/history/symbols
 * Symbols available to chart. Sourced from watchlist_symbols because that is what the chart
 * can also *trade* - a symbol configured in a watchlist carries the quantity defaults, product
 * and risk/auto-exit settings that every order path depends on. Charting something outside that
 * set would produce a chart whose trade buttons could not safely be wired up later.
 */
router.get('/symbols', VIEW, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT ws.id            AS symbolId,
              ws.exchange      AS exchange,
              ws.symbol        AS symbol,
              w.id             AS watchlistId,
              w.name           AS watchlistName,
              i.tick_size      AS tickSize
         FROM watchlist_symbols ws
         JOIN watchlists w ON w.id = ws.watchlist_id
         LEFT JOIN instruments i
           ON UPPER(i.exchange) = UPPER(ws.exchange) AND UPPER(i.symbol) = UPPER(ws.symbol)
        WHERE w.is_active = 1
        ORDER BY w.name, ws.symbol`
    );
    res.json({ status: 'success', data: rows });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/history/option-legs?symbolId=&ltp=&leg=ATM&expiry=
 *
 * The concrete CE and PE contracts an option order on this underlying would target, so the
 * chart can show them beside the underlying. Read-only: it resolves and returns symbols, it
 * places nothing.
 *
 * Strike selection deliberately mirrors options-resolution.service's offset convention
 * (ITM3..OTM3 around ATM) but resolves against the instruments master directly rather than
 * calling that service, because that path needs a live broker instance and a quote round-trip.
 * This is a display aid; the ACTUAL strike is still resolved per instance at execution, and may
 * differ if the underlying has moved - which the order confirmation states.
 */
router.get('/option-legs', VIEW, async (req, res, next) => {
  try {
    const symbolId = parseInt(req.query.symbolId, 10);
    const ltp = Number(req.query.ltp);
    const leg = String(req.query.leg || 'ATM').toUpperCase();
    const wantExpiry = req.query.expiry ? String(req.query.expiry) : null;

    if (!Number.isInteger(symbolId) || symbolId <= 0) {
      throw new ValidationError('symbolId must be a positive integer');
    }
    if (!Number.isFinite(ltp) || ltp <= 0) {
      throw new ValidationError('ltp is required to locate the at-the-money strike');
    }

    const row = await db.get(
      'SELECT symbol, underlying_symbol, exchange FROM watchlist_symbols WHERE id = ?',
      [symbolId]
    );
    if (!row) throw new ValidationError(`Symbol ${symbolId} not found`);

    // Segment-aware: an index keys to itself, an MCX future to its commodity, and a crypto
    // perpetual to its spot asset (BTCUSDFUT -> BTC). See underlying.util.js.
    const key = await resolveOptionsUnderlyingKey(row);
    if (!key) {
      return res.json({ status: 'success', data: { available: false, reason: 'no options for this underlying' } });
    }

    // Nearest expiry on or after today unless one is named. Formats differ by exchange
    // (DD-MMM-YY on NFO/BFO/MCX, YYYY-MM-DD on CRYPTO) - handled in underlying.util.js.
    const rows = await db.all(
      `SELECT DISTINCT expiry FROM instruments
        WHERE UPPER(underlying_key) = ? AND instrumenttype IN ('CE','PE') AND expiry IS NOT NULL`,
      [key]
    );
    const upcoming = upcomingExpiries(rows);
    const expiry = wantExpiry || upcoming[0] || null;

    if (!expiry) {
      return res.json({ status: 'success', data: { available: false, reason: 'no expiry found' } });
    }
    const expiryRow = { expiry };

    const strikes = await db.all(
      `SELECT DISTINCT strike FROM instruments
        WHERE UPPER(underlying_key) = ? AND expiry = ? AND instrumenttype IN ('CE','PE')
          AND strike > 0 ORDER BY strike ASC`,
      [key, expiryRow.expiry]
    );
    if (!strikes.length) {
      return res.json({ status: 'success', data: { available: false, reason: 'no strikes found' } });
    }

    const list = strikes.map((r) => Number(r.strike));
    let atmIdx = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (Math.abs(list[i] - ltp) < Math.abs(list[atmIdx] - ltp)) atmIdx = i;
    }
    // ITMn is below ATM for a call and above for a put, so the offset is applied per side.
    const off = { ITM3: 3, ITM2: 2, ITM1: 1, ATM: 0, OTM1: -1, OTM2: -2, OTM3: -3 }[leg] ?? 0;
    const clamp = (i) => Math.min(Math.max(i, 0), list.length - 1);
    const ceStrike = list[clamp(atmIdx - off)];
    const peStrike = list[clamp(atmIdx + off)];

    const find = async (strike, type) => db.get(
      `SELECT symbol, exchange, lotsize, strike, expiry FROM instruments
        WHERE UPPER(underlying_key) = ? AND expiry = ? AND strike = ? AND instrumenttype = ?
        LIMIT 1`,
      [key, expiryRow.expiry, strike, type]
    );

    const [ce, pe] = await Promise.all([find(ceStrike, 'CE'), find(peStrike, 'PE')]);

    res.json({
      status: 'success',
      data: {
        available: Boolean(ce || pe),
        underlying: key,
        expiry: expiryRow.expiry,
        // Served from the instruments cache so the chart needs no broker round-trip and no
        // guess at the derivatives exchange - asking /symbols/expiry with the INDEX exchange
        // (NSE_INDEX rather than NFO) is a 400 from the broker.
        expiries: upcoming.slice(0, 12),
        leg,
        atmStrike: list[atmIdx],
        ce: ce || null,
        pe: pe || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/history/levels?symbolId=123
 *
 * The symbol's configured target / stoploss / trailing levels, for the chart to draw and edit.
 *
 * These are NOT broker-side resting orders. They are the per-symbol risk config that
 * auto-exit.service already monitors and acts on via risk-controls.service - which is the
 * mechanism actually in use here (every existing strategy leg is POLLING, none are GTT). The
 * chart edits config that a running service consumes; it does not introduce a second, parallel
 * exit mechanism.
 *
 * Values are POINTS relative to entry, not absolute prices, because that is how the columns are
 * defined and how risk-controls converts them:
 *     targetPrice = entryPrice + direction * targetPoints
 *     stopPrice   = entryPrice - direction * stoplossPoints
 * The chart applies the exact inverse when a line is dragged.
 *
 * `mode` comes from riskControlsService._determineMode - the same function auto-exit uses to
 * pick which column set applies. Deliberately not re-derived from the chart's trade mode: the
 * server decides from the symbol name and type, and a client that guessed differently would
 * write to columns nothing reads.
 */
router.get('/levels', VIEW, async (req, res, next) => {
  try {
    const parsedSymbolId = parseInt(req.query.symbolId, 10);
    if (!Number.isInteger(parsedSymbolId) || parsedSymbolId <= 0) {
      throw new ValidationError('symbolId must be a positive integer');
    }

    const row = await db.get(
      'SELECT * FROM watchlist_symbols WHERE id = ?',
      [parsedSymbolId]
    );
    if (!row) throw new ValidationError(`Symbol ${parsedSymbolId} not found`);

    const mode = riskControlsService._determineMode(row, row.symbol);
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

    res.json({
      status: 'success',
      data: {
        symbolId: row.id,
        watchlistId: row.watchlist_id,
        symbol: row.symbol,
        exchange: row.exchange,
        mode,
        // Echoed so the client PUTs the same column names the server just read, rather than
        // rebuilding them from a mode string it could get wrong.
        columns: {
          target: `target_points_${mode}`,
          stoploss: `stoploss_points_${mode}`,
          trailing: `trailing_stoploss_points_${mode}`,
          trailingActivation: `trailing_activation_points_${mode}`,
        },
        points: {
          target: num(row[`target_points_${mode}`]),
          stoploss: num(row[`stoploss_points_${mode}`]),
          trailing: num(row[`trailing_stoploss_points_${mode}`]),
          trailingActivation: num(row[`trailing_activation_points_${mode}`]),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/history?exchange=NSE&symbol=SBIN&timeframe=5m&from=<unix>&to=<unix>
 *
 * `from`/`to` are unix seconds. Timestamps in the response are true UTC epoch seconds exactly
 * as the broker reports them - the IST display shift is applied by the chart, never here.
 */
router.get('/', VIEW, async (req, res, next) => {
  try {
    const { exchange, symbol, timeframe = '5m', from, to } = req.query;

    if (!exchange || !symbol) {
      throw new ValidationError('exchange and symbol are required');
    }
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value !== undefined && !Number.isFinite(Number(value))) {
        throw new ValidationError(`${name} must be a unix timestamp in seconds`);
      }
    }

    const result = await candleService.getCandles({ exchange, symbol, timeframe, from, to });

    // Fires on every chart open and every symbol/timeframe switch - the one guaranteed anchor
    // point for putting a chart's symbol into the broker-side WS subscription set immediately,
    // rather than depending on the chart's own REST polling to prime it as a side effect (that
    // polling stops the instant the browser's WS looks connected, which could leave the symbol
    // permanently unsubscribed - see market-data-feed.service.js's ensureSymbolSubscribed doc).
    marketDataFeedService.ensureSymbolSubscribed(String(exchange).toUpperCase(), String(symbol).toUpperCase());

    res.json({
      status: 'success',
      data: {
        exchange: String(exchange).toUpperCase(),
        symbol: String(symbol).toUpperCase(),
        timeframe,
        candles: result.candles,
        count: result.candles.length,
        // stale = the broker could not be reached (blackout / unhealthy instance) and these
        // candles came from cache. The UI says so rather than implying the data is live.
        stale: result.stale,
        source: result.source,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
