/**
 * Telegram Routes
 * Handle Telegram bot linking and webhook
 */

import express from 'express';
import { log } from '../../core/logger.js';
import telegramService from '../../services/telegram.service.js';
import { requireAuth } from '../../middleware/auth.js';

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

// Admin test hook: send a test message to default/subscribers
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    if (!req.user?.is_admin && !(req.user?.permissions || []).includes('settings.manage')) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }
    await telegramService.sendOrderNotification({
      symbol: 'TEST',
      exchange: 'NSE',
      side: 'BUY',
      quantity: 1,
    }, {
      type: 'TEST',
      instance_name: 'Test',
    });
    res.json({ status: 'success', message: 'Test notification sent (if chat id configured)' });
  } catch (error) {
    next(error);
  }
});

export default router;
