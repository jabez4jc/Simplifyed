import crypto from 'crypto';
import db from '../core/database.js';
import { log } from '../core/logger.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_DEFAULT_CHAT_ID || null;
const API_URL = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

function ensureConfigured() {
  if (!BOT_TOKEN || !BOT_USERNAME || !API_URL) {
    throw new Error('Telegram bot is not configured');
  }
}

async function ensureSchema() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS telegram_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      chat_id TEXT NOT NULL UNIQUE,
      username TEXT,
      linking_code TEXT,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

class TelegramService {
  async createLinkingCode(userId) {
    ensureConfigured();
    await ensureSchema();
    const code = `LINK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    try {
      await db.run(
        `INSERT INTO telegram_subscribers (user_id, chat_id, username, linking_code, is_active, updated_at)
         VALUES (?, NULL, NULL, ?, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET linking_code = excluded.linking_code, updated_at = CURRENT_TIMESTAMP`,
        [userId, code]
      );
    } catch (err) {
      log.error('telegram_link_code_failed', { user_id: userId, error: err.message });
      throw new Error('Failed to generate linking code');
    }
    return {
      linking_code: code,
      bot_username: BOT_USERNAME,
      link_url: `https://t.me/${BOT_USERNAME}?start=${code}`,
    };
  }

  async handleWebhook(update) {
    if (!update || !update.message) return;
    const msg = update.message;
    const chatId = msg.chat?.id;
    const username = msg.chat?.username || null;
    const text = msg.text || '';
    if (!chatId || !text.startsWith('/start')) return;

    const parts = text.split(' ');
    const code = parts.length > 1 ? parts[1].trim() : null;
    if (!code) return;
    await ensureSchema();

    const row = await db.get('SELECT * FROM telegram_subscribers WHERE linking_code = ?', [code]);
    if (!row) {
      await this.sendMessage(chatId, 'Invalid or expired linking code.');
      return;
    }

    await db.run(
      `UPDATE telegram_subscribers
       SET chat_id = ?, username = ?, is_active = 1, linked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE linking_code = ?`,
      [String(chatId), username, code]
    );

    await this.sendMessage(chatId, '✅ Telegram linked. You will now receive trade notifications.');
  }

  async getUserStatus(userId) {
    await ensureSchema();
    const row = await db.get('SELECT chat_id, username, linked_at, is_active FROM telegram_subscribers WHERE user_id = ?', [userId]);
    return {
      is_linked: !!row?.chat_id,
      linked_at: row?.linked_at,
      username: row?.username,
      is_active: row?.is_active === 1,
    };
  }

