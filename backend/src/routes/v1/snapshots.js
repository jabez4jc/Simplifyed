/**
 * Snapshot Routes
 * Provides cache-backed snapshots for quotes, positions, orderbook, and trades
 */

import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import { ValidationError } from '../../core/errors.js';

const router = express.Router();
router.use(requireAuth);

function parseInstanceId(instanceId) {
  const id = Number(instanceId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('instanceId must be a positive integer');
  }
  return id;
}

function parseSymbols(symbols) {
  if (!symbols) return [];
  return symbols
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toUpperCase());
}

function isStale(snapshot, ttlMs) {
  if (!snapshot?.fetchedAt || !ttlMs) return true;
  return Date.now() - snapshot.fetchedAt > ttlMs;
}

/**
 * GET /api/v1/snapshots/quotes?exchange=NFO&symbols=A,B
 * The feed's last quote per symbol, whatever instance or WebSocket delivered it. Cache only: a
 * request never triggers a broker refresh - the feed's own polling and the WS stream keep it warm.
 * `stale` compares each quote's age with the quote TTL, so a client does not chart an old price.
 */
router.get('/quotes', (req, res) => {
  const exchange = String(req.query.exchange || '').toUpperCase();
  const symbols = parseSymbols(req.query.symbols);
  if (!exchange || symbols.length === 0) {
    throw new ValidationError('exchange and symbols are required');
  }

  const { cached, missing } = marketDataFeedService.getCachedQuoteEntriesForSymbols(
    symbols.map((symbol) => ({ exchange, symbol })),
    { ttlMs: Infinity }
  );
  const now = Date.now();
  const ttlMs = marketDataFeedService.QUOTE_TTL_MS;

  res.json({
    status: 'success',
    data: {
      quotes: cached.map(({ quote, fetchedAt }) => ({
        exchange,
        symbol: quote.symbol,
        fetched_at: fetchedAt,
        age_ms: now - fetchedAt,
        stale: now - fetchedAt > ttlMs,
        quote,
      })),
      missing: missing.map((m) => m.symbol),
    },
  });
});

/**
 * GET /api/v1/snapshots/positions/:instanceId
 */
router.get('/positions/:instanceId', async (req, res, next) => {
  try {
    const instanceId = parseInstanceId(req.params.instanceId);
    const allowRefresh = req.query.refresh !== 'false';
    const ttlMs = marketDataFeedService._getStatefulTtlMs('positions'); // use existing dynamic TTL
    let snapshot = marketDataFeedService.getPositionSnapshot(instanceId);
    let stale = isStale(snapshot, ttlMs);

    if ((stale || !snapshot) && allowRefresh) {
      await marketDataFeedService.refreshPositionsForInstance(instanceId, { force: true });
      snapshot = marketDataFeedService.getPositionSnapshot(instanceId);
      stale = isStale(snapshot, ttlMs);
    }

    const data = snapshot?.data || [];
    res.json({
      status: 'success',
      data: {
        instance_id: instanceId,
        fetched_at: snapshot?.fetchedAt || null,
        age_ms: snapshot?.fetchedAt ? Date.now() - snapshot.fetchedAt : null,
        stale,
        count: data.length,
        positions: data,
      },
    });
  } catch (error) {
    next(error);
  }
});



export default router;
