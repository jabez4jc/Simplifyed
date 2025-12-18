import express from 'express';
import tradingviewBroadcastService from '../services/tradingview-broadcast.service.js';
import { ValidationError } from '../core/errors.js';

const router = express.Router();

// Accept JSON, text, or form bodies (TradingView can send plain text JSON)
router.use(express.text({ type: '*/*', limit: '1mb' }));
router.use(express.urlencoded({ extended: true, limit: '1mb' }));

router.post('/broadcast/:slug?', async (req, res, next) => {
  try {
    const tokenHeader = req.get('X-Webhook-Token') || req.query.token || req.query.t || null;
    tradingviewBroadcastService.assertAuthorized(tokenHeader);

    const parsedBody = tradingviewBroadcastService.parseRequestBody(req);
    if (!parsedBody) {
      throw new ValidationError('Request body must be valid JSON');
    }

    const normalized = tradingviewBroadcastService.normalizePayload(parsedBody);
    const watchlistIdRaw = req.query.watchlistId;
    const watchlistId = watchlistIdRaw ? parseInt(watchlistIdRaw, 10) : null;
    if (watchlistIdRaw && Number.isNaN(watchlistId)) {
      throw new ValidationError('watchlistId must be an integer');
    }
    const watchlistSlug = req.params.slug || req.query.watchlistSlug || req.query.watchlist || null;
    const result = await tradingviewBroadcastService.broadcast(normalized, { watchlistId, watchlistSlug });

    res.status(result.ok ? 200 : 502).json({
      status: result.ok ? 'ok' : 'error',
      message: result.message,
      results: result.results,
      summary: {
        total: result.total,
        successful: result.okCount,
        failed: result.total - result.okCount,
      },
      watchlist: result.watchlist,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
