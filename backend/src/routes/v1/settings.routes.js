/**
 * Settings Routes
 * API endpoints for hierarchical settings management
 *
 * Endpoints:
 * - GET    /settings/effective - Get merged effective settings
 * - PATCH  /settings/global - Update global defaults
 * - GET    /settings/global - Get global defaults
 * - PATCH  /settings/index/:indexName - Update index profile
 * - GET    /settings/index/:indexName - Get index profile
 * - PATCH  /settings/watchlist/:watchlistId - Update watchlist overrides
 * - GET    /settings/watchlist/:watchlistId - Get watchlist overrides
 * - PATCH  /settings/user/:userId - Update user defaults
 * - GET    /settings/user/:userId - Get user defaults
 * - PATCH  /settings/symbol/:symbol - Update symbol overrides
 * - GET    /settings/symbol/:symbol - Get symbol overrides
 * - GET    /settings/audit - Get config audit log
 */

import express from 'express';
import settingsService from '../../services/settings.service.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { ValidationError } from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/settings/effective
 * Get effective settings by merging all hierarchy levels
 *
 * Query params:
 * - userId: User ID (required)
 * - watchlistId: Watchlist ID (optional)
 * - indexName: Index name (optional)
 * - symbol: Symbol (optional)
 * - exchange: Exchange (optional)
 */
router.get(
  '/effective',
  asyncHandler(async (req, res) => {
    const { userId, watchlistId, indexName, symbol, exchange } = req.query;

    if (!userId) {
      throw new ValidationError('userId query parameter is required');
    }

    const context = {
      userId: parseInt(userId),
      watchlistId: watchlistId ? parseInt(watchlistId) : undefined,
      indexName: indexName || undefined,
      symbol: symbol || undefined,
      exchange: exchange || undefined,
    };

    const settings = await settingsService.getEffectiveSettings(context);

    res.json({
      success: true,
      data: settings,
      context,
    });
  })
);

/**
 * GET /api/v1/settings/global
 * Get global defaults
 */
router.get(
  '/global',
  asyncHandler(async (req, res) => {
    const settings = await settingsService._getGlobalDefaults();

    res.json({
      success: true,
      data: settings,
    });
  })
);

/**
 * PATCH /api/v1/settings/global
 * Update global defaults
 *
 * Body: Settings fields to update
 */
router.patch(
  '/global',
  asyncHandler(async (req, res) => {
    const userId = req.user?.id || 1; // Fallback to user 1 for test mode

    if (!req.user?.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can update global settings',
      });
    }

    const updated = await settingsService.updateGlobalDefaults(req.body, userId);

    res.json({
      success: true,
      data: updated,
      message: 'Global defaults updated successfully',
    });
  })
);

/**
 * GET /api/v1/settings/index/:indexName
 * Get index profile
 */
router.get(
  '/index/:indexName',
  asyncHandler(async (req, res) => {
    const { indexName } = req.params;

    const profile = await settingsService._getIndexProfile(indexName);

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: `Index profile for ${indexName} not found`,
      });
    }

    res.json({
      success: true,
      data: profile,
    });
  })
);

/**
 * PATCH /api/v1/settings/index/:indexName
 * Update or create index profile
 *
 * Body: Settings fields to update
 */
router.patch(
  '/index/:indexName',
  asyncHandler(async (req, res) => {
    const { indexName } = req.params;
    const userId = req.user?.id || 1;

    if (!req.user?.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can update index profiles',
      });
    }

    const updated = await settingsService.updateIndexProfile(
      indexName,
      req.body,
      userId
    );

    res.json({
      success: true,
      data: updated,
      message: `Index profile for ${indexName} updated successfully`,
    });
  })
);

/**
 * GET /api/v1/settings/watchlist/:watchlistId
 * Get watchlist overrides
 *
 * Query params:
 * - indexName: Index name (optional)
 */
router.get(
  '/watchlist/:watchlistId',
  asyncHandler(async (req, res) => {
    const { watchlistId } = req.params;
    const { indexName } = req.query;

    const overrides = await settingsService._getWatchlistOverrides(
      parseInt(watchlistId),
      indexName || null
    );

    if (!overrides) {
      return res.status(404).json({
        success: false,
        error: `Watchlist overrides for watchlist ${watchlistId} not found`,
      });
    }

    res.json({
      success: true,
      data: overrides,
    });
  })
);

