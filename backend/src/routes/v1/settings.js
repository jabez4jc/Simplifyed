/**
 * Settings Routes
 * API endpoints for managing application settings
 */

import express from 'express';
import settingsService from '../../services/settings.service.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/v1/settings/schema
 * The runtime-editable settings, grouped and labelled for display, with current values.
 * Registered before /:category so the literal path isn't swallowed by the param route.
 */
router.get('/schema', requirePermission('pages.settings.view'), async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await settingsService.getSchema() });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/settings
 * Update multiple settings
 */
router.put('/', requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const settings = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({
        status: 'error',
        message: 'Settings object is required'
      });
    }

    const result = await settingsService.updateSettings(settings);

    res.json({
      status: 'success',
      message: 'Settings updated successfully',
      data: {
        updated: result.updated,
        errors: result.errors,
        summary: {
          total: Object.keys(settings).length,
          successful: Object.keys(result.updated).length,
          failed: result.errors.length
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
