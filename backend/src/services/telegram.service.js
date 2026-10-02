import { log } from '../core/logger.js';
import { config } from '../core/config.js';

const { botToken, defaultChatId } = config.telegram;

class TelegramService {
  /** Send one message to TELEGRAM_DEFAULT_CHAT_ID. A silent no-op when the token or chat is unset. */
  async broadcastText(text) {
    if (!botToken || !defaultChatId) return [];
    const send = async (payload) => {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.description || 'Telegram API error');
    };
    try {
      // Markdown first; plain text if Telegram rejects the formatting
      try {
        await send({ chat_id: defaultChatId, text, parse_mode: 'Markdown' });
      } catch {
        await send({ chat_id: defaultChatId, text });
      }
      return [defaultChatId];
    } catch (err) {
      log.warn('telegram_send_failed', { reason: err.message });
      return [];
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
    return this.broadcastText(this.formatOrderMessage(order, context));
  }

  /**
   * Send a single summary notification for a batch/broadcast of orders.
   * Includes instance list, trigger type (manual/automated), and button label.
   */
  async sendOrderSummary(summary) {
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

    return this.broadcastText(lines.join('\n'));
  }
}

export default new TelegramService();