/**
 * PATCH /api/v1/settings/watchlist/:watchlistId
 * Update or create watchlist overrides
 *
 * Query params:
 * - indexName: Index name (optional)
 *
 * Body: Settings fields to update
 */
router.patch(
  '/watchlist/:watchlistId',
  asyncHandler(async (req, res) => {
    const { watchlistId } = req.params;
    const { indexName } = req.query;
    const userId = req.user?.id || 1;

    if (!req.user?.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can update watchlist settings',
      });
    }

    const updated = await settingsService.updateWatchlistOverrides(
      parseInt(watchlistId),
      indexName || null,
      req.body,
      userId
    );

    res.json({
      success: true,
      data: updated,
      message: `Watchlist overrides updated successfully`,
    });
  })
);

/**
 * GET /api/v1/settings/user/:userId
 * Get user defaults
 */
router.get(
  '/user/:userId',
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    // Users can only view their own defaults (unless admin)
    if (!req.user?.is_admin && req.user?.id !== parseInt(userId)) {
      return res.status(403).json({
        success: false,
        error: 'You can only view your own settings',
      });
    }

    const defaults = await settingsService._getUserDefaults(parseInt(userId));

    if (!defaults) {
      return res.status(404).json({
        success: false,
        error: `User defaults for user ${userId} not found`,
      });
    }

    res.json({
      success: true,
      data: defaults,
    });
  })
);

/**
 * PATCH /api/v1/settings/user/:userId
 * Update or create user defaults
 *
 * Body: Settings fields to update
 */
router.patch(
  '/user/:userId',
  asyncHandler(async (req, res) => {
    const { userId } = req.params;

    // Users can only update their own defaults (unless admin)
    if (!req.user?.is_admin && req.user?.id !== parseInt(userId)) {
      return res.status(403).json({
        success: false,
        error: 'You can only update your own settings',
      });
    }

    const updated = await settingsService.updateUserDefaults(
      parseInt(userId),
      req.body
    );

    res.json({
      success: true,
      data: updated,
      message: 'User defaults updated successfully',
    });
  })
);

/**
 * GET /api/v1/settings/symbol/:symbol
 * Get symbol overrides
 *
 * Query params:
 * - exchange: Exchange (required)
 */
router.get(
  '/symbol/:symbol',
  asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const { exchange } = req.query;

    if (!exchange) {
      throw new ValidationError('exchange query parameter is required');
    }

    const overrides = await settingsService._getSymbolOverrides(symbol, exchange);

    if (!overrides) {
      return res.status(404).json({
        success: false,
        error: `Symbol overrides for ${exchange}:${symbol} not found`,
      });
    }

    res.json({
      success: true,
      data: overrides,
    });
  })
);

/**
 * PATCH /api/v1/settings/symbol/:symbol
 * Update or create symbol overrides
 *
 * Query params:
 * - exchange: Exchange (required)
 *
 * Body: Settings fields to update
 */
router.patch(
  '/symbol/:symbol',
  asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const { exchange } = req.query;
    const userId = req.user?.id || 1;

    if (!exchange) {
      throw new ValidationError('exchange query parameter is required');
    }

    if (!req.user?.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'Only administrators can update symbol settings',
      });
    }

    const updated = await settingsService.updateSymbolOverrides(
      symbol,
      exchange,
      req.body,
      userId
    );

    res.json({
      success: true,
      data: updated,
      message: `Symbol overrides for ${exchange}:${symbol} updated successfully`,
    });
  })
);

/**
 * GET /api/v1/settings/audit
 * Get config audit log
 *
 * Query params:
 * - scope: Filter by scope (optional)
 * - scopeKey: Filter by scope key (optional)
 * - userId: Filter by user (optional)
 */
router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const { scope, scopeKey, userId } = req.query;

    const filters = {
      scope: scope || undefined,
      scopeKey: scopeKey || undefined,
      userId: userId ? parseInt(userId) : undefined,
    };

    const audit = await settingsService.getConfigAudit(filters);

    res.json({
      success: true,
      data: audit,
      count: audit.length,
    });
  })
);

export default router;
