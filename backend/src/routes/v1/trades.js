/**
 * Trades Routes
 * Provides tradebook snapshots grouped by instance
 */

import express from 'express';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import instanceService from '../../services/instance.service.js';
import { normalizeTradebookEntry } from '../../utils/tradebook-utils.js';

const router = express.Router();

router.get('/tradebook', async (req, res, next) => {
  try {
    const instances = await instanceService.getAllInstances({ is_active: true });
    const payload = {
      liveInstances: [],
      analyzerInstances: [],
      statistics: {
        total_trades: 0,
        total_buy_trades: 0,
        total_sell_trades: 0,
        total_quantity: 0,
        total_value: 0,
      },
      fetchedAt: Date.now(),
    };

    const normalizeTrade = (trade = {}) => {
      const normalized = normalizeTradebookEntry(trade);

      if (normalized.action === 'BUY') {
        payload.statistics.total_buy_trades += 1;
      } else if (normalized.action === 'SELL') {
        payload.statistics.total_sell_trades += 1;
      }
      payload.statistics.total_quantity += normalized.quantity;
      payload.statistics.total_value += normalized.trade_value;

      return {
        ...normalized,
        product: trade.product,
      };
    };

    await Promise.all(
      instances.map(async (instance) => {
        const snapshot = await marketDataFeedService.getTradebookSnapshot(instance.id);
        const tradesRaw = Array.isArray(snapshot?.data) ? snapshot.data : [];
        const normalizedTrades = tradesRaw.map(normalizeTrade);
        normalizedTrades.sort((a, b) => (b.timestamp_epoch || 0) - (a.timestamp_epoch || 0));
        payload.statistics.total_trades += normalizedTrades.length;

        const entry = {
          instance_id: instance.id,
          instance_name: instance.name,
          broker: instance.broker,
          is_analyzer_mode: !!instance.is_analyzer_mode,
          trades: normalizedTrades,
          fetchedAt: snapshot?.fetchedAt || null,
        };

        if (instance.is_analyzer_mode) {
          payload.analyzerInstances.push(entry);
        } else {
          payload.liveInstances.push(entry);
        }
      })
    );

    res.json({
      status: 'success',
      data: payload,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