  async sendMessage(chatId, text) {
    ensureConfigured();
    if (!chatId) return;
    // Attempt with Markdown, fallback to plain text if Telegram rejects formatting
    const attemptSend = async (payload) => {
      const res = await fetch(`${API_URL}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!body.ok) {
        const err = new Error(body.description || 'Telegram API error');
        err.code = body.error_code;
        throw err;
      }
      return body.result;
    };

    try {
      return await attemptSend({ chat_id: chatId, text, parse_mode: 'Markdown' });
    } catch (err) {
      // Retry without parse_mode for formatting errors
      log.warn('telegram_send_retry_plain', { chat_id: chatId, reason: err.message });
      return await attemptSend({ chat_id: chatId, text });
    }
  }

  formatOrderMessage(order, context = {}) {
    const lines = [];
    const type = context.type || 'ORDER';
    const side = (order.side || '').toUpperCase();
    lines.push(`*${type}*`);
    if (context.trigger_type) lines.push(`Trigger: ${context.trigger_type}`);
    if (context.button_label) lines.push(`Button: ${context.button_label}`);
    lines.push(`Symbol: ${order.symbol} (${order.exchange || ''})`);
    if (order.product_type) lines.push(`Product: ${order.product_type}`);
    if (order.order_type) lines.push(`Type: ${order.order_type}`);
    if (order.quantity) lines.push(`Qty: ${order.quantity}`);
    if (order.price) lines.push(`Price: ${order.price}`);
    if (order.trigger_price) lines.push(`Trigger: ${order.trigger_price}`);
    if (context.pnl !== undefined) lines.push(`P&L: ${context.pnl}`);
    if (context.instance_name) lines.push(`Instance: ${context.instance_name}`);
    lines.push(`Side: ${side}`);
    return lines.join('\n');
  }

  async sendOrderNotification(order, context = {}) {
    ensureConfigured();
    await ensureSchema();
    const msg = this.formatOrderMessage(order, context);

    const targets = [];
    // Global chat first if configured
    if (DEFAULT_CHAT_ID) {
      try {
        await this.sendMessage(DEFAULT_CHAT_ID, msg);
        targets.push(DEFAULT_CHAT_ID);
      } catch (err) {
        log.error('Telegram send failed (global)', { chat_id: DEFAULT_CHAT_ID, reason: err.message });
      }
    }

    // Active subscribers
    const subs = await db.all('SELECT chat_id FROM telegram_subscribers WHERE is_active = 1 AND chat_id IS NOT NULL');
    log.info('telegram_dispatch', { count: subs.length + (DEFAULT_CHAT_ID ? 1 : 0), chat_id: DEFAULT_CHAT_ID || 'subs' });
    for (const sub of subs) {
      try {
        await this.sendMessage(sub.chat_id, msg);
        targets.push(sub.chat_id);
      } catch (err) {
        log.error('Telegram send failed (subscriber)', { chat_id: sub.chat_id, reason: err.message });
      }
    }
    return targets;
  }

  /**
   * Send a single summary notification for a batch/broadcast of orders.
   * Includes instance list, trigger type (manual/automated), and button label.
   */
  async sendOrderSummary(summary, context = {}) {
    ensureConfigured();
    await ensureSchema();

    const instances = summary.instances || [];
    const successInstances = summary.success_instances || [];
    const failureInstances = summary.failure_instances || [];
    const successCount = summary.success_count ?? successInstances.length ?? 0;
    const failureCount = summary.failure_count ?? failureInstances.length ?? 0;

    const lines = [];
    lines.push(`*${summary.title || 'ORDER SUMMARY'}*`);
    if (summary.trigger_type) lines.push(`Trigger: ${summary.trigger_type}`);
    if (summary.button_label) lines.push(`Button: ${summary.button_label}`);
    if (summary.trade_mode) lines.push(`Mode: ${summary.trade_mode}`);
    if (summary.side) lines.push(`Side: ${summary.side}`);
    lines.push(`Symbol: ${summary.symbol} (${summary.exchange || ''})`);
    if (summary.product) lines.push(`Product: ${summary.product}`);
    if (summary.order_type) lines.push(`Type: ${summary.order_type}`);
    if (summary.quantity) lines.push(`Qty: ${summary.quantity}`);
    if (summary.trigger_price) lines.push(`Trigger: ${summary.trigger_price}`);
    if (summary.price) lines.push(`Price: ${summary.price}`);
    lines.push(`Instances (${instances.length}): ${instances.length ? instances.join(', ') : 'None'}`);

    const successList = successInstances.length ? ` (${successInstances.join(', ')})` : '';
    const failureList = failureInstances.length ? ` (${failureInstances.join(', ')})` : '';
    lines.push(`Results: ${successCount} success${successList}${failureCount ? `, ${failureCount} failed${failureList}` : ''}`);

    const msg = lines.join('\n');

    const targets = [];

    // Global chat
    if (DEFAULT_CHAT_ID) {
      try {
        await this.sendMessage(DEFAULT_CHAT_ID, msg);
        targets.push(DEFAULT_CHAT_ID);
      } catch (err) {
        log.error('Telegram send failed (summary global)', { chat_id: DEFAULT_CHAT_ID, reason: err.message });
      }
    }

    // Subscribers
    const subs = await db.all('SELECT chat_id FROM telegram_subscribers WHERE is_active = 1 AND chat_id IS NOT NULL');
    log.info('telegram_dispatch_summary', { count: subs.length + (DEFAULT_CHAT_ID ? 1 : 0), chat_id: DEFAULT_CHAT_ID || 'subs' });
    for (const sub of subs) {
      try {
        await this.sendMessage(sub.chat_id, msg);
        targets.push(sub.chat_id);
      } catch (err) {
        log.error('Telegram send failed (summary subscriber)', { chat_id: sub.chat_id, reason: err.message });
      }
    }

    return targets;
  }
}

export default new TelegramService();
