/**
 * Trades Routes
 * Provides tradebook snapshots grouped by instance
 */

import express from 'express';
import marketDataFeedService from '../../services/market-data-feed.service.js';
import instanceService from '../../services/instance.service.js';

const router = express.Router();

function parseTradeTimestamp(raw) {
  if (!raw) return null;
  const value = String(raw).trim();

  // Format: HH:MM:SS DD-MM-YYYY
  const timeFirstMatch = value.match(
    /^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})[-/](\d{2})[-/](\d{4})$/
  );
  if (timeFirstMatch) {
    const [, hh, mm, ss, dd, month, yyyy] = timeFirstMatch;
    const date = new Date(
      Number(yyyy),
      Number(month) - 1,
      Number(dd),
      Number(hh),
      Number(mm),
      Number(ss)
    );
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback;
  }

  return null;
}

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
      const action = (trade.action || trade.side || '').toUpperCase();
      const quantity = Number(trade.quantity) || 0;
      const price = Number(trade.average_price ?? trade.price ?? 0) || 0;
      const tradeValue = Number(trade.trade_value ?? quantity * price) || 0;
      const timestampRaw = trade.timestamp || trade.trade_time || trade.placed_at;
      const parsedTimestamp = parseTradeTimestamp(timestampRaw);
      const timestampEpoch = parsedTimestamp ? parsedTimestamp.getTime() : null;

      if (action === 'BUY') {
        payload.statistics.total_buy_trades += 1;
      } else if (action === 'SELL') {
        payload.statistics.total_sell_trades += 1;
      }
      payload.statistics.total_quantity += quantity;
      payload.statistics.total_value += tradeValue;

      return {
        symbol: trade.symbol || trade.tradingsymbol,
        exchange: trade.exchange,
        product: trade.product,
        action,
        quantity,
        average_price: price,
        trade_value: tradeValue,
        timestamp: timestampRaw,
        timestamp_iso: parsedTimestamp ? parsedTimestamp.toISOString() : null,
        timestamp_epoch: timestampEpoch,
        metadata: trade,
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
