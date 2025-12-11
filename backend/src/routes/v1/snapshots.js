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
 * GET /api/v1/snapshots/quotes
 * Optional filters: instanceId, exchange, symbols (comma-separated), refresh (default true)
 */
router.get('/quotes', async (req, res, next) => {
  try {
    const allowRefresh = req.query.refresh !== 'false';
    const exchangeFilter = req.query.exchange ? String(req.query.exchange).toUpperCase() : null;
    const symbolFilter = parseSymbols(req.query.symbols);
    const instanceId = req.query.instanceId ? parseInstanceId(req.query.instanceId) : null;

    // Determine which instances to return
    const cacheStatus = marketDataFeedService.getCacheStatus();
    const instanceIds = instanceId
      ? [instanceId]
      : cacheStatus.entries.filter((e) => e.feed === 'quotes').map((e) => e.instanceId);

    const results = [];
    let refreshed = false;

    for (const id of instanceIds) {
      let snapshot = marketDataFeedService.getQuoteSnapshot(id);
      const ttlMs = marketDataFeedService.QUOTE_TTL_MS;
      let stale = isStale(snapshot, ttlMs);

      if ((stale || !snapshot) && allowRefresh) {
        await marketDataFeedService.refreshQuotes({ force: true });
        snapshot = marketDataFeedService.getQuoteSnapshot(id);
        stale = isStale(snapshot, ttlMs);
        refreshed = true;
      }

      let data = snapshot?.data || [];
      if (exchangeFilter) {
        data = data.filter((q) => (q.exchange || q.exch || '').toUpperCase() === exchangeFilter);
      }
      if (symbolFilter.length) {
        const set = new Set(symbolFilter);
        data = data.filter((q) => set.has((q.symbol || '').toUpperCase()));
      }

      results.push({
        instance_id: id,
        fetched_at: snapshot?.fetchedAt || null,
        age_ms: snapshot?.fetchedAt ? Date.now() - snapshot.fetchedAt : null,
        stale,
        count: data.length,
        quotes: data,
      });
    }

    res.json({
      status: 'success',
      data: { refreshed, instances: results },
    });
  } catch (error) {
    next(error);
  }
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

/**
 * GET /api/v1/snapshots/orders/:instanceId
 */
router.get('/orders/:instanceId', async (req, res, next) => {
  try {
    const instanceId = parseInstanceId(req.params.instanceId);
    const allowRefresh = req.query.refresh !== 'false';
    const ttlMs = marketDataFeedService._getStatefulTtlMs('orderbook');
    let snapshot = await marketDataFeedService.getOrderbookSnapshot(instanceId, { force: false });
    let stale = isStale(snapshot, ttlMs);

    if ((stale || !snapshot) && allowRefresh) {
      snapshot = await marketDataFeedService.getOrderbookSnapshot(instanceId, { force: true });
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
        orders: data,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/snapshots/trades/:instanceId
 */
router.get('/trades/:instanceId', async (req, res, next) => {
  try {
    const instanceId = parseInstanceId(req.params.instanceId);
    const allowRefresh = req.query.refresh !== 'false';
    const ttlMs = marketDataFeedService._getStatefulTtlMs('tradebook');
    let snapshot = await marketDataFeedService.getTradebookSnapshot(instanceId, { force: false });
    let stale = isStale(snapshot, ttlMs);

    if ((stale || !snapshot) && allowRefresh) {
      snapshot = await marketDataFeedService.getTradebookSnapshot(instanceId, { force: true });
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
        trades: data,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
