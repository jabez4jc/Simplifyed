/**
 * Telegram Service
 * Handles Telegram bot integration for trading alerts
 */

import crypto from 'crypto';
import db from '../core/database.js';
import log from '../core/logger.js';
import { config } from '../core/config.js';

class TelegramService {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.botUsername = process.env.TELEGRAM_BOT_USERNAME;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.pollingInterval = null;
    this.lastUpdateId = 0;

    if (!this.botToken || this.botToken === 'your-telegram-bot-token-here') {
      log.warn('Telegram bot token not configured. Alerts will not be sent.');
      this.isConfigured = false;
    } else {
      this.isConfigured = true;
      log.info('Telegram service initialized', { bot_username: this.botUsername });
    }
  }

  /**
   * Send trading alert to user
   * @param {number} userId - User ID
   * @param {Object} alert - Alert object
   * @returns {Promise<Object>} - Send result
   */
  async sendAlert(userId, alert) {
    if (!this.isConfigured) {
      log.debug('Telegram not configured, skipping alert');
      return { status: 'skipped', reason: 'not_configured' };
    }

    try {
      // Get user's Telegram config
      const telegramConfig = await db.get(
        'SELECT * FROM user_telegram_config WHERE user_id = ? AND is_active = 1',
        [userId]
      );

      if (!telegramConfig || !telegramConfig.telegram_chat_id) {
        log.debug('User has not linked Telegram', { userId });
        return { status: 'skipped', reason: 'not_linked' };
      }

      if (!telegramConfig.enabled) {
        return { status: 'skipped', reason: 'notifications_disabled' };
      }

      // Check if user wants this type of notification
      if (!this.shouldSendAlert(telegramConfig, alert.type)) {
        return { status: 'skipped', reason: 'notification_type_disabled' };
      }

      // Format message
      const message = this.formatAlertMessage(alert);

      // Send via Telegram API
      const result = await this.sendMessage(
        telegramConfig.telegram_chat_id,
        message,
        {
          parse_mode: 'Markdown',
          disable_notification: telegramConfig.silent_mode,
        }
      );

      // Log message
      await this.logMessage(
        userId,
        telegramConfig.telegram_chat_id,
        alert.type,
        message,
        result
      );

      // Update last message timestamp
      await db.run(
        'UPDATE user_telegram_config SET last_message_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [userId]
      );

      log.info('Telegram alert sent', {
        userId,
        alertType: alert.type,
        messageId: result.message_id,
      });

      return { status: 'sent', message_id: result.message_id };
    } catch (error) {
      log.error('Telegram send failed', { userId, error: error.message });

      // Log failed attempt
      await this.logMessage(userId, null, alert.type, null, {
        ok: false,
        error: error.message,
      });

      return { status: 'failed', error: error.message };
    }
  }

  /**
   * Format alert message for Telegram
   * @param {Object} alert - Alert data
   * @returns {string} - Formatted message
   */
  formatAlertMessage(alert) {
    const emoji = this.getAlertEmoji(alert.type, alert.pnl);
    const pos = alert.position;
    const trigger = alert.trigger;

    // Compact, scannable format
    const message = `
${emoji} *${alert.type.replace(/_/g, ' ')}* ${emoji}

*${pos.symbol}* | ${pos.exchange}
${pos.side} ${Math.abs(pos.quantity)} @ ₹${this.formatPrice(pos.entry_price)}

*Exit:* ₹${this.formatPrice(trigger.exit_price)}
*P&L:* ${this.formatPnL(alert.pnl)}
*Qty:* ${trigger.exit_quantity}

*Instance:* ${pos.instance_name}
*Time:* ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
    `.trim();

    return message;
  }

  /**
   * Get appropriate emoji for alert type
   * @param {string} type - Alert type
   * @param {number} pnl - P&L value
   * @returns {string} - Emoji
   */
  getAlertEmoji(type, pnl) {
    if (type === 'TARGET_HIT') return '🎯';
    if (type === 'SL_HIT') return pnl < 0 ? '🛑' : '⚠️';
    if (type === 'TSL_HIT') return '📉';
    if (type === 'ERROR') return '❌';
    return '📊';
  }

  /**
   * Format P&L with color indicator
   * @param {number} pnl - P&L value
   * @returns {string} - Formatted P&L
   */
  formatPnL(pnl) {
    const sign = pnl >= 0 ? '+' : '';
    const emoji = pnl >= 0 ? '💰' : '📉';
    return `${emoji} ${sign}₹${pnl.toFixed(2)}`;
  }

  /**
   * Format price value
   * @param {number} price - Price value
   * @returns {string} - Formatted price
   */
  formatPrice(price) {
    return price.toFixed(2);
  }

  /**
   * Send message via Telegram Bot API
   * @param {string} chatId - Telegram chat ID
   * @param {string} text - Message text
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - Telegram API response
   */
  async sendMessage(chatId, text, options = {}) {
    const response = await fetch(`${this.apiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...options,
      }),
    });

    const result = await response.json();

    if (!result.ok) {
      throw new Error(result.description || 'Telegram API error');
    }

    return result.result;
  }

  /**
   * Generate unique linking code
   * @returns {string} - Linking code
   */
  generateLinkingCode() {
    return `LINK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  /**
   * Create linking code for user
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Linking details
   */
  async createLinkingCode(userId) {
    const code = this.generateLinkingCode();

    await db.run(
      `
      INSERT INTO user_telegram_config (user_id, linking_code)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        linking_code = excluded.linking_code,
        updated_at = CURRENT_TIMESTAMP
    `,
      [userId, code]
    );

    return {
      linking_code: code,
      bot_username: this.botUsername,
      link_url: `https://t.me/${this.botUsername}?start=${code}`,
    };
  }

  /**
   * Link Telegram account (called when user sends /start command)
   * @param {string} linkingCode - Linking code
   * @param {string} chatId - Telegram chat ID
   * @param {string} username - Telegram username
   * @returns {Promise<number>} - User ID
   */
  async linkAccount(linkingCode, chatId, username) {
    const config = await db.get(
      'SELECT * FROM user_telegram_config WHERE linking_code = ?',
      [linkingCode]
    );

    if (!config) {
      throw new Error('Invalid linking code');
    }

    // Update with Telegram details
    await db.run(
      `
      UPDATE user_telegram_config
      SET telegram_chat_id = ?,
          telegram_username = ?,
          linked_at = CURRENT_TIMESTAMP,
          is_active = 1
      WHERE user_id = ?
    `,
      [chatId, username, config.user_id]
    );

    log.info('Telegram account linked', {
      userId: config.user_id,
      chatId,
      username,
    });

    return config.user_id;
  }

  /**
   * Get user's Telegram configuration
   * @param {number} userId - User ID
   * @returns {Promise<Object>} - Telegram config
   */
  async getUserConfig(userId) {
    return await db.get(
      'SELECT * FROM user_telegram_config WHERE user_id = ?',
      [userId]
    );
  }

  /**
   * Check if should send this alert type
   * @param {Object} config - User config
   * @param {string} alertType - Alert type
   * @returns {boolean} - Should send
   */
  shouldSendAlert(config, alertType) {
    if (alertType === 'TARGET_HIT') return config.notify_on_target;
    if (alertType === 'SL_HIT') return config.notify_on_sl;
    if (alertType === 'TSL_HIT') return config.notify_on_tsl;
    if (alertType === 'ERROR') return config.notify_on_error;
    return true;
  }

  /**
   * Log message attempt
   * @param {number} userId - User ID
   * @param {string} chatId - Chat ID
   * @param {string} messageType - Message type
   * @param {string} messageText - Message text
   * @param {Object} result - Send result
   * @returns {Promise<void>}
   */
  async logMessage(userId, chatId, messageType, messageText, result) {
    await db.run(
      `
      INSERT INTO telegram_message_log
      (user_id, chat_id, message_type, message_text, telegram_message_id, send_status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        userId,
        chatId,
        messageType,
        messageText,
        result.message_id || null,
        result.ok ? 'sent' : 'failed',
        result.error || null,
      ]
    );
  }

  /**
   * Handle incoming webhook from Telegram (for bot commands)
   * @param {Object} update - Telegram update object
   * @returns {Promise<void>}
   */
  async handleWebhook(update) {
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text;
      const username = update.message.from.username || update.message.from.first_name;

      // Handle /start LINK-XXXXX
      if (text.startsWith('/start LINK-')) {
        const linkingCode = text.split(' ')[1];
        try {
          const userId = await this.linkAccount(linkingCode, chatId, username);
          await this.sendMessage(
            chatId,
            '✅ *Successfully linked!*\n\nYou\'ll now receive trading alerts here.',
            { parse_mode: 'Markdown' }
          );
          log.info('Telegram account linked via webhook', { userId, chatId, username });
        } catch (error) {
          await this.sendMessage(
            chatId,
            '❌ *Invalid linking code*\n\nPlease check the code and try again.',
            { parse_mode: 'Markdown' }
          );
          log.warn('Invalid linking code attempt', { chatId, linkingCode });
        }
      }

      // Handle /status command
      else if (text === '/status') {
        await this.sendMessage(chatId, '📊 Status command coming soon!');
      }

      // Handle /help command
      else if (text === '/help' || text === '/start') {
        const helpText = `
*Simplifyed Trading Bot*

*Commands:*
/status - View active positions
/help - Show this help message

You'll receive automatic alerts when:
🎯 Targets are hit
🛑 Stop losses trigger
📉 Trailing stops activate
        `.trim();
        await this.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
      }
    }
  }

  /**
   * Get updates from Telegram (for polling)
   * @returns {Promise<Array>} - Array of updates
   */
  async getUpdates() {
    if (!this.isConfigured) {
      return [];
    }

    try {
      const url = `${this.apiUrl}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        log.error('Telegram API HTTP error', {
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      const result = await response.json();

      if (result.ok && result.result.length > 0) {
        // Update last update ID
        this.lastUpdateId = result.result[result.result.length - 1].update_id;
        log.debug('Received Telegram updates', { count: result.result.length });
        return result.result;
      }

      return [];
    } catch (error) {
      log.error('Failed to get Telegram updates', {
        error: error.message,
        stack: error.stack,
        code: error.code,
      });
      return [];
    }
  }

  /**
   * Start polling for Telegram updates
   * @param {number} intervalMs - Polling interval in milliseconds (default: 2000)
   */
  async startPolling(intervalMs = 2000) {
    if (!this.isConfigured) {
      log.debug('Telegram not configured, skipping polling');
      return;
    }

    if (this.pollingInterval) {
      log.debug('Telegram polling already running');
      return;
    }

    log.info('Starting Telegram polling', { interval_ms: intervalMs });

    // Poll immediately on start
    await this.poll();

    // Then poll at intervals
    this.pollingInterval = setInterval(async () => {
      await this.poll();
    }, intervalMs);
  }

  /**
   * Poll for updates once
   */
  async poll() {
    try {
      const updates = await this.getUpdates();

      for (const update of updates) {
        await this.handleWebhook(update);
      }
    } catch (error) {
      log.error('Error during Telegram polling', { error: error.message });
    }
  }

  /**
   * Stop polling for Telegram updates
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      log.info('Telegram polling stopped');
    }
  }

  /**
   * Get polling status
   * @returns {Object} - Polling status
   */
  getPollingStatus() {
    return {
      is_polling: !!this.pollingInterval,
      is_configured: this.isConfigured,
      last_update_id: this.lastUpdateId,
    };
  }
}

export default new TelegramService();
