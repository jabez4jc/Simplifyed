/**
 * Emergency WhatsApp alerts. notify() hands an event here when its caller tagged it with an
 * alert key (the 'alert' rows of whatsapp_templates) and the instances involved. The template
 * decides whether it is on, who hears it (owner, admin, both) and the cooldown: an instance is
 * alerted about the same event at most once per cooldown_min, so a flapping instance cannot
 * flood anyone. An event with no instance (futures roll) goes to the admin only.
 */
import db from '../core/database.js';
import { log } from '../core/logger.js';
import whatsappTemplates, { messageVars, render, groupByPhone, ownerDetail } from './whatsapp-templates.service.js';
import whatsappOutbox, { PRIORITY } from './whatsapp-outbox.service.js';

async function recentlyAlerted(key, instanceId, cooldownMin) {
  if (!cooldownMin) return false;
  const since = `-${cooldownMin} minutes`;
  const row = instanceId == null
    ? await db.get("SELECT 1 FROM whatsapp_messages WHERE template_key = ? AND created_at > datetime('now', ?) LIMIT 1", [key, since])
    : await db.get("SELECT 1 FROM whatsapp_messages WHERE template_key = ? AND instance_ids LIKE ? AND created_at > datetime('now', ?) LIMIT 1",
      [key, `%,${instanceId},%`, since]);
  return Boolean(row);
}

/**
 * @param {string} key - alert template key, e.g. 'alert_max_loss'
 * @param {{instanceIds?: number[], detail?: string, vars?: object}} event
 * @returns {Promise<number>} messages queued
 */
export async function dispatchAlert(key, { instanceIds = [], detail = '', vars = {} } = {}) {
  const template = await whatsappTemplates.get(key);
  if (!template || template.kind !== 'alert' || !template.enabled) return 0;

  const ids = [...new Set(instanceIds.filter((id) => id != null).map(Number))];
  let instances = [];
  if (ids.length) {
    instances = await db.all(`SELECT * FROM instances WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const fresh = [];
    for (const inst of instances) {
      if (!(await recentlyAlerted(key, inst.id, template.cooldown_min))) fresh.push(inst);
    }
    instances = fresh;
    if (!instances.length) return 0;
  } else if (await recentlyAlerted(key, null, template.cooldown_min)) {
    return 0;
  }

  const extra = { detail, ...vars };
  const messages = [];
  if (template.send_to !== 'admin') {
    const everyone = await db.all('SELECT id, name, broker, host_url FROM instances');
    for (const [phone, list] of groupByPhone(instances)) {
      messages.push({ recipient: 'owner', phone, instanceIds: list.map((i) => i.id), templateKey: key,
        body: render(template.body, messageVars(list, { extra: { ...extra, detail: ownerDetail(detail, list, everyone) } })),
        priority: PRIORITY.alert });
    }
  }
  if (template.send_to !== 'owner' || !instances.length) {
    messages.push({ recipient: 'admin', instanceIds: instances.map((i) => i.id), templateKey: key,
      body: render(template.body, messageVars(instances, { forAdmin: true, extra })), priority: PRIORITY.alert });
  }
  await whatsappOutbox.enqueue(messages);
  log.info('whatsapp_alert_queued', { key, instances: instances.length, messages: messages.length });
  return messages.length;
}
