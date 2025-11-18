/**
 * Settings Routes
 * API endpoints for managing application settings
 */

import express from 'express';
import settingsService from '../../services/settings.service.js';
import { log } from '../../core/logger.js';

const router = express.Router();

/**
 * GET /api/v1/settings
 * Get all settings grouped by category
 */
router.get('/', async (req, res, next) => {
  try {
    const settings = await settingsService.getAllSettings();
    res.json({
      status: 'success',
      data: settings
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/settings/categories
 * Get all setting categories
 */
router.get('/categories', async (req, res, next) => {
  try {
    const categories = await settingsService.getCategories();
    res.json({
      status: 'success',
      data: categories
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/settings/:category
 * Get settings by category
 */
router.get('/:category', async (req, res, next) => {
  try {
    const { category } = req.params;
    const settings = await settingsService.getSettingsByCategory(category);
    res.json({
      status: 'success',
      data: settings
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/settings/key/:key
 * Get a single setting by key
 */
router.get('/key/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const setting = await settingsService.getSetting(key);
    res.json({
      status: 'success',
      data: setting
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }
    next(error);
  }
});

/**
 * PUT /api/v1/settings/:key
 * Update a single setting
 */
router.put('/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        status: 'error',
        message: 'Value is required'
      });
    }

    const updated = await settingsService.updateSetting(key, value);
    res.json({
      status: 'success',
      message: `Setting '${key}' updated successfully`,
      data: updated
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }
    if (error.message.includes('expects')) {
      return res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
    next(error);
  }
});

/**
 * PUT /api/v1/settings
 * Update multiple settings
 */
router.put('/', async (req, res, next) => {
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

/**
 * POST /api/v1/settings/:key/reset
 * Reset a setting to its default value
 */
router.post('/:key/reset', async (req, res, next) => {
  try {
    const { key } = req.params;
    const setting = await settingsService.resetSetting(key);

    res.json({
      status: 'success',
      message: `Setting '${key}' reset to default`,
      data: setting
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }
    next(error);
  }
});

export default router;
