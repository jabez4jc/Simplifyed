import express from 'express';
import tradingviewBroadcastService from '../services/tradingview-broadcast.service.js';
import strategyService from '../services/strategy.service.js';
import idempotencyService from '../services/idempotency.service.js';
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

    // Strategy webhooks use their own slug namespace and a different execution path (multi-leg,
    // basket-batched) rather than the watchlist broadcast-to-many-instances path. instanceId is
    // optional here too - when omitted, targets every active, order-enabled instance assigned to
    // the strategy's watchlist; pass ?instanceId= to override and target just one.
    const slugParam = req.params.slug || req.query.watchlistSlug || req.query.watchlist || null;
    if (slugParam) {
      const strategy = await strategyService.findByWebhookSlug(slugParam);
      if (strategy) {
        const instanceIdRaw = req.query.instanceId || parsedBody?.instance_id;
        const instanceId = instanceIdRaw ? parseInt(instanceIdRaw, 10) : null;
        // action defaults to ENTRY (executeStrategy) for backward compatibility with existing
        // webhook configs that never sent an action field - EXIT/EXIT_ALL closes every leg that's
        // still open instead, symmetric with the EXIT/EXIT_ALL actions regular (non-strategy)
        // watchlist webhook alerts already support.
        const action = String(req.query.action || parsedBody?.action || 'ENTRY').toUpperCase();
        const isExit = action === 'EXIT' || action === 'EXIT_ALL';
        // leg_tag is optional - a TradingView alert can't reference an internal numeric leg id,
        // so legs are addressed by this user-editable tag instead (set on the leg, see
        // strategy-builder.js). Omit it to keep the existing enter-every-leg/exit-every-leg
        // behavior.
        const legTagRaw = req.query.leg_tag || parsedBody?.leg_tag || null;
        const legId = legTagRaw
          ? await strategyService._resolveLegId(strategy.id, { legTag: legTagRaw })
          : null;
        const result = isExit
          ? await strategyService.exitStrategy(strategy.id, { instanceId, legId, source: 'strategy_webhook' })
          : await strategyService.executeStrategy(strategy.id, { instanceId, legId, source: 'strategy_webhook' });
        return res.status(result.success ? 200 : 502).json({
          status: result.success ? 'ok' : 'error',
          data: result,
        });
      }
    }

    const requestIdHeader = req.get('X-Request-Id');
    const requestIdBody = parsedBody?.request_id;
    const requestId = requestIdHeader || requestIdBody || null;
    if (requestId !== null && (typeof requestId !== 'string' || !requestId.trim())) {
      throw new ValidationError('request_id must be a non-empty string');
    }

    const normalized = tradingviewBroadcastService.normalizePayload(parsedBody);
    const watchlistIdRaw = req.query.watchlistId;
    const watchlistId = watchlistIdRaw ? parseInt(watchlistIdRaw, 10) : null;
    if (watchlistIdRaw && Number.isNaN(watchlistId)) {
      throw new ValidationError('watchlistId must be an integer');
    }
    const watchlistSlug = req.params.slug || req.query.watchlistSlug || req.query.watchlist || null;

    if (requestId) {
      const { hit, record, mismatch } = await idempotencyService.getOrCreate({
        requestId,
        source: 'webhook',
        payload: { normalized, watchlistId, watchlistSlug },
      });
      if (mismatch) {
        return res.status(409).json({
          status: 'error',
          message: 'Request ID reuse with different payload',
        });
      }
      if (hit && record?.response_json) {
        const cached = JSON.parse(record.response_json);
        res.set('X-Idempotency-Hit', 'true');
        const statusCode = record.status_code || (record.status === 'success' ? 200 : 409);
        return res.status(statusCode).json(cached);
      }
      if (hit) {
        return res.status(409).json({
          status: 'error',
          message: 'Request is already in progress',
        });
      }
    }

    const result = await tradingviewBroadcastService.broadcast(normalized, { watchlistId, watchlistSlug });

    const responsePayload = {
      status: result.ok ? 'ok' : 'error',
      message: result.message,
      results: result.results,
      summary: {
        total: result.total,
        successful: result.okCount,
        failed: result.total - result.okCount,
      },
      watchlist: result.watchlist,
    };

    if (requestId) {
      await idempotencyService.complete({
        requestId,
        source: 'webhook',
        response: responsePayload,
        status: result.ok ? 'success' : 'failed',
        statusCode: result.ok ? 200 : 502,
      });
    }

    res.status(result.ok ? 200 : 502).json(responsePayload);
  } catch (error) {
    const requestId = req.get('X-Request-Id') || req.body?.request_id || null;
    if (requestId && typeof requestId === 'string' && requestId.trim()) {
      await idempotencyService.complete({
        requestId: requestId.trim(),
        source: 'webhook',
        response: {
          status: 'error',
          message: error.message,
        },
        status: 'failed',
        statusCode: error.statusCode || 500,
      });
    }
    next(error);
  }
});

export default router;
