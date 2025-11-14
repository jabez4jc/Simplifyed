/**
 * Telegram Routes
 * Handle Telegram bot linking and webhook
 */

import express from 'express';
import db from '../../core/database.js';
import log from '../../core/logger.js';
import telegramService from '../../services/telegram.service.js';

const router = express.Router();

/**
 * POST /api/v1/telegram/webhook
 * Receive updates from Telegram
 */
router.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    await telegramService.handleWebhook(update);
    res.json({ ok: true });
  } catch (error) {
    log.error('Telegram webhook error', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/v1/telegram/link
 * Generate linking code
 */
router.post('/link', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const linkData = await telegramService.createLinkingCode(userId);

    res.json({
      status: 'success',
      data: linkData,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/telegram/status
 * Check if Telegram is linked
 */
router.get('/status', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const config = await telegramService.getUserConfig(userId);

    res.json({
      status: 'success',
      data: {
        is_linked: !!config?.telegram_chat_id,
        linked_at: config?.linked_at,
        is_active: config?.is_active || false,
        username: config?.telegram_username,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/telegram/preferences
 * Update notification preferences
 */
router.put('/preferences', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      enabled,
      notify_on_target,
      notify_on_sl,
      notify_on_tsl,
      notify_on_error,
      silent_mode,
    } = req.body;

    // Check if config exists
    const config = await telegramService.getUserConfig(userId);
    if (!config) {
      return res.status(404).json({
        status: 'error',
        message: 'Telegram not linked yet',
      });
    }

    // Update preferences
    await db.run(
      `
      UPDATE user_telegram_config
      SET enabled = COALESCE(?, enabled),
          notify_on_target = COALESCE(?, notify_on_target),
          notify_on_sl = COALESCE(?, notify_on_sl),
          notify_on_tsl = COALESCE(?, notify_on_tsl),
          notify_on_error = COALESCE(?, notify_on_error),
          silent_mode = COALESCE(?, silent_mode),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `,
      [
        enabled,
        notify_on_target,
        notify_on_sl,
        notify_on_tsl,
        notify_on_error,
        silent_mode,
        userId,
      ]
    );

    // Get updated config
    const updatedConfig = await telegramService.getUserConfig(userId);

    res.json({
      status: 'success',
      data: updatedConfig,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/telegram/unlink
 * Unlink Telegram account
 */
router.delete('/unlink', async (req, res, next) => {
  try {
    const userId = req.user.id;

    await db.run(
      `
      UPDATE user_telegram_config
      SET telegram_chat_id = NULL,
          telegram_username = NULL,
          is_active = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `,
      [userId]
    );

    res.json({
      status: 'success',
      message: 'Telegram account unlinked',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
